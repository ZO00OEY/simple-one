import { desktopProcess, type NodeFs, type NodePath } from "../../shared/desktopNode";
import { defaultSyncIgnorePatterns, shouldIgnore } from "./dirty";

const nodeRequire = desktopProcess?.versions?.node
  ? (window as unknown as { require?: (name: string) => unknown }).require : undefined;
const fs = nodeRequire ? (nodeRequire("fs") as NodeFs).promises : null;
const path = nodeRequire ? nodeRequire("path") as NodePath : null;

export interface NestedRepo { directory: string; gitIsDirectory: boolean }
export type GitCommand = (args: string[]) => Promise<string>;

export async function findNestedRepos(vaultPath: string, configDir: string): Promise<NestedRepo[]> {
  if (!fs || !path) throw new Error("内嵌仓库检查仅支持桌面端");
  const found: NestedRepo[] = [];
  const visit = async (folder: string): Promise<void> => {
    if (path.relative(vaultPath, folder).replace(/\\/g, "/").split("/")[0] === ".gitshare") return;
    const entries = await fs.readdir(folder, { withFileTypes: true });
    if (folder !== vaultPath) {
      const git = entries.find((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()));
      if (git) found.push({ directory: path.relative(vaultPath, folder).replace(/\\/g, "/"), gitIsDirectory: git.isDirectory() });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const absolute = path.join(folder, entry.name);
      const relative = path.relative(vaultPath, absolute).replace(/\\/g, "/");
      if (!shouldIgnore(relative, defaultSyncIgnorePatterns(configDir), configDir)) await visit(absolute);
    }
  };
  await visit(vaultPath);
  return found;
}

export function nestedGitIgnoreRules(repos: readonly NestedRepo[]): string[] {
  return repos.map((repo) => `/${repo.directory}/.git${repo.gitIsDirectory ? "/" : ""}`);
}

export async function nestedRepoFiles(vaultPath: string, repos: readonly NestedRepo[], git: GitCommand, configDir: string): Promise<string[]> {
  if (!path || !fs) throw new Error("内嵌仓库检查仅支持桌面端");
  const files: string[] = [];
  let vaultIgnore: string[] = [];
  try { vaultIgnore = (await fs.readFile(path.join(vaultPath, ".gitignore"), "utf8")).split(/\r?\n/); }
  catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  for (const repo of repos) {
    if (repo.directory === ".gitshare" || repo.directory.startsWith(".gitshare/")) continue;
    const absolute = path.join(vaultPath, repo.directory);
    const listed = await git(["-C", absolute, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    for (const name of listed.split("\0").filter(Boolean)) {
      if (name === ".git" || name.startsWith(".git/") || name.startsWith("../") || path.isAbsolute(name)) continue;
      const relative = `${repo.directory}/${name.replace(/\\/g, "/")}`;
      // The vault's exclusions govern ordinary child files too, not just data.json.
      if (shouldIgnore(relative, [...defaultSyncIgnorePatterns(configDir), ...vaultIgnore], configDir)) continue;
      try {
        if ((await fs.lstat(path.join(vaultPath, relative))).isFile()) files.push(relative);
      } catch { /* deleted child file */ }
    }
    // Public plugin repositories commonly ignore private data.json. The vault
    // keeps that user configuration unless its own ignore rules exclude it.
    const data = `${repo.directory}/data.json`;
    if (repo.directory.startsWith(`${configDir}/plugins/`) && repo.directory.slice(`${configDir}/plugins/`.length).split("/").length === 1 &&
        !shouldIgnore(data, [...defaultSyncIgnorePatterns(configDir), ...vaultIgnore], configDir)) {
      try { if ((await fs.lstat(path.join(vaultPath, data))).isFile()) files.push(data); }
      catch { /* plugin has no data.json */ }
    }
  }
  return [...new Set(files)].sort();
}

// A plain `git add -A` records a new embedded repository as a gitlink. Seeding
// one regular file in the parent index makes later `git add -A` traverse it.
export async function seedNestedRepoFiles(vaultPath: string, repos: readonly NestedRepo[], git: GitCommand, configDir: string, skip: ReadonlySet<string> = new Set()): Promise<void> {
  if (!fs || !path) throw new Error("内嵌仓库检查仅支持桌面端");
  const tracked = new Set((await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean));
  const candidates = await nestedRepoFiles(vaultPath, repos, git, configDir);
  const stage = async (file: string): Promise<void> => {
    const info = await fs.stat(path.join(vaultPath, file));
    const mode = info.mode & 0o111 ? "100755" : "100644";
    const sha = (await git(["hash-object", "-w", "--", file])).trim();
    await git(["update-index", "--add", "--cacheinfo", `${mode},${sha},${file}`]);
    tracked.add(file);
  };
  for (const repo of repos) {
    const prefix = `${repo.directory}/`;
    if (![...tracked].some((file) => file.startsWith(prefix))) {
      const file = candidates.find((name) => name.startsWith(prefix) && !skip.has(name));
      if (file) await stage(file);
    }
    const data = `${repo.directory}/data.json`;
    if (candidates.includes(data) && !tracked.has(data) && !skip.has(data)) await stage(data);
  }
}

// Reconcile only embedded repositories. Other staged vault changes are left as-is.
export async function rebuildNestedRepoTracking(vaultPath: string, repos: readonly NestedRepo[], git: GitCommand, configDir: string): Promise<number> {
  if (!repos.length) return 0;
  if (fs && path) {
    try {
      await fs.access(path.join(vaultPath, ".gitmodules"));
      const modules = await git(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
      const paths = new Set(modules.split(/\r?\n/).map((line) => line.slice(line.indexOf(" ") + 1).trim()));
      if (repos.some((repo) => paths.has(repo.directory))) {
        throw new Error("检测到正式 Git 子模块；请先单独处理 .gitmodules，向导不会将其改成普通目录。");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("正式 Git 子模块")) throw error;
      // No submodule declarations.
    }
  }
  const before = new Set((await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean));
  const staged = (await git(["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
  for (const repo of repos) {
    if (staged.some((line) => line.startsWith("160000 ") && line.endsWith(`\t${repo.directory}`))) {
      await git(["rm", "-f", "--cached", "--", repo.directory]);
    }
  }
  await seedNestedRepoFiles(vaultPath, repos, git, configDir);
  const files = await nestedRepoFiles(vaultPath, repos, git, configDir);
  for (const repo of repos) {
    if (files.some((file) => file.startsWith(`${repo.directory}/`)) ||
        [...before].some((file) => file.startsWith(`${repo.directory}/`))) {
      await git(["add", "-A", "--", repo.directory]);
    }
  }
  const after = new Set((await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean));
  const missing = files.filter((file) => !after.has(file));
  if (missing.length) throw new Error(`主仓库仍未追踪内嵌仓库文件 ${missing[0]}；请检查主仓库的其他忽略规则。`);
  if (repos.some((repo) => after.has(repo.directory))) {
    throw new Error("主仓库仍把内嵌仓库记录为 Git 引用，未能重建普通文件追踪。");
  }
  return files.filter((file) => !before.has(file)).length;
}
