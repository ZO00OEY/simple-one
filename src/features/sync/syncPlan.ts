import { sameContent, type Manifest } from "./linkDiff";
import type { ConflictChoice, MobilePlan } from "./mobileGithub";

export type SyncStrategy = "merge" | "merge-remote" | "merge-local" | "remote" | "local";

export function strategyChoices(plan: MobilePlan, strategy: SyncStrategy): Record<string, ConflictChoice> {
  const choices = { ...plan.pendingChoices };
  if (strategy === "local" || strategy === "remote") return choices;
  for (const conflict of plan.conflicts) {
    if (conflict.kind === "duplicate") choices[conflict.id] = { choice: "both" };
    else if (conflict.kind === "unpaired" || conflict.kind === "delete") {
      choices[conflict.id] = { choice: conflict.local ? "local" : "remote" };
    }
    else if (strategy === "merge-remote" || strategy === "merge-local") {
      choices[conflict.id] = { choice: strategy === "merge-remote" ? "remote" : "local" };
    }
  }
  return choices;
}

/** A strict mirror retains the preview snapshot and all execute-time guards. */
export function mirrorPlan(plan: MobilePlan, strategy: "remote" | "local"): MobilePlan {
  const desired: Manifest = Object.fromEntries(Object.entries(strategy === "remote" ? plan.remote.files : plan.local)
    .map(([path, entry]) => [path, { sha: sameContent(entry, plan.remote.files[path]) ? plan.remote.files[path].sha : entry.sha, mode: entry.mode }]));
  return { ...plan, desired, conflicts: [], mergedContents: {},
    uploads: Object.keys(desired).filter(path => desired[path].sha !== plan.remote.files[path]?.sha || desired[path].mode !== plan.remote.files[path]?.mode),
    downloads: Object.keys(desired).filter(path => !sameContent(desired[path], plan.local[path])),
    localDeletes: Object.keys(plan.local).filter(path => !desired[path]),
    remoteDeletes: Object.keys(plan.remote.files).filter(path => !desired[path]) };
}
