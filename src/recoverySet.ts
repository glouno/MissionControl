import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LoadedConfiguration } from "./config.js";
import {
  createBackup,
  restoreBackup,
  assertQuiescentBackup,
} from "./backup.js";
import { sealPrivateStore, openPrivateStore } from "./privateBundle.js";
import { acquireMatrixSnapshot, restoreMatrixStore } from "./matrixRecovery.js";
import { acquireAuthEnvironment } from "./control/authEnvironment.js";
import { restoreAuthStore } from "./control/authBackup.js";
import type { ControlStore } from "./control/store.js";
import { SqliteStore } from "./sqlite.js";
import { ControlStore as Store } from "./control/store.js";

const file = z
  .object({
    path: z.string().regex(/^[a-z0-9.-]+\.age$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const catalogSchema = z
  .object({
    format: z.literal("missioncontrol-recovery-set-v1"),
    instanceId: z.string(),
    configurationHash: z.string(),
    application: file,
    auth: z.array(file.extend({ id: z.string(), storeInstance: z.string() })),
    matrix: z.array(
      file.extend({
        id: z.string(),
        identity: z.record(z.string(), z.string()),
      }),
    ),
    externalRequirements: z.array(z.string()),
    qualified: z.literal(false),
  })
  .strict();
async function hash(path: string) {
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest("hex");
}
/** Offline caller owns application DB for the entire coordinated recovery set. */
export async function createRecoverySet(
  store: ControlStore,
  config: LoadedConfiguration,
  destination: string,
  recipientFile: string,
) {
  for (const root of [
    config.root,
    config.settings.stateDir,
    config.settings.secretsDir,
  ]) {
    const rel = relative(resolve(root), resolve(destination));
    if (!rel || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)))
      throw Error(
        "Recovery set must live outside configuration, application and secrets",
      );
  }
  try {
    await lstat(resolve(destination));
    throw Error("Recovery set destination must be new");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertQuiescentBackup(store.db);
  const pending = store.setting("subscription-auth-runs") as
    { status: string }[] | undefined;
  if (pending?.some((r) => r.status !== "stopped"))
    throw Error(
      "Recover all authentication resources before coordinated backup",
    );
  const applied = store.setting("configuration-snapshot") as
    LoadedConfiguration | undefined;
  if (applied && applied.hash !== config.hash)
    throw Error(
      "Coordinated backup requires the explicitly applied configuration",
    );
  const stage = await mkdtemp(join(tmpdir(), "mc-recovery-set-"));
  const release: (() => Promise<void>)[] = [],
    held: (() => void)[] = [];
  let completed = false,
    published = false;
  try {
    const auth = [];
    // Hold every writer from before application copy through final set encryption.
    for (const a of config.auth) {
      const owner = await acquireAuthEnvironment(a, config.settings.secretsDir);
      release.push(owner.release);
      auth.push({ config: a, owner });
    }
    const matrices = [];
    for (const c of config.connectors.filter((c) => c.kind === "matrix")) {
      if (c.kind !== "matrix") continue;
      const { binary, companionConfig } = c.settings;
      if (!binary || !companionConfig) {
        if (c.enabled)
          throw Error("Enabled Matrix requires explicit backup configuration");
        continue;
      }
      const owner = await acquireMatrixSnapshot(companionConfig, binary);
      release.push(owner.release);
      held.push(owner.assertHeld);
      matrices.push({ id: c.id, owner });
    }
    for (const check of held) check();
    const application = await createBackup(
      store.db,
      config.settings.stateDir,
      join(stage, "application.age"),
      recipientFile,
      true,
    );
    const catalog: z.output<typeof catalogSchema> = {
      format: "missioncontrol-recovery-set-v1",
      instanceId: application.instanceId,
      configurationHash: config.hash,
      application: {
        path: "application.age",
        sha256: await hash(join(stage, "application.age")),
      },
      auth: [],
      matrix: [],
      externalRequirements: [
        "Reviewed external configuration and non-session secret store",
        "Homeserver PostgreSQL/media/configuration/signing-key recovery",
        "Real off-host retrieval and synthetic restored workflow",
      ],
      qualified: false,
    };
    for (const { config: a, owner } of auth) {
      const path = `auth-${a.id}.age`;
      const result = await sealPrivateStore(
        owner.path,
        join(stage, path),
        recipientFile,
        "subscription",
        {
          id: owner.identity.id,
          harness: owner.identity.harness,
          instance: owner.identity.instance,
          policyHash: owner.identity.policyHash,
        },
        ["writer.lock", "session/tmp"],
      );
      catalog.auth.push({
        id: a.id,
        storeInstance: owner.identity.instance,
        path,
        sha256: result.bundleSha256,
      });
    }
    for (const { id, owner } of matrices) {
      const path = `matrix-${id}.age`;
      const result = await sealPrivateStore(
        owner.snapshot,
        join(stage, path),
        recipientFile,
        "matrix",
        owner.identity,
      );
      catalog.matrix.push({
        id,
        identity: owner.identity,
        path,
        sha256: result.bundleSha256,
      });
    }
    await writeFile(
      join(stage, "catalog.json"),
      JSON.stringify(catalogSchema.parse(catalog), null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    for (const check of held) check();
    const result = await sealPrivateStore(
      stage,
      resolve(destination),
      recipientFile,
      "recovery-set",
      { instanceId: application.instanceId, configurationHash: config.hash },
    );
    published = true;
    for (const check of held) check();
    completed = true;
    return {
      created: true,
      application: true,
      authStores: catalog.auth.length,
      matrixStores: catalog.matrix.length,
      bundleSha256: result.bundleSha256,
      qualified: false,
      externalRequirements: catalog.externalRequirements,
    };
  } finally {
    if (published && !completed)
      await rm(resolve(destination), { force: true });
    const failures = [];
    for (const close of release.reverse())
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    await rm(stage, { recursive: true, force: true });
    if (failures.length)
      throw Error(
        "Recovery set ownership release failed; inspect private resources before retrying",
      );
  }
}
/** Restores only into a new isolated destination; never starts/authenticates services. */
export async function restoreRecoverySet(
  config: LoadedConfiguration,
  bundle: string,
  identityFile: string,
  destination: string,
) {
  const root = resolve(destination);
  const parent = dirname(root);
  if (
    (await realpath(parent)) !== parent ||
    (await lstat(parent)).isSymbolicLink()
  )
    throw Error("Recovery destination parent must be canonical");
  try {
    await lstat(root);
    throw Error("Recovery set destination must be new");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(root, { mode: 0o700 });
  try {
    const opened = await openPrivateStore(
      bundle,
      identityFile,
      join(root, "bundles"),
      "recovery-set",
      (manifest) => {
        if (!manifest.files.some((f) => f.path === "catalog.json"))
          throw Error("Recovery set catalog missing");
      },
    );
    const catalog = catalogSchema.parse(
      JSON.parse(await readFile(join(root, "bundles/catalog.json"), "utf8")),
    );
    if (
      catalog.instanceId !== opened.manifest.identity.instanceId ||
      catalog.configurationHash !== opened.manifest.identity.configurationHash
    )
      throw Error("Recovery set identity mismatch");
    if (
      new Set(catalog.auth.map((a) => a.id)).size !== catalog.auth.length ||
      new Set(catalog.matrix.map((a) => a.id)).size !== catalog.matrix.length
    )
      throw Error("Duplicate recovery store");
    // Require reviewed config with the exact store policies and permanent Matrix identities.
    if (config.hash !== catalog.configurationHash)
      throw Error(
        "Supply original reviewed configuration for store recovery; relocate/apply explicitly afterwards",
      );
    if (
      JSON.stringify(config.auth.map((a) => a.id).sort()) !==
      JSON.stringify(catalog.auth.map((a) => a.id).sort())
    )
      throw Error("Authentication recovery inventory differs");
    for (const file of [
      catalog.application,
      ...catalog.auth,
      ...catalog.matrix,
    ])
      if ((await hash(join(root, "bundles", file.path))) !== file.sha256)
        throw Error("Recovery set payload hash differs");
    await restoreBackup(
      join(root, "bundles", catalog.application.path),
      identityFile,
      join(root, "application"),
    );
    await mkdir(join(root, "authentication"), { mode: 0o700 });
    const db = new SqliteStore(join(root, "application/mission-control.db"), {
      mustExist: true,
    });
    try {
      const store = new Store(db);
      for (const entry of catalog.auth) {
        const a = config.auth.find((a) => a.id === entry.id)!;
        const result = await restoreAuthStore(
          store,
          a,
          join(root, "authentication"),
          join(root, "bundles", entry.path),
          identityFile,
        );
        if (result.storeInstance !== entry.storeInstance)
          throw Error("Restored auth identity differs");
      }
    } finally {
      db.close();
    }
    await mkdir(join(root, "matrix"), { mode: 0o700 });
    for (const entry of catalog.matrix) {
      const c = config.connectors.find((c) => c.id === entry.id);
      if (
        c?.kind !== "matrix" ||
        !c.settings.binary ||
        !c.settings.companionConfig
      )
        throw Error("Missing reviewed Matrix restore configuration");
      await restoreMatrixStore(
        c.settings.companionConfig,
        c.settings.binary,
        join(root, "bundles", entry.path),
        identityFile,
        join(root, "matrix", entry.id),
      );
    }
    const result = {
      restored: true,
      isolated: true,
      servicesStarted: false,
      authenticated: false,
      qualified: false,
      authStores: catalog.auth.length,
      matrixStores: catalog.matrix.length,
      externalRequirements: catalog.externalRequirements,
      nextAction:
        "Review relocated paths, provision fresh controller tokens, apply config offline and run synthetic recovery workflow before activation",
    };
    await writeFile(
      join(root, "restore-status.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return result;
  } catch (error) {
    await writeFile(
      join(root, "restore-status.json"),
      JSON.stringify({
        restored: false,
        servicesStarted: false,
        action:
          "Inspect isolated partial restoration; original instance is untouched",
      }) + "\n",
      { mode: 0o600 },
    );
    throw error;
  }
}
