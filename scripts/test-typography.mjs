import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";

async function load(path, obsidian) {
  const output = await build({ entryPoints: [path], bundle: true, format: "cjs", platform: "node", write: false,
    external: ["obsidian", "@codemirror/state", "@codemirror/view", "@codemirror/language"] });
  const { createRequire } = await import("node:module");
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", output.outputFiles[0].text)(name => name === "obsidian" && obsidian ? obsidian : require(name), module, module.exports);
  return module.exports;
}
const { normalizeTypography, TYPOGRAPHY_DEFAULTS, isStandaloneBoldLine, headingFontFloorPatch } = await load("src/shared/typography.ts");
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
assert.equal(TYPOGRAPHY_DEFAULTS.fontSize, 15);
assert.equal(TYPOGRAPHY_DEFAULTS.letterSpacing, 0.04);
assert.equal(TYPOGRAPHY_DEFAULTS.latinFont, "Segoe UI");
assert.equal(normalizeTypography({ fontSize: NaN, lineHeight: Infinity }).fontSize, 15);
assert.equal(normalizeTypography({ fontSize: 15, letterSpacing: 0.5 }).fontSize, 15, 'stored font size is not migrated to the new default');
assert.equal(normalizeTypography({ fontSize: 15, letterSpacing: 0.5 }).letterSpacing, 0.04, 'legacy pixel spacing uses the em default');
assert.equal(normalizeTypography({ letterSpacing: 0.08, letterSpacingUnit: "em" }).letterSpacing, 0.08, 'valid saved em spacing is preserved');
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
assert.equal(document.body.style.getPropertyValue("--simple-typography-line-height"), "", 'disabling typography clears line height without disabling independent font controls');
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
const { registerThemeAppearance } = await load("src/features/themeAppearance.ts");
for (const doc of [document, second.window.document]) Object.defineProperty(doc, 'win', { value: { createEl: tag => doc.createElement(tag) } });
plugin.settings.themeBackgroundColor = "#f6f7f9";
const refreshTheme = registerThemeAppearance(plugin);
assert(document.body.classList.contains('simple-theme-sidebar-background'));
assert.equal(document.body.style.getPropertyValue('--simple-theme-sidebar-background'),'#f6f7f9');
assert.equal(document.body.style.getPropertyValue('--background-primary'),'','sidebar color never overrides note background');
events['window-open']({ doc: second.window.document });
assert.equal(second.window.document.body.style.getPropertyValue('--simple-theme-sidebar-background'),'#f6f7f9');
plugin.settings.themeBackgroundColor = '';
refreshTheme();
assert(!document.body.classList.contains('simple-theme-sidebar-background'),'reset follows the theme');
plugin.settings.themeBackgroundColor = 'red; } body { color: red';
refreshTheme();
assert.equal(document.body.style.getPropertyValue('--simple-theme-sidebar-background'),'','invalid colors cannot inject styles');
cleanup.forEach(fn => fn());
assert.equal(document.head.querySelector('style'), null, 'unloading restores theme backgrounds');
assert.equal(second.window.document.head.querySelector('style'), null);
assert(!second.window.document.body.classList.contains('simple-theme-sidebar-background'),'unload clears popout backgrounds');
console.log('Theme background, reset, popout, validation and cleanup tests passed');

