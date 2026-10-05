import assert from "node:assert/strict";
import { build } from "esbuild";

async function loadModule(entryPoint) {
  const output = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false
  });
  const source = output.outputFiles[0].text;
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const raw = await loadModule("src/features/sync/dirty.ts");
const module = { ...raw, shouldIgnore: (path, patterns = raw.defaultSyncIgnorePatterns(".obsidian")) => raw.shouldIgnore(path, patterns, ".obsidian") };
assert(raw.shouldIgnore(".custom/plugins/simple-link/data.json", ["!.custom/plugins/simple-link/data.json"], ".custom"));
assert(raw.shouldIgnore(".custom/cache/x", raw.defaultSyncIgnorePatterns(".custom"), ".custom"));
assert(!raw.shouldIgnore("notes/cache/x", raw.defaultSyncIgnorePatterns(".custom"), ".custom"));

assert.deepEqual(module.coalesceDirty([], { type: "add", path: "a.md" }), [
  { type: "add", path: "a.md" }
]);
assert.deepEqual(
  module.coalesceDirty([{ type: "add", path: "a.md" }], { type: "delete", path: "a.md" }),
  []
);
assert.deepEqual(
  module.coalesceDirty([{ type: "add", path: "a.md" }], {
    type: "move",
    fromPath: "a.md",
    path: "folder/a.md"
  }),
  [{ type: "add", path: "folder/a.md" }]
);
assert.deepEqual(
  module.coalesceDirty([{ type: "modify", path: "old.md" }], { type: "delete", path: "old.md" }),
  [{ type: "delete", path: "old.md" }]
);
assert.deepEqual(
  module.coalesceDirty([{ type: "modify", path: "old.md" }], {
    type: "move",
    fromPath: "old.md",
    path: "new.md"
  }),
  [
    { type: "move", fromPath: "old.md", path: "new.md" },
    { type: "modify", path: "new.md" }
  ]
);
assert.deepEqual(
  module.coalesceDirty([{ type: "move", fromPath: "old.md", path: "mid.md" }], {
    type: "move",
    fromPath: "mid.md",
    path: "new.md"
  }),
  [{ type: "move", fromPath: "old.md", path: "new.md" }]
);
assert.equal(module.shouldIgnore(".obsidian/plugins/zoey-sync-test/data.json"), false);
assert.equal(module.shouldIgnore(".obsidian/plugins/simple-one-sync/data.json"), false);
assert(raw.shouldIgnore("plugins/example/.git", ["!plugins/example/.git"], ".obsidian"));
assert(raw.shouldIgnore("plugins/example/.git/config", ["!plugins/example/.git/**"], ".obsidian"));
assert.equal(module.shouldIgnore(".obsidian/cache/index.json"), true);
assert.equal(module.shouldIgnore("folder/draft.tmp"), true);
assert.equal(module.shouldIgnore("folder/node_modules/package/index.js"), true);
assert.equal(module.shouldIgnore(".codex/output/preview.png"), true);
assert.equal(module.shouldIgnore("attachments/image.png"), false);
assert.equal(module.shouldIgnore("private/keep.md", ["private/", "!private/keep.md"]), false);
assert.equal(module.shouldIgnore("Notes/a.md"), false);
const gitStatus = await loadModule("src/features/sync/gitStatus.ts");
assert.deepEqual(gitStatus.parseGitStatus(" M changed.md\0?? new file.md\0D  old.md\0"), [
  { path: "changed.md", kind: "modified" },
  { path: "new file.md", kind: "added" },
  { path: "old.md", kind: "deleted" }
]);
assert.deepEqual(gitStatus.parseGitStatus("R  new.md\0old.md\0"), [
  { path: "new.md", oldPath: "old.md", kind: "moved" }
]);
assert.deepEqual(gitStatus.parseGitNameStatus("M\0changed.md\0A\0new.md\0D\0old.md\0"), [
  { path: "changed.md", kind: "modified" },
  { path: "new.md", kind: "added" },
  { path: "old.md", kind: "deleted" }
]);
assert.deepEqual(gitStatus.parseGitNameStatus("R100\0old.md\0new.md\0"), [
  { path: "new.md", oldPath: "old.md", kind: "moved" }
]);
assert.deepEqual(
  gitStatus.partitionCommitChanges(
    [
      { path: "stable.md", kind: "modified" },
      { path: "typing.md", kind: "modified" },
      { path: "renamed.md", oldPath: "old.md", kind: "moved" }
    ],
    new Set(["typing.md", "old.md"])
  ),
  {
    included: [{ path: "stable.md", kind: "modified" }],
    skipped: [
      { path: "typing.md", kind: "modified" },
      { path: "renamed.md", oldPath: "old.md", kind: "moved" }
    ],
    skippedPaths: ["typing.md", "renamed.md", "old.md"]
  }
);
assert.deepEqual(
  gitStatus.findRemoteChangeOverlaps(
    [
      { path: "typing.md", kind: "modified" },
      { path: "local-only.md", kind: "modified" },
      { path: "renamed.md", oldPath: "old.md", kind: "moved" }
    ],
    [
      { path: "typing.md", kind: "modified" },
      { path: "remote-only.md", kind: "modified" },
      { path: "old.md", kind: "deleted" }
    ]
  ),
  ["old.md", "typing.md"]
);
const conflict = await loadModule("src/features/sync/conflict.ts");
const conflictText = `before\n<<<<<<< HEAD\nfrom local\n=======\nfrom github\n>>>>>>> FETCH_HEAD\nafter\n`;
const blocks = conflict.parseConflictBlocks(conflictText);
assert.equal(blocks.length, 1);
assert.equal(blocks[0].github, "from github\n");
assert.equal(blocks[0].local, "from local\n");
assert.equal(conflict.applyConflictResolutions(conflictText, blocks, ["merged\n"]), "before\nmerged\nafter\n");
const gitError = await loadModule("src/features/sync/gitError.ts");
assert.equal(
  gitError.describeGitError("fatal: unable to access repository: schannel: SSL/TLS connection failed"),
  "与 GitHub 网络连接失败：fatal: unable to access repository: schannel: SSL/TLS connection failed"
);
const uncertainAuth = "X Failed to log in to github.com account ZO00OEY (keyring)\n- The token in keyring is invalid.";
assert.equal(gitError.isUncertainGitAuthError(uncertainAuth), true);
assert.match(gitError.describeGitError(uncertainAuth), /^GitHub 认证状态检查失败（暂不能确认 Token 已失效/);
assert.equal(gitError.isUncertainGitAuthError("remote: Invalid username or password."), false);
assert.equal(gitError.isMissingRemoteRefError("fatal: couldn't find remote ref master"), true);
assert.equal(gitError.isMissingRemoteRefError("fatal: Authentication failed"), false);
assert.equal(
  gitError.describeGitError("remote: Repository not found"),
  "认证失败：remote: Repository not found"
);
assert.equal(gitError.describeGitError("fatal: bad revision"), "fatal: bad revision");
for (const lockPath of ["P:/Obsidian/.git/index.lock", "P:\\Obsidian\\.git\\index.lock", "/vault/.git/index.lock"]) {
  const raw = `fatal: Unable to create '${lockPath}': File exists. Another git process seems to be running in this repository.`;
  const translated = gitError.describeGitError(new Error(raw));
  assert(translated.includes(lockPath));
  assert.match(translated, /手动删除该锁文件/);
  assert.match(translated, /先确认没有 Git 操作运行/);
  assert.match(translated, /完成接入/);
}
assert.equal(gitError.describeGitIndexLockError("fatal: Unable to create '.git/index.lock': Permission denied"), null);
assert.equal(gitError.describeGitIndexLockError("fatal: Unable to create '.git/config.lock': File exists"), null);
console.log("dirty queue, git status, conflict, and Git error checks passed");

