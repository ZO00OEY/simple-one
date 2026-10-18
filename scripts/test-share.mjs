import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { shareRemoteFixture } from "./share-remote-fixture.mjs";

const require = createRequire(import.meta.url);
const folder = await mkdtemp(join(tmpdir(), "simple-share-test-"));
globalThis.crypto ??= webcrypto;
globalThis.window = { require, setTimeout };
const fixture = `export class TFile { constructor(path) { this.path=path; this.name=path.split('/').pop(); this.extension=this.name.split('.').pop(); this.basename=this.name.slice(0,-this.extension.length-1); } }
export class FileSystemAdapter { constructor(root) { this.root=root; } getBasePath() {return this.root;} }
export class TFolder {constructor(path){this.path=path;}}
export const Platform={isMobile:false};
export const requireApiVersion=()=>true; export const requestUrl=()=>{throw new Error('Unexpected live request in share test');};
export class Component{};export class ItemView{constructor(leaf){this.app=leaf?.app;this.contentEl=leaf?.contentEl;}getState(){return {};}};export class MarkdownView{};export class Menu{};export class Modal{constructor(app){this.app=app;Object.assign(this,globalThis.shareModalElements?.());}open(){this.onOpen?.();}close(){this.onClose?.();}};export class FuzzySuggestModal{};export class Notice{};export class Setting{constructor(parent){if(globalThis.shareSetting)return globalThis.shareSetting(parent);}};export class WorkspaceLeaf{};export const addIcon=()=>{};export const setIcon=()=>{};export const setTooltip=()=>{};export const parseYaml=source=>({share_id:/^share_id: (.+)$/m.exec(source)?.[1]});`;
const plugin = { name: "obsidian-fixture", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" })); build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: fixture, loader: "js" })); } };
async function bundle(source, name) {
  const outfile = join(folder, `${name}.cjs`);
  await esbuild.build({ entryPoints: [source], bundle: true, platform: "node", format: "cjs", outfile, plugins: [plugin], logLevel: "silent" });
  return require(outfile);
}
try {
  const model = await bundle("src/features/share/model.ts", "model");
  const libraries = await bundle("src/features/share/libraries.ts", "libraries");
  const libraryManifest = model.emptyManifest();
  libraryManifest.site = { owner: "owner", repo: "first", branch: "main" };
  libraries.ensureLibraries(libraryManifest);
  libraries.addLibrary(libraryManifest);
  const secondId = libraryManifest.libraries.active;
  assert.deepEqual(libraries.selectedLibraryIds(libraryManifest), ["legacy"], "an unfinished library is not a publishing target");
  libraryManifest.site = { owner: "owner", repo: "second", branch: "main" };
  assert.deepEqual(libraries.selectedLibraryIds(libraryManifest), ["legacy", secondId], "newly connected libraries join the publishing selection");
  model.parseManifest(model.serializeManifest(libraryManifest));
  libraries.removeLibrary(libraryManifest, "legacy");
  assert.equal(libraryManifest.libraries.active, secondId);
  assert.equal(libraryManifest.libraries.default, secondId);
  assert.equal(libraryManifest.site.repo, "second");
  assert.deepEqual(libraries.selectedLibraryIds(libraryManifest), [secondId], "deleting a library removes it from publishing targets");
  model.parseManifest(model.serializeManifest(libraryManifest));
  libraries.removeLibrary(libraryManifest, secondId);
  assert.equal(libraryManifest.libraries.active, "legacy");
  assert.equal(libraryManifest.libraries.default, "legacy");
  assert.equal(libraryManifest.site.repo, "");
  model.parseManifest(model.serializeManifest(libraryManifest));
  for (let mask = 1; mask < 8; mask++) {
    const selected = { title: !!(mask & 1), github: !!(mask & 2), pageOne: !!(mask & 4) };
    const output = model.formatShareContent('标题\n第二行', 'https://example.github.io/notes/', 'https://example.edgeone.dev/', selected);
    assert.equal(output.includes('标题 第二行'), selected.title);
    if (selected.title) assert(output.startsWith('《标题 第二行》'));
    assert.equal(output.includes('https://example.github.io/notes/'), selected.github);
    assert.equal(output.includes('https://example.edgeone.dev/'), selected.pageOne);
    assert.equal(output.includes('GitHub 链接：'), selected.github && selected.pageOne);
    assert.equal(output.includes('EdgeOne Makers 链接：'), selected.github && selected.pageOne);
  }
  assert.throws(() => model.formatShareContent('标题', '', '', { title:false, github:false, pageOne:false }), /至少勾选/);
  assert.equal(model.formatShareContent('标题', '', '', { title:false, github:false, pageOne:true }), '');
  assert.equal(model.formatShareContent('标题', '', 'https://example.edgeone.dev/', { title:true, github:true, pageOne:true }), '《标题》\nhttps://example.edgeone.dev/');
  assert.equal(model.formatShareContent('标题', 'https://example.github.io/notes/', '', { title:true, github:true, pageOne:true }), '《标题》\nhttps://example.github.io/notes/');
  assert.deepEqual(model.DEFAULT_SHARE_COPY_CONTENT, { title:true, github:true, pageOne:true });
  assert.equal(model.normalizeShareDomainUrl('https://share.example.com/notes'), 'https://share.example.com/notes/');
  assert.equal(model.shareDomainNoteUrl('https://share.example.com/notes/', 'abcdefghijkl'), 'https://share.example.com/notes/#/notes/abcdefghijkl');
  assert.throws(() => model.normalizeShareDomainUrl('https://share.example.com/?token=secret'), /不含参数/);
  assert.equal(model.formatShareContent('标题', '', '', model.DEFAULT_SHARE_COPY_CONTENT, [{ name: '备用站点', url: 'https://share.example.com/#/notes/abcdefghijkl' }]), '《标题》\nhttps://share.example.com/#/notes/abcdefghijkl');
  const copyManifest = model.emptyManifest();
  copyManifest.copyContent = { title:false, github:false, pageOne:true };
  copyManifest.customDomains = [{ id: 'domain-1', name: '备用站点', baseUrl: 'https://share.example.com/' }];
  copyManifest.edgeOneDomains = { projectId: 'makers-fixture', domains: [
    { domain: 'notes.example.com', status: 'online' }, { domain: 'backup.example.com', status: 'online' }], selected: ['notes.example.com'] };
  assert.deepEqual(model.parseManifest(model.serializeManifest(copyManifest)).copyContent, copyManifest.copyContent);
  assert.deepEqual(model.parseManifest(model.serializeManifest(copyManifest)).customDomains, copyManifest.customDomains);
  assert.deepEqual(model.parseManifest(model.serializeManifest(copyManifest)).edgeOneDomains, copyManifest.edgeOneDomains, 'per-project custom-domain selection survives reload');
  const columns = await bundle("src/shared/columns.ts", "columns");
  const diff = await bundle("src/features/sync/linkDiff.ts", "diff");
  const exporter = await bundle("src/features/share/export.ts", "export");
  const ids = new Set();
  for (let i = 0; i < 2000; i++) { const id = model.newShareId(ids); assert.match(id, /^[a-z0-9]{12}$/); ids.add(id); }
  assert.equal(ids.size, 2000);
  const legacy = model.emptyManifest();
  legacy.notes.aaaaaaaaaaaa = { enabled: true, sourcePath: 'note.md', category: '', revision: 1, baseIntent: 'obsolete', baseHash: 'obsolete' };
  const migrated = model.parseManifest(model.serializeManifest(legacy));
  assert.equal(migrated.notes.aaaaaaaaaaaa.baseHash, undefined);
  assert.equal(migrated.notes.aaaaaaaaaaaa.baseIntent, undefined);
  assert.throws(() => model.parseManifest("null"));
  assert.throws(() => model.parseManifest('{"version":2}'));
  const mapping = model.emptyManifest();
  mapping.directories = { writing: '写作/人物' };
  mapping.notes.aaaaaaaaaaaa = { enabled: true, sourcePath: 'private.md', category: 'old', directoryCode: 'writing', revision: 1 };
  assert.equal(model.parseManifest(model.serializeManifest(mapping)).notes.aaaaaaaaaaaa.category, '写作/人物');
  for (const path of ['../private', '.obsidian', 'a/../b', 'a\\b', 'bad:name', 'a//b']) assert.throws(() => model.normalizeShareDirectory(path));
  assert.equal(model.managedPath('notes/写作/人物/aaaaaaaaaaaa.md'), true);
  assert.equal(model.managedPath('notes/../aaaaaaaaaaaa.md'), false);
  assert.equal(model.managedPath('notes/.obsidian/aaaaaaaaaaaa.md'), false);
  mapping.notes.aaaaaaaaaaaa.directoryCode = 'missing';
  assert.throws(() => model.parseManifest(model.serializeManifest(mapping)), /不存在/);
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

  const root = join(folder, "vault");
  await mkdir(root); await writeFile(join(root, "private.md"), "private");
  // Share one fixture class between the host adapter and repository module.
  await writeFile(join(folder, "entry.ts"), `export {FileSystemAdapter,TFile,TFolder,Platform} from "obsidian"; export {ShareRepository,websiteFiles} from ${JSON.stringify(resolve("src/features/share/repository.ts"))}; export {ApiShareRepository,FallbackShareRepository} from ${JSON.stringify(resolve("src/features/share/apiRepository.ts"))}; export {default as ShareFeature,ShareView,ShareDirectoryModal} from ${JSON.stringify(resolve("src/features/share/index.ts"))};`);
  const combined = await bundle(join(folder, "entry.ts"), "combined");
  {
    let probes = 0;
    const host = { manifest: { id: 'fixture' }, app: { secretStorage: { getSecret: () => 'fixture-token' } }, sync: { exec: async (_program, args) => { probes++; return args[0] === 'api' ? 'fixture-user' : 'gh version'; } } };
    const desktop = new combined.ShareFeature(host);
    assert(await desktop.repository() instanceof combined.FallbackShareRepository);
    assert.equal(desktop.backend, 'cli');
    assert.equal(probes, 2, 'desktop probes CLI authentication and GitHub API access');
    await desktop.repository(); assert.equal(probes, 4, 'CLI availability is verified again for each repository operation');
    combined.Platform.isMobile = true;
    try {
      const mobile = new combined.ShareFeature(host);
      assert(await mobile.repository() instanceof combined.ApiShareRepository);
      assert.equal(probes, 4, 'mobile never probes or executes CLI');
    } finally { combined.Platform.isMobile = false; }
    const missing = new combined.ShareFeature({ ...host, sync: { exec: async () => { throw new Error('CLI not installed'); } } });
    assert(await missing.repository() instanceof combined.ApiShareRepository);
    assert.equal(missing.backend, 'api');
  }
  // Exercise authorization selection through DOM events, without real credentials.
  const dom = new JSDOM("<body><main></main></body>");
  globalThis.DOMParser = dom.window.DOMParser;
  const templates = await bundle("src/features/share/template.ts", "template");
  const defaultTemplate = '<!doctype html><html><head><title>分享笔记</title><style data-simple-reader-style>body{color:black}</style><style data-simple-appearance></style></head><body><h1 id="note-title"></h1><input id="search"><nav id="note-list"></nav><article id="content"></article><script data-simple-reader>window.reader=true;</script></body></html>';
  templates.validateShareTemplate(defaultTemplate);
  {
    const calls = [];
    const prefix = '.obsidian/plugins/simple-one/';
    const selection = prefix + templates.TEMPLATE_SELECTION_FILE;
    const adapter = {
      exists: async path => path === selection,
      read: async path => { calls.push(path); assert.equal(path, selection); return '{"file":"custom-test.html"}'; },
      list: async () => ({ files: [prefix + 'custom-test.html'], folders: [] })
    };
    const workspace = { on: () => ({}), onLayoutReady: () => {}, getLeavesOfType: () => [] };
    const host = {
      manifest: { id: 'simple-one' },
      app: { vault: { configDir: '.obsidian', adapter, on: () => ({}) }, workspace, metadataCache: { on: () => ({}) } },
      sync: { exec: async () => { assert.fail('startup must not probe GitHub authorization'); } },
      registerEvent() {}, register() {}, registerView() {}, addCommand() {}, registerInterval() {}
    };
    const feature = new combined.ShareFeature(host);
    feature.edgeone.load = async () => {};
    feature.registerEvent = feature.register = () => {};
    const interval = globalThis.window.setInterval;
    globalThis.window.setInterval = () => 1;
    try { await feature.initialize(); } finally { globalThis.window.setInterval = interval; }
    assert.equal(feature.template, '', 'startup does not load or parse HTML');
    assert.equal(feature.templateFile, 'custom-test.html', 'saved selection remains visible');
    assert.equal(feature.templateFiles['custom-test.html'], 'custom-test.html');
    assert.deepEqual(calls, [selection], 'startup reads only lightweight template metadata');
    adapter.read = async path => {
      calls.push(path);
      return path === selection ? '{"file":"custom-test.html"}' : defaultTemplate;
    };
    assert.equal(await feature.readTemplate(), defaultTemplate, 'first template use loads and validates it');
    adapter.read = async path => path === selection ? '{"file":"custom-test.html"}' : '<html><body>broken</body></html>';
    await assert.rejects(feature.readTemplate(), /content/, 'invalid templates still fail when used');
    console.log('Share startup: no authentication probe or HTML read; saved template selection and lazy validation passed.');
  }
  {
    const prefix = '.obsidian/plugins/simple-one/';
    const installed = new Map(['main.js', 'manifest.json', 'styles.css'].map(name => [prefix + name, 'installed']));
    const adapter = { exists: async path => installed.has(path), read: async path => installed.get(path), write: async (path, value) => { installed.set(path, value); } };
    const freshInstall = new combined.ShareFeature({ manifest: { id: 'simple-one' }, app: { vault: { configDir: '.obsidian', adapter } } });
    assert.equal(await freshInstall.readDefaultTemplate(), await readFile('default.html', 'utf8'), 'market installation restores the bundled default HTML without network access');
    assert.equal(installed.get(prefix + 'reader-licenses.txt'), await readFile('reader-licenses.txt', 'utf8'), 'market installation includes reader licenses');
    installed.set(prefix + 'default.html', defaultTemplate);
    assert.equal(await freshInstall.readDefaultTemplate(), defaultTemplate, 'existing default HTML edits are preserved');
    installed.set(prefix + 'default.html', '<html><body>broken template</body></html>');
    await assert.rejects(freshInstall.readDefaultTemplate(), /content/);
    assert.equal(installed.get(prefix + 'default.html'), '<html><body>broken template</body></html>', 'invalid existing templates are reported without overwriting user content');
    console.log('Community installation: three standard files restore HTML and licenses offline; existing templates are preserved.');
  }
  assert.throws(() => templates.validateShareTemplate(defaultTemplate.replace('id="content"', 'id="missing-content"')), /content/);
  assert.throws(() => templates.validateShareTemplate(defaultTemplate.replace('<script data-simple-reader>window.reader=true;</script>', '')), /reader\/app.js/);
  assert.throws(() => templates.validateShareTemplate(defaultTemplate.replace('</head>', '<base href="https://example.com"></head>')), /base/);
  const proto = dom.window.HTMLElement.prototype;
  proto.createEl = function(tag, options = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    if (options.href) element.setAttribute('href', options.href);
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    this.append(element); return element;
  };
  proto.createDiv = function(options) { return this.createEl("div", options); };
  proto.createSpan = function(options) { return this.createEl("span", options); };
  proto.empty = function() { this.replaceChildren(); };
  proto.setText = function(text) { this.textContent = text; };
  proto.addClass = function(...names) { this.classList.add(...names); };
  proto.toggleClass = function(name, enabled) { this.classList.toggle(name, enabled); };
  globalThis.shareSetting = parent => {
    const setting = { settingEl: parent.createDiv({ cls: "setting-item" }) };
    setting.infoEl = setting.settingEl.createDiv({ cls: "setting-item-info" });
    setting.nameEl = setting.infoEl.createDiv({ cls: "setting-item-name" }); setting.descEl = setting.infoEl.createDiv({ cls: "setting-item-description" });
    setting.controlEl = setting.settingEl.createDiv({ cls: "setting-item-control" });
    setting.setName = text => { setting.nameEl.textContent = text; return setting; };
    setting.setDesc = text => { setting.descEl.textContent = text; return setting; };
    setting.setHeading = () => setting;
    setting.setClass = cls => { setting.settingEl.addClass(cls); return setting; };
    setting.addToggle = configure => {
      const toggleEl = setting.controlEl.createEl("input"); toggleEl.type = "checkbox";
      const control = { setValue(value) { toggleEl.checked = value; return this; }, setDisabled(value) { toggleEl.disabled = value; return this; }, onChange(callback) { toggleEl.addEventListener("change", () => callback(toggleEl.checked)); return this; } };
      configure(control); return setting;
    };
    setting.addDropdown = configure => {
      const selectEl = setting.settingEl.createEl("select");
      const control = { selectEl, addOption(value, text) { selectEl.createEl("option", { text, attr: { value } }); return this; }, addOptions(options) { for (const [value, text] of Object.entries(options)) this.addOption(value, text); return this; }, setValue(value) { selectEl.value = value; return this; }, setDisabled(value) { selectEl.disabled = value; return this; }, onChange(callback) { selectEl.addEventListener("change", () => callback(selectEl.value)); return this; } };
      configure(control); return setting;
    };
    setting.addText = configure => {
      const inputEl = setting.settingEl.createEl("input");
      const control = { inputEl, setValue(value) { inputEl.value = value; return this; }, setPlaceholder(value) { inputEl.placeholder = value; return this; }, onChange(callback) { inputEl.addEventListener("input", () => callback(inputEl.value)); return this; } };
      configure(control); return setting;
    };
    setting.addSearch = setting.addText;
    setting.addButton = configure => {
      const buttonEl = setting.controlEl.createEl("button");
      const control = { buttonEl, setButtonText(text) { buttonEl.textContent = text; return this; }, setIcon(value) { buttonEl.dataset.icon = value; return this; }, setTooltip(value) { buttonEl.title = value; return this; }, setDisabled(value) { buttonEl.disabled = value; return this; }, setCta() { return this; }, onClick(callback) { buttonEl.addEventListener("click", callback); return this; } };
      configure(control); return setting;
    };
    return setting;
  };
  try {
    const uiCalls = [];
    let savedLayouts = 0;
    const ui = new combined.ShareFeature({ manifest: { id: 'fixture' }, app: { secretStorage: { setSecret() {}, getSecret: () => 'fixture-secret' }, vault: { getName: () => "fixture" }, workspace: { getLeavesOfType: () => [], requestSaveLayout() { savedLayouts++; } } }, sync: { exec: async (program, args, _auth, _trim, _timeout, output, stdin, signal) => {
      uiCalls.push({ program, args, stdin });
      if (args.includes("--web")) {
        output("First copy your one-time code: ABCD-1234");
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Authorization cancelled")), { once: true }));
      }
      return args[0] === "api" ? JSON.stringify({ login: "fixture" }) : "ok";
    } } });
    ui.manifest.notes = { fixture: {} };
    ui.host.app.vault.configDir = ".obsidian";
    ui.host.app.vault.getMarkdownFiles = () => Array.from({ length: 401 }, (_, index) => ({ path: `${index}.md` }));
    ui.host.app.metadataCache = { getFileCache: () => undefined };
    const scanTimer = globalThis.window.setTimeout;
    globalThis.window.setTimeout = () => { throw new Error("Repository scanning must not wait for a throttled timer."); };
    try { assert.equal((await ui.scanIndex()).size, 0); }
    finally { globalThis.window.setTimeout = scanTimer; ui.manifest.notes = {}; }
    const rootEl = dom.window.document.querySelector("main");
    ui.change = async edit => { edit(ui.manifest); };
    const click = text => { const button = [...rootEl.querySelectorAll("button")].find(element => element.textContent === text); assert(button, text); button.click(); };
    const settle = async () => { for (let attempt = 0; ui.setupBusy && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(ui.setupBusy, false); };
    ui.renderSettings(rootEl, true, false);
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-progress-label"), null);
    assert(rootEl.querySelector(".simple-one-sync-setup-status").textContent.includes("尚未添加分享库"));
    assert.equal(rootEl.querySelector(".simple-page-title"), null);
    assert.equal(rootEl.querySelectorAll(".simple-one-sync-setup-nav__step").length, 4);
    assert.equal(rootEl.querySelectorAll(".simple-one-sync-setup-nav__step")[1].disabled, true);
    assert.equal(rootEl.querySelector(".simple-share-library-selector select option").textContent, "新仓库");
    assert([...rootEl.querySelectorAll("button")].some(button => button.textContent === "新建仓库"));
    assert.equal(rootEl.querySelector("input"), null, "credentials shown only for selected method");
    assert.equal(rootEl.querySelector('.simple-share-guide-body > .setting-item-heading'), null, 'step navigation supplies the card title');
    assert.equal(rootEl.querySelector('.simple-one-sync-setup-badge'), null);
    assert(rootEl.querySelector('.simple-share-guide-auth-sections'));
    assert.equal(rootEl.querySelector('.simple-share-guide-auth-choice'), null, 'accent line appears only after choosing an authorization method');
    assert(rootEl.textContent.includes("安装工具"));
    assert(rootEl.textContent.includes("手机端或未安装 CLI 时使用 GitHub token。"));
    assert(rootEl.textContent.includes("授权 Simple One 访问 GitHub"));
    click("Token 授权");
    assert(rootEl.querySelector('.simple-share-guide-auth-choice .simple-one-sync-setup-token-setting'));
    const input = rootEl.querySelector("input"); assert.equal(input.type, "password");
    input.value = "fixture-secret"; input.dispatchEvent(new dom.window.Event("input"));
    click("已填写 token，验证授权"); await settle();
    assert.equal(ui.guideStep, 2, ui.error); assert.equal(ui.token, "");
    assert.equal(uiCalls.find(call => call.args.includes("--with-token")).stdin, "fixture-secret\n");
    assert.equal(rootEl.querySelector(".simple-page-title"), null, "async re-render preserves shared header");
    rootEl.querySelector(".simple-one-sync-setup-nav__step").click();
    assert.equal(rootEl.querySelector("input").value, "");
    click("验证已有授权"); await settle(); assert.equal(ui.guideStep, 2);
    rootEl.querySelector(".simple-one-sync-setup-nav__step").click();
    click("浏览器登录授权");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(rootEl.querySelector('.simple-share-guide-auth-choice .simple-one-sync-setup-device-action'));
    assert(rootEl.textContent.includes("ABCD-1234"));
    assert.equal(rootEl.querySelector("input"), null);
    assert([...rootEl.querySelectorAll(".simple-one-sync-setup-option")].every(button => button.disabled));
    click("取消授权等待"); await settle(); assert.equal(ui.guideStep, 1);
    assert.equal(ui.authController.signal.aborted, true);
    ui.manifest.site = { owner: "fixture", repo: "notes-share", branch: "main", initialized: true };
    ui.error = ""; ui.renderSettings(rootEl, true, false);
    assert(rootEl.querySelector(".simple-one-sync-setup-status").textContent.includes("当前库已验证成功"));
    assert.equal(rootEl.querySelectorAll(".simple-one-sync-setup-nav__step.is-done").length, 4);
    assert([...rootEl.querySelectorAll(".simple-one-sync-setup-nav__step")].every(button => !button.disabled));
    const librarySelect = rootEl.querySelector(".simple-share-library-selector select");
    librarySelect.value = ""; librarySelect.dispatchEvent(new dom.window.Event("change"));
    assert(rootEl.textContent.includes("准备新建分享仓库"));
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-nav"), null, "new-library selection waits for the create action");
    const originalNewLibrary = ui.newLibrary;
    let newLibraryRequested = false;
    ui.newLibrary = async () => { newLibraryRequested = true; };
    click("新建仓库");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(newLibraryRequested, true);
    ui.newLibrary = originalNewLibrary;
    ui.guideNewLibrarySelected = false; ui.renderSettings(rootEl, true, false);
    const connectedSite = { ...ui.manifest.site };
    ui.host.app.vault.adapter = { write: async () => {} };
    click("重新运行此库引导");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(ui.guideStep, 1); assert.equal(ui.guideAvailableStep, 1);
    assert.deepEqual(ui.manifest.site, { ...connectedSite, guideProgress: 1 }, "rechecking preserves the repository while saving the restarted progress");
    const restored = new combined.ShareFeature(ui.host);
    restored.manifest = model.parseManifest(model.serializeManifest(ui.manifest));
    restored.renderSettings(rootEl, true, false);
    assert.equal(rootEl.querySelectorAll(".simple-one-sync-setup-nav__step")[1].disabled, true, "explicit restart survives reloading");
    ui.guideStep = 2; ui.guideAvailableStep = 2; ui.repoMode = "create";
    ui.manifest.site.guideProgress = 2;
    ui.draftName = "notes-share";
    ui.createRepository = async name => {
      assert.equal(name, "notes-share");
      ui.takenRepository = { owner: "fixture", name };
      throw new Error(`仓库名称已被使用：fixture/${name}。`);
    };
    ui.renderSettings(rootEl, true, false);
    assert.equal(rootEl.querySelector(".simple-share-repository-content .setting-item-heading"), null, "choice buttons provide the repository mode heading");
    assert(rootEl.textContent.includes("可自定义名称，留空使用 fixture-share。"));
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-repo-name .setting-item-name").textContent, "");
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-repo-name input").getAttribute("aria-label"), "新仓库名称");
    click("创建分享仓库"); await settle();
    assert.equal(ui.repoMode, "existing"); assert.equal(ui.draftRepo, "https://github.com/fixture/notes-share");
    assert.equal(ui.guideStep, 2, "a name collision stays on the repository step");
    assert.equal(ui.takenRepository, undefined);
    assert.equal(rootEl.querySelector(".simple-share-repository-content .setting-item-heading"), null);
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-repo-url .setting-item-name").textContent, "");
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-repo-url input").getAttribute("aria-label"), "GitHub 仓库地址");
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-repo-url input").value, ui.draftRepo, "the existing-repository form is shown with the detected URL prefilled");
    assert.equal(rootEl.querySelector(".simple-share-repo-private-option input").checked, false, "existing repositories are made public by default");
    assert(rootEl.textContent.includes("连接后，分享仓库将设为公开，任何人都可以查看其内容"));
    assert(rootEl.querySelector(".simple-share-repository-visibility-note .simple-share-edgeone-area-note__icon"));
    assert(!rootEl.textContent.includes("无法使用 GitHub Pages 发布"));
    const verifyFeedback = rootEl.querySelector(".simple-share-repo-feedback");
    assert(verifyFeedback.textContent.includes("已切换到「使用已有分享仓库」"));
    assert.equal(verifyFeedback.querySelectorAll("li").length, 0);
    assert(rootEl.querySelector(".simple-share-repository-content .simple-one-sync-setup-action").textContent.includes("连接已有仓库"));
    const [github, repository, change] = [ui.github, ui.repository, ui.change];
    let madePublic = false;
    const publicCalls = [];
    ui.github = async (path, method, body) => {
      publicCalls.push({ path, method, body });
      if (method === "PATCH") { madePublic = true; return JSON.stringify({ private: false }); }
      return JSON.stringify({ default_branch: "main", private: !madePublic });
    };
    ui.repository = async () => ({ verify: async () => {} });
    ui.change = async (edit, refresh) => { assert.equal(refresh, false, "repository connection must not wait for the note scan"); edit(ui.manifest); };
    try { click("连接已有仓库"); await settle(); }
    finally { ui.github = github; ui.repository = repository; ui.change = change; }
    assert.equal(ui.guideStep, 3, ui.error);
    assert.deepEqual(publicCalls.find(call => call.method === "PATCH"),
      { path: "repos/fixture/notes-share", method: "PATCH", body: { private: false } });
    assert.equal(madePublic, true, "the repository is confirmed public before the connection is saved");
    ui.guideStep = 2; ui.repoMode = "existing"; ui.renderSettings(rootEl, true, false);
    const privateCheckbox = rootEl.querySelector(".simple-share-repo-private-option input");
    assert.equal(privateCheckbox.checked, false);
    privateCheckbox.click();
    assert.equal(privateCheckbox.checked, true);
    assert(rootEl.textContent.includes("连接后，分享仓库将设为私有，无法使用 GitHub Pages 发布；需接入其他发布方式"));
    assert(!rootEl.textContent.includes("任何人都可以查看其内容"));
    let privateState = false;
    const privateCalls = [];
    ui.github = async (path, method, body) => {
      privateCalls.push({ path, method, body });
      if (method === "PATCH") { privateState = true; return JSON.stringify({ private: true }); }
      return JSON.stringify({ default_branch: "main", private: privateState });
    };
    ui.repository = async () => ({ verify: async () => {} });
    ui.change = async (edit, refresh) => { assert.equal(refresh, false); edit(ui.manifest); };
    try { click("连接已有仓库"); await settle(); }
    finally { ui.github = github; ui.repository = repository; ui.change = change; }
    assert.equal(ui.guideStep, 3, ui.error);
    assert.deepEqual(privateCalls.find(call => call.method === "PATCH"),
      { path: "repos/fixture/notes-share", method: "PATCH", body: { private: true } });
    assert.equal(privateState, true, "repository privacy is re-read after the update");
    assert(!rootEl.textContent.includes("已确认为私有"), "the next step does not reuse the previous visibility choice as a result");
    ui.guideStep = 2; ui.repoMode = "existing"; ui.makeExistingRepositoryPrivate = false;
    ui.github = async (_path, method) => {
      if (method === "PATCH") throw new Error("admin permission denied");
      return JSON.stringify({ default_branch: "main", private: true });
    };
    ui.repository = async () => ({ verify: async () => {} });
    ui.change = async () => { throw new Error("failed visibility update must not save the connection"); };
    try { await assert.rejects(ui.bind("fixture", "notes-share"), /未能将仓库.*设为公开/); }
    finally { ui.github = github; ui.repository = repository; ui.change = change; }
    assert.equal(ui.guideStep, 2);
    ui.github = async (_path, method) => JSON.stringify({ default_branch: "main", private: true });
    ui.repository = async () => ({ verify: async () => {} });
    ui.change = async () => { throw new Error("unconfirmed public repository must not be saved"); };
    try { await assert.rejects(ui.bind("fixture", "notes-share"), /尚未确认仓库.*已设为公开/); }
    finally { ui.github = github; ui.repository = repository; ui.change = change; }
    ui.guideStep = 2;
    ui.github = async (_path, method) => {
      if (method === "PATCH") throw new Error("admin permission denied");
      return JSON.stringify({ default_branch: "main", private: false });
    };
    ui.repository = async () => ({ verify: async () => {} });
    ui.change = async () => { throw new Error("failed visibility update must not save the connection"); };
    try { await assert.rejects(ui.bind("fixture", "notes-share", true), /未能将仓库.*设为私有/); }
    finally { ui.github = github; ui.repository = repository; ui.change = change; }
    assert.equal(ui.guideStep, 2);
    ui.error = ""; ui.guideStep = 3; ui.guideAvailableStep = 3;
    ui.manifest.site.guideProgress = 3;
    ui.renderSettings(rootEl, true, false);
    assert.equal(rootEl.querySelector('.simple-share-guide-body > .setting-item-heading'), null);
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-option.is-selected"), null);
    assert.equal(rootEl.querySelector(".simple-one-sync-setup-platform-content"), null);
    assert(rootEl.textContent.includes("分享仓库须公开（非原笔记仓库），通过 GitHub Pages 地址访问"));
    assert(rootEl.textContent.includes("再接入 EdgeOne Makers：分享仓库可保持私有，网站通过 EdgeOne 发布"));
    const edgeVisibilityGithub = ui.github;
    const edgeVisibilityChecks = [];
    ui.github = async path => { edgeVisibilityChecks.push(path); return JSON.stringify({ private: true }); };
    click("接入 EdgeOne Makers");
    await settle();
    ui.status = "正在读取云端文件清单…";
    ui.renderSettings(rootEl, true, false);
    assert.equal(rootEl.querySelector(".simple-share-guide-footer-status")?.textContent, "正在读取云端文件清单…",
      "EdgeOne progress appears beside the lower action");
    assert(!rootEl.querySelector(".simple-share-guide-body > p[role=status]"), "EdgeOne progress is not repeated above the choices");
    ui.status = "";
    ui.renderSettings(rootEl, true, false);
    const edgeFooterButton = () => rootEl.querySelector(".simple-share-guide-footer button");
    assert.equal(edgeFooterButton()?.disabled, true, "the guide action is disabled before project verification");
    const priorEdgeState = ui.edgeone.state;
    ui.edgeone.state = { version: 1, step: 2, repo: "fixture/notes-share", branch: "main",
      projectId: "pages-fixture", completed: true };
    ui.edgeone.projectCheckDone = true;
    ui.renderSettings(rootEl, true, false);
    assert.equal(edgeFooterButton()?.disabled, true, "a previous successful deployment cannot enable this visit's action");
    assert(!edgeFooterButton()?.textContent.includes("重新验证"), "the previous completion does not flash a retry label");
    ui.status = "内容未变化，正在检查网站部署…";
    ui.busy = true;
    ui.edgeone.state.lastCheck = { kind: "pending", text: "最近一次分享正在部署，请稍后检查。", commit: "abc123", checkedAt: Date.now() };
    ui.renderSettings(rootEl, true, false);
    assert(!rootEl.querySelector(".simple-share-guide-footer-status"), "linked deployment progress is not duplicated beside the button");
    ui.busy = false; ui.status = "";
    ui.setupBusy = true;
    ui.renderSettings(rootEl, true, false);
    assert.equal(edgeFooterButton()?.disabled, true, "automatic verification keeps the action disabled");
    assert(edgeFooterButton()?.textContent.includes("正在验证"));
    ui.setupBusy = false;
    ui.edgeOneGuideAttemptFailed = true;
    ui.renderSettings(rootEl, true, false);
    assert.equal(edgeFooterButton()?.disabled, false, "the retry action is enabled only after this visit fails");
    ui.edgeOneGuideAttemptFailed = false;
    ui.edgeone.projectCheckDone = false;
    ui.edgeone.state = priorEdgeState;
    ui.renderSettings(rootEl, true, false);
    assert(!edgeVisibilityChecks.includes("repos/fixture/notes-share"), "entering EdgeOne does not inspect repository visibility before deployment fails");
    ui.edgeOneDeploymentFailed = true;
    ui.renderSettings(rootEl, true, false);
    await settle();
    assert(edgeVisibilityChecks.includes("repos/fixture/notes-share"), "a failed EdgeOne deployment triggers the repository visibility check");
    ui.edgeOneDeploymentFailed = false;
    ui.guideVisibilityAttemptedKey = "";
    edgeVisibilityChecks.length = 0;
    ui.edgeone.projectCreationFailed = true;
    ui.renderSettings(rootEl, true, false);
    await settle();
    assert(edgeVisibilityChecks.includes("repos/fixture/notes-share"), "a failed project creation also checks the actual repository visibility");
    ui.edgeone.projectCreationFailed = false;
    ui.github = edgeVisibilityGithub;
    ui.renderSettings(rootEl, true, false);
    assert(rootEl.querySelector(".simple-share-edgeone-guide"));
    assert(rootEl.textContent.includes("授权 Simple One 管理 EdgeOne Makers"));
    assert(!rootEl.textContent.includes("先授权 Simple One 管理 EdgeOne Makers，再授权 EdgeOne Makers 访问分享仓库并关联项目。"));
    assert.equal(rootEl.querySelector(".simple-share-edgeone-auth-options"), null);
    assert(!rootEl.textContent.includes("确认当前分享仓库"));
    assert(!rootEl.textContent.includes("打开腾讯项目页，连接 GitHub"), "GitHub authorization follows Tencent API Token verification");
    assert(rootEl.textContent.includes("创建 EdgeOne Makers API Token"), "missing saved authorization immediately shows the token setup");
    click("仅使用 GitHub Pages"); await settle();
    assert.equal(ui.guideStep, 4);
    assert.equal(ui.manifest.site.hosting, "github");
    assert.deepEqual(ui.copyContent, { title: true, github: true, pageOne: true });
    assert.equal(ui.edgeone.authMode, null, "choosing GitHub Pages clears the EdgeOne authorization choice");
    const visibilityGithub = ui.github;
    const checkVisibility = async isPrivate => {
      ui.github = async () => JSON.stringify({ private: isPrivate });
      ui.guideVisibilityAttemptedKey = "";
      ui.renderSettings(rootEl, true, false);
      for (let attempt = 0; ui.guideVisibilityChecking && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(ui.guideVisibilityChecking, false);
    };
    await checkVisibility(false);
    assert(rootEl.textContent.includes("GitHub 分享仓库状态：公开"));
    assert([...rootEl.querySelectorAll("button")].some(button => button.textContent === "初始化网站并完成"));
    await checkVisibility(true);
    assert(rootEl.textContent.includes("GitHub 分享仓库状态：私有"));
    assert(rootEl.textContent.includes("仓库内所有内容将可被任何人查看"));
    assert([...rootEl.querySelectorAll("button")].some(button => button.textContent === "公开分享仓库并初始化网站"));
    assert(!rootEl.textContent.includes("在 GitHub 检查或补充 EdgeOne 仓库授权"), "GitHub-only flow skips EdgeOne authorization reminder");
    let repoIsPrivate = true;
    const visibilityCalls = [];
    ui.github = async (path, method, body) => {
      visibilityCalls.push({ path, method, body });
      if (method === "PATCH") { repoIsPrivate = false; return JSON.stringify({ private: false }); }
      return JSON.stringify({ private: repoIsPrivate });
    };
    await ui.ensureGuideGithubPagesPublic();
    assert.deepEqual(visibilityCalls.find(call => call.method === "PATCH"),
      { path: "repos/fixture/notes-share", method: "PATCH", body: { private: false } });
    assert.equal(repoIsPrivate, false);
    assert(rootEl.textContent.includes("已自动将分享仓库 fixture/notes-share 设为公开"));
    ui.manifest.site.guideProgress = 7; ui.guideStep = 4; ui.renderSettings(rootEl, true, false);
    assert(rootEl.textContent.includes("为使用 GitHub Pages，已自动将当前分享仓库设为公开"));
    assert(rootEl.textContent.includes("分享网站已发布"));
    assert([...rootEl.querySelectorAll("button")].some(button => button.textContent === "完成并返回分享管理"));
    assert.equal(rootEl.querySelectorAll(".simple-one-sync-setup-nav__step").length, 4);
    ui.manifest.site.guideProgress = 4;
    repoIsPrivate = true;
    ui.guideVisibility = { key: "fixture/notes-share", private: true };
    ui.guideVisibilityChangedKey = "";
    ui.github = async (_path, method) => {
      if (method === "PATCH") throw new Error("admin permission denied");
      return JSON.stringify({ private: true });
    };
    await assert.rejects(ui.ensureGuideGithubPagesPublic(), /未能自动公开分享仓库/);
    assert.equal(ui.guideVisibility.private, true, "a failed visibility update is never reported as public");
    const previousEdgeoneState = ui.edgeone.state;
    ui.manifest.site.hosting = "edgeone";
    ui.edgeone.state = { version: 1, step: 3, repo: "fixture/notes-share", branch: "main", projectId: "edgeone-fixture", projectName: "notes-share", area: "global", completed: true };
    await checkVisibility(true);
    assert(rootEl.textContent.includes("当前分享仓库为私有，GitHub Pages 页面不可用"));
    assert(rootEl.textContent.includes("项目 notes-share 本次 Git 部署成功"));
    assert(rootEl.textContent.includes("有效期 3 小时"));
    assert(rootEl.textContent.includes("未绑定自定义域名时，需从") && !rootEl.textContent.includes("中国大陆访问"));
    assert(rootEl.querySelector('a[href="https://console.cloud.tencent.com/edgeone/pages/project/edgeone-fixture"]')?.textContent === '项目概览 ↗', 'guide result links directly to the project overview');
    assert(rootEl.textContent.includes("查看 EdgeOne 项目及构建日志"));
    assert([...rootEl.querySelectorAll("button")].some(button => button.textContent === "完成并返回分享管理"), "EdgeOne deployment finishes on guide step four");
    const openAfterEdgeOne = ui.open;
    let returnedToShareManagement = false;
    ui.open = async closeSettings => { returnedToShareManagement = closeSettings; };
    click("完成并返回分享管理"); await settle();
    assert.equal(ui.manifest.site.guideProgress, 7);
    assert.equal(ui.guideStep, 4);
    assert.equal(returnedToShareManagement, true);
    ui.open = openAfterEdgeOne;
    ui.manifest.site.guideProgress = 4;
    ui.github = async path => path.endsWith("/pages")
      ? JSON.stringify({ html_url: "https://fixture.github.io/notes-share/", status: "built" })
      : JSON.stringify({ private: false });
    ui.guideVisibilityAttemptedKey = "";
    ui.guidePagesAttemptedKey = "";
    ui.renderSettings(rootEl, true, false);
    for (let attempt = 0; (ui.guideVisibilityChecking || ui.guidePagesChecking || !ui.guidePages) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(rootEl.textContent.includes("GitHub Pages 已发布"));
    assert(rootEl.textContent.includes("https://fixture.github.io/notes-share/"));
    ui.github = async path => {
      if (path.endsWith("/pages")) throw new Error("GitHub HTTP 404：Not Found");
      return JSON.stringify({ private: false });
    };
    ui.guidePagesAttemptedKey = "";
    ui.renderSettings(rootEl, true, false);
    for (let attempt = 0; ui.guidePagesChecking && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(rootEl.textContent.includes("GitHub Pages 尚未启用"));
    assert(!rootEl.textContent.includes("fixture.github.io/notes-share/"));
    ui.edgeone.state = { ...ui.edgeone.state, area: "overseas" };
    ui.renderSettings(rootEl, true, false);
    assert(rootEl.textContent.includes("不提供中国大陆节点加速"));
    assert(!rootEl.textContent.includes("有效期 3 小时"));
    ui.github = async () => { throw new Error("visibility unavailable"); };
    ui.guideVisibilityAttemptedKey = "";
    ui.renderSettings(rootEl, true, false);
    for (let attempt = 0; ui.guideVisibilityChecking && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(rootEl.textContent.includes("暂时无法确认分享仓库及 GitHub Pages 状态"));
    ui.edgeone.state = previousEdgeoneState;
    ui.manifest.site.hosting = "github";
    ui.github = visibilityGithub;
    const layout = new combined.ShareFeature({ sync: { isSyncing: () => false } });
    const firstId = "aaaaaaaaaaaa", secondId = "bbbbbbbbbbbb", withdrawnId = "cccccccccccc";
    layout.manifest.notes = {
      [firstId]: { enabled: true, sourcePath: "本地/子目录/甲.md", category: "公开/专栏", publicName: "公开甲", revision: 1 },
      [secondId]: { enabled: true, sourcePath: "本地/乙.md", category: "公开", revision: 1 },
      [withdrawnId]: { enabled: false, sourcePath: "旧/撤下.md", category: "旧公开", revision: 1 }
    };
    layout.rows = [{ id: firstId, title: "甲", state: "已发布" }, { id: secondId, title: "乙", state: "待发布" }, { id: withdrawnId, title: "旧记录", state: "未分享" }];
    const collapsed = new Set(["source:/本地"]);
    layout.renderPanel(rootEl, "", false, "source", collapsed);
    assert.equal(rootEl.querySelectorAll("details").length, 3);
    assert.equal(rootEl.querySelector("details").open, false);
    assert.equal(rootEl.querySelectorAll(".simple-share-note-row").length, 3);
    assert(rootEl.querySelector("details details .simple-share-note-row").textContent.includes("甲"));
    layout.renderPanel(rootEl, "甲", false, "source", collapsed);
    assert([...rootEl.querySelectorAll("details")].every(element => element.open), "search reveals matching nested notes");
    assert(collapsed.has("source:/本地"), "search preserves normal folder collapse state");
    layout.renderPanel(rootEl, "", false, "public", collapsed);
    assert(rootEl.querySelector("details details .simple-share-note-row").textContent.includes("公开甲"));
    assert(rootEl.textContent.includes('旧记录'), 'legacy disabled records remain manageable without a withdrawal setting');
    assert.equal(rootEl.querySelectorAll('button[data-icon="eye"], button[data-icon="eye-off"]').length, 0);
    layout.renderPanel(rootEl, "", false);
    assert.equal(rootEl.querySelector("details"), null, "default layout is flat");
    assert([...rootEl.querySelectorAll(".simple-share-note-row .setting-item-description")].every(element => element.hidden), "paths are hidden by default");
    const ascendingNames = [...rootEl.querySelectorAll(".simple-share-note-row")].map(element => element.children[0].textContent);
    layout.renderPanel(rootEl, "", false, "list", collapsed, undefined, true);
    assert.deepEqual([...rootEl.querySelectorAll(".simple-share-note-row")].map(element => element.children[0].textContent), ascendingNames.toReversed(), "descending reverses the visible filename order");
    layout.manifest.notes[firstId].publicName = "Z public";
    layout.manifest.notes[secondId].publicName = "A public";
    layout.renderPanel(rootEl, "", false, "public");
    const publicFolder = [...rootEl.querySelectorAll("details")].find(element => element.querySelector(":scope > summary").textContent === "公开");
    assert(publicFolder.querySelector(":scope > .simple-share-folder-body > .simple-share-note-row").textContent.includes("A public"));
    const openedNotes = [];
    const numericSearch = new combined.ShareFeature({ sync: { isSyncing: () => false } });
    numericSearch.rows = [{ id: firstId, title: '笔记', state: '已发布', file: { path: '目录1/笔记.md', parent: { path: '目录1' } } }, { id: secondId, title: '未命名 1', state: '已发布' }];
    numericSearch.renderPanel(rootEl, '1', false);
    assert.equal(rootEl.querySelectorAll('.simple-share-note-row').length, 1, 'hidden directory digits do not match title search');
    assert(rootEl.textContent.includes('未命名 1'));
    numericSearch.renderPanel(rootEl, '1', true);
    assert.equal(rootEl.querySelectorAll('.simple-share-note-row').length, 2, 'visible paths remain searchable');
    const panel = new combined.ShareFeature({ app: { workspace: { getLeavesOfType: () => [], requestSaveLayout() {}, getLeaf: () => ({ openFile: async file => openedNotes.push(file.path) }) } }, sync: { isSyncing: () => false } });
    panel.manifest = structuredClone(layout.manifest); panel.rows = layout.rows.filter(row => row.id !== withdrawnId);
    panel.rows[0] = { ...panel.rows[0], file: { path: '甲.md', parent: { path: '' } } };
    panel.manifest.site = { owner: 'fixture', repo: 'share', branch: 'main' };
    const view = new combined.ShareView({ app: panel.host.app, contentEl: rootEl }, panel);
    view.render();
    assert(rootEl.querySelector('.simple-share-header button').classList.contains('simple-share-edit'), 'tools start at the left of the top toolbar');
    assert.equal(rootEl.querySelector('.simple-share-header button:last-child').textContent, '切换同步', 'sync switch ends the toolbar');
    assert.equal(rootEl.querySelector('.simple-share-header').nextElementSibling.className, 'setting-item simple-share-publish-row');
    assert.equal(rootEl.querySelector('.simple-share-publish-row').nextElementSibling.className, 'setting-item simple-share-search');
    assert.equal(rootEl.querySelector('.simple-share-publish-row button').textContent, '推送新分享');
    assert(rootEl.querySelector('.simple-share-publish-row button').classList.contains('simple-share-new'));
    assert(rootEl.querySelector('.simple-share-publish-row button .simple-share-new-icon'));
    assert.equal(rootEl.querySelectorAll('.simple-share-quick-actions button').length, 0, 'mode entry buttons are removed');
    let sidebarPushes = 0;
    panel.publish = async () => { sidebarPushes++; };
    rootEl.querySelector('.simple-share-publish-row button').click();
    assert.equal(sidebarPushes, 1, 'top push button publishes all pending sharing changes');
    assert(rootEl.querySelector('.simple-share-search').nextElementSibling.classList.contains('simple-share-selection-bar'));
    assert.equal(rootEl.querySelector('.simple-share-actions > button'), null, 'new-share action no longer occupies the search footer');
    assert.equal(rootEl.querySelectorAll('.simple-share-note-row button[data-icon="trash-2"]').length, 0);
    assert.equal(rootEl.querySelectorAll('.simple-share-selection').length, 0);
    assert(rootEl.querySelector('.simple-share-selection-bar').hidden);
    rootEl.querySelector('.simple-share-note-link').click();
    assert.deepEqual(openedNotes, ['甲.md'], 'normal title click opens the original note');
    openedNotes.length = 0;
    rootEl.querySelector('.simple-share-edit').click();
    assert(!rootEl.querySelector('.simple-share-selection-bar').hidden);
    assert.equal(rootEl.querySelectorAll('.simple-share-locate').length, 0);
    assert.deepEqual([...rootEl.querySelectorAll('.simple-share-selection-bar button')].map(button => button.textContent), ['全选', '反选', '清空', '移动', '删除']);
    assert.equal(rootEl.querySelectorAll('.simple-share-selection').length, 2);
    const selectionRow = rootEl.querySelector('.simple-share-note-row');
    selectionRow.querySelector(".setting-item-info").click();
    assert(selectionRow.classList.contains('is-selected'));
    assert.equal(openedNotes.length, 0, 'title click selects instead of opening the note');
    selectionRow.querySelector(".setting-item-name").dispatchEvent(new dom.window.MouseEvent('dblclick'));
    assert.deepEqual(openedNotes, ['甲.md'], 'double click still opens the source note');
    const independentButton = selectionRow.createEl('button'); independentButton.click();
    assert(selectionRow.querySelector('.simple-share-selection').checked, 'action buttons do not toggle row selection');
    independentButton.remove();
    selectionRow.click();
    assert(!selectionRow.querySelector('.simple-share-selection').checked, 'row whitespace toggles selection');
    const selectionInfo = selectionRow.querySelector(".setting-item-info");
    selectionInfo.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ' }));
    assert(selectionRow.querySelector('.simple-share-selection').checked);
    selectionInfo.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
    assert(!selectionRow.querySelector('.simple-share-selection').checked);
    const checkbox = rootEl.querySelector('.simple-share-selection'); checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    assert(rootEl.querySelector('.simple-share-selection-bar').textContent.includes('已选 1 篇'));
    assert.equal(rootEl.querySelector('.simple-share-selection-bar').firstElementChild.tagName, 'SPAN', 'mode and selected count sit above operation buttons');
    const selectAction = label => [...rootEl.querySelectorAll('.simple-share-selection-bar button')].find(button => button.textContent === label).click();
    selectAction('全选');
    assert.equal(rootEl.querySelectorAll('.simple-share-selection:checked').length, 2);
    selectAction('反选');
    assert.equal(rootEl.querySelectorAll('.simple-share-selection:checked').length, 0);
    const search = rootEl.querySelector('.simple-share-search input');
    search.value = '甲'; search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(rootEl.querySelectorAll('.simple-share-selection').length, 1);
    selectAction('全选');
    assert(rootEl.querySelector('.simple-share-selection-bar').textContent.includes('已选 1 篇'), 'select-all applies only to visible search matches');
    selectAction('反选');
    assert(rootEl.querySelector('.simple-share-selection-bar').textContent.includes('已选 0 篇'), 'inverse applies only to visible search matches');
    search.value = ''; search.dispatchEvent(new dom.window.Event('input'));
    selectAction('全选'); selectAction('清空');
    assert.equal(rootEl.querySelectorAll('.simple-share-selection:checked').length, 0);
    assert(rootEl.querySelector('.simple-share-selection-bar').textContent.includes('已选 0 篇'));
    assert([...rootEl.querySelectorAll('.simple-share-selection-bar button')].find(button => button.textContent === '删除').disabled);
    assert([...rootEl.querySelectorAll('.simple-share-selection-bar button')].find(button => button.textContent === '移动').disabled);
    assert.equal(rootEl.querySelectorAll('.simple-share-selection').length, 2);
    assert(!('showDirectory' in view.getState()), 'obsolete directory visibility switch is removed');
    rootEl.querySelector('.simple-share-edit').click();
    assert(rootEl.querySelector('.simple-share-selection-bar').hidden);
    assert.equal(rootEl.querySelectorAll('.simple-share-selection').length, 0, 'leaving edit mode hides checkboxes');
    const popup = dom.window.document.body.createDiv();
    globalThis.shareModalElements = () => ({ titleEl: popup.createDiv(), contentEl: popup.createDiv() });
    const destinations = { all: ['/', '/公开/旧/', '原库/甲', '公开/旧'], share: ['/', '/公开/旧/', '公开/旧'] }, moves = [], creations = [];
    const directoryFeature = { host: { app: {} }, shareDirectories: async () => destinations,
      moveShares: async (ids, directory) => moves.push({ ids, directory }),
      createShareDirectory: async (parent, name) => { const path = `${parent}/${name}`; creations.push(path); destinations.share.push(path); return path; } };
    const defaultPicker = new combined.ShareDirectoryModal(directoryFeature, [firstId, secondId], () => {});
    defaultPicker.open(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(defaultPicker.contentEl.querySelector('.simple-share-directory-feedback').textContent, '', 'legacy root slash must not cause recursive rendering');
    assert.equal(defaultPicker.contentEl.querySelectorAll('[data-directory=""]').length, 1, 'root is rendered once');
    assert(defaultPicker.contentEl.querySelector('[data-directory="公开/旧"]'), 'legacy paths are normalized before building the tree');
    assert(defaultPicker.contentEl.textContent.includes('分享专用库') && !defaultPicker.contentEl.textContent.includes('专门分享库'));
    assert(!defaultPicker.contentEl.querySelector('[data-directory="原库/甲"]'), 'private vault directories are not shown');
    defaultPicker.contentEl.querySelector('.simple-share-directory-footer .mod-cta').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(moves[0].directory, undefined, 'moving without a destination uses each source directory');
    const picker = new combined.ShareDirectoryModal(directoryFeature, [firstId], () => {});
    picker.open(); await new Promise(resolve => setTimeout(resolve, 0));
    const directorySearch = picker.contentEl.querySelector('.simple-share-directory-search');
    directorySearch.value = '不存在'; directorySearch.dispatchEvent(new dom.window.Event('input'));
    assert(!picker.contentEl.querySelector('[data-directory="公开/旧"]'));
    directorySearch.value = '旧'; directorySearch.dispatchEvent(new dom.window.Event('input'));
    picker.contentEl.querySelector('[data-directory="公开/旧"]').click();
    picker.contentEl.querySelector('.simple-share-directory-breadcrumb button').click();
    assert.equal(creations.length, 0, 'new folder remains a draft until its name is saved');
    const inlineEditor = picker.contentEl.querySelector('.simple-share-directory-create');
    assert(inlineEditor.parentElement.classList.contains('simple-share-directory-row'), 'editor replaces the directory label in its original row');
    assert.equal(inlineEditor.dataset.directory, '公开/旧/新建文件夹');
    assert.equal(dom.window.document.activeElement, inlineEditor.querySelector('input'));
    assert.equal(inlineEditor.querySelector('input').selectionEnd, '新建文件夹'.length);
    inlineEditor.querySelector('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(creations.length, 0, 'canceling a draft creates no directory');
    picker.contentEl.querySelector('.simple-share-directory-breadcrumb button').click();
    picker.contentEl.querySelector('.simple-share-directory-create input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(creations, ['公开/旧/新建文件夹']);
    assert(picker.contentEl.querySelector('[data-directory="公开/旧/新建文件夹"]'));
    assert(picker.contentEl.querySelector('.simple-share-directory-breadcrumb').textContent.includes('公开/旧/新建文件夹'));
    picker.contentEl.querySelector('.simple-share-directory-footer .mod-cta').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(moves[1].directory, '公开/旧/新建文件夹');
    delete globalThis.shareModalElements; popup.remove();
    ui.manifest.enabled = false; ui.renderSettings(rootEl, false, false);
    assert.deepEqual([...rootEl.querySelectorAll(".simple-section-title")].map(title => title.textContent), ["分享库管理", "界面与分享模板"]);
    assert.equal([...rootEl.querySelectorAll('button')].filter(button => button.textContent === '管理').length, 1);
    assert(![...rootEl.querySelectorAll('button')].some(button => button.textContent === '删除记录'), 'delete action is inside library management');
    assert(rootEl.querySelector(".simple-share-settings-dependent").classList.contains("is-disabled"));
    assert.equal(rootEl.querySelector(".simple-share-settings-dependent").inert, true, "dependent controls are disabled as a group");
    assert(!rootEl.textContent.includes("默认分享库"));
    assert(!rootEl.textContent.includes("当前分享用仓库"));
    assert(!rootEl.textContent.includes("当前部署状态"));
    assert(rootEl.querySelector(".simple-share-preview-area"));
    assert(rootEl.textContent.includes("分享预览"));
    assert(rootEl.querySelector(".simple-share-preview-example").textContent.includes("《示例笔记》"));
    ui.manifest.enabled = true;
    ui.renderSettings(rootEl, false, false);
    const [detailGithub, detailAdapter, detailDomains] = [ui.github, ui.host.app.vault.adapter, ui.edgeone.customDomainsForProject];
    const detailCalls = [];
    let domainCalls = 0;
    let domainResult = [];
    ui.edgeone.customDomainsForProject = async projectId => {
      assert.equal(projectId, 'makers-test-project');
      domainCalls++;
      return domainResult;
    };
    ui.github = async (path, method) => {
      detailCalls.push({ path, method });
      return JSON.stringify({ private: true });
    };
    const detailCache = new Map();
    let edgeArea = 'global';
    ui.host.app.vault.adapter = {
      ...detailAdapter,
      exists: async path => path.includes('share-local.json.edgeone') || detailCache.has(path),
      read: async path => path.includes('share-local.json.edgeone')
        ? JSON.stringify({ repo: `${ui.manifest.site.owner}/${ui.manifest.site.repo}`.toLowerCase(), branch: ui.manifest.site.branch,
          projectId: 'makers-test-project', projectName: 'share-site', area: edgeArea, website: 'https://share-site.edgeone.cool' })
        : detailCache.get(path) ?? detailAdapter.read(path),
      write: async (path, content) => { detailCache.set(path, content); },
    };
    const detailButton = [...rootEl.querySelectorAll('button')].find(button => button.textContent === '管理');
    assert(detailButton, 'each library offers a detail entry');
    detailButton.click();
    assert.equal(ui.isLibraryManagementOpen, true);
    assert(rootEl.querySelector('.simple-share-library-detail'), 'manage opens a nested settings page');
    assert(rootEl.textContent.includes('正在读取项目关联记录'), 'EdgeOne does not show an unlinked state while its local record is loading');
    for (let attempt = 0; rootEl.textContent.includes('正在读取') || rootEl.textContent.includes('正在重新检查'); attempt++) {
      assert(attempt < 100, 'initial detail check completes');
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const privateChoice = [...rootEl.querySelectorAll('.simple-share-library-detail__visibility-choices button')].find(button => button.textContent === '私有');
    assert(privateChoice && privateChoice.getAttribute('aria-pressed') === 'true' && !privateChoice.disabled, 'private repository is selected');
    assert(rootEl.textContent.includes('当前仓库为私有，GitHub Pages 不可用。'));
    assert(rootEl.querySelector('.simple-share-library-detail__notice'), 'private repository displays a compact warning');
    assert(!rootEl.querySelector('.simple-share-library-detail__section').textContent.includes('分享网址'), 'private repository has no GitHub Pages URL');
    assert.equal(rootEl.querySelectorAll('.simple-share-library-detail__section').length, 3, 'GitHub, EdgeOne and custom domains are separate modules');
    assert.deepEqual([...rootEl.querySelectorAll('.simple-share-library-detail__heading')].map(heading => heading.textContent), ['GitHub Pages', 'EdgeOne Makers', '自定义网站域名'], 'each provider has a visible section heading');
    assert([...rootEl.querySelectorAll('button')].some(button => button.textContent === '新增分享网站'));
    [...rootEl.querySelectorAll('button')].find(button => button.textContent === '新增分享网站').click();
    const domainForm = rootEl.querySelector('.simple-share-library-detail__domain-form');
    assert(domainForm, 'the add action opens name and domain inputs');
    assert(domainForm.textContent.includes('网站首页地址') && domainForm.textContent.includes('插件会根据笔记编号自动生成该网站的笔记链接。'));
    const domainUrl = domainForm.querySelector('input[inputmode="url"]');
    domainUrl.value = 'https://alternate.example.com/notes';
    domainUrl.dispatchEvent(new dom.window.Event('input'));
    assert(domainForm.textContent.includes('https://alternate.example.com/notes/#/notes/abcdefghijkl'), 'domain preview assembles a note link');
    [...domainForm.querySelectorAll('button')].find(button => button.textContent === '取消').click();
    assert(rootEl.querySelector('a[href="https://console.cloud.tencent.com/edgeone/pages/project/makers-test-project"]'), 'project name links to its management page');
    assert(rootEl.textContent.includes('EdgeOne 分享网址https://share-site.edgeone.cool'), 'the preset URL has an explicit EdgeOne label');
    assert(rootEl.textContent.includes('自定义分享网址未绑定'), 'an empty API list is shown as unbound');
    assert.equal(domainCalls, 1, 'the initial opening checks custom domains once');
    const edgeoneDetail = rootEl.querySelectorAll('.simple-share-library-detail__section')[1];
    assert(edgeoneDetail.querySelector('.simple-share-library-detail__notice')?.textContent.includes('有效期 3 小时'), 'mainland-inclusive area explains the temporary preview link');
    assert(edgeoneDetail.querySelector('.simple-share-library-detail__notice')?.textContent.includes('未绑定自定义域名时，需从') && !edgeoneDetail.textContent.includes('中国大陆访问'), 'library notice uses the same unqualified preview instruction');
    assert(edgeoneDetail.querySelector('.simple-share-library-detail__notice a[href="https://console.cloud.tencent.com/edgeone/pages/project/makers-test-project"]')?.textContent === '项目概览 ↗', 'preview notice links inline to project overview');
    assert(edgeoneDetail.querySelector('.simple-share-library-detail__notice')?.textContent.includes('长期访问请绑定已备案的自定义域名。'), 'long-term access guidance stays on a second line');
    assert(rootEl.querySelector('.simple-share-library-detail__row a').href.startsWith('https://github.com/'), 'repository link remains available');
    assert(rootEl.textContent.includes('关联仓库') && rootEl.textContent.includes('仓库可见性'));
    assert(rootEl.textContent.includes('上次检查：') && [...rootEl.querySelectorAll('button')].some(button => button.textContent === '重新检查'));
    assert([...detailCache.keys()].some(path => path.includes('share-local.json.details')), 'the last GitHub check is cached locally');
    assert(rootEl.textContent.includes('GitHub 仓库、已发布网站和原笔记保留'));
    assert([...rootEl.querySelectorAll('button')].some(button => button.textContent === '删除记录'));
    assert(rootEl.querySelector('.simple-share-library-detail__controls')?.textContent.includes('上次检查：'), 'the deletion note and actions occupy a separate lower card');
    assert(!rootEl.querySelector('.simple-share-library-detail').textContent.includes('删除记录只移除'), 'the provider card contains only share-site details');
    assert(!detailCalls.some(call => call.method === 'PATCH'), 'opening details never changes repository visibility');
    const confirmation = dom.window.document.createElement('div'); dom.window.document.body.append(confirmation);
    globalThis.shareModalElements = () => ({ titleEl: confirmation.createDiv(), contentEl: confirmation.createDiv() });
    let privateRepo = true;
    ui.github = async (path, method, request) => {
      detailCalls.push({ path, method, request });
      if (method === 'PATCH') privateRepo = request.private;
      return path.endsWith('/pages')
        ? JSON.stringify({ html_url: 'https://fixture.github.io/notes-share/', status: 'built' })
        : JSON.stringify({ private: privateRepo });
    };
    const publicChoice = [...rootEl.querySelectorAll('.simple-share-library-detail__visibility-choices button')].find(button => button.textContent === '公开');
    publicChoice.click();
    assert(confirmation.textContent.includes('任何人都可以查看仓库内容'));
    [...confirmation.querySelectorAll('button')].find(button => button.textContent === '确认').click();
    for (let attempt = 0; !rootEl.textContent.includes('https://fixture.github.io/notes-share/') && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(detailCalls.some(call => call.method === 'PATCH' && call.request.private === false), 'visibility switch makes the repository public after confirmation');
    assert([...rootEl.querySelectorAll('.simple-share-library-detail__visibility-choices button')].find(button => button.textContent === '公开').getAttribute('aria-pressed') === 'true', 'public repository is selected');
    assert(rootEl.textContent.includes('分享网址https://fixture.github.io/notes-share/'));
    assert(!rootEl.querySelector('.simple-share-library-detail__section')?.querySelector('.simple-share-library-detail__notice'), 'public repository does not show the private warning');
    assert(!rootEl.textContent.includes('启用 GitHub Pages'), 'an enabled Pages site needs no enable action');
    [...rootEl.querySelectorAll('.simple-share-library-detail__visibility-choices button')].find(button => button.textContent === '私有').click();
    assert(confirmation.textContent.includes('GitHub Pages 网站将无法通过本引导使用'));
    [...confirmation.querySelectorAll('button')].find(button => button.textContent === '确认').click();
    for (let attempt = 0; rootEl.textContent.includes('分享网址https://fixture.github.io/notes-share/') && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(detailCalls.some(call => call.method === 'PATCH' && call.request.private === true), 'visibility switch can return the repository to private');
    assert(!rootEl.querySelector('.simple-share-library-detail__section').textContent.includes('分享网址'), 'private repository hides the Pages URL');
    delete globalThis.shareModalElements; confirmation.remove();
    for (let attempt = 0; ![...detailCache.values()].some(value => value.includes('"visibility":true')) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(ui.backFromShareLibraryManagement(), true);
    assert.equal(ui.isLibraryManagementOpen, false);
    edgeArea = 'overseas';
    const callsBeforeCachedOpen = detailCalls.length;
    const domainCallsBeforeCachedOpen = domainCalls;
    [...rootEl.querySelectorAll('button')].find(button => button.textContent === '管理').click();
    for (let attempt = 0; rootEl.textContent.includes('正在读取') && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(rootEl.textContent.includes('当前仓库为私有，GitHub Pages 不可用。'), 'a later opening shows the saved visibility');
    assert(!rootEl.querySelectorAll('.simple-share-library-detail__section')[1].querySelector('.simple-share-library-detail__notice'), 'overseas-only area has no mainland preview warning');
    assert.equal(detailCalls.length, callsBeforeCachedOpen, 'a cached opening does not request GitHub');
    assert.equal(domainCalls, domainCallsBeforeCachedOpen, 'a cached opening does not request EdgeOne again');
    edgeArea = 'global';
    domainResult = [{ domain: 'notes.example.com', status: 'online' }, { domain: 'backup.example.com', status: 'online' }, { domain: 'preview.example.com', status: 'pending' }];
    [...rootEl.querySelectorAll('button')].find(button => button.textContent === '重新检查').click();
    for (let attempt = 0; detailCalls.length === callsBeforeCachedOpen && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(detailCalls.length > callsBeforeCachedOpen, 'manual recheck requests GitHub');
    for (let attempt = 0; rootEl.textContent.includes('正在重新检查') && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(domainCalls, domainCallsBeforeCachedOpen + 1, 'manual recheck requests the custom domain list');
    assert(rootEl.querySelector('a[href="https://notes.example.com"]'), 'an online custom domain is clickable');
    assert(rootEl.querySelector('a[href="https://backup.example.com"]'), 'multiple online custom domains are listed');
    assert(rootEl.textContent.includes('https://preview.example.com（待生效）'), 'a second pending domain is also displayed');
    const onlineDomainToggle = rootEl.querySelector('input[aria-label="启用 notes.example.com"]');
    const pendingDomainToggle = rootEl.querySelector('input[aria-label="启用 preview.example.com"]');
    assert(onlineDomainToggle.checked && !onlineDomainToggle.disabled, 'an online domain is enabled by default');
    assert(!pendingDomainToggle.checked && pendingDomainToggle.disabled, 'a pending domain cannot be shared yet');
    onlineDomainToggle.checked = false; onlineDomainToggle.dispatchEvent(new dom.window.Event('change'));
    for (let attempt = 0; ui.manifest.edgeOneDomains?.selected === undefined && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(ui.manifest.edgeOneDomains.selected, ['backup.example.com'], 'disabling one domain preserves the other enabled domain');
    onlineDomainToggle.checked = true; onlineDomainToggle.dispatchEvent(new dom.window.Event('change'));
    for (let attempt = 0; !ui.manifest.edgeOneDomains?.selected?.includes('notes.example.com') && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert(ui.manifest.edgeOneDomains.selected.includes('notes.example.com'), 'a domain can be enabled again');
    const backupDomainToggle = rootEl.querySelector('input[aria-label="启用 backup.example.com"]');
    backupDomainToggle.checked = false; backupDomainToggle.dispatchEvent(new dom.window.Event('change'));
    for (let attempt = 0; ui.manifest.edgeOneDomains.selected.includes('backup.example.com') && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(ui.manifest.edgeOneDomains.selected, ['notes.example.com'], 'each online domain has an independent selection');
    assert(!rootEl.querySelectorAll('.simple-share-library-detail__section')[1].querySelector('.simple-share-library-detail__notice'), 'an online custom domain removes the preset-domain preview warning');
    assert.equal(ui.backFromShareLibraryManagement(), true);
    const beforeCustomPreview = ui.edgeone.state;
    const beforeHosting = ui.manifest.site.hosting;
    ui.edgeone.state = { version: 1, step: 3, repo: 'fixture/notes-share', branch: 'main', projectId: 'makers-test-project', website: 'https://share-site.edgeone.cool' };
    ui.renderSettings(rootEl, false, false);
    assert(rootEl.querySelector('.simple-share-preview-example').textContent.includes('EdgeOne 自定义域名链接（notes.example.com）'), 'enabled domains appear in the share preview');
    assert(!rootEl.querySelector('.simple-share-preview-example').textContent.includes('preview.example.com'), 'pending domains stay out of the share preview');
    assert(!rootEl.querySelector('.simple-share-preview-example').textContent.includes('backup.example.com'), 'disabled online domains stay out of the share preview');
    assert((await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('https://notes.example.com/#/notes/abcdefghijkl'), 'copied share content uses the enabled custom domain');
    assert(!(await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('preview.example.com'), 'copied share content excludes pending domains');
    assert(!(await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('backup.example.com'), 'copied share content excludes disabled domains');
    ui.manifest.site.hosting = 'edgeone';
    ui.edgeone.state.area = 'global';
    assert(!(await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('share-site.edgeone.cool'), 'mainland-inclusive projects do not copy the unusable preset domain');
    ui.manifest.copyContent = { title: true, github: true, pageOne: false };
    assert(!(await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('notes.example.com'), 'EdgeOne custom domains follow the EdgeOne link checkbox');
    ui.renderSettings(rootEl, false, false);
    assert(!rootEl.querySelector('.simple-share-preview-example').textContent.includes('notes.example.com'), 'the preview follows the same EdgeOne checkbox');
    ui.manifest.copyContent = { title: true, github: true, pageOne: true };
    ui.edgeone.state.area = 'overseas';
    assert((await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('share-site.edgeone.cool'), 'overseas projects may copy the preset domain');
    ui.edgeone.state.area = 'global';
    ui.github = async path => JSON.stringify(path.endsWith('/pages') ? { html_url: 'https://fixture.github.io/notes-share/', status: 'built' } : { private: false });
    ui.guidePages = undefined;
    assert((await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('fixture.github.io/notes-share/'), 'a public built Pages URL is copied after the guide state is gone');
    ui.github = async path => JSON.stringify(path.endsWith('/pages') ? { html_url: 'https://fixture.github.io/notes-share/', status: 'built' } : { private: true });
    ui.manifest.site.hosting = 'github';
    assert(!(await ui.shareCopyText('abcdefghijkl', '实际笔记')).includes('fixture.github.io'), 'a private repository never contributes a Pages URL');
    ui.manifest.site.hosting = beforeHosting;
    ui.edgeone.state = beforeCustomPreview;
    ui.host.app.vault.adapter = detailAdapter;
    ui.github = detailGithub;
    ui.edgeone.customDomainsForProject = detailDomains;
    ui.renderSettings(rootEl, false, false);
    const copyOptions = rootEl.querySelectorAll('.simple-share-settings-dependent input[type="checkbox"]');
    assert.equal(copyOptions.length, 3);
    assert.deepEqual([...copyOptions].map(input => input.checked), [true, true, true]);
    const originalCopyChange = ui.updateCopyContent.bind(ui);
    ui.updateCopyContent = async (key, value) => { ui.manifest.copyContent = { ...ui.copyContent, [key]:value }; };
    copyOptions[1].checked = false; copyOptions[1].dispatchEvent(new dom.window.Event('change'));
    assert.equal(ui.copyContent.github, false, 'settings page updates shared copy preferences');
    assert(!rootEl.querySelector('.simple-share-preview-example').textContent.includes('example.github.io'), 'preview omits unchecked link');
    assert(rootEl.querySelector('.simple-share-preview-example').textContent.includes('example.edgeone.cool'), 'preview keeps selected link');
    copyOptions[1].checked = true; copyOptions[1].dispatchEvent(new dom.window.Event('change'));
    const copyMenuItems = [];
    const copyMenu = { addSeparator() {}, addItem(configure) {
      const item = { setTitle(value) { this.title=value;return this; }, setIcon(value) { this.icon=value;return this; }, setDisabled(value) { this.disabled=value;return this; }, onClick(callback) { this.click=callback;return this; } };
      configure(item);copyMenuItems.push(item);
    } };
    ui.addCopyContentMenu(copyMenu);
    assert.deepEqual(copyMenuItems.map(item => item.title), ['笔记标题', 'GitHub 链接', 'EdgeOne Makers 链接']);
    assert.equal(copyMenuItems[2].icon, 'check-square', 'sidebar menu reflects the settings page');
    copyMenuItems[0].click();
    ui.renderSettings(rootEl, false, false);
    assert(!rootEl.querySelector('.simple-share-settings-dependent input[aria-label="笔记标题"]').checked, 'menu changes reflect in the settings page');
    ui.updateCopyContent = originalCopyChange;
    const selects = rootEl.querySelectorAll("select");
    const layoutSelect = [...selects].find(select => select.querySelector('option[value="public"]'));
    layoutSelect.value = "public"; layoutSelect.dispatchEvent(new dom.window.Event("change"));
    assert.equal(ui.display.layout, "public");
    assert.equal(ui.display.layout, "public");
    assert(savedLayouts > 0, "display preferences use Obsidian workspace persistence");
    ui.restoreDisplay({ layout: "source", showPaths: true });
    assert.equal(ui.display.layout, "public", "obsolete workspace state cannot override persisted display settings");
    const pageTitles = [];
    ui.renderSettings(rootEl, false, false, title => pageTitles.push(title));
    ui.edgeOneGuideOpen = true; ui.renderSettings(rootEl, false, false, title => pageTitles.push(title));
    assert.equal(pageTitles.at(-1), '腾讯 EdgeOne 接入引导', 'Tencent guide updates the shared page header');
    assert.equal(rootEl.querySelectorAll('.simple-page-title').length, 0, 'embedded guide has no duplicate heading');
    assert(!rootEl.textContent.includes('返回笔记分享设置'));
    assert(!rootEl.textContent.includes('按顺序完成三步'));
    assert(rootEl.querySelector('.simple-one-sync-setup-status'), 'keep the connection status strip');
    assert(ui.backFromEdgeOneGuide());
    assert.equal(pageTitles.at(-1), '笔记分享设置', 'header back returns to sharing settings');
    assert(!ui.backFromEdgeOneGuide(), 'normal sharing back can return to its parent');
    const deploymentCalls = [];
    let finishDeployment;
    ui.host.sync.exec = async (_program, args) => {
      deploymentCalls.push(args);
      if (args[0] === 'auth') return 'authenticated';
      if (args[0] === 'api' && args[1] === 'user') return 'fixture';
      return await new Promise(resolve => { finishDeployment = resolve; });
    };
    ui.local = async () => ({ version: 1, site: "fixture/notes-share", commit: "fixture-commit" });
    const check = ui.checkDeployment();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(ui.checkingDeployment, true);
    finishDeployment(JSON.stringify({ commit: "fixture-commit", status: "built" })); await check;
    assert.equal(ui.githubDeploymentStatus, "网站已更新");
    assert.deepEqual(deploymentCalls, [["auth", "status", "--active", "--hostname", "github.com"], ["api", "user", "--jq", ".login"], ["api", "repos/fixture/notes-share/pages/builds/latest"]], "deployment verifies local CLI access, then only reads build status");
  } finally { delete globalThis.shareSetting; dom.window.close(); }
  console.log("Share authorization UI: method selection, token handoff, device code cancellation and shared title preservation passed.");
  {
    for (const occupied of ["precheck", "create-race", "permission", "free"]) {
      const calls = [];
      const creator = new combined.ShareFeature({ manifest: { id: 'fixture' }, app: { secretStorage: { getSecret: () => '' } }, sync: { exec: async (_program, args) => {
        calls.push(args);
        if (args[0] === 'auth' && args[1] === 'token') throw Error('no fallback token in this fixture');
        if (args[0] === 'auth') return 'authenticated';
        if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login: "fixture" });
        if (args[0] === "api" && args[1] !== "user/repos") { if (occupied === "precheck") return "{}"; throw new Error("HTTP 404"); }
        if (occupied === "create-race") throw new Error("Name already exists on this account");
        if (occupied === "permission") throw new Error("HTTP 403: denied");
        return "created";
      } } });
      let bound;
      creator.bind = async (owner, name) => { bound = `${owner}/${name}`; };
      if (["precheck", "create-race"].includes(occupied)) {
        await assert.rejects(() => creator.createRepository("vault-share"), /仓库名称已被使用：fixture\/vault-share.*更换名称.*使用已有分享仓库/);
        assert.deepEqual(creator.takenRepository, { owner: "fixture", name: "vault-share" });
        assert.equal(bound, undefined);
        if (occupied === "precheck") assert(!calls.some(args => args.includes("user/repos")), "existing repository must not be created or reused silently");
      } else if (occupied === "permission") await assert.rejects(() => creator.createRepository("vault-share"), /403: denied/);
      else { await creator.createRepository("vault-share"); assert.equal(bound, "fixture/vault-share"); assert(calls.some(args => args.includes("user/repos") && args.includes("POST"))); }
    }
    let scans = 0, active = 0, peak = 0, release;
    const manager = new combined.ShareFeature({});
    manager.scanNow = async () => { scans++; active++; peak = Math.max(peak, active); if (scans === 1) await new Promise(resolve => { release = resolve; }); active--; };
    const first = manager.scan(), second = manager.scan();
    release(); await Promise.all([first, second]); assert.equal(scans, 2); assert.equal(peak, 1, "new changes request a follow-up without overlapping scans");
    let reveal = false, closed = false, finishScan;
    let created = 0;
    const shareLeaf = { setViewState: async () => {} };
    manager.host.app = { workspace: { getLeavesOfType: () => [], getRightLeaf: split => {
      assert.equal(split, false, 'opening share management adds a tab in the existing right group');
      created++; return shareLeaf;
    }, revealLeaf: async () => { reveal = true; } }, setting: { close() { closed = true; } } };
    manager.scan = () => new Promise(resolve => { finishScan = resolve; });
    await manager.open(true);
    assert(reveal && closed, "settings button reveals the manager and closes the settings modal before background checking completes");
    finishScan();
    reveal = false; closed = false;
    manager.host.app.workspace.getLeavesOfType = () => [shareLeaf];
    await manager.open(false, false);
    assert(!reveal && !closed, 'automatic sidebar installation preserves the active page');
    assert.equal(created, 1, 'automatic installation reuses an existing share panel');
    finishScan();
    manager.host.app.workspace.getLeavesOfType = () => [shareLeaf];
    await manager.open(true);
    assert.equal(created, 1, 'reopening reuses share management without creating duplicate panels');
    finishScan();
    const sequence = [];
    manager.manifest.site = { owner: 'fixture', repo: 'notes-share', branch: 'main' };
    manager.open = async () => { sequence.push("open"); };
    manager.shareCopyText = () => 'share content';
    manager.shareNow = async (_file, _id, onId) => { sequence.push("publish"); onId('abcdefghijkl'); assert.equal(manager.publishingTitle, "current"); };
    await manager.share(new combined.TFile("current.md"));
    assert.deepEqual(sequence, ["open", "publish"], "sharing reveals the progress panel before publishing starts");
    assert.equal(manager.sharing, false);
    libraries.addLibrary(manager.manifest);
    const secondTarget = manager.libraryId;
    manager.manifest.site = { owner: 'fixture', repo: 'second-share', branch: 'main' };
    manager.change = async edit => { edit(manager.manifest); };
    manager.refreshActions = () => {};
    manager.renderViews = () => {};
    await manager.toggleShareTarget('legacy');
    assert.deepEqual(libraries.selectedLibraryIds(manager.manifest), [secondTarget]);
    await assert.rejects(manager.toggleShareTarget(secondTarget), /至少保留一个/);
    await manager.toggleShareTarget('legacy');
    assert.deepEqual(model.parseManifest(model.serializeManifest(manager.manifest)).libraries.selected, [secondTarget, 'legacy']);
    manager.manifest.libraries.selected = ['legacy', secondTarget];
    manager.switchLibrary = async id => { libraries.selectLibrary(manager.manifest, id); sequence.push(`switch:${id}`); };
    manager.shareCopyText = () => 'share content';
    manager.shareNow = async (_file, priorId, onId) => {
      assert.equal(priorId, undefined === sequence.find(item => item === 'publish:legacy') ? undefined : 'abcdefghijkl');
      onId('abcdefghijkl'); sequence.push(`publish:${manager.libraryId}`);
      if (manager.libraryId === secondTarget) throw new Error('fixture publish failed');
    };
    const oldClipboard = globalThis.navigator.clipboard;
    let copied = '';
    globalThis.navigator.clipboard = { writeText: async text => { copied = text; } };
    try { await manager.share(new combined.TFile('current.md')); }
    finally { globalThis.navigator.clipboard = oldClipboard; }
    assert(sequence.includes('publish:legacy') && sequence.includes(`publish:${secondTarget}`), 'all selected libraries are attempted');
    assert.equal(manager.libraryId, secondTarget, 'publishing restores the library being viewed');
    assert(manager.status.includes('1/2 个分享库'));
    assert(manager.error.includes('fixture publish failed'));
    assert(copied.includes('share content'));
    manager.shareNow = async (_file, priorId, onId) => { onId(priorId ?? 'abcdefghijkl'); };
    globalThis.navigator.clipboard = { writeText: async text => { copied = text; } };
    try { await manager.share(new combined.TFile('current.md')); }
    finally { globalThis.navigator.clipboard = oldClipboard; }
    assert(manager.status.includes('2/2 个分享库'));
    assert.equal(manager.error, '');
    assert(copied.includes('fixture/notes-share') && copied.includes('fixture/second-share'), 'all successful library links are copied together');
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
  adapter.list = async path => { const entries = await readdir(join(root, path), { withFileTypes: true }); return { files: entries.filter(item => item.isFile()).map(item => path + "/" + item.name), folders: entries.filter(item => item.isDirectory()).map(item => path + "/" + item.name) }; };
  const cloud = shareRemoteFixture({ 'README.md': 'unmanaged keep' });
  const featureDom = new JSDOM('<body></body>');
  for (const name of ['createDiv', 'createEl', 'createSpan', 'setAttr', 'addClass', 'toggleClass', 'empty']) {
    if (dom.window.HTMLElement.prototype[name]) featureDom.window.HTMLElement.prototype[name] = dom.window.HTMLElement.prototype[name];
  }
  globalThis.document = featureDom.window.document;
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => name === '--simple-image-max-height' ? '320px' : '', color: 'rgb(80, 120, 160)' });
  const sourceFiles = [new combined.TFile('写作/source.md'), new combined.TFile('other.md')];
  const contents = new Map([[sourceFiles[0].path, '---\nshare_id: ' + id + '\nprivate: secret\n---\n# 正文\n'], [sourceFiles[1].path, '---\nshare_id: ' + other + '\n---\n另一个正文']]);
  const repoHost = { manifest: { id: 'simple-one' }, settings: { enhancements: { quickFormat: { customCallouts: [], calloutColors: { warning: '#aabbcc' } } } },
    app: { vault: { adapter, configDir: '.obsidian', getMarkdownFiles: () => sourceFiles,
      getAbstractFileByPath: path => sourceFiles.find(file => file.path === path), read: async file => contents.get(file.path) },
      workspace: { getLeavesOfType: () => [] }, metadataCache: { getFileCache: file => ({ frontmatter: { share_id: file === sourceFiles[0] ? id : other } }), getFirstLinkpathDest: () => null } },
    sync: { isSyncing: () => false, exec: async (program, args, _auth, _trim, _timeout, _output, stdin) => {
      assert.equal(program, 'gh', 'publishing must never execute Git');
      if (args[0] === '--version') return 'gh version';
      if (args[0] === 'auth') return 'authenticated';
      if (args[0] === 'api' && args[1] === 'user') return 'fixture';
      assert.equal(args[0], 'api');
      const methodIndex = args.indexOf('--method');
      return JSON.stringify(await cloud.request(args[1], methodIndex >= 0 ? args[methodIndex + 1] : 'GET', stdin ? JSON.parse(stdin) : undefined));
    } }
  };
  const manifestPath = '.obsidian/plugins/simple-one/share-manifest.json';
  await adapter.mkdir('.obsidian/plugins/simple-one');
  await adapter.write('.obsidian/plugins/simple-one/default.html', defaultTemplate);
  const registry = model.emptyManifest(); registry.site = { owner: 'test', repo: 'public', branch: 'main' };
  registry.notes[id] = { enabled: true, sourcePath: sourceFiles[0].path, category: '写作', revision: 1 };
  registry.notes[other] = { enabled: true, sourcePath: sourceFiles[1].path, category: '', revision: 1 };
  await adapter.write(manifestPath, model.serializeManifest(registry));
  // Previous subrepository jobs do not constrain new manifest-driven publishing.
  await adapter.write('.obsidian/plugins/simple-one/share-local.json', JSON.stringify({ version: 1, site: 'old/repo', backend: 'api', job: { base: 'obsolete', expected: {} } }));
  const feature = new combined.ShareFeature(repoHost);
  await feature.publish(false, id);
  assert.equal(JSON.parse(cloud.files.get('catalog.json')).notes.length, 2, 'a single share action reconstructs all enabled manifest entries');
  assert(!cloud.files.get('notes/' + id + '.md').toString().includes('secret'));
  assert.equal(cloud.files.get('README.md').toString(), 'unmanaged keep');
  assert(!await adapter.exists('.gitshare'), 'no clone or generated public cache is created');
  assert.equal(cloud.calls.filter(call => call.path.includes('/git/blobs/') && call.method === 'GET').length, 0, 'fresh repo has no cloud content downloads');
  const commitCount = () => cloud.calls.filter(call => call.path.endsWith('/git/commits') && call.method === 'POST').length;
  const firstCount = commitCount();
  await feature.publish(); assert.equal(commitCount(), firstCount, 'unchanged publish creates no commit');
  const appearance = cloud.files.get('reader/appearance.css').toString();
  assert(appearance.includes('--share-image-max-height:320px'));
  assert(appearance.includes('.callout[data-callout="caution"]{--callout-color:#aabbcc}'));
  const customTemplate = defaultTemplate.replace('<title>分享笔记</title>', '<title>自定义分享</title>');
  await feature.saveTemplate(customTemplate, '已导入', '我的主题.html');
  await feature.publish(); assert(cloud.files.get('index.html').toString().includes('自定义分享'));
  assert.equal(await adapter.read('.obsidian/plugins/simple-one/default.html'), defaultTemplate);
  await assert.rejects(() => feature.saveTemplate('<html><body>损坏</body></html>', ''), /content/);
  await feature.restoreDefaultTemplate(); await feature.publish();
  assert(!cloud.files.get('index.html').toString().includes('自定义分享'));
  assert.equal(await adapter.read('.obsidian/plugins/simple-one/custom-我的主题.html'), customTemplate);
  const replaced = defaultTemplate.replace('分享笔记', '替换默认');
  await adapter.write('.obsidian/plugins/simple-one/default.html', replaced); await feature.publish();
  assert(cloud.files.get('index.html').toString().includes('替换默认'));
  await adapter.write('.obsidian/plugins/simple-one/default.html', defaultTemplate);
  await feature.moveShares([id, other], '写作/人物');
  await feature.publish();
  for (const noteId of [id, other]) { assert(cloud.files.has('notes/写作/人物/' + noteId + '.md')); assert(!cloud.files.has('notes/' + noteId + '.md')); }
  const publishMapping = model.parseManifest(await adapter.read(manifestPath));
  publishMapping.directories[publishMapping.notes[id].directoryCode] = '迁移/新目录';
  await adapter.write(manifestPath, model.serializeManifest(publishMapping)); await feature.publish();
  for (const noteId of [id, other]) { assert(cloud.files.has('notes/迁移/新目录/' + noteId + '.md')); assert(!cloud.files.has('notes/写作/人物/' + noteId + '.md')); }
  assert.equal(await feature.createShareDirectory('公开'), '公开/新建文件夹');
  const numbered = await Promise.all([feature.createShareDirectory('公开'), feature.createShareDirectory('公开')]);
  assert.deepEqual(numbered, ['公开/新建文件夹(1)', '公开/新建文件夹(2)']);
  assert.equal(await feature.renameShareDirectory('公开', '公开改名'), '公开改名');
  await assert.rejects(() => feature.createShareDirectory('', '../private'), /名称/);
  await feature.createShareDirectory('空目录测试', '子目录');
  assert(await feature.deleteShareDirectory('空目录测试'));
  assert(!(await feature.shareDirectories()).share.some(path => path.startsWith('空目录测试')));
  assert(!await adapter.exists('.gitshare'), 'directory editing remains manifest-only');
  const beforeMissing = cloud.head;
  const savedSource = sourceFiles.pop();
  await assert.rejects(() => feature.publish(), /源文件缺失/); assert.equal(cloud.head, beforeMissing);
  sourceFiles.push(savedSource);
  // No saved base protects older content: the current manifest + local source are authoritative.
  contents.set(sourceFiles[0].path, 'older local content');
  await feature.publish(); assert.equal(cloud.files.get('notes/迁移/新目录/' + id + '.md').toString(), 'older local content');
  cloud.offline = true; contents.set(sourceFiles[0].path, 'changed while offline');
  await assert.rejects(() => feature.publish(), /offline/);
  await feature.change(value => { value.copyContent = { title:true, github:true, pageOne:false }; });
  cloud.offline = false; await feature.publish();
  assert.equal(cloud.files.get('notes/迁移/新目录/' + id + '.md').toString(), 'changed while offline');
  cloud.loseResponse = true; contents.set(sourceFiles[0].path, 'uncertain completed content');
  await assert.rejects(() => feature.publish(), /lost response/);
  const countAfterLost = commitCount();
  const restarted = new combined.ShareFeature(repoHost); await restarted.publish();
  assert.equal(commitCount(), countAfterLost, 'restart regenerates and discovers the completed result');
  // Unknown remote notes are retained as SHA references, never downloaded into a mirror.
  await feature.change(value => { delete value.notes[other]; });
  const reads = cloud.calls.filter(c => c.path.includes('/git/blobs/') && c.method === 'GET').length;
  await feature.publish();
  assert(cloud.files.has('notes/迁移/新目录/' + other + '.md'));
  assert.equal(cloud.calls.filter(c => c.path.includes('/git/blobs/') && c.method === 'GET').length - reads, 1);
  await feature.removeShares([id]);
  assert(!cloud.files.has('notes/迁移/新目录/' + id + '.md'));
  assert(cloud.files.has('notes/迁移/新目录/' + other + '.md'));
  await feature.refreshPublished(); await feature.removeShares([other]);
  assert.equal(JSON.parse(cloud.files.get('catalog.json')).notes.length, 0);
  assert.equal(await adapter.read('private.md'), 'private');
  assert.equal(cloud.files.get('README.md').toString(), 'unmanaged keep');
  const local = JSON.parse(await adapter.read('.obsidian/plugins/simple-one/share-local.json'));
  assert(!local.job && !local.backend && !local.base, 'local state contains deployment status metadata, not a synchronization baseline');
  featureDom.window.close();
  console.log('Share direct publishing passed: full manifest generation, CLI without Git, no clone/disk mirror, no-op hashes, template replacement, directory mapping, explicit deletion, missing-source protection and restart recovery.');
} finally {
  const target = resolve(folder);
  if (!target.startsWith(resolve(tmpdir()))) throw new Error("Invalid temporary cleanup target");
  await rm(target, { recursive: true, force: true });
}
