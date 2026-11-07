import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/main.ts"], bundle: true, write: false,
  format: "cjs", platform: "browser", external: ["obsidian"] });
let supported = true;
const obsidian = new Proxy({}, { get: (_, name) => name === "requireApiVersion" ? () => supported : class {} });
const context = vm.createContext({ module: { exports: {} }, require: () => obsidian, crypto: webcrypto });
vm.runInContext(bundle.outputFiles[0].text, context);
const Plugin = context.module.exports.default;
const secrets = new Map([["simple-one-ai-legacy", "legacy-secret"]]);
const source = { id: "legacy", name: "Existing", protocol: "openai", urlMode: "base",
  url: "https://example.invalid", modelsUrl: "", prefix: "", models: [{ id: "model", alias: "" }], discoveredModels: [] };
const plugin = Object.create(Plugin.prototype);
let fail = false, saved;
const localFiles = new Map();
Object.assign(plugin, { manifest: { dir: ".obsidian/plugins/simple-ai" }, app: {
  secretStorage: { getSecret: key => secrets.get(key), setSecret: (key, value) => secrets.set(key, value) },
  vault: { adapter: {
    exists: async path => localFiles.has(path),
    mkdir: async path => { localFiles.set(path, ""); },
    write: async (path, content) => { if (fail) throw new Error("disk failed"); localFiles.set(path, content); },
  } },
},
  settings: { sources: [source], selected: { sourceId: "legacy", modelId: "model" } },
  writes: Promise.resolve(), keyCursor: new Map(), saveData: async value => { if (fail) throw new Error("disk failed"); saved = value; } });
assert.equal(plugin.getKey("legacy"), "legacy-secret", "legacy single-key storage stays readable");
await plugin.saveSourceKeys({ ...source, activeKeyId: "second" }, [
  { id: "legacy", value: "legacy-secret" }, { id: "second", value: "second-secret" }
]);
assert.equal(plugin.getKey("legacy"), "second-secret");
assert.equal(plugin.getKeys("legacy").length, 2);
plugin.settings.sources[0].rotateKeys = true;
assert.equal(plugin.getRequestKey("legacy"), "legacy-secret");
assert.equal(plugin.getRequestKey("legacy"), "second-secret");
assert.equal(plugin.getRequestKey("legacy"), "legacy-secret");
assert.equal(plugin.getKey("legacy"), "second-secret", "rotation must not change configured keys or active selection");
plugin.settings.sources[0].rotateKeys = false;
assert.equal(plugin.getRequestKey("legacy"), "second-secret");
assert(!JSON.stringify(saved).includes("-secret"), "settings contain secret IDs only");
await plugin.saveSourceKeys({ ...plugin.settings.sources[0], prefix: "prefix" }, plugin.getKeys("legacy"));
assert.equal(plugin.settings.sources[0].prefix, "prefix");
assert.equal(plugin.getKeys("legacy").length, 2, "editing model/source fields preserves all keys");
assert.equal(plugin.getKey("legacy"), "second-secret");
fail = true;
await assert.rejects(plugin.saveSourceKeys({ ...plugin.settings.sources[0], activeKeyId: "third" }, [
  { id: "third", value: "third-secret" }
]), /disk failed/);
assert.equal(plugin.getKey("legacy"), "second-secret", "failed save restores old active key and settings");
assert.equal(secrets.get("simple-one-ai-legacy"), "legacy-secret");
assert.equal(secrets.get("simple-one-ai-second"), "second-secret");
assert.equal(secrets.get("simple-one-ai-third"), "");
fail = false;
await plugin.saveSourceKeys(plugin.settings.sources[0], [{ id: "second", value: "second-secret" }]);
assert.equal(secrets.get("simple-one-ai-legacy"), "", "removed keys are cleared from secret storage");
await plugin.deleteSource("legacy");
assert.equal(secrets.get("simple-one-ai-second"), "");
assert.equal(plugin.settings.sources.length, 0);
assert.equal(plugin.settings.selected, null);
console.log("Multi-key storage: legacy compatibility, active selection, preservation, privacy, rollback and deletion passed.");

supported = false;
const originalApp = plugin.app;
plugin.app = new Proxy({}, { get() { throw new Error("Old Obsidian API must not be accessed"); } });
assert.throws(() => plugin.getKeys("legacy"), /requires Obsidian 1\.11\.4/);
await assert.rejects(plugin.saveSourceKeys(source, []), /requires Obsidian 1\.11\.4/);
await assert.rejects(plugin.deleteSource("legacy"), /requires Obsidian 1\.11\.4/);
plugin.app = originalApp;
supported = true;
console.log("Old Obsidian rejects AI secret operations before any App API access.");
