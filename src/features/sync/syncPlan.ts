import { sameContent, type Manifest } from "./linkDiff";
import type { ConflictChoice, MobilePlan } from "./mobileGithub";

export type SyncStrategy = "merge" | "remote" | "local" | "custom";

export function downloadSummary(downloads: number, total: number): { ratio: number; recommend: boolean } {
  const ratio = total ? Math.min(1, downloads / total) : 0;
  return { ratio, recommend: downloads > 1000 || downloads >= 100 && ratio >= 0.5 };
}

export function strategyChoices(plan: MobilePlan, strategy: SyncStrategy): Record<string, ConflictChoice> {
  const choices = { ...plan.pendingChoices };
  if (strategy !== "merge") return choices;
  for (const conflict of plan.conflicts) {
    if (conflict.kind === "duplicate") choices[conflict.id] = { choice: "both" };
    else if (conflict.kind === "unpaired" || conflict.kind === "delete") {
      choices[conflict.id] = { choice: conflict.local ? "local" : "remote" };
    }
  }
  return choices;
}

/** A strict mirror still goes through the final counts/deletion confirmation and execute guards. */
export function mirrorPlan(plan: MobilePlan, strategy: "remote" | "local"): MobilePlan {
  const desired: Manifest = Object.fromEntries(Object.entries(strategy === "remote" ? plan.remote.files : plan.local)
    .map(([path, entry]) => [path, { sha: sameContent(entry, plan.remote.files[path]) ? plan.remote.files[path].sha : entry.sha, mode: entry.mode }]));
  return { ...plan, desired, conflicts: [], mergedContents: {},
    uploads: Object.keys(desired).filter(path => desired[path].sha !== plan.remote.files[path]?.sha || desired[path].mode !== plan.remote.files[path]?.mode),
    downloads: Object.keys(desired).filter(path => !sameContent(desired[path], plan.local[path])),
    localDeletes: Object.keys(plan.local).filter(path => !desired[path]),
    remoteDeletes: Object.keys(plan.remote.files).filter(path => !desired[path]) };
}
