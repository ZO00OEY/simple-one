import { desktopProcess, base64Bytes, type NodeFs, type NodePath, type NodeCrypto } from "../../shared/desktopNode";
import { describeGitIndexLockError } from "./gitError";
import { defaultSyncIgnorePatterns, recommendedIgnoreRules as setupGitIgnore, shouldIgnore } from "./dirty";
export { recommendedIgnoreRules as setupGitIgnore } from "./dirty";
import { parseGitStatus } from "./gitStatus";
import { findNestedRepos, nestedGitIgnoreRules, nestedRepoFiles, rebuildNestedRepoTracking, seedNestedRepoFiles, NestedRepo } from "./nestedRepos";

const nodeRequire = desktopProcess?.versions?.node
  ? (window as unknown as { require?: (name: string) => unknown }).require : undefined;
const nodeFs = nodeRequire ? (nodeRequire("fs") as NodeFs).promises : null;
const nodeFsStream = nodeRequire ? nodeRequire("fs") as NodeFs : null;
const nodePath = nodeRequire ? nodeRequire("path") as NodePath : null;
const nodeCrypto = nodeRequire ? nodeRequire("crypto") as NodeCrypto : null;

export type OverlapChoice = "local" | "remote";
export interface SetupPreview {
  vaultPath: string;
  repoUrl: string;
  branch: string;
  remoteSha: string;
  alreadyLinked: boolean;
  relatedHistory: boolean;
  localRoot: string | null;
  localBranch: string | null;
  origin: string | null;
  localFiles: string[];
  localSignatures: Record<string, string>;
  remoteFiles: string[];
  remoteBlobs: Record<string, { sha: string; size: number }>;
  overlaps: string[];
  identicalCount: number;
  remoteOnly: string[];
  localOnly: string[];
  missingIgnoreRules: string[];
  nestedRepos: NestedRepo[];
  trackedExcludedLocal: string[];
  trackedExcludedRemote: string[];
  localIgnore: string;
  remoteIgnore: string;
  trackedLocalFiles: string[];
  additionalIgnoredLocal: string[];
  optimizedIgnore: string;
  customIgnore?: string;
}

export interface SetupOverlapContent {
  path: string;
  local: string;
  remote: string;
}

export interface VerifiedRepo {
  url: string;
  owner: string;
  name: string;
  branch: string;
  remoteSha: string;
}

export type RunCommand = (program: string, args: string[], timeoutMs?: number, onOutput?: (chunk: string) => void, stdinText?: string, signal?: AbortSignal) => Promise<string>;

function gitTransferProgress(label: string, report?: (message: string) => void): (chunk: string) => void {
  return chunk => {
    const matches = [...chunk.matchAll(/(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Writing objects):\s*(\d+)%/g)];
    const latest = matches[matches.length - 1];
    if (!latest) return;
    const phase = latest[1] === "Receiving objects" ? "接收对象" : latest[1] === "Resolving deltas" ? "解析差异" : latest[1] === "Counting objects" ? "统计对象" : latest[1] === "Writing objects" ? "发送对象" : "压缩对象";
    report?.(`${label}：${phase} ${latest[2]}%…`);
  };
}


/** Presentation only: keep the original pattern order in the executable plan. */
export function setupIgnoreRuleGroups(preview: Pick<SetupPreview, "nestedRepos">, configDir: string): { title: string; rules: string[] }[] {
  const groups = [{ title: "Git 元数据（默认排除）", rules: [".git/"] }];
  const nestedRules = nestedGitIgnoreRules(preview.nestedRepos);
  if (nestedRules.length) groups.push({ title: "检测到的内嵌仓库（排除其 Git 历史与配置）", rules: nestedRules });
  for (const line of setupGitIgnore(configDir)) {
    if (line === "# Git 元数据" || line === ".git/") continue;
    if (line.startsWith("# ")) groups.push({ title: line.slice(2), rules: [] });
    else groups[groups.length - 1].rules.push(line);
  }
  return groups;
}

/** Categorize the final rules for display without rewriting their executable order. */
export function setupFinalIgnoreRuleGroups(preview: SetupPreview, configDir: string, customTitle = "本机自有规则"): { title: string; rules: string[] }[] {
  const recommendations = setupIgnoreRuleGroups(preview, configDir);
  const groups = recommendations.map(group => ({ title: group.title, rules: [] as string[] }));
  const key = (rule: string) => rule.trim().replace(/^\//, "").replace(/\/$/, "");
  const categories = new Map(recommendations.flatMap((group, index) => group.rules.map(rule => [key(rule), index] as const)));
  const custom: string[] = [];
  for (const line of preview.optimizedIgnore.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const index = categories.get(key(line));
    if (index === undefined) custom.push(line);
    else groups[index].rules.push(line);
  }
  if (custom.length) groups.push({ title: customTitle, rules: custom });
  return groups.filter(group => group.rules.length > 0);
}

export function missingSetupIgnoreRules(existing: string, configDir: string): string[] {
  const patterns = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));
  return setupGitIgnore(configDir).filter((line) => !line.startsWith("#") &&
    !patterns.has(line) && !(line.endsWith("/") && patterns.has(line.slice(0, -1))));
}

