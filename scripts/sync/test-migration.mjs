import assert from "node:assert/strict";
import { build } from "esbuild";
const output = await build({ entryPoints: ["src/features/sync/storage.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { migrateLinkFiles, readLocalSyncSettings, legacySyncRunning, writeApiLocal, readApiLocal } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
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
