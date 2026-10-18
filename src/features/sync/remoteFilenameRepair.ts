import { sanitizeNoteFilename } from "../../shared/noteFilename";

type RunGit = (args: string[], authenticated?: boolean, stdin?: string) => Promise<string>;
interface TreeEntry { mode: string; type: string; oid: string; name: string }

export function isInvalidGitPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:error|fatal):\s*invalid path\b/i.test(message);
}

export function hasCaseInsensitivePathCollisions(paths: string[]): boolean {
  const names = new Map<string, string>();
  for (const path of paths) {
    let prefix = "";
    for (const part of path.split("/")) {
      prefix += `/${part}`;
      const key = prefix.toLowerCase();
      if (names.has(key) && names.get(key) !== prefix) return true;
      names.set(key, prefix);
    }
  }
  return false;
}

/** Rewrite trees without checking out Windows-incompatible paths or touching the local index. */
export async function repairRemoteFilenames(git: RunGit, branch: string): Promise<string[]> {
  const parent = (await git(["rev-parse", "FETCH_HEAD"])).trim();
  const renamed: string[] = [];
  const rewrite = async (tree: string, prefix: string): Promise<string> => {
    const entries: TreeEntry[] = (await git(["ls-tree", "-z", tree])).split("\0").filter(Boolean).map(record => {
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      if (tab < 0 || !mode || !type || !oid) throw new Error("远端 Git 目录数据异常，已停止文件名修复");
      return { mode, type, oid, name: record.slice(tab + 1) };
    });
    const occupied = new Set(entries.map(entry => entry.name.toLowerCase()));
    const seen = new Set<string>();
    let changed = false;
    for (const entry of entries) {
      const oldName = entry.name;
      if (oldName === "." || oldName === ".." || oldName.toLowerCase() === ".git") {
        throw new Error("远端包含不安全目录，无法自动修复");
      }
      const isNote = entry.type === "blob" && oldName.toLowerCase().endsWith(".md");
      const base = sanitizeNoteFilename(isNote ? oldName.slice(0, -3) : oldName);
      const safe = isNote ? `${base}.md` : base;
      if (safe !== oldName || seen.has(oldName.toLowerCase())) {
        const dot = safe.lastIndexOf(".");
        const stem = entry.type === "blob" && dot > 0 ? safe.slice(0, dot) : safe;
        const extension = entry.type === "blob" && dot > 0 ? safe.slice(dot) : "";
        let name = safe;
        for (let index = 1; occupied.has(name.toLowerCase()); index++) name = `${stem} ${index}${extension}`;
        occupied.add(name.toLowerCase());
        entry.name = name;
        renamed.push(`${prefix}${oldName} → ${prefix}${name}`);
        changed = true;
      }
      seen.add(entry.name.toLowerCase());
      if (entry.type === "tree") {
        const oid = await rewrite(entry.oid, `${prefix}${entry.name}/`);
        if (oid !== entry.oid) { entry.oid = oid; changed = true; }
      }
    }
    if (!changed) return tree;
    return (await git(["mktree", "-z"], false,
      entries.map(entry => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\0`).join(""))).trim();
  };
  const originalTree = (await git(["rev-parse", `${parent}^{tree}`])).trim();
  const tree = await rewrite(originalTree, "");
  if (!renamed.length) return [];
  const commit = (await git(["commit-tree", tree, "-p", parent, "-m",
    "Fix Windows-incompatible filenames for sync"])).trim();
  // A regular push rejects concurrent updates; never force-push a repair.
  try {
    await git(["push", "origin", `${commit}:refs/heads/${branch}`], true);
  } catch (error) {
    throw new Error(`云端文件名修复提交未能推送，已停止下载合并；请检查写入权限或稍后重试。${String(error)}`);
  }
  await git(["fetch", "origin", branch], true);
  return renamed;
}
