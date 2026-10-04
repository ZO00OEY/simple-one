import { requestUrl, requireApiVersion } from "obsidian";
import type SimplePlugin from "../../main";
import { sha256, type ShareManifest } from "./model";

export const EDGEONE_SETTINGS_URL = "https://console.cloud.tencent.com/edgeone/makers?tab=settings";
export const EDGEONE_PROJECTS_URL = "https://console.cloud.tencent.com/edgeone/makers";
type Site = ShareManifest["site"];
export interface EdgeOneProject {
  ProjectId: string; Name: string; Provider?: string; RepoUrl?: string;
  RepoOwner?: string; RepoName?: string; RepoBranch?: string; PresetDomain?: string;
}
export interface EdgeOneDeployment {
  DeploymentId: string; Status: string; Env: string; RepoBranch: string;
  RepoCommitHash?: string; UsedInProd?: boolean; CreatedOn?: string;
}
export interface EdgeOneResult {
  kind: "success" | "pending" | "error" | "unknown";
  text: string;
}
interface EdgeOneState {
  version: 1; step: number; repo?: string; branch?: string;
  projectId?: string; projectName?: string; website?: string;
  creationName?: string; completed?: boolean;
  lastCheck?: EdgeOneResult & { commit: string; checkedAt: number };
}
type JsonObject = Record<string, unknown>;
export type EdgeOneTransport = (token: string, action: string, body: JsonObject) => Promise<JsonObject>;
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: unknown, fallback = ""): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
const repoKey = (site: Site): string => `${site.owner}/${site.repo}`.toLowerCase();

/** Pages uses a Code/Data/Response envelope, unlike the GitHub API. */
export async function edgeOneRequest(token: string, action: string, body: JsonObject): Promise<JsonObject> {
  let timer: number | undefined;
  try {
    const response = await Promise.race([
      requestUrl({ url: "https://pages-api.cloud.tencent.com/v1", method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body, Action: action }), throw: false }),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("腾讯请求超时，请稍后重试。")), 30000); })
    ]);
    const envelope = object(response.json);
    const payload = object(object(envelope.Data).Response ?? envelope.Response);
    const nestedError = object(payload.Error);
    if (response.status < 200 || response.status >= 300 ||
      envelope.Code !== undefined && Number(envelope.Code) !== 0 || Object.keys(nestedError).length) {
      const code = string(nestedError.Code ?? envelope.Code, String(response.status));
      if (response.status === 401 || response.status === 403 || /auth|token|unauthorized/i.test(code)) {
        throw new Error("腾讯授权无效或已过期，请重新创建 API Token 并核验授权。");
      }
      const message = string(nestedError.Message ?? envelope.Message, "腾讯接口请求失败");
      throw new Error(`${message}（${code}）`);
    }
    if (!Object.keys(payload).length) throw new Error("腾讯返回的数据格式无法识别，请稍后重试。");
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(token).join("[已隐藏]").slice(0, 600));
  } finally { if (timer) window.clearTimeout(timer); }
}

export function matchesEdgeOneRepository(project: EdgeOneProject, site: Site): boolean {
  if (project.Provider?.toLowerCase() !== "github") return false;
  const identity = project.RepoOwner && project.RepoName
    ? `${project.RepoOwner}/${project.RepoName}`
    : project.RepoUrl?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i)?.[1];
  return identity?.toLowerCase() === repoKey(site) && project.RepoBranch === site.branch;
}

export function edgeOneWebsite(domain: string | undefined): string {
  if (!domain) return "";
  try {
    const url = new URL(domain.includes("://") ? domain : `https://${domain}`);
    return url.protocol === "https:" && !url.username && !url.password ? url.href.replace(/\/$/, "") : "";
  } catch { return ""; }
}

/** A successful preview or a superseded production build is not the live website. */
export function edgeOneDeploymentResult(deployments: EdgeOneDeployment[], commit: string, branch: string): EdgeOneResult {
  const production = deployments.filter(item => item.Env === "Production" && item.RepoBranch === branch);
  const matchingVersions = production.filter(item => item.RepoCommitHash === commit);
  const matching = matchingVersions.find(item => item.Status === "Success" && item.UsedInProd === true)
    ?? matchingVersions.sort((a, b) => (b.CreatedOn ?? "").localeCompare(a.CreatedOn ?? ""))[0];
  if (!matching) return { kind: "pending", text: "最近一次分享尚未找到对应的正式部署记录。" };
  if (["Failed", "Timeout", "Cancelled", "Invalid"].includes(matching.Status)) {
    return { kind: "error", text: "最近一次分享部署失败、已取消或已失效，请在腾讯项目页查看原因。" };
  }
  if (["Pending", "Process"].includes(matching.Status)) return { kind: "pending", text: "最近一次分享正在部署，请稍后检查。" };
  if (matching.Status !== "Success") return { kind: "unknown", text: "腾讯返回了未知部署状态，请在项目页确认。" };
  if (matching.UsedInProd === true) return { kind: "success", text: "最近一次分享已部署，正式网站已更新。" };
  const active = production.find(item => item.UsedInProd === true);
  return { kind: "unknown", text: active
    ? "最近一次分享已构建成功，但正式网站当前使用其他版本。"
    : "最近一次分享已构建成功，尚未确认正式网站使用该版本。" };
}

