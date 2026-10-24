import { launchFrame } from "./nativeLauncher.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdir,
  writeFile,
  readFile,
  mkdtemp,
  rm,
  access,
} from "node:fs/promises";
import { PrivateOutput } from "./privateOutput.js";
import { finished } from "node:stream/promises";
import { join, matchesGlob } from "node:path";
import { z } from "zod";
import type { AgentBackend, RunContext, BackendResult } from "./backend.js";
import {
  ControlError,
  type Claim,
  type Goal,
  type GoalConfig,
} from "./schema.js";
import type { ControlStore } from "./store.js";
import {
  nativeBinding,
  nativeEnvironment,
  type NativeProfile,
} from "./nativeConfig.js";
import {
  nativeOutputSchema,
  normalizeNativeOutput,
} from "./nativeOutputSchema.js";
import { workerResponseSchema, responseHandoff } from "./workerHandoff.js";
import { codexArguments, CodexEvents } from "./nativeCodex.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { executionSignal } from "./executionDeadline.js";
import { instructionManifest } from "./projectContext.js";
import { InvocationStore, type Invocation } from "./invocations.js";
import {
  nativeCommand,
  cleanupNativeProcess,
  ownedGroup,
  processIdentity,
  stopOwnedGroup,
} from "./nativeProcess.js";
import {
  ProviderFailure,
  classifyFailure,
  failureRecord,
  boundedCleanup,
  abortable,
} from "./reliability.js";
import { git } from "./git.js";
import { prepareContractSnapshot } from "./contractSnapshots.js";
import type { VerificationResult } from "./isolatedVerifier.js";

export function selectedNativeProfile(config: GoalConfig): NativeProfile {
  if (
    config.executionContract?.execution !== "native" ||
    !config.admission?.nativeProfile ||
    config.admission.runtimeHash !== nativeBinding(config)
  )
    throw new ControlError(
      "native_binding",
      "Native profile differs from its admitted configuration",
      409,
    );
  return config.admission.nativeProfile;
}
export async function nativePreflight(
  config: GoalConfig,
  task?: Claim["task"]["spec"],
  parentSignal = executionSignal(),
) {
  const profile = selectedNativeProfile(config),
    env = nativeEnvironment(profile),
    signal = AbortSignal.any([
      AbortSignal.timeout(config.timeoutMs),
      ...(parentSignal ? [parentSignal] : []),
    ]),
    faults: string[] = [];
  const result = (agentVersion?: string) => ({
    configurationVersion: nativeBinding(config),
    ready: !faults.length,
    environment: "native",
    faults,
    agentVersion,
    permissions: profile.permissions,
    resourceEnforcement: "scheduler accounting only",
    authenticationInspected: process.platform === "linux" && !signal.aborted,
    configuration:
      "Selected existing Codex home/profile; project instructions and integrations remain enabled",
    setupCommands: profile.setupCommands,
  });
  if (process.platform !== "linux") {
    faults.push("Native execution currently supports Linux/WSL only");
    return result();
  }
  const version = await nativeCommand(profile.executable, ["--version"], {
    cwd: config.repoPath,
    env,
    signal,
  }).catch(() => undefined);
  if (!version || version.exitCode)
    faults.push("Selected Codex executable is unavailable");
  for (const executable of ["git", ...profile.requiredExecutables]) {
    const found = await nativeCommand(
      "/bin/sh",
      ["-c", 'command -v "$1"', "mc-preflight", executable],
      { cwd: config.repoPath, env, signal },
    ).catch(() => undefined);
    if (!found || found.exitCode)
      faults.push(`Required executable unavailable: ${executable}`);
  }
  for (const path of profile.requiredPaths) {
    if (
      !(await access(join(config.repoPath, path)).then(
        () => true,
        () => false,
      ))
    )
      faults.push(`Required repository input unavailable: ${path}`);
  }
  if (task)
    for (const path of profile.requiredScopePaths)
      if (!task.allowedPaths.some((scope) => matchesGlob(path, scope)))
        faults.push(
          `Required fixture or packaging file outside task scope: ${path}`,
        );
  for (const url of profile.requiredUrls) {
    try {
      if (
        !(
          await fetch(url, {
            method: "HEAD",
            signal,
          })
        ).ok
      )
        faults.push(
          `Required documentation unavailable: ${new URL(url).hostname}`,
        );
    } catch {
      faults.push(
        `Required documentation unavailable: ${new URL(url).hostname}`,
      );
    }
  }
  const identity = await nativeCommand("git", ["var", "GIT_COMMITTER_IDENT"], {
    cwd: config.repoPath,
    env,
    signal,
  }).catch(() => undefined);
  if (!identity || identity.exitCode)
    faults.push("Configure Git author identity before execution");
  if (
    config.repository?.mode === "local" &&
    config.repository.branch !== config.policy.targetBranch
  )
    faults.push(
      "Local base branch must match the configured integration target",
    );
  if (!config.verificationCommands.length)
    faults.push("Configure explicit verification commands");
  const login = await nativeCommand(profile.executable, ["login", "status"], {
    cwd: config.repoPath,
    env,
    signal,
  }).catch(() => undefined);
  if (!login || login.exitCode || !/chatgpt/i.test(login.stdout + login.stderr))
    faults.push(
      "Selected Codex home needs an existing ChatGPT login; no login was attempted",
    );
  return result(version?.exitCode === 0 ? version.stdout.trim() : undefined);
}

