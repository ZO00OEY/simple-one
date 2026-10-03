import { addIcon, Component, FuzzySuggestModal, ItemView, MarkdownView, Menu, Modal, Notice, Platform, Setting, setIcon, setTooltip, parseYaml, TFile, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type SimplePlugin from "../../main";
import { runAsync } from "../../shared/async";
import { settingsSection } from "../../shared/settingsLayout";
import { registerMarkdownAction } from "../../shared/markdownAction";
import { ID_PATTERN, SHARE_FOLDER, emptyManifest, formatShareLink, intentHash, newShareId, parseManifest, remoteConflict, serializeManifest, siteUrl, sha256, type ShareManifest, type PublishState } from "./model";
import { exportNote } from "./export";
import { ShareRepository, websiteFiles, type PublishJob } from "./repository";
import { shareAppearance } from "./appearance";
import { DEFAULT_SHARE_TEMPLATE, validateShareTemplate } from "./template";

const VIEW = "simple-one-share";
interface Row { id: string; title: string; state: string; file?: TFile }
type ShareLayout = "list" | "source" | "public";
interface ShareDisplaySettings { showPaths: boolean; showCancelled: boolean; layout: ShareLayout; descending: boolean }
interface ShareFolder { children: Map<string, ShareFolder>; rows: Row[] }
interface LocalState { version: 1; job?: PublishJob; site?: string; commit?: string }
class CategoryModal extends Modal {
  constructor(private feature: ShareFeature, private id: string) { super(feature.host.app); }
  onOpen(): void {
    this.titleEl.setText("公开分类与文件名");
    let category = this.feature.manifest.notes[this.id].category;
    let publicName = this.feature.manifest.notes[this.id].publicName || "";
    new Setting(this.contentEl).setName("分类路径").setDesc("例如 写作/人物；不会改变原笔记目录或分享链接。")
      .addText(text => text.setValue(category).onChange(value => { category = value; }));
    new Setting(this.contentEl).setName("公开发布文件名").setDesc("留空沿用原笔记名；不修改本地笔记名或固定分享链接。无需填写 .md 后缀。")
      .addText(text => text.setPlaceholder(this.feature.manifest.notes[this.id].sourcePath.split("/").pop()?.replace(/\.md$/i, "") || "原笔记名").setValue(publicName).onChange(value => { publicName = value; }));
    new Setting(this.contentEl).addButton(button => button.setButtonText("保存").setCta().onClick(runAsync(async () => {
      const name = publicName.trim().replace(/\.md$/i, "");
      if (/[\\/\r\n]/.test(name)) { new Notice("公开文件名不能包含目录分隔符或换行。"); return; }
      await this.feature.change(manifest => { const entry = manifest.notes[this.id]; entry.category = category.trim(); entry.publicName = name || undefined; entry.revision++; }); this.close();
    })));
  }
  onClose(): void { this.contentEl.empty(); }
}
class IdModal extends Modal {
  constructor(private feature: ShareFeature, private id: string, private files: TFile[]) { super(feature.host.app); }
  onOpen(): void {
    this.titleEl.setText("选择原分享对应的笔记");
    this.contentEl.createEl("p", { text: "所选笔记保留原链接，其他副本获得新 ID，但不会自动开启分享。" });
    for (const file of this.files) new Setting(this.contentEl).setName(file.path).addButton(button => button.setButtonText("保留此篇").onClick(runAsync(async () => {
      await this.feature.resolveDuplicate(this.id, file, this.files); this.close();
    })));
  }
  onClose(): void { this.contentEl.empty(); }
}
class RelinkModal extends FuzzySuggestModal<TFile> {
  constructor(private feature: ShareFeature, private id: string) { super(feature.host.app); this.setPlaceholder("选择原分享对应的笔记"); }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles().filter(file => !file.path.startsWith(SHARE_FOLDER + "/") && !file.path.startsWith(this.app.vault.configDir + "/")); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { void this.feature.restoreId(this.id, file).catch(error => new Notice(String(error))); }
}
export default class ShareFeature extends Component {
  manifest = emptyManifest();
  rows: Row[] = [];
  busy = false;
  status = "";
  error = "";
  publishingTitle = "";
  private scanTimer?: number;
  private scanRequest = 0;
  private scanTask?: Promise<void>;
  private scanAgain = false;
  private sharing = false;
  private refreshActions: () => void = () => {};
  private mutation: Promise<void> = Promise.resolve();
  private manifestText = "";
  private guideStep = 1;
  private guideAvailableStep = 1;
  private authorized = false;
  private setupBusy = false;
  private deviceCode = "";
  private authController?: AbortController;
  private setupHost?: HTMLElement;
  private setupGuide = false;
  private setupShowTitle = true;
  private authMode: "browser" | "token" | "verify" | null = null;
  private repoMode: "create" | "existing" | null = null;
  private draftName = "";
  private draftRepo = "";
  private takenRepository?: { owner: string; name: string };
  private repositoryFeedback = "";
  private checkingDeployment = false;
  display: ShareDisplaySettings = { showPaths: false, showCancelled: false, layout: "list", descending: false };
  private displayStored = false;
  private template = DEFAULT_SHARE_TEMPLATE;
  private templateMessage = "";
  private templateBusy = false;
  private token = "";
  private published: PublishState = { version: 1, notes: {}, files: [] };
  constructor(readonly host: SimplePlugin) { super(); }
  private path(name: string): string { return `${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}/${name}`; }
  private suggestedRepoName(): string {
    const settings = this.host.sync.settings;
    const remote = settings?.boundRepoUrl || settings?.mobile?.repoUrl || settings?.gitRemoteUrl || settings?.setupRepoUrl || "";
    const name = remote.match(/[:/]([^/:]+?)(?:\.git)?\/?$/)?.[1] || this.host.app.vault?.getName?.() || "notes";
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 94) || "notes";
    return `${safe}-share`;
  }
  async initialize(): Promise<void> {
    await this.reload().catch(error => { this.error = String(error); });
    await this.readTemplate().catch(error => { this.templateMessage = error instanceof Error ? error.message : String(error); });
    if (this.manifest.site.repo && this.manifest.site.initialized) { this.guideStep = 4; this.guideAvailableStep = 4; }
    addIcon("simple-share-location", '<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M50 92S81 59 81 38a31 31 0 0 0-62 0c0 21 31 54 31 54Z"/><circle cx="50" cy="38" r="11"/></g>');
    addIcon("simple-share-sort-asc", '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M25 85V15m-12 12 12-12 12 12M60 35l10-25 10 25M64 27h12M60 60h20L60 85h20"/></g>');
    addIcon("simple-share-sort-desc", '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M25 15v70m-12-12 12 12 12-12M60 10h20L60 35h20M60 85l10-25 10 25M64 77h12"/></g>');
    this.refreshActions = registerMarkdownAction(this.host, "data-simple-share-note", () => this.manifest.enabled && !Platform.isMobile,
      view => view.addAction("share-2", "分享当前笔记", runAsync(async () => {
        if (!view.file) return;
        await view.save();
        await this.share(view.file).catch(error => this.fail(error));
      })),
      action => {
        const disabled = this.busy || this.sharing;
        action.setAttr("aria-disabled", String(disabled));
        setTooltip(action, disabled ? "正在发布分享，请稍候" : "分享当前笔记：发布并复制链接");
      });
    this.host.registerView(VIEW, leaf => new ShareView(leaf, this));
    this.host.addCommand({ id: "share-current-note", name: "分享此笔记", checkCallback: checking => {
      const file = this.host.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (!file) return false; if (!checking) void this.share(file).catch(error => this.fail(error)); return true;
    } });
    this.host.addCommand({ id: "open-share-manager", name: "打开笔记分享管理", callback: () => { void this.open(); } });
    this.host.addCommand({ id: "publish-shared-notes", name: "推送新分享", callback: () => { void this.publish().catch(error => this.fail(error)); } });
    this.host.addRibbonIcon("share-2", "笔记分享管理", () => { void this.open(); });
    this.registerEvent(this.host.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md" || file.path.startsWith(SHARE_FOLDER + "/")) return;
      menu.addItem(item => item.setTitle("分享此笔记").setIcon("share-2").onClick(() => { void this.share(file).catch(error => this.fail(error)); }));
    }));
    const schedule = () => {
      if (this.scanTimer) window.clearTimeout(this.scanTimer);
      this.scanTimer = window.setTimeout(() => { void this.scan().catch(error => this.fail(error)); }, 900);
    };
    this.registerEvent(this.host.app.vault.on("modify", file => { if (!file.path.startsWith(SHARE_FOLDER + "/") && file.path !== this.path("share-local.json")) schedule(); }));
    this.registerEvent(this.host.app.vault.on("rename", schedule));
    this.registerEvent(this.host.app.vault.on("delete", schedule));
    this.registerEvent(this.host.app.metadataCache.on("changed", schedule));
    this.host.app.workspace.onLayoutReady(schedule);
    this.host.registerInterval(window.setInterval(() => {
      if (this.busy) return;
      const adapter = this.host.app.vault.adapter;
      void adapter.exists(this.path("share-manifest.json")).then(async exists => {
        const text = exists ? await adapter.read(this.path("share-manifest.json")) : "";
        if (text !== this.manifestText) schedule();
      }).catch(error => this.fail(error));
    }, 5000));
    this.register(() => { if (this.scanTimer) window.clearTimeout(this.scanTimer); this.authController?.abort(); });
  }
  private fail(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); this.renderViews(); new Notice(`笔记分享：${this.error}`, 10000); }
  private async reload(): Promise<void> {
    const adapter = this.host.app.vault.adapter;
    const path = this.path("share-manifest.json");
    const text = await adapter.exists(path) ? await adapter.read(path) : "";
    this.manifestText = text;
    this.manifest = text ? parseManifest(text) : emptyManifest();
  }
  async change(edit: (manifest: ShareManifest) => void, refresh = true): Promise<void> {
    if (this.busy) throw new Error("发布正在进行，请稍后修改分享设置。");
    const operation = this.mutation.then(async () => {
      if (this.host.sync.isSyncing()) throw new Error("主库正在同步，请稍后修改分享设置。");
      if ((await this.local()).job) throw new Error("存在待恢复的发布，请先点击「推送新分享」恢复，再修改分享设置。");
      await this.reload(); edit(this.manifest);
      const serialized = serializeManifest(this.manifest); parseManifest(serialized);
      await this.host.app.vault.adapter.write(this.path("share-manifest.json"), serialized);
    });
    this.mutation = operation.catch(() => {});
    await operation; this.error = ""; if (refresh) await this.scan();
  }
  private async scanIndex(): Promise<Map<string, TFile[]>> {
    const index = new Map<string, TFile[]>();
    if (!Object.keys(this.manifest.notes).length) return index;
    let count = 0;
    for (const file of this.host.app.vault.getMarkdownFiles()) {
      if (++count % 200 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      if (file.path.startsWith(SHARE_FOLDER + "/") || file.path.startsWith(this.host.app.vault.configDir + "/")) continue;
      const id: unknown = this.host.app.metadataCache.getFileCache(file)?.frontmatter?.share_id;
      if (typeof id === "string" && ID_PATTERN.test(id)) index.set(id, [...(index.get(id) || []), file]);
    }
    return index;
  }
  private index(): Map<string, TFile[]> {
    const index = new Map<string, TFile[]>();
    for (const file of this.host.app.vault.getMarkdownFiles()) {
      if (file.path.startsWith(SHARE_FOLDER + "/") || file.path.startsWith(this.host.app.vault.configDir + "/")) continue;
      const id: unknown = this.host.app.metadataCache.getFileCache(file)?.frontmatter?.share_id;
      if (typeof id === "string" && ID_PATTERN.test(id)) index.set(id, [...(index.get(id) || []), file]);
    }
    return index;
  }
  async share(file: TFile): Promise<void> {
    if (this.sharing || this.busy) throw new Error("发布正在进行，请稍候。");
    this.sharing = true; this.publishingTitle = file.basename; this.status = "准备分享…"; this.error = ""; this.refreshActions();
    try { await this.open(); this.renderViews(); await this.shareNow(file); }
    finally { this.sharing = false; this.renderViews(); }
  }
  private async shareNow(file: TFile): Promise<void> {
    if (Platform.isMobile) throw new Error("请在电脑端发布分享，手机端可管理分享清单。");
    await this.reload();
    if (!this.manifest.enabled) throw new Error("请先在笔记分享设置中启用分享。");
    if (!this.manifest.site.repo) throw new Error("请先完成笔记分享引导，连接公开分享仓库。");
    if (file.path.startsWith(SHARE_FOLDER + "/") || file.path.startsWith(this.host.app.vault.configDir + "/")) throw new Error("请选择主库中的正文笔记。");
    if (this.busy) throw new Error("发布正在进行。");
    let id: unknown = this.host.app.metadataCache.getFileCache(file)?.frontmatter?.share_id;
    const index = this.index();
    if (id !== undefined && (typeof id !== "string" || !ID_PATTERN.test(id))) throw new Error("现有 share_id 格式不正确，请先修复，不会覆盖。");
    if (!id) {
      if (Object.values(this.manifest.notes).some(entry => entry.sourcePath === file.path)) throw new Error("这篇笔记的分享 ID 已丢失，请在侧栏恢复原 ID。");
      id = newShareId(new Set([...index.keys(), ...Object.keys(this.manifest.notes)]));
      await this.host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => { frontmatter.share_id = id; });
    }
    const key = id as string;
    if ((index.get(key)?.length || 0) > 1) throw new Error("该 ID 对应多篇笔记，请在分享侧栏解决重复。");
    await this.change(manifest => {
      const old = manifest.notes[key];
      manifest.notes[key] = { ...old, enabled: true, sourcePath: file.path, category: old?.category ?? file.parent?.path ?? "", revision: (old?.revision || 0) + 1 };
    }, false);
    await this.publish(false, key);
    const url = `${siteUrl(this.manifest.site)}#/notes/${key}`;
    try { await navigator.clipboard.writeText(formatShareLink(this.published.notes[key]?.title || this.manifest.notes[key]?.publicName || file.basename, url)); new Notice("当前笔记已推送，笔记名和分享链接已复制；网站展示需等待部署完成。", 8000); }
    catch { new Notice("当前笔记已推送，可在分享侧栏复制链接。", 8000); }
  }
  async resolveDuplicate(id: string, keep: TFile, files: TFile[]): Promise<void> {
    if (this.busy) throw new Error("请等待发布完成。");
    const used = new Set([...this.index().keys(), ...Object.keys(this.manifest.notes)]);
    for (const file of files) if (file !== keep) {
      const fresh = newShareId(used); used.add(fresh);
      await this.host.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { fm.share_id = fresh; });
    }
    await this.change(manifest => { if (manifest.notes[id]) { manifest.notes[id].sourcePath = keep.path; manifest.notes[id].revision++; } });
  }
  async restoreId(id: string, selected?: TFile): Promise<void> {
    if (this.busy) throw new Error("请等待发布完成。");
    const file = selected || this.host.app.vault.getAbstractFileByPath(this.manifest.notes[id].sourcePath);
    if (!(file instanceof TFile)) throw new Error("原路径没有笔记，请先移动原笔记回该路径，或在分享清单中重新关联。");
    if (this.index().has(id)) throw new Error("原 ID 仍被其他笔记使用。");
    await this.host.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (fm.share_id !== undefined) throw new Error("笔记已有其他 ID，停止覆盖。"); fm.share_id = id;
    }); await this.change(manifest => { manifest.notes[id].sourcePath = file.path; manifest.notes[id].revision++; });
  }
  scan(): Promise<void> {
    if (this.busy) return Promise.resolve();
    if (this.scanTask) { this.scanAgain = true; return this.scanTask; }
    this.scanTask = (async () => {
      do { this.scanAgain = false; await this.scanNow(); } while (this.scanAgain && !this.busy);
    })().finally(() => { this.scanTask = undefined; });
    return this.scanTask;
  }
  private async scanNow(): Promise<void> {
    const request = ++this.scanRequest;
    await this.mutation; await this.reload();
    const adapter = this.host.app.vault.adapter;
    this.published = await adapter.exists(`${SHARE_FOLDER}/publish-state.json`) ? (await new ShareRepository(this.host, this.manifest.site).state()) : { version: 1, notes: {}, files: [] };
    const index = await this.scanIndex(), rows: Row[] = [], moved: Record<string, string> = {};
    for (const [id, entry] of Object.entries(this.manifest.notes)) {
      if (request !== this.scanRequest || this.busy) return;
      const files = index.get(id) || [], old = this.published.notes[id];
      const row: Row = { id, title: files[0]?.basename || old?.title || entry.sourcePath.split("/").pop() || id, file: files.length === 1 ? files[0] : undefined, state: "" };
      if (row.file && row.file.path !== entry.sourcePath) moved[id] = row.file.path;
      if (!entry.enabled) row.state = remoteConflict(entry, this.published, id) ? "云端已变更，需确认" : old ? "待撤下" : "已撤下";
      else if (files.length > 1) row.state = "ID 冲突";
      else if (!row.file) row.state = "源文件缺失或 ID 丢失";
      else {
        try {
          const exported = await exportNote(this.host, row.file, entry.category, this.manifest, index, entry.publicName);
          row.state = remoteConflict(entry, this.published, id, exported.hash) ? "云端已变更，需确认" : !old ? "待发布" : old.hash !== exported.hash ? "待更新" : "已发布";
        } catch (error) { row.state = `导出异常：${error instanceof Error ? error.message : String(error)}`; }
      }
      rows.push(row);
    }
    for (const [id, note] of Object.entries(this.published.notes)) if (!this.manifest.notes[id]) rows.push({ id, title: note.title, state: "未关联，保留线上版本" });
    if (request !== this.scanRequest || this.busy) return;
    if (Object.keys(moved).length && !this.host.sync.isSyncing() && !(await this.local()).job) await this.change(manifest => { for (const [id, path] of Object.entries(moved)) if (manifest.notes[id]) manifest.notes[id].sourcePath = path; }, false);
    this.rows = rows; this.renderViews();
  }
  private async local(): Promise<LocalState> {
    const adapter = this.host.app.vault.adapter;
    const path = this.path("share-local.json");
    if (!await adapter.exists(path)) return { version: 1 };
    const value = JSON.parse(await adapter.read(path)) as LocalState;
    if (value.version !== 1 || value.job && (!value.job.expected || Object.keys(value.job.expected).some(path => !/^(?:index\.html|\.nojekyll|catalog\.json|publish-state\.json|(?:notes|assets|reader)\/[A-Za-z0-9._/-]+)$/.test(path) || path.includes("..")))) throw new Error("本机发布恢复记录异常。");
    return value;
  }
  private saveLocal(value: LocalState): Promise<void> { return this.host.app.vault.adapter.write(this.path("share-local.json"), JSON.stringify(value, null, 2)); }
  async publish(initialize = false, onlyId?: string): Promise<void> {
    if (Platform.isMobile) throw new Error("请在桌面端发布分享。");
    if (this.templateBusy) throw new Error("模板正在保存，请稍后推送。");
    if (this.busy || this.host.sync.isSyncing()) throw new Error("已有分享或主库同步任务正在运行。");
    await this.mutation; await this.reload();
    if (!this.manifest.enabled) throw new Error("笔记分享已关闭。");
    if (this.busy || this.host.sync.isSyncing()) throw new Error("已有分享或主库同步任务正在运行。");
    if (!this.sharing) this.publishingTitle = onlyId ? this.manifest.notes[onlyId]?.sourcePath.split("/").pop()?.replace(/\.md$/, "") || "" : "";
    this.busy = true; this.error = ""; this.status = "正在核验主库与分享仓库…"; this.renderViews();
    try {
      const snapshot = serializeManifest(this.manifest);
      const template = await this.readTemplate();
      const repository = new ShareRepository(this.host, this.manifest.site);
      await repository.checkPrivateFreshness(); await repository.ensure();
      const local = await this.local();
      if (onlyId && local.job) throw new Error("存在待恢复的发布，请先在分享侧栏点击「推送新分享」恢复。");
      const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
      if (local.job && local.site !== key) throw new Error("存在另一个仓库的未完成发布，请先恢复原仓库发布。");
      await repository.refresh(local.job);
      if (local.job?.manifest && local.job.manifest !== await sha256(snapshot)) throw new Error("分享清单与上次未完成发布不同，停止恢复旧内容；请先检查并恢复对应清单。");
      if (local.job?.templateHash && local.job.templateHash !== await sha256(template)) throw new Error("HTML 模板与上次未完成发布不同，请恢复对应模板后重试。");
      let job = local.job;
      if (!job) {
        const old = await repository.state();
        const state: PublishState = { version: 1, notes: { ...old.notes }, intents: { ...old.intents }, files: [] };
        const files = websiteFiles(template);
        files.set("reader/appearance.css", shareAppearance(this.host));
        const index = this.index();
        if (onlyId) {
          if (!this.manifest.notes[onlyId]?.enabled) throw new Error("当前笔记尚未开启分享。");
          // Frontmatter writes can finish before Obsidian's metadata cache updates.
          const file = this.host.app.vault.getAbstractFileByPath(this.manifest.notes[onlyId].sourcePath);
          if (file instanceof TFile && !(index.get(onlyId) || []).some(candidate => candidate.path === file.path)) {
            const source = await this.host.app.vault.read(file);
            const yaml = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
            if (yaml && (parseYaml(yaml) as { share_id?: unknown })?.share_id === onlyId) index.set(onlyId, [...(index.get(onlyId) || []), file]);
          }
        }
        const visible = onlyId ? { ...this.manifest, notes: Object.fromEntries(Object.entries(this.manifest.notes).map(([id, entry]) => [id, { ...entry, enabled: id === onlyId ? entry.enabled : !!old.notes[id] }])) } : this.manifest;
        const failures: string[] = [];
        for (const [id, entry] of Object.entries(this.manifest.notes)) {
          if (initialize || onlyId && id !== onlyId) continue;
          if (remoteConflict(entry, old, id)) { failures.push(`${entry.sourcePath}：云端分享设置已改变，请先同步或确认采用本机设置`); continue; }
          if (!entry.enabled) { delete state.notes[id]; state.intents![id] = { enabled: false, category: entry.category, ...(entry.publicName ? { publicName: entry.publicName } : {}), hash: await intentHash(entry) }; continue; }
          const matches = index.get(id) || [];
          if (matches.length !== 1) { failures.push(`${entry.sourcePath}：源文件缺失或 ID 重复`); continue; }
          try {
            const result = await exportNote(this.host, matches[0], entry.category, visible, index, entry.publicName);
            if (remoteConflict(entry, old, id, result.hash)) { failures.push(`${matches[0].basename}：云端正文已改变，请先同步或确认采用本机版本`); continue; }
            files.set(`notes/${id}.md`, result.source);
            for (const [path, data] of result.assets) files.set(path, data);
            state.notes[id] = { title: result.title, category: result.category, hash: result.hash, assets: [...result.assets.keys()].sort() };
            state.intents![id] = { enabled: true, category: entry.category, ...(entry.publicName ? { publicName: entry.publicName } : {}), hash: await intentHash(entry) };
          } catch (error) { failures.push(`${matches[0].basename}：${String(error)}`); }
        }
        // Keep the remote copy and its assets for missing, unassociated or failed notes.
        for (const [id, note] of Object.entries(state.notes)) {
          const path = `notes/${id}.md`;
          if (!files.has(path)) files.set(path, await this.host.app.vault.adapter.read(`${SHARE_FOLDER}/${path}`));
          for (const asset of note.assets) if (!files.has(asset)) files.set(asset, await this.host.app.vault.adapter.readBinary(`${SHARE_FOLDER}/${asset}`));
        }
        files.set("catalog.json", JSON.stringify({ version: 1, notes: Object.entries(state.notes).map(([id, note]) => ({ id, title: note.title, category: note.category })).sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title)) }, null, 2));
        files.set("publish-state.json", ""); state.files = [...files.keys()].sort();
        files.set("publish-state.json", JSON.stringify(state, null, 2));
        await this.reload();
        if (serializeManifest(this.manifest) !== snapshot) throw new Error("分享设置在生成期间发生变化，请重新发布。");
        if (template !== await this.readTemplate()) throw new Error("HTML 模板在生成期间发生变化，请重新推送。");
        if (failures.length) {
          // Stop before mutation so the user sees exactly which updates cannot be applied.
          throw new Error(`以下笔记异常；线上版本保留，请处理后重试：\n${failures.join("\n")}`);
        }
        this.status = "正在生成公开文件…"; this.renderViews();
        const manifestHash = await sha256(snapshot);
        const templateHash = await sha256(template);
        job = await repository.writeFiles(files, old, job => { job.manifest = manifestHash; job.templateHash = templateHash; return this.saveLocal({ version: 1, site: key, job }); });
      }
      this.status = "正在推送公开仓库…"; this.renderViews();
      const commit = await repository.push(job, job => this.saveLocal({ version: 1, site: key, job }));
      await this.saveLocal({ version: 1, site: key, commit });
      const result = await repository.state();
      await this.reload();
      for (const [id, entry] of Object.entries(this.manifest.notes)) {
        const intent = result.intents?.[id];
        if (intent && intent.hash === await intentHash(entry)) { entry.baseIntent = intent.hash; entry.baseHash = result.notes[id]?.hash; }
      }
      await this.host.app.vault.adapter.write(this.path("share-manifest.json"), serializeManifest(this.manifest));
      this.status = "已推送，正在检查网站部署…"; this.renderViews();
      try {
        await repository.configurePages(); this.status = await repository.deployment(commit);
        this.manifest.site.initialized = true;
        await this.host.app.vault.adapter.write(this.path("share-manifest.json"), serializeManifest(this.manifest));
      }
      catch (error) { this.status = "仓库已推送；Pages 需要检查"; this.error = error instanceof Error ? error.message : String(error); }
      new Notice(`笔记分享：${this.status}`, 8000);
    } finally { this.busy = false; await this.scan().catch(error => this.fail(error)); this.renderViews(); }
  }
  async checkDeployment(): Promise<void> {
    if (this.checkingDeployment || this.isPublishing) throw new Error("已有分享任务正在运行，请稍后检查。");
    this.checkingDeployment = true; this.error = ""; this.status = "正在检查网站部署…"; this.renderViews();
    try {
      const local = await this.local(); if (!local.commit) throw new Error("尚未完成推送，请先初始化网站或点击「推送新分享」。");
      if (local.site !== `${this.manifest.site.owner}/${this.manifest.site.repo}`) throw new Error("最近一次推送属于其他仓库，请重新检查分享仓库配置。");
      const repository = new ShareRepository(this.host, this.manifest.site);
      this.status = await repository.deployment(local.commit);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error); throw error;
    } finally { this.checkingDeployment = false; this.renderViews(); }
  }
  async open(closeSettings = false): Promise<void> {
    const existing = this.host.app.workspace.getLeavesOfType(VIEW)[0];
    const leaf = existing || this.host.app.workspace.getRightLeaf(false);
    if (!leaf) return; if (!existing) await leaf.setViewState({ type: VIEW, active: true });
    await this.host.app.workspace.revealLeaf(leaf);
    if (closeSettings) (this.host.app as typeof this.host.app & { setting?: { close(): void } }).setting?.close();
    void this.scan().catch(error => this.fail(error));
  }
  private renderViews(): void {
    this.refreshActions();
    for (const leaf of this.host.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof ShareView) leaf.view.render();
    if (this.setupHost?.isConnected) this.renderSettings(this.setupHost, this.setupGuide, this.setupShowTitle);
  }
  get isPublishing(): boolean { return this.busy || this.sharing; }
  restoreDisplay(state: Record<string, unknown>): void {
    if (this.displayStored) return;
    if (typeof state.showPaths === "boolean" && state.layout !== undefined) this.display.showPaths = state.showPaths;
    if (typeof state.showCancelled === "boolean") this.display.showCancelled = state.showCancelled;
    if (typeof state.descending === "boolean") this.display.descending = state.descending;
    if (state.layout === "list" || state.layout === "source" || state.layout === "public") this.display.layout = state.layout;
  }
  updateDisplay(change: Partial<ShareDisplaySettings>): void {
    Object.assign(this.display, change); this.displayStored = true;
    this.host.app.workspace.requestSaveLayout(); this.renderViews();
  }
  private async readTemplate(): Promise<string> {
    const adapter = this.host.app.vault.adapter;
    const path = this.path("share-template.html");
    const source = await adapter.exists(path) ? await adapter.read(path) : DEFAULT_SHARE_TEMPLATE;
    if (source !== DEFAULT_SHARE_TEMPLATE) validateShareTemplate(source);
    this.template = source; return source;
  }
  private async saveTemplate(source: string, message: string): Promise<void> {
    if (this.isPublishing || this.templateBusy || this.host.sync.isSyncing()) throw new Error("请等待分享或主库同步任务完成后再更换模板。");
    if (source !== DEFAULT_SHARE_TEMPLATE) validateShareTemplate(source);
    this.templateBusy = true; this.renderViews();
    try {
      if ((await this.local()).job) throw new Error("存在未完成的发布，请先恢复发布再更换模板。");
      const adapter = this.host.app.vault.adapter;
      const path = this.path("share-template.html");
      if (await adapter.exists(path)) await adapter.write(this.path("share-template.previous.html"), await adapter.read(path));
      await adapter.write(path, source); this.template = source; this.templateMessage = message;
    } finally { this.templateBusy = false; this.renderViews(); }
  }
  private importTemplate(): void {
    const input = createEl("input"); input.type = "file"; input.accept = ".html,.htm,text/html";
    input.addEventListener("change", () => {
      const file = input.files?.[0]; if (!file) return;
      void (async () => {
        if (file.size > 2 * 1024 * 1024) throw new Error("请选择小于 2 MB 的 HTML 模板。");
        await this.saveTemplate(await file.text(), "模板已导入，点击「推送新分享」后网站生效。");
      })().catch(error => { this.templateMessage = error instanceof Error ? error.message : String(error); this.renderViews(); new Notice(this.templateMessage); });
    }, { once: true });
    input.click();
  }
  private async exportTemplate(): Promise<void> {
    const template = await this.readTemplate();
    const url = URL.createObjectURL(new Blob([template], { type: "text/html;charset=utf-8" }));
    const link = createEl("a"); link.href = url; link.download = "share-template.html";
    document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  addPublishButton(setting: Setting): Setting {
    return setting.addButton(button => button.setButtonText(this.isPublishing ? "推送中…" : "推送新分享")
      .setTooltip("检查并发布所有笔记变化，包括更新与撤下")
      .setDisabled(this.isPublishing || this.checkingDeployment || this.templateBusy || Platform.isMobile || !this.manifest.site.repo || !this.manifest.enabled)
      .onClick(() => { void this.publish().catch(error => this.fail(error)); }).buttonEl.addClass("simple-share-publish"));
  }
  renderPanel(container: HTMLElement, query: string, showCancelled: boolean, showPaths = false, layout: ShareLayout = "list", collapsed = new Set<string>(), onFolderToggle?: () => void, descending = false): void {
    container.empty();
    const compareNames = (a: string, b: string): number => (descending ? -1 : 1) * a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
    const displayName = (row: Row): string => layout === "public" ? this.manifest.notes[row.id]?.publicName || this.published.notes[row.id]?.title || row.title : row.title;
    const rows = this.rows.filter(row => {
      const entry = this.manifest.notes[row.id];
      return (showCancelled || row.state !== "已撤下") && `${row.title} ${row.file?.path || entry?.sourcePath || ""} ${entry?.category || this.published.notes[row.id]?.category || ""} ${entry?.publicName || ""} ${row.state}`.toLowerCase().includes(query.toLowerCase());
    }).sort((a, b) => compareNames(displayName(a), displayName(b)) || compareNames(a.id, b.id));
    const targets = new Map<string, HTMLElement>();
    if (layout !== "list") {
      const root: ShareFolder = { children: new Map(), rows: [] };
      for (const row of rows) {
        const entry = this.manifest.notes[row.id];
        const path = layout === "public" ? entry?.category ?? this.published.notes[row.id]?.category ?? "" : row.file?.parent?.path ?? entry?.sourcePath.split("/").slice(0, -1).join("/") ?? "";
        let folder = root;
        for (const part of path.split("/").filter(Boolean)) {
          if (!folder.children.has(part)) folder.children.set(part, { children: new Map(), rows: [] });
          folder = folder.children.get(part)!;
        }
        folder.rows.push(row);
      }
      const renderFolder = (folder: ShareFolder, parent: HTMLElement, path: string): void => {
        for (const [name, child] of [...folder.children].sort(([a], [b]) => compareNames(a, b))) {
          const key = `${path}/${name}`;
          const details = parent.createEl("details", { cls: "simple-share-folder" });
          details.open = !!query || !collapsed.has(`${layout}:${key}`);
          const summary = details.createEl("summary", { cls: "simple-share-folder-heading" });
          setIcon(summary.createSpan({ cls: "simple-share-folder-chevron" }), "chevron-right");
          setIcon(summary.createSpan({ cls: "simple-share-folder-icon" }), "folder");
          summary.createSpan({ text: name, cls: "simple-share-folder-name" });
          const body = details.createDiv({ cls: "simple-share-folder-body" });
          details.addEventListener("toggle", () => {
            if (query || !details.isConnected) return;
            if (details.open) collapsed.delete(`${layout}:${key}`); else collapsed.add(`${layout}:${key}`);
            onFolderToggle?.();
          });
          renderFolder(child, body, key);
        }
        for (const row of folder.rows) targets.set(row.id, parent);
      };
      renderFolder(root, container, "");
    }
    if (!rows.length) container.createDiv({ cls: "simple-share-empty", text: query ? "没有匹配的分享笔记" : "暂无分享笔记" });
    for (const row of rows) {
      const entry = this.manifest.notes[row.id];
      const path = row.file?.parent?.path ?? entry?.sourcePath.split("/").slice(0, -1).join("/") ?? "";
      const name = displayName(row);
      const setting = new Setting(targets.get(row.id) || container).setName(name).setDesc(path || "/").setClass("simple-share-note-row");
      setting.settingEl.toggleClass("is-withdrawn", row.state === "已撤下");
      setting.nameEl.setAttribute("title", `${row.title} · ${row.state}`);
      setting.descEl.hidden = !showPaths;
      setting.descEl.setAttribute("title", `原笔记目录：${path || "/"} · 公开分类：${entry?.category || "未分类"}`);
      if (row.file) setting.addButton(button => {
        button.setIcon("simple-share-location").setTooltip("定位原笔记").onClick(runAsync(async () => { await this.host.app.workspace.getLeaf(false).openFile(row.file!); }));
        button.buttonEl.addClass("simple-share-locate");
      });
      if (entry) {
        setting.addButton(button => button.setIcon("folder").setTooltip("修改公开分类与文件名").setDisabled(this.isPublishing).onClick(() => new CategoryModal(this, row.id).open()));
      }
      if (this.published.notes[row.id]) setting.addButton(button => button.setIcon("copy").setTooltip("复制笔记名和分享链接").onClick(runAsync(async () => {
        await navigator.clipboard.writeText(formatShareLink(this.published.notes[row.id].title, `${siteUrl(this.manifest.site)}#/notes/${row.id}`)); new Notice("笔记名和分享链接已复制。");
      })));
      if (entry) {
        setting.addButton(button => {
          button.setIcon(entry.enabled ? "eye" : "eye-off").setTooltip(entry.enabled ? "取消分享（推送新分享后撤下）" : "恢复分享（推送新分享后发布）").setDisabled(this.busy || this.sharing).onClick(() => {
            void this.change(manifest => { const note = manifest.notes[row.id]; note.enabled = !note.enabled; note.revision++; }).catch(error => this.fail(error));
          });
          button.buttonEl.setAttribute("aria-pressed", String(entry.enabled));
          button.buttonEl.toggleClass("is-active", entry.enabled);
        });
        if (row.state === "ID 冲突") setting.addButton(button => button.setIcon("git-compare").setTooltip("解决重复 ID").setDisabled(this.busy).onClick(() => new IdModal(this, row.id, this.index().get(row.id) || []).open()));
        if (row.state === "云端已变更，需确认") setting.addButton(button => button.setIcon("upload").setTooltip("采用本机版本").setDisabled(this.busy).onClick(() => { void this.acceptLocal(row.id).catch(error => this.fail(error)); }));
        if (row.state === "源文件缺失或 ID 丢失") setting.addButton(button => button.setIcon("link").setTooltip("重新关联笔记").setDisabled(this.busy).onClick(() => new RelinkModal(this, row.id).open()));
      } else if (this.published.notes[row.id]) {
        setting.addButton(button => button.setIcon("eye-off").setTooltip("撤下此篇").setDisabled(this.busy).onClick(() => {
          void this.change(manifest => {
            const note = this.published.notes[row.id];
            manifest.notes[row.id] = { enabled: false, sourcePath: "", category: note.category, revision: 1, baseIntent: this.published.intents?.[row.id]?.hash, baseHash: note.hash };
          }).catch(error => this.fail(error));
        }));
      }
    }
  }
  renderSettings(root: HTMLElement, guide: boolean, showTitle = true): void {
    this.setupHost = root; this.setupGuide = guide; this.setupShowTitle = showTitle; root.empty();
    root.toggleClass("simple-one-sync-setup-page", guide);
    const page = root.createDiv({ cls: "simple-one-sync-setup-layout" });
    if (showTitle) new Setting(page).setName(guide ? "笔记分享引导" : "笔记分享设置").setHeading().setClass("simple-page-title");
    if (Platform.isMobile) { page.createEl("p", { text: "请在电脑端创建仓库和发布；本机可以管理分享清单。" }); return; }
    if (!guide) {
      const card = page.createDiv({ cls: "simple-card simple-share-settings-card" });
      new Setting(card).setName("启用笔记分享").setDesc("关闭后暂停本机分享操作，已发布的网站仍然保留。")
        .addToggle(toggle => toggle.setValue(this.manifest.enabled).setDisabled(this.isPublishing || this.checkingDeployment).onChange(async value => { try { await this.change(manifest => { manifest.enabled = value; }); } catch (error) { this.fail(error); } }));
      const dependent = card.createDiv({ cls: `simple-one-sync-engine-body simple-share-settings-dependent${this.manifest.enabled ? "" : " is-disabled"}` });
      dependent.inert = !this.manifest.enabled;
      new Setting(dependent).setName("当前公开仓库").setDesc(this.manifest.site.repo ? `${this.manifest.site.owner}/${this.manifest.site.repo}` : "尚未接入")
        .addButton(button => button.setButtonText("打开分享管理").setDisabled(!this.manifest.enabled).onClick(runAsync(() => this.open(true))));
      const deployment = new Setting(dependent).setName("当前部署状态").setDesc("检查最近一次推送的网站是否已完成部署。 ")
        .addButton(button => button.setButtonText(this.checkingDeployment ? "检查中…" : "检查网站部署").setDisabled(!this.manifest.enabled || this.isPublishing || this.checkingDeployment || !this.manifest.site.repo).onClick(() => { void this.checkDeployment().catch(error => this.fail(error)); }));
      if (this.manifest.site.repo) deployment.descEl.createEl("a", { text: "在 GitHub 检查网站设置 ↗", href: `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}/settings/pages`, attr: { target: "_blank", rel: "noopener noreferrer" } });
      deployment.infoEl.createEl("p", { text: this.error || this.status || (this.manifest.site.initialized ? "网站已初始化，尚未查询当前部署状态。" : "尚未初始化网站。"), cls: `simple-share-deployment-result ${this.error ? "simple-share-error" : "simple-share-status"}`, attr: { role: "status", "aria-live": "polite" } });
      const appearance = settingsSection(page, "界面设置");
      appearance.addClass("simple-share-settings-card", "simple-one-sync-engine-body");
      appearance.toggleClass("is-disabled", !this.manifest.enabled); appearance.inert = !this.manifest.enabled;
      new Setting(appearance).setName("显示文件路径").setDesc("在笔记名称旁显示原笔记所在目录。")
        .addToggle(toggle => toggle.setValue(this.display.showPaths).setDisabled(!this.manifest.enabled).onChange(value => this.updateDisplay({ showPaths: value })));
      new Setting(appearance).setName("显示已撤下笔记").setDesc("在分享列表中保留已撤下的笔记，以浅灰色显示。")
        .addToggle(toggle => toggle.setValue(this.display.showCancelled).setDisabled(!this.manifest.enabled).onChange(value => this.updateDisplay({ showCancelled: value })));
      new Setting(appearance).setName("列表布局")
        .addDropdown(dropdown => dropdown.addOptions({ list: "平铺笔记", source: "本地目录", public: "公开目录" }).setValue(this.display.layout).setDisabled(!this.manifest.enabled).onChange(value => {
          if (value === "list" || value === "source" || value === "public") this.updateDisplay({ layout: value });
        }));
      new Setting(appearance).setName("名称排序")
        .addDropdown(dropdown => dropdown.addOptions({ asc: "正序 A→Z", desc: "倒序 Z→A" }).setValue(this.display.descending ? "desc" : "asc").setDisabled(!this.manifest.enabled).onChange(value => this.updateDisplay({ descending: value === "desc" })));
      const templateDisabled = !this.manifest.enabled || this.isPublishing || this.templateBusy;
      const templateSetting = new Setting(appearance).setName("HTML 模板").setDesc("导入单个 HTML 文件，可内嵌 CSS；保留阅读器所需元素与脚本。模板随主库同步。")
        .addButton(button => button.setButtonText("导入模板").setDisabled(templateDisabled).onClick(() => this.importTemplate()))
        .addButton(button => button.setButtonText("导出模板").setDisabled(templateDisabled).onClick(() => { void this.exportTemplate().catch(error => this.fail(error)); }))
        .addButton(button => button.setButtonText("恢复默认模板").setDisabled(templateDisabled).onClick(() => {
          void this.saveTemplate(DEFAULT_SHARE_TEMPLATE, "已恢复默认模板，点击「推送新分享」后网站生效。").catch(error => {
            this.templateMessage = error instanceof Error ? error.message : String(error); this.renderViews(); new Notice(this.templateMessage);
          });
        }));
      templateSetting.infoEl.createEl("p", { text: this.templateBusy ? "正在保存模板…" : this.templateMessage || (this.template === DEFAULT_SHARE_TEMPLATE ? "当前使用默认模板。" : "当前使用自定义 HTML 模板。"), cls: "simple-share-template-status", attr: { role: "status", "aria-live": "polite" } });
      return;
    }
    const steps = ["安装与授权", "公开仓库", "初始化网站", "完成"];
    const completed = !!this.manifest.site.repo && this.manifest.site.initialized === true;
    const status = page.createDiv({ cls: `simple-one-sync-setup-status is-${this.error ? "error" : completed ? "success" : "disconnected"}`, attr: { role: "status" } });
    setIcon(status.createSpan({ cls: "simple-one-sync-setup-status__icon" }), this.error ? "triangle-alert" : completed ? "check" : "unplug");
    const copy = status.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    copy.createEl("strong", { text: this.error ? "分享设置需要检查" : completed ? "分享库首次设置已完成" : this.manifest.site.repo ? "分享仓库已连接，首次设置待核验" : "分享库首次设置尚未完成" });
    copy.createEl("p", { text: this.error || (completed ? "公开仓库与阅读页面已初始化；网站当前部署状态可在分享设置中检查。" : "按下方步骤完成授权、连接公开仓库并初始化网站。") });
    const restart = status.createEl("button", { text: "重新检查或修复分享设置", attr: { type: "button" } });
    restart.disabled = this.setupBusy || this.isPublishing;
    restart.addEventListener("click", () => {
      if (restart.disabled) return;
      this.authController?.abort(); this.authorized = false; this.token = "";
      this.guideStep = 1; this.guideAvailableStep = 1; this.error = ""; this.status = "";
      this.renderViews();
    });
    const nav = page.createDiv({ cls: "simple-one-sync-setup-nav" });
    steps.forEach((label, index) => {
      const step = index + 1;
      const button = nav.createEl("button", {
        cls: `simple-one-sync-setup-nav__step${step === this.guideStep ? " is-active" : ""}${step < this.guideAvailableStep ? " is-done" : ""}`,
        attr: { type: "button", "aria-current": step === this.guideStep ? "step" : "false" }
      });
      button.createSpan({ text: String(step), cls: "simple-one-sync-setup-nav__marker" });
      button.createSpan({ text: label, cls: "simple-one-sync-setup-nav__label" });
      button.disabled = step > this.guideAvailableStep || this.setupBusy || this.busy;
      button.addEventListener("click", () => {
        if (step > this.guideAvailableStep || this.setupBusy || this.busy) return;
        this.guideStep = step; this.renderViews();
      });
    });
    const container = page.createDiv({ cls: "simple-one-sync-card simple-one-sync-setup-body simple-share-guide-body" });
    if (this.guideStep !== 2 && (this.error || this.status)) container.createEl("p", { text: this.error || this.status, cls: this.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback", attr: { role: "status", "aria-live": "polite" } });
    const run = (work: () => Promise<void>): void => {
      if (this.setupBusy || this.busy) return;
      this.setupBusy = true; this.error = ""; this.renderViews();
      void work().catch(error => this.fail(error)).finally(() => { this.setupBusy = false; this.token = ""; this.renderViews(); });
    };
    const action = (label: string, work: () => Promise<void>, parent = container) => new Setting(parent).addButton(button => button.setButtonText(label).setDisabled(this.setupBusy || this.busy).onClick(() => run(work)));
    if (this.guideStep === 1) {
      container.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-platform-step");
      const heading = container.createDiv({ cls: "simple-one-sync-setup-section-header" });
      new Setting(heading).setName("GitHub 笔记分享").setHeading();
      heading.createSpan({ text: "当前仅支持 GitHub", cls: "simple-one-sync-setup-badge" });
      const content = container.createDiv({ cls: "simple-one-sync-setup-platform-content", attr: { role: "group", "aria-label": "GitHub 分享接入步骤" } });
      const tools = content.createDiv({ cls: "simple-one-sync-setup-detail" });
      new Setting(tools).setName("安装工具").setHeading();
      tools.createEl("p", { text: "GitHub 用于存放公开分享仓库，并提供笔记展示网站。电脑端需要 Git 发布文件，GitHub CLI 用于登录、建仓和仓库核验。若没有 GitHub 账号，请先完成注册。" });
      const link = (parent: HTMLElement, text: string, href: string): void => { parent.createEl("a", { text, href, attr: { target: "_blank", rel: "noopener noreferrer" } }); };
      const links = tools.createDiv({ cls: "simple-one-sync-setup-links" });
      link(links, "下载 Git ↗", "https://git-scm.com/downloads");
      link(links, "下载 GitHub CLI ↗", "https://cli.github.com/");
      link(links, "注册 GitHub ↗", "https://github.com/signup");
      const auth = content.createDiv({ cls: "simple-one-sync-setup-detail simple-one-sync-setup-auth" });
      new Setting(auth).setName("选择 GitHub 授权方式").setHeading();
      const verify = async () => {
        await this.host.sync.exec("git", ["--version"]); await this.host.sync.exec("gh", ["auth", "status", "--active", "--hostname", "github.com"]);
        const account = JSON.parse(await this.host.sync.exec("gh", ["api", "user"])) as { login: string };
        this.authorized = true; this.status = `已验证 GitHub 账号：${account.login}`; this.guideStep = 2; this.guideAvailableStep = Math.max(this.guideAvailableStep, 2);
      };
      const browserLogin = async () => {
        this.authController = new AbortController(); this.deviceCode = ""; let output = "";
        await this.host.sync.exec("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"], false, true, 300000, chunk => {
          output += chunk; const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
          if (code && code !== this.deviceCode) { this.deviceCode = code; this.renderViews(); }
        }, undefined, this.authController.signal); await verify();
      };
      const options = auth.createDiv({ cls: "simple-one-sync-setup-options" });
      for (const mode of ["browser", "token", "verify"] as const) {
        const button = options.createEl("button", {
          text: mode === "browser" ? "浏览器登录授权" : mode === "token" ? "Token 授权" : "验证已有授权",
          cls: `simple-one-sync-setup-option${this.authMode === mode ? " is-selected" : ""}`,
          attr: { type: "button", "aria-pressed": String(this.authMode === mode) }
        });
        button.disabled = this.setupBusy || this.busy;
        button.addEventListener("click", () => {
          if (this.setupBusy || this.busy) return;
          this.authMode = mode; this.authorized = false; this.token = ""; this.error = ""; this.status = ""; this.deviceCode = "";
          if (mode === "browser") run(browserLogin);
          else if (mode === "verify") run(verify);
          else this.renderViews();
        });
      }
      if (this.authMode === "browser") {
        const instructions = auth.createEl("p");
        instructions.append("在下方获取设备码，然后在浏览器中");
        link(instructions, "打开 GitHub 设备码填写页 ↗", "https://github.com/login/device");
        instructions.append("，按提示登录、输入设备码并完成授权。授权完成后会自动核验并进入下一步。");
        const deviceAction = auth.createDiv({ cls: "simple-one-sync-setup-device-action" });
        deviceAction.createEl("code", { text: this.deviceCode || (this.setupBusy ? "正在获取…" : ""), cls: `simple-one-sync-setup-device-slot${this.deviceCode ? " simple-one-sync-setup-device-code" : ""}`, attr: { "aria-live": "polite" } });
        const copy = deviceAction.createEl("button", { cls: "simple-one-sync-setup-device-icon-button", attr: { type: "button", "aria-label": "复制设备码", title: "复制设备码" } });
        setIcon(copy, "copy"); copy.disabled = !this.deviceCode;
        copy.addEventListener("click", runAsync(async () => { await navigator.clipboard.writeText(this.deviceCode); }));
        const refresh = deviceAction.createEl("button", { cls: "simple-one-sync-setup-device-icon-button", attr: { type: "button", "aria-label": "刷新设备码", title: "刷新设备码" } });
        setIcon(refresh, "refresh-cw"); refresh.disabled = this.setupBusy || this.busy;
        refresh.addEventListener("click", () => run(browserLogin));
        if (this.setupBusy) new Setting(auth).addButton(button => button.setButtonText("取消授权等待").onClick(() => this.authController?.abort()));
      } else if (this.authMode === "token") {
        auth.createEl("p", { text: "本插件不在设置中保存 token；token 会交给本机 GitHub CLI 保存，用于登录与后续发布。" });
        const tokenHint = auth.createDiv({ cls: "simple-one-sync-setup-token-hint" });
        setIcon(tokenHint.createSpan({ cls: "simple-one-sync-setup-token-hint__icon", attr: { "aria-hidden": "true" } }), "circle-alert");
        tokenHint.createSpan({ text: "使用传统个人令牌（Classic Token），通过本机 GitHub CLI 核验后再继续连接公开分享仓库。" });
        let submit: HTMLButtonElement | undefined;
        const tokenSetting = new Setting(auth).setName("GitHub token").addText(text => {
          text.inputEl.type = "password"; text.inputEl.autocomplete = "off"; text.inputEl.disabled = this.setupBusy || this.busy;
          text.setPlaceholder("粘贴 token").setValue(this.token).onChange(value => { this.token = value; if (submit) submit.disabled = this.setupBusy || this.busy || !value.trim(); });
        });
        tokenSetting.settingEl.addClass("simple-one-sync-setup-token-setting");
        link(tokenSetting.descEl, "前往 GitHub 创建 Token ↗", "https://github.com/settings/tokens");
        new Setting(auth).addButton(button => {
          submit = button.buttonEl;
          button.setButtonText("已填写 token，验证授权").setCta().setDisabled(this.setupBusy || this.busy || !this.token.trim()).onClick(() => {
            const token = this.token.trim();
            if (!token) return;
            this.token = "";
            run(async () => {
              await this.host.sync.exec("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], false, true, 120000, undefined, token + "\n"); await verify();
            });
          });
        }).settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
      } else if (this.authMode === "verify") {
        auth.createEl("p", { text: this.setupBusy ? "正在验证当前 GitHub CLI 登录状态…" : this.authorized ? "当前 GitHub CLI 登录状态已核验。" : "选择后会自动验证当前 GitHub CLI 登录状态。", cls: "simple-one-sync-setup-feedback" });
        if (this.error && !this.setupBusy) action("重新验证", verify, auth).settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
      }
    } else if (this.guideStep === 2) {
      container.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-repository");
      const mode = this.repoMode ?? (this.manifest.site.repo ? "existing" : "create");
      const options = container.createDiv({ cls: "simple-one-sync-setup-options" });
      for (const choice of ["create", "existing"] as const) {
        const button = options.createEl("button", {
          text: choice === "create" ? "新建公开分享仓库" : "使用已有公开分享仓库",
          cls: `simple-one-sync-setup-option${mode === choice ? " is-selected" : ""}`,
          attr: { type: "button", "aria-pressed": String(mode === choice) }
        });
        button.disabled = this.setupBusy || this.busy;
        button.addEventListener("click", () => {
          if (this.setupBusy || this.busy) return;
          this.repoMode = choice; this.error = ""; this.repositoryFeedback = ""; this.renderViews();
        });
      }
      const card = container.createDiv({ cls: "simple-one-sync-setup-detail" });
      const feedback = (checks = false): void => {
        const area = card.createDiv({ cls: "simple-share-repo-feedback", attr: { role: "status", "aria-live": "polite" } });
        if (checks) {
          area.createEl("p", { text: "将核验以下项目：", cls: "simple-one-sync-setup-helper" });
          const list = area.createEl("ul", { cls: "simple-one-sync-setup-helper" });
          for (const text of ["仓库地址可访问，并读取默认分支", "仓库公开、未归档，当前账号具有写入权限", "与已绑定的分享仓库一致，避免连接到其他仓库"]) list.createEl("li", { text });
        }
        if (this.error || this.repositoryFeedback) area.createEl("p", { text: this.error || this.repositoryFeedback, cls: this.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback" });
        if (!checks && this.takenRepository) {
          const taken = this.takenRepository;
          const use = area.createEl("button", { text: "使用这个已有仓库", attr: { type: "button" } });
          use.disabled = this.setupBusy || this.isPublishing;
          use.addEventListener("click", () => {
            if (use.disabled) return;
            this.repoMode = "existing"; this.draftRepo = `https://github.com/${taken.owner}/${taken.name}`;
            this.error = ""; this.repositoryFeedback = "已填入重名仓库地址，请核验后连接。"; this.takenRepository = undefined;
            this.renderViews();
          });
        }
      };
      if (mode === "create") {
        const suggested = this.suggestedRepoName();
        new Setting(card).setName("创建公开分享仓库").setHeading();
        new Setting(card).setName("新仓库名称").setDesc(`可自定义名称；留空使用 ${suggested}。仅创建公开仓库。`)
          .addText(text => {
            text.inputEl.disabled = this.setupBusy || this.busy;
            text.setValue(this.draftName).setPlaceholder(suggested).onChange(value => {
              this.draftName = value; this.takenRepository = undefined; this.repositoryFeedback = ""; this.error = "";
              card.querySelector(".simple-share-repo-feedback")?.replaceChildren();
            });
          }).settingEl.addClass("simple-one-sync-setup-repo-name");
        feedback();
        action("创建公开分享仓库", async () => {
          await this.createRepository(this.draftName.trim() || suggested);
        }, card).settingEl.addClass("simple-one-sync-setup-action");
      } else {
        new Setting(card).setName("连接已有公开分享仓库").setHeading();
        new Setting(card).setName("GitHub 仓库地址").setDesc("换设备或恢复引导时连接原来的公开分享仓库。")
          .addText(text => {
            text.inputEl.disabled = this.setupBusy || this.busy;
            text.setPlaceholder("https://github.com/用户名/分享仓库.git").setValue(this.draftRepo || (this.manifest.site.repo ? `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}` : "")).onChange(value => { this.draftRepo = value; });
          }).settingEl.addClass("simple-one-sync-setup-repo-url");
        feedback(true);
        action("核验并连接已有仓库", async () => {
          const input = this.draftRepo || `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}`;
          const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(input.trim());
          if (!match) throw new Error("请输入 GitHub 仓库 HTTPS 地址。"); await this.bind(match[1], match[2]);
        }, card).settingEl.addClass("simple-one-sync-setup-action");
      }
    } else if (this.guideStep === 3) {
      container.createEl("p", { text: `将初始化 ${this.manifest.site.owner}/${this.manifest.site.repo} 的阅读器。此步骤不发布任何新增笔记。` });
      action("初始化并检查 Pages", async () => { await this.publish(true); if (this.error) throw new Error(this.error); this.guideStep = 4; this.guideAvailableStep = 4; });
      container.createEl("a", { text: "手动检查 GitHub 网站配置", href: `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}/settings/pages` });
    } else {
      container.createEl("p", { text: `网站：${siteUrl(this.manifest.site)}` });
      action("打开分享管理", async () => { await this.open(true); });
    }
  }
  private async createRepository(name: string): Promise<void> {
    this.takenRepository = undefined;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || [".", ".."].includes(name)) throw new Error("仓库名只能包含字母、数字、点、下划线和连字符。");
    this.reportRepository("正在确认 GitHub 账号…");
    const owner = (await this.host.sync.exec("gh", ["api", "user", "--jq", ".login"])).trim();
    if (this.manifest.site.repo && (this.manifest.site.repo.toLowerCase() !== name.toLowerCase() || this.manifest.site.owner.toLowerCase() !== owner.toLowerCase())) throw new Error("已绑定分享仓库；第一版不支持直接迁移，请继续原仓库。");
    const taken = () => {
      this.takenRepository = { owner, name };
      return new Error(`仓库名称已被使用：${owner}/${name}。请更换名称，或选择「使用已有公开分享仓库」连接原仓库。`);
    };
    let exists = false;
    this.reportRepository(`正在检查仓库名称 ${owner}/${name} 是否已被使用…`);
    try { await this.host.sync.exec("gh", ["api", `repos/${owner}/${name}`]); exists = true; }
    catch (error) { if (!String(error).includes("404")) throw error; }
    if (exists) throw taken();
    this.reportRepository(`仓库名称可用，正在创建公开分享仓库 ${owner}/${name}…`);
    try { await this.host.sync.exec("gh", ["repo", "create", `${owner}/${name}`, "--public"]); }
    catch (error) {
      if (/already exists|already been taken|name[^\n]*taken/i.test(String(error))) throw taken();
      throw error;
    }
    await this.bind(owner, name);
  }
  private async bind(owner: string, repo: string): Promise<void> {
    this.reportRepository("正在核验仓库地址与当前分享配置…");
    if (this.manifest.site.repo && `${owner}/${repo}`.toLowerCase() !== `${this.manifest.site.owner}/${this.manifest.site.repo}`.toLowerCase()) throw new Error("已绑定另一个分享仓库，不能直接切换。");
    const value = JSON.parse(await this.host.sync.exec("gh", ["api", `repos/${owner}/${repo}`])) as { default_branch?: string };
    const site = { owner, repo, branch: value.default_branch || "main" };
    this.reportRepository(`已读取默认分支 ${site.branch}；正在核验公开状态、归档状态和写入权限…`);
    await new ShareRepository(this.host, site).verify();
    this.reportRepository("核验通过，正在保存分享仓库连接…");
    await this.change(manifest => {
      const initialized = manifest.site.owner.toLowerCase() === owner.toLowerCase() && manifest.site.repo.toLowerCase() === repo.toLowerCase() && manifest.site.branch === site.branch ? manifest.site.initialized : undefined;
      manifest.site = { ...site, ...(initialized !== undefined ? { initialized } : {}) };
    }); this.guideStep = 3; this.guideAvailableStep = Math.max(this.guideAvailableStep, 3);
  }
  private reportRepository(text: string): void {
    this.repositoryFeedback = text;
    if (this.setupBusy) this.renderViews();
  }
  private async acceptLocal(id: string): Promise<void> {
    if (this.busy || this.host.sync.isSyncing()) throw new Error("请等待同步或发布结束。");
    this.busy = true;
    let state: PublishState;
    try { const repository = new ShareRepository(this.host, this.manifest.site); await repository.ensure(); await repository.refresh(); state = await repository.state(); }
    finally { this.busy = false; }
    await this.change(manifest => { const entry = manifest.notes[id]; entry.baseIntent = state.intents?.[id]?.hash; entry.baseHash = state.notes[id]?.hash; entry.revision++; });
    new Notice("已采用本机分享设置；下一次发布将覆盖对应云端版本。");
  }
  detachSettings(): void { this.setupHost = undefined; this.authController?.abort(); this.token = ""; }
}
class ShareView extends ItemView {
  private query = "";
  private get showCancelled(): boolean { return this.feature.display.showCancelled; }
  private get showPaths(): boolean { return this.feature.display.showPaths; }
  private get layout(): ShareLayout { return this.feature.display.layout; }
  private get descending(): boolean { return this.feature.display.descending; }
  private collapsed = new Set<string>();
  constructor(leaf: WorkspaceLeaf, private feature: ShareFeature) { super(leaf); }
  getViewType(): string { return VIEW; }
  getDisplayText(): string { return "笔记分享"; }
  getIcon(): string { return "share-2"; }
  getState(): Record<string, unknown> { return { ...super.getState(), showPaths: this.showPaths, showCancelled: this.showCancelled, layout: this.layout, collapsed: [...this.collapsed], descending: this.descending }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    this.feature.restoreDisplay(state);
    if (Array.isArray(state.collapsed)) this.collapsed = new Set(state.collapsed.filter((key): key is string => typeof key === "string"));
    await super.setState(state, result); this.render();
  }
  async onOpen(): Promise<void> { this.render(); }
  render(): void {
    this.contentEl.empty(); this.contentEl.addClass("simple-share-panel");
    const header = new Setting(this.contentEl)
      .addButton(button => {
        button.setIcon("globe").setTooltip("打开分享网站").setDisabled(!siteUrl(this.feature.manifest.site)).onClick(() => window.open(siteUrl(this.feature.manifest.site), "_blank", "noopener"));
        button.buttonEl.addClass("simple-share-header-icon", "clickable-icon", "nav-action-button");
      })
      .addButton(button => {
        const labels: Record<ShareLayout, string> = { list: "平铺笔记", source: "本地目录", public: "公开目录" };
        button.setIcon(this.layout === "list" ? "list" : this.layout === "source" ? "folder-tree" : "network")
          .setTooltip(`当前布局：${labels[this.layout]}；点击切换布局`).onClick(event => {
            const menu = new Menu();
            for (const mode of ["list", "source", "public"] as const) menu.addItem(item => item.setTitle(labels[mode]).setIcon(this.layout === mode ? "check" : mode === "list" ? "list" : mode === "source" ? "folder-tree" : "network").onClick(() => {
              this.feature.updateDisplay({ layout: mode });
            }));
            menu.showAtMouseEvent(event);
          });
        button.buttonEl.addClass("simple-share-header-icon", "clickable-icon", "nav-action-button");
      });
    header.addButton(button => {
      button.setIcon(this.descending ? "simple-share-sort-desc" : "simple-share-sort-asc")
        .setTooltip(this.descending ? "名称倒序 Z→A；点击切换正序" : "名称正序 A→Z；点击切换倒序")
        .onClick(() => this.feature.updateDisplay({ descending: !this.descending }));
      button.buttonEl.addClass("simple-share-header-icon", "simple-share-sort-button", "clickable-icon", "nav-action-button");
    });
    header.addButton(button => {
      button.setIcon("settings").setTooltip("界面设置").onClick(event => {
        new Menu().addItem(item => item.setTitle("显示文件路径").setIcon(this.showPaths ? "check-square" : "square").onClick(() => {
          this.feature.updateDisplay({ showPaths: !this.showPaths });
        })).addItem(item => item.setTitle("显示已撤下笔记").setIcon(this.showCancelled ? "check-square" : "square").onClick(() => {
          this.feature.updateDisplay({ showCancelled: !this.showCancelled });
        })).showAtMouseEvent(event);
      });
      button.buttonEl.addClass("simple-share-header-icon", "clickable-icon", "nav-action-button");
    });
    this.feature.addPublishButton(header).settingEl.addClass("simple-share-header");
    const prefix = this.feature.publishingTitle ? `${this.feature.busy ? "正在发布" : ""}《${this.feature.publishingTitle}》 · ` : "";
    if (this.feature.error || this.feature.status || this.feature.isPublishing) {
      this.contentEl.createEl("p", { text: prefix + (this.feature.error || this.feature.status || "正在准备发布…"), cls: this.feature.error ? "simple-share-error" : "simple-share-status", attr: { role: "status", "aria-live": "polite" } });
    }
    const renderList = () => this.feature.renderPanel(body, this.query, this.showCancelled, this.showPaths, this.layout, this.collapsed, () => this.app.workspace.requestSaveLayout(), this.descending);
    new Setting(this.contentEl).addSearch(search => search.setPlaceholder("搜索分享笔记…").setValue(this.query).onChange(value => { this.query = value; renderList(); }))
      .settingEl.addClass("simple-share-search");
    const body = this.contentEl.createDiv(); renderList();
  }
}