export class EdgeOneConnection {
  state: EdgeOneState = { version: 1, step: 1 };
  busy = false;
  message = "";
  error = "";
  draftToken = "";
  draftName = "";
  authMode: "verify" | "create" = "create";
  candidates: EdgeOneProject[] = [];
  selectedProject = "";
  area: "overseas" | "mainland" | "global" = "overseas";
  private secretId = "";
  private stopped = false;
  constructor(private host: SimplePlugin, readonly site: () => Site,
    private latestCommit: () => Promise<string>, readonly refresh: () => void,
    private transport: EdgeOneTransport = edgeOneRequest) {}
  private get path(): string { return `${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}/share-local.json.edgeone`; }
  get linked(): boolean { return !!this.state.projectId && this.state.repo === repoKey(this.site()) && this.state.branch === this.site().branch; }
  get completed(): boolean { return this.linked && this.state.completed === true; }
  get website(): string { return this.linked ? this.state.website ?? "" : ""; }
  private secrets(): { getSecret(id: string): string | null; setSecret(id: string, value: string): void } | undefined {
    if (requireApiVersion("1.11.4")) return this.host.app.secretStorage;
    return undefined;
  }
  get hasToken(): boolean { return !!this.secretId && !!this.secrets()?.getSecret(this.secretId); }
  async load(): Promise<void> {
    const adapter = this.host.app.vault.adapter;
    const desktopAdapter = adapter as typeof adapter & { getBasePath?: () => string };
    const identity = desktopAdapter.getBasePath?.() ?? this.host.app.vault.getName();
    this.secretId = `simple-one-edgeone-${(await sha256(identity)).slice(0, 16)}`;
    if (!await adapter.exists(this.path)) return;
    const value = object(JSON.parse(await adapter.read(this.path)));
    if (value.version !== 1 || !Number.isInteger(value.step) || Number(value.step) < 1 || Number(value.step) > 3) {
      throw new Error("腾讯接入记录格式不正确，已保留原文件。");
    }
    for (const key of ["repo", "branch", "projectId", "projectName", "creationName", "website"]) {
      if (value[key] !== undefined && typeof value[key] !== "string") throw new Error("腾讯接入记录格式不正确，已保留原文件。");
    }
    this.state = value as unknown as EdgeOneState;
    this.state.website = edgeOneWebsite(this.state.website);
    if (this.state.lastCheck && (!this.state.lastCheck.text || !["success", "pending", "error", "unknown"].includes(this.state.lastCheck.kind))) delete this.state.lastCheck;
    this.draftName = this.state.creationName ?? this.state.projectName ?? "";
  }
  stop(): void { this.stopped = true; this.draftToken = ""; }
  private token(): string {
    const token = this.secretId && this.secrets()?.getSecret(this.secretId);
    if (!token) throw new Error("请先填写并核验腾讯 API Token。");
    return token;
  }
  private save(): Promise<void> {
    return this.host.app.vault.adapter.write(this.path, JSON.stringify(this.state, null, 2));
  }
  async invalidateDeployment(commit: string): Promise<void> {
    if (!this.linked || this.state.lastCheck?.commit === commit) return;
    delete this.state.lastCheck;
    this.state.completed = false;
    this.message = "分享已推送，请检查腾讯网站部署。";
    await this.save();
  }
  private report(text: string): void { this.message = text; this.refresh(); }
  async run(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = ""; this.stopped = false; this.refresh();
    try { await work(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const secrets = [this.draftToken, this.secrets()?.getSecret(this.secretId) ?? ""].filter(Boolean);
      this.error = secrets.reduce((text, secret) => text.split(secret).join("[已隐藏]"), message).slice(0, 600);
    }
    finally { this.busy = false; this.refresh(); }
  }
  async verifyToken(useSaved = false): Promise<void> {
    const token = this.draftToken.trim() || (useSaved && this.hasToken ? this.token() : "");
    if (!token || /\s/.test(token)) throw new Error("请粘贴完整的腾讯 API Token。");
    const secrets = this.secrets();
    if (!secrets?.setSecret) throw new Error("保存腾讯授权需要 Obsidian 1.11.4 或以上版本，请升级后接入。");
    this.report("正在核验腾讯授权…");
    const response = await this.transport(token, "DescribePagesProjects", { Offset: 0, Limit: 1 });
    if (!Array.isArray(response.Projects)) throw new Error("腾讯没有返回项目列表，授权尚未核验成功。");
    if (!this.secretId) await this.load();
    secrets.setSecret(this.secretId, token);
    this.draftToken = "";
    this.state.step = 2;
    await this.save(); this.report("腾讯授权已核验，请关联当前笔记分享仓库。");
    await this.enterRepositoryStep();
  }
  async enterRepositoryStep(): Promise<void> {
    this.state.step = 2;
    if (!this.site().initialized || !this.site().owner || !this.site().repo) { this.refresh(); return; }
    await this.findProjects();
    const existing = this.candidates.find(project => project.ProjectId === this.state.projectId)
      ?? (this.candidates.length === 1 ? this.candidates[0] : undefined);
    if (existing) {
      const completed = existing.ProjectId === this.state.projectId && this.completed;
      const lastCheck = this.linked && existing.ProjectId === this.state.projectId ? this.state.lastCheck : undefined;
      await this.adopt(existing);
      this.state.step = 2; this.state.completed = completed; this.state.lastCheck = lastCheck;
      await this.save();
      this.report(`已关联腾讯项目 ${existing.Name}，可以继续初始化或检查网站。`);
    } else {
      delete this.state.projectId; delete this.state.projectName; delete this.state.website;
      delete this.state.completed; delete this.state.lastCheck;
      await this.save();
      this.report(this.candidates.length ? "找到多个匹配项目，请选择要关联的项目。" : "当前分享仓库尚未关联腾讯项目，请创建并关联。");
    }
  }
  requireShareReady(): Site {
    const site = this.site();
    if (!site.owner || !site.repo || !site.initialized) throw new Error("请先完成笔记分享引导，创建并初始化分享专用仓库。");
    return { ...site };
  }
  async findProjects(): Promise<void> {
    const site = this.requireShareReady();
    this.report("正在查找关联当前分享仓库的腾讯项目…");
    const token = this.token();
    const candidates: EdgeOneProject[] = [];
    for (let page = 0; page < 100; page++) {
      const response = await this.transport(token, "DescribePagesProjects", { Offset: page, Limit: 100 });
      if (!Array.isArray(response.Projects)) throw new Error("腾讯返回的项目列表格式不正确。");
      const projects = response.Projects as EdgeOneProject[];
      candidates.push(...projects.filter(project => matchesEdgeOneRepository(project, site)));
      if (!projects.length || (page + 1) * 100 >= Number(response.TotalCount ?? projects.length)) break;
      if (page === 99) throw new Error("腾讯项目过多，请在控制台确认要接入的项目。");
    }
    this.candidates = candidates;
    this.selectedProject = candidates.find(project => project.ProjectId === this.state.projectId)?.ProjectId ?? candidates[0]?.ProjectId ?? "";
    this.report(candidates.length ? `找到 ${candidates.length} 个关联当前分享仓库的项目。` : "未找到已有项目，可以创建新的腾讯分享项目。");
  }
  private async project(id: string): Promise<EdgeOneProject> {
    const response = await this.transport(this.token(), "DescribePagesProjects", { ProjectIds: [id], Offset: 0, Limit: 1 });
    const projects = Array.isArray(response.Projects) ? response.Projects as EdgeOneProject[] : [];
    const project = projects.find(item => item.ProjectId === id);
    if (!project) throw new Error("腾讯项目尚未返回，请稍后重试；已创建的项目不会重复创建。");
    if (!matchesEdgeOneRepository(project, this.requireShareReady())) throw new Error("腾讯项目关联的仓库或分支与当前分享仓库不一致，请在控制台完成 GitHub 授权并确认项目配置。");
    return project;
  }
  private async adopt(project: EdgeOneProject): Promise<void> {
    this.state = { version: 1, step: 3, repo: repoKey(this.site()), branch: this.site().branch,
      projectId: project.ProjectId, projectName: project.Name, website: edgeOneWebsite(project.PresetDomain) };
    await this.save();
  }
  async connectProject(): Promise<void> {
    this.requireShareReady();
    if (this.selectedProject) {
      await this.adopt(await this.project(this.selectedProject));
      this.report("腾讯项目已关联，继续初始化网站。"); return;
    }
    // A saved ID takes precedence after a lost response or interrupted initialization.
    if (this.linked) {
      await this.adopt(await this.project(this.state.projectId!));
      this.report("已恢复腾讯项目，继续初始化网站。"); return;
    }
    const name = (this.draftName || this.site().repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")).trim();
    if (!/^[a-z0-9][a-z0-9-]{3,61}[a-z0-9]$/.test(name)) throw new Error("项目名需为 5–63 位小写字母、数字或连字符，不能以连字符开头或结尾。");
    // Always reconcile before a write. An interrupted create is looked up by name on retry.
    await this.findProjects();
    if (this.candidates.length) {
      this.report("已有项目关联这个仓库，请选择项目后再次点击关联。"); return;
    }
    const named = await this.transport(this.token(), "DescribePagesProjects", { Filters: [{ Name: "Name", Values: [name] }], Offset: 0, Limit: 100 });
    if (!Array.isArray(named.Projects)) throw new Error("无法确认项目名称，请稍后重试。");
    const existing = (named.Projects as EdgeOneProject[]).find(item => item.Name === name);
    if (existing) {
      if (!matchesEdgeOneRepository(existing, this.site())) throw new Error("项目名称已被其他仓库使用，请更换名称。");
      await this.adopt(existing); this.report("已恢复此前创建的项目，继续初始化网站。"); return;
    }
    const site = this.requireShareReady();
    this.state.creationName = name; this.state.repo = repoKey(site); this.state.branch = site.branch;
    await this.save();
    this.report("正在创建项目并关联当前分享仓库…");
    // Source/Channel follow Tencent's official SDK; Git fields follow the Pages v1 contract.
    const response = await this.transport(this.token(), "CreatePagesProject", {
      Name: name, Channel: "Custom", Source: "sdk", Provider: "Github",
      RepoUrl: `https://github.com/${site.owner}/${site.repo}`, RepoOwner: site.owner,
      RepoName: site.repo, RepoBranch: site.branch, Framework: "other", RootDir: ".",
      OutputDir: ".", BuildCmd: "", InstallCmd: "", Area: this.area
    });
    if (typeof response.ProjectId !== "string" || !response.ProjectId) throw new Error("腾讯未返回项目编号，请刷新项目列表确认后重试。");
    this.state.projectId = response.ProjectId; this.state.projectName = name; this.state.step = 3;
    await this.save();
    await this.adopt(await this.project(response.ProjectId));
    this.report("腾讯项目已创建并关联分享仓库，继续初始化网站。");
  }
  private async deployments(): Promise<EdgeOneDeployment[]> {
    const results: EdgeOneDeployment[] = [];
    for (let page = 0; page < 100; page++) {
      const response = await this.transport(this.token(), "DescribePagesDeployments", {
        ProjectId: this.state.projectId, Filters: [{ Name: "RepoBranch", Values: [this.site().branch] }],
        Offset: page, Limit: 100, OrderBy: "CreatedOn", OrderType: "Desc"
      });
      if (!Array.isArray(response.Deployments)) throw new Error("腾讯返回的部署记录格式不正确。");
      const items = response.Deployments as EdgeOneDeployment[];
      results.push(...items);
      if (!items.length || (page + 1) * 100 >= Number(response.TotalCount ?? items.length)) return results;
    }
    throw new Error("部署记录过多，请在腾讯项目页确认。");
  }
  async checkDeployment(): Promise<EdgeOneResult> {
    if (!this.linked) throw new Error("请先关联当前分享仓库的腾讯项目。");
    const commit = await this.latestCommit();
    this.report("正在检查最近一次分享的腾讯部署…");
    const project = await this.project(this.state.projectId!);
    const result = edgeOneDeploymentResult(await this.deployments(), commit, this.site().branch);
    this.state.website = edgeOneWebsite(project.PresetDomain);
    this.state.lastCheck = { ...result, commit, checkedAt: Date.now() };
    this.state.completed = result.kind === "success";
    await this.save(); this.report(result.text);
    return result;
  }
  async initializeWebsite(): Promise<void> {
    if (!this.linked) throw new Error("请先关联腾讯项目。");
    const commit = await this.latestCommit();
    await this.project(this.state.projectId!);
    this.report("正在确认腾讯初始化进度…");
    const records = await this.deployments();
    const existing = records.find(item => item.Env === "Production" && item.RepoBranch === this.site().branch && item.RepoCommitHash === commit);
    if (!existing) {
      this.report("正在请求腾讯部署最近一次分享…");
      await this.transport(this.token(), "CreatePagesDeployment", { ProjectId: this.state.projectId,
        ViaMeta: "Api", Provider: "Github", Env: "Production", RepoBranch: this.site().branch,
        RepoCommitHash: commit, RepoCommitMsg: "Initialize shared notes website" });
    }
    // Query progress instead of inventing a percentage. Returning to settings stops polling.
    for (let attempt = 0; attempt < 24 && !this.stopped; attempt++) {
      const result = await this.checkDeployment();
      if (result.kind === "success") { this.state.step = 3; await this.save(); return; }
      if (result.kind === "error" || result.kind === "unknown") return;
      await new Promise<void>(resolve => window.setTimeout(resolve, 5000));
    }
    if (!this.stopped) this.report("腾讯仍在部署。进度已保留，可稍后点击「检查网站部署」。");
  }
}
