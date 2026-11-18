import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
dom.window.document.win = dom.window;
dom.window.createEl = tag => dom.window.document.createElement(tag);
dom.window.createDiv = () => dom.window.document.createElement("div");
dom.window.createFragment = () => dom.window.document.createDocumentFragment();
globalThis.MutationObserver = dom.window.MutationObserver;
const output = await build({ entryPoints: ["src/features/quotedTables.ts"], bundle: true, format: "cjs", platform: "node", write: false });
const module = { exports: {} };
new Function("module", "exports", output.outputFiles[0].text)(module, module.exports);
const { refreshQuotedTables, observeQuotedTables } = module.exports;
const root = dom.window.document.createElement("div");
const fixture = '<blockquote><div class="callout-content"><p>前文<br>\n　<br>\n| 选项 | 优点 | 缺点 |<br>\n|:---|:---:|---:|<br>\n| <strong>httpx</strong> | <a href="https://example.com">链接</a> | <code>a|b</code> |<br>\n后文<br>\n下一行</p></div></blockquote>';
root.innerHTML = fixture;
const original = root.innerHTML;
refreshQuotedTables(root, false);
assert.equal(root.innerHTML, original);
refreshQuotedTables(root, true);
assert.equal(root.querySelectorAll("table").length, 1);
assert.equal(root.querySelectorAll("th").length, 3);
assert.equal(root.querySelector("td strong").textContent, "httpx");
assert.equal(root.querySelector("td a").getAttribute("href"), "https://example.com");
assert.equal(root.querySelector("td code").textContent, "a|b");
assert.equal(root.querySelectorAll("th")[1].getAttribute("align"), "center");
assert.equal(root.querySelectorAll("th")[2].getAttribute("align"), "right");
assert(root.textContent.includes("后文"));
assert(root.querySelector(".simple-quoted-tables > p:last-child br"));
const rendered = root.innerHTML;
refreshQuotedTables(root, true);
assert.equal(root.innerHTML, rendered, "repeated rendering must be idempotent");
refreshQuotedTables(root, false);
assert.equal(root.innerHTML, original, "disabling must restore the original DOM");

// Ordinary paragraphs and code examples must remain untouched.
root.innerHTML = '<p>| a | b |\n|---|---|\n|1|2|</p><blockquote><pre><code>|a|b|\n|---|---|</code></pre><table><tbody><tr><td>Native</td></tr></tbody></table><p>| broken | header |\n|---|---|---|</p></blockquote>';
const untouched = root.innerHTML;
refreshQuotedTables(root, true);
assert.equal(root.innerHTML, untouched);

root.innerHTML = '<blockquote><p><span class="internal-embed"></span><br>\n| a | b |\n|---|---|\n|1|2|</p></blockquote>';
const embed = root.querySelector(".internal-embed");
refreshQuotedTables(root, true);
assert.equal(root.querySelector(".internal-embed"), embed, "recovery must keep the original interactive embed");

// Typography wraps text in spans before this feature runs in the app.
root.innerHTML = '<blockquote><p>　<br>\n<span>| </span>名称<span> | </span>说明<span> |</span><br>\n<span>|---|---|</span><br>\n<span>| A | </span>正文<span> |</span></p></blockquote>';
refreshQuotedTables(root, true);
assert.equal(root.querySelectorAll("td").length, 2);
assert.equal(root.querySelector("td").textContent.trim(), "A");

root.innerHTML = "";
const observer = observeQuotedTables(root, () => true);
root.innerHTML = fixture;
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(root.querySelectorAll("table").length, 1, "late live-preview callouts must render");
observer.disconnect();
console.log("Quoted table rendering tests passed.");
