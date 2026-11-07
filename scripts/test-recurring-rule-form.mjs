import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { build, transform } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>');
const doc = dom.window.document;
const proto = dom.window.HTMLElement.prototype;
proto.createEl = function(tag, options = {}) {
  const el = doc.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
  this.append(el);
  return el;
};
proto.createDiv = function(options) { return this.createEl('div', options); };
proto.empty = function() { this.replaceChildren(); };
proto.addClass = function(...names) { this.classList.add(...names); };
proto.setText = function(value) { this.textContent = value; };

class Setting {
  constructor(parent) {
    this.settingEl = parent.createDiv({ cls: 'setting-item' });
    this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' });
    this.controlEl = this.settingEl.createDiv();
  }
  setName(value) { this.nameEl.textContent = value; return this; }
  setDesc() { return this; }
  setClass(value) { this.settingEl.classList.add(value); return this; }
  addText(callback) {
    const input = this.controlEl.createEl('input');
    input.type = 'text';
    const text = {
      setPlaceholder(value) { input.placeholder = value; return text; },
      setValue(value) { input.value = value; return text; },
      onChange(fn) { input.addEventListener('input', () => fn(input.value)); return text; },
    };
    callback(text); return this;
  }
  addDropdown(callback) {
    const select = this.controlEl.createEl('select');
    const dropdown = {
      addOption(value, label) { const option = select.createEl('option', { text: label }); option.value = value; return dropdown; },
      setValue(value) { select.value = value; return dropdown; },
      onChange(fn) { select.addEventListener('change', () => fn(select.value)); return dropdown; },
    };
    callback(dropdown); return this;
  }
  addToggle(callback) {
    callback({ toggleEl: this.controlEl.createDiv(), getValue: () => false });
    return this;
  }
}