async function candidateUnchanged(
  path: string,
  commit: string,
  outputs: string[],
) {
  if (
    (await git(path, ["rev-parse", "HEAD"])) !== commit ||
    (await git(path, ["status", "--porcelain", "--untracked-files=no"])) !== ""
  )
    return false;
  const untracked = await git(path, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return untracked
    .split("\0")
    .filter(Boolean)
    .every((file) => outputs.some((pattern) => matchesGlob(file, pattern)));
}

export class NativeRuntime {
  readonly invocations: InvocationStore;
  constructor(
    readonly store: ControlStore,
    readonly root: string,
  ) {
    this.invocations = new InvocationStore(store);
  }
  async recoverStartup() {
    for (const record of this.invocations
      .all()
      .filter(
        (r) =>
          r.environment === "native" &&
          ["active", "cleanup_blocked"].includes(r.outcome),
      )) {
      try {
        await this.recover({ attemptId: record.attemptId });
      } catch {
        record.outcome = "cleanup_blocked";
        this.invocations.save(record);
        this.store.recordFailure(
          record.goalId,
          failureRecord("cleanup_blocked"),
          record.attemptId,
        );
      }
    }
    this.store.finishStartupRecovery({
      environment: "native",
      skipRetained: true,
    });
  }
  async recover(scope?: {
    taskId?: string;
    generation?: number;
    attemptId?: string;
  }) {
    for (const record of this.invocations
      .all()
      .filter(
        (r) =>
          r.environment === "native" &&
          (!scope ||
            (scope.attemptId
              ? r.attemptId === scope.attemptId
              : r.taskId === scope.taskId &&
                r.generation === scope.generation)) &&
          (r.outcome === "active" || r.outcome === "cleanup_blocked"),
      )) {
      if (!record.process && record.launchProtocol !== "framed-v1")
        throw new ProviderFailure(failureRecord("cleanup_blocked"));
      if (record.process) {
        await stopOwnedGroup(
          record.process,
          this.store.reliability.cleanupSignal(record.attemptId),
        );
        if ((await ownedGroup(record.process)).length)
          throw new ControlError(
            "cleanup_blocked",
            "Native writer has not stopped; inspect retained execution",
            409,
          );
      }
      // A preparing invocation has not been given a prompt until its process identity is recorded.
      record.outcome = "interrupted";
      record.endedAt = this.store.clock();
      this.invocations.save(record);
    }
  }
  async recoverAttempt(
    taskId: string,
    generation: number,
    _signal: AbortSignal,
  ) {
    await this.recover({ taskId, generation });
  }
  async recoverOperation(attemptId: string, _signal: AbortSignal) {
    await this.recover({ attemptId });
  }
  backend(goal: Goal): AgentBackend {
    selectedNativeProfile(goal.config);
    return { run: (context) => this.run(context) };
  }
  async run(context: RunContext): Promise<BackendResult> {
    if (context.mode !== "review") return this.runInWorkspace(context);
    const commit = await git(context.workspace, ["rev-parse", "HEAD"]);
    await mkdir(join(this.root, "native-review"), {
      recursive: true,
      mode: 0o700,
    });
    const path = await mkdtemp(join(this.root, "native-review", "candidate-"));
    let retained = false;
    try {
      await git(context.workspace, [
        "worktree",
        "add",
        "--detach",
        path,
        commit,
      ]);
      const result = await this.runInWorkspace({ ...context, workspace: path });
      if (
        !(await candidateUnchanged(
          path,
          commit,
          selectedNativeProfile(context.claim.goal.config).buildOutputPaths,
        ))
      )
        throw new ControlError(
          "review_mutation",
          "Native reviewer changed the candidate",
          409,
        );
      return result;
    } catch (error) {
      retained = classifyFailure(error).kind === "cleanup_blocked";
      throw error;
    } finally {
      if (!retained) {
        await git(context.workspace, [
          "worktree",
          "remove",
          "--force",
          path,
        ]).catch(() => {});
        await rm(path, { recursive: true, force: true });
      }
    }
  }
  private async runInWorkspace(context: RunContext): Promise<BackendResult> {
    const config = context.claim.goal.config,
      profile = selectedNativeProfile(config),
      env = nativeEnvironment(profile);
    if (!context.invocationId)
      throw Error("Native execution requires persisted invocation intent");
    context.signal.throwIfAborted();
    context.assertAuthority?.();
    const assertAuthority = () => {
      context.signal.throwIfAborted();
      if (context.operationReservationId) {
        const runtime = this.store.reliability.runtime(
          context.operationReservationId,
        );
        if (!runtime || runtime.deadlineAt <= this.store.clock())
          throw Error("Native operation authority expired");
      } else
        this.store.assertLease(
          context.claim.task.id,
          context.claim.workerId,
          context.claim.generation,
        );
    };
    assertAuthority();
    const preflight = await nativePreflight(
      config,
      context.claim.task.spec,
      context.signal,
    );
    context.signal.throwIfAborted();
    if (!preflight.ready)
      throw new ControlError(
        "native_preflight",
        preflight.faults.join("; "),
        409,
      );
    const baseCommit = await git(context.workspace, ["rev-parse", "HEAD"]);
    context.observe?.({
      workspace: context.workspace,
      agentVersion: preflight.agentVersion,
      configurationVersion: preflight.configurationVersion,
      baseCommit,
      ...(context.mode === "review" ? { candidate: baseCommit } : {}),
    });
    if (context.mode === "implement")
      for (const command of profile.setupCommands) {
        const result = await this.command(
          context.claim,
          context.workspace,
          command,
          context.signal,
          "setup",
          context.operationReservationId,
        );
        if (result.exitCode)
          throw new ControlError(
            "native_setup",
            "Declared setup failed; inspect project recipe",
            409,
          );
      }
    const directory = join(this.root, "agent-output", context.invocationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const schema =
      context.outputSchema ??
      z.toJSONSchema(workerResponseSchema, { target: "draft-7", io: "input" });
    const schemaPath = join(directory, "schema.json"),
      finalPath = join(directory, "final.json");
    await writeFile(schemaPath, JSON.stringify(nativeOutputSchema(schema)), {
      mode: 0o600,
    });
    const previous =
      context.mode === "implement" && !context.disableTaskHandoffs
        ? this.invocations
            .all(context.claim.goal.id)
            .filter(
              (r) =>
                r.taskId === context.claim.task.id &&
                r.phase === "implement" &&
                r.workspace === context.workspace &&
                r.sessionId &&
                r.id !== context.invocationId &&
                r.outcome !== "active" &&
                r.outcome !== "cleanup_blocked",
            )
            .at(-1)
        : undefined;
    const args = codexArguments(
      profile,
      config.backend.model,
      schemaPath,
      finalPath,
      context.mode,
      previous?.sessionId,
      config.backend.kind === "codex"
        ? config.backend.reasoningEffort
        : undefined,
    );
    const raw = new PrivateOutput(join(directory, "events.jsonl")),
      errors = new PrivateOutput(join(directory, "stderr.txt"));
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./nativeLauncher.js", import.meta.url)),
        profile.executable,
        ...args,
      ],
      {
        cwd: context.workspace,
        env: { ...env, MC_NATIVE_EXECUTION_ID: context.invocationId },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let parseError: unknown;
    const protocol = new CodexEvents(context, previous?.sessionId);
    const exited = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? -1));
    });
    exited.catch(() => {});
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    raw.on("error", (error) => {
      parseError = error;
      stop();
    });
    errors.on("error", (error) => {
      parseError = error;
      stop();
    });
    child.stdin.on("error", (error) => {
      parseError = error;
    });
    child.stdout.pipe(raw);
    child.stderr.pipe(errors);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        protocol.feed(line);
      } catch (error) {
        parseError = error;
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
      }
    });
    const stop = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as any).code !== "ESRCH") parseError = error;
        }
    };
    context.signal.addEventListener("abort", stop, { once: true });
    try {
      if (!child.pid) throw Error("Codex could not start");
      const identity = await processIdentity(child.pid);
      if (!identity)
        throw Error(
          "Codex exited before its execution identity could be recorded",
        );
      context.observe?.({ process: identity });
      // No source work is authorized until the exact spawned identity is durable.
      assertAuthority();
      const instructions =
        context.mode !== "implement"
          ? await instructionManifest(context.claim.goal, context.workspace)
          : undefined;
      child.stdin.end(
        launchFrame +
          [
            `Execution environment: native devbox. Workspace: ${context.workspace}. The worker user has explicitly configured ${profile.permissions} permissions.`,
            `Runtime instructions: ${config.runtimeInstructions}`,
            `Required checks: ${JSON.stringify(config.verificationCommands)}`,
            ...(instructions
              ? [
                  `Pinned repository inputs and context: ${JSON.stringify(instructions)}`,
                ]
              : []),
            context.prompt,
          ].join("\n"),
      );
      const code = await abortable(exited, context.signal);
      await cleanupNativeProcess(identity, closed, context.cleanupSignal);
      context.signal.throwIfAborted();
      await Promise.all([finished(raw), finished(errors)]);
      protocol.assertSuccessful(code, parseError);
      const normalized = normalizeNativeOutput(
        JSON.parse(await readFile(finalPath, "utf8")),
        schema,
      );
      let text: string;
      if (context.outputSchema) text = JSON.stringify(normalized);
      else {
        const handoff = responseHandoff(
          normalized,
          context.mode === "implement",
        );
        if (handoff.wait) throw handoff.wait;
        text = handoff.response.text;
      }
      const { usage, sessionId } = protocol;
      return {
        text,
        usage,
        sessionId,
        inputTokens:
          usage?.kind === "subscription" ? (usage.inputTokens ?? 0) : 0,
        outputTokens:
          usage?.kind === "subscription" ? (usage.outputTokens ?? 0) : 0,
      };
    } catch (error) {
      try {
        const record = this.invocations
          .all(context.claim.goal.id)
          .find((r) => r.id === context.invocationId);
        if (record?.process)
          await cleanupNativeProcess(
            record.process,
            closed,
            context.cleanupSignal,
          );
        else {
          stop();
          await closed;
        }
      } catch (cleanupError) {
        error = cleanupError;
      }
      throw Object.assign(
        error instanceof Error ? error : Error("Native execution failed"),
        { usage: protocol.usage },
      );
    } finally {
      context.signal.removeEventListener("abort", stop);
      lines.close();
      raw.end();
      errors.end();
    }
  }
  private async command(
    claim: Claim,
    cwd: string,
    command: string,
    signal: AbortSignal,
    phase: string,
    operationReservationId?: string,
  ) {
    const profile = selectedNativeProfile(claim.goal.config);
    const row: Invocation = {
      kind: "command",
      launchProtocol: "framed-v1",
      id: `cmd_${randomUUID()}`,
      goalId: claim.goal.id,
      taskId: claim.generation > 0 ? claim.task.id : undefined,
      attemptId:
        operationReservationId ?? `${claim.task.id}:${claim.generation}`,
      generation: claim.generation,
      phase,
      environment: "native",
      agent: "shell",
      workspace: cwd,
      candidate: await git(cwd, ["rev-parse", "HEAD"]),
      startedAt: this.store.clock(),
      outcome: "active",
      turns: 0,
      toolEvents: 0,
      retryEvents: 0,
    };
    this.invocations.save(row);
    try {
      const result = await nativeCommand("/bin/sh", ["-c", command], {
        cwd,
        env: nativeEnvironment(profile),
        signal,
        cleanupSignal: () =>
          this.store.reliability.cleanupSignal(row.attemptId),
        onProcess: (identity) => {
          row.process = identity;
          this.invocations.save(row);
        },
      });
      if (row.process && (await ownedGroup(row.process)).length)
        throw new ProviderFailure(failureRecord("cleanup_blocked"));
      row.outcome = result.exitCode === 0 ? "completed" : "failed";
      return result;
    } catch (error) {
      row.outcome =
        classifyFailure(error).kind === "cleanup_blocked"
          ? "cleanup_blocked"
          : signal.aborted
            ? "interrupted"
            : "failed";
      throw error;
    } finally {
      row.endedAt = this.store.clock();
      this.invocations.save(row);
    }
  }
  async verify(claim: Claim, source: string): Promise<VerificationResult> {
    const profile = selectedNativeProfile(claim.goal.config),
      env = nativeEnvironment(profile),
      commit = await git(source, ["rev-parse", "HEAD"]);
    await mkdir(join(this.root, "native-verification"), {
      recursive: true,
      mode: 0o700,
    });
    const path = await mkdtemp(
      join(this.root, "native-verification", "candidate-"),
    );
    const signal = AbortSignal.timeout(
      Math.max(
        1,
        (claim.runtime?.deadlineAt ??
          Date.now() + claim.goal.config.timeoutMs) - Date.now(),
      ),
    );
    const results: VerificationResult["results"] = [];
    let retained = false;
    try {
      await git(source, ["worktree", "add", "--detach", path, commit]);
      const contracts = claim.goal.config.siblingContracts;
      if (contracts.length)
        await prepareContractSnapshot(
          join(path, ".missioncontrol-contracts"),
          contracts,
          signal,
        );
      for (const command of [
        ...profile.setupCommands,
        ...new Set([
          ...claim.goal.config.verificationCommands,
          ...claim.task.spec.verificationCommands,
        ]),
      ])
        results.push({
          command,
          ...(await this.command(claim, path, command, signal, "verify")),
        });
      const unchanged =
        (await candidateUnchanged(path, commit, [
          ...profile.buildOutputPaths,
          ...(contracts.length ? [".missioncontrol-contracts/**"] : []),
        ])) &&
        (await candidateUnchanged(source, commit, profile.buildOutputPaths));
      return {
        passed: unchanged && results.every((r) => r.exitCode === 0),
        unchanged,
        results,
        commit,
        verifierVersion: "native-candidate-v1",
      };
    } catch (error) {
      retained = classifyFailure(error).kind === "cleanup_blocked";
      throw error;
    } finally {
      if (!retained) {
        await git(source, ["worktree", "remove", "--force", path]).catch(
          () => {},
        );
        await rm(path, { recursive: true, force: true });
      }
    }
  }
}
