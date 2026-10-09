import { desktopProcess, type NodeFs, type NodePath } from "../../shared/desktopNode";
import type { GitCommand } from "./nestedRepos";

/** Repair only the vault copy; never operate on the public plugin repository. */
export async function repairIgnoredPluginData(vaultPath: string, configDir: string,
  git: GitCommand, isPrivateRemote: () => Promise<boolean>): Promise<string | null> {
  const requireNode = desktopProcess?.versions?.node
    ? (window as unknown as { require?: (name: string) => unknown }).require : undefined;
  if (!requireNode) return null;
  const fs = (requireNode("fs") as NodeFs).promises;
  const path = requireNode("path") as NodePath;
  const file = `${configDir}/plugins/simple-one/data.json`;
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  if (path.resolve(root).toLowerCase() !== path.resolve(vaultPath).toLowerCase()) return null;
  const relative = path.relative(vaultPath, path.join(vaultPath, file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try { if (!(await fs.lstat(path.join(vaultPath, file))).isFile()) return null; }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  const realFile = await fs.realpath(path.join(vaultPath, file));
  const realRoot = await fs.realpath(vaultPath);
  const resolvedRelative = path.relative(realRoot, realFile);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) return null;
  if ((await git(["ls-files", "--cached", "-z", "--", file])).split("\0").includes(file)) return null;
  // Respect an intentional staged removal instead of restoring it automatically.
  if ((await git(["diff", "--cached", "--diff-filter=D", "--name-only", "-z", "--", file])).split("\0").includes(file)) return null;
  let ignored = false;
  try { ignored = !!(await git(["check-ignore", "--", file])).trim(); }
  catch { /* Exit 1 means the normal Git add already includes the file. */ }
  if (!ignored || !await isPrivateRemote()) return null;
  await git(["add", "-f", "--", file]);
  return file;
}
