import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import { buildReaderFiles, standaloneReader } from "./build-share-reader.mjs";
import { JSDOM } from "jsdom";

const folder = await mkdtemp(join(tmpdir(), "simple-reader-test-"));
const id = "k7m2x9a4w8p3";
const dom = new JSDOM('<!doctype html><h1 id="note-title"></h1><input id="search"><nav id="note-list"></nav><article id="content"></article>', { url: `https://example.github.io/share/#/notes/${id}` });
const names = ["window", "document", "navigator", "location", "Node", "NodeFilter", "HTMLElement", "HTMLAnchorElement", "Element", "SVGElement", "DOMParser"];
const prior = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const fixture = `# 双列与安全\n\n> [!note] 提示\n> 正文 **加粗**。\n\n- [x] 完成任务\n\n==高亮== 与 $x^2$\n\n$$\n\\frac{1}{2}\n$$\n\n\`\`\`simple-columns\nwidths: 40:60\n## 左侧\n左侧正文\n---column---\n## 右侧\n右侧正文\n\`\`\`\n\n<script>window.stolen=true</script><img src=x onerror="window.stolen=true"><iframe src="https://evil.example"></iframe>\n\n[危险](javascript:alert(1))\n\n脚注[^1]\n\n[^1]: 注释内容`;
try {
  for (const name of names) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.CSS = { escape: value => value.replace(/["\\]/g, "\\$&") };
  dom.window.HTMLElement.prototype.scrollIntoView = function() { this.dataset.scrolled = "true"; };
  globalThis.fetch = async path => new Response(path === "catalog.json" ? JSON.stringify({ notes: [{ id, title: "双列与安全", category: "演示" }] }) : fixture + '\n\n<Snapshot>快照内容</Snapshot>\n\n<thinking>思考内容</thinking>\n\n<img src="assets/example.png" width="300" height="180">\n\n```html\n<style>p{color:red}</style><p>HTML 预览</p><script>window.stolen=true</script>\n```\n' + "\n\n## 第一节\n第一节正文\n\n### 子节\n子节正文\n\n#### 深层标题\n深层正文\n\n## 第二节\n第二节正文\n\n[跳转深层](#深层标题)\n");
  const output = join(folder, "reader.cjs");
  const fallbackFetch = globalThis.fetch, requested = [], legacyId = 'bbbbbbbbbbbb', invalidId = 'aaaaaaaaaaaa';
  globalThis.fetch = async path => {
    requested.push(path);
    if (path === 'catalog.json') return new Response(JSON.stringify({ notes: [
      { id, title: '双列与安全', category: '444 人工智障管理处/001 AI渠道与账号/010 账号与支付/环境与风控', path: `notes/写作/人物/${id}.md` },
      { id: legacyId, title: '旧版路径', category: '/' },
      { id: invalidId, title: '异常路径', category: '444 人工智障管理处/001 AI渠道与账号/其他', path: `notes/../${invalidId}.md` }
    ] }));
    return fallbackFetch(path);
  };
  const { files } = await buildReaderFiles();
  assert(!/\bimport\s*\(/.test(files["reader/app.js"]), "standalone reader must not load JavaScript chunks");
  assert(!/url\((?!["']?data:)/.test(files["reader/app.css"]), "fonts must be embedded");
  await writeFile(output, files["reader/app.js"]);
  const templateOutput = join(folder, "template.cjs");
  await esbuild.build({ entryPoints: ["src/features/share/template.ts"], bundle: true, platform: "node", format: "cjs", outfile: templateOutput, logLevel: "silent" });
  const templates = createRequire(import.meta.url)(templateOutput);
  const defaultTemplate = standaloneReader(files);
  const diskAssets = templates.readerAssets(defaultTemplate);
  assert.equal(diskAssets["reader/app.js"], files["reader/app.js"], "legacy assets extracted from default.html retain valid JavaScript");
  assert.equal(diskAssets["reader/app.css"], files["reader/app.css"], "legacy assets retain the default CSS and fonts");
  templates.validateShareTemplate(defaultTemplate);
  const standalone = new JSDOM(defaultTemplate);
  assert.equal(standalone.window.document.querySelectorAll("script[src],link[rel=stylesheet]").length, 0, "default HTML needs no reader assets");
  assert.equal(standalone.window.document.querySelectorAll("script[data-simple-reader]").length, 1, "script text must not break the HTML boundary");
  assert(standalone.window.document.querySelector("style[data-simple-reader-style]").textContent.includes("data:font"));
  const themed = templates.templateAppearance(defaultTemplate, ":root{--share-image-max-height:320px}");
  const custom = defaultTemplate.replace('<title>分享笔记</title>', '<title>自定义外观</title>')
    .replace('</head>', '<style data-custom>main{color:purple}</style></head>')
    .replace(/<style data-simple-reader-style>[\s\S]*?<\/style>/, '<style data-simple-reader-style>.heading-toggle{width:1px}</style>')
    .replace(/<script data-simple-reader>[\s\S]*?<\/script>/, '<script data-simple-reader>window.oldReader=true;</script>');
  const upgraded = templates.templateAppearance(custom, ':root{--share-image-max-height:320px}');
  assert(upgraded.includes('<title>自定义外观</title>'), 'updating the embedded reader preserves custom HTML');
  assert(upgraded.includes('window.oldReader=true;'), 'custom scripts are preserved without automatic replacement');
  const upgradedDom = new JSDOM(upgraded);
  assert.equal(upgradedDom.window.document.querySelector('style[data-simple-reader-style]').textContent, '.heading-toggle{width:1px}', 'custom reader styles remain intact');
  assert.equal(upgradedDom.window.document.querySelector('style[data-custom]').textContent, 'main{color:purple}', 'custom styles outside reader blocks survive upgrades');
  upgradedDom.window.close();
  assert(themed.includes("320px"));
  standalone.window.close();
  createRequire(import.meta.url)(output);
  const wait = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Reader did not complete"); };
  await wait(() => document.querySelector(".simple-columns"));
  assert(requested.includes(`notes/${encodeURIComponent('写作')}/${encodeURIComponent('人物')}/${id}.md`), 'reader resolves mapped UTF-8 paths while keeping the original ID route');
  assert.equal(document.getElementById("note-title").textContent, "双列与安全");
  const folderNames = Array.from(document.querySelectorAll('#note-list summary'), summary => summary.textContent);
  assert.deepEqual(folderNames, ['444 人工智障管理处', '001 AI渠道与账号', '010 账号与支付', '环境与风控', '其他']);
  const nestedLink = document.querySelector(`#note-list a[href="#/notes/${id}"]`);
  let ancestorCount = 0;
  for (let parent = nestedLink.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') ancestorCount++;
  assert.equal(ancestorCount, 4, 'each slash-separated folder becomes a nested expandable level');
  assert.equal(document.querySelector(`#note-list a[href="#/notes/${legacyId}"]`).parentElement.id, 'note-list', 'root notes need no slash folder');
  assert.equal(document.querySelectorAll(".simple-column").length, 2);
  assert.match(document.querySelector(".simple-columns").getAttribute("style"), /minmax\(0,40fr\) minmax\(0,60fr\)/);
  assert(document.querySelector(".callout strong"));
  assert.equal(document.querySelector('.callout p strong').textContent, "加粗");
  assert(document.querySelector('input[type="checkbox"]')?.checked);
  assert(document.querySelector("mark")); assert(document.querySelectorAll(".katex").length >= 2, document.getElementById("content").innerHTML.slice(0, 2200));
  assert(document.querySelector(".footnotes"));
  assert(!document.querySelector("#content script, #content iframe:not(.share-html-preview), #content [onerror], #content a[href^='javascript:']"));
  assert.equal(document.querySelector('.callout').dataset.callout, "note");
  assert.equal(document.querySelectorAll('.share-special-block').length, 2);
  const preview = document.querySelector('.share-html-preview');
  assert.equal(preview.getAttribute('sandbox'), "");
  assert(preview.srcdoc.includes('p{color:red}'));
  assert(!preview.srcdoc.includes('<script'));
  assert(preview.srcdoc.includes("script-src 'none'"));
  assert.equal(document.querySelector('img[width="300"]').style.aspectRatio, "300 / 180");
  assert(!dom.window.stolen);
  const first = document.getElementById("第一节"), child = document.getElementById("子节"), deep = document.getElementById("深层标题"), second = document.getElementById("第二节");
  const firstBody = first.nextElementSibling, childBody = child.nextElementSibling;
  first.querySelector("button").click();
  assert(firstBody.hidden); assert.equal(first.querySelector("button").getAttribute("aria-expanded"), "false");
  assert(!firstBody.contains(second), "same-level sibling must stay outside the folded section");
  first.querySelector("button").click(); child.querySelector("button").click();
  first.querySelector("button").click(); first.querySelector("button").click();
  assert(childBody.hidden, "opening parent preserves a child's independent collapsed state");
  first.querySelector("button").click();
  Array.from(document.querySelectorAll("#content a")).find(link => decodeURIComponent(link.getAttribute("href")) === "#深层标题").click();
  assert(!firstBody.hidden && !childBody.hidden, "anchor navigation opens all folded ancestors");
  assert.equal(deep.dataset.scrolled, "true");
  const left = document.querySelector(".simple-column h2"), right = document.querySelectorAll(".simple-column h2")[1];
  left.querySelector("button").click();
  assert(left.nextElementSibling.hidden); assert(!right.nextElementSibling.hidden, "column folding must not affect another column");
  const search = document.getElementById("search");
  search.value = '环境与风控'; search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(document.querySelectorAll('#note-list a').length, 1);
  assert.equal(document.querySelectorAll('#note-list details').length, 4, 'search preserves matching ancestor folders and removes unrelated branches');
  search.value = "不存在"; search.dispatchEvent(new dom.window.Event("input"));
  assert.equal(document.querySelectorAll("#note-list a").length, 0);
  dom.window.location.hash = "#/notes/p8n4w2a7b9c6";
  await wait(() => document.getElementById("note-title").textContent.includes("已删除"));
  dom.window.location.hash = `#/notes/${legacyId}`;
  await wait(() => document.getElementById('note-title').textContent === '旧版路径' && document.querySelector('.simple-columns'));
  assert(requested.includes(`notes/${legacyId}.md`), 'legacy flat paths remain readable');
  dom.window.location.hash = `#/notes/${invalidId}`;
  await wait(() => document.getElementById('content').textContent.includes('Invalid note path'));
  assert(!requested.includes(`notes/../${invalidId}.md`), 'invalid catalog paths cannot escape the notes directory');
  console.log("Reader DOM checks passed: direct route, columns, callout inline content, task list, math, footnotes, search and HTML filtering. Visual appearance still requires user confirmation.");
} finally {
  dom.window.close();
  for (const [name, descriptor] of prior) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  const target = resolve(folder);
  if (!target.startsWith(resolve(tmpdir()))) throw new Error("Invalid temporary cleanup target");
  await rm(target, { recursive: true, force: true });
}
