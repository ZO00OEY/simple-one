import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import postcss from "postcss";

const { window } = new JSDOM("<div><button title='复制'><span></span></button><button disabled>保存</button></div>");
const output = await build({ entryPoints: ["src/shared/actionButton.ts"], bundle: true,
  platform: "node", format: "cjs", external: ["obsidian"], write: false });
const context = vm.createContext({ module: { exports: {} }, require: () => ({
  setIcon(element, icon) { element.dataset.icon = icon; }
}) });
vm.runInContext(output.outputFiles[0].text, context);
const { setActionIcon, styleActionButton, styleActionFooter } = context.module.exports;
const root = window.document.querySelector("div"), button = root.querySelector("button");
let clicks = 0; button.addEventListener("click", () => clicks++);
setActionIcon(button.firstElementChild, "copy", "bordered");
assert(button.classList.contains("simple-action-button--bordered"), "nested SVG host styles its button");
assert.equal(button.title, "复制"); button.click(); assert.equal(clicks, 1, "styling preserves actions");
styleActionButton(button, "plain");
assert(!button.classList.contains("simple-action-button--bordered"), "changing variants removes old border variant");
styleActionFooter(root);
assert(button.classList.contains("simple-action-button--plain"), "footer preserves explicit icon variants");
assert(root.lastElementChild.classList.contains("simple-action-button--text"));
assert.equal(root.lastElementChild.disabled, true, "styling preserves disabled state");
const css = await readFile("styles.css", "utf8");
const shared = css.slice(css.indexOf("/* Shared action sizes."));
// JSDOM does not resolve custom properties. Preserve their body scopes when substituting them.
const stylesheet = postcss.parse(shared);
const declarations = selector => {
  const tokens = {};
  stylesheet.walkRules(rule => { if (rule.selector === selector && rule.parent.type === "root")
    rule.walkDecls(/^--simple-action-/, decl => { tokens[decl.prop] = decl.value; });
  });
  return tokens;
};
root.className = "legacy"; button.classList.add("sample");
const icon = window.document.createElementNS("http://www.w3.org/2000/svg", "svg"); button.appendChild(icon);
const sheet = window.document.createElement("style"); window.document.head.appendChild(sheet);
for (const [mobile, size] of [[false, "28px"], [true, "44px"]]) {
  window.document.body.classList.toggle("is-mobile", mobile);
  const tokens = { ...declarations("body"), ...(mobile ? declarations("body.is-mobile") : {}) };
  sheet.textContent = '.legacy button.sample { width: 40px; height: 32px; min-height: 32px; border-radius: 9px; }' +
    shared.replace(/var\((--simple-action-[\w-]+)\)/g, (_match, key) => tokens[key]);
  const style = window.getComputedStyle(button);
  assert.equal(style.height, size); assert.equal(style.minHeight, size); assert.equal(style.width, size);
  assert.equal(style.borderRadius, "6px"); assert.equal(style.borderTopWidth, "1px");
  assert.equal(window.getComputedStyle(icon).width, "16px");
  assert.equal(window.getComputedStyle(root.lastElementChild).minHeight, size, "text and icon actions share minimum height");
  assert.equal(window.getComputedStyle(root.lastElementChild).width, "fit-content", "text action keeps content width");
}
button.hidden = true; assert.equal(window.getComputedStyle(button).display, "none");
// A popout setting creates its checkbox in the original toggle's document.
const popout = new JSDOM('<div class="setting-item"><div class="setting-item-name">Popout setting</div><div class="toggle"></div></div>');
const popoutDoc = popout.window.document;
popout.window.HTMLElement.prototype.createEl = function(tag) { return this.appendChild(popoutDoc.createElement(tag)); };
popout.window.HTMLElement.prototype.addClass = function(name) { this.classList.add(name); };
const checkboxBundle = await build({ entryPoints: ['src/shared/nativeCheckbox.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const checkboxModule = { exports: {} };
vm.runInNewContext(checkboxBundle.outputFiles[0].text, { module: checkboxModule, document: { createElement() { assert.fail('popout must not create in the main document'); } } });
const toggle = { toggleEl: popoutDoc.querySelector('.toggle'), getValue: () => true };
assert.equal(checkboxModule.exports.nativeCheckbox(toggle), toggle);
const checkbox = popoutDoc.querySelector('input');
assert.equal(checkbox.ownerDocument, popoutDoc); assert.equal(checkbox.getAttribute('aria-label'), 'Popout setting');
assert.equal(toggle.getValue(), true); assert.equal(popoutDoc.querySelector('.toggle'), null);
const changes = [];
toggle.onChange(value => changes.push(value)); checkbox.checked = false; checkbox.dispatchEvent(new popout.window.Event('change'));
assert.deepEqual(changes, [false]);
assert.equal(toggle.setValue(true), toggle); assert.equal(toggle.getValue(), true); assert.deepEqual(changes, [false]);
toggle.setDisabled(true); toggle.setTooltip('Popout tooltip'); assert.equal(checkbox.disabled, true); assert.equal(checkbox.title, 'Popout tooltip');
popout.window.close();
console.log("Action buttons: platform-scoped 28/44 geometry, nested icons, variants, labels, events and disabled state passed.");