const link = await loadModule("src/features/sync/linkDiff.ts");
const customOptions = { ...link.DEFAULT_MOBILE_OPTIONS, syncPlugins: true, plugins: ["simple-link"], ignorePatterns: ["!.custom/cache/**", "!.custom/plugins/simple-link/data.json", "!.custom/plugins/simple-link/link-state.json"] };
for (const path of [".custom/cache/x", ".custom/plugins/simple-link/data.json", ".custom/plugins/simple-link/link-state.json", ".custom/plugins/simple-link/link-state.json.recovery"]) {
  assert.equal(link.included(path, customOptions, ".custom", "simple-link"), false);
}
assert.equal(link.included(".custom/plugins/simple-link/sync-settings.json", customOptions, ".custom", "simple-link"), true);
assert.equal(link.included("notes/keep.md", customOptions, ".custom", "simple-link"), true);

const aiOptions = { ...link.DEFAULT_MOBILE_OPTIONS, syncPlugins: true, plugins: ["simple-ai"], ignorePatterns: ["!**"] };
for (const file of ["index.json", "memory.json", "work.json.previous", "sessions/chat.json", "images/attachment.txt"]) {
  const path = `.custom/plugins/simple-ai/private/${file}`;
  assert(raw.shouldIgnore(path, ["!**"], ".custom"));
  assert.equal(link.included(path, aiOptions, ".custom", "simple-one"), false);
  assert.throws(() => raw.assertNoPrivateSyncFiles([path], ".custom"), /私人配置/);
}
for (const file of ["data.json", "main.js", "styles.css", "manifest.json"]) {
  const path = `.custom/plugins/simple-ai/${file}`;
  assert.equal(link.included(path, aiOptions, ".custom", "simple-one"), true);
  raw.assertNoPrivateSyncFiles([path], ".custom");
}
assert.equal(link.included(".custom/plugins/simple-ai/data.json", { ...aiOptions, plugins: [] }, ".custom", "simple-one"), false);
assert.equal(link.included(".custom/plugins/other/data.json", { ...aiOptions, plugins: ["other"] }, ".custom", "simple-one"), false);

