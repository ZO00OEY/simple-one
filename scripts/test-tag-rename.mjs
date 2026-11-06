import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/features/tagRename.ts"], bundle: true, platform: "node", format: "cjs", write: false, external: ["obsidian"] });
const module = { exports: {} };
class Menu {
  static forEvent() { assert.equal(this, Menu); return new Menu(); }
  showAtPosition(position) { assert(this instanceof Menu); this.position = position; return this; }
}
new Function("require", "module", "exports", result.outputFiles[0].text)(() => ({ Modal: class {}, Menu }), module, module.exports);
const { renamedTag, replaceBodyTags } = module.exports;
assert.equal(renamedTag("#旧标签/子项", "旧标签", "新标签"), "新标签/子项");
assert.equal(renamedTag("#旧标签后缀", "旧标签", "新标签"), "旧标签后缀");
assert.equal(renamedTag("#OLD/Child", "old", "New"), "New/Child");
const source = "旧标签 #旧标签 和 #旧标签/子项 `#旧标签`";
const cache = { tags: ["#旧标签", "#旧标签/子项"].map(tag => { const start = source.indexOf(tag); return { tag, position: { start: { offset: start }, end: { offset: start + tag.length } } }; }) };
assert.equal(replaceBodyTags(source, cache, "旧标签", "很长的新标签"), "旧标签 #很长的新标签 和 #很长的新标签/子项 `#旧标签`");
assert.throws(() => replaceBodyTags("changed" + source, cache, "旧标签", "新标签"), /位置已变化/);
assert.equal(replaceBodyTags(source, {}, "旧标签", "新标签"), source);
const originalForEvent = Menu.forEvent, originalShow = Menu.prototype.showAtPosition;
const disposers = [];
globalThis.document = {};
module.exports.registerTagRename({ settings: { enableVaultTagRename: true }, register: fn => disposers.push(fn),
  registerDomEvent() {}, registerEvent() {}, app: { workspace: { iterateAllLeaves() {}, on() { return {}; } } } });
const menu = Menu.forEvent({ target: null });
assert.equal(menu.showAtPosition({ x: 2, y: 3 }), menu);
assert.deepEqual(menu.position, { x: 2, y: 3 });
for (const dispose of disposers) dispose();
assert.equal(Menu.forEvent, originalForEvent, "unload restores exact static method identity");
assert.equal(Menu.prototype.showAtPosition, originalShow, "unload restores exact instance method identity");
delete globalThis.document;
console.log("Tag rename: nested tags, case matching, exact boundaries, cache-only edits and stale positions passed");