/** Generate the same categorized file that is reviewed in the setup screen. */
export function organizedSetupIgnore(base: string, repos: readonly NestedRepo[], configDir: string): string {
  const groups = setupIgnoreRuleGroups({ nestedRepos: [...repos] }, configDir);
  const key = (rule: string) => rule.trim().replace(/^\//, "").replace(/\/$/, "");
  const recommended = new Set(groups.flatMap(group => group.rules.map(key)));
  const generatedHeadings = new Set([
    ...groups.map(group => `# ${group.title}`),
    "# Git 元数据", "# 本机自有规则", "# 远端自有规则", "# 合并后的自有规则",
    "# 同步与分享 recommended local exclusions", "# 系统文件", "# 备份与临时文件",
    "# 本机依赖", "# Obsidian Git 临时冲突清单"
  ]);
  const custom = base.split(/\r?\n/).filter(line => line.trim() &&
    !generatedHeadings.has(line.trim()) &&
    (line.trim().startsWith("#") || !recommended.has(key(line))));
  // Keep the last occurrence: negations and later overrides retain their order.
  const seen = new Set<string>();
  const unique = custom.filter((line, index) => line.trim().startsWith("#") ||
    !custom.slice(index + 1).includes(line));
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const sections = groups.map(group => {
    const rules = group.rules.filter(rule => {
      const normalized = key(rule);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
    return [`# ${group.title}`, ...rules].join(eol);
  });
  if (unique.length) sections.push(["# 本机自有规则", ...unique].join(eol));
  return sections.join(eol + eol) + eol;
}

export function applySetupIgnoreBase(preview: SetupPreview, choice: OverlapChoice, configDir: string): void {
  const base = preview.customIgnore ?? (choice === "remote" ? preview.remoteIgnore : preview.localIgnore);
  const lines = base.split(/\r?\n/);
  const missing = [...missingSetupIgnoreRules(base, configDir), ...nestedGitIgnoreRules(preview.nestedRepos)
    .filter((rule) => !lines.includes(rule))];
  preview.missingIgnoreRules = missing;
  preview.optimizedIgnore = organizedSetupIgnore(base, preview.nestedRepos, configDir);
  const patterns = preview.optimizedIgnore.split(/\r?\n/);
  preview.trackedExcludedLocal = [...new Set([...preview.additionalIgnoredLocal,
    ...preview.trackedLocalFiles.filter((name) => shouldIgnore(name, patterns, configDir) || shouldIgnore(name, setupGitIgnore(configDir), configDir))])].sort();
  preview.trackedExcludedRemote = preview.remoteFiles.filter((name) => shouldIgnore(name, patterns, configDir) || shouldIgnore(name, setupGitIgnore(configDir), configDir));
}

/** Ignore display-only line endings and empty lines at EOF, preserving pattern whitespace. */
export function setupIgnoreComparisonText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

export function setupIgnoreDiffers(preview: SetupPreview): boolean {
  return setupIgnoreComparisonText(preview.localIgnore) !== setupIgnoreComparisonText(preview.remoteIgnore);
}

export function parseGithubRepoUrl(input: string): { url: string; owner: string; name: string } {
  const trimmed = input.trim();
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match || match[2] === "." || match[2] === "..") {
    throw new Error("请输入 GitHub 仓库的 HTTPS 地址，例如 https://github.com/用户名/仓库名.git");
  }
  return { url: `https://github.com/${match[1]}/${match[2]}.git`, owner: match[1], name: match[2] };
}

export function explainSetupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lock = describeGitIndexLockError(message);
  if (lock) return lock;
  if (/ENOENT|is not recognized|spawn (?:git|gh)/i.test(message)) return "缺少 Git 或 GitHub CLI，请先安装后重试。";
  if (/timed? out|could not resolve|DNS|network|failed to connect|unable to access|ETIMEDOUT/i.test(message)) return "网络连接失败或超时，请检查网络与代理后重试。";
  if (/not logged|authentication|token|401|403|permission denied|no authentication/i.test(message)) return "GitHub 登录失效或当前账号没有仓库权限，请重新授权。";
  if (/404|not found|could not read from remote/i.test(message)) return "仓库地址错误，或当前账号无权访问该仓库。";
  return message;
}

function sameGithubRepo(a: string, b: string): boolean {
  const ssh = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/i.exec(a.trim());
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`.toLowerCase() === b.toLowerCase();
  try { return parseGithubRepoUrl(a).url.toLowerCase() === parseGithubRepoUrl(b).url.toLowerCase(); }
  catch { return false; }
}

function hasFileAsParent(path: string, otherFiles: Set<string>): boolean {
  let slash = path.indexOf("/");
  while (slash >= 0) {
    if (otherFiles.has(path.slice(0, slash))) return true;
    slash = path.indexOf("/", slash + 1);
  }
  return false;
}

export function pathBatches(paths: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (current.length && (current.length >= 100 || length + path.length > 12000)) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(path);
    length += path.length + 1;
  }
  if (current.length) batches.push(current);
  return batches;
}

export class GitSetup {
  constructor(private vaultPath: string, private run: RunCommand, private configDir: string) {
    if (!nodeFs || !nodePath) throw new Error("首次使用引导仅支持桌面端");
  }

  async checkTools(): Promise<void> {
    await this.run("git", ["--version"]);
    await this.run("gh", ["--version"]);
  }

  async login(onCode?: (code: string) => void, signal?: AbortSignal): Promise<void> {
    await this.checkTools();
    if (signal?.aborted) return;
    let output = "";
    let lastCode = "";
    await this.run("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"], 300000, (chunk) => {
      output += chunk;
      const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
      if (code && code !== lastCode) { lastCode = code; onCode?.(code); }
    }, undefined, signal);
    await this.checkLogin();
  }

  async loginWithToken(token: string): Promise<void> {
    const value = token.trim();
    if (!value) throw new Error("请先粘贴 GitHub Token。");
    await this.checkTools();
    await this.run("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], 120000, undefined, `${value}\n`);
    await this.checkLogin();
  }

  async checkLogin(): Promise<void> {
    await this.run("gh", ["auth", "status", "--active", "--hostname", "github.com"]);
  }

  async createRepository(name: string): Promise<string> {
    const repoName = name.trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName === "." || repoName === "..") {
      throw new Error("仓库名称只能使用字母、数字、点、下划线或连字符，且不能超过 100 个字符。");
    }
    await this.checkTools();
    await this.checkLogin();
    const owner = (await this.run("gh", ["api", "user", "--jq", ".login"])).trim();
    if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error("无法确认当前 GitHub 登录账号，请重新授权。");
    await this.run("gh", ["repo", "create", `${owner}/${repoName}`, "--private"]);
    return `https://github.com/${owner}/${repoName}.git`;
  }

  async verifyRepository(input: string): Promise<VerifiedRepo> {
    const parsed = parseGithubRepoUrl(input);
    await this.checkLogin();
    const raw = await this.run("gh", ["repo", "view", `${parsed.owner}/${parsed.name}`, "--json", "isPrivate,viewerPermission,defaultBranchRef"]);
    const data = JSON.parse(raw) as { isPrivate?: boolean; viewerPermission?: string; defaultBranchRef?: { name?: string } | null };
    if (data.isPrivate !== true) throw new Error("该仓库不是私人仓库。请在 GitHub 仓库设置中改为 Private 后重试。");
    if (!new Set(["ADMIN", "MAINTAIN", "WRITE"]).has(data.viewerPermission ?? "")) {
      throw new Error("当前 GitHub 账号没有此仓库的写入权限。");
    }
    const branch = data.defaultBranchRef?.name || "main";
    const branchRaw = data.defaultBranchRef?.name
      ? await this.run("gh", ["api", `repos/${parsed.owner}/${parsed.name}/branches/${encodeURIComponent(branch)}`])
      : "";
    const remoteSha = branchRaw ? (JSON.parse(branchRaw) as { commit?: { sha?: string } }).commit?.sha ?? "" : "";
    return { ...parsed, branch, remoteSha };
  }

  private async localRoot(): Promise<string | null> {
    try { return (await this.run("git", ["rev-parse", "--show-toplevel"])).trim(); }
    catch { return null; }
  }

  private async readIgnore(): Promise<string> {
    try { return await nodeFs!.readFile(nodePath!.join(this.vaultPath, ".gitignore"), "utf8"); }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "";
      throw error;
    }
  }

  private async localFiles(root: string | null, nestedRepos: readonly NestedRepo[]): Promise<string[]> {
    if (root) {
      const output = await this.run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
      const nested = await nestedRepoFiles(this.vaultPath, nestedRepos, (args) => this.run("git", args), this.configDir);
      const files: string[] = [];
      for (const name of new Set([...output.split("\0").filter(Boolean), ...nested])) {
        try {
          if ((await nodeFs!.stat(nodePath!.join(this.vaultPath, name))).isFile()) files.push(name);
        } catch { /* tracked file deleted locally */ }
      }
      return files.sort();
    }
    let existingIgnore: string[] = [];
    try {
      existingIgnore = (await nodeFs!.readFile(nodePath!.join(this.vaultPath, ".gitignore"), "utf8")).split(/\r?\n/);
    } catch { /* no existing .gitignore */ }
    const patterns = [...defaultSyncIgnorePatterns(this.configDir), ...existingIgnore];
    const found: string[] = [];
    const visit = async (folder: string): Promise<void> => {
      for (const item of await nodeFs!.readdir(folder, { withFileTypes: true })) {
        const absolute = nodePath!.join(folder, item.name);
        const name = nodePath!.relative(this.vaultPath, absolute).replace(/\\/g, "/");
        if (item.name === ".git") {
          continue;
        }
        if (shouldIgnore(name, patterns, this.configDir)) continue;
        if (item.isDirectory()) await visit(absolute);
        else if (item.isFile()) found.push(name);
      }
    };
    await visit(this.vaultPath);
    return found.sort();
  }

  async preview(repo: VerifiedRepo, onProgress?: (message: string) => void): Promise<SetupPreview> {
    onProgress?.("1 · 检查本地仓库、分支与未完成的 Git 操作…");
    const localRoot = await this.localRoot();
    if (localRoot && (await nodeFs!.realpath(localRoot)).toLowerCase() !== (await nodeFs!.realpath(this.vaultPath)).toLowerCase()) {
      throw new Error(`当前 Vault 位于另一个 Git 仓库内部：${localRoot}。请先独立设置 Vault 仓库。`);
    }
    let localBranch: string | null = null;
    if (localRoot) {
      try { localBranch = (await this.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim(); }
      catch { throw new Error("本机仓库当前处于 detached HEAD。请先切换到要同步的本地分支，再重新检查。"); }
      for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
        let exists = false;
        try { await this.run("git", ["rev-parse", "--verify", "-q", ref]); exists = true; }
        catch { /* no interrupted operation */ }
        if (exists) throw new Error(`检测到未完成的 ${ref} 操作，请先在 Git 中处理后重新检查。`);
      }
    }
    let origin: string | null = null;
    if (localRoot) {
      try { origin = await this.run("git", ["config", "--get", "remote.origin.url"]); } catch { /* no origin */ }
      if (origin && !sameGithubRepo(origin, repo.url)) {
        throw new Error("现有 origin 指向其他仓库或包含凭据。向导不会覆盖它。");
      }
    }
    onProgress?.("2 · 扫描本地文件与内嵌仓库…");
    const nestedRepos = await findNestedRepos(this.vaultPath, this.configDir);
    const nestedUserData = new Set((await nestedRepoFiles(this.vaultPath, nestedRepos, (args) => this.run("git", args), this.configDir))
      .filter((name) => nestedRepos.some((repo) => name === `${repo.directory}/data.json`)));
    const localFiles = await this.localFiles(localRoot, nestedRepos);
    const trackedLocal = localRoot
      ? (await this.run("git", ["ls-files", "--cached", "-z"])).split("\0").filter(Boolean)
      : [];
    const trackedIgnoredLocal = localRoot
      ? (await this.run("git", ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
      : [];
    const localSignatures: Record<string, string> = {};
    const localGitBlobs: Record<string, string> = {};
    let hashed = 0;
    let lastProgress = Date.now();
    onProgress?.(`3 · 计算本地文件哈希：0 / ${localFiles.length}…`);
    for (const file of localFiles) {
      const stat = await nodeFs!.stat(nodePath!.join(this.vaultPath, file));
      const hash = nodeCrypto!.createHash("sha256");
      const gitHash = nodeCrypto!.createHash("sha1").update(`blob ${stat.size}\0`);
      for await (const chunk of nodeFsStream!.createReadStream(nodePath!.join(this.vaultPath, file))) {
        if (!(chunk instanceof Uint8Array)) throw new Error("无法读取本地文件字节，已停止检查。");
        hash.update(chunk);
        gitHash.update(chunk);
      }
      localSignatures[file] = `${stat.size}:${hash.digest("hex")}`;
      localGitBlobs[file] = gitHash.digest("hex");
      hashed++;
      if (hashed === localFiles.length || Date.now() - lastProgress >= 250) {
        onProgress?.(`3 · 计算本地文件哈希：${hashed} / ${localFiles.length}…`);
        lastProgress = Date.now();
      }
    }
    onProgress?.("4 · 检查本地与云端的提交历史…");
    let alreadyLinked = false;
    let relatedHistory = false;
    if (localRoot && repo.remoteSha) {
      let hasHead = false;
      try { await this.run("git", ["rev-parse", "--verify", "HEAD"]); hasHead = true; }
      catch { /* local repository has no commits */ }
      if (hasHead) {
        try { await this.run("git", ["cat-file", "-e", `${repo.remoteSha}^{commit}`]); }
        catch {
          // Download commit objects only; leave refs, index, and working files untouched.
          onProgress?.("4 · Fetch：获取云端提交记录…");
          await this.run("git", ["fetch", "--progress", "--no-tags", "--no-write-fetch-head", repo.url, repo.branch], undefined, gitTransferProgress("4 · Fetch", onProgress));
          await this.run("git", ["cat-file", "-e", `${repo.remoteSha}^{commit}`]);
        }
        onProgress?.("4 · Merge-base：检查两端共同历史与合并关系…");
        try { await this.run("git", ["merge-base", "HEAD", repo.remoteSha]); relatedHistory = true; }
        catch { /* independently created repositories */ }
        if (relatedHistory) {
          try { await this.run("git", ["merge-base", "--is-ancestor", repo.remoteSha, "HEAD"]); alreadyLinked = true; }
          catch { /* remote has commits that are not yet local */ }
        }
      }
    }
    if (relatedHistory && localBranch !== repo.branch) {
      throw new Error(`本机当前分支是 ${localBranch}，远端默认分支是 ${repo.branch}。请先切换到要同步的 ${repo.branch} 分支，再重新检查。`);
    }
    if (localRoot) {
      if (trackedLocal.includes(`${this.configDir}/plugins/simple-one-sync/data.json`) || trackedLocal.includes(`${this.configDir}/plugins/zoey-sync-test/data.json`)) {
        throw new Error("本地 Git 正在跟踪插件的本机凭据文件 data.json。请先停止跟踪该文件，再继续接入。");
      }
      const staged = await this.run("git", ["ls-files", "--stage", "-z"]);
      const nestedPaths = new Set(nestedRepos.map((item) => item.directory));
      if (staged.split("\0").some((line) => line.startsWith("160000 ") && !nestedPaths.has(line.slice(line.indexOf("\t") + 1)))) {
        throw new Error("本地 Git 包含子模块，向导暂不支持自动接入。");
      }
    }
    let remoteFiles: string[] = [];
    const remoteBlobs: Record<string, { sha: string; size: number }> = {};
    onProgress?.("5 · 读取云端文件列表…");
    if (repo.remoteSha) {
      const raw = await this.run("gh", ["api", `repos/${repo.owner}/${repo.name}/git/trees/${repo.remoteSha}?recursive=1`]);
      const tree = JSON.parse(raw) as { truncated?: boolean; tree?: Array<{ path: string; type: string; sha?: string; size?: number }> };
      if (tree.truncated) throw new Error("远端文件列表过大，GitHub 只返回了部分文件；向导已停止，请先缩小仓库或手动接入。");
      if (tree.tree?.some((item) => item.type === "commit")) throw new Error("远端仓库包含 Git 子模块，向导暂不支持自动接入。");
      remoteFiles = (tree.tree ?? []).filter((item) => item.type === "blob").map((item) => {
        remoteBlobs[item.path] = { sha: item.sha ?? "", size: item.size ?? 0 };
        return item.path;
      }).sort();
      if (remoteFiles.includes(`${this.configDir}/plugins/simple-one-sync/data.json`) || remoteFiles.includes(`${this.configDir}/plugins/zoey-sync-test/data.json`)) {
        throw new Error("远端正在跟踪插件的本机凭据文件 data.json。请先从远端历史中处理它，再继续接入。");
      }
    }
    onProgress?.(`6 · 对比文件与路径：本地 ${localFiles.length} 个，云端 ${remoteFiles.length} 个…`);
    const localSet = new Set(localFiles);
    const remoteSet = new Set(remoteFiles);
    const remoteOnly = remoteFiles.filter((name) => !localSet.has(name));
    const deletedTrackedRemote = !alreadyLinked ? remoteOnly.filter((name) => trackedLocal.includes(name)) : [];
    if (deletedTrackedRemote.length > 0) {
      throw new Error(`本机已删除但远端仍有同名文件：${deletedTrackedRemote.slice(0, 3).join("、")}。请先手动确认后重新检查。`);
    }
    const ignoredLocalCollisions: string[] = [];
    for (const name of remoteOnly) {
      try {
        await nodeFs!.lstat(nodePath!.join(this.vaultPath, name));
        ignoredLocalCollisions.push(name);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
    }
    if (ignoredLocalCollisions.length > 0) {
      throw new Error(`远端文件与本机已忽略的现有路径重名：${ignoredLocalCollisions.slice(0, 3).join("、")}。请先备份并手动整理后重新检查。`);
    }
    const identicalCount = localFiles.filter((name) => remoteBlobs[name]?.sha.length === 40 &&
      localGitBlobs[name] === remoteBlobs[name].sha).length;
    const overlaps = relatedHistory ? [] : localFiles.filter((name) => name !== ".gitignore" && remoteSet.has(name) &&
      (remoteBlobs[name]?.sha.length !== 40 || localGitBlobs[name] !== remoteBlobs[name].sha));
    const prefixCollision = localFiles.some((name) => hasFileAsParent(name, remoteSet)) ||
      remoteFiles.some((name) => hasFileAsParent(name, localSet));
    if (prefixCollision) throw new Error("两端存在同名文件与目录冲突，需要先手动整理后再接入。");
    onProgress?.("7 · 核对本地与云端的忽略规则及追踪范围…");
    const existingIgnore = await this.readIgnore();
    let remoteIgnore = "";
    if (remoteFiles.includes(".gitignore")) {
      const raw = await this.run("gh", ["api", `repos/${repo.owner}/${repo.name}/git/blobs/${remoteBlobs[".gitignore"].sha}`]);
      const data = JSON.parse(raw) as { encoding?: string; content?: string };
      if (data.encoding !== "base64" || typeof data.content !== "string") throw new Error("无法读取远端 .gitignore，请重新检查。");
      remoteIgnore = new TextDecoder("utf-8", { fatal: true }).decode(base64Bytes(data.content.replace(/\s/g, "")));
    }
    const nestedRules = nestedGitIgnoreRules(nestedRepos);
    const effectiveIgnore = [...existingIgnore.split(/\r?\n/), ...setupGitIgnore(this.configDir), ...nestedRules];
    const result: SetupPreview = {
      vaultPath: this.vaultPath, repoUrl: repo.url, branch: repo.branch, remoteSha: repo.remoteSha, alreadyLinked, relatedHistory,
      localRoot, localBranch, origin, localFiles, localSignatures, remoteFiles, remoteBlobs, overlaps, identicalCount,
      remoteOnly,
      localOnly: localFiles.filter((name) => !remoteSet.has(name)),
      missingIgnoreRules: [...missingSetupIgnoreRules(existingIgnore, this.configDir), ...nestedRules.filter((rule) => !existingIgnore.split(/\r?\n/).includes(rule))],
      nestedRepos,
      localIgnore: existingIgnore, remoteIgnore, trackedLocalFiles: trackedLocal, optimizedIgnore: "",
      additionalIgnoredLocal: trackedIgnoredLocal.filter((name) => !nestedUserData.has(name) && !shouldIgnore(name, existingIgnore.split(/\r?\n/), this.configDir)),
      trackedExcludedLocal: [...new Set([...trackedIgnoredLocal.filter((name) => !nestedUserData.has(name)), ...trackedLocal.filter((name) => shouldIgnore(name, setupGitIgnore(this.configDir), this.configDir))])].sort(),
      trackedExcludedRemote: remoteFiles.filter((name) => shouldIgnore(name, effectiveIgnore, this.configDir))
    };
    applySetupIgnoreBase(result, "local", this.configDir);
    onProgress?.(`✓ 检查完成：本地 ${localFiles.length} 个文件，云端 ${remoteFiles.length} 个文件，同名差异 ${overlaps.length} 个。`);
    return result;
  }

  async readOverlap(repo: VerifiedRepo, preview: SetupPreview, file: string): Promise<SetupOverlapContent> {
    if (!preview.overlaps.includes(file)) throw new Error("该文件不在同名文件列表中，请重新检查第 3 步。");
    const absolute = nodePath!.resolve(this.vaultPath, file);
    const vault = nodePath!.resolve(this.vaultPath);
    if (!absolute.toLowerCase().startsWith(`${vault}${nodePath!.sep}`.toLowerCase())) throw new Error("文件路径超出 Vault");
    const localStat = await nodeFs!.stat(absolute);
    const local = localStat.size > 100000
      ? `文件较大（${localStat.size} 字节），请在 Obsidian 中打开本机文件查看。`
      : this.describeContent(await nodeFs!.readFile(absolute));
    const blob = preview.remoteBlobs[file];
    if (!blob?.sha) throw new Error("缺少远端文件信息，请重新检查第 3 步。");
    if (blob.size > 100000) return { path: file, local, remote: `远端文件较大（${blob.size} 字节），请在 GitHub 仓库网页查看。` };
    const raw = await this.run("gh", ["api", `repos/${repo.owner}/${repo.name}/git/blobs/${blob.sha}`]);
    const data = JSON.parse(raw) as { content?: string; encoding?: string };
    if (data.encoding !== "base64" || !data.content) throw new Error("无法读取远端文件内容");
    return { path: file, local, remote: this.describeContent(base64Bytes(data.content.replace(/\s/g, ""))) };
  }

  private describeContent(buffer: Uint8Array): string {
    if (buffer.includes(0)) return `二进制文件（${buffer.length} 字节），请在对应位置查看原文件。`;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer).slice(0, 10000); }
    catch { return `非 UTF-8 文本或二进制文件（${buffer.length} 字节）。`; }
  }

  async appendIgnore(repos: readonly NestedRepo[]): Promise<void> {
    const file = nodePath!.join(this.vaultPath, ".gitignore");
    const existing = await this.readIgnore();
    const organized = organizedSetupIgnore(existing, repos, this.configDir);
    if (organized !== existing) await nodeFs!.writeFile(file, organized, "utf8");
  }

  private async rebuildTrackingIndex(paths: string[], skipped: ReadonlySet<string>, repos: readonly NestedRepo[]): Promise<void> {
    for (const path of paths) {
      try { await this.run("git", ["check-ignore", "--no-index", "-q", "--", path]); }
      catch { throw new Error(`不能确认 .gitignore 会排除 ${path}，已停止重建 Git 追踪。请检查排除规则后重新预览。`); }
    }
    await this.run("git", ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", "."]);
    await seedNestedRepoFiles(this.vaultPath, repos, (args) => this.run("git", args), this.configDir, skipped);
    await this.run("git", ["add", "-A"]);
    if (skipped.size) {
      const staged = new Set((await this.run("git", ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean));
      for (const batch of pathBatches([...skipped].filter((path) => staged.has(path)))) {
        await this.run("git", ["reset", "-q", "HEAD", "--", ...batch]);
      }
    }
    const allowedData = new Set((await nestedRepoFiles(this.vaultPath, repos, (args) => this.run("git", args), this.configDir))
      .filter((name) => repos.some((repo) => name === `${repo.directory}/data.json`)));
    const remaining = (await this.run("git", ["ls-files", "-ci", "--exclude-standard", "-z"])).split("\0").filter((name) => name && !allowedData.has(name));
    if (remaining.length) throw new Error(`重建后仍有 ${remaining.length} 个被忽略的文件受到追踪，请检查 .gitignore 后重试。`);
  }

  async finish(
    repo: VerifiedRepo,
    prior: SetupPreview,
    choices: Record<string, OverlapChoice>,
    author: { name: string; email: string },
    onMutationStart?: () => Promise<void>,
    activelyChangingPaths: ReadonlySet<string> = new Set(),
    rebuildTracking = false,
    onProgress?: (stage: string) => void
  ): Promise<string[]> {
    onProgress?.("核验仓库与授权");
    const verified = await this.verifyRepository(repo.url);
    onProgress?.("重新检查两端文件与忽略规则");
    const latest = await this.preview(verified, message => onProgress?.(`重新检查 · ${message}`));
    const ignoreDiffers = setupIgnoreDiffers(latest);
    if (latest.localIgnore !== prior.localIgnore || latest.remoteIgnore !== prior.remoteIgnore) {
      throw new Error(".gitignore 在预览后发生变化，请重新检查两端规则。");
    }
    if (ignoreDiffers && !choices[".gitignore"]) throw new Error("请选择以本机或远端 .gitignore 为基准。");
    latest.customIgnore = prior.customIgnore;
    applySetupIgnoreBase(latest, choices[".gitignore"] || "local", this.configDir);
    if (verified.branch !== prior.branch || latest.alreadyLinked !== prior.alreadyLinked ||
        latest.relatedHistory !== prior.relatedHistory ||
        JSON.stringify(latest.remoteFiles) !== JSON.stringify(prior.remoteFiles) ||
        latest.remoteSha !== prior.remoteSha || latest.origin !== prior.origin || latest.localBranch !== prior.localBranch) {
      throw new Error("远端或仓库状态在预览后发生变化，请重新检查第 3 步。");
    }
    if (JSON.stringify(latest.trackedExcludedLocal) !== JSON.stringify(prior.trackedExcludedLocal) ||
        JSON.stringify(latest.trackedExcludedRemote) !== JSON.stringify(prior.trackedExcludedRemote)) {
      throw new Error("已被 Git 跟踪的忽略文件在预览后发生变化，请重新检查第 3 步。");
    }
    const changedSincePreview = new Set([...new Set([...prior.localFiles, ...latest.localFiles])]
      .filter((file) => prior.localSignatures[file] !== latest.localSignatures[file]));
    if (changedSincePreview.has(".gitignore") ||
        JSON.stringify(latest.missingIgnoreRules) !== JSON.stringify(prior.missingIgnoreRules)) {
      throw new Error(".gitignore 在预览后发生变化，请重新检查第 3 步的待补规则。");
    }
    const active = new Set([...changedSincePreview, ...activelyChangingPaths]);
    const pluginPrefix = `${this.configDir}/plugins/`;
    const pluginDirs = new Set([...active].filter(file => file.startsWith(pluginPrefix) && file.length > pluginPrefix.length)
      .map(file => pluginPrefix + file.slice(pluginPrefix.length).split("/")[0] + "/"));
    const changedOutsidePlugins = [...changedSincePreview].filter((file) => ![...pluginDirs].some((dir) => file.startsWith(dir)));
    if (!latest.alreadyLinked && changedOutsidePlugins.length > 0) {
      throw new Error("首次合并前本地文件在预览后发生变化，请重新检查第 3 步。");
    }
    const skipped = new Set<string>(changedSincePreview);
    const changes = latest.localRoot
      ? parseGitStatus(await this.run("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"]))
      : [];
    const dirtyPaths = new Set(changes.flatMap((change) => [change.path, change.oldPath].filter((file): file is string => !!file)));
    for (const file of latest.localFiles) {
      if ((!latest.localRoot || dirtyPaths.has(file)) &&
          (active.has(file) || [...pluginDirs].some((dir) => file.startsWith(dir)))) skipped.add(file);
    }
    if (!latest.relatedHistory && latest.overlaps.some((file) => skipped.has(file))) {
      throw new Error("正在编辑的插件与远端存在同名文件。请暂停编辑并重新检查第 3 步，避免首次合并覆盖本机文件。");
    }
    if (latest.localRoot) {
      for (const change of changes) {
        if ([change.path, change.oldPath].some((file) => file && (active.has(file) || [...pluginDirs].some((dir) => file.startsWith(dir))))) {
          skipped.add(change.path);
          if (change.oldPath) skipped.add(change.oldPath);
        }
      }
    }
    if (latest.relatedHistory && !latest.alreadyLinked && skipped.size > 0) {
      const base = (await this.run("git", ["merge-base", "HEAD", latest.remoteSha])).trim();
      const remoteChanges = (await this.run("git", ["diff", "--name-only", "-z", base, latest.remoteSha])).split("\0").filter(Boolean);
      const overlap = remoteChanges.find((file) => skipped.has(file));
      if (overlap) throw new Error(`远端也修改了正在编辑的文件 ${overlap}。请先暂停编辑并处理该文件，再重新检查第 3 步。`);
    }
    for (const file of latest.overlaps) if (!choices[file]) throw new Error(`请选择同名文件的保留版本：${file}`);
    if (!author.name.trim() || !author.email.trim() || author.name === "default" || author.email === "default@default.com") {
      throw new Error("请填写 Git 提交作者名称和邮箱。");
    }
    await onMutationStart?.();
    onProgress?.("准备仓库与文件追踪");
    if (!latest.localRoot) await this.run("git", ["init", "-b", repo.branch]);
    await this.run("git", ["config", "user.name", author.name]);
    await this.run("git", ["config", "user.email", author.email]);
    if (!latest.origin) await this.run("git", ["remote", "add", "origin", repo.url]);
    await nodeFs!.writeFile(nodePath!.join(this.vaultPath, ".gitignore"), latest.optimizedIgnore, "utf8");
    if (latest.localRoot) await rebuildNestedRepoTracking(this.vaultPath, latest.nestedRepos, (args) => this.run("git", args), this.configDir);
    let hasHead = false;
    try { await this.run("git", ["rev-parse", "--verify", "HEAD"]); hasHead = true; }
    catch { /* new repository */ }
    await seedNestedRepoFiles(this.vaultPath, latest.nestedRepos, (args) => this.run("git", args), this.configDir, skipped);
    if (hasHead) await this.run("git", ["add", "-A"]);
    else {
      const eligible = new Set((await this.run("git", ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean));
      const included = [...new Set([...latest.localFiles, ".gitignore"])].filter((file) => !skipped.has(file) && eligible.has(file));
      for (const batch of pathBatches(included)) await this.run("git", ["add", "-A", "--", ...batch]);
    }
    if (hasHead && skipped.size > 0) {
      const stagedPaths = new Set((await this.run("git", ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean));
      for (const batch of pathBatches([...skipped].filter((file) => stagedPaths.has(file)))) {
        await this.run("git", ["reset", "-q", "HEAD", "--", ...batch]);
      }
    }
    if (latest.alreadyLinked) {
      const staged = (await this.run("git", ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
      const changedDuringStage: string[] = [];
      for (const file of staged) {
        try {
          const stat = await nodeFs!.stat(nodePath!.join(this.vaultPath, file));
          const hash = nodeCrypto!.createHash("sha256");
          for await (const chunk of nodeFsStream!.createReadStream(nodePath!.join(this.vaultPath, file))) {
            if (!(chunk instanceof Uint8Array)) throw new Error("无法读取本地文件字节，已停止检查。");
            hash.update(chunk);
          }
          if (`${stat.size}:${hash.digest("hex")}` !== latest.localSignatures[file] && file !== ".gitignore") changedDuringStage.push(file);
        } catch {
          if (latest.localSignatures[file]) changedDuringStage.push(file);
        }
      }
      for (const batch of pathBatches(changedDuringStage)) await this.run("git", ["reset", "-q", "HEAD", "--", ...batch]);
      for (const file of changedDuringStage) skipped.add(file);
    }
    if (rebuildTracking && hasHead) {
      onProgress?.("重建已有文件的追踪");
      await this.rebuildTrackingIndex(latest.trackedExcludedLocal, skipped, latest.nestedRepos);
    }
    onProgress?.("创建本地提交");
    try {
      await this.run("git", ["diff", "--cached", "--quiet"]);
    } catch {
      await this.run("git", ["commit", "-m", "同步与分享 initial vault snapshot"]);
    }
    if (repo.remoteSha) {
      onProgress?.("Fetch：获取并核验远端提交…");
      await this.run("git", ["fetch", "--progress", "origin", repo.branch], undefined, gitTransferProgress("Fetch", onProgress));
      const fetchedSha = await this.run("git", ["rev-parse", "FETCH_HEAD"]);
      if (fetchedSha !== repo.remoteSha) throw new Error("远端分支在检查后更新了。尚未合并或推送，请重新预览。");
      let containsRemote = false;
      try { await this.run("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"]); containsRemote = true; } catch { /* needs merge */ }
      if (!containsRemote) {
        onProgress?.("Merge：合并本地与远端文件…");
        try {
          await this.run("git", latest.relatedHistory
            ? ["merge", "--no-commit", "--no-ff", "FETCH_HEAD"]
            : ["merge", "--allow-unrelated-histories", "--no-commit", "--no-ff", "-s", "ours", "FETCH_HEAD"]);
        } catch (error) {
          try { await this.run("git", ["merge", "--abort"]); } catch { /* retain Git's diagnostic */ }
          throw new Error(latest.relatedHistory
            ? `同源仓库合并出现冲突；已尝试撤销本次合并。请先处理冲突后重新检查第 3 步。${String(error)}`
            : String(error));
        }
        try {
          const fromRemote = latest.relatedHistory ? [] :
            [...latest.remoteOnly, ...latest.overlaps.filter((name) => choices[name] === "remote")].filter((name) => name !== ".gitignore");
          for (const batch of pathBatches(fromRemote)) await this.run("git", ["checkout", "FETCH_HEAD", "--", ...batch]);
          await nodeFs!.writeFile(nodePath!.join(this.vaultPath, ".gitignore"), latest.optimizedIgnore, "utf8");
          await this.run("git", ["add", "-A"]);
          if (skipped.size > 0) {
            const stagedPaths = new Set((await this.run("git", ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean));
            for (const batch of pathBatches([...skipped].filter((file) => stagedPaths.has(file)))) {
              await this.run("git", ["reset", "-q", "HEAD", "--", ...batch]);
            }
          }
          if (rebuildTracking) await this.rebuildTrackingIndex(
            [...new Set([...latest.trackedExcludedLocal, ...latest.trackedExcludedRemote])], skipped, latest.nestedRepos);
          await this.run("git", ["commit", "-m", "同步与分享 connect local and remote notes"]);
        } catch (error) {
          try { await this.run("git", ["merge", "--abort"]); } catch { /* keep Git's diagnostics */ }
          throw error;
        }
      }
    }
    onProgress?.("首次推送到 GitHub");
    await this.run("git", ["push", "--progress", "-u", "origin", `HEAD:${repo.branch}`], undefined, gitTransferProgress("Push：首次推送", onProgress));
    return [...skipped].sort();
  }
}
