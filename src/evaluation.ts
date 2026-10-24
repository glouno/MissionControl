/** Offline comparison controller. No provider SDKs, credentials or native defaults. */
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  rm,
  rename,
} from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

export const CONTRACT_VERSION = 1;
export const IDENTITIES = [
  "codex-native",
  "missioncontrol-codex-native",
  "openhands-acp-codex",
  "openhands-sdk-model-loop",
] as const;
export type Identity = (typeof IDENTITIES)[number];
export type Provenance = "measured" | "estimated" | "unknown" | "synthetic";
export type Quantity = { value: number | null; provenance: Provenance };
export const unknown = (): Quantity => ({ value: null, provenance: "unknown" });
export const DEFAULT_BUDGET = {
  timeoutMs: 300_000,
  maxAttempts: 1,
  maxRestarts: 0,
  maxOutputBytes: 1_048_576,
  maxReportedTokens: 100_000,
  maxReportedCostUsd: 5,
};
export const METRICS = [
  "agentMs",
  "controllerMs",
  "checkMs",
  "reviewMs",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "costUsd",
] as const;
type Metrics = Record<(typeof METRICS)[number], Quantity>;
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Expected object");
  return v as Record<string, unknown>;
};
function keys(
  v: Record<string, unknown>,
  permitted: readonly string[],
  required = permitted,
) {
  if (
    Object.keys(v).some((k) => !permitted.includes(k)) ||
    required.some((k) => !(k in v))
  )
    throw Error("Contract fields invalid");
}
function label(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+ -]{0,159}$/.test(v)
  )
    throw Error("Expected bounded non-secret identifier");
  return v;
}
function number(v: unknown, max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)
    throw Error("Invalid nonnegative measurement");
  return v;
}
function integer(v: unknown, max: number) {
  const n = number(v, max);
  if (!Number.isInteger(n)) throw Error("Expected integer");
  return n;
}
function quantity(v: unknown): Quantity {
  const o = object(v);
  keys(o, ["value", "provenance"]);
  if (
    !["measured", "estimated", "unknown", "synthetic"].includes(
      String(o.provenance),
    )
  )
    throw Error("Invalid provenance");
  if (o.provenance === "unknown") {
    if (o.value !== null) throw Error("Unknown requires null");
    return unknown();
  }
  return { value: number(o.value), provenance: o.provenance as Provenance };
}
const emptyMetrics = (): Metrics =>
  Object.fromEntries(METRICS.map((k) => [k, unknown()])) as Metrics;

// Repository-owned fixture data stays in the existing source publication inventory.
// Neither expected values nor reference solutions enter the agent's repository.
const reservationSolution = `export function reserve(stock, reserved, quantity) {
  if (![stock, reserved, quantity].every(Number.isSafeInteger) || stock < 0 || reserved < 0 || reserved > stock || quantity <= 0) return { ok: false, reserved };
  if (quantity > stock - reserved) return { ok: false, reserved };
  return { ok: true, reserved: reserved + quantity };
}\n`;
const csvSolution = `export function normalize(csv) {
  if (typeof csv !== 'string') throw new Error('invalid');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) { if (c === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; continue; }
    if (c === '"') { if (field !== '' || closed) throw new Error('invalid'); quoted = true; continue; }
    if (c === ',' || c === '\\n' || c === '\\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') { if (c === '\\r') { if (csv[i + 1] !== '\\n') throw new Error('invalid'); i++; } rows.push(row); row = []; }
      continue;
    }
    if (closed) throw new Error('invalid'); field += c;
  }
  if (quoted) throw new Error('invalid');
  if (field !== '' || row.length || closed) { row.push(field); rows.push(row); }
  if (!rows.length) throw new Error('invalid');
  const headers = rows.shift().map(h => h.trim());
  if (headers.some(h => !h || h === '__proto__' || h === 'constructor' || h === 'prototype') || new Set(headers).size !== headers.length) throw new Error('invalid');
  const sorted = [...headers].sort();
  const output = rows.map(values => {
    if (values.length !== headers.length) throw new Error('invalid');
    return '{' + sorted.map(h => JSON.stringify(h) + ':' + JSON.stringify(values[headers.indexOf(h)].trim())).join(',') + '}';
  });
  return '[' + output.join(',') + ']\\n';
}\n`;
type Case = { args: unknown[]; expected?: unknown; throws?: true };
const reservationCases: Case[] = [];
for (let stock = 0; stock <= 5; stock++)
  for (let reserved = 0; reserved <= stock; reserved++)
    for (let q = -1; q <= 7; q++)
      reservationCases.push({
        args: [stock, reserved, q],
        expected: {
          ok: q > 0 && q <= stock - reserved,
          reserved: q > 0 && q <= stock - reserved ? reserved + q : reserved,
        },
      });
for (const args of [
  [-1, 0, 1],
  [2, -1, 1],
  [2, 3, 1],
  [1.5, 0, 1],
  [3, 0, 0.5],
  [3, 0, "1"],
  [3, null, 1],
  [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1],
])
  reservationCases.push({
    args,
    expected: {
      ok: args[0] === Number.MAX_SAFE_INTEGER && args[1] === 0,
      reserved:
        args[0] === Number.MAX_SAFE_INTEGER && args[1] === 0
          ? Number.MAX_SAFE_INTEGER
          : args[1],
    },
  });
