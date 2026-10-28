import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>');
const doc = dom.window.document;
Object.defineProperty(doc, 'win', { value: { createEl: tag => doc.createElement(tag) } });
for (const [name, tag] of [['createDiv', 'div'], ['createSpan', 'span']]) {
  dom.window.HTMLElement.prototype[name] = function(options) { return this.createEl(tag, options); };
}
dom.window.HTMLElement.prototype.createEl = function(tag, options = {}) {
  const el = doc.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  for (const key of ['type', 'value']) if (options[key]) el[key] = options[key];
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  this.append(el); return el;
};
dom.window.HTMLElement.prototype.setText = function(value) { this.textContent = value; };
dom.window.HTMLElement.prototype.addClass = function(...values) { this.classList.add(...values); };
let opened;
class Modal {
  constructor() { this.modalEl = doc.body.createDiv(); this.titleEl = this.modalEl.createDiv(); this.contentEl = this.modalEl.createDiv(); }
  open() { opened = this; this.onOpen(); }
  close() { this.modalEl.remove(); this.onClose?.(); }
}
async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(() => ({ Modal, Notice: class {}, setIcon: (el, name) => { el.dataset.icon = name; } }), module, module.exports);
  return module.exports;
}
const { parseColorValue, colorHsl, hsvHex } = await load('src/shared/colorValues.ts');
assert.equal(parseColorValue('RGB', '246, 247, 249'), '#f6f7f9');
assert.equal(parseColorValue('HEX', '#abc'), '#aabbcc');
assert.equal(parseColorValue('HSL', '360, 100%, 50%'), '#ff0000');
assert.equal(parseColorValue('HSL', '120 100 50'), '#00ff00');
assert.deepEqual(colorHsl('#000000'), [0, 0, 0]);
assert.deepEqual(colorHsl('#ffffff'), [0, 0, 100]);
assert.deepEqual(colorHsl('#0000ff'), [240, 100, 50]);
for (const [space, value] of [['RGB', '256,0,0'], ['RGB', '1%,2,3'], ['HSL', '120,101,50'], ['HEX', '#badvalue'], ['RGB', '1,2'], ['RGB', '-1,0,0']]) assert.equal(parseColorValue(space, value), null);
assert.equal(hsvHex(240, 1, 1), '#0000ff');
const { ThemeColorPicker, FAVORITE_COLORS, installPaletteScroll } = await load('src/shared/themeColorPicker.ts');
let saves = 0;
const plugin = { app: {}, settings: { themeRecentColors: [] }, saveSettings: async () => { saves++; } }, changes = [];
const picker = new ThemeColorPicker(doc.body, plugin).setValue('#f6f7f9').onChange(color => changes.push(color));
picker.setValue('#824ce6');
assert.deepEqual(changes, [], 'programmatic values never become manual overrides');

picker.buttonEl.click();
const root=opened.contentEl;
const tabs=[...root.querySelectorAll('[role=tab]')];
assert.deepEqual(tabs.map(b=>b.textContent),['收藏','最近','主题']);
assert.equal(tabs[0].getAttribute('aria-selected'),'true');
const format=root.querySelector('[aria-label="切换颜色格式"]');
const value=root.querySelector('.simple-theme-color-value');
assert.equal(format,null);
assert.equal(value.textContent,'#824CE6');
value.click();const input=root.querySelector('.simple-theme-color-value-row input');
input.value='#f6f7f9';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
assert.equal(changes.at(-1),'#f6f7f9');
for(const tab of tabs){tab.click();assert.equal(root.querySelector('.simple-theme-color-options button').title.toLowerCase(),'#824ce6');}
tabs[1].click();
assert.equal(root.querySelectorAll('.simple-theme-color-options [aria-pressed="true"]').length,1);
assert.equal(root.querySelector('.simple-theme-color-options [aria-pressed="true"]').title.toLowerCase(),'#f6f7f9');
const preview=root.querySelector('.simple-theme-color-preview');preview.click();assert(!plugin.settings.themeFavoriteColors.includes('#f6f7f9'));preview.click();assert(plugin.settings.themeFavoriteColors.includes('#f6f7f9'));
assert.equal(root.querySelector('[aria-label="从屏幕取色"]'),null);
const confirmed=[];
const deferred=new ThemeColorPicker(doc.body,plugin,true).setValue('#824ce6').onChange(color=>confirmed.push(color));
deferred.buttonEl.click();
const confirmRoot=opened.contentEl;
confirmRoot.querySelector('.simple-theme-color-value').click();
const edit=confirmRoot.querySelector('.simple-theme-color-value-row input');
edit.value='#168c54';edit.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
assert.deepEqual(confirmed,[],'selection colors do not modify a note while choosing');
[...confirmRoot.querySelectorAll('button')].find(button=>button.textContent==='应用到选中文字').click();
assert.deepEqual(confirmed,['#168c54'],'selection color applies once, after confirmation');
const added=[];let closed=false;
const manager=new ThemeColorPicker(doc.body,plugin,'manage').setValue('#e60f61').onChange(color=>added.push(color)).onClose(()=>{closed=true;});
manager.buttonEl.click();
assert.equal(opened.contentEl.querySelector('.simple-theme-color-confirm').textContent,'添加');
assert.equal(opened.contentEl.querySelectorAll('button').length>0,true);
assert.deepEqual(added,[],'opening palette manager does not apply a color');
opened.contentEl.querySelector('.simple-theme-color-confirm').click();
assert.deepEqual(added,['#e60f61']);assert(closed,'closing manager refreshes toolbar favorites');
console.log('Color picker tabs, pinned original, actual selection, formats, editing and favorites passed.');

plugin.settings.themeFavoriteColors=['#123456'];
tabs[0].click();root.querySelector('.simple-theme-color-restore').click();
assert(plugin.settings.themeFavoriteColors.includes('#123456'));
for(const color of FAVORITE_COLORS) assert(plugin.settings.themeFavoriteColors.includes(color));
const count=plugin.settings.themeFavoriteColors.length;root.querySelector('.simple-theme-color-restore').click();assert.equal(plugin.settings.themeFavoriteColors.length,count);
assert.equal(preview.title,'点击取消收藏');
assert.equal(preview.hasAttribute('aria-label'),false);
