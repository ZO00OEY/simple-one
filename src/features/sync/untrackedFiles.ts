import { desktopProcess, type NodeFs, type NodePath } from "../../shared/desktopNode";
import type { GitCommand } from "./nestedRepos";

export interface UntrackedBackup {
  directory: string;
  files: string[];
  restore(): Promise<void>;
}

/** Preserve local-only files before merge, including files hidden by .gitignore. */
export async function preserveUntrackedFiles(vaultPath: string, git: GitCommand, mergeBase: string): Promise<UntrackedBackup | null> {
  const requireNode = desktopProcess?.versions?.node
    ? (window as unknown as { require?: (name: string) => unknown }).require : undefined;
  if (!requireNode) return null;
  const fs = (requireNode("fs") as NodeFs).promises;
  const path = requireNode("path") as NodePath;
  const root = await fs.realpath(vaultPath);
  if ((await fs.realpath((await git(["rev-parse", "--show-toplevel"])).trim())).toLowerCase() !== root.toLowerCase()) {
    throw new Error("当前 Vault 不是独立 Git 仓库，无法安全备份未追踪文件。");
  }
  const tracked = new Set((await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean));
  // Staged deletions are intentional tracked changes, not local-only files.
  for (const name of (await git(["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0")) tracked.add(name);
  // Only incoming additions/changes can occupy a local path. Ignore unchanged remote files.
  const remote = (await git(["diff", "--name-only", "--no-renames", "--diff-filter=ACMT", "-z", mergeBase, "FETCH_HEAD"])).split("\0").filter(Boolean);
  const candidates = new Set<string>();
  for (const name of remote) {
    const parts = name.split("/");
    const resolved = path.relative(root, path.join(root, name));
    if (parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
        name.includes("\\") || name.includes(":") || path.isAbsolute(name) || resolved.startsWith("..") || path.isAbsolute(resolved)) {
      throw new Error("远端包含不安全的文件路径，已停止同步。");
    }
    for (let count = 1; count <= parts.length; count++) {
      const relative = parts.slice(0, count).join("/");
      const absolute = path.join(root, relative);
      let info;
      try { info = await fs.lstat(absolute); }
      catch (error) {
        if ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR") break;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error(`路径 ${relative} 是符号链接，请先处理后同步。`);
      if (!info.isFile()) {
        if (count === parts.length && !tracked.has(relative) && ![...tracked].some(file => file.startsWith(relative + "/"))) {
          throw new Error(`云端文件 ${relative} 将替换本机未追踪目录，请先移动该目录后同步。`);
        }
        continue;
      }
      if (!tracked.has(relative)) candidates.add(relative);
      break;
    }
  }
  if (!candidates.size) return null;
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"])).trim();
  const directory = path.join(gitDir, "simple-one-untracked-backups", `${Date.now()}-${crypto.randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  const files = [...candidates].sort();
  const moved: string[] = [];
  const restore = async (): Promise<void> => {
    for (const file of [...moved].reverse()) {
      const original = path.join(root, file);
      try { await fs.lstat(original); continue; }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      await fs.mkdir(path.dirname(original), { recursive: true });
      await fs.rename(path.join(directory, "files", file), original);
    }
  };
  // Record the recovery location before moving anything. Backups never enter Git's index.
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version: 1, root, files }, null, 2), "utf8");
  try {
    for (const file of files) {
      const backup = path.join(directory, "files", file);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.rename(path.join(root, file), backup);
      moved.push(file);
    }
  } catch (error) {
    try { await restore(); } catch { /* The original copies remain in the recorded backup directory. */ }
    throw new Error(`未追踪文件备份未完成，已停止同步。已备份内容位于 ${directory}。${String(error)}`);
  }
  return { directory, files, restore };
}
