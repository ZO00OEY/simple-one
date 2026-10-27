import assert from "node:assert/strict";
import { build } from "esbuild";
const output = await build({ entryPoints: ["src/features/sync/storage.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { migrateLinkFiles, readLocalSyncSettings, legacySyncRunning, writeApiLocal, readApiLocal, writeLocalSyncSettings } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const root = ".custom/plugins/", legacy = root + "simple-link/", current = root + "simple-one/";
const files = new Map([
  [current + "data.json", JSON.stringify({ diary: { enabled: true }, token: "parent-private" })],
  [legacy + "data.json", JSON.stringify({ enabled: true, mobile: { token: "device-token", plugins: ["simple-link", "sample"] }, boundRepoUrl: "https://github.com/a/b.git" })],
  [legacy + "sync-settings.json", JSON.stringify({ enabled: true, boundRepoUrl: "https://github.com/a/b.git", token: "must-not-share", mobile: { token: "must-not-share" } })],
  [legacy + "link-state.json", JSON.stringify({ schema: 1, pending: { commit: "keep" } })],
  [legacy + "link-state.json.recovery", JSON.stringify({ schema: 1, pending: { commit: "recover" } })],
]);
const original = new Map(files), writes = [];
const adapter = { exists: async path => files.has(path), read: async path => files.get(path), write: async (path, content) => { writes.push(path); files.set(path, content); } };
const keys = new Set(["boundRepoUrl"]);
await migrateLinkFiles(adapter, ".custom", "simple-one", false, keys);
let settings = await readLocalSyncSettings(adapter, ".custom", "simple-one");
assert.equal(settings.enabled, false);
assert.equal(settings.setupComplete, false, "native Git must review the migrated plugin exclusions");
assert.equal(settings.legacyMigrationPending, true);
assert.deepEqual(settings.mobile.plugins, ["simple-one", "sample"]);
assert.equal(settings.mobile.token, "device-token");
assert(!files.has(current + "link-state.json"), "running legacy engine journals are deferred");
assert.deepEqual(JSON.parse(files.get(current + "sync-settings.json")), { boundRepoUrl: "https://github.com/a/b.git" });
await migrateLinkFiles(adapter, ".custom", "simple-one", true, keys);
settings = await readLocalSyncSettings(adapter, ".custom", "simple-one");
assert.equal(settings.legacyMigrationPending, false);
assert.deepEqual(JSON.parse(files.get(current + "link-state.json")).pending, { commit: "keep" });
assert.deepEqual(JSON.parse(files.get(current + "link-state.json.recovery")).pending, { commit: "recover" });
for (const [path, content] of original) assert.equal(files.get(path), content, `original preserved: ${path}`);
files.set(current + "sync-local.json", JSON.stringify({ enabled: true, legacyMigrationPending: false, own: "configured" }));
files.set(current + "link-state.json", "user-established-state");
const count = writes.length;
await migrateLinkFiles(adapter, ".custom", "simple-one", true, keys);
assert.equal(writes.length, count, "migration is idempotent and preserves destination configuration");
assert.equal(files.get(current + "link-state.json"), "user-established-state");
assert(legacySyncRunning({ plugins: { enabledPlugins: new Set(["simple-link"]), plugins: {} } }));
assert(!legacySyncRunning({ plugins: { enabledPlugins: new Set(["simple-link"]), plugins: { "simple-link": { settings: { enabled: false } } } } }));
const broken = new Map([[legacy + "data.json", "{}"], [legacy + "link-state.json", "broken"]]);
const invalidAdapter = { exists: async path => broken.has(path), read: async path => broken.get(path), write: async () => { throw new Error("no writes expected"); } };
await assert.rejects(migrateLinkFiles(invalidAdapter, ".custom", "simple-one", true, keys), /JSON/);
assert(!broken.has(current + "sync-local.json"));
console.log("Sync migration: private files, share whitelist, deferred journals and idempotence passed");

const established = new Map([
  [legacy + "data.json", "{}"],
  [legacy + "link-state.json.recovery", JSON.stringify({ old: "must-not-recover" })],
  [current + "sync-local.json", JSON.stringify({ legacyMigrationPending: true })],
  [current + "link-state.json", JSON.stringify({ current: "keep" })],
]);
await migrateLinkFiles({ exists: async path => established.has(path), read: async path => established.get(path), write: async (path, text) => established.set(path, text) }, ".custom", "simple-one", true, keys);
assert(!established.has(current + "link-state.json.recovery"), "an established primary must not receive a stale legacy recovery copy");
assert.deepEqual(JSON.parse(established.get(current + "link-state.json")), { current: "keep" });

await Promise.all([writeApiLocal(adapter, ".custom", "simple-one", { state: { base: { preserved: true } } }), writeApiLocal(adapter, ".custom", "simple-one", { settings: { mobile: { token: "local" } } })]);
const combined = await readApiLocal(adapter, ".custom", "simple-one");
assert.equal(combined.state.base.preserved, true);
assert.equal(combined.settings.mobile.token, "local");
files.set(current + "sync-api-local.json", "broken");
assert.deepEqual(await readApiLocal(adapter, ".custom", "simple-one"), combined);
console.log("API local: concurrent settings/state writes and recovery passed");

const secretValues = new Map();
const secrets = { getSecret: key => secretValues.get(key) ?? null, setSecret: (key, token) => secretValues.set(key, token) };
const privateSettings = { deviceId: "device-one", mobile: { token: "legacy-token", repoUrl: "https://github.com/example/vault" } };
await writeLocalSyncSettings(adapter, ".custom", "simple-one", privateSettings, secrets);
assert.equal(secretValues.get("simple-one-sync-github-device-one"), "legacy-token");
assert.equal(privateSettings.mobile.token, "legacy-token", "runtime authorization remains available");
assert.equal((await readApiLocal(adapter, ".custom", "simple-one")).state.base.preserved, true);
for (const name of ["sync-api-local.json", "sync-api-local.json.recovery", "sync-local.json"]) {
  assert(!files.get(current + name).includes("legacy-token"), `no plaintext Token in ${name}`);
}
assert.equal((await readLocalSyncSettings(adapter, ".custom", "simple-one", secrets)).mobile.token, "legacy-token");
const beforeSecretFailure = writes.length;
await assert.rejects(writeLocalSyncSettings(adapter, ".custom", "simple-one", { ...privateSettings, mobile: { token: "new-token" } },
  { getSecret: () => null, setSecret() { throw new Error("secret unavailable"); } }), /secret unavailable/);
assert.equal(writes.length, beforeSecretFailure, "failed secret migration does not overwrite local data");
await assert.rejects(writeLocalSyncSettings(adapter, ".custom", "simple-one", privateSettings,
  { getSecret: () => null, setSecret() {} }), /Secret Storage/);
assert.equal(writes.length, beforeSecretFailure, "read-back verification must succeed before JSON writes");
await writeLocalSyncSettings(adapter, ".custom", "simple-one", { ...privateSettings, mobile: { token: "" } }, secrets);
assert.equal((await readLocalSyncSettings(adapter, ".custom", "simple-one", secrets)).mobile.token, "");
console.log("Lightweight Token: Secret Storage migration, recovery scrubbing, state preservation, failure guards and clearing passed.");

// The API-local write may succeed before device settings fail to save.
const partialFiles = new Map();
const partialAdapter = { exists: async path => partialFiles.has(path), read: async path => partialFiles.get(path),
  write: async (path, content) => {
    if (path.endsWith("/sync-local.json")) throw new Error("device settings failed");
    partialFiles.set(path, content);
  } };
await assert.rejects(writeLocalSyncSettings(partialAdapter, ".custom", "simple-one", privateSettings, secrets), /device settings failed/);
assert.equal((await readLocalSyncSettings(partialAdapter, ".custom", "simple-one", secrets)).mobile.token, "legacy-token",
  "the secret ID travels with sanitized API settings so a partial write cannot lose authorization");
