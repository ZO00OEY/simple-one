import type { DataAdapter } from "obsidian";
import { organizedLocalIgnore, readRootIgnore, rootIgnoreMatcher, writeRootIgnore } from "./localIgnore";
import { pathBatches } from "./onboarding";

type Git = (args: string[]) => Promise<string>;
export interface IgnoreTrackingPlan {
  paths: string[];
  addPaths: string[];
  missingRules: string[];
  originalIgnore: string;
  nextIgnore: string;
}

export async function inspectIgnoreTracking(adapter: DataAdapter, configDir: string, git: Git, legacy: readonly string[] = [], nested: readonly string[] = []): Promise<IgnoreTrackingPlan> {
  const originalIgnore = await readRootIgnore(adapter);
  const nextIgnore = organizedLocalIgnore(originalIgnore, configDir, legacy);
  const ignored = rootIgnoreMatcher(nextIgnore, configDir);
  const tracked = new Set((await git(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean));
  const deleted = new Set((await git(["ls-files", "--deleted", "-z"])).split("\0").filter(Boolean));
  const others = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  return { originalIgnore, nextIgnore,
    paths: [...tracked].filter(path => !deleted.has(path) && ignored(path)).sort(),
    addPaths: [...new Set([...others, ...nested])].filter(path => !tracked.has(path) && !ignored(path)).sort(),
    missingRules: originalIgnore === nextIgnore ? [] : nextIgnore.split(/\r?\n/)
  };
}

/** Only the reviewed delta is staged; no commit, push, working-file deletion or whole-index rebuild. */
export async function applyIgnoreTracking(adapter: DataAdapter, configDir: string, git: Git, plan: IgnoreTrackingPlan): Promise<void> {
  if ((await git(["ls-files", "--unmerged", "-z"])).trim()) throw new Error("请先解决 Git 冲突，再重建规则与文件追踪。");
  const staged = new Set((await git(["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean));
  if ([...plan.paths, ...plan.addPaths].some(path => staged.has(path))) throw new Error("计划涉及已有暂存改动，请先处理后重新检查。");
  await writeRootIgnore(adapter, plan.originalIgnore, plan.nextIgnore, configDir);
  for (const batch of pathBatches(plan.paths)) await git(["rm", "--cached", "--ignore-unmatch", "--", ...batch]);
  for (const batch of pathBatches(plan.addPaths)) await git(["add", "-f", "--", ...batch]);
}

/** A local rules file never adopts a branch's tracked version, including on merge failure. */
export async function preserveRootIgnore<T>(adapter: DataAdapter, git: Git, task: () => Promise<T>): Promise<T> {
  const existed = await adapter.exists(".gitignore");
  const original = await readRootIgnore(adapter);
  let outcome: { result: T } | { error: unknown };
  try { outcome = { result: await task() }; }
  catch (error) { outcome = { error }; }
  try {
    if (existed) await adapter.write(".gitignore", original);
    else if (await adapter.exists(".gitignore")) await adapter.remove(".gitignore");
    // Never silently create a shared remote deletion: this must be reviewed in the repair plan.
    const tracked = (await git(["ls-files", "--cached", "--", ".gitignore"])).trim();
    if (tracked) throw new Error("远端仍跟踪根 .gitignore；本机规则已恢复。请先取消本次合并并在「重建忽略规则与修复文件追踪」中确认历史迁移，未自动提交或推送。");
  } catch (error) {
    if ("error" in outcome) throw Object.assign(new Error(`操作失败：${String(outcome.error)}；恢复本机忽略规则时亦失败：${String(error)}`), { errors: [outcome.error, error] });
    throw error;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}