// Things' 0.9em h6 must not fall below a 15px body; other headings retain their size.
const levels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const blankSizes = () => Object.fromEntries(levels.map(level => [level, '']));
const themeHeadings = { h1: 30, h2: 25, h3: 22, h4: 18, h5: 15, h6: 13.5 };
assert.deepEqual(headingFontFloorPatch(blankSizes(), 15, themeHeadings), { h6: '15' });
assert.deepEqual(headingFontFloorPatch({ ...blankSizes(), h5: '11', h6: '12' }, 15, { ...themeHeadings, h5: 11 }), { h5: '15', h6: '15' });
assert.deepEqual(headingFontFloorPatch({ ...blankSizes(), h6: '21' }, 15, themeHeadings), {}, 'valid larger explicit choices survive a stale computed-style sample');
assert.deepEqual(headingFontFloorPatch({ ...blankSizes(), h6: '15' }, 15, themeHeadings), {});
for (const body of [NaN, Infinity, 0, 9, 97]) assert.deepEqual(headingFontFloorPatch(blankSizes(), body, themeHeadings), {});
for (const h6 of [NaN, Infinity, 0, -1]) assert.deepEqual(headingFontFloorPatch(blankSizes(), 15, { ...themeHeadings, h6 }), {});
assert.deepEqual(headingFontFloorPatch(blankSizes(), 15.1234, { ...themeHeadings, h5: 16 }), { h6: '15.124' });

const headingObsidian = new Proxy({ Menu: class {}, Notice: class {}, Modal: class {}, addIcon() {}, setIcon() {}, setTooltip() {} },
  { get: (target, key) => key in target ? target[key] : class {} });
