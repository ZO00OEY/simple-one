import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

const output = await build({
  entryPoints: ["src/features/attachmentAutomation.ts"], bundle: true,
  platform: "node", format: "cjs", write: false, external: ["obsidian"],
  plugins: [{ name: "mock-organizer", setup(builder) {
    builder.onResolve({ filter: /attachmentOrganizer$/ }, () => ({ path: "organizer", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
      export const checkUnusedAttachments = (plugin, options) => globalThis.action('cleanup', options);
      export const planAttachmentImageRename = (plugin, options) => globalThis.action('images', options);
      export const planAttachmentOrganization = (plugin, options) => globalThis.action('attachments', options);
      export const planInlineImageExtraction = (plugin, options) => globalThis.action('inline', options);
      export const registerAttachmentCleanupGuard = () => {};
    ` }));
  } }],
});
class TFile { constructor(path, mtime = 0) { this.path = path; this.extension = path.split('.').at(-1); this.stat = { mtime, size: 1 }; } }
class TFolder { constructor(path) { this.path = path; } }
let now = 1_000_000, next = 0;
const timers = new Map(), calls = [], errors = [], listeners = new Map(), disposers = [];
const note = new TFile('Notes/A.md'), image = new TFile('Attachments/a.png');
const fresh = new TFile('Attachments/fresh.png', now), folder = new TFolder('Attachments/empty');
const files = new Map([note, image].map(file => [file.path, file]));
const timer = (callback, delay, interval = false) => { const id = ++next; timers.set(id, { callback, at: now + delay, delay, interval }); return id; };
const context = vm.createContext({
  module: { exports: {} }, require: () => ({ TFile, TFolder }),
  Date: { now: () => now }, console: { error: (...args) => errors.push(args) },
  window: {
    setTimeout: (callback, delay) => timer(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => timer(callback, delay, true), clearInterval: id => timers.delete(id),
  },
  action: async (kind, options) => {
    calls.push({ kind, options });
    if (kind === 'cleanup') calls.at(-1).eligible = [image, fresh, folder].map(file => options.canDelete(file));
  },
});
vm.runInContext(output.outputFiles[0].text, context);
const on = prefix => (event, callback) => { listeners.set(`${prefix}:${event}`, callback); return {}; };
let indexed = true;
const plugin = {
  settings: { autoCleanAttachments: false, autoOrganizeImages: false, autoOrganizeAttachments: false, autoExtractInlineImages: false },
  registerEvent() {}, register: callback => disposers.push(callback),
  app: {
    vault: { on: on('vault'), getAbstractFileByPath: path => files.get(path), getMarkdownFiles: () => [note] },
    metadataCache: { on: on('cache'), getFileCache: () => indexed ? {} : null, resolvedLinks: { [note.path]: { [image.path]: 1 } } },
    workspace: { onLayoutReady: callback => callback() },
  },
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const advance = async milliseconds => {
  const target = now + milliseconds;
  while (true) {
    const due = [...timers].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, task] = due; now = task.at;
    if (task.interval) task.at += task.delay; else timers.delete(id);
    task.callback(); await settle();
  }
  now = target; await settle();
};
const refresh = context.module.exports.registerAttachmentAutomation(plugin);
await advance(70_000);
assert.equal(calls.length, 0, 'all automatic features are opt-in');
Object.keys(plugin.settings).forEach(key => { plugin.settings[key] = true; });
fresh.stat.mtime = now;
refresh(); await advance(10_000);
assert.deepEqual(calls.map(call => call.kind), ['inline', 'images', 'attachments', 'cleanup']);
assert.deepEqual(calls.at(-1).eligible, [false, false, false], 'first cleanup only observes candidates');
await advance(120_000);
assert.deepEqual(calls.at(-1).eligible, [true, false, true], 'second stable scan excludes newly pasted files');
assert.equal(calls.filter(call => call.kind === 'images').length, 1, 'cleanup timer does not rescan all image plans');
calls.length = 0;
listeners.get('vault:modify')(note);
listeners.get('vault:modify')(note);
await advance(10_000);
assert.equal(calls.length, 0, 'wait for reference resolution after edits');
listeners.get('cache:resolved')(); await advance(10_000);
assert.deepEqual(calls.map(call => call.kind), ['inline', 'images', 'attachments']);
assert.deepEqual(Array.from(calls[0].options.notes, file => file.path), [note.path]);
assert.deepEqual([...calls[1].options.paths].sort(), [note.path, image.path].sort(), 'incremental processing includes note references');
calls.length = 0;
indexed = false;
await advance(60_000);
assert.equal(calls.length, 0, 'incomplete caches block cleanup');
indexed = true;
Object.keys(plugin.settings).forEach(key => { plugin.settings[key] = false; });
refresh(); await advance(120_000);
assert.equal(calls.length, 0, 'switching off stops scheduled work');
plugin.settings.autoOrganizeImages = true;
context.action = async () => { throw new Error('silent failure'); };
refresh(); await advance(10_000);
assert.equal(errors.length, 1, 'automatic errors are logged without notices or dialogs');
disposers.forEach(dispose => dispose());
assert.equal(timers.size, 0, 'unloading cancels timers');
console.log('Attachment automation: opt-in, debounce, metadata readiness, incremental scope, cleanup grace, silence and disposal passed.');
