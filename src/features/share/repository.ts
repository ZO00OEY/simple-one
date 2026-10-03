import { gunzipSync, strFromU8 } from "fflate";
import { desktopProcess, base64Bytes, type NodeFs, type NodePath } from "../../shared/desktopNode";
import { FileSystemAdapter, Platform } from "obsidian";
import type SimplePlugin from "../../main";
import { managedPath, parsePublishState, SHARE_FOLDER, type ShareManifest, type PublishState } from "./model";
import { readerArchive } from "./readerPayload";
import { DEFAULT_SHARE_TEMPLATE } from "./template";
export interface PublishJob { base: string; commit?: string; manifest?: string; templateHash?: string; expected: Record<string, string | null> }
export class ShareRepository {
  constructor(private host: SimplePlugin, private site: ShareManifest["site"]) {}
  get root(): string {
    const adapter = this.host.app.vault.adapter;
    if (Platform.isMobile || !(adapter instanceof FileSystemAdapter)) throw new Error("创建与发布分享仅支持桌面端。");
    return adapter.getBasePath().replace(/\\/g, "/") + "/" + SHARE_FOLDER;
  }
  git(args: string[], trim = true): Promise<string> { return this.host.sync.exec("git", ["-C", this.root, ...args], true, trim); }
  api(args: string[], input?: string): Promise<string> { return this.host.sync.exec("gh", ["api", ...args], false, true, 120000, undefined, input); }
  async verify(): Promise<void> {
    const { owner, repo, branch } = this.site;
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || [".", ".."].includes(repo)) throw new Error("分享仓库名称不正确。");
    await this.host.sync.exec("git", ["check-ref-format", "--branch", branch]);
    const value = JSON.parse(await this.api([`repos/${owner}/${repo}`])) as { private: boolean; permissions?: { push?: boolean }; archived?: boolean };
    if (value.private || !value.permissions?.push || value.archived) throw new Error("分享仓库必须公开、未归档，并具有写入权限。");
  }
  async exclude(): Promise<void> {
    const adapter = this.host.app.vault.adapter;
    const content = await adapter.exists(".gitignore") ? await adapter.read(".gitignore") : "";
    if (!content.split(/\r?\n/).some(line => line.trim() === `/${SHARE_FOLDER}/`)) await adapter.write(".gitignore", content + (content.endsWith("\n") || !content ? "" : "\n") + `\n# Simple One 分享发布缓存\n/${SHARE_FOLDER}/\n`);
    // Existing index entries must be handled deliberately, never removed silently.
    const tracked = await this.host.sync.exec("git", ["ls-files", "--", SHARE_FOLDER]);
    if (tracked) throw new Error("主库已跟踪 .gitshare，请先在主库解除该目录的 Git 跟踪（保留本机文件）再继续。");
    await this.host.sync.exec("git", ["check-ignore", "--quiet", `${SHARE_FOLDER}/index.html`]);
  }
  async ensure(): Promise<void> {
    await this.verify(); await this.exclude();
    const adapter = this.host.app.vault.adapter;
    await this.safePath(".git");
    if (!await adapter.exists(`${SHARE_FOLDER}/.git`)) {
      if (await adapter.exists(SHARE_FOLDER)) {
        const listing = await adapter.list(SHARE_FOLDER);
        if (listing.files.length || listing.folders.length) throw new Error(".gitshare 目录已有非仓库文件；请先检查，插件不会覆盖。");
      }
      await this.host.sync.exec("git", ["clone", "--", `https://github.com/${this.site.owner}/${this.site.repo}.git`, this.root], true);
    }
    const root = (await this.git(["rev-parse", "--show-toplevel"])).replace(/\\/g, "/");
    if (await this.canonical(root) !== await this.canonical(this.root)) throw new Error("公开仓库根目录不匹配，停止操作。");
    const remote = await this.git(["config", "--get", "remote.origin.url"]);
    if (remote.toLowerCase().replace(/\.git$/, "") !== `https://github.com/${this.site.owner}/${this.site.repo}`.toLowerCase()) throw new Error("GitShare 远端与分享清单不匹配。");
    const branch = await this.git(["symbolic-ref", "--short", "HEAD"]);
    if (branch !== this.site.branch) {
      const head = await this.git(["rev-parse", "--verify", "HEAD"]).catch(() => "");
      if (head) throw new Error(`分享工作目录分支为 ${branch}，预期 ${this.site.branch}；请先检查。`);
      await this.git(["symbolic-ref", "HEAD", `refs/heads/${this.site.branch}`]);
    }
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
      if (await adapter.exists(`${SHARE_FOLDER}/.git/${marker}`)) throw new Error("分享仓库有未完成的 Git 操作。");
    }
  }
  private async safePath(relative: string): Promise<void> {
    const requireNode = (window as unknown as { require: (name: string) => unknown }).require;
    const fs = (requireNode("fs") as NodeFs).promises;
    const path = requireNode("path") as NodePath;
    const absolute = path.resolve(this.root, relative);
    if (!absolute.startsWith(path.resolve(this.root) + path.sep)) throw new Error("发布路径越过分享目录边界。");
    let current = this.root;
    for (const part of ["", ...relative.split("/")]) {
      if (part) current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("分享缓存存在符号链接，停止文件操作。"); }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    }
  }
  private async canonical(value: string): Promise<string> {
    const requireNode = (window as unknown as { require: (name: string) => unknown }).require;
    const fs = (requireNode("fs") as NodeFs).promises;
    const canonical = (await fs.realpath(value)).replace(/\\/g, "/");
    return desktopProcess?.platform === "win32" ? canonical.toLowerCase() : canonical;
  }
  async checkPrivateFreshness(): Promise<void> {
    const run = (args: string[]) => this.host.sync.exec("git", args, true);
    const adapter = this.host.app.vault.adapter as FileSystemAdapter;
    const root = (await run(["rev-parse", "--show-toplevel"])).replace(/\\/g, "/");
    if (await this.canonical(root) !== await this.canonical(adapter.getBasePath())) throw new Error("私人主库 Git 根目录不正确。");
    if (await run(["diff", "--name-only", "--diff-filter=U"])) throw new Error("主库存在冲突，请先完成私人同步。");
    const upstream = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "");
    if (!upstream) throw new Error("主库未设置上游，无法核验多设备分享清单；请先完成主库同步接入。");
    const remote = upstream.slice(0, upstream.indexOf("/"));
    await run(["fetch", remote]);
    const counts = (await run(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).split(/\s+/).map(Number);
    if (counts[1] > 0) throw new Error("主库落后于远端或存在分叉；请先同步主库，再发布分享。");
  }
  async refresh(job?: PublishJob): Promise<void> {
    await this.git(["fetch", "origin"]);
    const status = await this.git(["status", "--porcelain", "--untracked-files=all", "-z"], false);
    if (status && !job) throw new Error("分享工作目录存在未提交改动，请检查后重试。");
    const head = await this.git(["rev-parse", "--verify", "HEAD"]).catch(() => "");
    const remote = await this.git(["rev-parse", "--verify", `refs/remotes/origin/${this.site.branch}`]).catch(() => "");
    if (job) {
      if (head !== (job.commit || job.base)) throw new Error("上次发布后 GitShare 提交发生变化，请检查后恢复。");
      const paths = status.split("\0").filter(Boolean).map(line => line.slice(3));
      if (paths.some(path => !(path in job.expected))) throw new Error("发布缓存包含额外改动，停止恢复。");
      for (const [path, hash] of Object.entries(job.expected)) {
        const current = await this.fileHash(path);
        if (current !== hash) throw new Error("上次发布文件被修改或写入不完整，停止覆盖，请检查缓存。");
      }
      if (remote && remote !== job.base && remote !== job.commit) throw new Error("另一台设备已更新分享仓库，请检查后重新生成发布计划。");
      return;
    }
    if (!remote || head === remote) return;
    if (!head) throw new Error("远端已有提交，请重新检查本地分享分支。");
    const counts = (await this.git(["rev-list", "--left-right", "--count", `HEAD...origin/${this.site.branch}`])).split(/\s+/).map(Number);
    if (counts[0]) throw new Error("分享仓库有未登记的本地提交或分叉，不会强制覆盖。");
    await this.git(["merge", "--ff-only", `origin/${this.site.branch}`]);
  }
  async state(): Promise<PublishState> {
    const adapter = this.host.app.vault.adapter;
    if (await adapter.exists(`${SHARE_FOLDER}/publish-state.json`)) {
      const state = parsePublishState(await adapter.read(`${SHARE_FOLDER}/publish-state.json`));
      if (!Platform.isMobile) for (const file of state.files) await this.safePath(file);
      return state;
    }
    const files = await this.git(["ls-files", "-z"], false);
    if (files.split("\0").filter(Boolean).some(path => managedPath(path))) throw new Error("现有仓库包含同名文件但没有发布记录，停止覆盖。");
    return { version: 1, notes: {}, files: [] };
  }
  async fileHash(path: string): Promise<string | null> {
    const { sha256 } = await import("./model");
    const adapter = this.host.app.vault.adapter;
    return await adapter.exists(`${SHARE_FOLDER}/${path}`) ? sha256(await adapter.readBinary(`${SHARE_FOLDER}/${path}`)) : null;
  }
  async writeFiles(files: Map<string, string | ArrayBuffer>, previous: PublishState, persist: (job: PublishJob) => Promise<void>): Promise<PublishJob> {
    const adapter = this.host.app.vault.adapter;
    const base = await this.git(["rev-parse", "--verify", "HEAD"]).catch(() => "");
    const expected: Record<string, string | null> = {};
    const { sha256 } = await import("./model");
    for (const [path, value] of files) {
      if (!managedPath(path)) throw new Error("非法发布路径。");
      await this.safePath(path);
      if (!previous.files.includes(path) && await adapter.exists(`${SHARE_FOLDER}/${path}`)) throw new Error(`发现未受管的同名文件：${path}`);
      expected[path] = await sha256(value);
    }
    for (const path of previous.files) if (!files.has(path)) { await this.safePath(path); expected[path] = null; }
    const job = { base, expected };
    const backups = new Map<string, ArrayBuffer | null>();
    for (const path of Object.keys(expected)) backups.set(path, await adapter.exists(`${SHARE_FOLDER}/${path}`) ? await adapter.readBinary(`${SHARE_FOLDER}/${path}`) : null);
    try {
      for (const [path, value] of files) {
        const target = `${SHARE_FOLDER}/${path}`;
        const parent = target.slice(0, target.lastIndexOf("/"));
        if (!await adapter.exists(parent)) await adapter.mkdir(parent);
        if (typeof value === "string") await adapter.write(target, value); else await adapter.writeBinary(target, value);
      }
      for (const path of previous.files) if (!files.has(path) && await adapter.exists(`${SHARE_FOLDER}/${path}`)) await adapter.remove(`${SHARE_FOLDER}/${path}`);
      await persist(job); return job;
    } catch (error) {
      let rollbackFailed = false;
      for (const [path, value] of backups) {
        try { const target = `${SHARE_FOLDER}/${path}`; if (value) await adapter.writeBinary(target, value); else if (await adapter.exists(target)) await adapter.remove(target); }
        catch { rollbackFailed = true; }
      }
      if (rollbackFailed) throw new Error("生成失败且缓存恢复不完整；线上文件未推送，请检查分享缓存后重试。");
      throw error;
    }
  }
  async push(job: PublishJob, persist: (job: PublishJob) => Promise<void>): Promise<string> {
    if (!job.commit) {
      const paths = Object.keys(job.expected);
      for (let i = 0; i < paths.length; i += 50) await this.git(["add", "-A", "--", ...paths.slice(i, i + 50)]);
      const status = await this.git(["diff", "--cached", "--name-only"]);
      if (status) {
        const account = JSON.parse(await this.api(["user"])) as { login: string; id: number };
        await this.git(["-c", `user.name=${account.login}`, "-c", `user.email=${account.id}+${account.login}@users.noreply.github.com`, "commit", "-m", "Update shared notes"]);
      }
      job.commit = await this.git(["rev-parse", "HEAD"]); await persist(job);
    }
    await this.git(["push", "origin", `HEAD:refs/heads/${this.site.branch}`]);
    await this.git(["fetch", "origin"]);
    if (await this.git(["rev-parse", `origin/${this.site.branch}`]) !== job.commit) throw new Error("远端提交校验未通过，请重新检查。");
    return job.commit;
  }
  async configurePages(): Promise<string> {
    const endpoint = `repos/${this.site.owner}/${this.site.repo}/pages`;
    let existing: { html_url?: string; source?: { branch?: string; path?: string }; build_type?: string };
    try { existing = JSON.parse(await this.api([endpoint])) as typeof existing; }
    catch (error) {
      if (!String(error).includes("404")) throw error;
      existing = JSON.parse(await this.api([endpoint, "--method", "POST", "--input", "-"], JSON.stringify({ build_type: "legacy", source: { branch: this.site.branch, path: "/" } }))) as typeof existing;
    }
    if (existing.build_type === "workflow" || existing.source?.branch !== this.site.branch || existing.source?.path !== "/") throw new Error("仓库已有不同的 Pages 配置，请在 GitHub 确认发布分支和根目录。");
    return existing.html_url || "";
  }
  async deployment(commit: string): Promise<string> {
    const build = JSON.parse(await this.api([`repos/${this.site.owner}/${this.site.repo}/pages/builds/latest`])) as { commit?: string; status?: string; error?: { message?: string } };
    if (build.status === "errored") throw new Error(build.error?.message || "Pages 部署失败");
    return build.commit === commit && build.status === "built" ? "网站已更新" : "已推送，网站部署中";
  }
}
export function websiteFiles(template = DEFAULT_SHARE_TEMPLATE): Map<string, string | ArrayBuffer> {
  const files = new Map<string, string | ArrayBuffer>();
  files.set(".nojekyll", "");
  files.set("index.html", template);
  files.set("reader/appearance.css", "");
  let readerFiles: Record<string, string> = {};
  if (readerArchive) {
    readerFiles = JSON.parse(strFromU8(gunzipSync(base64Bytes(readerArchive)))) as Record<string, string>;
  }
  for (const [path, value] of Object.entries(readerFiles)) {
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0)); files.set(path, bytes.buffer);
  }
  return files;
}