const { repairHeadingFontSizes } = await load('src/features/quickFormat.ts', headingObsidian);
function headingFixture({ mobile = false, body = 15, headings = themeHeadings, sizes = {} } = {}) {
  const window = new JSDOM('<html><head></head><body></body></html>').window;
  const doc = window.document, cleanups = [], applied = [];
  const measured = { body, headings: { ...headings }, calls: 0 };
  window.HTMLElement.prototype.createEl = function(tag, options = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    this.append(element); return element;
  };
  window.HTMLElement.prototype.createDiv = function(options) { return this.createEl('div', options); };
  doc.adoptedStyleSheets = [];
  doc.win = {
    closed: false,
    getComputedStyle(element) {
      measured.calls++;
      assert(element.closest('.workspace-leaf-content[data-type="markdown"].simple-font-size-probe'), 'font probe inherits a real Markdown leaf');
      assert(element.closest('.markdown-preview-view.markdown-rendered'), 'font probe inherits rendered Markdown styles');
      return { fontSize: element.tagName === 'P' ? String(measured.body) + 'px' : String(measured.headings[element.tagName.toLowerCase()]) + 'px' };
    },
    CSSStyleSheet: class { replaceSync(css) { applied.push(css); } }
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.desktopTypography.fontSize = 36;
  settings.enhancements.quickFormat.headingSizes = { ...blankSizes(), ...sizes };
  settings.enhancements.quickFormat.headingColors.h3 = '#123456';
  let saves = 0;
  const fixture = {
    doc, measured, applied, cleanups, save: async () => {},
    plugin: { isMobile: mobile, settings, register: fn => cleanups.push(fn),
      app: { workspace: { iterateAllLeaves() {} } }, saveSettings: async () => { saves++; await fixture.save(); } },
    get saves() { return saves; },
    use() { globalThis.document = doc; },
    dispose() { cleanups.forEach(fn => fn()); window.close(); }
  };
  fixture.use(); return fixture;
}
const originalDocument = globalThis.document;
try {
  {
    const f = headingFixture();
    assert.equal(await repairHeadingFontSizes(f.plugin), true);
    assert.equal(f.saves, 1);
    assert.deepEqual(f.plugin.settings.enhancements.quickFormat.headingSizes, { ...blankSizes(), h6: '15' });
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingColors.h3, '#123456');
    assert.match(f.applied.at(-1), /--h6-size:15px/);
    assert.equal(f.doc.querySelector('.simple-font-size-probe'), null);
    assert.equal(await repairHeadingFontSizes(f.plugin), false); assert.equal(f.saves, 1);
    f.plugin.settings.enhancements.quickFormat.headingSizes.h6 = '11';
    assert.equal(await repairHeadingFontSizes(f.plugin), false);
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h6, '11', 'a user choice is not repeatedly overridden in the same body-size context');
    assert.equal(await repairHeadingFontSizes(f.plugin, true), true); assert.equal(f.saves, 2);
    assert.equal(await repairHeadingFontSizes(f.plugin, true), false); assert.equal(f.saves, 2);
    f.measured.body = 18;
    assert.equal(await repairHeadingFontSizes(f.plugin), true);
    assert.deepEqual(f.plugin.settings.enhancements.quickFormat.headingSizes, { ...blankSizes(), h5: '18', h6: '18' });
    assert.equal(f.saves, 3); f.dispose();
  }
  {
    const f = headingFixture({ headings: { ...themeHeadings, h6: 16 } });
    assert.equal(await repairHeadingFontSizes(f.plugin), false); assert.equal(f.saves, 0);
    f.measured.headings.h6 = 13.5;
    assert.equal(await repairHeadingFontSizes(f.plugin), false, 'ordinary refresh keeps a completed body-size context');
    assert.equal(await repairHeadingFontSizes(f.plugin, true), true, 'a theme event remeasures headings even when body size is unchanged');
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h6, '15'); assert.equal(f.saves, 1); f.dispose();
  }
  {
    const f = headingFixture({ mobile: true });
    const desktop = structuredClone(f.plugin.settings.desktopTypography);
    assert.equal(await repairHeadingFontSizes(f.plugin), true);
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h6, '15', 'mobile uses the measured theme body, not desktop fontSize 36');
    assert.deepEqual(f.plugin.settings.desktopTypography, desktop); f.dispose();
  }
  {
    const f = headingFixture({ body: NaN });
    assert.equal(await repairHeadingFontSizes(f.plugin), false); assert.equal(f.saves, 0);
    assert.equal(f.doc.querySelector('.simple-font-size-probe'), null); f.dispose();
  }
  {
    const f = headingFixture({ sizes: { h5: '11' }, headings: { ...themeHeadings, h5: 11 } });
    let reject;
    f.save = () => new Promise((_resolve, failure) => { reject = failure; });
    const pending = repairHeadingFontSizes(f.plugin);
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h6, '15');
    f.plugin.settings.enhancements.quickFormat.headingSizes.h5 = '27';
    f.plugin.settings.enhancements.quickFormat.headingSizes.h3 = '44';
    reject(Error('fixture save failure')); await assert.rejects(pending, /fixture save failure/);
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h5, '27', 'failed save preserves a concurrent edit to a patched key');
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h3, '44');
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h6, '', 'only unchanged patch values roll back');
    assert.equal(f.applied.length, 0);
    f.save = async () => {};
    assert.equal(await repairHeadingFontSizes(f.plugin), true, 'failed save can retry the same measured body');
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h5, '27');
    assert.equal(f.plugin.settings.enhancements.quickFormat.headingSizes.h6, '15'); assert.equal(f.saves, 2); f.dispose();
  }
  {
    const f = headingFixture(); let finish;
    f.save = () => new Promise(resolve => { finish = resolve; });
    const pending = repairHeadingFontSizes(f.plugin);
    assert.equal(await repairHeadingFontSizes(f.plugin, true), false, 'an in-flight valid patch does not trigger a duplicate save on a theme event');
    assert.equal(f.saves, 1);
    f.cleanups.forEach(fn => fn()); finish(); await pending;
    assert.equal(f.applied.length, 0, 'save completion after unload cannot reapply styles'); f.dispose();
  }
  {
    const f = headingFixture(); f.doc.win.closed = true;
    assert.equal(await repairHeadingFontSizes(f.plugin), false);
    assert.equal(f.saves, 0); assert.equal(f.measured.calls, 0); f.dispose();
  }
  {
    const f = headingFixture(); let finish;
    f.save = () => new Promise(resolve => { finish = resolve; });
    const pending = repairHeadingFontSizes(f.plugin); f.doc.win.closed = true; finish(); await pending;
    assert.equal(f.applied.length, 0, 'save completion after the window closes cannot apply styles'); f.dispose();
  }
} finally { globalThis.document = originalDocument; }
console.log('Heading font floor: theme measurements, explicit choices, mobile isolation, save retry/concurrent edits and unloaded/closed-window guards passed.');
