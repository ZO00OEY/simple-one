export type ChangeKind = "modified" | "added" | "deleted" | "moved" | "changed";

export interface ChangeItem {
  path: string;
  kind: ChangeKind;
  oldPath?: string;
}

export interface CommitChangePartition {
  included: ChangeItem[];
  skipped: ChangeItem[];
  skippedPaths: string[];
}

export function partitionCommitChanges(
  changes: ChangeItem[],
  activePaths: ReadonlySet<string>
): CommitChangePartition {
  const included: ChangeItem[] = [];
  const skipped: ChangeItem[] = [];
  const skippedPaths = new Set<string>();
  for (const change of changes) {
    const paths = [change.path, change.oldPath].filter((path): path is string => Boolean(path));
    if (paths.some((path) => activePaths.has(path))) {
      skipped.push(change);
      for (const path of paths) skippedPaths.add(path);
    } else {
      included.push(change);
    }
  }
  return { included, skipped, skippedPaths: [...skippedPaths] };
}

export function findRemoteChangeOverlaps(localChanges: ChangeItem[], remoteChanges: ChangeItem[]): string[] {
  const localPaths = new Set(
    localChanges.flatMap((change) => [change.path, change.oldPath].filter((path): path is string => Boolean(path)))
  );
  const remotePaths = new Set(
    remoteChanges.flatMap((change) => [change.path, change.oldPath].filter((path): path is string => Boolean(path)))
  );
  return [...localPaths].filter((path) => remotePaths.has(path)).sort((a, b) => a.localeCompare(b));
}

export function parseGitStatus(output: string): ChangeItem[] {
  const records = output.split("\0").filter(Boolean);
  const changes: ChangeItem[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;
    if (code.includes("R") || code.includes("C")) {
      changes.push({ path, oldPath: records[++index], kind: "moved" });
    } else if (code === "??" || code.includes("A")) {
      changes.push({ path, kind: "added" });
    } else if (code.includes("D")) {
      changes.push({ path, kind: "deleted" });
    } else if (code.includes("M")) {
      changes.push({ path, kind: "modified" });
    } else {
      changes.push({ path, kind: "changed" });
    }
  }
  return changes;
}

export function parseGitNameStatus(output: string): ChangeItem[] {
  const fields = output.split("\0").filter(Boolean);
  const changes: ChangeItem[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index];
    const kindCode = code[0];
    if (kindCode === "R" || kindCode === "C") {
      const oldPath = fields[++index];
      const path = fields[++index];
      if (path && oldPath) changes.push({ path, oldPath, kind: "moved" });
      continue;
    }
    const path = fields[++index];
    if (!path) continue;
    if (kindCode === "A") changes.push({ path, kind: "added" });
    else if (kindCode === "D") changes.push({ path, kind: "deleted" });
    else if (kindCode === "M") changes.push({ path, kind: "modified" });
    else changes.push({ path, kind: "changed" });
  }
  return changes;
}