const csvCases: Case[] = [
  { args: ["b,a\n 2 , 1 \n"], expected: '[{"a":"1","b":"2"}]\n' },
  // Literal strings are independent of object enumeration's numeric-key order.
  { args: ["2,10\nb,a\n"], expected: '[{"10":"a","2":"b"}]\n' },
  {
    args: ['"a""b",2,10,00,0\n"say ""hi""", two , ten ,zeroes,zero\n'],
    expected:
      '[{"0":"zero","00":"zeroes","10":"ten","2":"two","a\\"b":"say \\"hi\\""}]\n',
  },
  {
    args: ['name,note\r\nAda,"hello, world"\r\nBob,"said ""hi"""\r\n'],
    expected:
      JSON.stringify([
        { name: "Ada", note: "hello, world" },
        { name: "Bob", note: 'said "hi"' },
      ]) + "\n",
  },
  {
    args: ['z,a\n"line\nnext",é\n,\n'],
    expected: '[{"a":"é","z":"line\\nnext"},{"a":"","z":""}]\n',
  },
  { args: ["a,b"], expected: "[]\n" },
  {
    args: ["b,a\n2,1\n2,1"],
    expected: '[{"a":"1","b":"2"},{"a":"1","b":"2"}]\n',
  },
  ...[
    "",
    "a,a\n1,2",
    " ,b\n1,2",
    "__proto__,b\n1,2",
    "constructor\nx",
    "prototype\nx",
    "a,b\n1",
    'a\n"unclosed',
    'a\n"x"bad',
    'a\nx"y',
    "a\rx",
    "a,b\n\n",
  ].map((csv) => ({ args: [csv], throws: true as const })),
];
export const FIXTURES = {
  inventory: {
    version: 1,
    file: "reservation.mjs",
    entry: "reserve",
    solution: reservationSolution,
    cases: reservationCases,
    start:
      "export function reserve(stock, reserved, quantity) {\n  return quantity < stock - reserved ? { ok: true, reserved: reserved + quantity } : { ok: false, reserved };\n}\n",
    prompt:
      "Fix reserve(stock, reserved, quantity) in reservation.mjs. Inputs must be safe integers; stock >= 0, 0 <= reserved <= stock, quantity > 0. Accept quantity equal to available stock. On any invalid input or insufficient stock return {ok:false,reserved} preserving the original reserved value; success returns {ok:true,reserved:reserved+quantity}. No mutation. Export this synchronous pure function; no imports, external resources or top-level side effects. Only reservation.mjs may change. Do not change Git metadata, instructions, package.json, add files, commit, or create a checker. Acceptance is independent outside this repository.",
  },
  csv: {
    version: 1,
    file: "normalize.mjs",
    entry: "normalize",
    solution: csvSolution,
    cases: csvCases,
    start:
      "export function normalize(csv) {\n  throw new Error('not implemented');\n}\n",
    prompt:
      "Implement normalize(csv) in normalize.mjs as a synchronous pure function returning compact JSON plus exactly one LF. Parse comma-separated fields, LF or CRLF records, quoted commas/newlines and doubled quotes. Bare CR, unmatched/misplaced quotes or characters after a closing quote are invalid. Do not create an extra record for a final line ending. Trim headers and values; headers must be nonempty and unique and cannot be __proto__, constructor or prototype. Require every data row to match header width (blank records count). Preserve row order and duplicates; sort object keys in JavaScript default lexicographic order. All values remain strings. A header-only CSV returns [] plus LF. Empty input is invalid. Throw Error on invalid input. No imports, external resources or top-level side effects. Only normalize.mjs may change. Do not change Git metadata, instructions, package.json, add files, commit, or create a checker. Acceptance is independent outside this repository.",
  },
} as const;
export type FixtureId = keyof typeof FIXTURES;
function fixture(id: string) {
  if (!(id === "inventory" || id === "csv")) throw Error("Unknown fixture");
  return FIXTURES[id];
}
function startingFiles(id: FixtureId) {
  const f = fixture(id);
  return {
    "package.json":
      '{"private":true,"type":"module","engines":{"node":">=24 <25"}}\n',
    "TASK.md": f.prompt + "\n",
    [f.file]: f.start,
  };
}
export const fixtureHash = (id: FixtureId) =>
  hash(
    JSON.stringify({
      version: fixture(id).version,
      files: startingFiles(id),
      cases: fixture(id).cases,
    }),
  );

