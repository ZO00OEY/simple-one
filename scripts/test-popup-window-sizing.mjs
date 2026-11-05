import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const output = await build({ entryPoints: ['src/features/popupWindowSizing.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
const context = vm.createContext({ module, console });
vm.runInContext(output.outputFiles[0].text, context);
const { registerPopupWindowSizing } = module.exports;

function fixture({ alreadyOpen = false, options = false, inApp = false, migrate = false } = {}) {
  const cleanups = [], timers = new Map(), resizes = [], moves = [];
  let id = 0, opens = 0, closes = 0;
  const main = { outerWidth: 1000, outerHeight: 800, screenX: 0, screenY: 0,
    screen: { availLeft: -1920, availTop: 0, availWidth: 3840, availHeight: 1080 } };
  const native = { closed: false, screenX: 100, screenY: 100,
    resizeTo: (width, height) => resizes.push([width, height]), moveTo: (x, y) => moves.push([x, y]) };
  const nativeDoc = { defaultView: native }, mainDoc = { defaultView: main };
  const classes = new Set(), properties = new Map();
  const modal = { isConnected: alreadyOpen, ownerDocument: inApp || migrate ? mainDoc : nativeDoc,
    addClass: name => classes.add(name), removeClass: name => classes.delete(name),
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } };
  const settings = { modalEl: modal,
    onOpen() { assert.equal(this, settings); opens++; modal.isConnected = true; },
    onClose() { assert.equal(this, settings); closes++; modal.isConnected = false; } };
  if (options) settings.getPopoutOptions = function() { assert.equal(this, settings); return { width: 400, height: 300, marker: 'retained' }; };
  const originals = { open: settings.onOpen, close: settings.onClose, options: settings.getPopoutOptions };
  const plugin = { isMobile: false, app: { setting: settings, workspace: { rootSplit: { containerEl: { ownerDocument: mainDoc } } } },
    displaySettings: { popupWindowScale: '70' }, settings: { desktopTypography: { fontSize: 14, letterSpacing: 0.8, lineHeight: 1.7 } },
    register: cleanup => cleanups.push(cleanup) };
  context.window = { setTimeout(fn, delay) { const timer = ++id; timers.set(timer, { fn, delay }); return timer; }, clearTimeout(timer) { timers.delete(timer); } };
  const refresh = registerPopupWindowSizing(plugin);
  const flush = delay => { for (const [timer, task] of [...timers]) if (task.delay === delay) { timers.delete(timer); task.fn(); } };
  return { plugin, settings, modal, native, nativeDoc, mainDoc, refresh, resizes, moves, properties, classes, timers, originals, flush,
    get opens() { return opens; }, get closes() { return closes; }, dispose: () => cleanups.forEach(cleanup => cleanup()) };
}

{
  const f = fixture();
  assert.equal(f.resizes.length, 0, 'registration never changes an existing window');
  f.settings.onOpen(); f.flush(0); f.flush(100);
  assert.deepEqual(f.resizes, [[700, 560]], 'immediate/0/100 callbacks size a document once');
  f.native.screenX = -1800; f.native.screenY = -250;
  for (const [key, value] of [['fontSize', 18], ['lineHeight', 2], ['letterSpacing', 1.2]]) {
    f.plugin.settings.desktopTypography[key] = value; f.refresh(); f.settings.onOpen(); f.flush(0); f.flush(100);
  }
  f.plugin.displaySettings.popupWindowScale = '80'; f.refresh();
  assert.equal(f.resizes.length, 1); assert.deepEqual(f.moves, []);
  assert.equal(f.native.screenX, -1800); assert.equal(f.native.screenY, -250, 'user-positioned negative coordinates stay untouched');
  f.settings.onClose(); f.settings.onOpen(); f.flush(0); f.flush(100);
  assert.deepEqual(f.resizes, [[700, 560], [800, 640]], 'new scale applies after close and reopen');
  f.dispose();
  assert.equal(f.settings.onOpen, f.originals.open); assert.equal(f.settings.onClose, f.originals.close);
}
{
  const f = fixture({ alreadyOpen: true });
  f.refresh(); f.settings.onOpen(); f.flush(0); f.flush(100);
  assert.deepEqual(f.resizes, []); assert.deepEqual(f.moves, [], 'loading into an already-open window is inert');
  f.settings.onClose(); f.settings.onOpen(); f.flush(100); assert.deepEqual(f.resizes, [[700, 560]]); f.dispose();
}
{
  const f = fixture({ options: true });
  const options = f.settings.getPopoutOptions();
  assert.equal(options.width, 700); assert.equal(options.height, 560); assert.equal(options.marker, 'retained');
  f.settings.onOpen(); f.flush(0); f.flush(100); f.refresh();
  assert.deepEqual(f.resizes, [[700, 560]]); assert.deepEqual(f.moves, [], 'restored bounds are corrected even when creation options were supplied');
  f.plugin.displaySettings.popupWindowScale = '80';
  assert.equal(f.settings.getPopoutOptions().width, 400, 'asking again while open leaves original platform options alone');
  f.settings.onClose(); assert.equal(f.settings.getPopoutOptions().width, 800);
  f.settings.onOpen(); f.flush(0); f.flush(100); assert.deepEqual(f.resizes, [[700, 560], [800, 640]]);
  f.dispose(); assert.equal(f.settings.getPopoutOptions, f.originals.options);
}
{
  const f = fixture({ migrate: true });
  f.settings.onOpen(); assert.equal(f.properties.get('--simple-popup-width'), '700px');
  const stale = [...f.timers.values()]; f.settings.onClose();
  assert.equal(f.timers.size, 0, 'close clears deferred callbacks');
  f.modal.ownerDocument = f.nativeDoc;
  for (const task of stale) task.fn();
  assert.deepEqual(f.resizes, [], 'a late callback from a closed session cannot resize a migrated window');
  f.plugin.displaySettings.popupWindowScale = '80'; f.settings.onOpen();
  for (const task of stale) task.fn();
  f.flush(0); f.flush(100); assert.deepEqual(f.resizes, [[800, 640]], 'old generation cannot change the reopened session'); f.dispose();
}
{
  const f = fixture({ migrate: true });
  f.settings.onOpen(); f.modal.ownerDocument = f.nativeDoc; f.flush(0); f.flush(100); f.refresh();
  assert.deepEqual(f.resizes, [[700, 560]], 'in-app to native migration sizes each document only once');
  assert(!f.classes.has('simple-scaled-modal')); assert.deepEqual(f.moves, []); f.dispose();
}
{
  const f = fixture({ inApp: true });
  f.settings.onOpen(); assert.equal(f.properties.get('--simple-popup-width'), '700px');
  f.plugin.displaySettings.popupWindowScale = '80'; f.refresh(); f.flush(0); f.flush(100);
  assert.equal(f.properties.get('--simple-popup-width'), '700px', 'open in-app modal also retains its session geometry');
  f.settings.onClose(); f.settings.onOpen(); assert.equal(f.properties.get('--simple-popup-width'), '800px'); f.dispose();
}
{
  const f = fixture(); f.settings.onOpen(); f.flush(100); const stale = [...f.timers.values()];
  f.dispose(); for (const task of stale) task.fn();
  assert.equal(f.resizes.length, 1); assert.equal(f.timers.size, 0, 'unload cancels pending window sizing');
}
{
  const f = fixture({ options: true });
  const sizes = [];
  f.settings.getPopoutWindow = () => ({ electronWindow: {
    isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
    setSize: (width, height) => sizes.push([width, height]),
  } });
  f.settings.getPopoutOptions(); f.settings.onOpen(); f.flush(0); f.flush(100);
  assert.deepEqual(sizes, [[700, 560]], 'native API corrects restored size once');
  assert.deepEqual(f.resizes, []); assert.deepEqual(f.moves, []); f.dispose();
}
{
  const f = fixture({ options: true });
  f.native.outerWidth = 700; f.native.outerHeight = 560;
  f.settings.getPopoutOptions(); f.settings.onOpen(); f.flush(0); f.flush(100);
  assert.deepEqual(f.resizes, [], 'correct creation size does not trigger another resize'); f.dispose();
}
console.log('Popup sizing: first-open sessions, native creation options, delayed migration, negative positions, close/reopen and cleanup passed.');

// Position optimization follows the native instance, not repeated open() calls.
const positionBundle = await build({ entryPoints: ['src/features/windowPositionOptimization.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const positionModule = { exports: {} }, positionContext = vm.createContext({ module: positionModule, console });
vm.runInContext(positionBundle.outputFiles[0].text, positionContext);
const { registerWindowPositionOptimization } = positionModule.exports;
function positionFixture(alreadyOpen = false) {
  const calls = [], matches = [], cleanups = [];
  const native = (bounds = { x: -2100, y: -200, width: 1000, height: 800 }) => ({
    bounds, maximized: false,
    getBounds() { return { ...this.bounds }; }, setBounds(next) { this.bounds = { ...next }; calls.push(next); },
    isDestroyed: () => false, isMaximized() { return this.maximized; }, isFullScreen: () => false
  });
  class Popout {
    constructor() { this.native = native(); this.closed = !alreadyOpen; this.opens = 0; }
    open() { this.opens++; this.closed = false; }
    getPopoutWindow() { return { closed: this.closed, electronWindow: this.native }; }
  }
  const setting = new Popout(), original = Popout.prototype.open;
  positionContext.window = { electron: { remote: { screen: { getDisplayMatching(bounds) {
    matches.push(bounds); return { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
  } } } } };
  const plugin = { isMobile: false, settings: { enableWindowPositionOptimization: true }, app: { setting }, register: fn => cleanups.push(fn) };
  registerWindowPositionOptimization(plugin);
  return { setting, plugin, calls, matches, native, dispose() { cleanups.forEach(fn => fn()); assert.equal(Popout.prototype.open, original); } };
}
{
  const f = positionFixture(); f.setting.open();
  assert.equal(f.setting.opens, 1, 'original open receives its instance');
  assert.equal(f.matches[0].x, -2100, 'first clamp asks for the matching display using native bounds');
  assert.deepEqual({ ...f.calls[0] }, { x: -1920, y: 0, width: 1000, height: 800 });
  f.setting.native.bounds = { x: -1800, y: -150, width: 1000, height: 800 };
  f.setting.open(); assert.equal(f.calls.length, 1); assert.equal(f.matches.length, 1);
  assert.equal(f.setting.native.bounds.y, -150);
  f.setting.native = f.native(); f.setting.open(); assert.equal(f.calls.length, 2, 'a new native instance is clamped once');
  f.setting.native = f.native(); f.plugin.settings.enableWindowPositionOptimization = false; f.setting.open();
  f.plugin.settings.enableWindowPositionOptimization = true; f.setting.open();
  assert.equal(f.calls.length, 2, 'enabling the feature does not later move an already-observed window');
  f.setting.native = f.native(); f.setting.native.maximized = true; f.setting.open();
  f.setting.native.maximized = false; f.setting.open(); assert.equal(f.calls.length, 2, 'restoring a previously observed maximized window is not another first open');
  f.dispose();
}
{
  const f = positionFixture(true); f.setting.open();
  assert.equal(f.calls.length, 0); assert.equal(f.matches.length, 0, 'a native window already open at plugin load is seeded without repositioning'); f.dispose();
}
console.log('Window positions: matching negative display, one clamp per native instance, existing windows and opt-in/maximized guards passed.');
