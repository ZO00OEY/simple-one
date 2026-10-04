import type SimplePlugin from "../../main";
import { base64Bytes } from "../../shared/desktopNode";
import { blobSha } from "../sync/linkDiff";
import { managedPath, parsePublishState, type ShareManifest, type PublishState } from "./model";
import { readerAssets } from "./template";

export interface PublishJob { base: string; commit?: string; expected: Record<string, string | null> }
interface TreeEntry { path: string; mode: string; type: string; sha: string }
interface Head { sha: string; tree: string }

/** Publish generated files directly, without a clone or persistent sync baseline. */
export class ShareRepository {
  private head?: Head;
  private entries = new Map<string, TreeEntry>();
  private generated = new Map<string, Uint8Array>();
  private published: PublishState = { version: 1, notes: {}, files: [] };
  constructor(protected host: SimplePlugin, protected site: ShareManifest["site"]) {}
  api(args: string[], input?: string): Promise<string> { return this.host.sync.exec("gh", ["api", ...args], false, true, 120000, undefined, input); }
  private get prefix(): string { return "repos/" + this.site.owner + "/" + this.site.repo; }
  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    return JSON.parse(await this.api([path, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body))) as T;
  }
  async verify(): Promise<void> {
    const { owner, repo, branch } = this.site;
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || [".", ".."].includes(repo) ||
        !branch || /[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|\/\//.test(branch) || branch.split("/").some(part => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) throw new Error("分享仓库或分支配置不正确。");
    const value = await this.request<{ private: boolean; permissions?: { push?: boolean }; archived?: boolean; disabled?: boolean }>(this.prefix);
    if (value.private || value.permissions?.push !== true || value.archived || value.disabled) throw new Error("分享仓库必须公开、未归档，并具有写入权限。");
  }
  private async readRef(): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>(this.prefix + "/git/ref/heads/" + encodeURIComponent(this.site.branch));
    if (!/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error("GitHub 提交格式不正确。");
    return ref.object.sha;
  }
  private async readHead(): Promise<Head> {
    const sha = await this.readRef();
    const commit = await this.request<{ tree: { sha: string } }>(this.prefix + "/git/commits/" + sha);
    if (!/^[a-f0-9]{40}$/.test(commit.tree.sha)) throw new Error("GitHub 文件树格式不正确。");
    return { sha, tree: commit.tree.sha };
  }
  async refresh(): Promise<void> {
    try { this.head = await this.readHead(); }
    catch (error) {
      if (!/\b(?:404|409)\b/.test(String(error))) throw error;
      const branches = await this.request<unknown[]>(this.prefix + "/branches?per_page=1");
      if (branches.length) throw error;
      this.head = undefined; this.entries.clear();
      this.published = { version: 1, notes: {}, files: [] }; return;
    }
    const tree = await this.request<{ tree: TreeEntry[]; truncated?: boolean }>(this.prefix + "/git/trees/" + this.head.tree + "?recursive=1");
    if (tree.truncated) throw new Error("云端文件清单被截断，停止发布和删除。");
    this.entries = new Map(tree.tree.map(entry => [entry.path, entry]));
    const state = this.entries.get("publish-state.json");
    if (state) this.published = parsePublishState(new TextDecoder().decode(await this.readBlob(state)));
    else {
      if ([...this.entries.keys()].some(managedPath)) throw new Error("远端已有分享文件但没有发布清单，停止覆盖。");
      this.published = { version: 1, notes: {}, files: [] };
    }
  }
  private async readBlob(entry: TreeEntry): Promise<Uint8Array> {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("分享文件不能是符号链接或其他特殊文件。");
    const blob = await this.request<{ content: string; encoding: string }>(this.prefix + "/git/blobs/" + entry.sha);
    if (blob.encoding !== "base64") throw new Error("GitHub 文件编码不正确。");
    const bytes = base64Bytes(blob.content.replace(/\s/g, ""));
    if (await blobSha(bytes) !== entry.sha) throw new Error("云端发布清单下载校验失败。");
    return bytes;
  }
  async state(): Promise<PublishState> { return this.published; }
  async writeFiles(files: Map<string, string | ArrayBuffer>, previous: PublishState): Promise<PublishJob> {
    const next = files.get("publish-state.json");
    if (typeof next !== "string") throw new Error("缺少目标发布清单。");
    const target = parsePublishState(next);
    // Git database endpoints require a first commit. Bootstrap only metadata, never note content.
    if (!this.head) {
      const content = JSON.stringify({ version: 1, notes: {}, files: ["publish-state.json"] });
      await this.request(this.prefix + "/contents/publish-state.json", "PUT", { message: "Initialize shared notes", branch: this.site.branch, content: btoa(content) });
      await this.refresh(); previous = this.published;
      if (!this.head) throw new Error("分享仓库初始化未完成，请重新发布。");
    }
    const retained = new Set(target.files);
    this.generated.clear();
    const expected: Record<string, string | null> = {};
    for (const [path, content] of files) {
      if (!managedPath(path) || !retained.has(path)) throw new Error("非法发布路径或文件未登记。");
      const existing = this.entries.get(path);
      if (existing && !previous.files.includes(path)) throw new Error("发现未受管的同名文件：" + path);
      if (existing && (existing.type !== "blob" || !["100644", "100755"].includes(existing.mode))) throw new Error("分享文件不能是符号链接或其他特殊文件。");
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content).slice();
      const hash = await blobSha(bytes);
      if (existing?.sha === hash) continue;
      this.generated.set(path, bytes); expected[path] = hash;
    }
    for (const path of target.files) if (!files.has(path) && (!previous.files.includes(path) || !this.entries.has(path))) throw new Error("目标文件缺失：" + path);
    for (const path of previous.files) if (!retained.has(path) && this.entries.has(path)) expected[path] = null;
    return { base: this.head.sha, expected };
  }
  async push(job: PublishJob, persist: (job: PublishJob) => Promise<void> = async () => {}): Promise<string> {
    const current = { sha: await this.readRef(), tree: this.head?.tree ?? "" };
    if (job.commit && current.sha === job.commit) return job.commit;
    if (current.sha !== job.base) throw new Error("云端在生成期间发生变化，请重新发布；不会强制覆盖。");
    if (!Object.keys(job.expected).length) return current.sha;
    if (!job.commit) {
      const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
      for (const [path, hash] of Object.entries(job.expected)) {
        if (!managedPath(path)) throw new Error("发布计划越出公开文件范围。");
        if (hash === null) { entries.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
        const bytes = this.generated.get(path);
        if (!bytes || await blobSha(bytes) !== hash) throw new Error("目标文件变化，请重新生成。");
        let binary = "";
        for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
        const blob = await this.request<{ sha: string }>(this.prefix + "/git/blobs", "POST", { content: btoa(binary), encoding: "base64" });
        if (blob.sha !== hash) throw new Error("文件上传哈希校验失败。");
        entries.push({ path, mode: "100644", type: "blob", sha: hash });
      }
      let tree = current.tree;
      for (let offset = 0; offset < entries.length; offset += 500) tree = (await this.request<{ sha: string }>(this.prefix + "/git/trees", "POST", { base_tree: tree, tree: entries.slice(offset, offset + 500) })).sha;
      job.commit = (await this.request<{ sha: string }>(this.prefix + "/git/commits", "POST", { message: "Update shared notes", tree, parents: [job.base] })).sha;
      if (!/^[a-f0-9]{40}$/.test(job.commit)) throw new Error("GitHub 提交格式不正确。");
      await persist(job);
    }
    if (await this.readRef() !== job.base) throw new Error("推送前云端出现新提交，请重新发布。");
    await this.request(this.prefix + "/git/refs/heads/" + encodeURIComponent(this.site.branch), "PATCH", { sha: job.commit, force: false });
    if (await this.readRef() !== job.commit) throw new Error("推送结果尚未确认；重新发布会按云端实际内容对比。");
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
export function websiteFiles(template: string, defaultTemplate: string, licenses = ""): Map<string, string | ArrayBuffer> {
  const files = new Map<string, string | ArrayBuffer>();
  files.set(".nojekyll", "");
  files.set("index.html", template);
  files.set("reader/appearance.css", "");
  // Standalone custom HTML owns its assets; legacy templates still need reader/app.*.
  if (!/<script data-simple-reader>/.test(template)) {
    for (const [path, value] of Object.entries(readerAssets(defaultTemplate))) files.set(path, value);
  }
  files.set("reader/licenses.txt", licenses);
  return files;
}