/** Bounded, no-follow inventory includes Git metadata, empty directories and modes. */
export async function snapshot(root: string) {
  const result: Record<string, string> = {};
  let count = 0,
    bytes = 0;
  const base = await lstat(root);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    resolve(root) !== (await realpath(root))
  )
    throw Error("Noncanonical repository");
  async function visit(dir: string, prefix: string, depth: number) {
    if (depth > 12) throw Error("Repository depth limit");
    const names = await readdir(dir);
    if (names.length > 512) throw Error("Repository entry limit");
    for (const name of names.sort()) {
      if (++count > 512) throw Error("Repository entry limit");
      const p = join(dir, name),
        relative = prefix + name,
        info = await lstat(p);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
      )
        throw Error("Unsafe repository entry");
      if (info.isDirectory()) {
        result[relative + "/"] = String(info.mode & 0o777);
        await visit(p, relative + "/", depth + 1);
      } else {
        bytes += info.size;
        if (bytes > 4_194_304 || info.size > 65_536)
          throw Error("Repository size limit");
        result[relative] = `${info.mode & 0o777}:${hash(await readFile(p))}`;
      }
    }
  }
  await visit(root, "", 0);
  return result;
}
export type Manifest = {
  schemaVersion: 1;
  fixture: FixtureId;
  fixtureHash: string;
  startTree: string;
  startCommit: string;
  baseline: Record<string, string>;
  sourceRevision: string;
  kitHash: string;
  attempts: Attempt[];
};
const gitEnvironment = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Evaluation Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Evaluation Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
function git(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    env: gitEnvironment,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
  }).trim();
}
export async function kitProvenance(kitRoot: string) {
  const sourceRevision = git(kitRoot, ["rev-parse", "HEAD"]);
  const paths = ["src/evaluation.ts", "scripts/evaluate-agents.mjs"];
  const kitHash = hash(
    JSON.stringify(
      await Promise.all(
        paths.map(async (p) => [p, hash(await readFile(join(kitRoot, p)))]),
      ),
    ),
  );
  return { sourceRevision, kitHash };
}
export async function prepare(
  id: FixtureId,
  directory: string,
  kitRoot: string,
): Promise<Manifest> {
  fixture(id);
  directory = resolve(directory);
  await mkdir(directory, { mode: 0o700 }); // Never overwrite or reset an existing run.
  const repo = join(directory, "repo");
  await mkdir(repo, { mode: 0o700 });
  for (const [name, content] of Object.entries(startingFiles(id)))
    await writeFile(join(repo, name), content, { mode: 0o644 });
  git(repo, ["init", "--quiet", "--initial-branch=task", "--template="]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["add", "--all"]);
  git(repo, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Pinned evaluation fixture v1",
  ]);
  await rm(join(repo, ".git", "index"));
  git(repo, ["read-tree", "HEAD"]);
  const manifest: Manifest = {
    schemaVersion: 1,
    fixture: id,
    fixtureHash: fixtureHash(id),
    startTree: git(repo, ["rev-parse", "HEAD^{tree}"]),
    startCommit: git(repo, ["rev-parse", "HEAD"]),
    baseline: await snapshot(repo),
    ...(await kitProvenance(kitRoot)),
    attempts: [],
  };
  await writeFile(join(directory, "manifest.json"), json(manifest), {
    mode: 0o600,
    flag: "wx",
  });
  return manifest;
}

export type Outcome =
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "output-limit"
  | "malformed"
  | "interrupted";
export type Attempt = {
  index: number;
  evidence: "live" | "synthetic";
  outcome: Outcome;
  wallMs: Quantity;
  checkWallMs: Quantity;
  metrics: Metrics;
  costBasis:
    | "provider-receipt"
    | "published-rate-estimate"
    | "subscription-included"
    | "unknown"
    | "synthetic";
  interventions: number;
  restarts: number;
  outputBytes: number;
  outputHash: string;
  exitCode: number | null;
  signal: string | null;
  terminalSeen: boolean;
  acceptance: { passed: boolean; reason: string; candidateHash: string | null };
  flags: string[];
  config: RunConfig;
  executableHash: string;
  requestHash: string;
  environment: {
    node: string;
    git: string;
    platform: string;
    architecture: string;
  };
};
export type Settings = {
  model: string;
  reasoning: string;
  authentication: "subscription" | "api" | "none";
  billing: "subscription" | "metered" | "none";
  permissions: string;
  isolation: string;
  environment: string;
};
export type RunConfig = {
  schemaVersion: 1;
  identity: Identity;
  executable: string;
  executableVersion: string;
  nativeVersion: string;
  wrapperRevision: string;
  evidence: "live" | "synthetic";
  settings: Settings;
  budget: typeof DEFAULT_BUDGET;
};
export function parseConfig(value: unknown): RunConfig {
  const o = object(value);
  keys(o, [
    "schemaVersion",
    "identity",
    "executable",
    "executableVersion",
    "nativeVersion",
    "wrapperRevision",
    "evidence",
    "settings",
    "budget",
  ]);
  if (
    o.schemaVersion !== 1 ||
    !IDENTITIES.includes(o.identity as Identity) ||
    !["live", "synthetic"].includes(String(o.evidence))
  )
    throw Error("Unsupported adapter contract");
  if (
    typeof o.executable !== "string" ||
    !isAbsolute(o.executable) ||
    o.executable.length > 1024 ||
    /[\x00-\x1f]/.test(o.executable)
  )
    throw Error("Absolute executable required");
  const s = object(o.settings);
  keys(s, [
    "model",
    "reasoning",
    "authentication",
    "billing",
    "permissions",
    "isolation",
    "environment",
  ]);
  for (const v of Object.values(s)) label(v);
  if (
    !["subscription", "api", "none"].includes(String(s.authentication)) ||
    !["subscription", "metered", "none"].includes(String(s.billing)) ||
    (s.authentication === "subscription") !== (s.billing === "subscription") ||
    (s.authentication === "api") !== (s.billing === "metered")
  )
    throw Error("Authentication/billing mismatch");
  const b = object(o.budget);
  keys(b, Object.keys(DEFAULT_BUDGET), []);
  const budget = { ...DEFAULT_BUDGET, ...b };
  if (
    integer(budget.timeoutMs, 300_000) < 1 ||
    integer(budget.maxOutputBytes, 1_048_576) < 1 ||
    integer(budget.maxAttempts, 3) < 1
  )
    throw Error("Empty budget");
  integer(budget.maxRestarts, 2);
  integer(budget.maxReportedTokens, 1_000_000);
  number(budget.maxReportedCostUsd, 100);
  return {
    schemaVersion: 1,
    identity: o.identity as Identity,
    executable: o.executable,
    executableVersion: label(o.executableVersion),
    nativeVersion: label(o.nativeVersion),
    wrapperRevision: label(o.wrapperRevision),
    evidence: o.evidence as "live" | "synthetic",
    settings: s as Settings,
    budget,
  };
}

