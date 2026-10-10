import "./canonical-temp.mjs";
// Real isolated tool-loop lifecycle with synthetic controller-side inference.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { git } from "../dist/control/git.js";
import { SqliteStore } from "../dist/sqlite.js";
import {
  EnvironmentRegistry,
  DockerEnvironment,
} from "../dist/control/environments.js";
import { InferenceGateway } from "../dist/control/inferenceGateway.js";
import { IsolatedBackend } from "../dist/control/isolatedBackend.js";
import { IsolatedVerifier } from "../dist/control/isolatedVerifier.js";
import { goalSchema } from "../dist/control/schema.js";
const image = (await readFile(process.argv[2], "utf8")).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image))
  throw Error("Supply reviewed immutable image digest file");
const root = await mkdtemp(join(tmpdir(), "mc-portable-proof-")),
  source = join(root, "trusted");
await mkdir(source);
await git(source, ["init", "-b", "main"]);
await writeFile(join(source, "README.md"), "Synthetic source");
await git(source, ["add", "."]);
await git(source, [
  "-c",
  "user.name=Synthetic",
  "-c",
  "user.email=synthetic@example.invalid",
  "commit",
  "-m",
  "Synthetic base",
]);
const registry = new EnvironmentRegistry(join(root, "sandbox")),
  environment = new DockerEnvironment(registry),
  db = new SqliteStore(join(root, "gateway.db")),
  gateway = new InferenceGateway(db, {}, () => {});
const config = goalSchema.parse({
  title: "Synthetic",
  description: "Synthetic",
  repoPath: source,
  backend: {
    kind: "azure",
    model: "synthetic",
    endpoint: "https://provider.example",
    credential: "key",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
  },
  estimatePerRunUsd: 1,
  verificationCommands: ["test -f artifact.txt"],
});
const claim = {
  goal: { id: "goal", config },
  task: {
    id: "task",
    spec: {
      cpuUnits: 1,
      memoryMiB: 512,
      allowedPaths: ["artifact.txt"],
      verificationCommands: ["test -f artifact.txt"],
    },
  },
  generation: 1,
  workerId: "synthetic",
};
let calls = 0;
const provider = {
  cost: () => 0,
  generate: async (messages) => {
    if (calls++ === 0)
      return {
        text: "",
        calls: [
          { id: "read", name: "read_file", arguments: { path: "README.md" } },
          {
            id: "escape",
            name: "write_file",
            arguments: { path: "../escaped", content: "forbidden" },
          },
          {
            id: "denied",
            name: "shell",
            arguments: {
              command:
                "python3 -c \"import socket; socket.create_connection(('169.254.169.254',80),timeout=.2)\"",
            },
          },
          {
            id: "write",
            name: "write_file",
            arguments: { path: "artifact.txt", content: "synthetic artifact" },
          },
        ],
        inputTokens: 1,
        outputTokens: 1,
      };
    assert.equal(
      messages.find((m) => m.callId === "read").content,
      "Synthetic source",
    );
    assert.match(
      messages.find((m) => m.callId === "escape").content,
      /outside workspace/,
    );
    assert.ok(
      JSON.parse(messages.find((m) => m.callId === "denied").content)
        .exitCode !== 0,
    );
    return {
      text: "Synthetic implementation",
      calls: [],
      inputTokens: 1,
      outputTokens: 1,
    };
  },
};
const backend = new IsolatedBackend(
  environment,
  registry,
  {
    acquire: () => {
      throw Error("Portable tools must not have network");
    },
    stop: () => {
      throw Error("Unexpected network");
    },
  },
  gateway,
  {
    imageDigest: image,
    provider: "synthetic",
    socketDirectory: root,
    relayScript: "unused",
    assertLease: () => {},
    portableProvider: provider,
  },
);
try {
  const result = await backend.run({
    claim,
    workspace: source,
    mode: "implement",
    prompt: "Synthetic goal",
    signal: AbortSignal.timeout(30000),
    onCheckpoint: async () => {},
  });
  assert.equal(
    await readFile(join(source, "artifact.txt"), "utf8"),
    "synthetic artifact",
  );
  assert.equal(registry.get(result.executionSessionId).container, undefined);
  assert.equal(result.costStatus, "estimated_unknown");
  await git(source, [
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-am",
    "Synthetic artifact",
  ]);
  const check = await new IsolatedVerifier(environment, image).verify(
    claim,
    source,
  );
  assert.equal(check.passed, true);
  console.log(
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        syntheticInference: true,
        isolatedTools: true,
        traversalDenied: true,
        privateNetworkDenied: true,
        stoppedScopedImport: true,
        independentChecks: true,
        credentialsUsed: false,
        inferenceSpendUsd: 0,
      },
      null,
      2,
    ),
  );
} finally {
  for (const s of registry.all()) await environment.reset(s.id);
  registry.db.close();
  db.close();
  await rm(root, { recursive: true, force: true });
}
