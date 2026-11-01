import { reviewImage, reviewImageLimit, type ReviewImage } from "./reviewImage";
import { readApiLocal, writeApiLocal } from "./storage";
import { DataAdapter } from "obsidian";
import { githubResponse } from "./githubApi";
import { SYNC_HASH_VERSION, LocalSyncEdit, blobSha, syncBytes, sameContent, FileEntry, identityPaths, included, linkDiff, LocalState, Manifest, MobileOptions, newLocalState, newPathRecords, normalizePaths, PathRecords, noteChange, safePath, scanCurrent } from "./linkDiff";
import { parseGithubRepoUrl } from "./onboarding";
import { OperationTiming } from "../../shared/operationTiming";
import { legacyScopeRules, organizedLocalIgnore, readRootIgnore, rootIgnoreMatcher, writeRootIgnore } from "./localIgnore";

export interface RemoteSnapshot { commit: string; tree: string; files: Manifest; plugins: string[]; branch: string; renames: Record<string, string> }
export interface VerifiedAccess { branch: string; login: string; repository: string }
interface Side extends FileEntry { path: string; source: "local" | "remote" }
export interface MobileConflict {
  id: string; label: string; kind: "content" | "path" | "delete" | "initial" | "unpaired" | "duplicate";
  base?: Side; local?: Side; remote?: Side; targetPath?: string;
  localFiles?: Side[]; remoteFiles?: Side[];
}
export interface ConflictChoice { choice: "local" | "remote" | "manual" | "both" | "delete"; text?: string }
const PREVIEW_SNAPSHOT = Symbol("mobile-preview");
interface PreviewSnapshot {
  remote: RemoteSnapshot; local: Manifest; base: Manifest; paths: PathRecords;
  revision: number; scope: string; context: string;
  baseCommitSha: string | null; rejoinReview: boolean; downloading: Manifest; rechecking?: boolean;
}
export interface MobilePlan {
  [PREVIEW_SNAPSHOT]?: PreviewSnapshot;
  remote: RemoteSnapshot; local: Manifest; desired: Manifest; conflicts: MobileConflict[];
  uploads: string[]; downloads: string[]; localDeletes: string[]; remoteDeletes: string[];
  revision: number; pendingChoices: Record<string, ConflictChoice>; remoteRenames: Record<string, string>;
  paths: PathRecords; scope: string;
  mergedContents: Record<string, string>;
  identityTargets?: Record<string, string[]>;
}
interface LocalAction { path: string; sha: string | null; expected: string | null; size?: number }
export interface DownloadTask {
  mode: "choice" | "manual" | "automatic";
  downloads: number;
  completed?: number;
  total: number;
  createdAt: number;
  reviewRequired?: boolean;
}
interface ActionReceipt { applied: boolean; observed: string | null }
interface LocalRecheck { commit: string; scope: string; target: Manifest; base: Manifest; identityTargets: Record<string, string[]>; receipts: Record<string, ActionReceipt> }
interface PendingTransaction {
  commit: string; parent: string; base: Manifest; actions: LocalAction[];
  revision: number; paths: PathRecords;
  scope: string;
  transfer?: DownloadTask;
  receipts?: Record<string, ActionReceipt>;
  integrityFailures?: Record<string, string | null>;
  writesStarted?: boolean;
  comparisonBase?: Manifest;
  identityTargets?: Record<string, string[]>;
}
interface StoredState extends LocalState {
  localRecheck?: LocalRecheck;
  rejoinReview?: boolean;
  pending?: PendingTransaction;
  downloadVerification?: { phase: "downloading" | "verifying"; scope: string; commit: string; files: Manifest };
}
type ApiObject = Record<string, unknown>;
interface TreeEntry { path: string; type: string; mode: string; sha: string; size?: number }
interface CompareEntry { status: string; filename: string; previous_filename: string }


export class MobileGithub {
  state: StoredState = newLocalState();
  remaining: number | null = null;
  private remainingListeners = new Set<(remaining: number | null) => void>();

  onRemainingChange(listener: (remaining: number | null) => void): () => void {
    this.remainingListeners.add(listener);
    return () => { this.remainingListeners.delete(listener); };
  }

  resetRemaining(): void {
    this.remainingRevision++;
    this.remaining = null;
    this.notifyRemaining();
  }
  private remainingRevision = 0;

  private notifyRemaining(): void {
    for (const listener of this.remainingListeners) {
      try { listener(this.remaining); }
      catch { console.warn("同步与分享：额度显示更新失败。"); }
    }
  }
  get needsLocalRecheck(): boolean { return !!this.state.localRecheck; }

  private savePromise?: Promise<void>;
  private saveRequested = false;
  private loaded = false;
  private loadPromise?: Promise<void>;
  private deferredEvents: Array<{ type: "create" | "modify" | "delete" | "rename"; path: string; oldPath?: string }> = [];
  private running = false;
  private blobSizes = new Map<string, number>();
  private previewSnapshot?: PreviewSnapshot;
  private activeTiming?: OperationTiming;
  private rootIgnoreText?: string;
  private rootFileText?: string;
  private rootIgnored?: (path: string) => boolean;

  constructor(private adapter: DataAdapter, private configDir: string, private pluginId: string,
    private getOptions: () => MobileOptions, private progress: (message: string) => void,
    private operationLog?: (context: string, status: "success" | "error", message: string) => Promise<void>,
    private timingEnabled: () => boolean = () => false) {}

  private async finishTiming(context: string, timing: OperationTiming | undefined, failed: boolean): Promise<void> {
    if (!timing) return;
    try {
      await this.operationLog?.(context, failed ? "error" : "success",
        `${failed ? `失败阶段：${timing.currentStage}\n` : ""}${timing.summary()}`);
    } catch { /* Timing logs must not change the operation result. */ }
  }

  private get statePath(): string { return `${this.configDir}/plugins/${this.pluginId}/sync-api-local.json`; }
  private get recoveryPath(): string { return `${this.statePath}.recovery`; }
  get downloadTask(): DownloadTask | undefined { return this.state.pending?.transfer; }
  get initialSync(): boolean { return !this.state.baseCommitSha || !!this.state.rejoinReview; }
  allowed = (path: string): boolean => this.rootIgnored ? !this.rootIgnored(path) : included(path, this.getOptions(), this.configDir, this.pluginId);

  private async refreshRules(): Promise<void> {
    const text = await readRootIgnore(this.adapter);
    this.rootFileText = text;
    if (!text.includes("# >>> simple-one:fixed")) {
      throw new Error("本机规则尚未准备，请先完成轻量接入或手动重建规则；已有待办请使用引导上方「重新检查或修复接入」，本机文件与共同基准保留。");
    }
    if (text !== this.rootIgnoreText) {
      this.rootIgnoreText = text;
      this.rootIgnored = rootIgnoreMatcher(text, this.configDir);
    }
  }

  async prepareLocalRules(): Promise<void> {
    await this.load();
    if (this.state.pending || this.state.downloadVerification || this.state.localRecheck) throw new Error("还有未完成的同步或下载验证，请先用原连接恢复，或重新检查接入；不会改写本机规则。");
    const original = await readRootIgnore(this.adapter);
    if (!original.includes("# >>> simple-one:fixed")) {
      const legacy = legacyScopeRules(this.getOptions()).map(line => line.split("{config}").join(this.configDir));
      await writeRootIgnore(this.adapter, original, organizedLocalIgnore(original, this.configDir, legacy), this.configDir);
    }
    await this.refreshRules();
  }

  async recheckScope(expected?: string): Promise<string> {
    await this.refreshRules();
    const current = this.scope();
    if (expected !== undefined && current !== expected) throw new Error("重新核对期间仓库、分支或本机规则变化，已保留进度；请恢复原配置后继续。");
    return current;
  }

  private async assertRulesUnchanged(): Promise<void> {
    if (await readRootIgnore(this.adapter) !== this.rootFileText) throw new Error("本机 .gitignore 在预览后变化，已停止；请重新预览同步。");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    const loading = this.readState();
    this.loadPromise = loading;
    try { await loading; }
    finally { if (this.loadPromise === loading) this.loadPromise = undefined; }
  }

  private async readState(): Promise<void> {
    let parsed: StoredState | undefined;
    let recovered = false;
    for (const path of [this.statePath, this.recoveryPath, this.statePath.replace("sync-api-local", "link-state"), this.recoveryPath.replace("sync-api-local", "link-state")]) {
      if (!await this.adapter.exists(path)) continue;
      try {
        const raw = JSON.parse(await this.adapter.read(path)) as Record<string, unknown>;
        if (path.includes("sync-api-local") && !raw.state) continue;
        const candidate = (raw.state ?? raw) as StoredState;
        if (candidate.schema !== 1 || !candidate.base || !candidate.cache || !candidate.paths || !candidate.dirty) {
          throw new Error("Invalid state");
        }
        validateLocalRecovery(candidate);
        parsed = candidate; recovered = path !== this.statePath; break;
      } catch {
        if (path === this.recoveryPath) throw new Error("本机 Link 状态与恢复副本均无法读取，已停止同步；请保留文件后检查。");
      }
    }
    if (!parsed && ((await readApiLocal(this.adapter, this.configDir, this.pluginId)).state || await this.adapter.exists(this.statePath.replace("sync-api-local", "link-state")))) {
      throw new Error("本机 Link 状态无法读取且没有恢复副本，已停止同步；请保留文件后检查。");
    }
    if (parsed) {
      this.state = parsed;
      const oldPaths = !("moves" in parsed.paths) || "copies" in parsed.paths ||
        !!parsed.pending && (!("moves" in parsed.pending.paths) || "copies" in parsed.pending.paths);
      parsed.paths = normalizePaths(parsed.paths);
      if (parsed.pending) parsed.pending.paths = normalizePaths(parsed.pending.paths);
      if (parsed.pending && !parsed.downloadVerification) {
        parsed.downloadVerification = { phase: "downloading", scope: parsed.pending.scope, commit: parsed.pending.commit,
          files: Object.fromEntries(parsed.pending.actions.filter(action => action.sha !== null)
            .map(action => [action.path, parsed.pending!.base[action.path]])) };
        await this.save();
      }
      // Drop the obsolete baseline tree identifier without changing the baseline.
      const legacy = parsed as StoredState & { baseTreeSha?: string };
      if (recovered || oldPaths || "baseTreeSha" in legacy) {
        delete legacy.baseTreeSha;
        await this.save();
      }
    }
    this.loaded = true;
    for (const event of this.deferredEvents) this.event(event.type, event.path, event.oldPath);
    this.deferredEvents = [];
  }