/** Incremental NDJSON validation discards raw diagnostics; cumulative metrics never add twice. */
export class EventAccumulator {
  metrics = emptyMetrics();
  costBasis: Attempt["costBasis"] = "unknown";
  interventions = 0;
  restarts = 0;
  terminalSeen = false;
  helloSeen = false;
  outcome: Outcome = "failed";
  flags: string[] = [];
  sequence = 0;
  readonly config: RunConfig;
  constructor(config: RunConfig) {
    this.config = config;
  }
  accept(value: unknown) {
    const e = object(value);
    if (this.sequence >= 128) throw Error("Event count limit");
    if (e.schemaVersion !== 1 || e.seq !== this.sequence || this.terminalSeen)
      throw Error("Event sequence invalid");
    const common = ["schemaVersion", "seq", "type"];
    switch (e.type) {
      case "hello": {
        keys(e, [
          ...common,
          "identity",
          "effectiveSettings",
          "supportedSettings",
          "executableVersion",
          "nativeVersion",
        ]);
        if (
          this.helloSeen ||
          this.sequence !== 0 ||
          e.identity !== this.config.identity
        )
          throw Error("Adapter identity mismatch");
        const effective = object(e.effectiveSettings);
        keys(effective, Object.keys(this.config.settings));
        if (
          !Array.isArray(e.supportedSettings) ||
          e.supportedSettings.some(
            (k) => !Object.keys(this.config.settings).includes(String(k)),
          ) ||
          new Set(e.supportedSettings).size !== e.supportedSettings.length
        )
          throw Error("Invalid capabilities");
        for (const [k, v] of Object.entries(this.config.settings)) {
          label(effective[k]);
          if (!e.supportedSettings.includes(k))
            this.flags.push("unsupported:" + k);
          if (effective[k] !== v) this.flags.push("mismatch:" + k);
        }
        if (
          e.executableVersion !== this.config.executableVersion ||
          e.nativeVersion !== this.config.nativeVersion
        )
          this.flags.push("version-mismatch");
        this.helloSeen = true;
        break;
      }
      case "measurement": {
        keys(e, [...common, "metrics", "costBasis"]);
        if (!this.helloSeen) throw Error("Hello required");
        const m = object(e.metrics);
        keys(m, METRICS, []);
        // Validate the complete event before changing retained partial evidence.
        const next = { ...this.metrics };
        for (const [k, v] of Object.entries(m)) {
          const q = quantity(v),
            previous = this.metrics[k as keyof Metrics];
          if (
            k.endsWith("Tokens") &&
            q.value !== null &&
            !Number.isInteger(q.value)
          )
            throw Error("Fractional tokens");
          if (
            previous.value !== null &&
            (q.value === null ||
              q.value < previous.value ||
              q.provenance !== previous.provenance)
          )
            throw Error("Cumulative measurement regressed");
          next[k as keyof Metrics] = q;
        }
        if (
          ![
            "provider-receipt",
            "published-rate-estimate",
            "subscription-included",
            "unknown",
            "synthetic",
          ].includes(String(e.costBasis))
        )
          throw Error("Invalid cost basis");
        const cost = next.costUsd;
        if (
          this.config.settings.billing === "subscription" &&
          cost.value !== null
        )
          throw Error("Subscription dollars forbidden");
        if (
          cost.value !== null &&
          ((cost.provenance === "measured" &&
            e.costBasis !== "provider-receipt") ||
            (cost.provenance === "estimated" &&
              e.costBasis !== "published-rate-estimate") ||
            (cost.provenance === "synthetic" && e.costBasis !== "synthetic"))
        )
          throw Error("Cost provenance mismatch");
        if (
          this.config.evidence === "live" &&
          Object.values(next).some((q) => q.provenance === "synthetic")
        )
          this.flags.push("synthetic-measurement");
        this.metrics = next;
        this.costBasis = e.costBasis as Attempt["costBasis"];
        break;
      }
      case "intervention":
        keys(e, common);
        if (!this.helloSeen) throw Error("Hello required");
        this.interventions++;
        break;
      case "restart":
        keys(e, common);
        if (!this.helloSeen) throw Error("Hello required");
        this.restarts++;
        break;
      case "result":
        keys(e, [...common, "outcome"]);
        if (
          !this.helloSeen ||
          !["completed", "failed", "cancelled"].includes(String(e.outcome))
        )
          throw Error("Invalid terminal result");
        this.outcome = e.outcome as Outcome;
        this.terminalSeen = true;
        break;
      default:
        throw Error("Unknown event");
    }
    this.sequence++;
  }
}

