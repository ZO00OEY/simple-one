type Git = (args: string[], stdin?: string) => Promise<string>;

/** Exclude plugin-owned local rules without checking out files or changing the index. */
export async function localRuleMergeTarget(git: Git, parent: string, paths: readonly string[]): Promise<string> {
  if (!paths.length) return parent;
  const excluded = new Set(paths);
  const rewrite = async (tree: string, prefix: string): Promise<string> => {
    const records = (await git(["ls-tree", "-z", tree])).split("\0").filter(Boolean);
    const result: string[] = [];
    let changed = false;
    for (const record of records) {
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      const name = record.slice(tab + 1);
      if (tab < 0 || !mode || !type || !oid) throw new Error("远端 Git 目录数据异常，已停止合并");
      const path = prefix + name;
      if (excluded.has(path)) { changed = true; continue; }
      let next = oid;
      if (type === "tree" && paths.some(file => file.startsWith(path + "/"))) next = await rewrite(oid, path + "/");
      if (next !== oid) changed = true;
      result.push(`${mode} ${type} ${next}\t${name}\0`);
    }
    return changed ? (await git(["mktree", "-z"], result.join(""))).trim() : tree;
  };
  const original = (await git(["rev-parse", `${parent}^{tree}`])).trim();
  const tree = await rewrite(original, "");
  if (tree === original) return parent;
  return (await git(["commit-tree", tree, "-p", parent, "-m", "Keep plugin repository ignore rules device-local"])).trim();
}
