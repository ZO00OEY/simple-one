import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const output = await build({ entryPoints: ['src/features/autoCollapseRightSidebar.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
let pending, resize, disconnected = false, observations = 0;
const context = vm.createContext({ module,
  window: { setTimeout(fn) { pending = fn; return 1; }, clearTimeout() { pending = undefined; } },
  ResizeObserver: class {
    constructor(fn) { resize = fn; }
    observe() { observations++; }
    disconnect() { disconnected = true; }
  },
});
vm.runInContext(output.outputFiles[0].text, context);
const { registerAutoCollapseRightSidebar } = module.exports;
let width = 500, collapses = 0, ready, layout;
const cleanups = [];
const root = { isConnected: true, getBoundingClientRect: () => ({ width }) };
const right = { collapsed: false, containerEl: { getBoundingClientRect: () => ({ width: 300 }) },
  collapse() { this.collapsed = true; collapses++; } };
const plugin = { isMobile: false, settings: { enableAutoCollapseRightSidebar: false },
  app: { workspace: { rootSplit: { containerEl: root }, rightSplit: right,
    onLayoutReady(fn) { ready = fn; }, on(name, fn) { assert.equal(name, 'layout-change'); layout = fn; } } },
  registerEvent() {}, register(fn) { cleanups.push(fn); } };
const refresh = registerAutoCollapseRightSidebar(plugin);
const flush = () => { const fn = pending; pending = undefined; fn?.(); };
width = 200; ready(); flush();
assert.equal(collapses, 0, 'explicitly disabled setting is respected');
plugin.settings.enableAutoCollapseRightSidebar = true;
for (const value of [500, 400, 0]) { width = value; resize(); flush(); }
assert.equal(collapses, 0, 'wide or hidden workspace stays untouched');
width = 399; layout(); flush();
assert.equal(collapses, 1, 'narrow workspace collapses the native sidebar');
resize(); flush();
assert.equal(collapses, 1, 'already collapsed sidebar stays untouched');
width = 699; resize(); flush();
right.collapsed = false; width = 399; layout(); flush();
assert.equal(collapses, 1, 'manual reopening after automatic collapse is respected');
resize(); layout(); flush();
assert.equal(collapses, 1, 'repeated narrow-layout events never lock the sidebar shut');
width = 1000; resize(); flush();
right.collapsed = true; resize(); flush();
assert.equal(right.collapsed, true, 'never automatically reopens');
right.collapsed = false; width = 399; resize(); flush();
assert.equal(collapses, 2, 'wide-to-narrow transition starts a new episode');
right.collapsed = false; width = 200; refresh();
cleanups.forEach(fn => fn()); flush();
assert.equal(collapses, 2, 'unload cancels pending work');
assert.equal(disconnected, true);
refresh(); assert.equal(pending, undefined, 'unloaded callback is inert');
const startupWorkspace = { rootSplit: null, rightSplit: right,
  onLayoutReady(fn) { this.ready = fn; }, on() {} };
const startup = { ...plugin, app: { workspace: startupWorkspace }, register() {}, registerEvent() {} };
const startupRefresh = registerAutoCollapseRightSidebar(startup);
startupRefresh();
assert.equal(observations, 1, 'layout is not observed before it exists');
startupWorkspace.rootSplit = { containerEl: root };
startupWorkspace.ready();
assert.equal(observations, 2, 'observer starts when the layout becomes ready');
registerAutoCollapseRightSidebar({ isMobile: true })();
console.log('Auto-collapse right sidebar checks passed');
