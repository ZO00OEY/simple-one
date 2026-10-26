import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";

async function load(path) {
  const output = await build({ entryPoints: [path], bundle: true, format: "cjs", platform: "node", write: false,
    external: ["@codemirror/state", "@codemirror/view", "@codemirror/language"] });
  const { createRequire } = await import("node:module");
  const module = { exports: {} };
  new Function("require", "module", "exports", output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const { normalizeTypography, TYPOGRAPHY_DEFAULTS, isStandaloneBoldLine } = await load("src/shared/typography.ts");
const { activeDisplayProfile, displayParameterEnabled } = await load("src/shared/displayProfile.ts");
const { DEFAULT_SETTINGS } = await load("src/types.ts");
const displaySettings = structuredClone(DEFAULT_SETTINGS);
assert.equal(displayParameterEnabled(displaySettings, false, "readableLineWidth"), true);
assert.equal(displayParameterEnabled(displaySettings, true, "readableLineWidth"), false);
assert.equal(displayParameterEnabled(displaySettings, true, "popupWindowScale"), false);
assert.equal(displayParameterEnabled(displaySettings, true, "headerButtonSize"), true);
displaySettings.displayParameterSwitches.desktop.readableLineWidth = false;
assert.equal(activeDisplayProfile(displaySettings, false).readableLineWidth, "");
assert.equal(displaySettings.readableLineWidth, "900");
displaySettings.displayParameterSwitches.desktop.readableLineWidth = true;
assert.equal(activeDisplayProfile(displaySettings, false).readableLineWidth, "900");
displaySettings.mobileDisplay.imageMaxHeight = "300";
displaySettings.displayParameterSwitches.mobile.imageMaxHeight = false;
assert.equal(activeDisplayProfile(displaySettings, true).imageMaxHeight, "");
assert.equal(displaySettings.mobileDisplay.imageMaxHeight, "300");
assert.equal(activeDisplayProfile(displaySettings, false).imageMaxHeight, "450");
assert.equal(isStandaloneBoldLine("**队友设计**"), true);
assert.equal(isStandaloneBoldLine("  __独立标题__  "), true);
assert.equal(isStandaloneBoldLine("**女酒鬼剧情线完成度最高。**后面继续正文。"), false);
assert.equal(isStandaloneBoldLine("**一段**正文**另一段**"), false);
assert.deepEqual(normalizeTypography(), TYPOGRAPHY_DEFAULTS);
assert.equal(normalizeTypography({ fontSize: NaN, lineHeight: Infinity }).fontSize, 15);
assert.equal(normalizeTypography({ fontSize: 999 }).fontSize, 36);
assert.equal("lineLength" in normalizeTypography({ lineLength: 40 }), false);
assert.equal(normalizeTypography({ enabled: false }).enabled, false);
assert.equal(normalizeTypography({ paragraphStyle: "invalid" }).paragraphStyle, "spaced");

const dom = new JSDOM("<html><head></head><body></body></html>");
globalThis.document = dom.window.document;
dom.window.HTMLElement.prototype.setCssProps = function (properties) {
  for (const [key, value] of Object.entries(properties)) this.style.setProperty(key, value);
};
const { registerTypography, paragraphDecorations, decorateRenderedLineIndents } = await load("src/features/typography.ts");
const state = EditorState.create({ doc: "第一段\n接续文字\n\n第二段\n\n# 标题\n\n- 列表\n\n> 引用" });
const decorations = paragraphDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
const marked = [];
decorations.between(0, state.doc.length, (from, _to, value) => marked.push([state.doc.lineAt(from).number, value.spec.class]));
assert.deepEqual(marked, [[1, "simple-typography-paragraph-start"], [2, "simple-typography-paragraph-start simple-typography-paragraph-end"], [4, "simple-typography-paragraph-start simple-typography-paragraph-end"]]);
// A long logical line still gets one line decoration, independent of soft wraps.
const long = EditorState.create({ doc: "长段落".repeat(300) });
const longMarked = paragraphDecorations({ state: long, visibleRanges: [{ from: 0, to: long.doc.length }] });
assert.equal(longMarked.size, 1);
const boldState = EditorState.create({ doc: "**队友设计**\n**加粗起句**，后面是正文。" });
const boldMarked = [];
paragraphDecorations({ state: boldState, visibleRanges: [{ from: 0, to: boldState.doc.length }] })
  .between(0, boldState.doc.length, (from, _to, value) => boldMarked.push([from, value.spec.class.includes("simple-typography-bold-line")]));
assert.deepEqual(boldMarked.map(row => row[1]), [true, false]);
const root = document.createElement("div");
root.innerHTML = '<p>第一行<br>第二行<strong><br>加粗行</strong><a href="#">链接</a></p><blockquote><p>引用<br>续行</p></blockquote><ul><li><p>列表<br>续行</p></li></ul>';
for (const br of root.querySelectorAll("br")) Object.defineProperty(br, "doc", { value: { win: {
  createSpan: ({ cls }) => { const span = document.createElement("span"); span.className = cls; return span; },
} } });
const originalText = root.textContent;
decorateRenderedLineIndents(root);
decorateRenderedLineIndents(root);
assert.equal(root.querySelectorAll(".simple-typography-line-indent").length, 2);
assert.equal(root.textContent, originalText);
assert.equal(root.querySelectorAll("br").length, 4);
assert.ok(root.querySelector("strong .simple-typography-line-indent"));
assert.ok(root.querySelector("a"));
const titles = document.createElement("p");
titles.innerHTML = '<strong>队友设计</strong><br><strong>武装团体的领袖</strong><br><strong>加粗起句</strong>，后面继续正文。';
for (const br of titles.querySelectorAll("br")) Object.defineProperty(br, "doc", { value: { win: {
  createSpan: ({ cls }) => { const span = document.createElement("span"); span.className = cls; return span; },
} } });
decorateRenderedLineIndents(titles);
decorateRenderedLineIndents(titles);
assert.ok(titles.classList.contains("simple-typography-bold-line"));
assert.deepEqual([...titles.querySelectorAll(".simple-typography-line-indent")].map(e => e.classList.contains("simple-typography-bold-line")), [true, false]);
const cleanup = [], events = {};
const plugin = {
  isMobile: false, settings: { desktopTypography: { ...TYPOGRAPHY_DEFAULTS } },
  register: fn => cleanup.push(fn), registerEditorExtension() {}, registerEvent() {},
  registerMarkdownPostProcessor() {},
  app: { workspace: { iterateAllLeaves() {}, on: (event, fn) => { events[event] = fn; } } },
};
const refresh = registerTypography(plugin);
const enabled = (doc = document) => doc.body.classList.contains("simple-desktop-typography");
assert.equal(document.body.style.getPropertyValue("--simple-typography-width"), "");
document.body.style.setProperty("--file-line-width", "900px");
plugin.settings.desktopTypography.paragraphStyle = "indent";
refresh();
assert.ok(document.body.classList.contains("simple-chinese-reading"));
assert.equal(document.body.style.getPropertyValue("--simple-typography-indent"), "");
plugin.settings.desktopTypography.paragraphStyle = "spaced";
refresh();
assert.equal(document.body.style.getPropertyValue("--simple-typography-indent"), "");
assert.ok(!document.body.classList.contains("simple-chinese-reading"));
assert.equal(document.body.style.getPropertyValue("--file-line-width"), "900px");
plugin.settings.desktopTypography.enabled = false;
refresh();
assert.equal(enabled(), false);
assert.equal(document.body.style.length, 1);
assert.equal(document.body.style.getPropertyValue("--file-line-width"), "900px");
plugin.settings.desktopTypography.paragraphStyle = "indent";
refresh();
assert.ok(document.body.classList.contains("simple-chinese-reading"));
assert.equal(enabled(), false);
assert.equal(document.body.style.getPropertyValue("--simple-typography-indent"), "");
assert.equal(document.body.style.getPropertyValue("--simple-typography-font-size"), "");
plugin.settings.desktopTypography.paragraphStyle = "spaced";
plugin.settings.desktopTypography.enabled = true;
refresh();
assert.ok(enabled());
plugin.settings.displayParameterSwitches = { desktop: { fontSize: false, paragraphSpacing: false }, mobile: {} };
refresh();
assert.equal(document.body.classList.contains("simple-typography-font-size"), false);
assert.equal(document.body.classList.contains("simple-typography-paragraph-spacing"), false);
assert.equal(document.body.classList.contains("simple-typography-line-height"), true);
assert.equal(document.body.style.getPropertyValue("--simple-typography-font-size"), "");
assert.equal(document.body.style.getPropertyValue("--simple-typography-line-height"), "1.7");
assert.equal(plugin.settings.desktopTypography.fontSize, 15);
const second = new JSDOM("<html><head></head><body></body></html>");
events["window-open"]({ doc: second.window.document });
assert.ok(enabled(second.window.document));
cleanup.forEach(fn => fn());
assert.equal(enabled(), false);
assert.equal(enabled(second.window.document), false);
assert.equal(document.body.classList.contains("simple-chinese-reading"), false);
plugin.isMobile = true;
registerTypography(plugin)();
assert.equal(enabled(), false);
console.log("Typography normalization, toggle, popout and cleanup tests passed");