export type ProcessEvidence = {
  outcome: Outcome;
  wallMs: number;
  outputBytes: number;
  outputHash: string;
  exitCode: number | null;
  signal: string | null;
};
/** No shell, clean environment, process-group kill, deadline and aggregate stdout/stderr cap. */
export async function boundedProcess(
  executable: string,
  args: string[],
  input: string,
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
  },
): Promise<ProcessEvidence & { stdout: string }> {
  const started = performance.now();
  if (options.signal?.aborted)
    return {
      outcome: "cancelled",
      wallMs: performance.now() - started,
      outputBytes: 0,
      outputHash: hash(""),
      exitCode: null,
      signal: null,
      stdout: "",
    };
  const decoder = new StringDecoder("utf8");
  const digest = createHash("sha256");
  let bytes = 0,
    stdout = "",
    pending = "",
    stop: Outcome | null = null,
    settled = false;
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    function terminate(reason: Outcome) {
      if (!stop) stop = reason;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
    function finish(code: number | null, signal: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      // Kill lingering descendants even after a wrapper exits normally.
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* dead */
        }
      }
      pending += decoder.end();
      if (stop !== "malformed" && pending.trim() && options.onLine) {
        try {
          options.onLine(pending);
        } catch {
          stop = stop ?? "malformed";
        }
      }
      resolvePromise({
        outcome: stop ?? (code === 0 ? "completed" : "failed"),
        wallMs: performance.now() - started,
        outputBytes: bytes,
        outputHash: digest.digest("hex"),
        exitCode: code,
        signal,
        stdout,
      });
    }
    const cancel = () => terminate("cancelled");
    const timer = setTimeout(() => {
      terminate("timeout");
      finish(null, "SIGKILL");
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.on("error", () => finish(null, null));
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const receive = (chunk: Buffer, isStdout: boolean) => {
      if (settled || stop) return;
      const remaining = options.maxOutputBytes - bytes;
      const kept = chunk.subarray(0, Math.max(remaining, 0));
      digest.update(kept);
      bytes += kept.length;
      if (isStdout) {
        const content = decoder.write(kept);
        if (options.onLine) {
          pending += content;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            try {
              if (!line.trim()) throw Error("Empty event");
              options.onLine(line);
            } catch {
              terminate("malformed");
              break;
            }
          }
        } else stdout += content;
      }
      if (chunk.length > remaining) terminate("output-limit");
    };
    child.stdout.on("data", (chunk) => receive(chunk, true));
    child.stderr.on("data", (chunk) => receive(chunk, false));
  });
}

// Pure-module evaluator: no host objects enter the VM; expected results stay in parent.
// VM and Node permissions are defense in depth, not the live OS isolation boundary.
const checkerSerializer = `(() => {
  const quote = JSON.stringify, ownKeys = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor, hasOwn = Object.hasOwn;
  const isArray = Array.isArray, finite = Number.isFinite;
  const isProxy = require("node:util").types.isProxy;
  function encode(value, depth = 0) {
    if (depth > 20) throw 0;
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return quote(value);
    if (typeof value === "number" && finite(value)) return quote(value);
    if (typeof value !== "object") throw 0;
    // Check before any reflection: Proxy traps can fabricate descriptors.
    if (isProxy(value)) throw 0;
    const names = ownKeys(value);
    let text = "", count = 0;
    if (isArray(value)) {
      const length = descriptor(value, "length").value;
      if (names.length !== length + 1) throw 0;
      for (let i = 0; i < length; i++) {
        const d = descriptor(value, "" + i);
        if (!d || !hasOwn(d, "value")) throw 0;
        text += (i ? "," : "") + encode(d.value, depth + 1);
      }
      return "[" + text + "]";
    }
    for (let i = 0; i < names.length; i++) {
      const key = names[i], d = descriptor(value, key);
      if (typeof key !== "string" || !hasOwn(d, "value") || !d.enumerable) throw 0;
      text += (count++ ? "," : "") + quote(key) + ":" + encode(d.value, depth + 1);
    }
    return "{" + text + "}";
  }
  return encode;
})();`;

const checkerProgram = `const vm = require('node:vm'); const encode = ${checkerSerializer}; let input = ''; process.stdin.on('data', b => input += b); process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input);
    const results = [];
    for (const args of request.args) {
      const context = vm.createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
      // Parse/link the original source with ES module semantics. Imports are
      // forbidden: only this bounded source copy belongs to the candidate.
      const candidate = new vm.SourceTextModule(request.source, {context});
      await candidate.link(() => { throw Error('Imports forbidden'); });
      await candidate.evaluate({timeout:25});
      // Invoke inside a timed module, without exposing host functions/objects.
      // The import also enforces the actual named export, not a source regex.
      const invocation = new vm.SourceTextModule(
        'import {' + request.entry + ' as invoke} from "candidate"; ' +
        'export let value; export let threw = false; ' +
        'try { value = invoke(...' + JSON.stringify(args) + '); } catch { threw = true; }',
        {context});
      await invocation.link(() => candidate);
      await invocation.evaluate({timeout:25});
      // Serialize in the trusted process. No candidate hooks or intrinsics are
      // used, and proxies (including nested/revoked ones) fail before reflection.
      results.push(invocation.namespace.threw ? {threw:true} :
        {value:JSON.parse(encode(invocation.namespace.value))});
    }
    process.stdout.write(JSON.stringify(results));
  } catch { process.exitCode = 1; }
});`;
export async function evaluate(
  id: FixtureId,
  repo: string,
  baseline: Record<string, string>,
): Promise<Attempt["acceptance"]> {
  let candidateHash: string | null = null;
  try {
    const f = fixture(id),
      after = await snapshot(repo),
      beforeKeys = Object.keys(baseline).sort();
    if (
      JSON.stringify(beforeKeys) !==
        JSON.stringify(Object.keys(after).sort()) ||
      beforeKeys.some((k) => k !== f.file && after[k] !== baseline[k]) ||
      after[f.file]?.split(":")[0] !== baseline[f.file]?.split(":")[0]
    )
      return { passed: false, reason: "forbidden-changes", candidateHash };
    const source = await readFile(join(repo, f.file), "utf8");
    candidateHash = hash(source);
    if (Buffer.byteLength(source) > 32768) throw Error("Source too large");
    const run = await boundedProcess(
      process.execPath,
      [
        "--permission",
        "--disable-proto=throw",
        "--experimental-vm-modules",
        "-e",
        checkerProgram,
      ],
      JSON.stringify({
        source,
        entry: f.entry,
        args: f.cases.map((c) => c.args),
      }),
      { cwd: tmpdir(), timeoutMs: 10_000, maxOutputBytes: 65536 },
    );
    if (run.outcome !== "completed")
      return {
        passed: false,
        reason: "checker-execution-failed",
        candidateHash,
      };
    const got = JSON.parse(run.stdout);
    if (!Array.isArray(got) || got.length !== f.cases.length)
      throw Error("Invalid results");
    const passed = f.cases.every(
      (c, i) =>
        JSON.stringify(got[i]) ===
        JSON.stringify(c.throws ? { threw: true } : { value: c.expected }),
    );
    if (JSON.stringify(await snapshot(repo)) !== JSON.stringify(after))
      return { passed: false, reason: "changed-during-check", candidateHash };
    return {
      passed,
      reason: passed ? "exact-results" : "incorrect-results",
      candidateHash,
    };
  } catch {
    return {
      passed: false,
      reason: "unsafe-or-malformed-candidate",
      candidateHash,
    };
  }
}

