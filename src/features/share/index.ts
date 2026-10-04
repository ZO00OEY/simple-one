import { addIcon, Component, FuzzySuggestModal, ItemView, MarkdownView, Menu, Modal, Notice, Platform, Setting, setIcon, setTooltip, parseYaml, requireApiVersion, TFile, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type SimplePlugin from "../../main";
import { runAsync } from "../../shared/async";
import { confirmAction } from "../../shared/confirm";
import { settingsSection } from "../../shared/settingsLayout";
import { registerMarkdownAction } from "../../shared/markdownAction";
import { ID_PATTERN, SHARE_FOLDER, emptyManifest, DEFAULT_SHARE_COPY_CONTENT, formatShareContent, newShareId, normalizeShareDirectory, parseManifest, parsePublishState, serializeManifest, shareNotePath, siteUrl, type ShareCopyContent, type ShareManifest, type PublishState } from "./model";
import { exportNote } from "./export";
import { ShareRepository, websiteFiles } from "./repository";
import { ApiShareRepository } from "./apiRepository";
import { githubJson } from "../sync/githubApi";
import { shareAppearance } from "./appearance";
import { DEFAULT_TEMPLATE_FILE, TEMPLATE_SELECTION_FILE, bundledReaderFiles, templateAppearance, validateShareTemplate } from "./template";
import { EdgeOneConnection } from "./edgeone";
import { renderEdgeOneGuide, renderEdgeOneRow, shareExternalLink } from "./edgeoneUi";

const VIEW = "simple-one-share";
interface Row { id: string; title: string; state: string; file?: TFile }
type ShareLayout = "list" | "source" | "public";
interface ShareDisplaySettings { showPaths: boolean; layout: ShareLayout; descending: boolean }
interface ShareSelection { mode: "move" | "delete"; selected: Set<string>; onChange(): void }
interface ShareFolder { children: Map<string, ShareFolder>; rows: Row[] }
interface LocalState { version: 1; site?: string; commit?: string; pendingCommit?: string; published?: PublishState }
class CategoryModal extends Modal {
  constructor(private feature: ShareFeature, private id: string) { super(feature.host.app); }
  onOpen(): void {
    this.titleEl.setText("公开目录与文件名");
    let category = this.feature.manifest.notes[this.id].category;
    let publicName = this.feature.manifest.notes[this.id].publicName || "";
    new Setting(this.contentEl).setName("分享库目录").setDesc("例如 写作/人物；保存目录映射后推送生效，不会改变原笔记目录或分享链接。")
      .addText(text => text.setValue(category).onChange(value => { category = value; }));
    new Setting(this.contentEl).setName("公开发布文件名").setDesc("留空沿用原笔记名；不修改本地笔记名或固定分享链接。无需填写 .md 后缀。")
      .addText(text => text.setPlaceholder(this.feature.manifest.notes[this.id].sourcePath.split("/").pop()?.replace(/\.md$/i, "") || "原笔记名").setValue(publicName).onChange(value => { publicName = value; }));
    new Setting(this.contentEl).addButton(button => button.setButtonText("保存").setCta().onClick(runAsync(async () => {
      const name = publicName.trim().replace(/\.md$/i, "");
      if (/[\\/\r\n]/.test(name)) { new Notice("公开文件名不能包含目录分隔符或换行。"); return; }
      await this.feature.moveShares([this.id], category, name); this.close();
    })));
  }
  onClose(): void { this.contentEl.empty(); }
}
export class ShareDirectoryModal extends Modal {
  constructor(private feature: ShareFeature, private ids: string[], private completed: () => void) { super(feature.host.app); }
  onOpen(): void {
    this.titleEl.setText(`文件移动到 · ${this.ids.length} 篇分享笔记`);
    this.modalEl?.addClass("simple-share-directory-modal");
    this.contentEl.addClass("simple-share-directory-picker");
    let directory: string | undefined, working = false, query = "", renaming: string | undefined, creatingParent: string | undefined;
    let folders: { all: string[]; share: string[] } = { all: [], share: [] };
    const toolbar = this.contentEl.createDiv({ cls: "simple-share-directory-toolbar" });
    toolbar.createSpan({ text: "分享专用库" });
    const search = this.contentEl.createEl("input", { cls: "simple-share-directory-search", attr: { type: "search", placeholder: "搜索文件目录…", "aria-label": "搜索文件目录" } });
    const breadcrumb = this.contentEl.createDiv({ cls: "simple-share-directory-breadcrumb" });
    const current = breadcrumb.createSpan();
    const create = breadcrumb.createEl("button", { text: "新建", cls: "simple-share-directory-new", attr: { type: "button" } });
    const form = this.contentEl.createDiv({ cls: "simple-share-directory-create" }); form.hidden = true;
    setIcon(form.createSpan(), "folder");
    const name = form.createEl("input", { attr: { type: "text", placeholder: "目录名称", "aria-label": "目录名称" } });
    const save = form.createEl("button", { text: "保存", attr: { type: "button" } });
    const dismiss = form.createEl("button", { text: "取消", attr: { type: "button" } });
    const list = this.contentEl.createDiv({ cls: "simple-share-directory-list" });
    const feedback = this.contentEl.createEl("p", { cls: "simple-share-directory-feedback", attr: { role: "status", "aria-live": "polite" } });
    const footer = this.contentEl.createDiv({ cls: "simple-share-directory-footer" });
    const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
    const move = footer.createEl("button", { text: "移动到此", cls: "mod-cta", attr: { type: "button" } });
    move.disabled = !this.ids.length;
    const render = () => {
      move.disabled = working || !this.ids.length || !form.hidden;
      current.setText(directory === undefined ? "默认：与各篇原笔记相同的目录" : `分享专用库 / ${directory || "根目录"}`);
      form.remove();
      list.empty();
      // Preserve folders as paths; source-vault choices become destinations in the share library.
      const renderFolder = (parent: HTMLElement, path: string, label: string, children: string[]) => {
        const branch = children.length ? parent.createEl("details", { cls: "simple-share-directory-branch" }) : undefined;
        if (branch) branch.open = true;
        const row = branch ? branch.createEl("summary", { cls: "simple-share-directory-row" }) : parent.createDiv({ cls: "simple-share-directory-row" });
        const choose = row.createEl("button", { cls: "simple-share-directory-choice", attr: { type: "button", "data-directory": path, "aria-pressed": String(directory === path) } });
        setIcon(choose.createSpan(), "folder"); choose.createSpan({ text: label });
        choose.disabled = working; choose.addEventListener("click", event => { event.preventDefault(); directory = path; render(); });
        if (path) choose.addEventListener("contextmenu", event => {
          event.preventDefault(); event.stopPropagation(); directory = path;
          new Menu().addItem(item => item.setTitle("重命名目录").setIcon("pencil").setDisabled(working).onClick(() => {
            creatingParent = undefined; renaming = path; name.value = path.split("/").pop()!; form.hidden = false; render(); name.focus(); name.select();
          })).addItem(item => item.setTitle("删除目录").setIcon("trash-2").setDisabled(working).onClick(() => {
            void run(async () => {
              if (!await this.feature.deleteShareDirectory(path)) return;
              directory = ""; renaming = undefined; creatingParent = undefined; form.hidden = true;
              folders = await this.feature.shareDirectories();
              feedback.setText("目录已删除，其中的分享笔记已安排至根目录；推送新分享后应用到云端。");
            });
          })).showAtMouseEvent(event);
          render();
        });
        if (!form.hidden && path === renaming) { choose.remove(); form.dataset.directory = path; row.append(form); }
        if (branch) {
          const childRoot = branch.createDiv(); renderTree(childRoot, path, children);
        }
      };
      const renderTree = (parent: HTMLElement, prefix: string, paths: string[]) => {
        const names = [...new Set(paths.filter(path => path.startsWith(prefix ? prefix + "/" : "") && path !== prefix)
          .map(path => path.slice(prefix ? prefix.length + 1 : 0).split("/")[0]))].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
        for (const label of names) {
          const path = prefix ? `${prefix}/${label}` : label;
          renderFolder(parent, path, label, paths.filter(candidate => candidate.startsWith(path + "/")));
        }
      };
      renderFolder(list, "", "分享专用库 · 根目录", []);
      const paths = new Set<string>();
      for (const path of folders.share) {
        try { const normalized = normalizeShareDirectory(path); if (normalized) paths.add(normalized); }
        catch { /* Legacy or invalid paths cannot become tree branches. */ }
      }
      if (creatingParent !== undefined && renaming) paths.add(renaming);
      const visible = [...paths].filter(path => path.toLowerCase().includes(query.toLowerCase()) || path === renaming);
      renderTree(list, "", visible);
      if (query && !visible.length) list.createDiv({ text: "没有匹配的目录", cls: "simple-share-empty" });
    };
    search.addEventListener("input", () => { query = search.value.trim(); render(); });
    const cancelEdit = () => { if (creatingParent !== undefined) directory = creatingParent; form.hidden = true; renaming = undefined; creatingParent = undefined; render(); };
    dismiss.addEventListener("click", cancelEdit);
    cancel.addEventListener("click", () => this.close());
    const run = async (action: () => Promise<void>) => {
      if (working) return; working = true; move.disabled = create.disabled = save.disabled = true; render();
      try { await action(); }
      catch (error) { feedback.setText(error instanceof Error ? error.message : String(error)); }
      finally { working = false; create.disabled = save.disabled = false; render(); if (!form.hidden) { name.focus(); name.select(); } }
    };
    save.addEventListener("click", () => { void run(async () => {
      if (!renaming) return;
      const creating = creatingParent !== undefined;
      directory = creatingParent === undefined ? await this.feature.renameShareDirectory(renaming, name.value) : await this.feature.createShareDirectory(creatingParent, name.value);
      creatingParent = undefined; renaming = undefined; name.value = ""; form.hidden = true; query = ""; search.value = "";
      folders = await this.feature.shareDirectories(); feedback.setText(creating ? "文件夹已新建。" : "目录已重命名，推送新分享后应用到云端。");
    }); });
    create.addEventListener("click", () => {
      if (working) return;
      if (creatingParent !== undefined) cancelEdit();
      creatingParent = directory || "";
      let next = 0, leaf = "新建文件夹";
      const path = () => [creatingParent, leaf].filter(Boolean).join("/");
      while (folders.share.some(folder => normalizeShareDirectory(folder) === path() || normalizeShareDirectory(folder).startsWith(path() + "/"))) leaf = `新建文件夹(${++next})`;
      renaming = path(); name.value = leaf; form.hidden = false;
      query = ""; search.value = ""; feedback.setText(""); render(); name.focus(); name.select();
    });
    name.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); save.click(); }
      else if (event.key === "Escape" && !working) { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
    });
    move.addEventListener("click", () => { void run(async () => {
      await this.feature.moveShares(this.ids, directory);
      this.completed(); this.close(); new Notice("目录调整已保存，点击推送新分享后应用到云端分享库。");
    }); });
    render();
    void this.feature.shareDirectories().then(value => { folders = value; render(); }).catch((error: unknown) => { feedback.setText(error instanceof Error ? error.message : String(error)); });
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
  private setupTitleChanged?: (title: string) => void;
  private authMode: "browser" | "token" | "verify" | null = null;
  private repoMode: "create" | "existing" | null = null;
  private draftName = "";
  private draftRepo = "";
  private takenRepository?: { owner: string; name: string };
  private repositoryFeedback = "";
  private checkingDeployment = false;
  private githubDeploymentStatus = "";
  private githubDeploymentError = "";
  private edgeOneGuideOpen = false;
  readonly edgeone: EdgeOneConnection;
  display: ShareDisplaySettings = { showPaths: false, layout: "list", descending: false };
  private displayStored = false;
  private template = "";
  private templateFile = DEFAULT_TEMPLATE_FILE;
  private templateFiles: Record<string, string> = { [DEFAULT_TEMPLATE_FILE]: "默认模板" };
  private templateMessage = "";
  private templateBusy = false;
  private token = "";
  private cliAvailable?: boolean;
  private backend: "cli" | "api" = Platform.isMobile ? "api" : "cli";
  private async useCli(): Promise<boolean> {
    if (Platform.isMobile) return false;
    if (this.cliAvailable === undefined) {
      this.cliAvailable = await this.host.sync.exec("gh", ["--version"]).then(() => true, () => false);
    }
    return this.cliAvailable;
  }
  private secretId(): string { return `${this.host.manifest.id}-share-github`; }
  private savedToken(): string { return requireApiVersion("1.11.4") ? this.host.app.secretStorage?.getSecret(this.secretId()) ?? "" : ""; }
  private async github(path: string, method = "GET", body?: unknown): Promise<string> {
    if (await this.useCli()) return this.host.sync.exec("gh", ["api", path, ...(method === "GET" ? [] : ["--method", method]), ...(body === undefined ? [] : ["--input", "-"])], false, true, 120000, undefined, body === undefined ? undefined : JSON.stringify(body));
    return JSON.stringify(await githubJson(this.savedToken(), `/${path}`, method, body));
  }
  private async repository(site = this.manifest.site): Promise<ShareRepository> {
    const cli = await this.useCli(); this.backend = cli ? "cli" : "api";
    return cli ? new ShareRepository(this.host, site) : new ApiShareRepository(this.host, site, this.savedToken());
  }
  private published: PublishState = { version: 1, notes: {}, files: [] };
  constructor(readonly host: SimplePlugin) {
    super();
    this.edgeone = new EdgeOneConnection(host, () => this.manifest.site,
      async () => {
        const local = await this.local();
        if (!local.commit || local.site !== `${this.manifest.site.owner}/${this.manifest.site.repo}`) {
          throw new Error("请先将当前分享仓库推送成功，再检查腾讯网站部署。");
        }
        return local.commit;
      }, () => this.renderViews());
  }
  private path(name: string): string { return `${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}/${name}`; }
  private suggestedRepoName(): string {
    const settings = this.host.sync.settings;
    const remote = settings?.boundRepoUrl || settings?.mobile?.repoUrl || settings?.gitRemoteUrl || settings?.setupRepoUrl || "";
    const name = remote.match(/[:/]([^/:]+?)(?:\.git)?\/?$/)?.[1] || this.host.app.vault?.getName?.() || "notes";
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 94) || "notes";
    return `${safe}-share`;
  }
  async initialize(): Promise<void> {
    this.backend = await this.useCli() ? "cli" : "api";
    await this.reload().catch(error => { this.error = String(error); });
    await this.edgeone.load().catch(error => { this.edgeone.error = error instanceof Error ? error.message : String(error); });
    await this.readTemplate().catch(error => { this.templateMessage = error instanceof Error ? error.message : String(error); });
    const progress = this.manifest.site.guideProgress ?? (this.manifest.site.initialized ? 5 : this.manifest.site.repo ? 3 : 1);
    this.guideStep = Math.min(4, progress); this.guideAvailableStep = Math.min(4, progress);
    addIcon("simple-share-sort-asc", '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M25 85V15m-12 12 12-12 12 12M60 35l10-25 10 25M64 27h12M60 60h20L60 85h20"/></g>');
    addIcon("simple-share-sort-desc", '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M25 15v70m-12-12 12 12 12-12M60 10h20L60 35h20M60 85l10-25 10 25M64 77h12"/></g>');
    this.refreshActions = registerMarkdownAction(this.host, "data-simple-share-note", () => this.manifest.enabled,
      view => view.addAction("share-2", "分享当前笔记", runAsync(async () => {
        if (!view.file) return;
        await view.save();
        await this.share(view.file).catch(error => this.fail(error));
      })),
      action => {
        const disabled = this.busy || this.sharing;
        action.setAttr("aria-disabled", String(disabled));
        setTooltip(action, disabled ? "正在发布分享，请稍候" : "分享当前笔记：发布并按设置复制内容");
      });
    this.host.registerView(VIEW, leaf => new ShareView(leaf, this));
    this.host.addCommand({ id: "share-current-note", name: "分享此笔记", checkCallback: checking => {
      const file = this.host.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (!file) return false; if (!checking) void this.share(file).catch(error => this.fail(error)); return true;
    } });
    this.host.addCommand({ id: "open-share-manager", name: "打开分享管理", callback: () => { void this.open(); } });
    this.host.addCommand({ id: "publish-shared-notes", name: "推送新分享", callback: () => { void this.publish().catch(error => this.fail(error)); } });
    this.host.addRibbonIcon("share-2", "分享管理", () => { void this.open(); });
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
    this.register(() => { if (this.scanTimer) window.clearTimeout(this.scanTimer); this.authController?.abort(); this.edgeone.stop(); });
  }
  private fail(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); this.renderViews(); new Notice(`笔记分享：${this.error}`, 10000); }
  private async reload(): Promise<void> {
    const adapter = this.host.app.vault.adapter;
    const path = this.path("share-manifest.json");
    const text = await adapter.exists(path) ? await adapter.read(path) : "";
    this.manifestText = text;
    this.manifest = text ? parseManifest(text) : emptyManifest();
  }
  async change(edit: (manifest: ShareManifest) => void | Promise<void>, refresh = true): Promise<void> {
    if (this.busy) throw new Error("发布正在进行，请稍后修改分享设置。");
    const operation = this.mutation.then(async () => {
      if (this.host.sync.isSyncing()) throw new Error("主库正在同步，请稍后修改分享设置。");
      await this.reload(); await edit(this.manifest);
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
    await this.reload();
    if (!this.manifest.enabled) throw new Error("请先在笔记分享设置中启用分享。");
    if (!this.manifest.site.repo) throw new Error("请先完成笔记分享引导，连接公开分享仓库。");
    this.shareCopyText("", "");
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
      const category = old?.category ?? (manifest.defaultPath === "root" ? "" : file.parent?.path ?? "");
      manifest.notes[key] = { ...old, enabled: true, sourcePath: file.path, category, revision: (old?.revision || 0) + 1 };
      if (!old) manifest.notes[key].directoryCode = this.directoryCode(manifest, normalizeShareDirectory(category));
      delete manifest.notes[key].deleted;
    }, false);
    await this.publish(false, key);
    try { await this.copySharedNote(key, file.basename); new Notice("当前笔记已推送，已按设置复制内容；网站展示需等待部署完成。", 8000); }
    catch (error) { new Notice(`当前笔记已推送，复制失败：${error instanceof Error ? error.message : String(error)}`, 8000); }
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
  async removeShare(id: string): Promise<void> {
    await this.removeShares([id]);
  }
  async removeShares(ids: readonly string[]): Promise<void> {
    if (!this.manifest.enabled) throw new Error("请先启用笔记分享。");
    if (!ids.length) return;
    if (ids.some(id => !this.manifest.notes[id]?.deleted)) await this.change(manifest => { for (const id of new Set(ids)) {
      if (manifest.notes[id]?.deleted) continue;
      const old = manifest.notes[id];
      const published = this.published.notes[id];
      if (!old && !published) throw new Error("这篇分享已不存在。");
      // Explicit withdrawal remains in the manifest across devices.
      manifest.notes[id] = { ...old, enabled: false, deleted: true, sourcePath: old?.sourcePath || "", category: old?.category ?? published.category, revision: (old?.revision || 0) + 1 };
    } });
    await this.publish(false, ids);
    new Notice("分享已删除，本地笔记保留；网站生效需等待部署完成。");
  }
  async moveShares(ids: readonly string[], directory?: string, publicName?: string): Promise<void> {
    const target = directory === undefined ? undefined : normalizeShareDirectory(directory);
    if (!ids.length) return;
    await this.change(manifest => {
      for (const id of new Set(ids)) {
        const entry = manifest.notes[id];
        if (!entry || entry.deleted) throw new Error("所选分享笔记已删除或未关联，请刷新列表。");
        const path = target ?? (manifest.defaultPath === "root" ? "" : normalizeShareDirectory(entry.sourcePath.split("/").slice(0, -1).join("/")));
        entry.directoryCode = this.directoryCode(manifest, path); entry.category = path; entry.revision++;
        if (publicName !== undefined) entry.publicName = publicName || undefined;
      }
    });
  }
  private directoryCode(manifest: ShareManifest, path: string): string {
    const directories = manifest.directories ||= {};
    const existing = Object.keys(directories).find(code => directories[code] === path);
    if (existing) return existing;
    let next = 1; while (Object.prototype.hasOwnProperty.call(directories, `dir${next}`)) next++;
    directories[`dir${next}`] = path; return `dir${next}`;
  }
  async createShareDirectory(parent: string, name?: string): Promise<string> {
    const leaf = name?.trim() ?? "新建文件夹";
    if (!leaf || leaf.includes("/")) throw new Error("请输入单个目录名称。");
    const normalizedParent = normalizeShareDirectory(parent);
    let path = normalizeShareDirectory([normalizedParent, leaf].filter(Boolean).join("/"));
    await this.change(async manifest => {
      if (name === undefined) {
        const directories = (await this.shareDirectories()).share;
        let next = 0;
        while (directories.some(directory => directory === path || directory.startsWith(path + "/"))) {
          path = [normalizedParent, `${leaf}(${++next})`].filter(Boolean).join("/");
        }
      } else if ((await this.shareDirectories()).share.some(directory => directory === path || directory.startsWith(path + "/"))) throw new Error("同级目录已存在此名称。");
      this.directoryCode(manifest, path);
    });
    return path;
  }
  async renameShareDirectory(directory: string, name: string): Promise<string> {
    const source = normalizeShareDirectory(directory), leaf = name.trim();
    if (!source || !leaf || leaf.includes("/")) throw new Error("请输入单个目录名称，根目录不能重命名。");
    const target = normalizeShareDirectory([...source.split("/").slice(0, -1), leaf].join("/"));
    await this.change(async manifest => {
      if (source === target) return;
      const directories = (await this.shareDirectories()).share;
      if (directories.some(path => path === target || path.startsWith(target + "/"))) throw new Error("同级目录已存在此名称。");
      const replace = (path: string) => path === source || path.startsWith(source + "/") ? target + path.slice(source.length) : path;
      for (const code of Object.keys(manifest.directories || {})) manifest.directories![code] = replace(manifest.directories![code]);
      this.directoryCode(manifest, target);
      for (const entry of Object.values(manifest.notes)) {
        const category = replace(normalizeShareDirectory(entry.category));
        if (category === normalizeShareDirectory(entry.category)) continue;
        entry.category = category; entry.directoryCode = this.directoryCode(manifest, category); entry.revision++;
      }
    });
    return target;
  }
  async shareDirectories(): Promise<{ all: string[]; share: string[] }> {
    const shared = new Set<string>();
    for (const path of [...Object.values(this.manifest.directories || {}), ...Object.values(this.manifest.notes).filter(note => !note.deleted).map(note => note.category), ...Object.entries(this.published.notes).filter(([id]) => !this.manifest.notes[id]).map(([, note]) => note.category)]) {
      try { const normalized = normalizeShareDirectory(path); if (normalized) shared.add(normalized); }
      catch { /* Ignore legacy categories that are not valid destination folders. */ }
    }
    return { all: [...shared], share: [...shared] };
  }
  async deleteShareDirectory(directory: string, confirm: (count: number) => Promise<boolean> = count => confirmAction(this.host.app, `此目录及子目录包含 ${count} 篇分享笔记。删除目录后，这些笔记会转移到分享专用库根目录，原笔记和分享链接保留。是否继续？`)): Promise<boolean> {
    const source = normalizeShareDirectory(directory);
    if (!source) throw new Error("分享专用库根目录不能删除。");
    let deleted = false;
    await this.change(async manifest => {
      const inside = (path: string) => path === source || path.startsWith(source + "/");
      const entries = Object.values(manifest.notes).filter(entry => inside(normalizeShareDirectory(entry.category)));
      const count = entries.filter(entry => !entry.deleted).length;
      if (count && !await confirm(count)) return;
      for (const entry of entries) { entry.category = ""; entry.directoryCode = this.directoryCode(manifest, ""); entry.revision++; }
      for (const [code, path] of Object.entries(manifest.directories || {})) if (inside(path)) delete manifest.directories![code];
      deleted = true;
    });
    return deleted;
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
    const local = await this.local();
    const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
    this.published = local.site === key && local.published ? local.published : { version: 1, notes: {}, files: [] };
    const index = await this.scanIndex(), rows: Row[] = [], moved: Record<string, string> = {};
    for (const [id, entry] of Object.entries(this.manifest.notes)) {
      if (request !== this.scanRequest || this.busy) return;
      const files = index.get(id) || [], old = this.published.notes[id];
      if (entry.deleted && !old) continue;
      const row: Row = { id, title: files[0]?.basename || old?.title || entry.sourcePath.split("/").pop() || id, file: files.length === 1 ? files[0] : undefined, state: "" };
      if (row.file && row.file.path !== entry.sourcePath) moved[id] = row.file.path;
      if (!entry.enabled) row.state = entry.deleted || old ? "待删除" : "未分享";
      else if (files.length > 1) row.state = "ID 冲突";
      else if (!row.file) row.state = "源文件缺失或 ID 丢失";
      else {
        try {
          const exported = await exportNote(this.host, row.file, entry.category, this.manifest, index, entry.publicName);
          row.state = !old ? "待发布" : old.hash !== exported.hash || (old.path ?? `notes/${id}.md`) !== shareNotePath(id, entry) ? "待更新" : "已发布";
        } catch (error) { row.state = `导出异常：${error instanceof Error ? error.message : String(error)}`; }
      }
      rows.push(row);
    }
    for (const [id, note] of Object.entries(this.published.notes)) if (!this.manifest.notes[id]) rows.push({ id, title: note.title, state: "未关联，保留线上版本" });
    if (request !== this.scanRequest || this.busy) return;
    if (Object.keys(moved).length && !this.host.sync.isSyncing()) await this.change(manifest => { for (const [id, path] of Object.entries(moved)) if (manifest.notes[id]) manifest.notes[id].sourcePath = path; }, false);
    this.rows = rows; this.renderViews();
  }
  private async local(): Promise<LocalState> {
    const adapter = this.host.app.vault.adapter, path = this.path("share-local.json");
    if (!await adapter.exists(path)) return { version: 1 };
    const value = JSON.parse(await adapter.read(path)) as LocalState;
    if (value.version !== 1) throw new Error("本机发布记录版本不正确。");
    // Ignore obsolete clone/cache jobs; every retry compares the current remote tree.
    return { version: 1, site: value.site, commit: value.commit, pendingCommit: value.pendingCommit,
      ...(value.published ? { published: parsePublishState(JSON.stringify(value.published)) } : {}) };
  }
  private saveLocal(value: LocalState): Promise<void> { return this.host.app.vault.adapter.write(this.path("share-local.json"), JSON.stringify(value, null, 2)); }
  async refreshPublished(): Promise<void> {
    if (this.isPublishing || this.host.sync.isSyncing()) return;
    await this.reload();
    if (!this.manifest.site.repo) { await this.scan(); return; }
    const repository = await this.repository();
    await repository.verify(); await repository.refresh();
    if (this.isPublishing || this.host.sync.isSyncing()) return;
    const local = await this.local(), key = this.manifest.site.owner + "/" + this.manifest.site.repo;
    await this.saveLocal({ ...(local.site === key ? local : {}), version: 1, site: key, published: await repository.state() });
    await this.scan();
  }
  async publish(_initialize = false, onlyId?: string | readonly string[]): Promise<void> {
    if (this.templateBusy) throw new Error("模板正在保存，请稍后推送。");
    if (this.busy || this.host.sync.isSyncing()) throw new Error("已有分享或主库同步任务正在运行。");
    await this.mutation; await this.reload();
    if (!this.manifest.enabled) throw new Error("笔记分享已关闭。");
    if (this.busy || this.host.sync.isSyncing()) throw new Error("已有分享或主库同步任务正在运行。");
    const selected = onlyId ? (typeof onlyId === "string" ? [onlyId] : onlyId) : [];
    for (const id of selected) if (!this.manifest.notes[id]) throw new Error("当前笔记未关联分享清单。");
    if (!this.sharing) this.publishingTitle = typeof onlyId === "string" ? this.manifest.notes[onlyId]?.sourcePath.split("/").pop()?.replace(/\.md$/, "") || "" : "";
    this.busy = true; this.error = ""; this.status = "正在读取云端文件清单…"; this.renderViews();
    try {
      const snapshot = serializeManifest(this.manifest), template = await this.readTemplate();
      const readerTemplate = /<script data-simple-reader>/.test(template) ? template : await this.readDefaultTemplate();
      const repository = await this.repository();
      await repository.verify(); await repository.refresh();
      const key = this.manifest.site.owner + "/" + this.manifest.site.repo, old = await repository.state();
      const state: PublishState = { version: 1, notes: {}, files: [] };
      const adapter = this.host.app.vault.adapter, licensePath = this.path("reader-licenses.txt");
      const files = websiteFiles(template, readerTemplate, await adapter.exists(licensePath) ? await adapter.read(licensePath) : bundledReaderFiles().licenses);
      const appearance = shareAppearance(this.host);
      files.set("reader/appearance.css", appearance); files.set("index.html", templateAppearance(template, appearance));
      const index = await this.scanIndex();
      // Identity writes can precede Obsidian's metadata-cache refresh.
      for (const [id, entry] of Object.entries(this.manifest.notes)) {
        if (!entry.enabled || index.get(id)?.length) continue;
        const file = this.host.app.vault.getAbstractFileByPath(entry.sourcePath);
        if (!(file instanceof TFile)) continue;
        const source = await this.host.app.vault.read(file);
        const yaml = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
        if (yaml && (parseYaml(yaml) as { share_id?: unknown })?.share_id === id) index.set(id, [file]);
      }
      const failures: string[] = [];
      for (const [id, entry] of Object.entries(this.manifest.notes)) {
        if (!entry.enabled) continue;
        const matches = index.get(id) || [];
        if (matches.length !== 1) { failures.push(entry.sourcePath + "：源文件缺失或 ID 重复"); continue; }
        try {
          const result = await exportNote(this.host, matches[0], entry.category, this.manifest, index, entry.publicName);
          const path = shareNotePath(id, entry); files.set(path, result.source);
          for (const [asset, data] of result.assets) files.set(asset, data);
          state.notes[id] = { title: result.title, category: result.category, hash: result.hash, assets: [...result.assets.keys()].sort(), ...(entry.directoryCode ? { path } : {}) };
        } catch (error) { failures.push(matches[0].basename + "：" + String(error)); }
      }
      // An absent local entry is not an explicit withdrawal. Retain remote references, not content.
      const retained = new Set<string>();
      for (const [id, note] of Object.entries(old.notes)) if (!this.manifest.notes[id]) {
        state.notes[id] = note; retained.add(note.path ?? "notes/" + id + ".md");
        for (const asset of note.assets) retained.add(asset);
      }
      files.set("catalog.json", JSON.stringify({ version: 1, notes: Object.entries(state.notes).map(([id, note]) => ({ id, title: note.title, category: note.category, ...(note.path ? { path: note.path } : {}) })).sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title)) }, null, 2));
      files.set("publish-state.json", ""); state.files = [...new Set([...files.keys(), ...retained])].sort();
      files.set("publish-state.json", JSON.stringify(state, null, 2));
      await this.reload();
      if (serializeManifest(this.manifest) !== snapshot) throw new Error("分享设置在生成期间发生变化，请重新发布。");
      if (template !== await this.readTemplate() || readerTemplate !== template && readerTemplate !== await this.readDefaultTemplate()) throw new Error("HTML 模板在生成期间发生变化，请重新发布。");
      if (failures.length) throw new Error("以下笔记异常；线上版本保留，请处理后重试：\n" + failures.join("\n"));
      this.status = "正在按文件哈希对比并推送…"; this.renderViews();
      const job = await repository.writeFiles(files, old), previous = await this.local();
      const commit = await repository.push(job, pending => this.saveLocal({ ...(previous.site === key ? previous : {}), version: 1, site: key, pendingCommit: pending.commit }));
      await this.saveLocal({ version: 1, site: key, commit, published: state }); this.published = state;
      await this.edgeone.invalidateDeployment(commit).catch(error => { this.edgeone.error = error instanceof Error ? error.message : String(error); });
      this.status = Object.keys(job.expected).length ? "已推送，正在检查网站部署…" : "内容未变化，正在检查网站部署…"; this.renderViews();
      try {
        await repository.configurePages(); this.status = await repository.deployment(commit);
        this.githubDeploymentStatus = this.status; this.githubDeploymentError = "";
        this.manifest.site.initialized = true; this.manifest.site.guideProgress = 5;
        await adapter.write(this.path("share-manifest.json"), serializeManifest(this.manifest));
      } catch (error) {
        this.status = "仓库内容已确认；Pages 需要检查"; this.error = error instanceof Error ? error.message : String(error);
        this.githubDeploymentStatus = this.status; this.githubDeploymentError = this.error;
      }
      new Notice("笔记分享：" + this.status, 8000);
    } finally { this.busy = false; await this.scan().catch(error => this.fail(error)); this.renderViews(); }
  }
  async checkDeployment(): Promise<void> {
    if (this.checkingDeployment || this.isPublishing) throw new Error("已有分享任务正在运行，请稍后检查。");
    this.checkingDeployment = true; this.error = ""; this.status = "正在检查网站部署…";
    this.githubDeploymentError = ""; this.githubDeploymentStatus = this.status; this.renderViews();
    try {
      const local = await this.local(); if (!local.commit) throw new Error("尚未完成推送，请先初始化网站或点击「推送新分享」。");
      if (local.site !== `${this.manifest.site.owner}/${this.manifest.site.repo}`) throw new Error("最近一次推送属于其他仓库，请重新检查分享仓库配置。");
      const repository = await this.repository();
      this.status = await repository.deployment(local.commit);
      this.githubDeploymentStatus = this.status;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.githubDeploymentError = this.error; throw error;
    } finally { this.checkingDeployment = false; this.renderViews(); }
  }
  async open(closeSettings = false, reveal = true): Promise<void> {
    const existing = this.host.app.workspace.getLeavesOfType(VIEW)[0];
    // false creates a tab in the existing right group; true creates a vertical split.
    const leaf = existing || this.host.app.workspace.getRightLeaf(false);
    if (!leaf) return; if (!existing) await leaf.setViewState({ type: VIEW, active: reveal });
    if (reveal) await this.host.app.workspace.revealLeaf(leaf);
    if (closeSettings) (this.host.app as typeof this.host.app & { setting?: { close(): void } }).setting?.close();
    void this.scan().catch(error => this.fail(error));
    if (this.manifest.site.repo) void this.refreshPublished().catch(error => this.fail(error));
  }
  private renderViews(): void {
    this.refreshActions();
    for (const leaf of this.host.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof ShareView) leaf.view.render();
    if (this.setupHost?.isConnected) this.renderSettings(this.setupHost, this.setupGuide, this.setupShowTitle, this.setupTitleChanged);
  }
  get isPublishing(): boolean { return this.busy || this.sharing; }
  get copyContent(): ShareCopyContent { return this.manifest.copyContent ?? DEFAULT_SHARE_COPY_CONTENT; }
  async updateCopyContent(key: keyof ShareCopyContent, value: boolean): Promise<void> {
    await this.change(manifest => { manifest.copyContent = { ...DEFAULT_SHARE_COPY_CONTENT, ...manifest.copyContent, [key]: value }; });
  }
  private shareCopyText(id: string, title: string): string {
    const github = siteUrl(this.manifest.site);
    const pageOne = this.edgeone.website;
    return formatShareContent(title, github ? `${github}#/notes/${id}` : "", pageOne ? `${pageOne.replace(/\/$/, "")}#/notes/${id}` : "", this.copyContent);
  }
  async copySharedNote(id: string, fallback = ""): Promise<void> {
    const note = this.published.notes[id];
    if (!note) throw new Error("这篇笔记尚未发布，请先分享笔记。");
    await navigator.clipboard.writeText(this.shareCopyText(id, note.title || fallback));
  }
  addCopyContentMenu(menu: Menu): void {
    menu.addSeparator();
    menu.addItem(item => item.setTitle("复制内容").setIcon("copy").setDisabled(true));
    for (const [key, title] of [["title", "笔记标题"], ["github", "GitHub 链接"], ["pageOne", "Page One 链接"]] as const) {
      menu.addItem(item => item.setTitle(title).setIcon(this.copyContent[key] ? "check-square" : "square").setDisabled(this.isPublishing || !this.manifest.enabled)
        .onClick(() => { void this.updateCopyContent(key, !this.copyContent[key]).catch(error => this.fail(error)); }));
    }
  }
  restoreDisplay(state: Record<string, unknown>): void {
    if (this.displayStored) return;
    if (typeof state.showPaths === "boolean" && state.layout !== undefined) this.display.showPaths = state.showPaths;
    if (typeof state.descending === "boolean") this.display.descending = state.descending;
    if (state.layout === "list" || state.layout === "source" || state.layout === "public") this.display.layout = state.layout;
  }
  updateDisplay(change: Partial<ShareDisplaySettings>): void {
    Object.assign(this.display, change); this.displayStored = true;
    this.host.app.workspace.requestSaveLayout(); this.renderViews();
  }
  private async readDefaultTemplate(): Promise<string> {
    const adapter = this.host.app.vault.adapter;
    const path = this.path(DEFAULT_TEMPLATE_FILE);
    if (!await adapter.exists(path)) {
      const defaults = bundledReaderFiles();
      validateShareTemplate(defaults.template);
      const licensePath = this.path("reader-licenses.txt");
      if (!await adapter.exists(licensePath)) await adapter.write(licensePath, defaults.licenses);
      await adapter.write(path, defaults.template);
    }
    const source = await adapter.read(path);
    validateShareTemplate(source);
    return source;
  }
  private async readTemplate(): Promise<string> {
    const adapter = this.host.app.vault.adapter;
    const selectionPath = this.path(TEMPLATE_SELECTION_FILE);
    let filename = DEFAULT_TEMPLATE_FILE;
    if (await adapter.exists(selectionPath)) {
      const selected = JSON.parse(await adapter.read(selectionPath)) as { file?: unknown };
      if (typeof selected.file !== "string" || !/^(?:default|share-template|custom-[^\\/:*?"<>|]+)\.html$/.test(selected.file) || [...selected.file].some(char => char.charCodeAt(0) < 32)) throw new Error("HTML 模板选择记录不正确。");
      filename = selected.file;
    } else if (await adapter.exists(this.path("share-template.html"))) {
      // Legacy HTML may have custom edits inside any block; preserve it as a custom template.
      filename = "share-template.html";
      await adapter.write(selectionPath, JSON.stringify({ file: filename }, null, 2));
    }
    const source = filename === DEFAULT_TEMPLATE_FILE ? await this.readDefaultTemplate() : await adapter.read(this.path(filename));
    validateShareTemplate(source);
    this.templateFile = filename;
    await this.refreshTemplateFiles();
    this.template = source; return source;
  }
  private async refreshTemplateFiles(): Promise<void> {
    const entries = await this.host.app.vault.adapter.list(this.path("").replace(/\/$/, ""));
    this.templateFiles = { [DEFAULT_TEMPLATE_FILE]: "默认模板" };
    for (const path of entries.files) {
      const name = path.split("/").pop() || "";
      if (/^(?:custom-[^\\/:*?"<>|]+|share-template)\.html$/.test(name) && ![...name].some(char => char.charCodeAt(0) < 32)) this.templateFiles[name] = name;
    }
  }
  private async selectTemplate(filename: string): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(this.templateFiles, filename)) throw new Error("模板不存在。");
    if (this.isPublishing || this.templateBusy || this.host.sync.isSyncing()) throw new Error("请等待分享或主库同步任务完成后再更换模板。");
    this.templateBusy = true; this.renderViews();
    try {
      const source = filename === DEFAULT_TEMPLATE_FILE ? await this.readDefaultTemplate() : await this.host.app.vault.adapter.read(this.path(filename));
      validateShareTemplate(source);
      await this.host.app.vault.adapter.write(this.path(TEMPLATE_SELECTION_FILE), JSON.stringify({ file: filename }, null, 2));
      this.templateFile = filename; this.template = source;
    } finally { this.templateBusy = false; this.renderViews(); }
  }
  private async saveTemplate(source: string, message: string, name = "template.html"): Promise<void> {
    if (this.isPublishing || this.templateBusy || this.host.sync.isSyncing()) throw new Error("请等待分享或主库同步任务完成后再更换模板。");
    validateShareTemplate(source);
    this.templateBusy = true; this.renderViews();
    try {
      const adapter = this.host.app.vault.adapter;
      const stem = [...name].map(char => char.charCodeAt(0) < 32 ? "-" : char).join("").replace(/\.html?$/i, "").replace(/[\\/:*?"<>|]/g, "-").replace(/^[. ]+|[. ]+$/g, "").slice(0, 80) || "template";
      let filename = `custom-${stem}.html`;
      for (let suffix = 2; await adapter.exists(this.path(filename)); suffix++) filename = `custom-${stem}-${suffix}.html`;
      await adapter.write(this.path(filename), source);
      await adapter.write(this.path(TEMPLATE_SELECTION_FILE), JSON.stringify({ file: filename }, null, 2));
      await this.refreshTemplateFiles();
      this.templateFile = filename; this.template = source; this.templateMessage = message;
    } finally { this.templateBusy = false; this.renderViews(); }
  }
  private async restoreDefaultTemplate(): Promise<void> {
    if (this.isPublishing || this.templateBusy || this.host.sync.isSyncing()) throw new Error("请等待分享或主库同步任务完成后再更换模板。");
    this.templateBusy = true; this.renderViews();
    try {
      const source = await this.readDefaultTemplate();
      await this.host.app.vault.adapter.write(this.path(TEMPLATE_SELECTION_FILE), JSON.stringify({ file: DEFAULT_TEMPLATE_FILE }, null, 2));
      this.templateFile = DEFAULT_TEMPLATE_FILE; this.template = source;
      this.templateMessage = "已恢复默认模板，点击「推送新分享」后网站生效。";
    } finally { this.templateBusy = false; this.renderViews(); }
  }
  private importTemplate(): void {
    const input = createEl("input"); input.type = "file"; input.accept = ".html,.htm,text/html";
    input.addEventListener("change", () => {
      const file = input.files?.[0]; if (!file) return;
      void (async () => {
        if (file.size > 16 * 1024 * 1024) throw new Error("请选择小于 16 MB 的 HTML 模板。");
        await this.saveTemplate(await file.text(), "模板已导入，点击「推送新分享」后网站生效。", file.name);
      })().catch(error => { this.templateMessage = error instanceof Error ? error.message : String(error); this.renderViews(); new Notice(this.templateMessage); });
    }, { once: true });
    input.click();
  }
  private async exportTemplate(): Promise<void> {
    const template = await this.readTemplate();
    const url = URL.createObjectURL(new Blob([template], { type: "text/html;charset=utf-8" }));
    const link = createEl("a"); link.href = url; link.download = this.templateFile;
    document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  addPublishButton(setting: Setting): Setting {
    return setting.addButton(button => button.setButtonText(this.isPublishing ? "推送中…" : "推送新分享")
      .setTooltip("检查并推送所有分享变化，包括正文更新、目录调整与删除")
      .setDisabled(this.isPublishing || this.checkingDeployment || this.templateBusy || !this.manifest.site.repo || !this.manifest.enabled)
      .onClick(() => { void this.publish().catch(error => this.fail(error)); }).buttonEl.addClass("simple-share-publish"));
  }
  renderPanel(container: HTMLElement, query: string, showPaths = false, layout: ShareLayout = "list", collapsed = new Set<string>(), onFolderToggle?: () => void, descending = false, selection?: ShareSelection): void {
    container.empty();
    const compareNames = (a: string, b: string): number => (descending ? -1 : 1) * a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
    const displayName = (row: Row): string => layout === "public" ? this.manifest.notes[row.id]?.publicName || this.published.notes[row.id]?.title || row.title : row.title;
    const rows = this.rows.filter(row => {
      const entry = this.manifest.notes[row.id];
      const fields = [row.title, displayName(row)];
      if (showPaths || layout === "source") fields.push(row.file?.path || entry?.sourcePath || "");
      if (layout === "public") fields.push(entry?.category || this.published.notes[row.id]?.category || "");
      return fields.join(" ").toLowerCase().includes(query.trim().toLowerCase());
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
      if (selection) {
        const checkbox = setting.settingEl.createEl("input", { cls: "simple-share-selection", attr: { type: "checkbox", "aria-label": `选择分享笔记：${name}`, "data-share-id": row.id } });
        checkbox.checked = selection.selected.has(row.id);
        checkbox.disabled = this.isPublishing || selection.mode === "move" && (!entry || !!entry.deleted);
        setting.settingEl.prepend(checkbox);
        const updateSelection = () => {
          if (checkbox.checked) selection.selected.add(row.id); else selection.selected.delete(row.id);
          setting.settingEl.toggleClass("is-selected", checkbox.checked);
          setting.infoEl.setAttribute("aria-checked", String(checkbox.checked));
          selection.onChange();
        };
        const toggleSelection = () => { if (!checkbox.disabled) { checkbox.checked = !checkbox.checked; updateSelection(); } };
        setting.settingEl.toggleClass("is-selected", checkbox.checked);
        setting.settingEl.toggleClass("is-selectable", !checkbox.disabled);
        setting.infoEl.setAttribute("role", "checkbox");
        setting.infoEl.setAttribute("aria-label", `选择分享笔记：${name}`);
        setting.infoEl.setAttribute("aria-checked", String(checkbox.checked));
        setting.infoEl.setAttribute("aria-disabled", String(checkbox.disabled));
        setting.infoEl.tabIndex = checkbox.disabled ? -1 : 0;
        checkbox.addEventListener("change", updateSelection);
        setting.settingEl.addEventListener("click", event => {
          if ((event.target as Element).closest("button, input, a, .setting-item-control")) return;
          toggleSelection();
        });
        setting.infoEl.addEventListener("keydown", event => {
          if (event.key === " " || event.key === "Enter") { event.preventDefault(); toggleSelection(); }
        });
        if (row.file) setting.nameEl.addEventListener("dblclick", runAsync(async () => { await this.host.app.workspace.getLeaf(false).openFile(row.file!); }));
      } else if (row.file) {
        const locate = runAsync(async () => { await this.host.app.workspace.getLeaf(false).openFile(row.file!); });
        setting.nameEl.addClass("simple-share-note-link");
        setting.nameEl.setAttribute("role", "link"); setting.nameEl.tabIndex = 0;
        setting.nameEl.addEventListener("click", locate);
        setting.nameEl.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); locate(); } });
      }
      setting.nameEl.setAttribute("title", `${row.title} · ${row.state}${selection && row.file ? " · 双击打开原笔记" : ""}`);
      if (entry) setting.settingEl.addEventListener("contextmenu", event => {
        event.preventDefault();
        new Menu().addItem(item => item.setTitle("修改公开目录与文件名").setIcon("pencil").setDisabled(this.isPublishing)
          .onClick(() => new CategoryModal(this, row.id).open())).showAtMouseEvent(event);
      });
      setting.descEl.hidden = !showPaths;
      setting.settingEl.toggleClass("has-file-path", showPaths);
      setting.descEl.setAttribute("title", `原笔记目录：${path || "/"} · 公开分类：${entry?.category || "未分类"}`);
      if (this.published.notes[row.id]) setting.addButton(button => button.setIcon("copy").setTooltip("按设置复制分享内容").onClick(runAsync(async () => {
        await this.copySharedNote(row.id); new Notice("已按设置复制分享内容。");
      })));
      if (entry) {
        if (row.state === "ID 冲突") setting.addButton(button => button.setIcon("git-compare").setTooltip("解决重复 ID").setDisabled(this.busy).onClick(() => new IdModal(this, row.id, this.index().get(row.id) || []).open()));
        if (row.state === "源文件缺失或 ID 丢失") setting.addButton(button => button.setIcon("link").setTooltip("重新关联笔记").setDisabled(this.busy).onClick(() => new RelinkModal(this, row.id).open()));
      }
    }
  }
  get isEdgeOneGuideOpen(): boolean { return this.edgeOneGuideOpen; }
  backFromEdgeOneGuide(): boolean {
    if (!this.edgeOneGuideOpen) return false;
    this.edgeone.stop(); this.edgeOneGuideOpen = false; this.renderViews();
    return true;
  }
  renderSettings(root: HTMLElement, guide: boolean, showTitle = true, onTitleChanged?: (title: string) => void): void {
    this.setupTitleChanged = onTitleChanged;
    this.setupHost = root; this.setupGuide = guide; this.setupShowTitle = showTitle; root.empty();
    root.toggleClass("simple-one-sync-setup-page", guide || this.edgeOneGuideOpen);
    const page = root.createDiv({ cls: "simple-one-sync-setup-layout" });
    const title = !guide && this.edgeOneGuideOpen ? "腾讯 EdgeOne 接入引导" : guide ? "笔记分享引导" : "笔记分享设置";
    onTitleChanged?.(title);
    if (showTitle) {
      const header = page.createDiv({ cls: "simple-page-header" });
      if (!guide && this.edgeOneGuideOpen) {
        const back = header.createEl("button", { cls: "simple-back-button", attr: { type: "button", "aria-label": "返回笔记分享设置", title: "返回笔记分享设置" } });
        setIcon(back, "arrow-left"); back.addEventListener("click", () => this.backFromEdgeOneGuide());
      }
      new Setting(header).setName(title).setHeading().setClass("simple-page-title");
    }
    if (!guide && this.edgeOneGuideOpen) {
      renderEdgeOneGuide(page, this.edgeone, this.manifest.enabled, this.isPublishing,
        () => { this.edgeOneGuideOpen = false; this.renderViews(); },
        () => { this.edgeOneGuideOpen = false; this.renderSettings(root, true, showTitle); });
      return;
    }
    if (!guide) {
      const card = page.createDiv({ cls: "simple-card simple-share-settings-card" });
      new Setting(card).setName("启用笔记分享").setDesc("关闭后暂停本机分享操作，已发布的网站仍然保留。")
        .addToggle(toggle => toggle.setValue(this.manifest.enabled).setDisabled(this.isPublishing || this.checkingDeployment).onChange(async value => { try { await this.change(manifest => { manifest.enabled = value; }); if (value) await this.open(); } catch (error) { this.fail(error); } }));
      const dependent = card.createDiv({ cls: `simple-one-sync-engine-body simple-share-settings-dependent${this.manifest.enabled ? "" : " is-disabled"}` });
      dependent.inert = !this.manifest.enabled;
      const repositoryRow = new Setting(dependent).setName("当前分享用仓库").setClass("simple-share-repository-row");
      if (this.manifest.site.repo) {
        const url = `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}`;
        shareExternalLink(repositoryRow.controlEl, url, url);
      } else repositoryRow.descEl.setText("尚未接入，请先完成笔记分享引导。");
      new Setting(dependent).setName("笔记分享后路径（默认路径）").setDesc("设置新分享笔记在分享专用库中的默认目录，已有分享的目录保留。")
        .addDropdown(dropdown => dropdown.addOptions({ root: "在分享仓库的根目录", source: "跟随原笔记库路径" }).setValue(this.manifest.defaultPath || "source").setDisabled(!this.manifest.enabled || this.isPublishing).onChange(value => {
          if (value === "root" || value === "source") void this.change(manifest => { manifest.defaultPath = value; }).catch(error => this.fail(error));
        }));
      new Setting(dependent).setName("当前部署状态").setDesc("检查最近一次推送的分享是否已完成部署。");
      const providers = dependent.createDiv({ cls: "simple-share-deployment-providers" });
      const deployment = new Setting(providers).setName("GitHub Pages").setClass("simple-share-provider-row")
        .addButton(button => button.setButtonText(this.checkingDeployment ? "检查中…" : "检查网站部署").setDisabled(!this.manifest.enabled || this.isPublishing || this.checkingDeployment || !this.manifest.site.repo).onClick(() => { void this.checkDeployment().catch(error => this.fail(error)); }));
      if (this.manifest.site.repo) {
        const links = deployment.descEl.createDiv({ cls: "simple-share-provider-links" });
        const website = siteUrl(this.manifest.site);
        if (website) shareExternalLink(links, "打开分享网站 ↗", website);
        shareExternalLink(links, "在 GitHub 检查网站设置 ↗", `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}/settings/pages`);
      }
      const githubFallback = this.manifest.site.repo
        ? `已关联项目 ${this.manifest.site.owner}/${this.manifest.site.repo}，${this.manifest.site.initialized ? "尚未查询部署状态。" : "尚未初始化网站。"}`
        : "尚未关联分享仓库。";
      deployment.infoEl.createEl("p", { text: this.githubDeploymentError || this.githubDeploymentStatus || githubFallback, cls: `simple-share-deployment-result ${this.githubDeploymentError ? "simple-share-error" : this.githubDeploymentStatus === "网站已更新" ? "simple-share-success" : "simple-share-status"}`, attr: { role: "status", "aria-live": "polite" } });
      renderEdgeOneRow(providers, this.edgeone, this.manifest.enabled, this.isPublishing,
        () => {
          this.edgeOneGuideOpen = true; this.renderViews();
          if (this.edgeone.state.step === 2) void this.edgeone.run(() => this.edgeone.enterRepositoryStep());
        });
      new Setting(dependent).setName("复制内容").setDesc("选择复制或分享时包含的内容。");
      const copyOptions = dependent.createDiv({ cls: "simple-share-copy-options", attr: { role: "group", "aria-label": "复制内容" } });
      for (const [key, title] of [["title", "笔记标题"], ["github", "GitHub 链接"], ["pageOne", "Page One 链接"]] as const) {
        const label = copyOptions.createEl("label", { cls: "simple-share-copy-option" });
        const checkbox = label.createEl("input", { attr: { type: "checkbox", "aria-label": title } });
        label.createSpan({ text: title });
        checkbox.checked = this.copyContent[key];
        checkbox.disabled = !this.manifest.enabled || this.isPublishing;
        checkbox.addEventListener("change", () => { void this.updateCopyContent(key, checkbox.checked).catch(error => this.fail(error)); });
      }
      const appearance = settingsSection(page, "界面设置");
      appearance.addClass("simple-share-settings-card");
      appearance.toggleClass("is-disabled", !this.manifest.enabled); appearance.inert = !this.manifest.enabled;
      new Setting(appearance).setName("显示文件路径").setDesc("在笔记名称旁显示原笔记所在目录。")
        .addToggle(toggle => toggle.setValue(this.display.showPaths).setDisabled(!this.manifest.enabled).onChange(value => this.updateDisplay({ showPaths: value })));
      new Setting(appearance).setName("列表布局")
        .addDropdown(dropdown => dropdown.addOptions({ list: "平铺笔记", source: "本地目录", public: "公开目录" }).setValue(this.display.layout).setDisabled(!this.manifest.enabled).onChange(value => {
          if (value === "list" || value === "source" || value === "public") this.updateDisplay({ layout: value });
        }));
      new Setting(appearance).setName("名称排序")
        .addDropdown(dropdown => dropdown.addOptions({ asc: "正序 A→Z", desc: "倒序 Z→A" }).setValue(this.display.descending ? "desc" : "asc").setDisabled(!this.manifest.enabled).onChange(value => this.updateDisplay({ descending: value === "desc" })));
      const templateDisabled = !this.manifest.enabled || this.isPublishing || this.templateBusy;
      const templateSetting = new Setting(appearance).setName("HTML 模板")
        .addDropdown(dropdown => dropdown.addOptions(this.templateFiles).setValue(this.templateFile).setDisabled(templateDisabled).onChange(value => {
          void this.selectTemplate(value).catch(error => { this.fail(error); this.renderViews(); });
        }))
        .addButton(button => button.setButtonText("导入模板").setDisabled(templateDisabled).onClick(() => this.importTemplate()))
        .addButton(button => button.setButtonText("导出模板").setDisabled(templateDisabled).onClick(() => { void this.exportTemplate().catch(error => this.fail(error)); }))
        .addButton(button => button.setButtonText("恢复默认模板").setDisabled(templateDisabled).onClick(() => {
          void this.restoreDefaultTemplate().catch(error => {
            this.templateMessage = error instanceof Error ? error.message : String(error); this.renderViews(); new Notice(this.templateMessage);
          });
        }));
      templateSetting.infoEl.createEl("p", { text: this.templateFile === DEFAULT_TEMPLATE_FILE ? "当前使用默认 HTML 模板。" : `当前使用自定义 HTML 模板：${this.templateFile}`, cls: "simple-share-template-status", attr: { role: "status", "aria-live": "polite" } });
      return;
    }
    const steps = ["安装与授权", "公开仓库", "初始化网站", "完成"];
    const progress = this.manifest.site.guideProgress ?? (this.manifest.site.initialized ? 5 : this.manifest.site.repo ? 3 : 1);
    this.guideAvailableStep = Math.min(4, progress);
    const completed = !!this.manifest.site.repo && this.manifest.site.initialized === true;
    const status = page.createDiv({ cls: `simple-one-sync-setup-status is-${this.error ? "error" : completed ? "success" : "disconnected"}`, attr: { role: "status" } });
    setIcon(status.createSpan({ cls: "simple-one-sync-setup-status__icon" }), this.error ? "triangle-alert" : completed ? "check" : "unplug");
    const copy = status.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    copy.createEl("strong", { text: this.error ? "分享设置需要检查" : completed ? "分享库首次设置已完成" : this.manifest.site.repo ? "分享仓库已连接，首次设置待核验" : "分享库首次设置尚未完成" });
    copy.createEl("p", { text: this.error || (completed ? "公开仓库与阅读页面已初始化；网站当前部署状态可在分享设置中检查。" : "按下方步骤完成授权、连接公开仓库并初始化网站。") });
    const restart = status.createEl("button", { text: "重新检查或修复分享设置", attr: { type: "button" } });
    restart.disabled = this.setupBusy || this.isPublishing;
    restart.addEventListener("click", () => { void (async () => {
      if (restart.disabled) return;
      await this.change(manifest => { manifest.site.guideProgress = 1; }, false);
      this.authController?.abort(); this.authorized = false; this.token = "";
      this.guideStep = 1; this.guideAvailableStep = 1; this.error = ""; this.status = "";
      this.renderViews();
    })().catch(error => this.fail(error)); });
    const nav = page.createDiv({ cls: "simple-one-sync-setup-nav" });
    steps.forEach((label, index) => {
      const step = index + 1;
      const button = nav.createEl("button", {
        cls: `simple-one-sync-setup-nav__step${step === this.guideStep ? " is-active" : ""}${step < progress ? " is-done" : ""}`,
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
      tools.createEl("p", { text: "GitHub 用于存放公开分享仓库。电脑端优先使用 GitHub CLI；手机端或未安装 CLI 时使用 token。按分享清单生成文件，只推送有变化的内容。" });
      const link = (parent: HTMLElement, text: string, href: string): void => { parent.createEl("a", { text, href, attr: { target: "_blank", rel: "noopener noreferrer" } }); };
      const links = tools.createDiv({ cls: "simple-one-sync-setup-links" });
      link(links, "下载 GitHub CLI ↗", "https://cli.github.com/");
      link(links, "注册 GitHub ↗", "https://github.com/signup");
      const auth = content.createDiv({ cls: "simple-one-sync-setup-detail simple-one-sync-setup-auth" });
      new Setting(auth).setName("选择 GitHub 授权方式").setHeading();
      const verify = async () => {
        if (await this.useCli()) { await this.host.sync.exec("gh", ["auth", "status", "--active", "--hostname", "github.com"]); }
        const account = JSON.parse(await this.github("user")) as { login: string };
        await this.change(manifest => { manifest.site.guideProgress = Math.max(manifest.site.guideProgress ?? (manifest.site.initialized ? 5 : 1), 2); }, false);
        this.authorized = true; this.status = `已验证 GitHub 账号：${account.login}`; this.guideStep = 2; this.guideAvailableStep = Math.max(this.guideAvailableStep, 2);
      };
      const browserLogin = async () => {
        if (!await this.useCli()) throw new Error("当前设备使用 API 分享，请选择 Token 授权。");
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
        button.disabled = this.setupBusy || this.busy || (mode === "browser" && (Platform.isMobile || this.cliAvailable === false));
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
        auth.createEl("p", { text: "Token 用于核验与发布。电脑 CLI 路径交给 GitHub CLI 保存；API 路径保存在本机 Obsidian 密钥存储中，不上传到任何仓库。" });
        const tokenHint = auth.createDiv({ cls: "simple-one-sync-setup-token-hint" });
        setIcon(tokenHint.createSpan({ cls: "simple-one-sync-setup-token-hint__icon", attr: { "aria-hidden": "true" } }), "circle-alert");
        tokenHint.createSpan({ text: "使用具有公开仓库写入与 Pages 管理权限的 GitHub Token，核验后继续连接分享仓库。" });
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
              if (await this.useCli()) await this.host.sync.exec("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], false, true, 120000, undefined, token + "\n");
              else {
                await githubJson(token, "/user");
                if (requireApiVersion("1.11.4")) this.host.app.secretStorage.setSecret(this.secretId(), token);
                else throw new Error("API 授权需要 Obsidian 1.11.4 或以上版本，请升级后重试。");
              }
              await verify();
            });
          });
        }).settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
      } else if (this.authMode === "verify") {
        auth.createEl("p", { text: this.setupBusy ? "正在验证 GitHub 授权…" : this.authorized ? "当前 GitHub 授权已核验。" : "选择后会自动验证 CLI 授权或本机保存的 Token。", cls: "simple-one-sync-setup-feedback" });
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
      container.createEl("p", { text: "分享管理在独立的右侧面板打开，不会替换同步引导或下载待办。若当前在设置窗口中，将关闭设置窗口以显示该面板；已保存的接入进度保留。" });
      action("前往右侧分享管理", async () => { await this.open(true); });
    }
  }
  private async createRepository(name: string): Promise<void> {
    this.takenRepository = undefined;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || [".", ".."].includes(name)) throw new Error("仓库名只能包含字母、数字、点、下划线和连字符。");
    this.reportRepository("正在确认 GitHub 账号…");
    const owner = (await this.useCli()) ? (await this.host.sync.exec("gh", ["api", "user", "--jq", ".login"])).trim() : (JSON.parse(await this.github("user")) as { login:string }).login;
    if (this.manifest.site.repo && (this.manifest.site.repo.toLowerCase() !== name.toLowerCase() || this.manifest.site.owner.toLowerCase() !== owner.toLowerCase())) throw new Error("已绑定分享仓库；第一版不支持直接迁移，请继续原仓库。");
    const taken = () => {
      this.takenRepository = { owner, name };
      return new Error(`仓库名称已被使用：${owner}/${name}。请更换名称，或选择「使用已有公开分享仓库」连接原仓库。`);
    };
    let exists = false;
    this.reportRepository(`正在检查仓库名称 ${owner}/${name} 是否已被使用…`);
    try { await this.github(`repos/${owner}/${name}`); exists = true; }
    catch (error) { if (!String(error).includes("404")) throw error; }
    if (exists) throw taken();
    this.reportRepository(`仓库名称可用，正在创建公开分享仓库 ${owner}/${name}…`);
    try { await this.github("user/repos", "POST", { name, private:false, auto_init:true }); }
    catch (error) {
      if (/already exists|already been taken|name[^\n]*taken/i.test(String(error))) throw taken();
      throw error;
    }
    await this.bind(owner, name);
  }
  private async bind(owner: string, repo: string): Promise<void> {
    this.reportRepository("正在核验仓库地址与当前分享配置…");
    if (this.manifest.site.repo && `${owner}/${repo}`.toLowerCase() !== `${this.manifest.site.owner}/${this.manifest.site.repo}`.toLowerCase()) throw new Error("已绑定另一个分享仓库，不能直接切换。");
    const value = JSON.parse(await this.github(`repos/${owner}/${repo}`)) as { default_branch?: string };
    const site = { owner, repo, branch: value.default_branch || "main" };
    this.reportRepository(`已读取默认分支 ${site.branch}；正在核验公开状态、归档状态和写入权限…`);
    await (await this.repository(site)).verify();
    this.reportRepository("核验通过，正在保存分享仓库连接…");
    await this.change(manifest => {
      const initialized = manifest.site.owner.toLowerCase() === owner.toLowerCase() && manifest.site.repo.toLowerCase() === repo.toLowerCase() && manifest.site.branch === site.branch ? manifest.site.initialized : undefined;
      manifest.site = { ...site, ...(initialized !== undefined ? { initialized } : {}), guideProgress: initialized ? 5 : 3 };
    }); this.guideStep = 3; this.guideAvailableStep = Math.max(this.guideAvailableStep, 3);
  }
  private reportRepository(text: string): void {
    this.repositoryFeedback = text;
    if (this.setupBusy) this.renderViews();
  }
  detachSettings(): void { this.setupHost = undefined; this.setupTitleChanged = undefined; this.authController?.abort(); this.token = ""; this.edgeone.stop(); this.edgeOneGuideOpen = false; }
}
export class ShareView extends ItemView {
  private query = "";
  private get showPaths(): boolean { return this.feature.display.showPaths; }
  private get layout(): ShareLayout { return this.feature.display.layout; }
  private get descending(): boolean { return this.feature.display.descending; }
  private collapsed = new Set<string>();
  private editing = false;
  private selected = new Set<string>();
  constructor(leaf: WorkspaceLeaf, private feature: ShareFeature) { super(leaf); }
  getViewType(): string { return VIEW; }
  getDisplayText(): string { return "分享管理"; }
  getIcon(): string { return "share-2"; }
  getState(): Record<string, unknown> { return { ...super.getState(), ...this.feature.display, collapsed: [...this.collapsed] }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    this.feature.restoreDisplay(state);
    if (Array.isArray(state.collapsed)) this.collapsed = new Set(state.collapsed.filter((key): key is string => typeof key === "string"));
    await super.setState(state, result); this.render();
  }
  async onOpen(): Promise<void> { this.render(); }
  render(): void {
    this.contentEl.empty(); this.contentEl.addClass("simple-share-panel");
    const header = this.feature.addPublishButton(new Setting(this.contentEl))
      .addButton(button => {
        button.setIcon("square-pen").setTooltip(this.editing ? "退出编辑" : "编辑分享")
          .setDisabled(this.feature.isPublishing || !this.feature.manifest.enabled).onClick(() => {
            this.editing = !this.editing; this.selected.clear(); this.render();
          });
        button.buttonEl.addClass("simple-share-header-icon", "simple-share-edit", "clickable-icon", "nav-action-button");
        button.buttonEl.setAttribute("aria-label", "编辑分享");
        button.buttonEl.setAttribute("aria-pressed", String(this.editing));
      })
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
      button.setIcon("settings").setTooltip("界面与复制设置").onClick(event => {
        const menu = new Menu();
        menu.addItem(item => item.setTitle("界面设置").setIcon("settings").setDisabled(true));
        menu.addItem(item => item.setTitle("显示文件路径").setIcon(this.showPaths ? "check-square" : "square").onClick(() => {
          this.feature.updateDisplay({ showPaths: !this.showPaths });
        }));
        this.feature.addCopyContentMenu(menu);
        menu.showAtMouseEvent(event);
      });
      button.buttonEl.addClass("simple-share-header-icon", "clickable-icon", "nav-action-button");
    });
    header.settingEl.addClass("simple-share-header");
    const primary = header.settingEl.querySelector<HTMLButtonElement>(".simple-share-publish")!;
    primary.addClass("simple-share-new", "mod-cta");
    const uploadIcon = primary.createSpan({ cls: "simple-share-new-icon", attr: { "aria-hidden": "true" } });
    setIcon(uploadIcon, "upload-cloud"); primary.prepend(uploadIcon);
    for (const id of this.selected) if (!this.feature.rows.some(row => row.id === id)) this.selected.delete(id);
    const renderList = () => this.feature.renderPanel(body, this.query, this.showPaths, this.layout, this.collapsed, () => this.app.workspace.requestSaveLayout(), this.descending,
      this.editing ? { mode: "delete", selected: this.selected, onChange: () => { renderSelection(); } } : undefined);
    new Setting(this.contentEl).addSearch(search => search.setPlaceholder("搜索分享笔记…").setValue(this.query).onChange(value => { this.query = value; renderList(); }))
      .settingEl.addClass("simple-share-search");
    const selectionBar = this.contentEl.createDiv({ cls: "simple-share-selection-bar" });
    const renderSelection = () => {
      selectionBar.empty();
      selectionBar.hidden = !this.editing;
      if (!this.editing) return;
      selectionBar.createSpan({ text: `批量操作 · 已选 ${this.selected.size} 篇`, attr: { role: "status", "aria-live": "polite" } });
      const button = (label: string, action: () => void, needsSelection = false) => {
        const control = selectionBar.createEl("button", { text: label, attr: { type: "button" } });
        control.disabled = this.feature.isPublishing || !this.feature.manifest.enabled || needsSelection && !this.selected.size;
        control.addEventListener("click", action); return control;
      };
      button("全选", () => {
        body.querySelectorAll<HTMLInputElement>(".simple-share-selection:not(:disabled)").forEach(input => { this.selected.add(input.dataset.shareId!); });
        renderList(); renderSelection();
      }).setAttribute("title", "全选搜索筛选后显示的笔记");
      button("反选", () => {
        body.querySelectorAll<HTMLInputElement>(".simple-share-selection:not(:disabled)").forEach(input => {
          const id = input.dataset.shareId!;
          if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
        });
        renderList(); renderSelection();
      }).setAttribute("title", "反选搜索筛选后显示的笔记");
      button("清空", () => { this.selected.clear(); renderList(); renderSelection(); });
      {
        const move = button("移动", () => new ShareDirectoryModal(this.feature, [...this.selected], () => { this.selected.clear(); this.render(); }).open(), true);
        move.addClass("simple-share-selection-right");
        if ([...this.selected].some(id => !this.feature.manifest.notes[id] || this.feature.manifest.notes[id].deleted)) move.disabled = true;
      }
      const remove = button("删除", () => { void this.deleteSelected(); }, true);
      remove.addClass("mod-warning");
    };
    renderSelection();
    const prefix = this.feature.publishingTitle ? `${this.feature.busy ? "正在发布" : ""}《${this.feature.publishingTitle}》 · ` : "";
    if (this.feature.error || this.feature.status || this.feature.isPublishing) {
      this.contentEl.createEl("p", { text: prefix + (this.feature.error || this.feature.status || "正在准备发布…"), cls: this.feature.error ? "simple-share-error" : "simple-share-status", attr: { role: "status", "aria-live": "polite" } });
    }
    const body = this.contentEl.createDiv(); renderList();
  }
  private async deleteSelected(): Promise<void> {
    const ids = [...this.selected];
    if (!ids.length || !await confirmAction(this.app, `删除所选 ${ids.length} 篇分享？公开副本和网站列表项将被移除，本库原笔记保留。`)) return;
    try { await this.feature.removeShares(ids); this.selected.clear(); this.render(); }
    catch (error) { new Notice(String(error)); }
  }
}