const oneOptions = { ...link.DEFAULT_MOBILE_OPTIONS, syncPlugins: true, plugins: ["simple-one", "simple-link"], ignorePatterns: ["!.custom/plugins/simple-one/**", "!.custom/plugins/simple-link/**"] };
for (const plugin of ["simple-one", "simple-link"]) {
  for (const file of ["data.json", "sync-local.json", "link-state.json", "link-state.json.recovery", "data.json.bak", "sync-local.json_copy", "mobile-ignore.json"]) {
    const path = `.custom/plugins/${plugin}/${file}`;
    assert(raw.shouldIgnore(path, ["!**"], ".custom"));
    assert.equal(link.included(path, oneOptions, ".custom", "simple-one"), false);
    assert.throws(() => raw.assertNoPrivateSyncFiles([path], ".custom"), /私人配置/);
  }
}
for (const file of ["main.js", "styles.css", "manifest.json", "default.json", "sync-settings.json"]) {
  const path = `.custom/plugins/simple-one/${file}`;
  assert.equal(link.included(path, oneOptions, ".custom", "simple-one"), true);
  raw.assertNoPrivateSyncFiles([path], ".custom");
}

// Display categorization must preserve the actual file, including precedence and exceptions.
globalThis.window ??= globalThis;
const ruleGroups = await loadModule("src/features/sync/onboarding.ts");
const finalIgnore = "# original comment\r\n/.custom/cache/\r\nnode_modules\r\nprivate-notes/\r\n!.custom/cache/keep.json\r\n.custom/cache/\r\n";
const groupedPreview = { nestedRepos: [], optimizedIgnore: finalIgnore };
const classified = ruleGroups.setupFinalIgnoreRuleGroups(groupedPreview, ".custom");
assert(classified.find(group => group.title.includes("工作区")).rules.includes("/.custom/cache/"));
assert(classified.find(group => group.title === "系统文件、备份与本机依赖").rules.includes("node_modules"));
assert.deepEqual(classified.find(group => group.title === "本机自有规则").rules, ["private-notes/", "!.custom/cache/keep.json"]);
assert.equal(groupedPreview.optimizedIgnore, finalIgnore, "grouping must not rewrite rule precedence, comments or line endings");
assert(ruleGroups.setupFinalIgnoreRuleGroups(groupedPreview, ".custom", "远端自有规则").some(group => group.title === "远端自有规则"));
console.log("Rule cards: categories, custom rules, negations and unchanged source order passed");

const organized = ruleGroups.organizedSetupIgnore(
  "# user comment\n.custom/cache/\n/.custom/cache/\nnode_modules\nprivate/\n!private/keep.md\nprivate/\n",
  [{ directory: "plugins/example", gitIsDirectory: true }], ".custom");
assert(organized.startsWith("# Git 元数据（默认排除）\n.git/\n"));
assert(organized.includes("# 检测到的内嵌仓库（排除其 Git 历史与配置）\n/plugins/example/.git/"));
assert.equal(organized.split(".custom/cache/").length, 2);
assert.equal(organized.split("node_modules").length, 2);
assert(organized.includes("# 本机自有规则\n# user comment\n!private/keep.md\nprivate/\n"));
assert.equal(ruleGroups.organizedSetupIgnore(organized, [{ directory: "plugins/example", gitIsDirectory: true }], ".custom"), organized);
console.log("Categorized ignore generation: deduplication, custom precedence and idempotence passed");

// The overview and ignore diff viewer must agree across Windows/Unix line endings.
const ignoreDiff = await loadModule("src/features/sync/textDiff.ts");
const localIgnore = "# common\r\ncache/\r\n!cache/keep.json\nnode_modules/\r\n\r\n";
const remoteIgnore = "# common\ncache/\n!cache/keep.json\nnode_modules/\n";
const ignorePreview = { localIgnore, remoteIgnore };
assert.equal(ruleGroups.setupIgnoreDiffers(ignorePreview), false);
const compare = ruleGroups.setupIgnoreComparisonText;
assert.equal(compare(localIgnore), compare(remoteIgnore));
assert.equal(ignoreDiff.textParts(compare(localIgnore), compare(remoteIgnore)).filter(part => part.common === undefined).length, 0);
const changedIgnore = remoteIgnore.replace("node_modules/", "build/");
assert.equal(ruleGroups.setupIgnoreDiffers({ ...ignorePreview, remoteIgnore: changedIgnore }), true);
const actualDiffs = ignoreDiff.textParts(compare(localIgnore), compare(changedIgnore)).filter(part => part.common === undefined);
assert.equal(actualDiffs.length, 1, "a real rule change must remain a single diff block");
assert.equal(ruleGroups.setupIgnoreDiffers({ localIgnore: " foo/\n", remoteIgnore: "foo/\n" }), true, "leading pattern whitespace must not be trimmed");
assert.equal(ruleGroups.setupIgnoreDiffers({ localIgnore: "foo\\ \n", remoteIgnore: "foo\n" }), true, "escaped trailing spaces must not be trimmed");
assert.equal(ignorePreview.localIgnore, localIgnore, "comparison must not rewrite either source file");
console.log("Ignore overview and diff: mixed CRLF/LF, EOF blank lines, real rules and significant spaces passed");
