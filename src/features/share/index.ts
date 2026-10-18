import { addIcon, Component, FuzzySuggestModal, ItemView, MarkdownView, Menu, Modal, Notice, Platform, Setting, setIcon, setTooltip, parseYaml, requireApiVersion, TFile, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type SimplePlugin from "../../main";
import { runAsync } from "../../shared/async";
import { confirmAction } from "../../shared/confirm";
import { settingsSection } from "../../shared/settingsLayout";
import { registerMarkdownAction } from "../../shared/markdownAction";
import { ID_PATTERN, SHARE_FOLDER, emptyManifest, DEFAULT_SHARE_COPY_CONTENT, formatShareContent, newShareId, normalizeShareDirectory, normalizeShareDomainUrl, parseManifest, parsePublishState, serializeManifest, shareDomainNoteUrl, shareNotePath, siteUrl, type ShareCopyContent, type ShareManifest, type PublishState } from "./model";
import { addLibrary, ensureLibraries, libraryOptions, removeLibrary, selectLibrary, selectedLibraryIds } from "./libraries";
import { exportNote } from "./export";
import { ShareRepository, websiteFiles } from "./repository";
import { ApiShareRepository, FallbackShareRepository, canFallbackToApi } from "./apiRepository";
import { githubJson } from "../sync/githubApi";
import { shareAppearance } from "./appearance";
import { DEFAULT_TEMPLATE_FILE, TEMPLATE_SELECTION_FILE, bundledReaderFiles, templateAppearance, validateShareTemplate } from "./template";
import { EDGEONE_PROJECTS_URL, EdgeOneConnection, edgeOneWebsite, type EdgeOneCustomDomain } from "./edgeone";
import { renderEdgeOneGuide, renderMainlandPreviewNotice, shareExternalLink, type EdgeOneRepositoryVisibility } from "./edgeoneUi";

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
  private guideNewLibrarySelected = false;
  private authorized = false;
  private setupBusy = false;
  private deviceCode = "";
  private authController?: AbortController;
  private setupHost?: HTMLElement;
  private setupGuide = false;
  private setupShowTitle = true;
  private setupTitleChanged?: (title: string) => void;
  private managingLibraryId: string | null = null;
  private authMode: "browser" | "token" | "verify" | null = null;
  private repoMode: "create" | "existing" | null = null;
  private hostingMode: "edgeone" | "github" | null = null;
  private guideVisibility?: { key: string; private: boolean };
  private guideVisibilityAttemptedKey = "";
  private guideVisibilityChecking = false;
  private guideVisibilityError = "";
  private guideVisibilityRequest = 0;
  private guideVisibilityChangedKey = "";
  private guidePages?: { key: string; url: string; status: string };
  private guidePagesAttemptedKey = "";
  private guidePagesChecking = false;
  private guidePagesError = "";
  private guidePagesRequest = 0;
  private edgeOneDeploymentFailed = false;
  private edgeOneGuideAttemptFailed = false;
  private draftName = "";
  private draftRepo = "";
  private makeExistingRepositoryPrivate = false;
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
  private backend: "cli" | "api" = Platform.isMobile ? "api" : "cli";
  private async hasCli(): Promise<boolean> {
    if (Platform.isMobile) return false;
    return this.host.sync.exec("gh", ["--version"]).then(() => true, () => false);
  }
  private async useCli(): Promise<boolean> {
    if (Platform.isMobile) return false;
    try {
      await this.host.sync.exec("gh", ["auth", "status", "--active", "--hostname", "github.com"]);
      if (!(await this.host.sync.exec("gh", ["api", "user", "--jq", ".login"])).trim()) throw new Error("GitHub CLI 未返回账号信息。");
      this.backend = "cli";
      return true;
    } catch {
      this.backend = "api";
      return false;
    }
  }
  private secretId(): string { return `${this.host.manifest.id}-share-github`; }
  private savedToken(): string { return requireApiVersion("1.11.4") ? this.host.app.secretStorage?.getSecret(this.secretId()) ?? "" : ""; }
  private async fallbackToken(): Promise<string> {
    const saved = this.savedToken();
    if (saved || Platform.isMobile) return saved;
    try { return (await this.host.sync.exec("gh", ["auth", "token", "--hostname", "github.com"])).trim(); }
    catch { return ""; }
  }
  private async github(path: string, method = "GET", body?: unknown): Promise<string> {
    let token = "";
    if (await this.useCli()) {
      try {
        const result = await this.host.sync.exec("gh", ["api", path, ...(method === "GET" ? [] : ["--method", method]), ...(body === undefined ? [] : ["--input", "-"])], false, true, 120000, undefined, body === undefined ? undefined : JSON.stringify(body));
        this.backend = "cli";
        return result;
      } catch (error) {
        if (!canFallbackToApi(error, method)) throw error;
        token = await this.fallbackToken();
        if (!token) throw error;
      }
    }
    this.backend = "api";
    return JSON.stringify(await githubJson(token || await this.fallbackToken(), `/${path}`, method, body));
  }
  private async repository(site = this.manifest.site): Promise<ShareRepository> {
    const token = await this.fallbackToken();
    if (await this.useCli()) return new FallbackShareRepository(this.host, site, token, () => { this.backend = "api"; });
    this.backend = "api";
    return new ApiShareRepository(this.host, site, token);
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
      }, () => this.renderViews(), undefined, () => this.libraryId);
  }
  private path(name: string): string { return `${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}/${name}`; }
  private suggestedRepoName(): string {
    const settings = this.host.sync.settings;
    const remote = settings?.boundRepoUrl || settings?.mobile?.repoUrl || settings?.gitRemoteUrl || settings?.setupRepoUrl || "";
    const name = remote.match(/[:/]([^/:]+?)(?:\.git)?\/?$/)?.[1] || this.host.app.vault?.getName?.() || "notes";
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 94) || "notes";
    return `${safe.toLowerCase()}-share`;
  }
  async initialize(): Promise<void> {
    await this.reload().catch(error => { this.error = String(error); });
    if (!this.manifest.site.repo) {
      const existing = Object.entries(this.libraries)[0]?.[0];
      if (existing) await this.change(manifest => selectLibrary(manifest, existing), false);
    }
    await this.edgeone.load().catch(error => { this.edgeone.error = error instanceof Error ? error.message : String(error); });
    await this.readTemplateSelection().catch(error => { this.templateMessage = error instanceof Error ? error.message : String(error); });
    const progress = this.manifest.site.guideProgress ?? (this.manifest.site.initialized ? 7 : this.manifest.site.repo ? 3 : 1);
    this.guideStep = Math.min(4, progress); this.guideAvailableStep = Math.min(4, progress);
    addIcon("simple-share-sort-asc", '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M25 85V15m-12 12 12-12 12 12M60 35l10-25 10 25M64 27h12M60 60h20L60 85h20"/></g>');
    addIcon("simple-share-sort-desc", '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M25 15v70m-12-12 12 12 12-12M60 10h20L60 35h20M60 85l10-25 10 25M64 77h12"/></g>');
    const settingsBadge = '<path d="M71 60h12l2 7 7 2 4 10-5 5 1 8-10 4-5-5-8 1-4-10 5-5-1-8 7-4z"/><circle cx="79" cy="79" r="6"/>';
    const pathVisibilityIcon = '<path d="M6 35c19-32 57-32 76 0-19 32-57 32-76 0z"/><circle cx="44" cy="35" r="13"/><path stroke-width="5" d="M61 91V67h12l5 6h17v18z"/>';
    addIcon("simple-share-paths-visible", `<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${pathVisibilityIcon}</g>`);
    addIcon("simple-share-paths-hidden", `<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${pathVisibilityIcon}<path d="M13 8l60 53"/></g>`);
    addIcon("simple-share-copy-settings", `<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M27 53H13V9h43v14M55 79H28V26h43v26"/>${settingsBadge}</g>`);
    this.refreshActions = registerMarkdownAction(this.host, "data-simple-share-note", () => this.manifest.enabled,
      view => { const action = view.addAction("share-2", "分享当前笔记", runAsync(async () => {
        if (!view.file) return;
        await view.save();
        await this.share(view.file).catch(error => this.fail(error));
      }));
        action.addEventListener("contextmenu", event => {
          event.preventDefault(); event.stopPropagation();
          const menu = new Menu();
          const selected = selectedLibraryIds(this.manifest);
          const items: { id: string; item: import("obsidian").MenuItem }[] = [];
          const hide = menu.hide.bind(menu);
          let keepOpen = false;
          menu.hide = () => { if (keepOpen) { keepOpen = false; return menu; } return hide(); };
          for (const [id, label] of Object.entries(this.libraries)) menu.addItem(item => {
            items.push({ id, item });
            item.setTitle(label).setIcon(selected.includes(id) ? "check-square" : "square")
              .setDisabled(this.isPublishing || this.setupBusy || this.edgeone.busy || (selected.length === 1 && selected.includes(id)))
              .onClick(() => {
              keepOpen = true;
              for (const choice of items) choice.item.setDisabled(true);
              void this.toggleShareTarget(id).catch(error => this.fail(error)).finally(() => {
                const current = selectedLibraryIds(this.manifest);
                for (const choice of items) choice.item.setIcon(current.includes(choice.id) ? "check-square" : "square")
                  .setDisabled(this.isPublishing || this.setupBusy || this.edgeone.busy || current.length === 1 && current.includes(choice.id));
              });
              });
          });
          menu.addItem(item => item.setTitle("添加分享库").setIcon("plus").setDisabled(this.isPublishing || this.setupBusy || this.edgeone.busy).onClick(() => void this.newLibrary().catch(error => this.fail(error))));
          menu.showAtMouseEvent(event);
        }); return action; },
      action => {
        const disabled = this.busy || this.sharing;
        action.setAttr("aria-disabled", String(disabled));
        const selected = selectedLibraryIds(this.manifest).map(id => this.libraries[id]).filter(Boolean);
        setTooltip(action, disabled ? "正在发布分享，请稍候" : selected.length ? `分享到：${selected.join("、")}（右键选择）` : "尚未配置分享库（右键选择）");
      });
    this.host.registerView(VIEW, leaf => new ShareView(leaf, this));
    this.host.addCommand({ id: "share-current-note", name: "分享此笔记", checkCallback: checking => {
      const file = this.host.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (!file) return false; if (!checking) void this.share(file).catch(error => this.fail(error)); return true;
    } });
    this.host.addCommand({ id: "open-share-manager", name: "打开分享管理", callback: () => { void this.open(); } });
    this.host.addCommand({ id: "publish-shared-notes", name: "推送新分享", callback: () => { void this.publish().catch(error => this.fail(error)); } });
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
    if (!this.manifest.libraries && this.manifest.site.initialized) this.manifest.site.guideProgress = 7;
    ensureLibraries(this.manifest);
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
  get libraryId(): string { return this.manifest.libraries?.active ?? "legacy"; }
  get libraries(): Record<string, string> { return libraryOptions(this.manifest); }
  get website(): string { return this.manifest.site.hosting === "edgeone" ? this.edgeone.website : siteUrl(this.manifest.site); }
  get defaultLibraryId(): string { return ensureLibraries(this.manifest).default; }
  async toggleShareTarget(id: string): Promise<void> {
    if (this.isPublishing || this.setupBusy || this.edgeone.busy) throw new Error("请等待当前任务完成后选择分享库。");
    await this.change(manifest => {
      const libraries = ensureLibraries(manifest);
      if (!libraries.entries[id] || !(id === libraries.active ? manifest : libraries.entries[id]).site.repo) throw new Error("分享库尚未完成接入。");
      const selected = libraries.selected!;
      if (selected.includes(id)) {
        if (selectedLibraryIds(manifest).length <= 1) throw new Error("请至少保留一个分享库。");
        libraries.selected = selected.filter(candidate => candidate !== id);
      } else selected.push(id);
    }, false);
    this.refreshActions(); this.renderViews();
  }
  async switchLibrary(id: string, duringShare = false): Promise<void> {
    if (this.busy || this.sharing && !duringShare || this.setupBusy || this.edgeone.busy || this.checkingDeployment) throw new Error("请等待当前任务完成后切换分享库。");
    await this.change(manifest => selectLibrary(manifest, id), false);
    this.guideNewLibrarySelected = false;
    await this.edgeone.load(); this.published = { version: 1, notes: {}, files: [] };
    this.error = ""; this.status = ""; this.githubDeploymentError = ""; this.githubDeploymentStatus = "";
    this.draftRepo = ""; this.repoMode = null; this.hostingMode = null; this.draftName = ""; this.repositoryFeedback = "";
    this.edgeOneGuideAttemptFailed = false; this.edgeOneDeploymentFailed = false;
    const progress = this.manifest.site.guideProgress ?? (this.manifest.site.initialized ? 7 : this.manifest.site.repo ? 3 : 1);
    this.guideStep = Math.min(4, progress);
    await this.scan(); this.renderViews();
  }
  private async newLibrary(): Promise<void> {
    if (this.isPublishing || this.setupBusy || this.edgeone.busy) throw new Error("请等待当前任务完成。");
    await this.change(manifest => addLibrary(manifest), false);
    this.guideNewLibrarySelected = false;
    await this.switchLibrary(this.libraryId); this.guideStep = 1; this.guideAvailableStep = 1;
    if (!this.setupHost?.isConnected) this.host.sync.openPluginSettings(true);
    if (this.setupHost) this.renderSettings(this.setupHost, true, this.setupShowTitle, this.setupTitleChanged);
  }
  private async removeShareLibrary(id: string): Promise<void> {
    if (this.isPublishing || this.setupBusy || this.edgeone.busy || this.checkingDeployment) throw new Error("请等待当前任务完成后删除分享库记录。");
    await this.reload();
    const libraries = ensureLibraries(this.manifest);
    const stored = libraries.entries[id];
    if (!stored) throw new Error("分享库不存在。");
    const site = id === libraries.active ? this.manifest.site : stored.site;
    const label = site.repo ? `${site.owner}/${site.repo}` : "未完成接入的分享库";
    if (!await confirmAction(this.host.app, `从当前笔记库的分享设置中删除「${label}」？GitHub 仓库、已发布网站和原笔记不会删除。`)) return;
    if (this.isPublishing || this.setupBusy || this.edgeone.busy || this.checkingDeployment) throw new Error("请等待当前任务完成后删除分享库记录。");
    await this.change(manifest => removeLibrary(manifest, id), false);
    if (this.managingLibraryId === id) this.managingLibraryId = null;
    const adapter = this.host.app.vault.adapter;
    const suffix = id === "legacy" ? "" : `.${id}`;
    let cacheError = false;
    for (const name of [`share-local.json${suffix}`, `share-local.json.edgeone${suffix}`, `share-local.json.details${suffix}`]) {
      const path = this.path(name);
      try { if (await adapter.exists(path)) await adapter.remove(path); }
      catch { cacheError = true; }
    }
    await this.switchLibrary(this.libraryId);
    if (cacheError) new Notice("分享库记录已删除，但本机缓存未能全部清理。");
  }
  private openShareLibraryDetails(id: string): void {
    if (!ensureLibraries(this.manifest).entries[id]) throw new Error("分享库不存在。");
    this.managingLibraryId = id;
    this.renderViews();
  }
  get isLibraryManagementOpen(): boolean { return this.managingLibraryId !== null; }
  backFromShareLibraryManagement(): boolean {
    if (this.managingLibraryId === null) return false;
    this.managingLibraryId = null; this.renderViews();
    return true;
  }
  private renderShareLibraryDetails(parent: HTMLElement, id: string): void {
    const libraries = ensureLibraries(this.manifest);
    const stored = libraries.entries[id];
    if (!stored) throw new Error("分享库不存在。");
    const site = { ...(id === libraries.active ? this.manifest.site : stored.site) };
    const name = site.repo ? `${site.owner}/${site.repo}` : "未完成接入的分享库";
    const body = parent.createDiv({ cls: "simple-card simple-share-library-detail" });
    const controls = parent.createDiv({ cls: "simple-card simple-share-library-detail__controls" });
    let checking = false;
    let operating = false;
    let githubError = "";
    let actionError = "";
    let loadingLocal = true;
    let edgeoneLoading = true;
    let checkedAt = 0;
    let visibility: boolean | undefined;
    let pages: { url: string; status: string } | undefined;
    let pagesError = "";
    let edgeone: { projectId?: string; projectName?: string; website?: string; area?: string; completed?: boolean } | undefined;
    let edgeoneError = "";
    let edgeoneDomains: EdgeOneCustomDomain[] | undefined;
    let edgeoneDomainsChecked = false;
    let edgeoneDomainsError = "";
    let domainsProjectId: string | undefined;
    let editingDomainId: string | null = null;
    let draftDomainName = "";
    let draftDomainUrl = "";
    const heading = (section: HTMLElement, label: string): void => {
      const row = section.createDiv({ cls: "simple-share-library-detail__heading" });
      row.createSpan({ text: label });
    };
    const detailRow = (section: HTMLElement, label: string): HTMLElement => {
      const line = section.createDiv({ cls: "simple-share-library-detail__row" });
      line.createSpan({ cls: "simple-share-library-detail__label", text: label });
      return line.createDiv({ cls: "simple-share-library-detail__value" });
    };
    const detailLink = (section: HTMLElement, label: string, text: string, url: string): void => {
      detailRow(section, label).createEl("a", { text: `${text} ↗`, href: url, attr: { target: "_blank", rel: "noopener noreferrer" } });
    };
    const render = (): void => {
      body.empty();
      controls.empty();
      const github = body.createDiv({ cls: "simple-share-library-detail__section" });
      heading(github, "GitHub Pages");
      if (!site.repo) github.createEl("p", { text: "尚未连接 GitHub 分享仓库。" });
      else {
        detailLink(github, "关联仓库", `https://github.com/${name}`, `https://github.com/${name}`);
        const choices = detailRow(github, "仓库可见性").createDiv({ cls: `simple-share-library-detail__visibility-choices${visibility === false ? " is-public" : ""}`, attr: { role: "group", "aria-label": "仓库可见性" } });
        for (const [label, makePrivate] of [["私有", true], ["公开", false]] as const) {
          const option = choices.createEl("button", { text: label, attr: { type: "button", "aria-pressed": String(visibility === makePrivate) } });
          option.disabled = loadingLocal || checking || operating || visibility === undefined || !!githubError || this.busy || this.setupBusy;
          option.addEventListener("click", () => { void changeVisibility(makePrivate); });
        }
        if (loadingLocal || checking || githubError || visibility === undefined) github.createEl("p", {
          text: loadingLocal ? "正在读取上次检查结果…" : checking ? "正在重新检查仓库状态…" : githubError || "尚未检查仓库可见性。",
          cls: githubError ? "simple-one-sync-setup-error" : "simple-share-library-detail__muted" });
      }
      if (!site.repo) { /* The repository message above already explains the missing configuration. */ }
      else if (loadingLocal || visibility === undefined) { /* The repository check above covers this state. */ }
      else if (visibility === true) {
        const warning = github.createDiv({ cls: "simple-share-library-detail__notice", attr: { role: "status" } });
        setIcon(warning.createSpan({ cls: "simple-share-library-detail__notice-icon" }), "circle-alert");
        warning.createSpan({ text: "当前仓库为私有，GitHub Pages 不可用。" });
      }
      else if (pages) {
        detailLink(github, "分享网址", pages.url, pages.url);
        if (pages.status === "errored") github.createEl("p", { text: "最近一次构建失败，请检查 GitHub Pages 设置。", cls: "simple-one-sync-setup-error" });
      } else if (visibility === false) github.createEl("p", { text: pagesError === "GitHub Pages 尚未启用。" ? "尚未启用 GitHub Pages。" : pagesError || "尚未获取到 GitHub Pages 分享网址。", cls: "simple-share-library-detail__muted" });
      if (site.repo && visibility === false && !loadingLocal && !checking && !operating && !this.busy && !this.setupBusy && !githubError && !pages && pagesError === "GitHub Pages 尚未启用。") {
        const button = github.createEl("button", { text: "启用 GitHub Pages", attr: { type: "button" } });
        button.addEventListener("click", () => { void enablePages(); });
      }
      const edgeoneSection = body.createDiv({ cls: "simple-share-library-detail__section" });
      heading(edgeoneSection, "EdgeOne Makers");
      if (edgeoneLoading) edgeoneSection.createEl("p", { text: "正在读取项目关联记录…", cls: "simple-share-library-detail__muted" });
      else if (edgeoneError) edgeoneSection.createEl("p", { text: edgeoneError, cls: "simple-one-sync-setup-error" });
      else if (edgeone?.projectId && edgeone.projectName) {
        const projectUrl = `https://console.cloud.tencent.com/edgeone/pages/project/${encodeURIComponent(edgeone.projectId)}`;
        detailLink(edgeoneSection, "关联项目", edgeone.projectName, projectUrl);
        detailRow(edgeoneSection, "加速区域").setText(edgeone.area === "global" ? "全球（含中国大陆）" : edgeone.area === "mainland" ? "中国大陆" : edgeone.area === "overseas" ? "全球（不含中国大陆）" : "未记录");
        const website = edgeOneWebsite(edgeone.website);
        if (website) detailLink(edgeoneSection, "EdgeOne 分享网址", website, website);
        const domainValue = detailRow(edgeoneSection, "自定义分享网址");
        if (edgeoneDomains?.length) {
          const library = id === ensureLibraries(this.manifest).active ? this.manifest : ensureLibraries(this.manifest).entries[id];
          const savedDomains = library.edgeOneDomains?.projectId === edgeone.projectId ? library.edgeOneDomains : undefined;
          const selected = savedDomains?.selected;
          const domainList = domainValue.createDiv({ cls: "simple-share-library-detail__domain-list" });
          for (const item of edgeoneDomains) {
            const line = domainList.createDiv({ cls: "simple-share-library-detail__domain-choice" });
            const checkbox = line.createEl("input", { attr: { type: "checkbox", "aria-label": `启用 ${item.domain}` } });
            checkbox.checked = item.status === "online" && (selected === undefined || selected.includes(item.domain));
            checkbox.disabled = item.status !== "online" || !savedDomains || checking || operating || this.isPublishing;
            checkbox.addEventListener("change", () => { void (async () => {
              const enabled = checkbox.checked;
              try {
                await this.change(manifest => {
                  const entries = ensureLibraries(manifest);
                  const target = id === entries.active ? manifest : entries.entries[id];
                  const settings = target.edgeOneDomains;
                  if (!settings || settings.projectId !== edgeone?.projectId) throw new Error("项目域名记录已变化，请重新检查。");
                  const current = settings.selected ?? settings.domains.filter(domain => domain.status === "online").map(domain => domain.domain);
                  settings.selected = enabled ? [...new Set([...current, item.domain])] : current.filter(domain => domain !== item.domain);
                }, false);
              } catch (error) { checkbox.checked = !enabled; actionError = error instanceof Error ? error.message : String(error); render(); }
            })(); });
            const url = edgeOneWebsite(item.domain);
            if (item.status === "online") line.createEl("a", { text: `${url} ↗`, href: url, attr: { target: "_blank", rel: "noopener noreferrer" } });
            else {
              line.createSpan({ text: url });
              line.createSpan({ text: `（${item.status === "pending" ? "待生效" : item.status === "offline" ? "未上线" : "状态未确认"}）`, cls: "simple-share-library-detail__muted" });
            }
          }
        } else domainValue.createSpan({ text: edgeoneDomainsError || (checking && !edgeoneDomainsChecked ? "正在检查…" : edgeoneDomainsChecked ? "未绑定" : "尚未检查"), cls: "simple-share-library-detail__muted" });
        if (edgeoneDomainsError && edgeoneDomains?.length) edgeoneSection.createEl("p", { text: `自定义域名未能更新：${edgeoneDomainsError}`, cls: "simple-share-library-detail__muted" });
        if ((edgeone.area === "global" || edgeone.area === "mainland") && edgeoneDomainsChecked &&
          !edgeoneDomains?.some(item => item.status === "online")) {
          const warning = edgeoneSection.createDiv({ cls: "simple-share-library-detail__notice", attr: { role: "note" } });
          setIcon(warning.createSpan({ cls: "simple-share-library-detail__notice-icon", attr: { "aria-hidden": "true" } }), "circle-alert");
          renderMainlandPreviewNotice(warning.createDiv(), projectUrl);
        }
      } else edgeoneSection.createEl("p", { text: "尚未关联与此仓库及分支匹配的 EdgeOne 项目。" });
      const domainSection = body.createDiv({ cls: "simple-share-library-detail__section simple-share-library-detail__domains" });
      heading(domainSection, "自定义网站域名");
      const domains = (id === ensureLibraries(this.manifest).active ? this.manifest : ensureLibraries(this.manifest).entries[id]).customDomains ?? [];
      for (const domain of domains) {
        const item = domainSection.createDiv({ cls: "simple-share-library-detail__domain" });
        item.createSpan({ cls: "simple-share-library-detail__domain-name", text: domain.name });
        item.createEl("a", { text: `${domain.baseUrl} ↗`, href: domain.baseUrl, attr: { target: "_blank", rel: "noopener noreferrer" } });
        item.createEl("p", { cls: "simple-share-library-detail__muted", text: `预览：${shareDomainNoteUrl(domain.baseUrl, "abcdefghijkl")}` });
        const actions = item.createDiv({ cls: "simple-share-library-detail__domain-actions" });
        const edit = actions.createEl("button", { text: "编辑", attr: { type: "button" } });
        edit.disabled = this.isPublishing || this.setupBusy || operating;
        edit.addEventListener("click", () => { editingDomainId = domain.id; draftDomainName = domain.name; draftDomainUrl = domain.baseUrl; render(); });
        const removeDomain = actions.createEl("button", { text: "移除", attr: { type: "button" } });
        removeDomain.disabled = this.isPublishing || this.setupBusy || operating;
        removeDomain.addEventListener("click", () => { void (async () => {
          if (!await confirmAction(this.host.app, `移除分享网站「${domain.name}」？仅删除本机链接配置，不会更改网站或已发布内容。`)) return;
          await this.change(manifest => {
            const entries = ensureLibraries(manifest);
            const target = id === entries.active ? manifest : entries.entries[id];
            target.customDomains = (target.customDomains ?? []).filter(item => item.id !== domain.id);
          });
        })().catch(error => this.fail(error)); });
      }
      if (editingDomainId === null) {
        const add = domainSection.createEl("button", { text: "新增分享网站", attr: { type: "button" } });
        add.disabled = this.isPublishing || this.setupBusy || operating;
        add.addEventListener("click", () => { editingDomainId = "new"; draftDomainName = ""; draftDomainUrl = ""; render(); });
      } else {
        const form = domainSection.createDiv({ cls: "simple-share-library-detail__domain-form" });
        const nameField = form.createEl("label", { cls: "simple-share-library-detail__domain-field" });
        nameField.createSpan({ text: "分享名称" });
        const nameInput = nameField.createEl("input", { attr: { type: "text", placeholder: "例如 备用站点", maxlength: "50" } });
        nameInput.value = draftDomainName;
        const urlField = form.createEl("label", { cls: "simple-share-library-detail__domain-field" });
        urlField.createSpan({ text: "网站首页地址" });
        const exampleHomeUrl = "https://example.com/notes/";
        const urlInput = urlField.createEl("input", { attr: { type: "text", inputmode: "url", placeholder: exampleHomeUrl, spellcheck: "false" } });
        urlInput.value = draftDomainUrl;
        form.createEl("p", { cls: "simple-share-library-detail__domain-help", text: "填写分享网站的首页地址。分享笔记时，插件会根据笔记编号自动生成该网站的笔记链接。" });
        const preview = form.createEl("p", { cls: "simple-share-library-detail__muted" });
        const updatePreview = (): void => {
          draftDomainName = nameInput.value; draftDomainUrl = urlInput.value;
          try { preview.setText(`链接预览：${shareDomainNoteUrl(normalizeShareDomainUrl(draftDomainUrl), "abcdefghijkl")}`); preview.hidden = false; }
          catch { preview.setText(""); preview.hidden = true; }
        };
        nameInput.addEventListener("input", updatePreview); urlInput.addEventListener("input", updatePreview); updatePreview();
        const actions = form.createDiv({ cls: "simple-share-library-detail__domain-actions" });
        actions.createEl("button", { text: "取消", attr: { type: "button" } }).addEventListener("click", () => { editingDomainId = null; render(); });
        actions.createEl("button", { text: "保存", cls: "mod-cta", attr: { type: "button" } }).addEventListener("click", () => { void (async () => {
          const domainName = draftDomainName.trim();
          if (!domainName || /[\r\n：]/.test(domainName)) throw new Error("分享名称不能为空，也不能包含换行或中文冒号。");
          const baseUrl = normalizeShareDomainUrl(draftDomainUrl);
          const editing = editingDomainId;
          await this.change(manifest => {
            const entries = ensureLibraries(manifest);
            const target = id === entries.active ? manifest : entries.entries[id];
            const existing = target.customDomains ?? [];
            if (existing.some(item => item.baseUrl === baseUrl && item.id !== editing)) throw new Error("这个分享网站已经添加过了。");
            target.customDomains = editing === "new"
              ? [...existing, { id: crypto.randomUUID(), name: domainName, baseUrl }]
              : existing.map(item => item.id === editing ? { ...item, name: domainName, baseUrl } : item);
          });
          editingDomainId = null;
        })().catch(error => { actionError = error instanceof Error ? error.message : String(error); render(); }); });
      }
      if (actionError) body.createEl("p", { text: actionError, cls: "simple-one-sync-setup-error", attr: { role: "alert" } });
      controls.createEl("p", { text: "删除记录只移除当前笔记库中的分享配置；GitHub 仓库、已发布网站和原笔记保留。", cls: "simple-share-library-management-desc" });
      const footer = controls.createDiv({ cls: "simple-share-library-detail__footer" });
      footer.createSpan({ cls: "simple-share-library-detail__checked-at", text: checkedAt ? `上次检查：${new Date(checkedAt).toLocaleString()}` : "尚无检查记录" });
      const refresh = footer.createEl("button", { text: checking ? "检查中…" : "重新检查", attr: { type: "button" } });
      refresh.disabled = loadingLocal || checking || operating || !site.repo;
      refresh.addEventListener("click", () => { void inspect(); });
      const remove = footer.createEl("button", { text: "删除记录", cls: "mod-warning", attr: { type: "button" } });
      remove.disabled = loadingLocal || checking || operating || this.isPublishing || this.setupBusy || this.edgeone.busy || this.checkingDeployment;
      remove.addEventListener("click", () => { void this.removeShareLibrary(id).catch(error => this.fail(error)); });
    };
    const suffix = id === "legacy" ? "" : `.${id}`;
    const cachePath = this.path(`share-local.json.details${suffix}`);
    const readEdgeone = async (): Promise<void> => {
      edgeoneLoading = true; edgeoneError = ""; render();
      try {
        const path = this.path(`share-local.json.edgeone${suffix}`);
        edgeone = undefined;
        if (await this.host.app.vault.adapter.exists(path)) {
          const value = JSON.parse(await this.host.app.vault.adapter.read(path)) as {
            repo?: string; branch?: string; projectId?: string; projectName?: string; website?: string; area?: string; completed?: boolean;
          };
          if (value?.repo === `${site.owner}/${site.repo}`.toLowerCase() && value.branch === site.branch) edgeone = value;
        }
      } catch { edgeoneError = "本机 EdgeOne 关联记录无法读取。"; }
      if (domainsProjectId !== edgeone?.projectId) {
        edgeoneDomains = undefined; edgeoneDomainsChecked = false; edgeoneDomainsError = "";
        domainsProjectId = edgeone?.projectId;
      }
      const library = id === ensureLibraries(this.manifest).active ? this.manifest : ensureLibraries(this.manifest).entries[id];
      if (edgeone?.projectId && library.edgeOneDomains?.projectId === edgeone.projectId && !edgeoneDomainsChecked) {
        edgeoneDomains = library.edgeOneDomains.domains;
        edgeoneDomainsChecked = true;
      }
      edgeoneLoading = false; render();
    };
    const inspect = async (): Promise<void> => {
      if (checking) return;
      checking = true; githubError = ""; edgeoneDomainsError = ""; render();
      await readEdgeone();
      if (edgeone?.projectId) {
        const projectId = edgeone.projectId;
        try {
          edgeoneDomains = await this.edgeone.customDomainsForProject(projectId, site);
          await this.change(manifest => {
            const entries = ensureLibraries(manifest);
            const target = id === entries.active ? manifest : entries.entries[id];
            const existing = target.edgeOneDomains;
            target.edgeOneDomains = { projectId, domains: edgeoneDomains!,
              selected: existing && existing.projectId === projectId ? existing.selected : undefined };
          }, false);
          edgeoneDomainsChecked = true;
        } catch (error) { edgeoneDomainsError = error instanceof Error ? error.message : String(error); }
        render();
      }
      if (site.repo) {
        try {
          const value = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}`)) as { private?: unknown };
          if (typeof value.private !== "boolean") throw new Error("GitHub 未返回仓库可见性。");
          let nextPages: typeof pages;
          let nextPagesError = "";
          if (!value.private) {
            try {
              const response = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}/pages`)) as { html_url?: unknown; status?: unknown };
              nextPages = { url: typeof response.html_url === "string" && /^https:\/\//i.test(response.html_url) ? response.html_url : siteUrl(site),
                status: typeof response.status === "string" ? response.status : "" };
            } catch (error) { nextPagesError = /(?:^|\D)404(?:\D|$)/.test(String(error)) ? "GitHub Pages 尚未启用。" : "无法确认 GitHub Pages 状态。"; }
          }
          visibility = value.private; pages = nextPages; pagesError = nextPagesError; checkedAt = Date.now();
          try {
            await this.host.app.vault.adapter.write(cachePath, JSON.stringify({ version: 1, repo: name.toLowerCase(), branch: site.branch,
              visibility, pages, pagesError, checkedAt, edgeoneProjectId: edgeone?.projectId,
              edgeoneDomains: edgeoneDomainsChecked ? edgeoneDomains : undefined }));
          } catch { actionError = "已完成检查，但无法保存本机检查记录。"; }
        } catch (error) { githubError = `无法读取 GitHub 仓库状态：${error instanceof Error ? error.message : String(error)}`; }
      }
      checking = false; render();
    };
    const loadSaved = async (): Promise<void> => {
      await readEdgeone();
      let cached = false;
      try {
        const adapter = this.host.app.vault.adapter;
        if (await adapter.exists(cachePath)) {
          const value = JSON.parse(await adapter.read(cachePath)) as {
            version?: number; repo?: string; branch?: string; visibility?: unknown;
            pages?: { url?: unknown; status?: unknown }; pagesError?: unknown; checkedAt?: unknown;
            edgeoneProjectId?: unknown; edgeoneDomains?: unknown;
          };
          if (value.version === 1 && value.repo === name.toLowerCase() && value.branch === site.branch && typeof value.visibility === "boolean" && typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt)) {
            visibility = value.visibility;
            pages = value.pages && typeof value.pages.url === "string" && /^https:\/\//i.test(value.pages.url)
              ? { url: value.pages.url, status: typeof value.pages.status === "string" ? value.pages.status : "" } : undefined;
            pagesError = typeof value.pagesError === "string" ? value.pagesError : "";
            checkedAt = value.checkedAt;
            cached = true;
            if (edgeone?.projectId && value.edgeoneProjectId === edgeone.projectId && Array.isArray(value.edgeoneDomains) &&
              value.edgeoneDomains.every((item: unknown) => {
                if (!item || typeof item !== "object") return false;
                const domain = item as Record<string, unknown>;
                return typeof domain.domain === "string" && typeof domain.status === "string";
              })) {
              edgeoneDomains = value.edgeoneDomains as EdgeOneCustomDomain[];
              edgeoneDomainsChecked = true;
              domainsProjectId = edgeone.projectId;
            }
          }
        }
      } catch { /* An unreadable cache is replaced by a fresh check. */ }
      loadingLocal = false; render();
      const library = id === ensureLibraries(this.manifest).active ? this.manifest : ensureLibraries(this.manifest).entries[id];
      if ((!cached || (edgeone?.projectId && (!edgeoneDomainsChecked || library.edgeOneDomains?.projectId !== edgeone.projectId))) && site.repo) await inspect();
    };
    const changeVisibility = async (makePrivate: boolean): Promise<void> => {
      if (operating || checking || this.busy || this.setupBusy || !site.repo || visibility === undefined || visibility === makePrivate) { render(); return; }
      const prompt = makePrivate
        ? `将分享仓库「${name}」设为私有？GitHub Pages 网站将无法通过本引导使用，EdgeOne 项目也可能需要补充私有仓库授权。`
        : `将分享仓库「${name}」设为公开？任何人都可以查看仓库内容。`;
      if (!await confirmAction(this.host.app, prompt)) { render(); return; }
      operating = true; actionError = ""; render();
      try {
        const current = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}`)) as { private?: unknown };
        if (typeof current.private !== "boolean") throw new Error("GitHub 未返回仓库可见性，未更改仓库属性。");
        if (current.private !== makePrivate) {
          await this.github(`repos/${site.owner}/${site.repo}`, "PATCH", { private: makePrivate });
          const confirmed = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}`)) as { private?: unknown };
          if (confirmed.private !== makePrivate) throw new Error("GitHub 尚未确认仓库可见性已更新，请到 GitHub 核实。");
        }
        await inspect();
      } catch (error) {
        actionError = `更改仓库可见性失败：${error instanceof Error ? error.message : String(error)}`;
        await inspect();
      } finally { operating = false; render(); }
    };
    const enablePages = async (): Promise<void> => {
      if (operating || checking || this.busy || this.setupBusy || !site.repo) return;
      operating = true; actionError = ""; render();
      let madePublic = false;
      let publicChangeRequested = false;
      try {
        const current = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}`)) as { private?: unknown };
        if (typeof current.private !== "boolean") throw new Error("GitHub 未返回仓库可见性，未启用 Pages。");
        if (current.private) {
          if (!await confirmAction(this.host.app, `启用 GitHub Pages 将分享仓库「${name}」设为公开，任何人都可以查看仓库内容。是否继续？`)) return;
          await this.github(`repos/${site.owner}/${site.repo}`, "PATCH", { private: false });
          publicChangeRequested = true;
          const confirmed = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}`)) as { private?: unknown };
          if (confirmed.private !== false) throw new Error("仓库公开状态尚未确认，请在 GitHub 检查后重试。");
          madePublic = true;
        }
        await (await this.repository(site)).configurePages();
        await inspect();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        actionError = madePublic ? `仓库已设为公开，但 GitHub Pages 未能确认启用：${reason}`
          : publicChangeRequested ? "仓库公开请求已发出，但结果尚未确认；请先在 GitHub 核实。"
            : `启用 GitHub Pages 失败：${reason}`;
        await inspect();
      } finally { operating = false; render(); }
    };
    render();
    void loadSaved();
  }
  private useTakenRepository(): boolean {
    const taken = this.takenRepository;
    if (!taken) return false;
    this.repoMode = "existing";
    this.draftRepo = `https://github.com/${taken.owner}/${taken.name}`;
    this.repositoryFeedback = "检测到同名仓库，已切换到「使用已有分享仓库」并填入地址。请核验后连接。";
    this.takenRepository = undefined;
    this.error = "";
    return true;
  }
  renderLibrarySelector(parent: HTMLElement, settings = false, guide = false): void {
    const row = new Setting(parent).setName("当前分享库").setClass("simple-share-library-selector");
    if (settings) row.setDesc(`此处切换查看库；右键笔记分享按钮选择发布目标（已选 ${selectedLibraryIds(this.manifest).length} 个）。`);
    const hasLibraries = Object.values(ensureLibraries(this.manifest).entries).some(value => !!value.site.repo) || !!this.manifest.site.repo;
    const choices = settings ? Object.fromEntries(Object.entries(ensureLibraries(this.manifest).entries).map(([id, stored]) => {
      const site = id === this.libraryId ? this.manifest.site : stored.site;
      return [id, site.repo ? `${site.owner}/${site.repo}` : `未完成接入 · ${id.slice(0, 8)}`];
    })) : this.libraries;
    row.addDropdown(dropdown => {
      if (guide) dropdown.addOption("", "新仓库");
      if (!guide || hasLibraries) dropdown.addOptions(choices);
      dropdown.setValue(guide && (this.guideNewLibrarySelected || !this.manifest.site.repo) ? "" : this.libraryId)
        .setDisabled(this.isPublishing || this.setupBusy || this.edgeone.busy)
        .onChange(id => {
          if (guide && !id) { this.guideNewLibrarySelected = true; this.renderViews(); }
          else if (id) void this.switchLibrary(id).catch(error => this.fail(error));
        });
    });
    if (settings) {
      row.addButton(button => button.setButtonText("新建分享库").setDisabled(this.isPublishing || this.setupBusy || this.edgeone.busy)
        .onClick(() => { void this.newLibrary().catch(error => this.fail(error)); }));
    }
  }
  private localPath(): string { return this.path("share-local.json" + (this.libraryId === "legacy" ? "" : "." + this.libraryId)); }
  private async validateHosting(): Promise<void> {
    await (await this.repository()).verify();
    if (this.manifest.site.hosting === "edgeone") {
      if (!this.edgeone.linked) throw new Error("请先关联当前仓库的 EdgeOne Makers 项目。");
    } else {
      const value = JSON.parse(await this.github(`repos/${this.manifest.site.owner}/${this.manifest.site.repo}`)) as { private: boolean };
      if (value.private) throw new Error("跳过 EdgeOne Makers 时，GitHub 仓库必须公开。请返回接入 EdgeOne Makers，或在 GitHub 修改仓库属性后重试。");
    }
  }
  private async ensureGuideGithubPagesPublic(): Promise<void> {
    const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
    const current = JSON.parse(await this.github(`repos/${key}`)) as { private?: unknown };
    if (typeof current.private !== "boolean") throw new Error("GitHub 未返回分享仓库的公开或私有状态，尚未发布。");
    if (!current.private) {
      this.guideVisibility = { key, private: false };
      return;
    }
    if (this.guideVisibility?.key !== key || !this.guideVisibility.private) {
      this.guideVisibility = { key, private: true };
      this.renderViews();
      throw new Error("分享仓库刚变为私有。请确认下方将公开的仓库名称，再点击公开并初始化。");
    }
    this.status = `正在将分享仓库 ${key} 设为公开…`;
    this.renderViews();
    try {
      await this.github(`repos/${key}`, "PATCH", { private: false });
    } catch {
      throw new Error(`未能自动公开分享仓库 ${key}，请检查 GitHub 管理权限或组织限制；仓库状态尚未确认，未继续发布。`);
    }
    let confirmed: { private?: unknown };
    try {
      confirmed = JSON.parse(await this.github(`repos/${key}`)) as { private?: unknown };
    } catch {
      throw new Error(`GitHub 已收到公开分享仓库 ${key} 的请求，但未能确认最终状态。仓库可能已公开，请先到 GitHub 查看，不要重复操作。`);
    }
    if (confirmed.private !== false) throw new Error(`GitHub 尚未确认分享仓库 ${key} 已公开，未继续发布。请检查仓库设置。`);
    this.guideVisibility = { key, private: false };
    this.guideVisibilityChangedKey = key;
    this.status = `已将分享仓库 ${key} 设为公开，正在继续发布…`;
    this.renderViews();
  }
  private inspectGuideRepositoryVisibility(): void {
    const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
    const request = ++this.guideVisibilityRequest;
    this.guideVisibilityAttemptedKey = key;
    this.guideVisibility = undefined;
    this.guideVisibilityError = "";
    this.guideVisibilityChecking = true;
    void (async () => {
      try {
        const value = JSON.parse(await this.github(`repos/${key}`)) as { private?: unknown };
        if (typeof value.private !== "boolean") throw new Error("GitHub 未返回仓库可见性。");
        if (request === this.guideVisibilityRequest) this.guideVisibility = { key, private: value.private };
      } catch {
        if (request === this.guideVisibilityRequest) this.guideVisibilityError = "无法读取当前分享仓库的公开或私有状态，请检查 GitHub 授权后重试。";
      } finally {
        if (request === this.guideVisibilityRequest) {
          this.guideVisibilityChecking = false;
          this.renderViews();
        }
      }
    })();
  }
  private inspectGuidePages(): void {
    const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
    const request = ++this.guidePagesRequest;
    this.guidePagesAttemptedKey = key;
    this.guidePages = undefined;
    this.guidePagesError = "";
    this.guidePagesChecking = true;
    void (async () => {
      try {
        const value = JSON.parse(await this.github(`repos/${key}/pages`)) as { html_url?: unknown; status?: unknown };
        if (request === this.guidePagesRequest) this.guidePages = {
          key, url: typeof value.html_url === "string" && /^https:\/\//i.test(value.html_url) ? value.html_url : siteUrl(this.manifest.site),
          status: typeof value.status === "string" ? value.status : ""
        };
      } catch (error) {
        if (request === this.guidePagesRequest) this.guidePagesError = /(?:^|\D)404(?:\D|$)/.test(String(error)) ? "GitHub Pages 尚未启用。" : "暂时无法确认 GitHub Pages 的启用状态。";
      } finally {
        if (request === this.guidePagesRequest) {
          this.guidePagesChecking = false;
          this.renderViews();
        }
      }
    })();
  }
  private edgeOneRepositoryVisibility(): EdgeOneRepositoryVisibility {
    const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
    const current = this.guideVisibility?.key === key ? this.guideVisibility : undefined;
    return {
      private: current?.private ?? null,
      checking: this.guideVisibilityChecking,
      error: this.guideVisibilityError,
      refresh: () => this.inspectGuideRepositoryVisibility()
    };
  }
  private async scanIndex(): Promise<Map<string, TFile[]>> {
    const index = new Map<string, TFile[]>();
    if (!Object.keys(this.manifest.notes).length) return index;
    for (const file of this.host.app.vault.getMarkdownFiles()) {
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
  async share(file: TFile, libraryId?: string): Promise<void> {
    if (this.sharing || this.busy) throw new Error("发布正在进行，请稍候。");
    const targets = libraryId ? [libraryId] : selectedLibraryIds(this.manifest);
    if (!targets.length) throw new Error("请先在笔记分享设置中完成分享库接入，并在分享按钮的右键菜单中勾选目标库。");
    const originalLibraryId = this.libraryId;
    this.sharing = true; this.publishingTitle = file.basename; this.status = "准备分享…"; this.error = ""; this.refreshActions();
    const successes: { name: string; content: string }[] = [];
    const failures: string[] = [];
    let shareId: string | undefined;
    let resultStatus = "", resultError = "";
    try {
      await this.open(); this.renderViews();
      for (const id of targets) {
        const name = this.libraries[id] ?? id;
        try {
          if (id !== this.libraryId) await this.switchLibrary(id, true);
          await this.shareNow(file, shareId, value => { shareId = value; });
          successes.push({ name, content: await this.shareCopyText(shareId!, file.basename) });
        } catch (error) { failures.push(`${name}：${error instanceof Error ? error.message : String(error)}`); }
      }
      const summary = `已推送到 ${successes.length}/${targets.length} 个分享库${successes.length ? `：${successes.map(item => item.name).join("、")}` : ""}。`;
      resultStatus = summary;
      const copyable = successes.filter(item => item.content);
      if (copyable.length) {
        try {
          const content = copyable.map(item => copyable.length > 1 ? `${item.name}\n${item.content}` : item.content).join("\n\n");
          await navigator.clipboard.writeText(content);
          resultStatus = `${summary}已按设置复制分享内容；网站展示需等待部署完成。`;
        } catch (error) { resultStatus = `${summary}复制失败：${error instanceof Error ? error.message : String(error)}`; }
      } else if (successes.length) {
        resultStatus = `${summary}所选内容暂无可用的标题或网站链接；未复制。`;
      }
      if (failures.length) resultError = `以下分享库未推送成功：${failures.join("；")}`;
      new Notice([resultStatus, resultError].filter(Boolean).join(" ") || summary, 8000);
    } finally {
      try { if (originalLibraryId !== this.libraryId) await this.switchLibrary(originalLibraryId, true); }
      finally { this.sharing = false; this.status = resultStatus; this.error = resultError; this.renderViews(); }
    }
  }
  private async shareNow(file: TFile, existingId?: string, onId?: (id: string) => void): Promise<string> {
    await this.reload();
    if (!this.manifest.enabled) throw new Error("请先在笔记分享设置中启用分享。");
    if (!this.manifest.site.repo) throw new Error("请先完成笔记分享引导，连接分享仓库。");
    if (file.path.startsWith(SHARE_FOLDER + "/") || file.path.startsWith(this.host.app.vault.configDir + "/")) throw new Error("请选择主库中的正文笔记。");
    if (this.busy) throw new Error("发布正在进行。");
    let id: unknown = existingId ?? this.host.app.metadataCache.getFileCache(file)?.frontmatter?.share_id;
    const index = this.index();
    if (id !== undefined && (typeof id !== "string" || !ID_PATTERN.test(id))) throw new Error("现有 share_id 格式不正确，请先修复，不会覆盖。");
    if (!id) {
      if (Object.values(this.manifest.notes).some(entry => entry.sourcePath === file.path)) throw new Error("这篇笔记的分享 ID 已丢失，请在侧栏恢复原 ID。");
      id = newShareId(new Set([...index.keys(), ...Object.keys(this.manifest.notes)]));
      await this.host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => { frontmatter.share_id = id; });
    }
    const key = id as string;
    onId?.(key);
    if ((index.get(key)?.length || 0) > 1) throw new Error("该 ID 对应多篇笔记，请在分享侧栏解决重复。");
    await this.change(manifest => {
      const old = manifest.notes[key];
      const category = old?.category ?? (manifest.defaultPath === "root" ? "" : file.parent?.path ?? "");
      manifest.notes[key] = { ...old, enabled: true, sourcePath: file.path, category, revision: (old?.revision || 0) + 1 };
      if (!old) manifest.notes[key].directoryCode = this.directoryCode(manifest, normalizeShareDirectory(category));
      delete manifest.notes[key].deleted;
    }, false);
    await this.publish(false, key);
    return key;
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
    const adapter = this.host.app.vault.adapter, path = this.localPath();
    if (!await adapter.exists(path)) return { version: 1 };
    const value = JSON.parse(await adapter.read(path)) as LocalState;
    if (value.version !== 1) throw new Error("本机发布记录版本不正确。");
    // Ignore obsolete clone/cache jobs; every retry compares the current remote tree.
    return { version: 1, site: value.site, commit: value.commit, pendingCommit: value.pendingCommit,
      ...(value.published ? { published: parsePublishState(JSON.stringify(value.published)) } : {}) };
  }
  private saveLocal(value: LocalState): Promise<void> { return this.host.app.vault.adapter.write(this.localPath(), JSON.stringify(value, null, 2)); }
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
  async publish(_initialize = false, onlyId?: string | readonly string[], forceFreshEdgeOneDeployment = false,
    guideProgressOnSuccess = 7): Promise<void> {
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
        if (this.manifest.site.hosting === "edgeone") {
          if (_initialize) await this.edgeone.initializeWebsite(forceFreshEdgeOneDeployment && Object.keys(job.expected).length === 0); else await this.edgeone.checkDeployment();
          this.status = this.edgeone.message;
          if (_initialize && !this.edgeone.completed) throw new Error(this.edgeone.error || "EdgeOne Makers 部署尚未完成，请稍后重试。");
        } else { await this.validateHosting(); await repository.configurePages(); this.status = await repository.deployment(commit); }
        this.githubDeploymentStatus = this.status; this.githubDeploymentError = "";
        this.manifest.site.initialized = true; this.manifest.site.guideProgress = guideProgressOnSuccess;
        await adapter.write(this.path("share-manifest.json"), serializeManifest(this.manifest));
      } catch (error) {
        this.status = "仓库内容已确认；网站部署需要检查"; this.error = error instanceof Error ? error.message : String(error);
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
    const leaf = existing || this.host.app.workspace.getLeavesOfType("simple-one-sync-view")[0] || this.host.app.workspace.getRightLeaf(false);
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
    if (!Object.values({ ...this.copyContent, [key]: value }).some(Boolean)) throw new Error("请至少保留一项分享内容。");
    await this.change(manifest => { manifest.copyContent = { ...DEFAULT_SHARE_COPY_CONTENT, ...manifest.copyContent, [key]: value }; });
  }
  private selectedEdgeOneCustomLinks(noteId: string): Array<{ name: string; url: string }> {
    const settings = this.manifest.edgeOneDomains;
    if (!this.edgeone.linked || !settings || settings.projectId !== this.edgeone.state.projectId) return [];
    return settings.domains.filter(item => item.status === "online" &&
      (settings.selected === undefined || settings.selected.includes(item.domain))).map(item => ({
      name: `EdgeOne 自定义域名链接（${item.domain}）`,
      url: shareDomainNoteUrl(`${edgeOneWebsite(item.domain)}/`, noteId),
    }));
  }
  private async shareCopyText(id: string, title: string): Promise<string> {
    const site = this.manifest.site;
    let github = "";
    if (this.copyContent.github) try {
      const repository = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}`)) as { private?: unknown };
      if (repository.private === false) {
        const pages = JSON.parse(await this.github(`repos/${site.owner}/${site.repo}/pages`)) as { html_url?: unknown; status?: unknown };
        if (pages.status === "built") github = typeof pages.html_url === "string" && /^https:\/\//i.test(pages.html_url) ? pages.html_url : siteUrl(site);
      }
    } catch { /* A link without confirmed visibility and Pages status must not be shared. */ }
    const pageOne = this.edgeone.state.area === "overseas" ? this.edgeone.website : "";
    const domains = [...(this.copyContent.pageOne ? this.selectedEdgeOneCustomLinks(id) : []),
      ...(this.manifest.customDomains ?? []).map(domain => ({ name: domain.name, url: shareDomainNoteUrl(domain.baseUrl, id) }))];
    return formatShareContent(title, github ? `${github}#/notes/${id}` : "", pageOne ? `${pageOne.replace(/\/$/, "")}#/notes/${id}` : "", this.copyContent, domains);
  }
  async copySharedNote(id: string, fallback = ""): Promise<void> {
    const note = this.published.notes[id];
    if (!note) throw new Error("这篇笔记尚未发布，请先分享笔记。");
    const content = await this.shareCopyText(id, note.title || fallback);
    if (!content) throw new Error("所选内容当前没有可复制的标题或网站链接。");
    await navigator.clipboard.writeText(content);
  }
  addCopyContentMenu(menu: Menu): void {
    for (const [key, title] of [["title", "笔记标题"], ["github", "GitHub 链接"], ["pageOne", "EdgeOne Makers 链接"]] as const) {
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
  private async readTemplateSelection(): Promise<string> {
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
    this.templateFile = filename;
    await this.refreshTemplateFiles();
    return filename;
  }
  private async readTemplate(): Promise<string> {
    const filename = await this.readTemplateSelection();
    const source = filename === DEFAULT_TEMPLATE_FILE ? await this.readDefaultTemplate() : await this.host.app.vault.adapter.read(this.path(filename));
    if (filename !== DEFAULT_TEMPLATE_FILE) validateShareTemplate(source);
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
    const managingLibrary = !guide && !this.edgeOneGuideOpen ? this.managingLibraryId : null;
    const title = !guide && this.edgeOneGuideOpen ? "腾讯 EdgeOne 接入引导" : managingLibrary ? "分享库管理" : guide ? "笔记分享引导" : "笔记分享设置";
    onTitleChanged?.(title);
    if (showTitle) {
      const header = page.createDiv({ cls: "simple-page-header" });
      if (!guide && (this.edgeOneGuideOpen || managingLibrary)) {
        const back = header.createEl("button", { cls: "simple-back-button", attr: { type: "button", "aria-label": "返回笔记分享设置", title: "返回笔记分享设置" } });
        setIcon(back, "arrow-left"); back.addEventListener("click", () => { if (managingLibrary) this.backFromShareLibraryManagement(); else this.backFromEdgeOneGuide(); });
      }
      new Setting(header).setName(title).setHeading().setClass("simple-page-title");
    }
    if (managingLibrary) {
      this.renderShareLibraryDetails(page, managingLibrary);
      return;
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
      this.renderLibrarySelector(dependent, true);
      new Setting(dependent).setName("笔记分享后路径（默认路径）").setDesc("设置新分享笔记在分享专用库中的默认目录，已有分享的目录保留。")
        .addDropdown(dropdown => dropdown.addOptions({ root: "在分享仓库的根目录", source: "跟随原笔记库路径" }).setValue(this.manifest.defaultPath || "source").setDisabled(!this.manifest.enabled || this.isPublishing).onChange(value => {
          if (value === "root" || value === "source") void this.change(manifest => { manifest.defaultPath = value; }).catch(error => this.fail(error));
        }));
      new Setting(dependent).setName("分享预览").setClass("simple-share-preview-heading");
      const previewArea = dependent.createDiv({ cls: "simple-share-preview-area" });
      const copyOptions = previewArea.createDiv({ cls: "simple-share-copy-options", attr: { role: "group", "aria-label": "分享预览内容" } });
      const preview = previewArea.createDiv({ cls: "simple-share-preview-example", attr: { role: "status", "aria-live": "polite" } });
      const checked: ShareCopyContent = { ...this.copyContent };
      const renderPreview = () => {
        preview.empty();
        if (!checked.title && !checked.github && !checked.pageOne) { preview.createSpan({ text: "请至少勾选一项内容。" }); return; }
        const custom = [...(checked.pageOne ? this.selectedEdgeOneCustomLinks("示例") : []),
          ...(this.manifest.customDomains ?? []).map(domain => ({ name: domain.name, url: shareDomainNoteUrl(domain.baseUrl, "abcdefghijkl") }))];
        preview.setText(formatShareContent("示例笔记", "https://example.github.io/notes/#/notes/示例", "https://example.edgeone.cool/#/notes/示例", checked, custom));
      };
      for (const [key, title] of [["title", "笔记标题"], ["github", "GitHub 链接"], ["pageOne", "EdgeOne Makers 链接"]] as const) {
        const label = copyOptions.createEl("label", { cls: "simple-share-copy-option" });
        const checkbox = label.createEl("input", { attr: { type: "checkbox", "aria-label": title } });
        label.createSpan({ text: title });
        checkbox.checked = this.copyContent[key];
        checkbox.disabled = !this.manifest.enabled || this.isPublishing;
        checkbox.addEventListener("change", () => {
          checked[key] = checkbox.checked;
          if (!Object.values(checked).some(Boolean)) { checked[key] = true; checkbox.checked = true; new Notice("请至少保留一项分享内容。"); return; }
          renderPreview();
          void this.updateCopyContent(key, checkbox.checked).catch(error => this.fail(error));
        });
      }
      renderPreview();
      const management = settingsSection(page, "分享库管理");
      management.addClass("simple-share-settings-card");
      const libraries = ensureLibraries(this.manifest);
      for (const [id, stored] of Object.entries(libraries.entries)) {
        const library = id === libraries.active ? this.manifest : stored;
        const name = library.site.repo ? `${library.site.owner}/${library.site.repo}` : `未完成接入的分享库 · ${id.slice(0, 8)}`;
        const labels = [id === libraries.active ? "当前查看" : "", selectedLibraryIds(this.manifest).includes(id) ? "分享目标" : ""].filter(Boolean).join(" · ");
        new Setting(management).setName(name).setDesc(labels || "已保存的分享库")
          .addButton(button => button.setButtonText("管理").setDisabled(this.isPublishing || this.setupBusy || this.edgeone.busy)
            .onClick(() => { try { this.openShareLibraryDetails(id); } catch (error) { this.fail(error); } }));
      }
      const appearance = settingsSection(page, "界面与分享模板");
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
        .setClass("simple-wrapping-setting")
        .setClass("simple-share-template-setting")
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
    const steps = [{ id: 1, label: "安装与授权" }, { id: 2, label: "选择仓库" }, { id: 3, label: "接入 EdgeOne Makers" },
      { id: 4, label: this.manifest.site.hosting === "edgeone" ? "检查发布结果" : "发布并检查部署" }];
    const storedProgress = this.manifest.site.guideProgress ?? (this.manifest.site.initialized ? 7 : this.manifest.site.repo ? 3 : 1);
    const progress = storedProgress === 5 ? 4 : storedProgress;
    this.guideAvailableStep = Math.min(4, progress);
    const completed = !!this.manifest.site.repo && this.manifest.site.initialized === true && progress === 7;
    const edgeOneResultReady = this.guideStep === 4 && this.manifest.site.hosting === "edgeone" && this.edgeone.completed;
    const hasLibraries = Object.values(ensureLibraries(this.manifest).entries).some(value => !!value.site.repo) || !!this.manifest.site.repo;
    const rechecking = !!this.manifest.site.initialized && !completed;
    const error = this.error || this.edgeone.error;
    const statusTitle = this.guideNewLibrarySelected ? "准备新建分享仓库" : error ? "当前库验证失败" : completed ? "当前库已验证成功" : edgeOneResultReady ? "网站已部署，待确认结果" : !hasLibraries ? "尚未添加分享库" : rechecking ? "当前库需要重新验证" : "当前库尚未完成配置";
    const description = this.guideNewLibrarySelected ? "点击「新建仓库」开始引导。" : error ? `${error} 请在当前步骤重试。` : completed ? "当前分享库已完成配置。" : edgeOneResultReady ? "请查看下方发布结果。" : !hasLibraries ? "请按下方引导操作，选择新建分享仓库或连接已有仓库。" : "请继续下方引导步骤。";
    const status = page.createDiv({ cls: `simple-one-sync-setup-status is-${this.guideNewLibrarySelected ? "disconnected" : error ? "error" : completed ? "success" : "disconnected"}`, attr: { role: "status" } });
    setIcon(status.createSpan({ cls: "simple-one-sync-setup-status__icon" }), this.guideNewLibrarySelected ? "plus" : error ? "triangle-alert" : completed ? "check" : "unplug");
    const copy = status.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    copy.createEl("strong", { text: statusTitle });
    copy.createEl("p", { text: description });
    this.renderLibrarySelector(copy, false, true);
    const controls = copy.querySelector<HTMLElement>(".simple-share-library-selector .setting-item-control")!;
    controls.addClass("simple-share-library-guide-controls");
    const isNewLibrary = this.guideNewLibrarySelected || !this.manifest.site.repo;
    const guideAction = controls.createEl("button", { text: isNewLibrary ? "新建仓库" : "重新运行此库引导", attr: { type: "button" } });
    guideAction.disabled = this.setupBusy || this.isPublishing || this.edgeone.busy;
    guideAction.addEventListener("click", () => { void (async () => {
      if (guideAction.disabled) return;
      if (isNewLibrary) { await this.newLibrary(); return; }
      await this.edgeone.resetGuide();
      await this.change(manifest => { manifest.site.guideProgress = 1; }, false);
      this.authController?.abort(); this.authorized = false; this.token = "";
      this.hostingMode = null;
      this.edgeOneGuideAttemptFailed = false; this.edgeOneDeploymentFailed = false;
      this.makeExistingRepositoryPrivate = false;
      this.guideStep = 1; this.guideAvailableStep = 1; this.error = ""; this.status = "";
      this.renderViews();
    })().catch(error => this.fail(error)); });
    if (this.guideNewLibrarySelected) return;
    const nav = page.createDiv({ cls: "simple-one-sync-setup-nav simple-share-setup-nav" });
    steps.forEach(({ id: step, label }, index) => {
      const button = nav.createEl("button", {
        cls: `simple-one-sync-setup-nav__step${step === this.guideStep ? " is-active" : ""}${step < progress ? " is-done" : ""}`,
        attr: { type: "button", "aria-current": step === this.guideStep ? "step" : "false" }
      });
      button.createSpan({ text: String(index + 1), cls: "simple-one-sync-setup-nav__marker" });
      button.createSpan({ text: label, cls: "simple-one-sync-setup-nav__label" });
      button.disabled = step > this.guideAvailableStep || this.setupBusy || this.busy || this.edgeone.busy;
      button.addEventListener("click", () => {
        if (step > this.guideAvailableStep || this.setupBusy || this.busy || this.edgeone.busy) return;
        if (step === 3 && this.guideStep !== 3) {
          this.hostingMode = null; this.edgeone.authMode = null; this.guideVisibilityAttemptedKey = "";
          this.edgeOneGuideAttemptFailed = false; this.edgeOneDeploymentFailed = false;
        }
        if (step === 4) { this.guideVisibilityAttemptedKey = ""; this.guidePagesAttemptedKey = ""; }
        this.guideStep = step; this.renderViews();
      });
    });
    const container = page.createDiv({ cls: "simple-one-sync-card simple-one-sync-setup-body simple-share-guide-body" });
    if (this.guideStep !== 2 && !(this.guideStep === 3 && this.hostingMode === "edgeone") &&
      !(this.guideStep === 4 && this.manifest.site.hosting === "edgeone") && (this.error || this.status))
      container.createEl("p", { text: this.error || this.status, cls: this.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback", attr: { role: "status", "aria-live": "polite" } });
    const run = (work: () => Promise<void>): void => {
      if (this.setupBusy || this.busy || this.edgeone.busy) return;
      this.setupBusy = true; this.error = ""; this.renderViews();
      void work().catch(error => this.fail(error)).finally(() => { this.setupBusy = false; this.token = ""; this.renderViews(); });
    };
    const action = (label: string, work: () => Promise<void>, parent = container, disabled = false) => {
      const row = new Setting(parent).setClass("simple-share-guide-action");
      row.addButton(button => button.setButtonText(label).setCta().setDisabled(disabled || this.setupBusy || this.busy || this.edgeone.busy).onClick(() => run(work))); return row;
    };
    if (this.guideStep === 1) {
      container.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-platform-step");
      const content = container.createDiv({ cls: "simple-one-sync-setup-platform-content simple-share-guide-auth-sections", attr: { role: "group", "aria-label": "GitHub 分享接入步骤" } });
      const tools = content.createDiv({ cls: "simple-one-sync-setup-detail" });
      new Setting(tools).setName("安装工具").setHeading();
      tools.createEl("p", { text: "GitHub 用于存放分享文件。电脑端优先使用 GitHub CLI；手机端或未安装 CLI 时使用 GitHub token。" });
      const link = (parent: HTMLElement, text: string, href: string): void => { parent.createEl("a", { text, href, attr: { target: "_blank", rel: "noopener noreferrer" } }); };
      const links = tools.createDiv({ cls: "simple-one-sync-setup-links" });
      link(links, "下载 GitHub CLI ↗", "https://cli.github.com/");
      link(links, "注册 GitHub ↗", "https://github.com/signup");
      const auth = content.createDiv({ cls: "simple-one-sync-setup-detail simple-one-sync-setup-auth" });
      new Setting(auth).setName("选择 GitHub 授权方式").setHeading();
      auth.createEl("p", { text: "授权 Simple One 访问 GitHub，以创建或连接分享仓库并写入分享文件。" });
      const verify = async () => {
        const account = JSON.parse(await this.github("user")) as { login: string };
        await this.change(manifest => { manifest.site.guideProgress = Math.max(manifest.site.guideProgress ?? (manifest.site.initialized ? 7 : 1), 2); }, false);
        this.authorized = true; this.status = `已验证 GitHub 账号：${account.login}`; this.guideStep = 2; this.guideAvailableStep = Math.max(this.guideAvailableStep, 2);
      };
      const browserLogin = async () => {
        if (!await this.hasCli()) throw new Error("当前设备没有可用的 GitHub CLI，请选择 Token 授权。");
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
        button.disabled = this.setupBusy || this.busy || (mode === "browser" && Platform.isMobile);
        button.addEventListener("click", () => {
          if (this.setupBusy || this.busy) return;
          this.authMode = mode; this.authorized = false; this.token = ""; this.error = ""; this.status = ""; this.deviceCode = "";
          if (mode === "browser") run(browserLogin);
          else if (mode === "verify") run(verify);
          else this.renderViews();
        });
      }
      const authChoice = this.authMode ? auth.createDiv({ cls: "simple-share-guide-auth-choice" }) : auth;
      if (this.authMode === "browser") {
        const instructions = authChoice.createEl("p");
        instructions.append("在下方获取设备码，然后在浏览器中");
        link(instructions, "打开 GitHub 设备码填写页 ↗", "https://github.com/login/device");
        instructions.append("，按提示登录、输入设备码并完成授权。授权完成后会自动核验并进入下一步。");
        const deviceAction = authChoice.createDiv({ cls: "simple-one-sync-setup-device-action" });
        deviceAction.createEl("code", { text: this.deviceCode || (this.setupBusy ? "正在获取…" : ""), cls: `simple-one-sync-setup-device-slot${this.deviceCode ? " simple-one-sync-setup-device-code" : ""}`, attr: { "aria-live": "polite" } });
        const copy = deviceAction.createEl("button", { cls: "simple-one-sync-setup-device-icon-button", attr: { type: "button", "aria-label": "复制设备码", title: "复制设备码" } });
        setIcon(copy, "copy"); copy.disabled = !this.deviceCode;
        copy.addEventListener("click", runAsync(async () => { await navigator.clipboard.writeText(this.deviceCode); }));
        const refresh = deviceAction.createEl("button", { cls: "simple-one-sync-setup-device-icon-button", attr: { type: "button", "aria-label": "刷新设备码", title: "刷新设备码" } });
        setIcon(refresh, "refresh-cw"); refresh.disabled = this.setupBusy || this.busy;
        refresh.addEventListener("click", () => run(browserLogin));
        if (this.setupBusy) new Setting(authChoice).addButton(button => {
          button.buttonEl.addClass("simple-share-guide-cancel-auth");
          button.setButtonText("取消授权等待").onClick(() => this.authController?.abort());
        });
      } else if (this.authMode === "token") {
        authChoice.createEl("p", { text: "Token 会保存在本机 Obsidian 密钥存储，作为 API 兜底；电脑端若 GitHub CLI 验证可用，仍优先使用 CLI。token 不写入同步仓库。" });
        const tokenHint = authChoice.createDiv({ cls: "simple-one-sync-setup-token-hint" });
        setIcon(tokenHint.createSpan({ cls: "simple-one-sync-setup-token-hint__icon", attr: { "aria-hidden": "true" } }), "circle-alert");
        tokenHint.createSpan({ text: "Token 需要所选仓库的写入权限；使用 GitHub Pages 时还需要 Pages 管理权限。" });
        let submit: HTMLButtonElement | undefined;
        const tokenSetting = new Setting(authChoice).setName("GitHub token").addText(text => {
          text.inputEl.type = "password"; text.inputEl.autocomplete = "off"; text.inputEl.disabled = this.setupBusy || this.busy;
          text.setPlaceholder("粘贴 token").setValue(this.token).onChange(value => { this.token = value; if (submit) submit.disabled = this.setupBusy || this.busy || !value.trim(); });
        });
        tokenSetting.settingEl.addClass("simple-one-sync-setup-token-setting");
        link(tokenSetting.descEl, "前往 GitHub 创建 Token ↗", "https://github.com/settings/tokens");
        new Setting(authChoice).addButton(button => {
          submit = button.buttonEl;
          button.setButtonText("已填写 token，验证授权").setCta().setDisabled(this.setupBusy || this.busy || !this.token.trim()).onClick(() => {
            const token = this.token.trim();
            if (!token) return;
            this.token = "";
            run(async () => {
              if (!requireApiVersion("1.11.4")) throw new Error("API 兜底授权需要 Obsidian 1.11.4 或以上版本，请升级后重试。");
              let cliVerified = false;
              if (await this.hasCli()) {
                try {
                  await this.host.sync.exec("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], false, true, 120000, undefined, token + "\n");
                  cliVerified = await this.useCli();
                } catch { /* Preserve the verified API fallback attempt below. */ }
              }
              if (!cliVerified) await githubJson(token, "/user");
              if (requireApiVersion("1.11.4")) this.host.app.secretStorage.setSecret(this.secretId(), token);
              await verify();
            });
          });
        }).settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
      } else if (this.authMode === "verify") {
        authChoice.createEl("p", { text: this.setupBusy ? "正在验证 GitHub 授权…" : this.authorized ? "当前 GitHub 授权已核验。" : "选择后会自动验证 CLI 授权或本机保存的 Token。", cls: "simple-one-sync-setup-feedback" });
        if (this.error && !this.setupBusy) action("重新验证", verify, authChoice).settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
      }
    } else if (this.guideStep === 2) {
      container.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-repository");
      const mode = this.repoMode ?? (this.manifest.site.repo ? "existing" : "create");
      const options = container.createDiv({ cls: "simple-one-sync-setup-options" });
      for (const choice of ["create", "existing"] as const) {
        const button = options.createEl("button", {
          text: choice === "create" ? "新建分享仓库" : "使用已有分享仓库",
          cls: `simple-one-sync-setup-option${mode === choice ? " is-selected" : ""}`,
          attr: { type: "button", "aria-pressed": String(mode === choice) }
        });
        button.disabled = this.setupBusy || this.busy;
        button.addEventListener("click", () => {
          if (this.setupBusy || this.busy) return;
          this.repoMode = choice; this.makeExistingRepositoryPrivate = false; this.error = ""; this.repositoryFeedback = "";
          this.renderViews();
        });
      }
      const content = container.createDiv({ cls: "simple-one-sync-setup-platform-content simple-share-repository-content" });
      const card = content.createDiv({ cls: "simple-one-sync-setup-detail" });
      const feedback = (): void => {
        const area = card.createDiv({ cls: "simple-share-repo-feedback", attr: { role: "status", "aria-live": "polite" } });
        if (this.error || this.repositoryFeedback) area.createEl("p", { text: this.error || this.repositoryFeedback, cls: this.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback" });
        if (mode === "create" && this.takenRepository) {
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
        new Setting(card).setDesc(`可自定义名称，留空使用 ${suggested}。`)
          .addText(text => {
            text.inputEl.disabled = this.setupBusy || this.busy;
            text.inputEl.setAttribute("aria-label", "新仓库名称");
            text.setValue(this.draftName).setPlaceholder(suggested).onChange(value => {
              this.draftName = value; this.takenRepository = undefined; this.repositoryFeedback = ""; this.error = "";
              card.querySelector(".simple-share-repo-feedback")?.replaceChildren();
            });
          }).settingEl.addClass("simple-one-sync-setup-repo-name");
        feedback();
        action("创建分享仓库", async () => {
          try {
            await this.createRepository(this.draftName.trim() || suggested);
          } catch (error) {
            if (!this.useTakenRepository()) throw error;
          }
        }, card).settingEl.addClass("simple-one-sync-setup-action");
      } else {
        new Setting(card).setDesc("填写地址，或选择已经绑定的分享库。")
          .addText(text => {
            text.inputEl.disabled = this.setupBusy || this.busy;
            text.inputEl.setAttribute("aria-label", "GitHub 仓库地址");
            const list = card.createEl("datalist", { attr: { id: "simple-share-bound-repositories" } });
            for (const id of Object.keys(this.libraries)) {
              const site = id === this.libraryId ? this.manifest.site : ensureLibraries(this.manifest).entries[id].site;
              list.createEl("option", { value: `https://github.com/${site.owner}/${site.repo}` });
            }
            text.inputEl.setAttribute("list", list.id);
            text.setPlaceholder("https://github.com/用户名/分享仓库.git").setValue(this.draftRepo || (this.manifest.site.repo ? `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}` : "")).onChange(value => { this.draftRepo = value; });
          }).settingEl.addClass("simple-one-sync-setup-repo-url");
        feedback();
        const privateOption = card.createEl("label", { cls: "simple-share-repo-private-option" });
        const privateCheckbox = privateOption.createEl("input", { attr: { type: "checkbox" } });
        privateCheckbox.checked = this.makeExistingRepositoryPrivate;
        privateCheckbox.disabled = this.setupBusy || this.busy;
        privateOption.createSpan({ text: "将该仓库设置为私有" });
        const visibilityHint = card.createDiv({ cls: "simple-share-edgeone-area-note simple-share-repository-visibility-note", attr: { role: "note" } });
        setIcon(visibilityHint.createSpan({ cls: "simple-share-edgeone-area-note__icon", attr: { "aria-hidden": "true" } }), "circle-alert");
        const visibilityCopy = visibilityHint.createSpan();
        const updateVisibilityHint = (): void => visibilityCopy.setText(this.makeExistingRepositoryPrivate
          ? "连接后，分享仓库将设为私有，无法使用 GitHub Pages 发布；需接入其他发布方式。"
          : "连接后，分享仓库将设为公开，任何人都可以查看其内容。");
        updateVisibilityHint();
        privateCheckbox.addEventListener("change", () => { this.makeExistingRepositoryPrivate = privateCheckbox.checked; updateVisibilityHint(); });
        action("连接已有仓库", async () => {
          const input = this.draftRepo || `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}`;
          const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(input.trim());
          if (!match) throw new Error("请输入 GitHub 仓库 HTTPS 地址。"); await this.bind(match[1], match[2], this.makeExistingRepositoryPrivate);
        }, card).settingEl.addClass("simple-one-sync-setup-action");
      }
    } else if (this.guideStep === 3) {
      const mode = this.hostingMode;
      container.createEl("p", { text: "仅使用 GitHub Pages：分享仓库须公开（非原笔记仓库），通过 GitHub Pages 地址访问。" });
      container.createEl("p", { text: "再接入 EdgeOne Makers：分享仓库可保持私有，网站通过 EdgeOne 发布。" });
      const options = container.createDiv({ cls: "simple-one-sync-setup-options" });
      for (const choice of ["edgeone", "github"] as const) {
        const button = options.createEl("button", {
          text: choice === "edgeone" ? "接入 EdgeOne Makers" : "仅使用 GitHub Pages",
          cls: `simple-one-sync-setup-option${mode === choice ? " is-selected" : ""}`,
          attr: { type: "button", "aria-pressed": String(mode === choice) }
        });
        button.disabled = this.setupBusy || this.busy || this.edgeone.busy;
        button.addEventListener("click", () => {
          if (button.disabled) return;
          if (this.hostingMode !== choice) {
            this.edgeone.authMode = null;
            if (choice === "edgeone") { this.guideVisibilityAttemptedKey = ""; this.edgeOneDeploymentFailed = false; this.edgeOneGuideAttemptFailed = false; }
          }
          this.hostingMode = choice;
          if (choice === "github") {
            run(async () => { await this.change(manifest => { manifest.site.hosting = "github"; manifest.site.guideProgress = Math.max(manifest.site.guideProgress ?? 1, 4); }, false); this.guideVisibilityAttemptedKey = ""; this.guideStep = 4; });
            return;
          }
          this.renderViews();
        });
      }
      if (mode === "edgeone") {
        const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
        const inspectEdgeOneFailure = (this.edgeOneDeploymentFailed || this.edgeone.projectCreationFailed) && !this.isPublishing;
        if (inspectEdgeOneFailure && this.guideVisibilityAttemptedKey !== key)
          this.inspectGuideRepositoryVisibility();
        const completeEdgeOne = async () => {
          this.edgeOneDeploymentFailed = false;
          this.edgeOneGuideAttemptFailed = false;
          this.guideVisibilityAttemptedKey = "";
          try {
            if (!this.edgeone.linked || !this.edgeone.projectCheckDone) throw new Error("请先核验 EdgeOne 授权并关联当前分享仓库的项目。");
            await this.change(manifest => { manifest.site.hosting = "edgeone"; manifest.site.guideProgress = 3; }, false);
            await this.validateHosting();
            try {
              await this.publish(true, undefined, true, 4);
              if (this.error || !this.edgeone.completed) throw new Error(this.error || "EdgeOne 本次 Git 部署尚未成功，请查看部署记录后重试。");
            } catch (error) { this.edgeOneDeploymentFailed = true; throw error; }
            this.guideVisibilityAttemptedKey = "";
            this.guidePagesAttemptedKey = "";
            this.guideStep = 4;
          } catch (error) { this.edgeOneGuideAttemptFailed = true; throw error; }
        };
        const content = container.createDiv({ cls: "simple-one-sync-setup-platform-content" });
        renderEdgeOneGuide(content, this.edgeone, this.manifest.enabled, this.isPublishing,
          () => this.renderViews(), () => { this.guideStep = 2; this.renderViews(); }, true, () => run(completeEdgeOne),
          inspectEdgeOneFailure ? this.edgeOneRepositoryVisibility() : undefined, this.error ? "" : this.status);
        const footer = content.createDiv({ cls: "simple-share-guide-footer" });
        const linkedProgress = this.edgeone.linked && this.edgeone.projectCheckDone &&
          (this.isPublishing || this.edgeone.state.lastCheck?.kind === "pending");
        if (this.error || this.status && !linkedProgress) footer.createEl("p", { text: this.error || this.status,
          cls: `simple-share-guide-footer-status ${this.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback"}`,
          attr: { role: "status", "aria-live": "polite" } });
        const canRetry = this.edgeOneGuideAttemptFailed && this.edgeone.projectCheckDone && this.edgeone.linked && !this.edgeone.error;
        action(this.setupBusy || this.isPublishing ? "正在验证仓库读取并部署…" : canRetry ? "重新验证仓库读取并部署"
          : this.edgeone.linked && this.edgeone.projectCheckDone ? "等待自动验证仓库读取并部署…" : "等待项目关联后验证",
          completeEdgeOne, footer, !canRetry);
      }
    } else if (this.guideStep === 4) {
      if (this.manifest.site.hosting === "edgeone") {
        const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
        if (this.guideVisibilityAttemptedKey !== key) this.inspectGuideRepositoryVisibility();
        const visibility = this.guideVisibility?.key === key ? this.guideVisibility : undefined;
        if (visibility?.private === false && this.guidePagesAttemptedKey !== key) this.inspectGuidePages();
        const pages = this.guidePages?.key === key ? this.guidePages : undefined;
        const results = container.createDiv({ cls: "simple-share-guide-results" });
        const github = results.createDiv({ cls: "simple-share-guide-result" });
        github.createEl("h3", { text: "GitHub Pages" });
        const githubSettings = `https://github.com/${key}/settings/pages`;
        if (this.guideVisibilityChecking || !visibility && !this.guideVisibilityError)
          github.createEl("p", { text: "正在检查分享仓库状态…" });
        else if (this.guideVisibilityError)
          github.createEl("p", { text: "暂时无法确认分享仓库及 GitHub Pages 状态。", cls: "simple-one-sync-setup-error" });
        else if (visibility?.private)
          github.createEl("p", { text: "当前分享仓库为私有，GitHub Pages 页面不可用。", cls: "simple-one-sync-setup-helper" });
        else if (this.guidePagesChecking || !pages && !this.guidePagesError)
          github.createEl("p", { text: "仓库已公开，正在检查 GitHub Pages…" });
        else if (pages) {
          github.createEl("p", { text: pages.status === "built" ? "GitHub Pages 已发布。" : pages.status === "errored"
            ? "GitHub Pages 已启用，但最近一次构建失败。" : "GitHub Pages 已启用；页面是否可访问请以 GitHub 构建结果为准。",
            cls: pages.status === "errored" ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback" });
          shareExternalLink(github, `${pages.status === "built" ? "打开" : "查看"} GitHub Pages 地址：${pages.url} ↗`, pages.url);
        } else github.createEl("p", { text: `仓库已公开，${this.guidePagesError}`, cls: "simple-one-sync-setup-helper" });
        if (!visibility?.private && !this.guideVisibilityChecking) shareExternalLink(github, "查看 GitHub Pages 设置 ↗", githubSettings);

        const edgeone = results.createDiv({ cls: "simple-share-guide-result" });
        edgeone.createEl("h3", { text: "EdgeOne Makers" });
        edgeone.createEl("p", { text: this.edgeone.completed
          ? `项目 ${this.edgeone.state.projectName} 本次 Git 部署成功。`
          : "本次 Git 部署尚未成功，请返回第 3 步检查。",
          cls: this.edgeone.completed ? "simple-one-sync-setup-feedback" : "simple-one-sync-setup-error" });
        if (this.edgeone.website) shareExternalLink(edgeone, `项目网址：${this.edgeone.website} ↗`, this.edgeone.website);
        else edgeone.createEl("p", { text: "尚未取得项目网址，请在 EdgeOne 项目页查看。" });
        const area = this.edgeone.state.area;
        const areaLabel = area === "global" ? "全球（含中国大陆）" : area === "mainland" ? "中国大陆" : area === "overseas" ? "全球（不含中国大陆）" : "未能读取";
        edgeone.createEl("p", { text: `加速区域：${areaLabel}。` });
        if (area === "global" || area === "mainland") {
          renderMainlandPreviewNotice(edgeone, this.edgeone.state.projectId
            ? `https://console.cloud.tencent.com/edgeone/pages/project/${encodeURIComponent(this.edgeone.state.projectId)}` : EDGEONE_PROJECTS_URL);
        } else if (area === "overseas") edgeone.createEl("p", { text: "该区域不提供中国大陆节点加速；项目域名适用于中国大陆以外地区。" });
        shareExternalLink(edgeone, "查看 EdgeOne 项目及构建日志 ↗", EDGEONE_PROJECTS_URL);
        const footer = container.createDiv({ cls: "simple-share-guide-footer" });
        if (this.edgeone.completed) action("完成并返回分享管理", async () => {
          await this.change(manifest => { manifest.site.guideProgress = 7; }, false);
          await this.open(true);
        }, footer);
        else action("返回第 3 步验证部署", async () => { this.hostingMode = "edgeone"; this.guideStep = 3; this.error = ""; }, footer);
      } else {
      if (completed) {
        container.createEl("p", { text: `分享网站已发布 · ${this.manifest.site.owner}/${this.manifest.site.repo}`, cls: "simple-one-sync-setup-feedback" });
        if (this.guideVisibilityChangedKey === `${this.manifest.site.owner}/${this.manifest.site.repo}`)
          container.createEl("p", { text: "为使用 GitHub Pages，已自动将当前分享仓库设为公开。", cls: "simple-one-sync-setup-feedback" });
        const website = siteUrl(this.manifest.site);
        if (website) shareExternalLink(container, "打开分享网站 ↗", website);
        const footer = container.createDiv({ cls: "simple-share-guide-footer" });
        action("完成并返回分享管理", async () => { await this.open(true); }, footer);
      } else {
      const key = `${this.manifest.site.owner}/${this.manifest.site.repo}`;
      if (this.guideVisibilityAttemptedKey !== key) this.inspectGuideRepositoryVisibility();
      const visibility = this.guideVisibility?.key === key ? this.guideVisibility : undefined;
      container.createEl("p", { text: "已选择 GitHub Pages，分享仓库必须公开。" });
      container.createEl("p", { text: this.guideVisibilityChecking ? "正在检查 GitHub 分享仓库的公开或私有状态…"
        : this.guideVisibilityError || (visibility ? `GitHub 分享仓库状态：${visibility.private ? "私有" : "公开"}。` : "尚未检查 GitHub 分享仓库状态。"),
        cls: this.guideVisibilityError || visibility?.private ? "simple-one-sync-setup-error" : "simple-one-sync-setup-helper",
        attr: { role: "status", "aria-live": "polite" } });
      if (this.guideVisibilityChangedKey === key && !visibility?.private) container.createEl("p", {
        text: `已自动将分享仓库 ${key} 设为公开。`, cls: "simple-one-sync-setup-feedback", attr: { role: "status" }
      });
      if (this.guideVisibilityError) action("重新检查仓库状态", async () => { this.guideVisibilityAttemptedKey = ""; this.renderViews(); });
      if (visibility?.private) {
        container.createEl("p", { text: `当前选择仅使用 GitHub Pages。继续后，插件会将分享仓库 ${key} 设为公开，仓库内所有内容将可被任何人查看。此操作只针对分享仓库。`, cls: "simple-one-sync-setup-error" });
        action("返回选择发布方式", async () => { this.guideStep = 3; this.error = ""; });
        shareExternalLink(container, "前往 GitHub 修改仓库属性 ↗", `https://github.com/${this.manifest.site.owner}/${this.manifest.site.repo}/settings`);
      }
      if (this.error) {
        action("返回选择发布方式", async () => { this.guideStep = 3; this.error = ""; });
      }

      if (visibility) {
        container.createEl("p", { text: `将初始化 ${this.manifest.site.owner}/${this.manifest.site.repo} 的阅读页面。` });
        action(visibility.private ? "公开分享仓库并初始化网站" : "初始化网站并完成", async () => {
          await this.ensureGuideGithubPagesPublic();
          await this.validateHosting(); await this.publish(true);
          if (this.error) throw new Error(this.error);
        });
      }
      }
      }
    }
  }

  private async createRepository(name: string): Promise<void> {
    this.takenRepository = undefined;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || [".", ".."].includes(name)) throw new Error("仓库名只能包含字母、数字、点、下划线和连字符。");
    this.reportRepository("正在确认 GitHub 账号…");
    const owner = (JSON.parse(await this.github("user")) as { login: string }).login;
    const taken = () => {
      this.takenRepository = { owner, name };
      return new Error(`仓库名称已被使用：${owner}/${name}。请更换名称，或选择「使用已有分享仓库」连接原仓库。`);
    };
    let exists = false;
    this.reportRepository(`正在检查仓库名称 ${owner}/${name} 是否已被使用…`);
    try { await this.github(`repos/${owner}/${name}`); exists = true; }
    catch (error) { if (!String(error).includes("404")) throw error; }
    if (exists) throw taken();
    this.reportRepository(`仓库名称可用，正在创建分享仓库 ${owner}/${name}…`);
    try { await this.github("user/repos", "POST", { name, private:false, auto_init:true }); }
    catch (error) {
      if (/already exists|already been taken|name[^\n]*taken/i.test(String(error))) throw taken();
      throw error;
    }
    await this.bind(owner, name);
  }
  private async bind(owner: string, repo: string, makePrivate = false): Promise<void> {
    this.reportRepository("正在核验仓库地址与当前分享配置…");
    const value = JSON.parse(await this.github(`repos/${owner}/${repo}`)) as { default_branch?: string; private?: boolean };
    const site = { owner, repo, branch: value.default_branch || "main" };
    this.reportRepository(`已读取默认分支 ${site.branch}；正在核验归档状态和写入权限…`);
    await (await this.repository(site)).verify();
    if (typeof value.private !== "boolean") throw new Error("GitHub 未返回仓库可见性，未更改仓库属性。");
    if (value.private !== makePrivate) {
      const visibility = makePrivate ? "私有" : "公开";
      this.reportRepository(`正在将分享仓库 ${owner}/${repo} 设为${visibility}…`);
      try { await this.github(`repos/${owner}/${repo}`, "PATCH", { private: makePrivate }); }
      catch { throw new Error(`未能将仓库 ${owner}/${repo} 设为${visibility}。请检查 GitHub 管理权限或组织限制；尚未连接此仓库。`); }
      let confirmed: { private?: unknown };
      try { confirmed = JSON.parse(await this.github(`repos/${owner}/${repo}`)) as { private?: unknown }; }
      catch { throw new Error(`GitHub 已收到将仓库 ${owner}/${repo} 设为${visibility}的请求，但未能确认结果。请先到 GitHub 检查仓库状态。`); }
      if (confirmed.private !== makePrivate) throw new Error(`GitHub 尚未确认仓库 ${owner}/${repo} 已设为${visibility}。请先到 GitHub 检查仓库状态。`);
    }
    const existing = Object.entries(ensureLibraries(this.manifest).entries).find(([id, value]) => id !== this.libraryId && `${value.site.owner}/${value.site.repo}`.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    if (existing) { await this.change(manifest => selectLibrary(manifest, existing[0]), false); await this.edgeone.load(); }
    else if (this.manifest.site.repo && `${owner}/${repo}`.toLowerCase() !== `${this.manifest.site.owner}/${this.manifest.site.repo}`.toLowerCase()) { await this.change(manifest => addLibrary(manifest), false); await this.edgeone.load(); }
    this.reportRepository("核验通过，正在保存分享仓库连接…");
    await this.change(manifest => {
      const initialized = manifest.site.owner.toLowerCase() === owner.toLowerCase() && manifest.site.repo.toLowerCase() === repo.toLowerCase() && manifest.site.branch === site.branch ? manifest.site.initialized : undefined;
      manifest.site = { ...site, hosting: manifest.site.hosting, ...(initialized !== undefined ? { initialized } : {}), guideProgress: initialized ? Math.max(manifest.site.guideProgress ?? 1, 3) : 3 };
    }, false); this.hostingMode = null; this.edgeone.authMode = null; this.guideStep = 3; this.guideAvailableStep = Math.max(this.guideAvailableStep, 3);
    this.status = "";
    this.makeExistingRepositoryPrivate = false;
  }
  private reportRepository(text: string): void {
    this.repositoryFeedback = text;
    if (this.setupBusy) this.renderViews();
  }
  detachSettings(): void { this.setupHost = undefined; this.setupTitleChanged = undefined; this.authController?.abort(); this.token = ""; this.hostingMode = null; this.edgeone.authMode = null; this.edgeone.stop(); this.edgeOneGuideOpen = false; this.managingLibraryId = null; }
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
  getDisplayText(): string { return "同步与分享"; }
  getIcon(): string { return "refresh-cw"; }
  getState(): Record<string, unknown> { return { ...super.getState(), ...this.feature.display, collapsed: [...this.collapsed] }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    this.feature.restoreDisplay(state);
    if (Array.isArray(state.collapsed)) this.collapsed = new Set(state.collapsed.filter((key): key is string => typeof key === "string"));
    await super.setState(state, result); this.render();
  }
  async onOpen(): Promise<void> { this.render(); }
  render(): void {
    this.contentEl.empty(); this.contentEl.addClass("simple-share-panel");
    this.feature.renderLibrarySelector(this.contentEl);
    const header = new Setting(this.contentEl)
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
        button.setIcon("globe").setTooltip("打开分享网站").setDisabled(!this.feature.website).onClick(() => window.open(this.feature.website, "_blank", "noopener"));
        button.buttonEl.addClass("simple-share-header-icon", "clickable-icon", "nav-action-button");
      })
      .addButton(button => {
        const labels: Record<ShareLayout, string> = { list: "平铺笔记", source: "本地目录", public: "公开目录" };
        const modes = ["list", "source", "public"] as const;
        button.setIcon(this.layout === "list" ? "list" : this.layout === "source" ? "folder-tree" : "network")
          .setTooltip("切换文件视图").onClick(() => {
            this.feature.updateDisplay({ layout: modes[(modes.indexOf(this.layout) + 1) % modes.length] });
          });
        button.buttonEl.addEventListener("contextmenu", event => {
          event.preventDefault();
          event.stopPropagation();
          const menu = new Menu();
          for (const mode of modes) menu.addItem(item => item.setTitle(labels[mode]).setChecked(this.layout === mode).onClick(() => {
            this.feature.updateDisplay({ layout: mode });
          }));
          menu.showAtMouseEvent(event);
        });
        button.buttonEl.setAttribute("aria-label", "切换文件视图");
        button.buttonEl.addClass("simple-share-header-icon", "clickable-icon", "nav-action-button");
      });
    header.addButton(button => {
      button.setIcon(this.descending ? "simple-share-sort-desc" : "simple-share-sort-asc")
        .setTooltip(this.descending ? "名称倒序 Z→A；点击切换正序" : "名称正序 A→Z；点击切换倒序")
        .onClick(() => this.feature.updateDisplay({ descending: !this.descending }));
      button.buttonEl.addClass("simple-share-header-icon", "simple-share-sort-button", "clickable-icon", "nav-action-button");
    });
    header.addButton(button => {
      button.setIcon(this.showPaths ? "simple-share-paths-visible" : "simple-share-paths-hidden").setTooltip("是否显示路径").onClick(() => {
        this.feature.updateDisplay({ showPaths: !this.showPaths });
      });
      button.buttonEl.addClass("simple-share-header-icon", "simple-share-paths-toggle", "clickable-icon", "nav-action-button");
      button.buttonEl.setAttribute("aria-label", "是否显示路径");
      button.buttonEl.setAttribute("aria-pressed", String(this.showPaths));
    });
    header.addButton(button => {
      button.setIcon("simple-share-copy-settings").setTooltip("复制设置").onClick(event => {
        const menu = new Menu();
        this.feature.addCopyContentMenu(menu);
        menu.showAtMouseEvent(event);
      });
      button.buttonEl.addClass("simple-share-header-icon", "simple-share-composite-icon", "clickable-icon", "nav-action-button");
      button.buttonEl.setAttribute("aria-label", "复制设置");
    });
    header.addButton(button => {
      button.setIcon("settings").setTooltip("打开分享设置").onClick(() => this.feature.host.sync.openPluginSettings(true));
      button.buttonEl.addClass("simple-share-header-icon", "clickable-icon", "nav-action-button");
      button.buttonEl.setAttribute("aria-label", "打开分享设置");
    });
    header.settingEl.addClass("simple-share-header");
    const syncButton = header.controlEl.createEl("button", { cls: "simple-one-panel-switch",
      attr: { type: "button", "aria-label": "切换到同步" } });
    setIcon(syncButton.createSpan({ cls: "simple-one-panel-switch__icon", attr: { "aria-hidden": "true" } }), "arrow-right-left");
    syncButton.createSpan({ text: "切换同步" });
    syncButton.addEventListener("click", runAsync(() => this.feature.host.sync.openSyncView()));
    const publish = this.feature.addPublishButton(new Setting(this.contentEl));
    publish.settingEl.addClass("simple-share-publish-row");
    const primary = publish.settingEl.querySelector<HTMLButtonElement>(".simple-share-publish")!;
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
