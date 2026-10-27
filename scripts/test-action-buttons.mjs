import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

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
const tokens = Object.fromEntries([...shared.matchAll(/(--simple-action-[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]]));
const sheet = window.document.createElement("style");
sheet.textContent = '.legacy button.sample { width: 40px; height: 32px; min-height: 32px; }' +
  shared.replace(/var\((--simple-action-[\w-]+)\)/g, (_match, key) => tokens[key]);
window.document.head.appendChild(sheet);
root.className = "legacy"; button.classList.add("sample");
const icon = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
button.appendChild(icon);
assert.equal(window.getComputedStyle(button).height, "28px");
assert.equal(window.getComputedStyle(button).width, "28px");
assert.equal(window.getComputedStyle(icon).width, "16px");
console.log("Action buttons: nested icons, variants, labels, events and disabled state passed.");