  save(): Promise<void> {
    this.saveRequested = true;
    if (this.savePromise) return this.savePromise;
    // Retain one writer and the latest state, rather than a large JSON snapshot
    // for every event in a batch. Callers still wait for all requested writes.
    const write = Promise.resolve().then(async () => {
      do {
        this.saveRequested = false;
        const snapshot = JSON.stringify(this.state);
        // Write the recovery copy first: an interrupted primary write then has
        // a complete snapshot of the transaction that preceded cloud mutation.
        await writeApiLocal(this.adapter, this.configDir, this.pluginId, { state: JSON.parse(snapshot) });
      } while (this.saveRequested);
    });
    this.savePromise = write;
    void write.finally(() => {
      if (this.savePromise === write) this.savePromise = undefined;
    }).catch(() => undefined);
    return write;
  }

  event(type: "create" | "modify" | "delete" | "rename", path: string, oldPath?: string): void {
    if (!this.loaded) { this.deferredEvents.push({ type, path, oldPath }); return; }
    if (!this.allowed(path) && (!oldPath || !this.allowed(oldPath))) return;
    // Folder events may have no extension and are expanded by noteChange.
    noteChange(this.state, type, path, oldPath);
    if (!this.getOptions().trackPaths) this.state.paths = newPathRecords();
  }

  private repo(): { owner: string; name: string; prefix: string } {
    const repo = parseGithubRepoUrl(this.getOptions().repoUrl);
    if (!this.getOptions().token.trim()) throw new Error("请填写手机端 GitHub Token。");
    return { ...repo, prefix: `/repos/${repo.owner}/${repo.name}` };
  }

  private async json<T>(path: string, read: (value: unknown) => T, method = "GET", body?: unknown): Promise<T> {
    return read(await this.api(path, method, body));
  }

