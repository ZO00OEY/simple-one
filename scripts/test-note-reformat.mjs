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
