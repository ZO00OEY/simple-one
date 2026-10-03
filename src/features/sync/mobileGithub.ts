import { DataAdapter, requestUrl } from "obsidian";
import { blobSha, syncBytes, sameContent, FileEntry, identityPaths, included, linkDiff, LocalState, Manifest, MobileOptions, newLocalState, newPathRecords, normalizePaths, PathRecords, noteChange, safePath, scanCurrent } from "./linkDiff";
import { parseGithubRepoUrl } from "./onboarding";
import { extractRepositoryArchive } from "./repositoryArchive";

export interface RemoteSnapshot { commit: string; tree: string; files: Manifest; plugins: string[]; branch: string; renames: Record<string, string> }
interface Side extends FileEntry { path: string; source: "local" | "remote" }
export interface MobileConflict {
  id: string; label: string; kind: "content" | "path" | "delete" | "initial" | "unpaired" | "duplicate";
  base?: Side; local?: Side; remote?: Side; targetPath?: string;
  localFiles?: Side[]; remoteFiles?: Side[];
}
export interface ConflictChoice { choice: "local" | "remote" | "manual" | "both" | "delete"; text?: string }
export interface MobilePlan {
  remote: RemoteSnapshot; local: Manifest; desired: Manifest; conflicts: MobileConflict[];
  uploads: string[]; downloads: string[]; localDeletes: string[]; remoteDeletes: string[];
  revision: number; pendingChoices: Record<string, ConflictChoice>; remoteRenames: Record<string, string>;
  paths: PathRecords; scope: string;
  mergedContents: Record<string, string>;
}
interface LocalAction { path: string; sha: string | null; expected: string | null }
interface PendingTransaction {
  commit: string; parent: string; base: Manifest; actions: LocalAction[];
  revision: number; paths: PathRecords;
  scope: string;
  archive?: { commit: string; files: Manifest };
}
interface StoredState extends LocalState {
  rejoinReview?: boolean;
  pending?: PendingTransaction;
  downloadVerification?: { phase: "downloading" | "verifying"; scope: string; commit: string; files: Manifest };
}
type ApiObject = Record<string, unknown>;
interface TreeEntry { path: string; type: string; mode: string; sha: string }
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
  private savePromise?: Promise<void>;
  private saveRequested = false;
  private loaded = false;
  private loadPromise?: Promise<void>;
  private deferredEvents: Array<{ type: "create" | "modify" | "delete" | "rename"; path: string; oldPath?: string }> = [];
  private running = false;

  constructor(private adapter: DataAdapter, private configDir: string, private pluginId: string,
    private getOptions: () => MobileOptions, private progress: (message: string) => void) {}

  private get statePath(): string { return `${this.configDir}/plugins/${this.pluginId}/link-state.json`; }
  private get recoveryPath(): string { return `${this.statePath}.recovery`; }
  allowed = (path: string): boolean => included(path, this.getOptions(), this.configDir, this.pluginId);

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
    for (const path of [this.statePath, this.recoveryPath]) {
      if (!await this.adapter.exists(path)) continue;
      try {
        const candidate = JSON.parse(await this.adapter.read(path)) as StoredState;
        if (candidate.schema !== 1 || !candidate.base || !candidate.cache || !candidate.paths || !candidate.dirty) {
          throw new Error("Invalid state");
        }
        parsed = candidate; recovered = path === this.recoveryPath; break;
      } catch {
        if (path === this.recoveryPath) throw new Error("本机 Link 状态与恢复副本均无法读取，已停止同步；请保留文件后检查。");
      }
    }
    if (!parsed && await this.adapter.exists(this.statePath)) {
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
        await this.adapter.write(this.recoveryPath, snapshot);
        await this.adapter.write(this.statePath, snapshot);
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
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ url: `https://api.github.com${path}`, method,
          headers: { Authorization: `Bearer ${token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body), throw: false }),
        new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("GitHub 请求超时；下次同步会核对提交结果。")), timeoutMs); })
      ]);
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
    } finally { if (timer !== undefined) window.clearTimeout(timer); }
  }

  private scope(): string {
    const o = this.getOptions();
    return JSON.stringify([o.repoUrl.toLowerCase(), o.branch, o.syncImages, o.syncPlugins,
      [...o.plugins].sort(), o.ignorePatterns]);
  }

  async remote(useCompare = false): Promise<RemoteSnapshot> {
    const repo = this.repo();
    const branch = this.getOptions().branch.trim() || (await this.json(repo.prefix, readRepo)).default_branch;
    if (!branch) throw new Error("仓库尚无分支，请先在电脑端创建首次提交。");
    const head = await this.json(`${repo.prefix}/commits/${encodeURIComponent(branch)}`, readCommit);
    const rootTree = head.commit.tree.sha;
    const renames: Record<string, string> = {};
    let comparison: ReturnType<typeof readCompare> | undefined;
    if (useCompare && this.state.baseCommitSha) {
      if (head.sha !== this.state.baseCommitSha) {
        comparison = await this.json(`${repo.prefix}/compare/${this.state.baseCommitSha}...${head.sha}`, readCompare);
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
      if (this.state.baseScope === this.scope() && head.sha === this.state.baseCommitSha) {
        const files: Manifest = { ...this.filteredBase() };
        return { commit: head.sha, tree: rootTree, files, plugins: [], branch, renames };
      }
    }
    const files: Manifest = {};
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

  async verifyAccess(): Promise<RemoteSnapshot> {
    await this.verifyToken();
    const { prefix } = this.repo();
    const metadata = await this.json(prefix, readRepo);
    if (!metadata.private) throw new Error("请选择 GitHub 私人仓库，避免公开笔记。");
    if (metadata.archived || metadata.disabled) throw new Error("仓库已归档或停用，无法同步。");
    if (metadata.permissions?.push === false) throw new Error("当前账号没有仓库写入权限。");
    const branch = this.getOptions().branch.trim() || metadata.default_branch;
    if (!branch) throw new Error("仓库尚无分支，请先在 GitHub 创建 README 或首次提交。");
    const branchInfo = await this.json(`${prefix}/branches/${encodeURIComponent(branch)}`, value => ({ protected: apiBoolean(apiObject(value).protected) }));
    if (branchInfo.protected) throw new Error("该分支受保护，请选择允许直接写入的同步分支。");
    const remote = await this.remote();
    // Test Contents:write with an unattached empty blob, never update a file, commit or branch.
    await this.api(`${prefix}/git/blobs`, "POST", { content: "", encoding: "utf-8" });
    return remote;
  }

  async createPrivateRepository(name: string): Promise<{ url: string; branch: string }> {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error("仓库名称只能包含英文、数字、点、下划线或短横线。");
    await this.verifyToken();
    const repo = await this.json("/user/repos", readRepo, "POST", { name, private: true, auto_init: true });
    if (!repo.private || !repo.clone_url) throw new Error("未能确认新仓库的私人状态，请到 GitHub 检查创建结果。");
    return { url: parseGithubRepoUrl(repo.clone_url).url, branch: repo.default_branch || "" };
  }

  private binding(branch: string): string { const repo = this.repo(); return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${branch}`; }

  async bind(verified?: RemoteSnapshot): Promise<RemoteSnapshot> {
    if (this.running) throw new Error("正在检查缓存或执行同步，请稍后再绑定仓库。");
    await this.load();
    if (this.state.pending || this.state.downloadVerification) throw new Error("还有未完成同步或下载验证，请先用原仓库恢复，再更换绑定。");
    const remote = verified ?? await this.verify();
    const binding = this.binding(remote.branch);
    if (this.state.binding !== binding) this.state = newLocalState(binding);
    await this.save();
    return remote;
  }

  async restartSetup(): Promise<boolean> {
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
        for (const path of [this.statePath, this.recoveryPath]) {
          if (!await this.adapter.exists(path)) continue;
          const source = await this.adapter.read(path);
          let candidate: StoredState;
          try { candidate = JSON.parse(source) as StoredState; }
          catch (error) { if (error instanceof SyntaxError) continue; throw error; }
          if (complete(candidate)) { previous = candidate; break; }
        }
      }
      const preserved = complete(previous);
      const next: StoredState = newLocalState(preserved ? previous.binding : "");
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
    if (this.running || this.state.pending || this.state.downloadVerification) throw new Error("同步执行或下载验证期间不能重新建立缓存。");
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
    return Object.fromEntries(Object.entries(this.state.base).filter(([path]) => this.allowed(path)));
  }

  async preview(choices: Record<string, ConflictChoice> = {}): Promise<MobilePlan> {
    await this.load();
    if (!this.getOptions().bound) throw new Error("请先完成手机端 Token、仓库与同步范围引导。");
    if (this.running) throw new Error("本地缓存正在检查，请稍后重试。");
    this.running = true;
    try {
      await this.recover();
      if (this.state.downloadVerification && this.state.downloadVerification.scope !== this.scope()) {
        throw new Error("下载验证尚未完成，请恢复原同步范围后继续；不会将缺失文件视为删除。");
      }
      this.progress("正在读取 GitHub 文件树…");
      const remote = await this.remote(true);
      if (this.state.binding !== this.binding(remote.branch)) throw new Error("仓库或分支已变化，请重新绑定；旧基准不会被复用。");
      const local = await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, false, this.progress);
      // Retain the completed local check even if review or upload later fails.
      // This does not change the last successfully aligned baseline.
      await this.save();
      const base = this.filteredBase();
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
      const put = (side?: Side): void => {
        if (!side) return;
        if (desired[side.path]) {
          throw new Error(`目标路径被不同文件占用：${side.path}。请先调整名称，再重新预览。`);
        }
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
      const records = this.getOptions().trackPaths ? this.state.paths : newPathRecords();
      const lMap = identityPaths(base, local, records.moves, false);
      const rMap = identityPaths(base, remote.files, remoteRenames);
      const claimedLocal = new Set(Object.values(lMap)); const claimedRemote = new Set(Object.values(rMap));
      for (const path of Object.keys(base)) {
        const b: Side = { ...base[path], path, source: "remote" };
        const l = sideAt(local, lMap[path], "local"); const r = sideAt(remote.files, rMap[path], "remote");
        if (this.state.rejoinReview && (!!l !== !!r)) choose({ id: `base:${path}`, label: path, kind: "delete", base: b, local: l, remote: r });
        else if (!l && r && this.state.downloadVerification?.files[r.path] && !records.moves[path]) put(r);
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
      const additions = new Set([...Object.keys(local).filter((p) => !claimedLocal.has(p)),
        ...Object.keys(remote.files).filter((p) => !claimedRemote.has(p))]);
      if (!this.state.baseCommitSha) {
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
        if (!l && r && this.state.downloadVerification?.files[path]) put(r);
        else if (l && r && !sameContent(l, r)) choose({ id: `new:${path}`, label: path, kind: "initial", local: l, remote: r });
        else if ((!this.state.baseCommitSha || this.state.rejoinReview) && (!!l !== !!r)) {
          choose({ id: `new:${path}`, label: path, kind: "unpaired", local: l, remote: r });
        } else put(l ?? r);
      }
      const conflictedLocal = new Set(conflicts.flatMap(c => c.localFiles?.map(s => s.path) ?? (c.local ? [c.local.path] : [])));
      const conflictedRemote = new Set(conflicts.flatMap(c => c.remoteFiles?.map(s => s.path) ?? (c.remote ? [c.remote.path] : [])));
      const plan: MobilePlan = { remote, local, desired, conflicts, revision: this.state.revision,
        pendingChoices: choices, remoteRenames, paths: { moves: { ...records.moves } }, scope: this.scope(), mergedContents,
        uploads: Object.keys(desired).filter((p) => desired[p].sha !== remote.files[p]?.sha || desired[p].mode !== remote.files[p]?.mode),
        downloads: Object.keys(desired).filter((p) => !sameContent(desired[p], local[p])),
        localDeletes: Object.keys(local).filter((p) => !desired[p] && !conflictedLocal.has(p)),
        remoteDeletes: Object.keys(remote.files).filter((p) => !desired[p] && !conflictedRemote.has(p)) };
      const count = new Set([...plan.uploads, ...plan.downloads, ...plan.localDeletes, ...plan.remoteDeletes]).size;
      this.progress(`已整理同步计划 · 待同步 ${count} 个文件 · 待准备上传 ${plan.uploads.length} 个 · 待确认差异 ${conflicts.length} 项`);
      return plan;
    } finally { this.running = false; }
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
    return await blobSha(new Uint8Array(await this.adapter.readBinary(path)));
  }

  requiresPluginReload(plan: MobilePlan): boolean {
    const prefix = this.configDir + "/plugins/" + this.pluginId + "/";
    return [...plan.downloads, ...plan.localDeletes].some(path =>
      ["main.js", "manifest.json", "styles.css"].some(name => path === prefix + name));
  }

  async execute(plan: MobilePlan): Promise<void> {
    if (plan.conflicts.length) throw new Error("仍有未选择的冲突，未执行同步。");
    if (this.running) throw new Error("本地缓存正在检查，请稍后重试。");
    if (this.state.pending) throw new Error("还有未完成的下载或验证，请先重新预览以恢复同步；尚未确认新基准。");
    this.running = true;
    try {
      const remoteRemaining = new Set([...plan.uploads, ...plan.remoteDeletes]);
      const localRemaining = new Set([...plan.downloads, ...plan.localDeletes]);
      let prepared = 0;
      const report = (stage: string): void => {
        const remaining = new Set([...remoteRemaining, ...localRemaining]).size;
        this.progress(`${stage} · 待同步 ${remaining} 个文件 · 待准备上传 ${plan.uploads.length - prepared} 个 · 已准备 ${prepared}/${plan.uploads.length}`);
      };
      report("正在核对同步计划");
      if (plan.scope !== this.scope()) throw new Error("同步范围或仓库设置已变化，请重新预览。");
      if (this.state.revision !== plan.revision) throw new Error("预览后本地发生变化，请重新预览。");
      const repo = this.repo();
      const head = await this.json(`${repo.prefix}/git/ref/heads/${encodeURIComponent(plan.remote.branch)}`, value => ({ object: readSha(apiObject(value).object) }));
      if (head.object.sha !== plan.remote.commit) throw new Error("预览后云端出现新提交，请重新预览。");
      // Detect external edits and new/deleted files before any remote mutation.
      const live = await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, false, this.progress);
      await this.save();
      if (JSON.stringify(Object.entries(live).map(([p,e]) => [p,e.sha]).sort()) !==
          JSON.stringify(Object.entries(plan.local).map(([p,e]) => [p,e.sha]).sort())) throw new Error("预览后文件内容已变化，请重新预览。");
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
          if (await blobSha(bytes) !== target.sha) throw new Error("上传前本地文件已变化，请重新预览。");
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
      if (this.state.revision !== plan.revision) throw new Error("上传准备期间本地发生变化，尚未更新远端分支，请重新预览。");
      const actions: LocalAction[] = [
        ...plan.downloads.map((path) => ({ path, sha: plan.desired[path].sha, expected: plan.local[path]?.rawSha ?? plan.local[path]?.sha ?? null })),
        ...plan.localDeletes.map((path) => ({ path, sha: null, expected: plan.local[path].rawSha ?? plan.local[path].sha }))
      ];
      let commitSha = plan.remote.commit;
      if (treeSha !== plan.remote.tree) {
        report("正在生成云端版本");
        const commit = await this.json(`${repo.prefix}/git/commits`, readSha, "POST", {
          message: `同步与分享 mobile sync ${new Date().toISOString()}`, tree: treeSha, parents: [plan.remote.commit]
        });
        commitSha = commit.sha;
      }
      if (plan.scope !== this.scope()) throw new Error("上传准备期间同步范围已变化，请重新预览。");
      this.state.pending = { commit: commitSha, parent: plan.remote.commit, base: plan.desired, actions,
        revision: plan.revision, paths: plan.paths, scope: plan.scope };
      const emptyVault = Object.keys(plan.local).every(path => path.startsWith(`${this.configDir}/`));
      if (plan.downloads.length && (emptyVault || plan.downloads.length >= 50 ||
          Object.values(plan.pendingChoices).some(choice => choice.choice === "both"))) {
        const wanted = new Set(plan.downloads.map(path => plan.desired[path].sha));
        this.state.pending.archive = { commit: plan.remote.commit,
          files: Object.fromEntries(Object.entries(plan.remote.files).filter(([, entry]) => wanted.has(entry.sha))) };
      }
      this.state.downloadVerification = { phase: "downloading", scope: plan.scope, commit: commitSha,
        files: Object.fromEntries(plan.downloads.map(path => [path, plan.desired[path]])) };
      await this.save();
      report("正在确认云端更新");
      if (commitSha !== plan.remote.commit) await this.api(`${repo.prefix}/git/refs/heads/${encodeURIComponent(plan.remote.branch)}`,
        "PATCH", { sha: commitSha, force: false });
      remoteRemaining.clear();
      await this.applyPending((path) => {
        if (path) localRemaining.delete(path);
        report("正在应用本地同步结果");
      });
    } finally { this.running = false; }
  }

  private async recover(): Promise<void> {
    const pending = this.state.pending;
    if (!pending) return;
    this.progress("检测到未完成的下载或验证 · 正在恢复同步，保留原共同基准…");
    const remote = await this.remote();
    if (this.state.binding !== this.binding(remote.branch)) throw new Error("未完成事务属于其他仓库，不能切换绑定。");
    if (remote.commit !== pending.commit) {
      if (remote.commit === pending.parent && pending.commit !== pending.parent) {
        this.state.pending = undefined; this.state.downloadVerification = undefined; await this.save(); return;
      }
      const diff = await this.json(`${this.repo().prefix}/compare/${pending.commit}...${remote.commit}`, readCompare);
      if (!["ahead", "identical"].includes(diff.status)) throw new Error("未完成提交与远端历史不一致，请保留本机状态并检查仓库。");
    }
    // If the user edited a pending target, keep the old common baseline and
    // re-review against the now-confirmed remote commit. Advancing the baseline
    // here could turn a real two-sided conflict into an automatic overwrite.
    for (const action of pending.actions) {
      const current = await this.liveSha(action.path);
      if (current !== action.sha && current !== action.expected) {
        this.state.pending = undefined;
        await this.save();
        this.progress("未完成同步中发现本机新修改，已保留内容并重新预览差异…");
        return;
      }
    }
    await this.applyPending();
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/"); parts.pop(); let current = "";
    for (const part of parts) { current = current ? `${current}/${part}` : part; if (!await this.adapter.exists(current)) await this.adapter.mkdir(current); }
  }

  private async downloadArchive(pending: PendingTransaction): Promise<Map<string, Uint8Array>> {
    const blobs = new Map<string, Uint8Array>();
    if (!pending.archive) return blobs;
    const needed = new Set<string>();
    for (let index = 0; index < pending.actions.length; index++) {
      const action = pending.actions[index];
      if (action.sha && await this.liveSha(action.path) !== action.sha) needed.add(action.sha);
      if (index % 25 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (!needed.size) return blobs;
    const wanted = Object.fromEntries(Object.entries(pending.archive.files)
      .filter(([path, entry]) => this.allowed(path) && needed.has(entry.sha)));
    if (!Object.keys(wanted).length) return blobs;
    try {
      this.progress("正在打包下载云端仓库 · 完成后按同步规则筛选文件…");
      const bytes = await this.api(`${this.repo().prefix}/zipball/${encodeURIComponent(pending.archive.commit)}`, "GET", undefined, true, 180000);
      if (!(bytes instanceof Uint8Array)) throw new Error("压缩包响应无效。");
      const files = await extractRepositoryArchive(bytes, wanted, message => this.progress(message));
      let checked = 0;
      for (const [path, content] of files) {
        const sha = wanted[path].sha;
        // Archive attributes can change file contents; use the original blob then.
        if (await blobSha(content) === sha) blobs.set(sha, content);
        files.delete(path);
        if (++checked % 25 === 0) {
          this.progress(`正在校验压缩包内容 · 已检查 ${checked} 个文件`);
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }
      }
      return blobs;
    } catch {
      this.progress("整库打包下载未完成或超过解压容量，正在改用逐文件下载…");
      return new Map();
    }
  }

  private async applyPending(onApplied?: (path?: string) => void): Promise<void> {
    const pending = this.state.pending!;
    if (pending.scope !== this.scope()) throw new Error("未完成同步的范围已变化，请恢复原同步范围再继续。");
    const archived = await this.downloadArchive(pending);
    if (pending.scope !== this.scope()) throw new Error("打包下载期间同步范围已变化，请重新预览。");
    // Reuse a verified local copy when multiple paths download the same blob.
    const downloaded = new Map<string, string>();
    const remaining = new Set(pending.actions.map(action => action.path));
    const report = (path?: string): void => {
      if (path) remaining.delete(path);
      if (onApplied) onApplied(path);
      else this.progress(`正在恢复本地同步结果 · 待同步 ${remaining.size} 个文件`);
    };
    report();
    for (const action of pending.actions) {
      if (!this.allowed(action.path)) throw new Error("同步范围已变化，请恢复原范围后继续未完成事务。");
      const current = await this.liveSha(action.path);
      if (current === action.sha) {
        if (action.sha) downloaded.set(action.sha, action.path);
        report(action.path);
        continue;
      }
      if (current !== action.expected) throw new Error(`本地文件又被修改，已保留：${action.path}。请先备份并恢复到预览内容后重试。`);
      if (action.sha === null) {
        if (await this.liveSha(action.path) !== action.expected) throw new Error("删除前本地内容发生变化，已停止。");
        await this.adapter.remove(action.path);
      } else {
        const source = downloaded.get(action.sha);
        let bytes: Uint8Array | undefined = archived.get(action.sha) ?? (source && await this.adapter.exists(source)
          ? new Uint8Array(await this.adapter.readBinary(source)) : undefined);
        if (!bytes || await blobSha(bytes) !== action.sha) bytes = await this.getBlob(action.sha);
        await this.ensureParent(action.path);
        if (await this.liveSha(action.path) !== action.expected) throw new Error("下载期间本地内容发生变化，已停止写入。");
        await this.adapter.writeBinary(action.path, bytes.buffer as ArrayBuffer);
        downloaded.set(action.sha, action.path);
      }
      delete this.state.cache[action.path];
      report(action.path);
      if (remaining.size % 25 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    archived.clear();
    if (this.state.downloadVerification) this.state.downloadVerification.phase = "verifying";
    await this.save();
    this.progress(`正在验证下载结果 · 0/${pending.actions.length} 个文件 · 验证通过后确认基准`);
    for (let i = 0; i < pending.actions.length; i++) {
      const action = pending.actions[i];
      if (await this.liveSha(action.path) !== action.sha) {
        throw new Error(`下载结果验证未通过：${action.path}。已保留未完成状态和原共同基准，请重新预览恢复同步。`);
      }
      this.progress(`正在验证下载结果 · ${i + 1}/${pending.actions.length} 个文件 · 验证通过后确认基准`);
      if (i % 25 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    // A failed cache refresh must leave the download transaction recoverable.
    this.progress("下载验证通过 · 正在更新本地哈希缓存，尚未确认新基准…");
    await scanCurrent(this.adapter, this.state, this.getOptions(), this.allowed, false,
      message => this.progress(`正在完成下载验证 · ${message}`));
    // Recheck after the asynchronous scan: user edits during verification must
    // not be accepted as part of the downloaded baseline.
    for (const action of pending.actions) {
      if (await this.liveSha(action.path) !== action.sha) {
        throw new Error(`验证期间本地文件发生变化：${action.path}。原共同基准已保留，请重新预览。`);
      }
    }
    const moveOrigins = new Set([...Object.keys(this.state.paths.moves), ...Object.keys(pending.paths.moves)]);
    const outstanding = [...moveOrigins].filter((path) => this.state.paths.moves[path] !== pending.paths.moves[path])
      .map((path) => [path, this.state.paths.moves[path] ?? path] as const);
    const rebased = newPathRecords();
    for (const [oldBase, target] of outstanding) {
      const origin = pending.paths.moves[oldBase] ?? oldBase;
      if (origin !== target) rebased.moves[origin] = target;
    }
    this.state.base = pending.base; this.state.baseCommitSha = pending.commit;
    this.state.baseScope = pending.scope;
    this.state.paths = rebased; this.state.pending = undefined;
    this.state.downloadVerification = undefined;
    delete this.state.rejoinReview;
    // Keep event dirty markers: edits made while uploading remain detectable.
    await this.save();
    this.progress("同步已对齐 · 下载验证通过 · 待同步 0 个文件 · 新基准已确认");
  }
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
    return { path: safePath(apiString(entry.path)), sha: apiString(entry.sha), mode: apiString(entry.mode), type };
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