const compiled = await build({ entryPoints: ['src/shared/recurringRuleForm.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(() => ({ Setting }), module, module.exports);
const { renderRecurringRuleForm } = module.exports;
const notices = [];
class Modal {
  constructor() { this.contentEl = doc.body.createDiv(); this.titleEl = doc.body.createDiv(); this.closed = false; }
  close() { this.closed = true; this.contentEl.remove(); this.titleEl.remove(); }
}
async function loadModal(path, name) {
  const parsed = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = [name, 'cleanRecurringRule', 'normalizeNumberArray', 'normalizeOptionalNumber'];
  const nodes = parsed.statements.filter(node => names.includes(node.name?.text));
  assert.equal(nodes.length, names.length);
  const { code } = await transform(nodes.map(node => node.getText(parsed)).join('\n'), { loader: 'ts' });
  return new Function('Modal', 'Notice', 'renderRecurringRuleForm', 'runAsync', 'styleActionButton', 'setIcon', 'setDeleteIcon', 'nextId', `${code}\nreturn ${name};`)(
    Modal, class { constructor(text) { notices.push(text); } }, renderRecurringRuleForm,
    fn => () => { void fn().catch(error => { throw error; }); }, el => el,
    (el, icon) => { el.dataset.icon = icon; }, el => { el.dataset.icon = 'trash-2'; }, () => 'generated-id',
  );
}
function field(root, name, selector) {
  const row = [...root.querySelectorAll('.setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent === name);
  assert(row, `missing field: ${name}`);
  return row.querySelector(selector);
}
function change(el, value) {
  if (el.type === 'checkbox') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', { bubbles: true }));
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const SettingsModal = await loadModal('src/settings.ts', 'RecurringRuleModal');
const DiaryModal = await loadModal('src/features/diary.ts', 'DiaryRecurringRuleModal');

for (const [name, ModalType] of [['settings', SettingsModal], ['diary', DiaryModal]]) {
  for (const type of ['weekly', 'monthly-date', 'monthly-weekday']) {
    const original = { id: '', enabled: true, text: 'before', type, weekdays: [1], days: [2], nth: 2, weekday: 3 };
    const snapshot = structuredClone(original);
    let saved;
    const modal = new ModalType({}, 'test', original, async rule => { saved = rule; });
    modal.onOpen();
    const root = modal.contentEl;
    change(field(root, '周期计划内容', 'input'), '  edited  ');
    if (type === 'weekly') {
      const chips = root.querySelectorAll('.simple-recurring-chip');
      chips[0].click();
      assert(chips[0].classList.contains('is-selected'), 'last selected weekday remains selected');
      chips[4].click(); chips[0].click();
      assert.deepEqual([...root.querySelectorAll('.is-selected')].map(el => el.textContent), ['周五']);
      // Switching away and back keeps the selection in the draft.
      const cycle = field(root, '循环方式', 'select');
      change(cycle, 'monthly-date'); change(cycle, 'weekly');
      assert.equal(root.querySelector('.is-selected').textContent, '周五');
    } else if (type === 'monthly-date') {
      change(field(root, '每月日期', 'input'), '31，1、15 15,0,32,bad,2.5');
    } else {
      change(field(root, '第几个', 'select'), '5');
      change(field(root, '星期几', 'select'), '7');
    }
    const advance = field(root, '提前提醒', 'input');
    assert.equal(root.querySelector('.simple-recurring-advance').children.length, 0);
    change(advance, true);
    assert.equal(field(root, '提前工作日', 'input').value, '3');
    change(field(root, '提前工作日', 'input'), '0');
    change(advance, false); change(advance, true);
    assert.equal(field(root, '提前工作日', 'input').value, '3', 'invalid advance days fall back');
    change(field(root, '提前工作日', 'input'), '7');
    root.querySelector('.mod-cta').click(); await flush();
    assert(modal.closed);
    assert.deepEqual(original, snapshot, 'editing never mutates the source rule');
    assert.equal(saved.id, name === 'settings' ? 'generated-id' : '', 'each entry keeps its ID default');
    assert.equal(saved.text, 'edited');
    assert.equal(saved.type, type);
    assert.equal(saved.advanceEnabled, true);
    assert.equal(saved.advanceDays, 7);
    assert.equal(saved.outputFormat, 'task');
    assert.equal(saved.advanceContinuous, false);
    assert.equal(saved.advanceText, '');
    if (type === 'weekly') assert.deepEqual(saved.weekdays, [5]);
    if (type === 'monthly-date') assert.deepEqual(saved.days, [31, 1, 15]);
    if (type === 'monthly-weekday') { assert.equal(saved.nth, 5); assert.equal(saved.weekday, 7); }
  }
  let calls = 0;
  const empty = new ModalType({}, 'empty', { id: 'existing', enabled: true, text: '  ', type: 'weekly' }, async () => { calls++; });
  empty.onOpen(); empty.contentEl.querySelector('.mod-cta').click(); await flush();
  assert.equal(calls, 0); assert.equal(empty.closed, false);
  const cancel = name === 'settings' ? empty.contentEl.querySelector('[aria-label="取消"]') : [...empty.contentEl.querySelectorAll('button')].find(el => el.textContent === '取消');
  if (name === 'settings') assert.equal(cancel.dataset.icon, 'undo-2');
  cancel.click(); assert(empty.closed);
}

let release;
let saves = 0;
const busy = new SettingsModal({}, 'busy', { id: 'existing', enabled: true, text: 'save', type: 'weekly' }, () => { saves++; return new Promise(resolve => { release = resolve; }); }, async () => false);
busy.onOpen();
const save = busy.contentEl.querySelector('.mod-cta');
save.click(); save.click();
assert.equal(saves, 1, 'settings save is disabled while pending');
assert([...busy.contentEl.querySelectorAll('.simple-json-modal-footer button')].every(el => el.disabled));
release(); await flush(); assert(busy.closed);
let deletes = 0;
const removable = new SettingsModal({}, 'delete', { id: 'existing', enabled: true, text: 'delete', type: 'weekly' }, async () => {}, async () => ++deletes > 1);
removable.onOpen();
const remove = removable.contentEl.querySelector('.simple-event-delete');
remove.click(); await flush(); assert.equal(removable.closed, false); assert.equal(remove.disabled, false);
remove.click(); await flush(); assert(removable.closed);
assert.equal(notices.length, 2);
console.log('Recurring rule form: both entry points save all three schedules; weekday selection, advance reminders, validation, cancel/delete and settings busy state preserved.');
