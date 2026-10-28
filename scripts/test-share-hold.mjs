import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const output = await build({ entryPoints: ['src/features/share/holdEdit.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(output.outputFiles[0].text, context);
const { window } = new JSDOM('<div id="list"><div class="simple-share-note-row" data-share-note-id="note"><span>Note</span></div><summary data-share-directory="target">Folder</summary></div>');
const doc = window.document, list = doc.querySelector('#list');
window.HTMLElement.prototype.createDiv = function(options) {
  const element = doc.createElement('div'); element.className = options.cls; this.append(element); return element;
};
let hold, enabled = true, entries = [], drops = [], trashed = [];
window.setTimeout = callback => { hold = callback; return 1; };
window.clearTimeout = () => { hold = undefined; };
doc.elementFromPoint = () => list.querySelector('summary');
const dispose = context.module.exports.installShareHoldEdit(list, () => enabled,
  (id, directory) => { entries.push([id, directory]); list.querySelector('.simple-share-note-row').innerHTML = '<input type="checkbox">Note'; },
  (...args) => drops.push(args), (...args) => trashed.push(args));
function pointer(target, type, x = 10) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: 10 });
  target.dispatchEvent(event); return event;
}
pointer(list.firstElementChild, 'pointerdown'); pointer(doc, 'pointerup');
assert.equal(hold, undefined, 'short click cancels hold');
pointer(list.firstElementChild, 'pointerdown'); pointer(doc, 'pointermove', 30);
assert.equal(hold, undefined, 'scroll or movement cancels hold');
pointer(list.firstElementChild, 'pointerdown'); hold();
assert.deepEqual(entries, [['note', undefined]], 'hold enters editing before release');
pointer(doc, 'pointermove', 40); pointer(doc, 'pointerup', 40);
assert.deepEqual(drops, [['note', undefined, 'target']], 'same held pointer drops after the row is replaced');
assert.equal(doc.querySelector('.simple-share-drag-preview'), null);
enabled = false; pointer(list.firstElementChild, 'pointerdown');
assert.equal(entries.length, 1, 'disabled setting cannot enter edit mode');
enabled = true; pointer(list.querySelector('summary'), 'pointerdown'); hold();
pointer(doc, 'pointercancel');
assert.equal(drops.length, 1, 'cancel never moves a directory');
const trashTarget = doc.createElement('button'); trashTarget.dataset.shareTrash = 'true'; list.append(trashTarget);
doc.elementFromPoint = () => trashTarget;
pointer(list.firstElementChild, 'pointerdown'); hold(); pointer(doc, 'pointermove', 40); pointer(doc, 'pointerup', 40);
assert.deepEqual(trashed, [['note', undefined]], 'hold drop into trash uses deletion, not directory movement');
assert.equal(drops.length, 1);
dispose();
assert.equal(doc.querySelector('.simple-share-drag-preview'), null);
console.log('Share hold: click, scroll, edit transition, continuous drag, disabled state and cancellation passed.');