// A checkpoint is a lower bound, not a final receipt. Only a clean protocol
// termination can establish final accounting, including terminal task failures.
function accountingComplete(a: Attempt) {
  return (
    a.terminalSeen &&
    a.exitCode === 0 &&
    a.signal === null &&
    ["completed", "failed", "cancelled"].includes(a.outcome)
  );
}
function historyBudgetFlags(attempts: Attempt[], config: RunConfig): string[] {
  const flags: string[] = [];
  if (attempts.length > config.budget.maxAttempts) flags.push("attempt-limit");
  if (attempts.reduce((n, a) => n + a.restarts, 0) > config.budget.maxRestarts)
    flags.push("restart-limit");
  if (
    attempts.reduce((n, a) => n + (a.metrics.totalTokens.value ?? 0), 0) >
    config.budget.maxReportedTokens
  )
    flags.push("reported-token-limit");
  if (
    config.settings.billing === "metered" &&
    attempts.reduce((n, a) => n + (a.metrics.costUsd.value ?? 0), 0) >
      config.budget.maxReportedCostUsd
  )
    flags.push("reported-cost-limit");
  return flags;
}
export function admission(attempts: Attempt[], config: RunConfig): string[] {
  const flags = historyBudgetFlags(attempts, config);
  if (attempts.length >= config.budget.maxAttempts) flags.push("attempt-limit");
  if (
    attempts.some(
      (a) =>
        !accountingComplete(a) ||
        a.metrics.totalTokens.value === null ||
        !(
          config.evidence === "synthetic"
            ? ["measured", "synthetic"]
            : ["measured"]
        ).includes(a.metrics.totalTokens.provenance),
    )
  )
    flags.push("unknown-token-admission");
  if (
    attempts.reduce((n, a) => n + (a.metrics.totalTokens.value ?? 0), 0) >=
      config.budget.maxReportedTokens &&
    attempts.length
  )
    flags.push("token-admission-limit");
  if (config.settings.billing === "metered") {
    if (
      attempts.some(
        (a) =>
          !accountingComplete(a) ||
          a.metrics.costUsd.value === null ||
          a.metrics.costUsd.provenance !== "measured",
      )
    )
      flags.push("unknown-cost-admission");
    if (
      attempts.reduce((n, a) => n + (a.metrics.costUsd.value ?? 0), 0) >=
        config.budget.maxReportedCostUsd &&
      attempts.length
    )
      flags.push("cost-admission-limit");
  }
  return flags;
}
async function boundedRead(path: string, limit: number) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > limit
  )
    throw Error("Invalid bounded file");
  return readFile(path);
}
async function saveManifest(directory: string, manifest: Manifest) {
  const temporary = join(directory, "manifest.next.json");
  await writeFile(temporary, json(manifest), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(directory, "manifest.json"));
}
export async function readManifest(directory: string): Promise<Manifest> {
  const m = JSON.parse(
    (await boundedRead(join(directory, "manifest.json"), 1_048_576)).toString(),
  );
  if (
    m.schemaVersion !== 1 ||
    !Array.isArray(m.attempts) ||
    m.attempts.length > 3 ||
    m.fixtureHash !== fixtureHash(m.fixture)
  )
    throw Error("Manifest binding invalid");
  return m;
}
export async function runAdapter(
  directory: string,
  rawConfig: unknown,
  kitRoot: string,
  signal?: AbortSignal,
): Promise<Attempt> {
  const config = parseConfig(rawConfig),
    m = await readManifest(directory),
    current = await kitProvenance(kitRoot);
  if (
    m.kitHash !== current.kitHash ||
    m.sourceRevision !== current.sourceRevision
  )
    throw Error("Kit revision changed: prepare a fresh run");
  if (
    config.evidence === "live" &&
    config.identity === "missioncontrol-codex-native" &&
    config.settings.authentication === "subscription"
  )
    throw Error(
      "Pending: MissionControl subscription admission requires private exact-runtime qualification; this kit cannot grant it",
    );
  if (
    config.evidence === "live" &&
    (config.settings.isolation === "unknown" ||
      config.settings.authentication === "none" ||
      config.nativeVersion === "unknown")
  )
    throw Error("Live provenance/isolation incomplete");
  if (
    m.attempts.length &&
    JSON.stringify(m.attempts[0].config) !== JSON.stringify(config)
  )
    throw Error("Run configuration changed: prepare a fresh run");
  const blockers = admission(m.attempts, config);
  if (blockers.length) throw Error("Admission refused: " + blockers.join(","));
  directory = resolve(directory);
  const lock = join(directory, "active.lock");
  await writeFile(lock, "active\n", { flag: "wx", mode: 0o600 });
  try {
    const executableHash = hash(
      await boundedRead(config.executable, 16_777_216),
    );
    if (m.attempts.some((a) => a.executableHash !== executableHash))
      throw Error("Executable changed: prepare a fresh run");
    const state = new EventAccumulator(config),
      repo = join(directory, "repo"),
      index = m.attempts.length + 1;
    const remainingRestarts =
      config.budget.maxRestarts -
      m.attempts.reduce((n, a) => n + a.restarts, 0);
    const request = {
      schemaVersion: 1,
      type: "request",
      attempt: index,
      identity: config.identity,
      repository: repo,
      prompt: fixture(m.fixture).prompt,
      permittedChanges: [fixture(m.fixture).file],
      fixture: {
        id: m.fixture,
        hash: m.fixtureHash,
        startTree: m.startTree,
        startCommit: m.startCommit,
      },
      settings: config.settings,
      budget: { ...config.budget, maxRestarts: remainingRestarts },
    };
    const environment = {
      node: process.version,
      git: git(kitRoot, ["--version"]),
      platform: process.platform,
      architecture: process.arch,
    };
    const measured = (value: number): Quantity => ({
      value,
      provenance: config.evidence === "synthetic" ? "synthetic" : "measured",
    });
    const a: Attempt = {
      index,
      evidence: config.evidence,
      outcome: "interrupted",
      wallMs: unknown(),
      checkWallMs: unknown(),
      metrics: emptyMetrics(),
      costBasis: "unknown",
      interventions: 0,
      restarts: 0,
      outputBytes: 0,
      outputHash: hash(""),
      exitCode: null,
      signal: null,
      terminalSeen: false,
      acceptance: { passed: false, reason: "pending", candidateHash: null },
      flags: [],
      config,
      executableHash,
      requestHash: hash(JSON.stringify(request)),
      environment,
    };
    m.attempts.push(a);
    const persist = () => saveManifest(directory, m);
    await persist(); // Durable start consumes admission even if the controller crashes.
    let writes = Promise.resolve();
    const start = performance.now();
    const processEvidence = await boundedProcess(
      config.executable,
      [],
      JSON.stringify(request) + "\n",
      {
        cwd: repo,
        timeoutMs: config.budget.timeoutMs,
        maxOutputBytes: config.budget.maxOutputBytes,
        signal,
        onLine: (line) => {
          state.accept(JSON.parse(line));
          a.metrics = { ...state.metrics };
          a.costBasis = state.costBasis;
          a.interventions = state.interventions;
          a.restarts = state.restarts;
          a.terminalSeen = state.terminalSeen;
          a.wallMs = measured(performance.now() - start);
          // Capture immutable copies, preserving valid partial events after failure.
          const checkpoint = JSON.parse(json(m)) as Manifest;
          writes = writes.then(() => saveManifest(directory, checkpoint));
          if (state.restarts > remainingRestarts) throw Error("Restart limit");
        },
      },
    );
    await writes;
    a.wallMs = measured(processEvidence.wallMs);
    a.outputBytes = processEvidence.outputBytes;
    a.outputHash = processEvidence.outputHash;
    a.exitCode = processEvidence.exitCode;
    a.signal = processEvidence.signal;
    a.outcome =
      processEvidence.outcome === "completed"
        ? state.terminalSeen
          ? state.outcome
          : "malformed"
        : processEvidence.outcome;
    a.flags = [...state.flags];
    if (!state.helloSeen || !state.terminalSeen)
      a.flags.push("incomplete-protocol");
    a.flags.push(...historyBudgetFlags(m.attempts, config));
    if (
      a.metrics.totalTokens.value !== null &&
      a.metrics.totalTokens.value > config.budget.maxReportedTokens
    )
      a.flags.push("reported-token-limit");
    if (
      a.metrics.costUsd.value !== null &&
      a.metrics.costUsd.value > config.budget.maxReportedCostUsd
    )
      a.flags.push("reported-cost-limit");
    try {
      if (
        hash(await boundedRead(config.executable, 16_777_216)) !==
        executableHash
      )
        a.flags.push("executable-changed");
    } catch {
      a.flags.push("executable-unavailable");
    }
    try {
      if ((await kitProvenance(kitRoot)).kitHash !== m.kitHash)
        a.flags.push("trusted-kit-changed");
    } catch {
      a.flags.push("trusted-kit-unavailable");
    }
    const checkStart = performance.now();
    a.acceptance = await evaluate(m.fixture, repo, m.baseline);
    a.checkWallMs = measured(performance.now() - checkStart);
    await persist();
    return a;
  } finally {
    await rm(lock, { force: true });
  }
}

