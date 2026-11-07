import assert from "node:assert/strict";
import { build } from "esbuild";

const output = await build({
  entryPoints: ["src/features/noteReformatRules.ts"],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { applyTextReformatRules, parseReformatExpression } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
);
assert.deepEqual(parseReformatExpression("/hello/gi"), { pattern: "hello", flags: "gi" });
assert.deepEqual(parseReformatExpression("/https?:\\/\\//g"), { pattern: "https?:\\/\\/", flags: "g" });
for (const expression of ["hello", "/hello", "/[/g", "/hello/gg", "/hello/z", "//g"]) {
  assert.throws(() => parseReformatExpression(expression));
}
const rule = {
  id: "test", name: "test", enabled: true,
  ...parseReformatExpression("/hello/gi"), replaceWith: "world",
};
assert.equal(applyTextReformatRules("Hello hello", [rule]), "world world");
assert.equal(applyTextReformatRules("Hello", [{ ...rule, enabled: false }]), "Hello");
assert.equal(applyTextReformatRules("---\ntitle: Hello\n---\nHello", [rule]), "---\ntitle: Hello\n---\nworld");
assert.equal(applyTextReformatRules("https://hello.example\nHello", [rule]), "https://hello.example\nworld");
assert.equal(applyTextReformatRules("hello", [{ ...rule, replaceWith: "$&\\nnext" }]), "hello\nnext");
assert.equal(applyTextReformatRules("hello", [{ ...rule, pattern: "[" }, rule]), "world");
console.log("Note reformat expression and preview tests passed");

const linkOutput = await build({
  entryPoints: ["src/features/linkFilter.ts"],
  bundle: true, format: "cjs", platform: "node", write: false,
  external: ["obsidian", "electron"],
});
const module = { exports: {} };
let requests = 0;
new Function("require", "module", "exports", linkOutput.outputFiles[0].text)(
  name => {
    if (name !== "obsidian") throw new Error(`Unexpected dependency: ${name}`);
    return {
      Notice: class {},
      requestUrl: () => { requests++; throw new Error("Title fetching must be disabled"); },
    };
  }, module, module.exports,
);
async function pasteCase(overrides, text, plain = false) {
  let pasteHandler;
  let keydown;
  let result = "";
  const settings = {
    autoProcessPaste: true, autoProcessObsidian: true,
    autoProcessPastedTextLinks: false, extractLinkTitle: false,
    filterRules: [],
    enhancements: { currentNoteLinkConverter: { enabled: true } },
    diary: { reformat: { runFormatReflow: true, autoReformatAfterPaste: false, runLinkConversion: true, formatRules: [] } },
    ...overrides,
  };
  const plugin = {
    settings,
    registerDomEvent(_target, type, callback) { if (type === "keydown") keydown = callback; },
    registerEvent() {},
    addCommand() {},
    app: { workspace: { on(_name, callback) { pasteHandler = callback; } } },
  };
  globalThis.document = {};
  module.exports.registerLinkFilter(plugin);
  if (plain) keydown({ ctrlKey: true, shiftKey: true, key: "v" });
  let prevented = false;
  pasteHandler({
    defaultPrevented: false,
    clipboardData: { getData: () => text },
    preventDefault() { prevented = true; },
  }, {
    getCursor: () => ({ line: 0, ch: 0 }),
    getValue: () => result,
    replaceRange(value) { result = value; },
    getLine: () => result,
    setCursor() {},
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { prevented, result, settings };
}
assert.equal((await pasteCase({}, "https://example.com")).result, "[https://example.com](https://example.com)");
assert.equal((await pasteCase({}, "text https://example.com")).prevented, false);
assert.equal((await pasteCase({ autoProcessPaste: false, autoProcessPastedTextLinks: true }, "text https://example.com")).result,
  "text [https://example.com](https://example.com)");
assert.equal((await pasteCase({}, "https://example.com", true)).prevented, false);
assert.equal((await pasteCase({ autoProcessPastedTextLinks: true }, "text https://example.com", true)).prevented, false);
const legacyPlainPaste = { plainTextPasteSkipsSingleLinkProcessing: false, plainTextPasteSkipsContentLinkScan: false };
assert.equal((await pasteCase(legacyPlainPaste, "https://example.com", true)).prevented, false);
assert.equal((await pasteCase({ ...legacyPlainPaste, autoProcessPastedTextLinks: true }, "text https://example.com", true)).prevented, false);
assert.equal((await pasteCase(legacyPlainPaste, "obsidian://open?vault=Obsidian&file=test", true)).prevented, false);
const automatic = { runFormatReflow: true, autoReformatAfterPaste: true, runLinkConversion: true, formatRules: [rule] };
assert.equal((await pasteCase({
  ...legacyPlainPaste, autoProcessPastedTextLinks: true, diary: { reformat: automatic },
}, "hello https://example.com", true)).result, "world https://example.com");
assert.equal((await pasteCase({ diary: { reformat: automatic } }, "hello https://example.com")).result, "world https://example.com");
assert.equal((await pasteCase({
  diary: { reformat: { ...automatic, runFormatReflow: false } },
}, "hello")).result, "hello");
assert.equal((await pasteCase({
  diary: { reformat: automatic }, enhancements: { currentNoteLinkConverter: { enabled: false } },
}, "hello")).prevented, false);
assert.equal(requests, 0);
delete globalThis.document;
console.log("Paste processing independence, bypass, title opt-out and reformat switches passed");

const asyncBundle = await build({
  stdin: { contents: 'export { reformatCurrentNote } from "./src/features/noteReformat"; export { registerLinkFilter } from "./src/features/linkFilter";', resolveDir: process.cwd() },
  bundle: true, format: "cjs", platform: "node", write: false, external: ["obsidian"],
  plugins: [{ name: "deferred-title", setup(builder) {
    builder.onResolve({ filter: /shared\/webFetch$/ }, () => ({ path: "title", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const fetchPageTitle = () => fetchTitleMock();" }));
  } }],
});
let resolveTitle;
const notices = [];
const asyncModule = { exports: {} };
new Function("require", "module", "exports", "fetchTitleMock", asyncBundle.outputFiles[0].text)(
  () => ({ Notice: class { constructor(message) { notices.push(message); } } }), asyncModule, asyncModule.exports,
  () => new Promise(resolve => { resolveTitle = resolve; }),
);
function deferredFixture(text) {
  let value = text, cursor = { line: 0, ch: text.length }, paste;
  const offset = pos => value.split("\n").slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch;
  const editor = {
    getValue: () => value, setValue: text => { value = text; },
    getCursor: () => cursor, setCursor: pos => { cursor = pos; },
    replaceRange(text, from, to = from) { value = value.slice(0, offset(from)) + text + value.slice(offset(to)); },
  };
  const plugin = {
    settings: { extractLinkTitle: true, filterRules: [], autoProcessPaste: true, autoProcessPastedTextLinks: true,
      enhancements: { currentNoteLinkConverter: { enabled: true } },
      diary: { reformat: { runFormatReflow: false, runLinkConversion: true, autoReformatAfterPaste: true, formatRules: [] } } },
    app: { workspace: { activeEditor: { editor, file: { path: "note.md" } }, on(_event, callback) { paste = callback; } } },
    registerDomEvent() {}, registerEvent() {}, addCommand() {},
  };
  return { editor, plugin, paste(text) { paste({ defaultPrevented: false, clipboardData: { getData: () => text }, preventDefault() {} }, editor); } };
}
for (const scenario of ["unchanged", "edited", "switched"]) {
  const fixture = deferredFixture("https://example.com");
  const pending = asyncModule.exports.reformatCurrentNote(fixture.plugin);
  if (scenario === "edited") fixture.editor.setValue("https://example.com\n用户新增段落");
  if (scenario === "switched") fixture.plugin.app.workspace.activeEditor.file = { path: "other.md" };
  resolveTitle("网页标题");
  await pending;
  assert.equal(fixture.editor.getValue(), scenario === "unchanged" ? "[网页标题](https://example.com)" : scenario === "edited" ? "https://example.com\n用户新增段落" : "https://example.com");
}
globalThis.document = {};
for (const edited of [false, true]) {
  const fixture = deferredFixture("原文");
  asyncModule.exports.registerLinkFilter(fixture.plugin);
  fixture.paste(" https://example.com");
  assert.equal(fixture.editor.getValue(), "原文https://example.com", "paste is inserted before waiting for the title");
  if (edited) fixture.editor.setValue(fixture.editor.getValue() + "\n用户新增段落");
  resolveTitle("网页标题");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fixture.editor.getValue(), edited ? "原文https://example.com\n用户新增段落" : "原文[网页标题](https://example.com)");
}
{
  const fixture = deferredFixture("前文选中文字后文");
  const getCursor = fixture.editor.getCursor;
  fixture.editor.getCursor = which => which === "from" ? { line: 0, ch: 2 } : which === "to" ? { line: 0, ch: 6 } : getCursor();
  asyncModule.exports.registerLinkFilter(fixture.plugin);
  fixture.paste("https://example.com\n第二行");
  assert.equal(fixture.editor.getValue(), "前文https://example.com\n第二行后文");
  fixture.editor.setValue(fixture.editor.getValue() + "新增");
  resolveTitle("网页标题");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fixture.editor.getValue(), "前文https://example.com\n第二行后文新增", "delayed title conversion never reapplies the old selection");
}
delete globalThis.document;
assert(notices.some(message => message.includes("未写入自动排版结果")));
console.log("Async note reformat and paste preserve edits made while title requests are pending.");
