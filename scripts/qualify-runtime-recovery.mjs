// A real disposable active-container crash proof. Never touches installed state.
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import assert from "node:assert/strict";
import {
  initializeState,
  inspectState,
  lockInstance,
  recoverInstanceLock,
} from "../dist/instance.js";
import { SqliteStore } from "../dist/sqlite.js";
import { ControlStore } from "../dist/control/store.js";
import {
  EnvironmentRegistry,
  DockerEnvironment,
} from "../dist/control/environments.js";
import { reconcileRuntime } from "../dist/control/runtimeRecovery.js";
import { git } from "../dist/control/git.js";
const exec = promisify(execFile);
const image = (await readFile(process.argv[2], "utf8")).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const fingerprint = JSON.parse(
  (await exec("docker", ["version", "--format", "{{json .}}"])).stdout,
);
assert.equal(
  (
    await exec("docker", ["image", "inspect", "--format", "{{.Id}}", image])
  ).stdout.trim(),
  image,
);
const root = await mkdtemp(join(tmpdir(), "mc-active-recovery-"));
let state = join(root, "state"),
  child,
  db,
  unlock;
await initializeState(state);
const source = join(state, "source");
await mkdir(source);
await git(source, ["init", "-b", "main"]);
await writeFile(join(source, "README.md"), "Synthetic recovery proof\n");
await git(source, ["add", "."]);
await git(source, [
  "-c",
  "user.name=Synthetic",
  "-c",
  "user.email=synthetic@example.invalid",
  "commit",
  "-m",
  "Synthetic",
]);
const base = await git(source, ["rev-parse", "HEAD"]);
const modules = Object.fromEntries(
  ["instance", "sqlite", "control/store", "control/environments"].map(
    (name) => [name, new URL(`../dist/${name}.js`, import.meta.url).href],
  ),
);
const script = `import {lockInstance} from ${JSON.stringify(modules.instance)};
import {SqliteStore} from ${JSON.stringify(modules.sqlite)};import {ControlStore} from ${JSON.stringify(modules["control/store"])};
import {EnvironmentRegistry,DockerEnvironment} from ${JSON.stringify(modules["control/environments"])};
await lockInstance(${JSON.stringify(state)});const db=new SqliteStore(${JSON.stringify(join(state, "mission-control.db"))},{mustExist:true}),store=new ControlStore(db);
const goal=store.createGoal({title:'Synthetic crash',description:'Synthetic',repoPath:${JSON.stringify(source)},maxCostUsd:10,estimatePerRunUsd:1,executionContract:{harness:'tool-loop',provider:'azure',authentication:{kind:'controller',reference:'synthetic'},execution:'isolated',usagePolicy:{kind:'metered',maxCostUsd:10,estimatePerRunUsd:1}},backend:{kind:'azure',model:'synthetic',endpoint:'https://example.invalid',inputUsdPerMillion:1,outputUsdPerMillion:1}});
store.installPlan(goal.id,{tasks:[{key:'one',title:'Synthetic',description:'Synthetic',acceptanceCriteria:['inspect retained work'],allowedPaths:['**']}]},goal.revision);
const claim=store.claimNextTask('synthetic');store.transition(claim.task.id,'synthetic',claim.generation,'running');store.createToken('synthetic','worker','synthetic');
const registry=new EnvironmentRegistry(${JSON.stringify(join(state, "sandbox"))},db),environment=new DockerEnvironment(registry);
const session=await environment.prepare({taskId:claim.task.id,generation:claim.generation,goalId:goal.id,workerId:'synthetic',authorityGeneration:claim.generation,source:${JSON.stringify(source)},baseSha:${JSON.stringify(base)},image:${JSON.stringify(image)},cpu:1,memoryMiB:256,timeoutMs:60000});
const active=await environment.acquire(session.id);await environment.execute(session.id,['sh','-c','printf "retained synthetic progress" > artifact.txt'],AbortSignal.timeout(10000));
store.checkpoint(claim.task.id,'synthetic',claim.generation,{summary:'Tool effect requires inspection',pendingTool:{id:'ambiguous',name:'shell',arguments:{command:'synthetic write'}}});
process.stdout.write(JSON.stringify({goalId:goal.id,taskId:claim.task.id,generation:claim.generation,sessionId:session.id,container:active.container})+'\\n');setInterval(()=>{},1000);`;
try {
  child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  const exited = once(child, "exit");
  const record = await new Promise((yes, no) => {
    let output = "",
      diagnostic = "";
    const timer = setTimeout(
      () => no(Error("Active crash proof setup timed out")),
      120000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        clearTimeout(timer);
        try {
          yes(JSON.parse(output.trim()));
        } catch (e) {
          no(e);
        }
      }
    });
    child.stderr.on("data", (chunk) => (diagnostic += chunk));
    child.once("error", (e) => {
      clearTimeout(timer);
      no(e);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      no(Error("Active crash proof setup failed: " + diagnostic.slice(-4000)));
    });
  });
  assert.equal(
    JSON.parse((await exec("docker", ["inspect", record.container])).stdout)[0]
      .State.Running,
    true,
  );
  child.kill("SIGKILL");
  await exited;
  const owner = JSON.parse(
    await readFile(join(state, "controller.lock"), "utf8"),
  );
  await recoverInstanceLock(state, owner.nonce);
  unlock = await lockInstance(state);
  db = new SqliteStore(join(state, "mission-control.db"), { mustExist: true });
  let store = new ControlStore(db);
  let registry = new EnvironmentRegistry(join(state, "sandbox"), db),
    environment = new DockerEnvironment(registry);
  await reconcileRuntime(
    store,
    registry,
    environment,
    { records: () => [], reconcile: async () => {} },
    () => {},
  );
  await assert.rejects(exec("docker", ["inspect", record.container]));
  assert.equal(
    await readFile(
      join(registry.get(record.sessionId).path, "artifact.txt"),
      "utf8",
    ),
    "retained synthetic progress",
  );
  assert.equal(store.getTask(record.taskId).status, "waiting_human");
  assert.equal(store.attempts(record.goalId)[0].outcome, "interrupted");
  assert.equal(store.canSpend(record.goalId).unresolvedUsd, 1);
  assert.equal(
    db.query("SELECT * FROM control_tokens WHERE role='worker'").length,
    0,
  );
  assert.throws(() =>
    store.assertLease(record.taskId, "synthetic", record.generation),
  );
  await reconcileRuntime(
    store,
    registry,
    environment,
    { records: () => [], reconcile: async () => {} },
    () => {},
  );
  assert.equal(store.questions().length, 1);
  db.close();
  db = undefined;
  await unlock();
  unlock = undefined;
  const relocated = join(root, "relocated");
  await rename(state, relocated);
  state = relocated;
  await inspectState(state);
  unlock = await lockInstance(state);
  db = new SqliteStore(join(state, "mission-control.db"), { mustExist: true });
  store = new ControlStore(db);
  registry = new EnvironmentRegistry(join(state, "sandbox"), db);
  environment = new DockerEnvironment(registry);
  await reconcileRuntime(
    store,
    registry,
    environment,
    { records: () => [], reconcile: async () => {} },
    () => {},
  );
  assert.equal(
    await readFile(
      join(registry.get(record.sessionId).path, "artifact.txt"),
      "utf8",
    ),
    "retained synthetic progress",
  );
  assert.equal(store.questions().length, 1);
  const q = store.questions()[0];
  store.answer(q.id, "inspect", q.revision, "synthetic-operator");
  assert.equal(store.getTask(record.taskId).checkpoint.pendingTool, undefined);
  assert.equal(db.integrityCheck().join(), "ok");
  console.log(
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        docker: fingerprint,
        image,
        activeContainerSigkill: true,
        leaseFenced: true,
        ownedContainerStopped: true,
        checkpointRetained: true,
        usageUnresolved: true,
        idempotentDecision: true,
        relocatedState: true,
        spendUsd: 0,
      },
      null,
      2,
    ),
  );
} finally {
  if (child?.exitCode === null && child?.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  if (!db)
    db = new SqliteStore(join(state, "mission-control.db"), {
      mustExist: true,
    });
  const registry = new EnvironmentRegistry(join(state, "sandbox"), db),
    environment = new DockerEnvironment(registry);
  // Cleanup only registered containers through their verified owner labels.
  for (const session of registry.all())
    if (session.container) await environment.reset(session.id);
  db.close();
  if (unlock) await unlock();
  await rm(root, { recursive: true, force: true });
}
