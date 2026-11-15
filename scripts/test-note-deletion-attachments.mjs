import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const output = await build({ entryPoints: ['src/features/attachmentAutomation.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
class TFile {
  constructor(path) { this.path = path; this.extension = path.split('.').at(-1); this.stat = { mtime: 0, size: 1 }; }
}
class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }
const a = new TFile('A.md'), b = new TFile('B.md'), canvas = new TFile('Board.canvas');
const emf = new TFile('Attachments/figure.emf'), pdf = new TFile('Attachments/document.pdf');
const shared = new TFile('Attachments/shared.pdf'), onCanvas = new TFile('Attachments/canvas.emf');
const unrelated = new TFile('Attachments/unrelated.ini'), key = new TFile('Attachments/backup.key');
const root = new TFolder('Attachments', [emf, pdf, shared, onCanvas, unrelated, key]);
const entries = new Map([a, b, canvas, root, ...root.children].map(file => [file.path, file]));
const timers = new Map(), listeners = new Map(), cleanups = [], trashed = [], errors = [];
let now = 1_000_000, next = 0;
const timer = (fn, delay, interval = false) => {
  const id = ++next; timers.set(id, { fn, at: now + delay, delay, interval }); return id;
};
const context = vm.createContext({ module: { exports: {} },
  require: () => ({ TFile, TFolder, Modal: class {}, Notice: class {}, normalizePath: p => p.replace(/\\/g, '/') }),
  Date: { now: () => now }, console: { error: (...args) => errors.push(args) },
  window: { setTimeout: (fn, delay) => timer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, true), clearInterval: id => timers.delete(id) },
});
vm.runInContext(output.outputFiles[0].text, context);
const on = prefix => (name, fn) => { listeners.set(`${prefix}:${name}`, fn); return {}; };
const files = () => [...entries.values()].filter(file => file instanceof TFile);
const plugin = { settings: { autoCleanAttachments: true }, registerEvent() {}, register: fn => cleanups.push(fn),
  app: {
    vault: { on: on('vault'), getConfig: () => 'Attachments', getFiles: files,
      getMarkdownFiles: () => files().filter(file => file.extension === 'md'),
      getAbstractFileByPath: p => entries.get(p),
      read: async () => JSON.stringify({ nodes: [{ type: 'file', file: onCanvas.path }] }),
      adapter: { list: async () => ({ files: root.children.map(file => file.path), folders: [] }) } },
    metadataCache: { on: on('cache'), getFileCache: () => ({}), resolvedLinks: {
      [a.path]: Object.fromEntries([emf, pdf, shared, onCanvas].map(file => [file.path, 1])),
      [b.path]: { [shared.path]: 1 },
    } },
    workspace: { onLayoutReady: fn => fn() },
    fileManager: { trashFile: async file => {
      trashed.push(file.path); entries.delete(file.path);
      root.children = root.children.filter(child => child !== file);
      listeners.get('vault:delete')(file);
    } },
  } };
const advance = async ms => {
  const end = now + ms;
  for (;;) {
    const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, task] = due; now = task.at;
    if (task.interval) task.at += task.delay; else timers.delete(id);
    task.fn(); await new Promise(resolve => setImmediate(resolve));
  }
  now = end; await new Promise(resolve => setImmediate(resolve));
};
const refresh = context.module.exports.registerAttachmentAutomation(plugin);
await advance(150_000);
assert.deepEqual(trashed, [], 'periodic cleanup leaves unrelated non-image files alone');
// Obsidian may already have removed the source from its cache when delete fires.
entries.delete(a.path); delete plugin.app.metadataCache.resolvedLinks[a.path];
listeners.get('vault:delete')(a);
await advance(20_000);
assert.deepEqual(trashed, [], 'deletion waits for the updated reference index');
listeners.get('cache:resolved')(); await advance(10_000);
assert.deepEqual(trashed, [], 'first scan only observes deleted-note attachments');
await advance(120_000);
assert.deepEqual(trashed.sort(), [emf.path, pdf.path].sort(), 'delete only exclusive attachments, including EMF and PDF');
for (const file of [shared, onCanvas, unrelated, key]) assert(entries.has(file.path), `${file.path} must survive`);
// Deleting the last sharing note must now release the shared attachment.
entries.delete(b.path); delete plugin.app.metadataCache.resolvedLinks[b.path];
listeners.get('vault:delete')(b); listeners.get('cache:resolved')();
await advance(10_000);
plugin.settings.autoCleanAttachments = false; refresh();
await advance(150_000);
assert(entries.has(shared.path), 'turning off automatic cleanup cancels pending deletions');
assert.deepEqual(errors, []);
cleanups.forEach(fn => fn());
assert.equal(timers.size, 0);
console.log('Note-deletion cleanup: EMF/PDF, shared notes, Canvas, unrelated files, cache ordering, grace period and cancellation passed.');
