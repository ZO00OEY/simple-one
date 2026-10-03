import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const folder = await mkdtemp(join(tmpdir(), "simple-share-test-"));
globalThis.crypto ??= webcrypto;
globalThis.window = { require, setTimeout };
const fixture = `export class TFile { constructor(path) { this.path=path; this.name=path.split('/').pop(); this.extension=this.name.split('.').pop(); this.basename=this.name.slice(0,-this.extension.length-1); } }
export class FileSystemAdapter { constructor(root) { this.root=root; } getBasePath() {return this.root;} }
export const Platform={isMobile:false};
export class Component{};export class ItemView{};export class MarkdownView{};export class Menu{};export class Modal{};export class FuzzySuggestModal{};export class Notice{};export class Setting{constructor(parent){if(globalThis.shareSetting)return globalThis.shareSetting(parent);}};export class WorkspaceLeaf{};export const addIcon=()=>{};export const setIcon=()=>{};export const setTooltip=()=>{};export const parseYaml=source=>({share_id:/^share_id: (.+)$/m.exec(source)?.[1]});`;
const plugin = { name: "obsidian-fixture", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" })); build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: fixture, loader: "js" })); } };
async function bundle(source, name) {
  const outfile = join(folder, `${name}.cjs`);
  await esbuild.build({ entryPoints: [source], bundle: true, platform: "node", format: "cjs", outfile, plugins: [plugin], logLevel: "silent" });
  return require(outfile);
}
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  const model = await bundle("src/features/share/model.ts", "model");
  assert.equal(model.formatShareLink("笔记名", "https://example.com/#/notes/abc"), "笔记名 https://example.com/#/notes/abc");
  assert.equal(model.formatShareLink("标题[补充]", "https://example.com/"), "标题[补充] https://example.com/");
  const columns = await bundle("src/shared/columns.ts", "columns");
  const diff = await bundle("src/features/sync/linkDiff.ts", "diff");
  const nested = await bundle("src/features/sync/nestedRepos.ts", "nested");
  const exporter = await bundle("src/features/share/export.ts", "export");
  const ids = new Set();
  for (let i = 0; i < 2000; i++) { const id = model.newShareId(ids); assert.match(id, /^[a-z0-9]{12}$/); ids.add(id); }
  assert.equal(ids.size, 2000);
  const stale = { enabled: true, sourcePath: "old.md", category: "写作", revision: 1 };
  const cancelled = { version: 1, notes: {}, files: [], intents: { k7m2x9a4w8p3: { enabled: false, category: "写作", hash: await model.intentHash({ enabled: false, category: "写作" }) } } };
  assert(model.remoteConflict(stale, cancelled, "k7m2x9a4w8p3"));
  stale.baseIntent = cancelled.intents.k7m2x9a4w8p3.hash;
  assert(!model.remoteConflict(stale, cancelled, "k7m2x9a4w8p3"));
  assert.throws(() => model.parseManifest("null"));
  assert.throws(() => model.parseManifest('{"version":2}'));
  assert.equal(columns.parseColumns("widths: 40:60\nleft\n---column---\nright").widths[0], 40);
  assert.equal(columns.parseColumns("widths: 50:40\nleft\n---column---\nright"), null);
  assert.equal(columns.parseColumns("widths: 25:25:25:25\na\n---column---\nb\n---column---\nc\n---column---\nd").content.length, 4);
  const options = { ...diff.DEFAULT_MOBILE_OPTIONS, syncPlugins: false, plugins: [], ignorePatterns: [] };
  assert.equal(diff.included(".gitshare/notes/example.md", options, ".obsidian", "simple-one"), false);
  assert.equal(diff.included(".obsidian/plugins/simple-one/share-manifest.json", options, ".obsidian", "simple-one"), true);
  assert.equal(diff.included(".obsidian/plugins/simple-one/share-local.json.recovery", { ...options, syncPlugins: true, plugins: ["simple-one"] }, ".obsidian", "simple-one"), false);
  const id = "k7m2x9a4w8p3", other = "p8n4w2a7b9c6";
  const source = { path: "写作/原名.md", name: "原名.md", basename: "原名", extension: "md" };
  const target = { path: "写作/目标.md", name: "目标.md", basename: "目标", extension: "md" };
  const privateNote = { path: "私人.md", name: "私人.md", basename: "私人", extension: "md" };
  const image = { path: "999 attachment/a.png", name: "a.png", basename: "a", extension: "png" };
  let markdown = `---\nshare_id: ${id}\nsecret: hidden\n---\n# 正文\n%%PRIVATE%%\n[[目标|公开目标]] ![[a.png|300]] [[私人]]\n\n\`\`\`simple-columns\nwidths: 50:50\n[[目标]]\n---column---\n![[a.png]]\n\`\`\`\n\`[[私人]]\`\n\`\`\`js\n[[私人]]\n\`\`\``;
  const vault = { read: async () => markdown, readBinary: async () => Uint8Array.of(1,2,3).buffer };
  const host = { app: { vault, metadataCache: { getFirstLinkpathDest: name => ({ "目标": target, "a.png": image, "私人": privateNote })[name], getFileCache: file => ({ frontmatter: file === target ? { share_id: other } : {} }) } } };
  host.app.vault.configDir = ".obsidian";
  const manifest = model.emptyManifest(); manifest.notes[other] = { enabled: true, sourcePath: target.path, category: "写作", revision: 1 };
  const index = new Map([[other, [target]]]);
  const exported = await exporter.exportNote(host, source, "写作", manifest, index);
  const publicNamed = await exporter.exportNote(host, source, "写作", manifest, index, "公开名称");
  assert.equal(publicNamed.title, "公开名称");
  assert.equal(publicNamed.source, exported.source);
  assert.notEqual(publicNamed.hash, exported.hash);
  assert.equal((await exporter.exportNote(host, { ...source, basename: "改名" }, "写作", manifest, index, "公开名称")).hash, publicNamed.hash);
  assert.notEqual(await model.intentHash({ enabled: true, category: "写作", publicName: "公开名称" }), await model.intentHash({ enabled: true, category: "写作" }));
  assert(!exported.source.includes("secret")); assert(!exported.source.includes("PRIVATE"));
  assert(exported.source.includes(`#/notes/${other}`)); assert(exported.source.includes("私人（未公开）"));
  assert(exported.source.includes('width="300"')); assert.equal(exported.assets.size, 1);
  const originalMarkdown = markdown;
  markdown = markdown.replace('a.png|300', 'a.png|300x180');
  assert((await exporter.exportNote(host, source, "写作", manifest, index)).source.includes('width="300" height="180"'));
  markdown = originalMarkdown;
  assert(exported.source.includes("`[[私人]]`")); assert(exported.source.includes("```js\n[[私人]]"));
  const renamed = await exporter.exportNote(host, { ...source, basename: "改名" }, "写作", manifest, index);
  assert.notEqual(exported.hash, renamed.hash);
  manifest.notes[other].enabled = false;
  assert(!(await exporter.exportNote(host, source, "写作", manifest, index)).source.includes(`#/notes/${other}`));
  markdown = "![[missing.png]]";
  await assert.rejects(() => exporter.exportNote(host, source, "写作", manifest, index), /找不到/);
  markdown = "长笔记正文\n".repeat(401);
  let uiTurn = false;
  setTimeout(() => { uiTurn = true; }, 0);
  const longNote = await exporter.exportNote(host, source, "写作", manifest, index);
  assert.equal(longNote.source, markdown);
  assert(uiTurn, "long-note processing must allow UI timers to run before completion");

  const root = join(folder, "vault"), remote = join(folder, "share.git"), privateRemote = join(folder, "private.git");
  await mkdir(root); await mkdir(remote); await mkdir(privateRemote);
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  git(privateRemote, ["init", "--bare", "--initial-branch=main"]);
  git(root, ["init", "--initial-branch=main"]); git(root, ["config", "user.name", "Test"]); git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(join(root, "private.md"), "private"); git(root, ["add", "private.md"]); git(root, ["commit", "-m", "initial private"]);
  git(root, ["remote", "add", "origin", privateRemote]); git(root, ["push", "-u", "origin", "main"]);
  // Share one fixture class between the host adapter and repository module.
  await writeFile(join(folder, "entry.ts"), `export {FileSystemAdapter,TFile} from "obsidian"; export {ShareRepository,websiteFiles} from ${JSON.stringify(resolve("src/features/share/repository.ts"))}; export {default as ShareFeature} from ${JSON.stringify(resolve("src/features/share/index.ts"))};`);
  const combined = await bundle(join(folder, "entry.ts"), "combined");
  // Exercise authorization selection through DOM events, without real credentials.
  const dom = new JSDOM("<body><main></main></body>");
  globalThis.DOMParser = dom.window.DOMParser;
  const templates = await bundle("src/features/share/template.ts", "template");
  templates.validateShareTemplate(templates.DEFAULT_SHARE_TEMPLATE);
  assert.throws(() => templates.validateShareTemplate(templates.DEFAULT_SHARE_TEMPLATE.replace('id="content"', 'id="missing-content"')), /content/);
  assert.throws(() => templates.validateShareTemplate(templates.DEFAULT_SHARE_TEMPLATE.replace('src="reader/app.js"', 'src="missing.js"')), /reader\/app.js/);
  assert.throws(() => templates.validateShareTemplate(templates.DEFAULT_SHARE_TEMPLATE.replace('</head>', '<base href="https://example.com"></head>')), /base/);
  const proto = dom.window.HTMLElement.prototype;
  proto.createEl = function(tag, options = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    this.append(element); return element;
  };
  proto.createDiv = function(options) { return this.createEl("div", options); };
  proto.createSpan = function(options) { return this.createEl("span", options); };
  proto.empty = function() { this.replaceChildren(); };
  proto.addClass = function(...names) { this.classList.add(...names); };
  proto.toggleClass = function(name, enabled) { this.classList.toggle(name, enabled); };
  globalThis.shareSetting = parent => {
    const setting = { settingEl: parent.createDiv({ cls: "setting-item" }) };
    setting.infoEl = setting.settingEl;
    setting.nameEl = setting.settingEl.createDiv(); setting.descEl = setting.settingEl.createDiv();
    setting.setName = text => { setting.nameEl.textContent = text; return setting; };
    setting.setDesc = text => { setting.descEl.textContent = text; return setting; };
    setting.setHeading = () => setting;
    setting.setClass = cls => { setting.settingEl.addClass(cls); return setting; };
    setting.addToggle = configure => {
      const toggleEl = setting.settingEl.createEl("input"); toggleEl.type = "checkbox";
      const control = { setValue(value) { toggleEl.checked = value; return this; }, setDisabled(value) { toggleEl.disabled = value; return this; }, onChange(callback) { toggleEl.addEventListener("change", () => callback(toggleEl.checked)); return this; } };
      configure(control); return setting;
    };
    setting.addDropdown = configure => {
      const selectEl = setting.settingEl.createEl("select");
      const control = { addOptions(options) { for (const [value, text] of Object.entries(options)) selectEl.createEl("option", { text, attr: { value } }); return this; }, setValue(value) { selectEl.value = value; return this; }, setDisabled(value) { selectEl.disabled = value; return this; }, onChange(callback) { selectEl.addEventListener("change", () => callback(selectEl.value)); return this; } };
      configure(control); return setting;
    };
    setting.addText = configure => {
      const inputEl = setting.settingEl.createEl("input");
      const control = { inputEl, setValue(value) { inputEl.value = value; return this; }, setPlaceholder(value) { inputEl.placeholder = value; return this; }, onChange(callback) { inputEl.addEventListener("input", () => callback(inputEl.value)); return this; } };
      configure(control); return setting;
    };
    setting.addButton = configure => {
      const buttonEl = setting.settingEl.createEl("button");
      const control = { buttonEl, setButtonText(text) { buttonEl.textContent = text; return this; }, setIcon(value) { buttonEl.dataset.icon = value; return this; }, setTooltip(value) { buttonEl.title = value; return this; }, setDisabled(value) { buttonEl.disabled = value; return this; }, setCta() { return this; }, onClick(callback) { buttonEl.addEventListener("click", callback); return this; } };
      configure(control); return setting;
    };
    return setting;
  };
  try {
    const uiCalls = [];
    let savedLayouts = 0;
    const ui = new combined.ShareFeature({ app: { vault: { getName: () => "fixture" }, workspace: { getLeavesOfType: () => [], requestSaveLayout() { savedLayouts++; } } }, sync: { exec: async (program, args, _auth, _trim, _timeout, output, stdin, signal) => {
      uiCalls.push({ program, args, stdin });
      if (args.includes("--web")) {
        output("First copy your one-time code: ABCD-1234");
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Authorization cancelled")), { once: true }));
      }
      return args[0] === "api" ? JSON.stringify({ login: "fixture" }) : "ok";
    } } });
    const rootEl = dom.window.document.querySelector("main");
    const click = text => { const button = [...rootEl.querySelectorAll("button")].find(element => element.textContent === text); assert(button, text); button.click(); };
    const settle = async () => { for (let attempt = 0; ui.setupBusy && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(ui.setupBusy, false); };
    ui.renderSettings(rootEl, true, false);
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-progress-label"), null);
    assert(rootEl.querySelector(".simple-one-sync-setup-status").textContent.includes("分享库首次设置尚未完成"));
    assert.equal(rootEl.querySelector(".simple-page-title"), null);
    assert.equal(rootEl.querySelectorAll(".simple-one-sync-setup-nav__step").length, 4);
    assert.equal(rootEl.querySelectorAll(".simple-one-sync-setup-nav__step")[1].disabled, true);
    assert.equal(rootEl.querySelector("input"), null, "credentials shown only for selected method");
    assert(rootEl.textContent.includes("安装工具"));
    click("Token 授权");
    const input = rootEl.querySelector("input"); assert.equal(input.type, "password");
    input.value = "fixture-secret"; input.dispatchEvent(new dom.window.Event("input"));
    click("已填写 token，验证授权"); await settle();
    assert.equal(ui.guideStep, 2); assert.equal(ui.token, "");
    assert.equal(uiCalls.find(call => call.args.includes("--with-token")).stdin, "fixture-secret\n");
    assert.equal(rootEl.querySelector(".simple-page-title"), null, "async re-render preserves shared header");
    rootEl.querySelector(".simple-one-sync-setup-nav__step").click();
    assert.equal(rootEl.querySelector("input").value, "");
    click("验证已有授权"); await settle(); assert.equal(ui.guideStep, 2);
    rootEl.querySelector(".simple-one-sync-setup-nav__step").click();
    click("浏览器登录授权");
    assert(rootEl.textContent.includes("ABCD-1234"));
    assert.equal(rootEl.querySelector("input"), null);
    assert([...rootEl.querySelectorAll(".simple-one-sync-setup-option")].every(button => button.disabled));
    click("取消授权等待"); await settle(); assert.equal(ui.guideStep, 1);
    assert.equal(ui.authController.signal.aborted, true);
    ui.manifest.site = { owner: "fixture", repo: "notes-share", branch: "main", initialized: true };
    ui.error = ""; ui.renderSettings(rootEl, true, false);
    assert(rootEl.querySelector(".simple-one-sync-setup-status").textContent.includes("分享库首次设置已完成"));
    const connectedSite = JSON.stringify(ui.manifest.site);
    click("重新检查或修复分享设置");
    assert.equal(ui.guideStep, 1); assert.equal(ui.guideAvailableStep, 1);
    assert.equal(JSON.stringify(ui.manifest.site), connectedSite, "rechecking preserves the configured sharing repository");
    ui.guideStep = 2; ui.guideAvailableStep = 2; ui.repoMode = "create";
    ui.takenRepository = { owner: "fixture", name: "notes-share" };
    ui.error = "仓库名称已被使用：fixture/notes-share。";
    ui.renderSettings(rootEl, true, false);
    const collisionFeedback = rootEl.querySelector(".simple-share-repo-feedback");
    assert(collisionFeedback.querySelector(".simple-one-sync-setup-error"));
    assert(collisionFeedback.previousElementSibling.querySelector("input"), "collision appears beneath the repository-name input");
    click("使用这个已有仓库");
    assert.equal(ui.repoMode, "existing"); assert.equal(ui.draftRepo, "https://github.com/fixture/notes-share");
    assert.equal(ui.guideStep, 2, "selecting an existing repository still requires explicit verification");
    const verifyFeedback = rootEl.querySelector(".simple-share-repo-feedback");
    assert.equal(verifyFeedback.querySelectorAll("li").length, 3);
    assert(verifyFeedback.previousElementSibling.querySelector("input"));
    assert(verifyFeedback.nextElementSibling.textContent.includes("核验并连接已有仓库"));
    const layout = new combined.ShareFeature({});
    const firstId = "aaaaaaaaaaaa", secondId = "bbbbbbbbbbbb", withdrawnId = "cccccccccccc";
    layout.manifest.notes = {
      [firstId]: { enabled: true, sourcePath: "本地/子目录/甲.md", category: "公开/专栏", publicName: "公开甲", revision: 1 },
      [secondId]: { enabled: true, sourcePath: "本地/乙.md", category: "公开", revision: 1 },
      [withdrawnId]: { enabled: false, sourcePath: "旧/撤下.md", category: "旧公开", revision: 1 }
    };
    layout.rows = [{ id: firstId, title: "甲", state: "已发布" }, { id: secondId, title: "乙", state: "待发布" }, { id: withdrawnId, title: "撤下", state: "已撤下" }];
    const collapsed = new Set(["source:/本地"]);
    layout.renderPanel(rootEl, "", false, false, "source", collapsed);
    assert.equal(rootEl.querySelectorAll("details").length, 2);
    assert.equal(rootEl.querySelector("details").open, false);
    assert.equal(rootEl.querySelectorAll(".simple-share-note-row").length, 2);
    assert(rootEl.querySelector("details details .simple-share-note-row").textContent.includes("甲"));
    layout.renderPanel(rootEl, "甲", false, false, "source", collapsed);
    assert([...rootEl.querySelectorAll("details")].every(element => element.open), "search reveals matching nested notes");
    assert(collapsed.has("source:/本地"), "search preserves normal folder collapse state");
    layout.renderPanel(rootEl, "", true, false, "public", collapsed);
    assert(rootEl.querySelector("details details .simple-share-note-row").textContent.includes("公开甲"));
    assert.equal(rootEl.querySelectorAll(".is-withdrawn").length, 1);
    layout.renderPanel(rootEl, "", false);
    assert.equal(rootEl.querySelector("details"), null, "default layout is flat");
    assert([...rootEl.querySelectorAll(".simple-share-note-row")].every(element => element.children[1].hidden), "paths are hidden by default");
    const ascendingNames = [...rootEl.querySelectorAll(".simple-share-note-row")].map(element => element.children[0].textContent);
    layout.renderPanel(rootEl, "", false, false, "list", collapsed, undefined, true);
    assert.deepEqual([...rootEl.querySelectorAll(".simple-share-note-row")].map(element => element.children[0].textContent), ascendingNames.toReversed(), "descending reverses the visible filename order");
    layout.manifest.notes[firstId].publicName = "Z public";
    layout.manifest.notes[secondId].publicName = "A public";
    layout.renderPanel(rootEl, "", false, false, "public");
    const publicFolder = [...rootEl.querySelectorAll("details")].find(element => element.querySelector(":scope > summary").textContent === "公开");
    assert(publicFolder.querySelector(":scope > .simple-share-folder-body > .simple-share-note-row").textContent.includes("A public"));
    ui.manifest.enabled = false; ui.renderSettings(rootEl, false, false);
    assert.equal(rootEl.querySelectorAll(".simple-section-title").length, 1);
    assert.equal(rootEl.querySelector(".simple-section-title").textContent, "界面设置", "only display options have a section heading");
    assert(rootEl.querySelector(".simple-share-settings-dependent").classList.contains("is-disabled"));
    assert([...rootEl.querySelectorAll(".simple-share-settings-dependent button")].every(button => button.disabled));
    assert(rootEl.querySelector(".simple-share-deployment-result"));
    ui.manifest.enabled = true;
    ui.renderSettings(rootEl, false, false);
    const selects = rootEl.querySelectorAll("select");
    selects[0].value = "public"; selects[0].dispatchEvent(new dom.window.Event("change"));
    assert.equal(ui.display.layout, "public");
    assert.equal(ui.display.layout, "public");
    assert(savedLayouts > 0, "display preferences use Obsidian workspace persistence");
    ui.restoreDisplay({ layout: "source", showPaths: true });
    assert.equal(ui.display.layout, "public", "obsolete workspace state cannot override persisted display settings");
    const deploymentCalls = [];
    let finishDeployment;
    ui.host.sync.exec = async (_program, args) => { deploymentCalls.push(args); return await new Promise(resolve => { finishDeployment = resolve; }); };
    ui.local = async () => ({ version: 1, site: "fixture/notes-share", commit: "fixture-commit" });
    const check = ui.checkDeployment();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(rootEl.querySelector(".simple-share-deployment-result").textContent.includes("正在检查"));
    assert([...rootEl.querySelectorAll("button")].some(button => button.textContent === "检查中…" && button.disabled));
    finishDeployment(JSON.stringify({ commit: "fixture-commit", status: "built" })); await check;
    assert.equal(rootEl.querySelector(".simple-share-deployment-result").textContent, "网站已更新");
    assert.deepEqual(deploymentCalls, [["api", "repos/fixture/notes-share/pages/builds/latest"]], "deployment inspection only reads build status and never configures Pages or publishes notes");
  } finally { delete globalThis.shareSetting; dom.window.close(); }
  console.log("Share authorization UI: method selection, token handoff, device code cancellation and shared title preservation passed.");
  {
    for (const occupied of ["precheck", "create-race", "permission", "free"]) {
      const calls = [];
      const creator = new combined.ShareFeature({ sync: { exec: async (_program, args) => {
        calls.push(args);
        if (args.includes("user")) return "fixture";
        if (args[0] === "api") { if (occupied === "precheck") return "{}"; throw new Error("HTTP 404"); }
        if (occupied === "create-race") throw new Error("Name already exists on this account");
        if (occupied === "permission") throw new Error("HTTP 403: denied");
        return "created";
      } } });
      let bound;
      creator.bind = async (owner, name) => { bound = `${owner}/${name}`; };
      if (["precheck", "create-race"].includes(occupied)) {
        await assert.rejects(() => creator.createRepository("vault-share"), /仓库名称已被使用：fixture\/vault-share.*更换名称.*使用已有公开分享仓库/);
        assert.deepEqual(creator.takenRepository, { owner: "fixture", name: "vault-share" });
        assert.equal(bound, undefined);
        if (occupied === "precheck") assert(!calls.some(args => args.includes("create")), "existing repository must not be created or reused silently");
      } else if (occupied === "permission") await assert.rejects(() => creator.createRepository("vault-share"), /403: denied/);
      else { await creator.createRepository("vault-share"); assert.equal(bound, "fixture/vault-share"); assert(calls.some(args => args.includes("create") && args.includes("--public"))); }
    }
    let scans = 0, active = 0, peak = 0, release;
    const manager = new combined.ShareFeature({});
    manager.scanNow = async () => { scans++; active++; peak = Math.max(peak, active); if (scans === 1) await new Promise(resolve => { release = resolve; }); active--; };
    const first = manager.scan(), second = manager.scan();
    release(); await Promise.all([first, second]); assert.equal(scans, 2); assert.equal(peak, 1, "new changes request a follow-up without overlapping scans");
    let reveal = false, closed = false, finishScan;
    manager.host.app = { workspace: { getLeavesOfType: () => [], getRightLeaf: () => ({ setViewState: async () => {} }), revealLeaf: async () => { reveal = true; } }, setting: { close() { closed = true; } } };
    manager.scan = () => new Promise(resolve => { finishScan = resolve; });
    await manager.open(true);
    assert(reveal && closed, "settings button reveals the manager and closes the settings modal before background checking completes");
    finishScan();
    const sequence = [];
    manager.open = async () => { sequence.push("open"); };
    manager.shareNow = async () => { sequence.push("publish"); assert.equal(manager.publishingTitle, "current"); };
    await manager.share(new combined.TFile("current.md"));
    assert.deepEqual(sequence, ["open", "publish"], "sharing reveals the progress panel before publishing starts");
    assert.equal(manager.sharing, false);
  }
  console.log("Share manager: background opening, serialized refresh and repository-name conflicts passed.");
  const adapter = new combined.FileSystemAdapter(root);
  adapter.exists = async path => { try { await stat(join(root, path)); return true; } catch { return false; } };
  adapter.read = path => readFile(join(root, path), "utf8");
  adapter.readBinary = async path => { const bytes = await readFile(join(root, path)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); };
  adapter.write = (path, value) => writeFile(join(root, path), value);
  adapter.writeBinary = (path, value) => writeFile(join(root, path), Buffer.from(value));
  adapter.mkdir = path => mkdir(join(root, path), { recursive: true });
  adapter.remove = path => unlink(join(root, path));
  adapter.list = async path => { const entries = await readdir(join(root, path), { withFileTypes: true }); return { files: entries.filter(item => item.isFile()).map(item => `${path}/${item.name}`), folders: entries.filter(item => item.isDirectory()).map(item => `${path}/${item.name}`) }; };
  let offline = false;
  const realCalls = [];
  const repoHost = { app: { vault: { adapter, configDir: ".obsidian" } }, sync: { exec: async (program, args, auth, trim = true) => {
    if (program === "gh") return JSON.stringify(args.includes("user") ? { login: "tester", id: 1 } : { private: false, permissions: { push: true } });
    realCalls.push(args);
    if (offline && args.includes("push") && args.includes("-C")) throw new Error("network offline");
    let actual = [...args];
    if (actual[0] === "clone") actual = actual.map(value => value === "https://github.com/tester/share.git" ? remote : value);
    const result = execFileSync(program, actual, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return trim ? result.trim() : result;
  } } };
  const repository = new combined.ShareRepository(repoHost, { owner: "tester", repo: "share", branch: "main" });
  await repository.checkPrivateFreshness();
  // ensure validates the actual origin URL; local fixture is transported through insteadOf.
  git(root, ["config", "url." + remote + ".insteadOf", "https://github.com/tester/share.git"]);
  // The clone test adapter translates URLs; record the public origin after clone, as a real transport rewrite would.
  const originalExec = repoHost.sync.exec;
  repoHost.sync.exec = async (...args) => { const result = await originalExec(...args); if (args[0] === "git" && args[1][0] === "clone") git(join(root, ".gitshare"), ["remote", "set-url", "origin", "https://github.com/tester/share.git"]); return result; };
  await repository.ensure();
  git(join(root, ".gitshare"), ["config", "url." + remote + ".insteadOf", "https://github.com/tester/share.git"]);
  await repository.refresh();
  const state = await repository.state(); assert.equal(state.files.length, 0);
  let job;
  const files = combined.websiteFiles();
  files.set(`notes/${id}.md`, "# shared");
  const next = { version: 1, notes: { [id]: { title: "shared", category: "写作", hash: await model.sha256("shared"), assets: [] } }, files: [...files.keys(), "catalog.json", "publish-state.json"] };
  files.set("catalog.json", JSON.stringify({ version: 1, notes: [{ id, title: "shared", category: "写作" }] }));
  files.set("publish-state.json", JSON.stringify(next));
  job = await repository.writeFiles(files, state, async value => { job = value; });
  offline = true;
  await assert.rejects(() => repository.push(job, async value => { job = value; }), /offline/);
  assert(job.commit);
  offline = false; await repository.refresh(job); await repository.push(job, async value => { job = value; });
  assert.equal(git(remote, ["show", `main:notes/${id}.md`]), "# shared");
  assert(!git(root, ["ls-files"]).includes(".gitshare"));
  assert(!git(remote, ["ls-tree", "-r", "--name-only", "main"]).includes("private.md"));
  assert.equal((await nested.findNestedRepos(root, ".obsidian")).length, 0);
  // Explicit withdrawal removes only managed public artifacts and preserves the private note.
  const previous = await repository.state();
  const withdrawn = combined.websiteFiles();
  withdrawn.set("catalog.json", '{"version":1,"notes":[]}');
  withdrawn.set("publish-state.json", JSON.stringify({ version: 1, notes: {}, files: [...withdrawn.keys(), "publish-state.json"] }));
  let withdrawal;
  withdrawal = await repository.writeFiles(withdrawn, previous, async value => { withdrawal = value; });
  await repository.push(withdrawal, async value => { withdrawal = value; });
  assert(!git(remote, ["ls-tree", "-r", "--name-only", "main"]).includes(`notes/${id}.md`));
  assert.equal(await readFile(join(root, "private.md"), "utf8"), "private");
  // Unknown files survive; manually modified managed files prevent the next publish.
  await writeFile(join(root, ".gitshare", "manual.txt"), "keep");
  await assert.rejects(() => repository.refresh(), /未提交/);
  assert.equal(await readFile(join(root, ".gitshare", "manual.txt"), "utf8"), "keep");
  await unlink(join(root, ".gitshare", "manual.txt"));
  // File generation failure rolls back only its known public files.
  const beforeFailure = await repository.state();
  const pendingFiles = new Map(withdrawn); pendingFiles.set(`notes/${id}.md`, "temporary");
  const adapterWrite = adapter.write; let failOnce = true;
  adapter.write = async (path, value) => { if (failOnce && path === ".gitshare/catalog.json") { failOnce = false; throw new Error("fixture write failure"); } return adapterWrite(path, value); };
  await assert.rejects(() => repository.writeFiles(pendingFiles, beforeFailure, async () => {}), /write failure/);
  adapter.write = adapterWrite;
  await repository.refresh();
  assert(!await adapter.exists(`.gitshare/notes/${id}.md`));

  // Exercise the actual feature orchestration with a source identity and real isolated repositories.
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => name === "--simple-image-max-height" ? "320px" : "", color: "rgb(80, 120, 160)" });
  repoHost.settings = { enhancements: { quickFormat: { customCallouts: [], calloutColors: { warning: "#aabbcc" } } } };
  repoHost.sync.isSyncing = () => false;
  repoHost.manifest = { id: "simple-one" };
  repoHost.app.workspace = { getLeavesOfType: () => [] };
  let sourceFiles = [{ path: "写作/source.md", basename: "source", name: "source.md", extension: "md" }];
  repoHost.app.vault.getMarkdownFiles = () => sourceFiles;
  repoHost.app.vault.getAbstractFileByPath = path => sourceFiles.find(file => file.path === path);
  repoHost.app.vault.read = async () => `---\nshare_id: ${id}\nprivate: secret\n---\n# 正文\n`;
  repoHost.app.metadataCache = { getFileCache: () => ({ frontmatter: { share_id: id } }) };
  const manifestPath = ".obsidian/plugins/simple-one/share-manifest.json";
  await adapter.mkdir(".obsidian/plugins/simple-one");
  const registry = model.emptyManifest(); registry.site = { owner: "tester", repo: "share", branch: "main" };
  registry.notes[id] = { enabled: true, sourcePath: sourceFiles[0].path, category: "写作", revision: 1 };
  await adapter.write(manifestPath, model.serializeManifest(registry));
  const feature = new combined.ShareFeature(repoHost);
  offline = true;
  await assert.rejects(() => feature.publish(), /offline/);
  await assert.rejects(() => feature.change(value => { value.notes[id].enabled = false; }), /待恢复/);
  offline = false; await feature.publish();
  const appearance = await readFile(join(root, ".gitshare/reader/appearance.css"), "utf8");
  assert(appearance.includes('--share-image-max-height:320px'));
  assert(appearance.includes('.callout[data-callout="caution"]{--callout-color:#aabbcc}'));
  assert(!appearance.includes('--share-size') && !appearance.includes('--h1-color'), "reader typography must stay independent of local headings and font size");
  assert(!git(remote, ["show", `main:notes/${id}.md`]).includes("secret"));
  const customTemplate = templates.DEFAULT_SHARE_TEMPLATE.replace("<title>分享笔记</title>", "<title>自定义分享</title>");
  await feature.saveTemplate(customTemplate, "已导入");
  assert(!git(remote, ["show", "main:index.html"]).includes("自定义分享"), "import saves locally without publishing");
  await feature.publish();
  assert.equal(git(remote, ["show", "main:index.html"]), customTemplate.trim());
  await assert.rejects(() => feature.saveTemplate("<html><body>损坏</body></html>", ""), /content/);
  assert.equal(await adapter.read(`${repoHost.app.vault.configDir}/plugins/simple-one/share-template.html`), customTemplate, "invalid imports preserve the active template");
  await feature.saveTemplate(templates.DEFAULT_SHARE_TEMPLATE, "已恢复默认");
  assert.equal(await adapter.read(`${repoHost.app.vault.configDir}/plugins/simple-one/share-template.previous.html`), customTemplate);
  await feature.publish();
  assert.equal(git(remote, ["show", "main:index.html"]), templates.DEFAULT_SHARE_TEMPLATE.trim(), "restoring default changes the next published website");
  await feature.change(value => { value.notes[other] = { enabled: true, sourcePath: "missing.md", category: "待分享", revision: 1 }; });
  await feature.publish(false, id);
  assert(!git(remote, ["ls-tree", "-r", "--name-only", "main"]).includes(`notes/${other}.md`), "single-note publishing must preserve unrelated pending changes");
  assert.equal(feature.manifest.notes[other].baseHash, undefined);
  const originalFile = sourceFiles[0], cachedFile = repoHost.app.metadataCache.getFileCache;
  sourceFiles[0] = new combined.TFile(originalFile.path);
  repoHost.app.metadataCache.getFileCache = () => ({ frontmatter: {} });
  await feature.publish(false, id);
  assert.equal(JSON.parse(git(remote, ["show", "main:catalog.json"])).notes.find(note => note.id === id).title, "source", "single-note publishing reads freshly written ID when metadata cache lags");
  sourceFiles[0] = originalFile; repoHost.app.metadataCache.getFileCache = cachedFile;
  await feature.change(value => { delete value.notes[other]; });
  const originalLink = id;
  sourceFiles[0] = { ...sourceFiles[0], path: "另一个分类/renamed.md", basename: "renamed", name: "renamed.md" };
  await feature.scan(); await feature.publish();
  assert.equal(JSON.parse(await adapter.read(".gitshare/catalog.json")).notes[0].id, originalLink);
  assert.equal(JSON.parse(await adapter.read(".gitshare/catalog.json")).notes[0].title, "renamed");
  const staleRegistry = await adapter.read(manifestPath);
  sourceFiles = [];
  const remoteBeforeMissing = git(remote, ["rev-parse", "main"]);
  await assert.rejects(() => feature.publish(), /源文件缺失/);
  assert.equal(git(remote, ["rev-parse", "main"]), remoteBeforeMissing);
  assert(git(remote, ["ls-tree", "-r", "--name-only", "main"]).includes(`notes/${id}.md`));
  await feature.change(value => { value.notes[id].enabled = false; value.notes[id].revision++; });
  await feature.publish();
  assert.equal(JSON.parse(git(remote, ["show", "main:publish-state.json"])).intents[id].enabled, false);
  await adapter.write(manifestPath, staleRegistry);
  sourceFiles = [{ path: "另一个分类/renamed.md", basename: "renamed", name: "renamed.md", extension: "md" }];
  const withdrawnSha = git(remote, ["rev-parse", "main"]);
  await assert.rejects(() => feature.publish(), /云端分享设置已改变/);
  assert.equal(git(remote, ["rev-parse", "main"]), withdrawnSha);
  await feature.acceptLocal(id); await feature.publish();
  assert(git(remote, ["ls-tree", "-r", "--name-only", "main"]).includes(`notes/${id}.md`));
  // A second device restores the ignored public working directory from the repo,
  // while its synchronized private manifest continues to be the desired state.
  const secondRoot = join(folder, "second-vault");
  git(folder, ["clone", privateRemote, secondRoot]);
  const secondAdapter = new combined.FileSystemAdapter(secondRoot);
  secondAdapter.exists = async path => { try { await stat(join(secondRoot, path)); return true; } catch { return false; } };
  secondAdapter.read = path => readFile(join(secondRoot, path), "utf8");
  secondAdapter.write = (path, value) => writeFile(join(secondRoot, path), value);
  const secondHost = { app: { vault: { adapter: secondAdapter, configDir: ".obsidian" } }, sync: { exec: async (program, args, auth, trim = true) => {
    if (program === "gh") return JSON.stringify({ private: false, permissions: { push: true } });
    let actual = [...args];
    if (args[0] === "clone") actual = actual.map(value => value === "https://github.com/tester/share.git" ? remote : value);
    const result = execFileSync(program, actual, { cwd: secondRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (args[0] === "clone") {
      git(join(secondRoot, ".gitshare"), ["remote", "set-url", "origin", "https://github.com/tester/share.git"]);
      git(join(secondRoot, ".gitshare"), ["config", "url." + remote + ".insteadOf", "https://github.com/tester/share.git"]);
    }
    return trim ? result.trim() : result;
  } } };
  const secondRepository = new combined.ShareRepository(secondHost, registry.site);
  await secondRepository.checkPrivateFreshness(); await secondRepository.ensure(); await secondRepository.refresh();
  assert.equal((await secondRepository.state()).notes[id].title, "renamed");
  assert(git(remote, ["ls-tree", "-r", "--name-only", "main"]).includes(`notes/${id}.md`));
  assert(!git(secondRoot, ["ls-files"]).includes(".gitshare"));
  assert(realCalls.some(args => args[0] === "-C" && args.includes("push")));
  console.log("Share checks passed: IDs, columns, exclusions, exports, isolated publishing, rollback, failed-push recovery, actual rename/missing-source/withdrawal orchestration, stale-device protection and fresh-device clone.");
} finally {
  const target = resolve(folder);
  if (!target.startsWith(resolve(tmpdir()))) throw new Error("Invalid temporary cleanup target");
  await rm(target, { recursive: true, force: true });
}