export function comparisonFlags(a: Manifest, b: Manifest): string[] {
  const flags: string[] = [];
  if (a.fixtureHash !== b.fixtureHash || a.startTree !== b.startTree)
    flags.push("fixture-mismatch");
  if (a.sourceRevision !== b.sourceRevision || a.kitHash !== b.kitHash)
    flags.push("source-mismatch");
  const x = a.attempts.at(-1),
    y = b.attempts.at(-1);
  if (!x || !y) return [...flags, "pending"];
  if (x.config.nativeVersion !== y.config.nativeVersion)
    flags.push("native-version-mismatch");
  for (const m of [a, b])
    for (const attempt of m.attempts)
      for (const flag of historyBudgetFlags(m.attempts, attempt.config))
        if (!flags.includes(flag)) flags.push(flag);
  for (const k of ["settings", "budget"] as const)
    if (JSON.stringify(x.config[k]) !== JSON.stringify(y.config[k]))
      flags.push(k + "-mismatch");
  if (JSON.stringify(x.environment) !== JSON.stringify(y.environment))
    flags.push("environment-mismatch");
  if (
    (x.config.identity === "openhands-sdk-model-loop") !==
    (y.config.identity === "openhands-sdk-model-loop")
  )
    flags.push("execution-family-mismatch");
  return flags;
}
export function eligible(m: Manifest) {
  return (
    m.attempts.length > 0 &&
    m.attempts.every((a) => !historyBudgetFlags(m.attempts, a.config).length) &&
    m.attempts.every(
      (a) =>
        a.evidence === "live" &&
        a.outcome === "completed" &&
        accountingComplete(a) &&
        a.acceptance.passed &&
        !a.flags.length &&
        a.wallMs.provenance === "measured" &&
        a.metrics.totalTokens.provenance === "measured" &&
        a.metrics.agentMs.provenance === "measured",
    )
  );
}
export function summarize(m: Manifest) {
  const sum = (values: Quantity[]): Quantity => {
    if (!values.length || values.some((q) => q.value === null))
      return unknown();
    const provenance: Provenance = values.some(
      (q) => q.provenance === "synthetic",
    )
      ? "synthetic"
      : values.some((q) => q.provenance === "estimated")
        ? "estimated"
        : "measured";
    return { value: values.reduce((n, q) => n + q.value!, 0), provenance };
  };
  return {
    attempts: m.attempts.length,
    restarts: m.attempts.reduce((n, a) => n + a.restarts, 0),
    interventions: m.attempts.reduce((n, a) => n + a.interventions, 0),
    wallMs: sum(m.attempts.map((a) => a.wallMs)),
    checkWallMs: sum(m.attempts.map((a) => a.checkWallMs)),
    metrics: Object.fromEntries(
      METRICS.map((k) => [k, sum(m.attempts.map((a) => a.metrics[k]))]),
    ),
    usageComplete:
      m.attempts.length > 0 &&
      m.attempts.every(
        (a) => accountingComplete(a) && a.metrics.totalTokens.value !== null,
      ),
    eligible: eligible(m),
  };
}
export function report(manifests: Manifest[]) {
  const comparisons = [];
  for (let i = 0; i < manifests.length; i++)
    for (let j = i + 1; j < manifests.length; j++) {
      const flags = comparisonFlags(manifests[i], manifests[j]);
      if (!eligible(manifests[i]) || !eligible(manifests[j]))
        flags.push("rejected-or-incomplete-or-synthetic");
      comparisons.push({
        runs: [i, j],
        status: flags.length ? "excluded" : "comparable-observations",
        flags,
      });
    }
  return {
    schemaVersion: 1,
    liveMatrix: IDENTITIES.map((identity) => ({
      identity,
      status: "pending",
      family:
        identity === "openhands-sdk-model-loop"
          ? "sdk-model-loop"
          : "native-agent",
      reason:
        identity === "missioncontrol-codex-native"
          ? "Exact-runtime private admission/qualification required"
          : "No delivered live acceptance evidence",
    })),
    runs: manifests,
    summaries: manifests.map(summarize),
    comparisons,
    performanceConclusion:
      "pending; no ranking is established by synthetic evidence or a single observation",
  };
}
export async function selfVerify(kitRoot: string) {
  const directory = await mkdtemp(join(tmpdir(), "mc-eval-self-"));
  try {
    const evidence = [];
    for (const id of ["inventory", "csv"] as const) {
      const a = join(directory, id + "-a"),
        b = join(directory, id + "-b");
      const first = await prepare(id, a, kitRoot),
        second = await prepare(id, b, kitRoot);
      if (
        first.startTree !== second.startTree ||
        first.startCommit !== second.startCommit ||
        JSON.stringify(first.baseline) !== JSON.stringify(second.baseline)
      )
        throw Error("Nondeterministic fixture");
      const initial = await evaluate(id, join(a, "repo"), first.baseline);
      if (initial.passed) throw Error("Broken starting fixture accepted");
      await writeFile(join(a, "repo", fixture(id).file), fixture(id).solution);
      const correct = await evaluate(id, join(a, "repo"), first.baseline);
      if (!correct.passed)
        throw Error("Reference fixture rejected: " + id + ":" + correct.reason);
      evidence.push({
        fixture: id,
        startTree: first.startTree,
        startCommit: first.startCommit,
        fixtureHash: first.fixtureHash,
        initial,
        correct,
        evidence: "synthetic",
      });
    }
    return { schemaVersion: 1, passed: true, evidence };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