  private async api(path: string, method = "GET", body?: unknown, raw = false, timeoutMs = 60000): Promise<unknown> {
    const token = this.getOptions().token.trim();
    if (!token) throw new Error("请先填写 GitHub Token。");
    const remainingRevision = this.remainingRevision;
      const response = await githubResponse(token, path, method, body, raw, timeoutMs);
      const left = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "x-ratelimit-remaining")?.[1];
      if (remainingRevision === this.remainingRevision && token === this.getOptions().token.trim() &&
          left !== undefined && left.trim() !== "") {
        const remaining = Number(left);
        if (Number.isInteger(remaining) && remaining >= 0) {
          this.remaining = remaining;
          this.notifyRemaining();
        }
      }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401) throw new Error("GitHub Token 无效或已过期。");
        if (response.status === 403 || response.status === 429) throw new Error("GitHub 拒绝请求：请检查 Token 权限或稍后重试（可能限流）。");
        if (response.status === 404) throw new Error("仓库或分支不存在，或者 Token 无权访问。");
        throw new Error(`GitHub HTTP ${response.status}：请求未完成，请重新检查远端状态。`);
      }
      if (!raw) return response.json;
      const type = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
      if (type.includes("json")) return decodeBase64(apiString(apiObject(response.json).content, true));
      return new Uint8Array(response.arrayBuffer);
  }

  private scope(): string {
    const o = this.getOptions();
    if (this.rootIgnoreText !== undefined) return JSON.stringify(["root-gitignore-v1", o.repoUrl.toLowerCase(), o.branch, this.rootIgnoreText]);
    return JSON.stringify([o.repoUrl.toLowerCase(), o.branch, o.syncImages, o.syncPlugins,
      [...o.plugins].sort(), o.ignorePatterns]);
  }

  async remote(useCompare = false): Promise<RemoteSnapshot> {
    await this.refreshRules();
    const repo = this.repo();
    const branch = this.getOptions().branch.trim() || (await this.json(repo.prefix, readRepo)).default_branch;
    if (!branch) throw new Error("仓库尚无分支，请先在电脑端创建首次提交。");
    const head = await this.json(`${repo.prefix}/commits/${encodeURIComponent(branch)}`, readCommit);
    const rootTree = head.commit.tree.sha;
    const anchor = this.state.localRecheck;
    if (anchor && anchor.scope !== this.scope()) throw new Error("重新核对的仓库或范围已变化，请恢复原配置后继续。");
    const baseCommit = anchor?.commit ?? this.state.baseCommitSha;
    const remoteBase = anchor?.target ?? this.state.base;
    const renames: Record<string, string> = {};
    let comparison: ReturnType<typeof readCompare> | undefined;
    if (useCompare && baseCommit) {
      if (head.sha !== baseCommit) {
        comparison = await this.json(`${repo.prefix}/compare/${baseCommit}...${head.sha}`, readCompare);
        if (!["ahead", "identical"].includes(comparison.status)) throw new Error("远端历史与共同基准不一致，已停止同步，请重新核对仓库。");
        for (const change of comparison.files ?? []) {
          if (change.status === "renamed" && this.allowed(change.previous_filename) && this.allowed(change.filename)) {
            renames[change.previous_filename] = change.filename;
          }
        }
      }
      // Compare supplies rename identities but not authoritative file modes.
      // Reuse the baseline only for an unchanged head; changed heads need the
      // tree to detect executable files, symlinks and truncated comparisons.
      if ((anchor?.scope ?? this.state.baseScope) === this.scope() && head.sha === baseCommit) {
        const files: Manifest = Object.fromEntries(Object.entries(remoteBase).filter(([path]) => this.allowed(path)));
        return { commit: head.sha, tree: rootTree, files, plugins: [], branch, renames };
      }
    }
    const files: Manifest = {};
    this.blobSizes.clear();
    const pluginManifests = new Set<string>(); const pluginPrograms = new Set<string>();
    const collect = (entry: TreeEntry, prefix = ""): void => {
      const path = safePath(prefix + entry.path);
      if (entry.type === "blob" && ["100644", "100755"].includes(entry.mode) && path.startsWith(`${this.configDir}/plugins/`)) {
        const parts = path.slice(`${this.configDir}/plugins/`.length).split("/");
        if (parts.length === 2 && parts[1] === "manifest.json") pluginManifests.add(parts[0]);
        if (parts.length === 2 && parts[1] === "main.js") pluginPrograms.add(parts[0]);
      }
      if (!this.allowed(path)) return;
      if (entry.type === "blob") {
        if (!["100644", "100755"].includes(entry.mode)) throw new Error(`不支持同步符号链接：${path}`);
        files[path] = { sha: entry.sha, mode: entry.mode };
        if (entry.size !== undefined) this.blobSizes.set(entry.sha, entry.size);
      } else if (entry.type === "commit") throw new Error(`不支持同步 Git 子模块：${path}`);
    };
    const tree = await this.json(`${repo.prefix}/git/trees/${rootTree}?recursive=1`, readTree);
    if (!tree.truncated) { for (const entry of tree.tree) collect(entry); }
    else {
      const walk = async (sha: string, prefix = ""): Promise<void> => {
        const subtree = await this.json(`${repo.prefix}/git/trees/${sha}`, readTree);
        if (subtree.truncated) throw new Error("远端目录清单仍被截断，已停止同步，未推断删除。");
        for (const entry of subtree.tree) {
          if (entry.type === "tree") {
            const dir = prefix + safePath(entry.path);
            // Inspect immediate plugin directories even when excluded from sync;
            // a directory alone (or leftover settings) is not an installed plugin.
            if (dir === this.configDir || dir === `${this.configDir}/plugins` || prefix === `${this.configDir}/plugins/` || this.allowed(`${dir}/__link_scan__`)) {
              await walk(entry.sha, dir + "/");
            }
          }
          else collect(entry, prefix);
        }
      };
      await walk(rootTree);
    }
    const plugins = [...pluginManifests].filter(id => pluginPrograms.has(id)).sort();
    return { commit: head.sha, tree: rootTree, files, plugins, branch, renames };
  }

  async listCloudPlugins(): Promise<string[]> {
    const remote = await this.remote();
    return remote.plugins;
  }

  async verify(): Promise<RemoteSnapshot> {
    await this.load();
    const metadata = await this.json(this.repo().prefix, readRepo);
    if (metadata.permissions?.push === false) throw new Error("当前 Token 没有仓库写入权限，请授予 Contents 读写权限。");
    return await this.remote();
  }

  async verifyToken(): Promise<string> {
    const user = await this.json("/user", value => ({ login: apiString(apiObject(value).login) }));
    if (!user.login) throw new Error("未能确认 Token 对应的 GitHub 账号。");
    return user.login;
  }

  async verifyAccess(): Promise<VerifiedAccess> {
    const requested = { repoUrl: this.getOptions().repoUrl, branch: this.getOptions().branch, token: this.getOptions().token };
    const repo = this.repo();
    const login = await this.verifyToken();
    const prefix = repo.prefix;
    const metadata = await this.json(prefix, readRepo);
    if (!metadata.private) throw new Error("请选择 GitHub 私人仓库，避免公开笔记。");
    if (metadata.archived || metadata.disabled) throw new Error("仓库已归档或停用，无法同步。");
    if (metadata.permissions?.push === false) throw new Error("当前账号没有仓库写入权限。");
    const branch = this.getOptions().branch.trim() || metadata.default_branch;
    if (!branch) throw new Error("仓库尚无分支，请先在 GitHub 创建 README 或首次提交。");
    const branchInfo = await this.json(`${prefix}/branches/${encodeURIComponent(branch)}`, value => ({ protected: apiBoolean(apiObject(value).protected) }));
    if (branchInfo.protected) throw new Error("该分支受保护，请选择允许直接写入的同步分支。");
    // Test Contents:write with an unattached empty blob, never update a file, commit or branch.
    await this.api(`${prefix}/git/blobs`, "POST", { content: "", encoding: "utf-8" });
    const latest = this.getOptions();
    if (latest.repoUrl !== requested.repoUrl || latest.branch !== requested.branch || latest.token !== requested.token) throw new Error("仓库或 Token 配置在核验期间变化，请重新核验。");
    return { branch, login, repository: `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}` };
  }

  async createPrivateRepository(name: string): Promise<{ url: string; branch: string }> {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error("仓库名称只能包含英文、数字、点、下划线或短横线。");
    await this.verifyToken();
    const repo = await this.json("/user/repos", readRepo, "POST", { name, private: true, auto_init: true });
    if (!repo.private || !repo.clone_url) throw new Error("未能确认新仓库的私人状态，请到 GitHub 检查创建结果。");
    return { url: parseGithubRepoUrl(repo.clone_url).url, branch: repo.default_branch || "" };
  }

  private binding(branch: string): string { const repo = this.repo(); return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${branch}`; }

  async bind(verified?: VerifiedAccess | RemoteSnapshot): Promise<VerifiedAccess | RemoteSnapshot> {
    if (this.running) throw new Error("正在检查缓存或执行同步，请稍后再绑定仓库。");
    await this.load();
    if (this.state.pending || this.state.downloadVerification || this.state.localRecheck) throw new Error("还有未完成同步或下载验证，请先用原仓库恢复，再更换绑定。");
    const remote = verified ?? await this.verifyAccess();
    const repo = this.repo();
    if ("repository" in remote && remote.repository !== `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`) throw new Error("仓库地址已变化，请重新核验接入。");
    if (this.getOptions().branch && this.getOptions().branch !== remote.branch) throw new Error("分支已变化，请重新核验接入。");
    const binding = this.binding(remote.branch);
    const previous = this.state;
    if (this.state.binding !== binding) this.state = newLocalState(binding);
    try { await this.save(); }
    catch (error) { this.state = previous; throw error; }
    return remote;
  }

  async restartSetup(clearBaseline = false): Promise<boolean> {
    if (this.running) throw new Error("正在检查缓存或执行同步，请等待任务停止后重新接入。");
    this.running = true;
    try {
      await this.savePromise;
      // Wait for a guide's initial state read before replacing its snapshot.
      await this.loadPromise?.catch(() => undefined);
      let previous = this.state;
      const complete = (state: StoredState): boolean => state?.schema === 1 &&
        typeof state.binding === "string" && !!state.binding &&
        typeof state.baseCommitSha === "string" && !!state.baseCommitSha &&
        !!state.base && typeof state.base === "object" && !Array.isArray(state.base) &&
        Object.values(state.base).every(entry => !!entry && typeof entry.sha === "string" && !!entry.sha &&
          (entry.mode === "100644" || entry.mode === "100755"));
      if (!this.loaded) {
        previous = newLocalState();
        for (const path of [this.statePath, this.recoveryPath, this.statePath.replace("sync-api-local", "link-state"), this.recoveryPath.replace("sync-api-local", "link-state")]) {
          if (!await this.adapter.exists(path)) continue;
          const source = await this.adapter.read(path);
          let candidate: StoredState;
          try { const raw = JSON.parse(source) as Record<string, unknown>; candidate = (raw.state ?? raw) as StoredState; }
          catch (error) { if (error instanceof SyntaxError) continue; throw error; }
          if (complete(candidate)) { previous = candidate; break; }
        }
      }
      const preserved = !clearBaseline && complete(previous);
      const next: StoredState = newLocalState(clearBaseline ? previous.binding : preserved ? previous.binding : "");
      if (preserved) {
        next.base = previous.base;
        next.baseCommitSha = previous.baseCommitSha;
        next.baseScope = previous.baseScope;
      }
      // A partial download must not turn missing files into inferred deletions.
      next.rejoinReview = true;
      next.revision = (Number.isFinite(previous.revision) ? previous.revision : 0) + 1;
      const original = this.state;
      this.state = next;
      try { await this.save(); }
      catch (error) { this.state = original; throw error; }
      this.loaded = true;
      this.deferredEvents = [];
      this.resetRemaining();
      return preserved;
    } finally { this.running = false; }
  }

  async refreshCache(force = false): Promise<{ files: number; seconds: number }> {
    await this.load();
    await this.refreshRules();
    if (this.running || this.state.pending || this.state.downloadVerification || this.state.localRecheck) throw new Error("同步执行或下载验证期间不能重新建立缓存。");
    this.running = true;
    const started = performance.now();
    try {
      const current = await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, force, this.progress);
      await this.save();
      return { files: Object.keys(current).length, seconds: (performance.now() - started) / 1000 };
    } finally { this.running = false; }
  }

  async changes(): Promise<ReturnType<typeof linkDiff>> {
    await this.load();
    await this.refreshRules();
    if (this.running) return [];
    this.running = true;
    try {
      const current = await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, false);
      const base = this.filteredBase();
      await this.save();
      return linkDiff(base, current, this.getOptions().trackPaths ? this.state.paths : newPathRecords());
    } finally { this.running = false; }
  }

  cachedChanges(paths: readonly string[]): ReturnType<typeof linkDiff> {
    const base = this.filteredBase();
    const current: Manifest = {};
    const visible = new Set(paths);
    // Obsidian's in-memory file list omits hidden files and directories. Keep
    // those cached entries until the sync scan verifies them.
    for (const path of Object.keys(this.state.cache)) if (path.startsWith(`${this.configDir}/`) || path.split("/").some(part => part.startsWith("."))) visible.add(path);
    for (const path of visible) {
      if (!this.allowed(path)) continue;
      const entry = this.state.cache[path] ?? base[path];
      current[path] = entry ? { sha: entry.sha, rawSha: entry.rawSha, mode: entry.mode }
        : { sha: "unverified", mode: "100644" };
      // Event records mark candidates only. Hash verification remains in the
      // scheduled cache task and sync, never in a sidebar refresh.
      if (this.state.dirty[path]) current[path] = { sha: `unverified:${this.state.dirty[path]}`, mode: current[path].mode };
    }
    return linkDiff(base, current, this.getOptions().trackPaths ? this.state.paths : newPathRecords());
  }

  private filteredBase(): Manifest {
    return Object.fromEntries(Object.entries(this.state.localRecheck?.base ?? this.state.base).filter(([path]) => this.allowed(path)));
  }

  private planContext(): string {
    return JSON.stringify([this.state.binding, this.state.baseCommitSha, this.state.baseScope, this.state.base,
      this.state.rejoinReview, this.state.downloadVerification, this.state.localRecheck, this.getOptions().trackPaths, this.state.paths]);
  }

  private assertSnapshot(snapshot?: PreviewSnapshot): asserts snapshot is PreviewSnapshot {
    if (snapshot && snapshot === this.previewSnapshot && snapshot.scope === this.scope() && snapshot.revision !== this.state.revision) throw new LocalSyncEdit();
    if (!snapshot || snapshot !== this.previewSnapshot || !this.getOptions().bound ||
        snapshot.revision !== this.state.revision || snapshot.scope !== this.scope() || snapshot.context !== this.planContext()) {
      throw new Error("选择期间状态发生变化或预览已过期，请重新同步并选择。");
    }
  }

  private reportPlan(plan: MobilePlan): void {
    const count = new Set([...plan.uploads, ...plan.downloads, ...plan.localDeletes, ...plan.remoteDeletes]).size;
    this.progress(`待同步 ${count} 个文件 · 准备上传 ${plan.uploads.length} 个${plan.conflicts.length ? ` · 待确认差异 ${plan.conflicts.length} 项` : ""}`);
  }

  async recalculate(plan: MobilePlan, choices: Record<string, ConflictChoice>): Promise<MobilePlan> {
    await this.assertRulesUnchanged();
    if (this.running) throw new Error("本地缓存正在检查，请稍后重试。");
    this.running = true;
    const timing = this.activeTiming = this.timingEnabled() ? new OperationTiming() : undefined;
    let failed = false;
    try {
      timing?.stage("差异计算");
      const snapshot = plan[PREVIEW_SNAPSHOT];
      this.assertSnapshot(snapshot);
      const next = await this.calculatePlan(snapshot, choices);
      if (timing) timing.files("差异计算", Object.keys(next.desired).length);
      this.assertSnapshot(snapshot);
      this.reportPlan(next);
      await this.assertRulesUnchanged();
      return next;
    } catch (error) { failed = true; throw error; }
    finally {
      await this.finishTiming("轻量重算耗时", timing, failed);
      this.activeTiming = undefined; this.running = false;
    }
  }

  async preview(choices: Record<string, ConflictChoice> = {}): Promise<MobilePlan> {
    await this.load();
    await this.refreshRules();
    if (!this.getOptions().bound) throw new Error("请先完成手机端 Token、仓库与同步范围引导。");
    if (this.running) throw new Error("本地缓存正在检查，请稍后重试。");
    this.running = true;
    this.previewSnapshot = undefined;
    const timing = this.activeTiming = this.timingEnabled() ? new OperationTiming() : undefined;
    let failed = false;
    try {
      timing?.stage("预览恢复");
      if (this.downloadTask) throw new Error("还有下载待办，请从同步面板上方的红色提醒继续处理。");
      await this.recover();
      if (this.state.downloadVerification && this.state.downloadVerification.scope !== this.scope()) {
        throw new Error("下载验证尚未完成，请恢复原同步范围后继续；不会将缺失文件视为删除。");
      }
      const revision = this.state.revision, scope = this.scope(), context = this.planContext();
      this.progress("正在读取 GitHub 文件树…");
      timing?.stage("读取远端");
      const remote = await this.remote(true);
      const recheck = this.state.localRecheck;
      if (recheck) {
        const renamed: Record<string, string> = {};
        for (const [origin, targets] of Object.entries(recheck.identityTargets)) {
          if (targets.length === 1) renamed[origin] = remote.renames[targets[0]] ?? targets[0];
        }
        for (const [origin, target] of Object.entries(remote.renames)) if (!(origin in renamed)) renamed[origin] = target;
        remote.renames = renamed;
      }
      if (timing) timing.files("读取远端", Object.keys(remote.files).length);
      if (this.state.binding !== this.binding(remote.branch)) throw new Error("仓库或分支已变化，请重新绑定；旧基准不会被复用。");
      timing?.stage("扫描本地");
      const local = await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, false, this.progress, new Set(), this.filteredBase());
      if (timing) timing.files("扫描本地", Object.keys(local).length);
      // Retain the completed local check even if review or upload later fails.
      // This does not change the last successfully aligned baseline.
      timing?.stage("保存缓存");
      await this.save();
      timing?.stage("差异计算");
      const snapshot: PreviewSnapshot = {
        remote: { ...remote, files: copyManifest(remote.files), renames: { ...remote.renames }, plugins: [...remote.plugins] },
        local: copyManifest(local), base: copyManifest(this.filteredBase()),
        paths: { moves: { ...(this.getOptions().trackPaths ? this.state.paths.moves : {}) } },
        revision, scope, context, baseCommitSha: this.state.localRecheck?.commit ?? this.state.baseCommitSha, rejoinReview: !!this.state.rejoinReview, rechecking: !!this.state.localRecheck,
        downloading: copyManifest(this.state.downloadVerification?.files ?? {})
      };
      this.previewSnapshot = snapshot;
      this.assertSnapshot(snapshot);
      const plan = await this.calculatePlan(snapshot, choices);
      if (timing) timing.files("差异计算", Object.keys(plan.desired).length);
      this.assertSnapshot(snapshot);
      this.reportPlan(plan);
      return plan;
    } catch (error) { failed = true; throw error; }
    finally {
      await this.finishTiming("轻量比对耗时", timing, failed);
      this.activeTiming = undefined; this.running = false;
    }
  }

  private async calculatePlan(snapshot: PreviewSnapshot, decisions: Record<string, ConflictChoice>): Promise<MobilePlan> {
      const choices = Object.fromEntries(Object.entries(decisions).map(([id, decision]) => [id, { ...decision }]));
      const remote = { ...snapshot.remote, files: copyManifest(snapshot.remote.files),
        renames: { ...snapshot.remote.renames }, plugins: [...snapshot.remote.plugins] };
      const local = copyManifest(snapshot.local), base = snapshot.base;
      const remoteRenames = remote.renames;
      const mergedContents: Record<string, string> = {};
      const mergedEntries: Record<string, FileEntry> = {};
      for (const [id, decision] of Object.entries(choices)) if (decision.choice === "manual") {
        if (decision.text === undefined) throw new Error("手工合并内容为空缺，请重新选择。");
        const text = decision.text.replace(/\r\n/g, "\n");
        const sha = await blobSha(new TextEncoder().encode(text));
        mergedContents[sha] = text;
        mergedEntries[id] = { sha, mode: "100644" };
      }
      const desired: Manifest = {}; const conflicts: MobileConflict[] = [];
      const identityTargets: Record<string, string[]> = {}; let identity: string | undefined;
      const put = (side?: Side): void => {
        if (!side) return;
        if (desired[side.path]) {
          throw new Error(`目标路径被不同文件占用：${side.path}。请先调整名称，再重新预览。`);
        }
        if (identity) identityTargets[identity].push(side.path);
        const existing = remote.files[side.path];
        desired[side.path] = { sha: sameContent(side, existing) ? existing.sha : side.sha, mode: side.mode };
      };
      const choose = (conflict: MobileConflict): void => {
        const decision = choices[conflict.id];
        if (!decision) { conflicts.push(conflict); return; }
        if (decision.choice === "delete") {
          if (!["unpaired", "delete", "duplicate"].includes(conflict.kind) && !(conflict.kind === "path" && sameContent(conflict.local, conflict.remote))) throw new Error("内容差异不能按文件批量删除，请重新选择。");
          return;
        }
        if (decision.choice === "manual") {
          if (!["content", "initial"].includes(conflict.kind)) throw new Error("请先按文件选择路径或删除方案。");
          put({ ...mergedEntries[conflict.id], mode: conflict.local?.mode ?? conflict.remote?.mode ?? "100644",
            path: conflict.targetPath ?? conflict.local!.path, source: "local" });
          return;
        }
        if (decision.choice === "both") {
          if (conflict.kind !== "duplicate") throw new Error("该项目不能保留两个版本，请重新选择。");
          const files = [...conflict.localFiles!, ...conflict.remoteFiles!];
          for (const side of files) if (!desired[side.path]) put(side);
          return;
        }
        const files = decision.choice === "local" ? conflict.localFiles : conflict.remoteFiles;
        if (files) { for (const side of files) put(side); return; }
        const side = decision.choice === "local" ? conflict.local : conflict.remote;
        put(side && conflict.targetPath ? { ...side, path: conflict.targetPath } : side);
      };
      const sideAt = (files: Manifest, path: string | null, source: "local" | "remote"): Side | undefined =>
        path && files[path] ? { ...files[path], path, source } : undefined;
      const same = (a?: Side, b?: Side): boolean => (!a && !b) || !!a && !!b && a.path === b.path && a.mode === b.mode && sameContent(a, b);
      const records = snapshot.paths;
      const lMap = identityPaths(base, local, records.moves, false);
      const rMap = identityPaths(base, remote.files, remoteRenames);
      const claimedLocal = new Set(Object.values(lMap)); const claimedRemote = new Set(Object.values(rMap));
      for (const path of Object.keys(base)) {
        identity = path; identityTargets[path] = [];
        const b: Side = { ...base[path], path, source: "remote" };
        const l = sideAt(local, lMap[path], "local"); const r = sideAt(remote.files, rMap[path], "remote");
        if (snapshot.rechecking) {
          const extraLocal = r && !claimedLocal.has(r.path) ? sideAt(local, r.path, "local") : undefined;
          const extraRemote = l && !claimedRemote.has(l.path) ? sideAt(remote.files, l.path, "remote") : undefined;
          if (extraLocal || extraRemote) {
            const locals = [...new Map([l, extraLocal].filter((side): side is Side => !!side).map(side => [side.path, side])).values()];
            const remotes = [...new Map([r, extraRemote].filter((side): side is Side => !!side).map(side => [side.path, side])).values()];
            locals.forEach(side => claimedLocal.add(side.path)); remotes.forEach(side => claimedRemote.add(side.path));
            choose({ id: "base:" + path, label: path, kind: "path", base: b, local: extraLocal ?? l, remote: extraRemote ?? r, localFiles: locals, remoteFiles: remotes });
            continue;
          }
        }
        if (snapshot.rejoinReview && (!!l !== !!r)) choose({ id: `base:${path}`, label: path, kind: "delete", base: b, local: l, remote: r });
        else if (!l && r && snapshot.downloading[r.path] && !records.moves[path]) put(r);
        else if (same(l, r)) put(l);
        else if (same(l, b)) put(r);
        else if (same(r, b)) put(l);
        else if (!l || !r) choose({ id: `base:${path}`, label: path, kind: "delete", base: b, local: l, remote: r });
        else {
          const target = l.path === r.path ? l.path : l.path === path ? r.path : r.path === path ? l.path : undefined;
          if (!target) choose({ id: `base:${path}`, label: path, kind: "path", base: b, local: l, remote: r });
          else if (sameContent(l, r)) put({ ...l, mode: l.mode === b.mode ? r.mode : l.mode, path: target });
          else if (sameContent(l, b)) put({ ...r, path: target });
          else if (sameContent(r, b)) put({ ...l, path: target });
          else choose({ id: `base:${path}`, label: path, kind: "content", targetPath: target, base: b, local: l, remote: r });
        }
      }
      identity = undefined;
      const additions = new Set([...Object.keys(local).filter((p) => !claimedLocal.has(p)),
        ...Object.keys(remote.files).filter((p) => !claimedRemote.has(p))]);
      if (!snapshot.baseCommitSha) {
        // Identical paths need no choice, including canonical LF/CRLF matches.
        // Keep cloud metadata and its existing blob; no transfer is necessary.
        for (const path of [...additions]) {
          if (local[path] && remote.files[path] && sameContent(local[path], remote.files[path])) {
            put(sideAt(remote.files, path, "remote"));
            additions.delete(path);
          }
        }
        const localHashes = new Map<string, Side[]>(), remoteHashes = new Map<string, Side[]>();
        const remoteShas = new Set(Object.values(remote.files).map(f => f.sha));
        for (const [files, hashes, source] of [[local, localHashes, "local"], [remote.files, remoteHashes, "remote"]] as const) {
          const other = source === "local" ? remote.files : local;
          for (const path of additions) if (files[path] && (!other[path] || sameContent(other[path], files[path]))) {
            const hash = source === "local" && files[path].rawSha && remoteShas.has(files[path].rawSha)
              ? files[path].rawSha : files[path].sha;
            const group = hashes.get(hash) ?? [];
            group.push({ ...files[path], path, source }); hashes.set(hash, group);
          }
        }
        for (const [sha, locals] of localHashes) {
          const remotes = remoteHashes.get(sha);
          if (!remotes) continue;
          choose({ id: `hash:${sha}`, label: locals.length === 1 && remotes.length === 1
            ? locals[0].path : `相同内容 · ${new Set([...locals, ...remotes].map(s => s.path)).size} 个路径`,
            kind: "duplicate", local: locals[0], remote: remotes[0], localFiles: locals, remoteFiles: remotes });
          for (const side of [...locals, ...remotes]) {
            // Only remove the paired side; a different version at the same path still needs review.
            if (!local[side.path] || !remote.files[side.path] || sameContent(local[side.path], remote.files[side.path])) additions.delete(side.path);
          }
        }
      }
      for (const path of additions) {
        const l = !claimedLocal.has(path) ? sideAt(local, path, "local") : undefined;
        const r = !claimedRemote.has(path) ? sideAt(remote.files, path, "remote") : undefined;
        if (!l && r && snapshot.downloading[path]) put(r);
        else if (l && r && !sameContent(l, r)) choose({ id: `new:${path}`, label: path, kind: "initial", local: l, remote: r });
        else if ((!snapshot.baseCommitSha || snapshot.rejoinReview) && (!!l !== !!r)) {
          choose({ id: `new:${path}`, label: path, kind: "unpaired", local: l, remote: r });
        } else put(l ?? r);
      }
      const conflictedLocal = new Set(conflicts.flatMap(c => c.localFiles?.map(s => s.path) ?? (c.local ? [c.local.path] : [])));
      const conflictedRemote = new Set(conflicts.flatMap(c => c.remoteFiles?.map(s => s.path) ?? (c.remote ? [c.remote.path] : [])));
      const plan: MobilePlan = { [PREVIEW_SNAPSHOT]: snapshot, remote, local, desired, conflicts, revision: snapshot.revision,
        pendingChoices: choices, remoteRenames, paths: { moves: { ...records.moves } }, scope: snapshot.scope, mergedContents, identityTargets,
        uploads: Object.keys(desired).filter((p) => desired[p].sha !== remote.files[p]?.sha || desired[p].mode !== remote.files[p]?.mode),
        downloads: Object.keys(desired).filter((p) => !sameContent(desired[p], local[p])),
        localDeletes: Object.keys(local).filter((p) => !desired[p] && !conflictedLocal.has(p)),
        remoteDeletes: Object.keys(remote.files).filter((p) => !desired[p] && !conflictedRemote.has(p)) };
      return plan;
  }

  async content(side: Side): Promise<string> {
    const bytes = side.source === "local" ? new Uint8Array(await this.adapter.readBinary(side.path)) : await this.getBlob(side.sha);
    if (bytes.length > 200000) return "文件超过 200 KB，预览已省略。请在原文件中检查内容。";
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return text.includes("\0") ? "二进制文件，不提供文本预览。" : text;
    } catch { return "二进制文件，不提供文本预览。"; }
  }

  async reviewText(side: Side): Promise<string | null> {
    const bytes = side.source === "local" ? new Uint8Array(await this.adapter.readBinary(side.path)) : await this.getBlob(side.sha);
    if (await blobSha(bytes) !== (side.rawSha ?? side.sha)) throw new Error("预览文件已变化，请重新同步预览。");
    if (bytes.length > 200000) return null;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(syncBytes(bytes));
      return text.includes("\0") ? null : text;
    } catch { return null; }
  }

  async reviewImage(side: Side): Promise<ReviewImage> {
    const scope = this.scope();
    const size = side.source === "local" ? (await this.adapter.stat(side.path))?.size : this.blobSizes.get(side.sha);
    if (size === undefined || size > reviewImageLimit) throw new Error("图片大小未知或超过 5 MB，已省略预览。");
    if (scope !== this.scope()) throw new Error("仓库或同步范围已变化，请重新核对。");
    const bytes = side.source === "local" ? new Uint8Array(await this.adapter.readBinary(side.path)) : await this.getBlob(side.sha);
    if (scope !== this.scope()) throw new Error("仓库或同步范围已变化，请重新核对。");
    if (await blobSha(bytes) !== (side.rawSha ?? side.sha)) throw new Error("图片版本已变化，请重新核对文件。");
    return reviewImage(bytes);
  }

  private async getBlob(sha: string): Promise<Uint8Array> {
    const bytes = await this.api(`${this.repo().prefix}/git/blobs/${sha}`, "GET", undefined, true);
    if (!(bytes instanceof Uint8Array)) throw new Error("GitHub 文件响应格式错误，已停止同步。");
    if (await blobSha(bytes) !== sha) throw new Error("云端文件校验失败，已停止写入。");
    return bytes;
  }

  private async liveSha(path: string): Promise<string | null> {
    const stat = await this.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== "file") throw new Error(`目标位置被文件夹占用：${path}`);
    try { return await blobSha(new Uint8Array(await this.adapter.readBinary(path))); }
    catch (error) { if (!await this.adapter.stat(path)) return null; throw error; }
  }

  requiresPluginReload(plan: MobilePlan): boolean {
    const prefix = this.configDir + "/plugins/" + this.pluginId + "/";
    return [...plan.downloads, ...plan.localDeletes].some(path =>
      ["main.js", "manifest.json", "styles.css"].some(name => path === prefix + name));
  }

  async execute(plan: MobilePlan): Promise<void> {
    await this.refreshRules();
    if (plan.conflicts.length) throw new Error("仍有未选择的冲突，未执行同步。");
    if (this.running) throw new Error("本地缓存正在检查，请稍后重试。");
    if (this.state.pending) throw new Error("还有未完成的下载或验证，请先重新预览以恢复同步；尚未确认新基准。");
    this.running = true;
    const timing = this.activeTiming = this.timingEnabled() ? new OperationTiming() : undefined;
    if (timing) {
      timing.files("复核本地", Object.keys(plan.local).length);
      timing.files("上传准备与写树", plan.uploads.length + plan.remoteDeletes.length);
      timing.files("下载与落盘", plan.downloads.length + plan.localDeletes.length);
      timing.files("结果验证", plan.downloads.length + plan.localDeletes.length);
    }
    let failed = false;
    try {
      timing?.stage("核对远端");
      const remoteRemaining = new Set([...plan.uploads, ...plan.remoteDeletes]);
      const localRemaining = new Set([...plan.downloads, ...plan.localDeletes]);
      let prepared = 0;
      const report = (_stage: string): void => {
        const remaining = new Set([...remoteRemaining, ...localRemaining]).size;
        this.progress(`待同步 ${remaining} 个文件 · 准备上传 ${plan.uploads.length - prepared} 个`);
      };
      report("正在核对同步计划");
      this.assertSnapshot(plan[PREVIEW_SNAPSHOT]);
      await this.assertRulesUnchanged();
      if (plan.scope !== this.scope()) throw new Error("同步范围或仓库设置已变化，请重新预览。");
      if (this.state.revision !== plan.revision) throw new LocalSyncEdit();
      const repo = this.repo();
      const head = await this.json(`${repo.prefix}/git/ref/heads/${encodeURIComponent(plan.remote.branch)}`, value => ({ object: readSha(apiObject(value).object) }));
      if (head.object.sha !== plan.remote.commit) throw new Error("预览后云端出现新提交，请重新预览。");
      // Detect external edits and new/deleted files before any remote mutation.
      timing?.stage("复核本地");
      const live = await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, false, this.progress);
      await this.save();
      this.assertSnapshot(plan[PREVIEW_SNAPSHOT]);
      if (JSON.stringify(Object.entries(live).map(([p,e]) => [p,e.sha]).sort()) !==
          JSON.stringify(Object.entries(plan.local).map(([p,e]) => [p,e.sha]).sort())) throw new LocalSyncEdit();
      timing?.stage("上传准备与写树");
      const localBySha = new Map(Object.entries(plan.local).map(([path, entry]) => [entry.sha, path]));
      const entries: ApiObject[] = plan.remoteDeletes.map((path) => ({ path, mode: plan.remote.files[path].mode, type: "blob", sha: null }));
      const known = new Set([...Object.values(plan.remote.files), ...Object.values(this.state.base)].map((e) => e.sha));
      // Text is batched by byte budget; binary gets an individual blob request.
      let batch: ApiObject[] = []; let batchBytes = 0; let treeSha = plan.remote.tree;
      const flush = async (): Promise<void> => {
        if (!batch.length) return;
        report("正在分批上传云端内容");
        const tree = await this.json(`${repo.prefix}/git/trees`, readSha, "POST", { base_tree: treeSha, tree: batch });
        treeSha = tree.sha; batch = []; batchBytes = 0;
      };
      for (const entry of entries) {
        batch.push(entry);
        if (batch.length >= 500) await flush();
      }
      report("正在准备上传内容");
      for (let i = 0; i < plan.uploads.length; i++) {
        const path = plan.uploads[i]; const target = plan.desired[path];
        const item: ApiObject = { path, mode: target.mode, type: "blob" };
        if (known.has(target.sha)) item.sha = target.sha;
        else {
          const sourcePath = localBySha.get(target.sha);
          const merged = plan.mergedContents[target.sha];
          if (!sourcePath && merged === undefined) throw new Error("无法找到待上传内容，请重新预览。");
          const bytes = merged !== undefined ? new TextEncoder().encode(merged) : syncBytes(new Uint8Array(await this.adapter.readBinary(sourcePath!)));
          if (await blobSha(bytes) !== target.sha) throw new LocalSyncEdit();
          let text: string | null = null;
          try { const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); if (!decoded.includes("\0")) text = decoded; } catch { /* Non-UTF-8 content is uploaded as a binary blob. */ }
          // Budget uses serialized UTF-8 JSON to account for escaping.
          if (text !== null && bytes.length <= 512000) {
            item.content = text;
            const size = new TextEncoder().encode(JSON.stringify(item)).length;
            if (batchBytes + size > 1024000) await flush();
            batchBytes += size;
          } else {
            report("正在上传独立文件内容");
            const blob = await this.json(`${repo.prefix}/git/blobs`, readSha, "POST", { content: encodeBase64(bytes), encoding: "base64" });
            if (blob.sha !== target.sha) throw new Error("上传内容校验失败。");
            item.sha = blob.sha; known.add(blob.sha);
          }
        }
        batch.push(item);
        if (batch.length >= 500) await flush();
        prepared = i + 1;
        report("正在准备上传内容");
      }
      await flush();
      if (this.state.revision !== plan.revision) throw new LocalSyncEdit();
      const actions: LocalAction[] = [
        ...plan.downloads.map((path) => ({ path, sha: plan.desired[path].sha, expected: plan.local[path]?.rawSha ?? plan.local[path]?.sha ?? null,
          size: this.blobSizes.get(plan.desired[path].sha) })),
        ...plan.localDeletes.map((path) => ({ path, sha: null, expected: plan.local[path].rawSha ?? plan.local[path].sha }))
      ];
      let commitSha = plan.remote.commit;
      if (treeSha !== plan.remote.tree) {
        timing?.stage("创建提交");
        report("正在生成云端版本");
        const commit = await this.json(`${repo.prefix}/git/commits`, readSha, "POST", {
          message: `同步与分享 mobile sync ${new Date().toISOString()}`, tree: treeSha, parents: [plan.remote.commit]
        });
        commitSha = commit.sha;
      }
      await this.assertRulesUnchanged();
      if (plan.scope !== this.scope()) throw new Error("上传准备期间同步范围已变化，请重新预览。");
      timing?.stage("保存恢复记录");
      const previousTransaction = { pending: this.state.pending, downloadVerification: this.state.downloadVerification };
      this.state.pending = { commit: commitSha, parent: plan.remote.commit, base: plan.desired, actions,
        revision: plan.revision, paths: plan.paths, scope: plan.scope, comparisonBase: this.state.localRecheck?.base, identityTargets: plan.identityTargets, receipts: {} };
      this.state.downloadVerification = { phase: "downloading", scope: plan.scope, commit: commitSha,
        files: Object.fromEntries(plan.downloads.map(path => [path, plan.desired[path]])) };
      try { await this.save(); } catch (error) { Object.assign(this.state, previousTransaction); throw error; }
      report("正在确认云端更新");
      if (commitSha !== plan.remote.commit) {
        await this.assertRulesUnchanged();
        timing?.stage("更新分支");
        await this.api(`${repo.prefix}/git/refs/heads/${encodeURIComponent(plan.remote.branch)}`,
          "PATCH", { sha: commitSha, force: false });
      }
      remoteRemaining.clear();
      if (this.state.pending.transfer) {
        this.progress(`云端更新已确认 · ${plan.downloads.length} 个文件待下载 · 待办已保存`);
        return;
      }
      await this.applyPending((path) => {
        if (path) localRemaining.delete(path);
        report("正在应用本地同步结果");
      });
    } catch (error) { failed = true; throw error; }
    finally {
      await this.finishTiming("轻量执行耗时", timing, failed);
      this.activeTiming = undefined; this.running = false;
    }
  }

  private async recover(): Promise<void> {
    const pending = this.state.pending;
    if (!pending) return;
    this.progress("检测到未完成的下载或验证 · 正在恢复同步，保留原共同基准…");
    this.activeTiming?.stage("核对远端");
    const remote = await this.remote();
    if (this.state.binding !== this.binding(remote.branch)) throw new Error("未完成事务属于其他仓库，不能切换绑定。");
    if (remote.commit !== pending.commit) {
      if (remote.commit === pending.parent && pending.commit !== pending.parent) {
        if (pending.transfer) {
          pending.transfer.reviewRequired = true;
          await this.save();
          throw new Error("上传未被云端接受，待办已保留；请点击「重新检查同步」。");
        }
        this.state.pending = undefined; this.state.downloadVerification = undefined; await this.save();
        return;
      }
      const diff = await this.json(`${this.repo().prefix}/compare/${pending.commit}...${remote.commit}`, readCompare);
      if (!["ahead", "identical"].includes(diff.status)) throw new Error("未完成提交与远端历史不一致，请保留本机状态并检查仓库。");
    }
    // Per-path receipts protect edits while independent actions continue.
    if (pending.transfer && pending.transfer.mode !== "automatic") return;
    await this.applyPending();
  }

  async resetDownloadProgress(): Promise<void> {
    await this.load();
    if (!this.downloadTask) throw new Error("没有待重置的下载进度。");
    // restartSetup preserves the last completed baseline and all actual files.
    await this.restartSetup();
    const folder = `${this.statePath}.archive`;
    try { if (await this.adapter.exists(folder)) await this.adapter.rmdir(folder, true); }
    catch { console.warn("旧下载暂存区未能清理。"); }
    this.progress("下载进度已重置 · 已上传与新修改的文件保留 · 请重新预览同步");
  }

  async resumeAutomaticDownload(): Promise<void> {
    await this.load();
    await this.refreshRules();
    if (this.running) throw new Error("正在同步，请稍后再操作。");
    if (!this.downloadTask) throw new Error("没有待处理的下载。");
    this.running = true;
    const expectedCommit = this.state.pending!.commit;
    const timing = this.activeTiming = this.timingEnabled() ? new OperationTiming() : undefined;
    if (timing) {
      const count = this.state.pending!.actions.length;
      timing.files("复核本地", count);
      timing.files("下载与落盘", count);
      timing.files("结果验证", count);
    }
    let failed = false;
    try {
      timing?.stage("保存恢复记录");
      if (this.state.pending!.scope !== this.scope()) throw new Error("同步范围已变化，请恢复原范围再继续下载。");
      this.downloadTask.mode = "automatic";
      await this.save();
      await this.recover();
      timing?.stage("结果验证");
      if (this.state.pending) throw new Error("下载未完成，待办与原基准已保留。");
      if (!this.needsLocalRecheck && this.state.baseCommitSha !== expectedCommit) throw new Error("两端状态发生变化，请重新预览同步；本地新修改已保留。");
    } catch (error) { failed = true; throw error; }
    finally {
      await this.finishTiming("轻量恢复耗时", timing, failed);
      this.activeTiming = undefined; this.running = false;
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/"); parts.pop(); let current = "";
    for (const part of parts) { current = current ? `${current}/${part}` : part; if (!await this.adapter.exists(current)) await this.adapter.mkdir(current); }
  }

  private async applyPending(onApplied?: (path?: string) => void): Promise<void> {
    await this.assertRulesUnchanged(); const pending = this.state.pending!;
    const assertScope = (): void => { if (pending.scope !== this.scope()) throw new Error("未完成同步的仓库、分支或范围已变化，已保留待办与原基准；请恢复原配置后继续。"); };
    assertScope(); await this.save();
    const uncertainWrites = pending.writesStarted === true;
    const receipts = pending.receipts ??= {}, actions = new Map(pending.actions.map(action => [action.path, action]));
    const comparison = pending.comparisonBase ?? this.state.localRecheck?.base ?? this.state.base;
    const legacyTargets = !pending.identityTargets ? pending.actions.filter(action => action.sha !== null && !comparison[action.path]).map(action => action.path) : [];
    const legacyOrigins = new Set(!pending.identityTargets && legacyTargets.length ? pending.actions.filter(action => action.sha === null && comparison[action.path] && !pending.base[action.path]).map(action => action.path) : []);
    let legacyAmbiguous = false;
    const edges = new Map<string, Set<string>>();
    const connect = (paths: string[]): void => { for (const path of paths) { const linked = edges.get(path) ?? new Set<string>(); paths.forEach(other => linked.add(other)); edges.set(path, linked); } };
    for (const origin of legacyOrigins) connect([origin, ...legacyTargets]);
    for (const [origin, targets] of Object.entries(pending.identityTargets ?? {})) connect([origin, ...targets]);
    for (const [origin, target] of Object.entries(pending.paths.moves)) connect([origin, target]);
    for (const [origin, target] of Object.entries(this.state.paths.moves)) if (edges.has(origin)) connect([origin, target]);
    const component = (path: string): Set<string> => { const found = new Set([path]); for (const next of found) for (const linked of edges.get(next) ?? []) found.add(linked); return found; };
    const movedDuring = (path: string): boolean => {
      const linked = component(path);
      return Object.entries(this.state.paths.moves).some(([origin, target]) => linked.has(origin) && target !== (pending.paths.moves[origin] ?? origin));
    };
    const protectedPaths = new Set<string>(), observed = new Map<string, string | null>();
    const initialDirty = new Map(pending.actions.map(action => [action.path, this.state.dirty[action.path]]));
    const firstObserved = new Map<string, string | null>();
    const protectDeletion = (action: LocalAction, current: string | null): boolean => action.sha === null && current === null && !receipts[action.path]?.applied &&
      (movedDuring(action.path) || protectedPaths.has(action.path) || legacyOrigins.has(action.path) ||
        (pending.identityTargets?.[action.path]?.some(target => target !== action.path) ?? false) &&
        (firstObserved.get(action.path) !== null || initialDirty.get(action.path) !== this.state.dirty[action.path] || (this.state.dirty[action.path] ?? 0) > pending.revision));
    let edited = false;
    const protect = (path: string, sha: string | null): void => {
      observed.set(path, sha); edited = true;
      if ([...component(path)].some(linked => legacyOrigins.has(linked))) legacyAmbiguous = true;
      if (!this.state.dirty[path]) noteChange(this.state, sha === null ? "delete" : "modify", path);
      for (const linked of component(path)) if (actions.has(linked)) { protectedPaths.add(linked); const previous = receipts[linked]; receipts[linked] = { applied: previous?.applied ?? false, observed: observed.has(linked) ? observed.get(linked)! : previous?.observed ?? null }; }
      this.progress("检测到同步期间的新修改，正在重新核对…");
    };
    this.activeTiming?.stage("复核本地");
    for (const action of pending.actions) { const current = await this.liveSha(action.path); observed.set(action.path, current); firstObserved.set(action.path, current); }
    for (const action of pending.actions) { const current = observed.get(action.path)!;
      if (uncertainWrites && !receipts[action.path] && current !== action.sha && current !== action.expected) {
        (pending.integrityFailures ??= {})[action.path] = current;
        await this.save();
        throw new Error("上次写入缺少已验证完成记录，当前内容无法安全识别，已保留文件、待办与原基准；请检查并恢复该文件内容后继续。");
      }
      if (pending.integrityFailures && action.path in pending.integrityFailures) {
        if (current !== action.sha && current !== action.expected) throw new Error("上次写入结果未通过校验，已保留文件、待办与原基准；请先检查并恢复该文件内容后继续。");
        delete pending.integrityFailures[action.path];
      } if (current === action.sha && !(protectDeletion(action, current))) receipts[action.path] = { applied: true, observed: current }; else if (receipts[action.path] || current !== action.expected || movedDuring(action.path) || protectDeletion(action, current)) protect(action.path, current); }
    const mutate = async (action: LocalAction, work: () => Promise<void>): Promise<void> => {
      try { await work(); } catch (error) {
        let after: string | null = "unverified";
        try { after = await this.liveSha(action.path); } catch { /* Keep the original I/O failure. */ }
        if (after !== action.expected && after !== action.sha) (pending.integrityFailures ??= {})[action.path] = after;
        throw error;
      }
    };
    // Persist that writes may begin before mutation. Unknown bytes after a crash cannot be laundered into edits.
    pending.writesStarted = true;
    await this.save();
    const remaining = new Set(pending.actions.map(action => action.path));
    const report = (path?: string): void => {
      if (path) remaining.delete(path);
      if (pending.transfer) pending.transfer.completed = pending.actions.filter(action => action.sha !== null && receipts[action.path]?.applied && receipts[action.path]?.observed === action.sha).length;
      if (onApplied) onApplied(path); else this.progress(edited ? "检测到同步期间的新修改，正在重新核对…" : "正在恢复本地同步结果 · 待同步 " + remaining.size + " 个文件");
    };
    report();
    let writing = Promise.resolve(); let failure: { error: unknown } | undefined;
    const localWork = <T>(work: () => Promise<T>): Promise<T> => {
      const task = writing.then(async () => { if (failure) throw failure.error; await this.assertRulesUnchanged(); assertScope(); return work(); });
      writing = task.then(() => undefined, error => { failure ??= { error }; }); return task;
    };
    const parents = new Map(pending.actions.map(action => [action.path, action.path]));
    const root = (path: string): string => { let next = path; while (parents.get(next) !== next) next = parents.get(next)!; return next; };
    const union = (a: string, b: string): void => { parents.set(root(b), root(a)); };
    const bySha = new Map<string, string>();
    for (const action of pending.actions) { if (action.sha) { const previous = bySha.get(action.sha); if (previous) union(previous, action.path); else bySha.set(action.sha, action.path); } for (const linked of component(action.path)) if (parents.has(linked)) union(action.path, linked); }
    const groups = new Map<string, LocalAction[]>();
    for (const action of pending.actions) { const key = root(action.path), group = groups.get(key) ?? []; group.push(action); groups.set(key, group); }
    const applyGroup = async (group: LocalAction[]): Promise<void> => {
      let bytes: Uint8Array | undefined, payloadSha: string | undefined; const sources = new Map<string, string>();
      for (const action of [...group].sort((a,b) => Number(a.sha === null) - Number(b.sha === null))) {
        if (failure) return;
        const current = await localWork(() => this.liveSha(action.path));
        if (current === action.sha && !(protectDeletion(action, current))) { receipts[action.path] = { applied: true, observed: current }; if (action.sha) sources.set(action.sha, action.path); report(action.path); continue; }
        if (protectedPaths.has(action.path) || receipts[action.path]?.applied || current !== action.expected || movedDuring(action.path) || protectDeletion(action, current)) { await localWork(async () => { protect(action.path, current); await this.save(); }); report(action.path); continue; }
        if (action.sha !== null && payloadSha !== action.sha) {
          bytes = undefined; payloadSha = action.sha; const source = sources.get(action.sha);
          if (source) bytes = await localWork(async () => { if (!await this.adapter.exists(source)) return undefined; const copy = new Uint8Array(await this.adapter.readBinary(source)); return await blobSha(copy) === action.sha ? copy : undefined; });
          if (!bytes) { await this.assertRulesUnchanged(); assertScope(); bytes = await this.getBlob(action.sha); }
          if (action.size !== undefined && bytes.length !== action.size) throw new Error("云端文件大小与目录清单不一致，已停止写入。");
        }
        await localWork(async () => {
          if (!this.allowed(action.path)) throw new Error("同步范围已变化，请恢复原范围后继续未完成事务。");
          const before = await this.liveSha(action.path);
          if (before === action.sha && !protectDeletion(action, before)) { receipts[action.path] = { applied: true, observed: before }; return; }
          if (protectedPaths.has(action.path) || before !== action.expected || protectDeletion(action, before)) { protect(action.path, before); await this.save(); return; }
          const beforeStat = await this.adapter.stat(action.path), beforeDirty = this.state.dirty[action.path];
          if (action.sha === null) await mutate(action, () => this.adapter.remove(action.path));
          else { await this.ensureParent(action.path); const latest = await this.liveSha(action.path); if (latest === action.sha) { receipts[action.path] = { applied: true, observed: latest }; return; } if (latest !== action.expected) { protect(action.path, latest); await this.save(); return; } await mutate(action, () => this.adapter.writeBinary(action.path, bytes!.buffer as ArrayBuffer)); }
          // The adapter completed this exact write/delete; a later edit is based on that accepted target.
          receipts[action.path] = { applied: true, observed: action.sha };
          const after = await this.liveSha(action.path), afterStat = await this.adapter.stat(action.path);
          if (after !== action.sha) {
            const changed = beforeDirty !== this.state.dirty[action.path] || beforeStat?.mtime !== afterStat?.mtime || beforeStat?.ctime !== afterStat?.ctime;
            if (after === action.expected && !changed) { delete receipts[action.path]; throw new Error("同步写入结果验证未通过，原基准与待办已保留。"); }
            if (beforeDirty === this.state.dirty[action.path]) { delete receipts[action.path]; (pending.integrityFailures ??= {})[action.path] = after; throw new Error("同步写入结果校验失败，已保留本机内容、待办与原基准。"); }
            protect(action.path, after); await this.save(); return;
          }
          receipts[action.path] = { applied: true, observed: action.sha }; delete this.state.cache[action.path]; if (action.sha) sources.set(action.sha, action.path);
        });
        report(action.path); if (remaining.size % 25 === 0) await localWork(() => this.save());
      }
    };
    this.activeTiming?.stage("下载与落盘");
    const queue = [...groups.values()], active = new Set<Promise<void>>(), budget = 8 * 1024 * 1024; let next = 0, reserved = 0;
    while (next < queue.length || active.size) {
      while (!failure && next < queue.length && active.size < 3) {
        const group = queue[next], sizes = group.filter(action => action.sha !== null).map(action => action.size);
        const weight = sizes.some(size => size === undefined) ? budget : Math.min(budget, Math.max(1, ...sizes as number[])); if (reserved + weight > budget) break;
        next++; reserved += weight;
        const task = applyGroup(group).catch(error => { failure ??= { error }; }).finally(() => { reserved -= weight; active.delete(task); }); active.add(task);
      }
      if (!active.size) break; await Promise.race(active);
    }
    if (failure) { await this.save(); throw failure.error; }
    this.activeTiming?.stage("结果验证"); const verified = new Set<string>();
    for (const action of pending.actions) {
      await this.assertRulesUnchanged(); assertScope(); const stat = await this.adapter.stat(action.path), current = await this.liveSha(action.path);
      if (current !== action.sha || protectDeletion(action, current)) { protect(action.path, current); continue; }
      receipts[action.path] = { applied: true, observed: current };
      if (current === null) { delete this.state.cache[action.path]; verified.add(action.path); continue; }
      const dirty = this.state.dirty[action.path]; let bytes: Uint8Array;
      try { bytes = new Uint8Array(await this.adapter.readBinary(action.path)); }
      catch (error) { if (!await this.adapter.stat(action.path)) { protect(action.path, null); continue; } throw error; }
      const rawSha = await blobSha(bytes);
      const canonical = syncBytes(bytes), sha = canonical === bytes ? rawSha : await blobSha(canonical), after = await this.adapter.stat(action.path);
      if (!stat || !after || rawSha !== action.sha || stat.mtime !== after.mtime || stat.ctime !== after.ctime || stat.size !== after.size || dirty !== this.state.dirty[action.path]) { protect(action.path, rawSha); continue; }
      this.state.cache[action.path] = { sha, rawSha, mode: pending.base[action.path]?.mode ?? "100644", mtime: after.mtime, ctime: after.ctime, size: after.size, verifiedAt: Date.now(), hashVersion: SYNC_HASH_VERSION };
      if (this.state.dirty[action.path] === dirty) delete this.state.dirty[action.path]; verified.add(action.path);
    }
    edited = pending.actions.some(action => !receipts[action.path]?.applied || receipts[action.path]?.observed !== action.sha);
    if (!edited) { try {
      const current = await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, false, message => this.progress("正在完成下载验证 · " + message), verified, pending.base);
      edited = Object.keys(current).length !== Object.keys(pending.base).length || Object.entries(current).some(([path, entry]) => !sameContent(entry, pending.base[path]) || entry.mode !== pending.base[path]?.mode);
    } catch (error) { if (error instanceof LocalSyncEdit) edited = true; else throw error; } }
    for (const action of pending.actions) { const current = await this.liveSha(action.path); if (current !== action.sha) protect(action.path, current); }
    await this.assertRulesUnchanged(); assertScope();
    if (edited && legacyAmbiguous) {
      pending.transfer ??= { mode: "automatic", downloads: pending.actions.filter(action => action.sha !== null).length, total: pending.actions.length, createdAt: Date.now() };
      pending.transfer.reviewRequired = true;
      await this.save();
      throw new Error("旧版恢复记录缺少改名对应信息，已保留本机新修改、待办与原基准；请在下载待办中人工重新检查同步。");
    }
    if (edited) { await this.deferLocalEdits(pending); return; }
    this.activeTiming?.stage("保存基准");
    const previous = { base: this.state.base, baseCommitSha: this.state.baseCommitSha, baseScope: this.state.baseScope, paths: this.state.paths, pending: this.state.pending, downloadVerification: this.state.downloadVerification, rejoinReview: this.state.rejoinReview, localRecheck: this.state.localRecheck };
    this.state.base = pending.base; this.state.baseCommitSha = pending.commit; this.state.baseScope = pending.scope;
    this.state.paths = this.rebasedPaths(pending); this.state.pending = undefined; this.state.downloadVerification = undefined; delete this.state.rejoinReview; delete this.state.localRecheck;
    try { await this.save(); } catch (error) { Object.assign(this.state, previous); throw error; }
    this.progress("同步已对齐 · 下载验证通过 · 待同步 0 个文件 · 新基准已确认");
  }

  private rebasedPaths(pending: PendingTransaction, retained = new Set<string>()): PathRecords {
    const rebased = newPathRecords();
    for (const origin of new Set([...Object.keys(this.state.paths.moves), ...Object.keys(pending.paths.moves)])) { const target = this.state.paths.moves[origin] ?? origin, base = retained.has(origin) ? origin : pending.paths.moves[origin] ?? origin; if (base !== target) rebased.moves[base] = target; }
    return rebased;
  }

  private async deferLocalEdits(pending: PendingTransaction): Promise<void> {
    const comparison = pending.comparisonBase ?? this.state.localRecheck?.base ?? this.state.base, base = copyManifest(pending.base), retained = new Set<string>();
    const identities: Record<string, string[]> = Object.fromEntries(Object.keys(base).map(path => [path,[path]]));
    const unaccepted = new Set(pending.actions.filter(action => !pending.receipts?.[action.path]?.applied).map(action => action.path));
    for (const path of unaccepted) { if (comparison[path]) base[path] = { ...comparison[path] }; else delete base[path]; }
    for (const [origin, targets] of Object.entries(pending.identityTargets ?? {})) if (unaccepted.has(origin) || targets.some(path => unaccepted.has(path))) {
      retained.add(origin); if (comparison[origin]) { base[origin] = { ...comparison[origin] }; identities[origin] = targets; }
      for (const target of targets) if (unaccepted.has(target) && !comparison[target]) { delete base[target]; delete identities[target]; }
    }
    const previous = { pending: this.state.pending, downloadVerification: this.state.downloadVerification, localRecheck: this.state.localRecheck, paths: this.state.paths };
    const orderedIdentities = Object.fromEntries([...retained].filter(origin => !!base[origin]).map(origin => [origin, identities[origin]]));
    for (const [origin, targets] of Object.entries(identities)) if (!(origin in orderedIdentities)) orderedIdentities[origin] = targets;
    this.state.localRecheck = { commit: pending.commit, scope: pending.scope, target: copyManifest(pending.base), base, identityTargets: orderedIdentities, receipts: { ...pending.receipts } };
    this.state.paths = this.rebasedPaths(pending, retained); this.state.pending = undefined; this.state.downloadVerification = undefined;
    try { await this.save(); } catch (error) { Object.assign(this.state, previous); throw error; }
    this.progress("检测到同步期间的新修改，正在重新核对…");
  }

}

function validateLocalRecovery(state: StoredState): void {
  const manifest = (value: unknown): boolean => !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([path, entry]) => {
    safePath(path); return !!entry && typeof entry === "object" && typeof (entry as FileEntry).sha === "string" && ["100644", "100755"].includes((entry as FileEntry).mode);
  });
  const identities = (value: unknown): boolean => !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([path, targets]) => { safePath(path); return Array.isArray(targets) && targets.every(target => typeof target === "string" && !!safePath(target)); });
  const recheck = state.localRecheck;
  if (recheck && (typeof recheck.commit !== "string" || !recheck.commit || typeof recheck.scope !== "string" || !manifest(recheck.base) || !manifest(recheck.target) || !identities(recheck.identityTargets))) throw new Error("本机重新核对记录损坏，已停止覆盖文件。");
  const pending = state.pending;
  if (pending?.identityTargets && !identities(pending.identityTargets)) throw new Error("本机路径恢复记录损坏。");
  if (pending?.comparisonBase && !manifest(pending.comparisonBase)) throw new Error("本机比较基准损坏。");
  if (pending?.integrityFailures && (typeof pending.integrityFailures !== "object" || Array.isArray(pending.integrityFailures) || Object.entries(pending.integrityFailures).some(([path, value]) => { safePath(path); return value !== null && typeof value !== "string"; }))) throw new Error("本机完整性保护记录损坏。");
  for (const receipts of [pending?.receipts, recheck?.receipts]) if (receipts !== undefined) {
    if (!receipts || typeof receipts !== "object" || Array.isArray(receipts) || Object.entries(receipts).some(([path, receipt]) => {
      safePath(path); return !receipt || typeof receipt.applied !== "boolean" || !(receipt.observed === null || typeof receipt.observed === "string");
    })) throw new Error("本机同步完成记录损坏。");
  }
}

function copyManifest(files: Manifest): Manifest {
  return Object.fromEntries(Object.entries(files).map(([path, entry]) => [path, { ...entry }]));
}

function encodeBase64(bytes: Uint8Array): string {
  let result = ""; const chunk = 3 * 16384;
  for (let index = 0; index < bytes.length; index += chunk) {
    result += btoa(String.fromCharCode(...bytes.subarray(index, index + chunk)));
  }
  return result;
}
function decodeBase64(value: string): Uint8Array {
  const text = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function apiObject(value: unknown): ApiObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub 响应格式错误，已停止同步。");
  return value as ApiObject;
}
function apiString(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new Error("GitHub 响应缺少必要字段，已停止同步。");
  return value;
}
function apiBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("GitHub 响应布尔字段无效，已停止同步。");
  return value;
}
function apiArray<T>(value: unknown, read: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("GitHub 文件清单无效，已停止同步；不会推断删除。");
  return value.map(read);
}
function readSha(value: unknown): { sha: string } { return { sha: apiString(apiObject(value).sha) }; }
function readRepo(value: unknown) {
  const repo = apiObject(value);
  return { default_branch: repo.default_branch === undefined || repo.default_branch === "" ? "" : apiString(repo.default_branch),
    private: repo.private === undefined ? false : apiBoolean(repo.private),
    archived: repo.archived === undefined ? false : apiBoolean(repo.archived),
    disabled: repo.disabled === undefined ? false : apiBoolean(repo.disabled),
    clone_url: repo.clone_url === undefined ? "" : apiString(repo.clone_url),
    permissions: repo.permissions === undefined ? undefined : { push: apiBoolean(apiObject(repo.permissions).push) } };
}
function readCommit(value: unknown) {
  const commit = apiObject(value);
  return { sha: apiString(commit.sha), commit: { tree: readSha(apiObject(commit.commit).tree) } };
}
function readTree(value: unknown) {
  const tree = apiObject(value);
  return { truncated: apiBoolean(tree.truncated), tree: apiArray(tree.tree, value => {
    const entry = apiObject(value);
    const type = apiString(entry.type);
    if (!["blob", "tree", "commit"].includes(type)) throw new Error("GitHub 目录条目类型未知，已停止同步；不会推断删除。");
    const size = typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : undefined;
    return { path: safePath(apiString(entry.path)), sha: apiString(entry.sha), mode: apiString(entry.mode), type, size };
  }) };
}
function readCompare(value: unknown): { status: string; files: CompareEntry[] } {
  const compare = apiObject(value);
  return { status: apiString(compare.status), files: compare.files === undefined ? [] : apiArray(compare.files, value => {
    const file = apiObject(value);
    return { status: apiString(file.status), filename: apiString(file.filename),
      previous_filename: file.status === "renamed" ? apiString(file.previous_filename) : "" };
  }) };
}
