import assert from "node:assert/strict";
import { build } from "esbuild";

class TFile {}
class MarkdownView {
  constructor(file, body = "") { this.file = file; this.data = body; this.body = body; }
  getViewData() { return this.body; }
  async save() { if (this.fail) throw Error("save failed"); this.data = this.body; }
}
const notices = [];
const obsidian = { TFile, MarkdownView, Modal: class {}, Notice: class { constructor(message) { notices.push(message); } },
  normalizePath: p => p, parseYaml: JSON.parse };
const built = await build({ entryPoints: ["src/features/newNoteDefaults.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"] });
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(() => obsidian, module, module.exports);
const { registerNewNoteDefaults, noteTimestamp } = module.exports;
function dateAtOffset(iso, offset) {
  const date = new Date(iso); date.getTimezoneOffset = () => offset; return date;
}
assert.equal(noteTimestamp(dateAtOffset("2026-11-18T15:36:31.413Z", -480)), "2026-11-18T23:36:31");
assert.equal(noteTimestamp(dateAtOffset("2026-11-18T18:00:00Z", -480)), "2026-11-19T02:00:00");
assert.equal(noteTimestamp(dateAtOffset("2026-11-18T01:00:00Z", 300)), "2026-11-17T20:00:00");
assert.equal(noteTimestamp(dateAtOffset("2026-11-18T10:00:00Z", -345)), "2026-11-18T15:45:00");
function fixture(overrides = {}) {
  const files = new Map(), frontmatters = new Map(), types = new Map(), cleanups = [], events = new Map();
  let reads = 0, writes = 0, saves = 0, count = 0;
  const base = Object.assign(new TFile(), { path: "Notes/Index.base", extension: "base", basename: "Index" });
  const folder = { path: "Notes", children: [base] }; files.set(base.path, base);
  const vault = { getAbstractFileByPath: p => files.get(p) ?? null,
    read: async file => { reads++; return file === base ? '{"views":[{"order":["note.status","file.name"]}]}' : file.content; },
    on: (event, callback) => { events.set(event, callback); },
    create: async content => {
      const file = Object.assign(new TFile(), { path: `Notes/${++count}.md`, extension: "md", parent: folder, content });
      files.set(file.path, file); frontmatters.set(file, {}); events.get("create")?.(file); return file;
    } };
  const manager = { createNewMarkdownFile: async (_parent, name, content = "") => name === "unavailable" ? null : vault.create(content),
    processFrontMatter: async (file, edit) => { writes++; edit(frontmatters.get(file)); events.get("modify")?.(file); } };
  const originalCreate = manager.createNewMarkdownFile, originalProperties = manager.processFrontMatter;
  const originalSave = MarkdownView.prototype.save;
  const host = { settings: { newNoteDefaults: { enabled: true, recordCreationTime: true, updateModifiedTime: true, rules: [], ...overrides } },
    app: { vault, workspace: { layoutReady: true }, fileManager: manager, metadataTypeManager: {
      getAssignedWidget: key => types.get(key) ?? null, setType: async (key, type) => { types.set(key, type); }
    } }, saveSettings: async () => { saves++; }, register: fn => cleanups.push(fn), registerEvent() {} };
  registerNewNoteDefaults(host);
  return { host, manager, vault, folder, base, files, frontmatters, types, events,
    counts: () => ({ reads, writes, saves }),
    unload() { for (const fn of cleanups.reverse()) fn();
      assert.equal(manager.createNewMarkdownFile, originalCreate); assert.equal(manager.processFrontMatter, originalProperties);
      assert.equal(MarkdownView.prototype.save, originalSave); } };
}
const validTime = value => {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(Number.isNaN(Date.parse(value)), false);
};
{
  const f = fixture(); f.host.app.workspace.layoutReady = false;
  for (let i = 0; i < 5000; i++) await f.vault.create("old note");
  f.host.app.workspace.layoutReady = true;
  assert.equal(await f.manager.createNewMarkdownFile(f.folder, "unavailable"), null);
  const synced = await f.vault.create("");
  assert.deepEqual(f.counts(), { reads: 0, writes: 0, saves: 0 });
  assert.deepEqual(f.frontmatters.get(synced), {});
  const file = await f.manager.createNewMarkdownFile(f.folder);
  const properties = f.frontmatters.get(file);
  assert.equal(properties.status, null); validTime(properties.创建时间); validTime(properties.最后编辑时间);
  assert.equal(f.types.get("创建时间"), "datetime"); assert.equal(f.types.get("最后编辑时间"), "datetime");
  const created = properties.创建时间;
  properties.最后编辑时间 = "2000-01-01T00:00:00Z";
  const view = new MarkdownView(file); const before = f.counts().writes;
  await view.save(); assert.equal(f.counts().writes, before, "opening/no-op save must not write timestamps");
  view.body = "edited body"; await view.save();
  assert.notEqual(properties.最后编辑时间, "2000-01-01T00:00:00Z"); assert.equal(properties.创建时间, created);
  properties.最后编辑时间 = "2000-01-01T00:00:00Z";
  await f.manager.processFrontMatter(file, fm => { fm.status = "done"; });
  assert.equal(properties.status, "done"); assert.notEqual(properties.最后编辑时间, "2000-01-01T00:00:00Z");
  properties.最后编辑时间 = "2000-01-01T00:00:00Z";
  await f.manager.processFrontMatter(file, () => {});
  assert.equal(properties.最后编辑时间, "2000-01-01T00:00:00Z", "no-op property callback must preserve time");
  view.body = "unsaved changes"; view.fail = true;
  await assert.rejects(view.save(), /save failed/); assert.equal(properties.最后编辑时间, "2000-01-01T00:00:00Z");
  f.unload();
}
// Each switch works independently; existing content and creation times are preserved.
for (const [recordCreationTime, updateModifiedTime] of [[true, false], [false, true], [false, false]]) {
  const f = fixture({ enabled: false, recordCreationTime, updateModifiedTime });
  const file = await f.manager.createNewMarkdownFile(f.folder, "template", "template content");
  const properties = f.frontmatters.get(file);
  assert.equal(!!properties.创建时间, recordCreationTime); assert.equal(!!properties.最后编辑时间, updateModifiedTime);
  assert.equal(file.content, "template content"); assert.equal(f.counts().reads, 0);
  const before = f.counts().writes;
  const view = new MarkdownView(file); view.body = "body edit"; await view.save();
  assert.equal(f.counts().writes - before, Number(updateModifiedTime));
  f.unload();
}
{
  const f = fixture({ enabled: false });
  const original = f.vault.create;
  f.vault.create = async content => {
    const file = await original(content);
    f.frontmatters.get(file).创建时间 = "2000-01-01T00:00:00Z";
    return file;
  };
  const file = await f.manager.createNewMarkdownFile(f.folder);
  assert.equal(f.frontmatters.get(file).创建时间, "2000-01-01T00:00:00Z", "existing creation time must not be replaced");
  f.unload();
}
// Unloading during creation or content reads must not write later or interfere with replacement hooks.
for (const stage of ["create", "read"]) {
  const f = fixture(); let release, reached;
  const ready = new Promise(resolve => { reached = resolve; });
  const pause = () => new Promise(resolve => { release = resolve; reached(); });
  if (stage === "create") {
    const original = f.vault.create; f.vault.create = async content => { await pause(); return original(content); };
  } else f.vault.read = pause;
  const pending = f.manager.createNewMarkdownFile(f.folder);
  await ready; f.unload(); release(""); await pending;
  assert.equal(f.counts().writes, 0); assert.equal(f.counts().saves, 0);
}
assert.equal(notices.length, 0);
console.log("Note properties: manual creation only, zero startup/import reads, base defaults, independent timestamps, real/no-op/failed saves, metadata edits and unload cancellation passed.");
