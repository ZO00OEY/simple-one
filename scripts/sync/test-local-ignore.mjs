import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import esbuild from "esbuild";

const output = resolve("../../../.codex/output");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "local-ignore-test-"));
try {
  const bundle = join(folder, "ignore.cjs");
  await esbuild.build({ entryPoints: ["src/features/sync/localIgnore.ts"], bundle: true,
    platform: "node", format: "cjs", outfile: bundle });
  const { rootIgnoreMatcher, organizedLocalIgnore, legacyScopeRules, writeRootIgnore } = createRequire(import.meta.url)(bundle);
  const config = ".obsidian";
  const vault = join(folder, "vault");
  await mkdir(vault);
  execFileSync("git", ["init", "--quiet"], { cwd: vault });
  const paths = ["root.md", "nested/root.md", "build/file.md", "nested/build/file.md", "builder/file.md",
    "report1.md", "nested/report2.md", "reportx.md", "nested/report12.md", "#literal.md", "!literal.md",
    "trailing ", "blocked/keep.md", "opened/keep.md", "opened/drop.md", "docs/x/deep.md", "docs/deep.md",
    "notes/space file.md", "notes/other.md"];
  for (const path of paths) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    // Windows cannot represent trailing spaces in file names, but Git still accepts the candidate path.
    if (!path.endsWith(" ")) await writeFile(join(vault, path), "fixture");
  }
  const text = ["/root.md", "build/", "report[0-9].md", "\\#literal.md", "\\!literal.md", "trailing\\ ",
    "blocked/", "!blocked/keep.md", "opened/*", "!opened/keep.md", "docs/**/deep.md", "notes/space\\ file.md"].join("\n");
  await writeFile(join(vault, ".gitignore"), text);
  const checked = spawnSync("git", ["-c", "core.excludesFile=", "check-ignore", "--no-index", "-z", "--stdin"],
    { cwd: vault, input: paths.join("\0") + "\0", encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const gitIgnored = new Set(checked.stdout.split("\0").filter(Boolean));
  const match = rootIgnoreMatcher(text, config);
  for (const path of paths) assert.equal(match(path), gitIgnored.has(path), `Git parity: ${path}`);
  assert(match("blocked/keep.md"), "a negated child cannot reopen its ignored parent");
  assert(!match("opened/keep.md"), "an accessible parent allows child negation");
  assert(!match("nested/root.md"), "root anchors do not match descendants");
  assert(!match("reportx.md"), "character classes remain character classes");

  const original = "# first comment\r\n/a.tmp\r\n# second comment\r\n!a.tmp\r\n# last comment\r\n";
  const organized = organizedLocalIgnore(original, config, ["*.png", "private/"]);
  assert.equal(organizedLocalIgnore(organized, config, ["*.png", "private/"]), organized, "organization is byte-idempotent");
  assert(organized.includes(original.trimEnd()), "old comments and rule order survive as a contiguous block");
  assert.equal((organized.match(/# >>> simple-one:/g) ?? []).length, 4);
  assert(!organized.replace(/\r\n/g, "").includes("\n"), "CRLF is preserved");
  const appended = organized + "# new local exception\r\n!extra.tmp\r\n";
  const reorganized = organizedLocalIgnore(appended, config);
  assert(reorganized.includes("# new local exception\r\n!extra.tmp"));
  assert.equal(organizedLocalIgnore(reorganized, config), reorganized);
  const significantSpace = organizedLocalIgnore("trailing\\ ", config);
  assert(significantSpace.split(/\r?\n/).includes("trailing\\ "), "an escaped trailing space is rule content, including at EOF");
  assert(rootIgnoreMatcher(significantSpace, config)("trailing "));
  assert.throws(() => organizedLocalIgnore("# >>> simple-one:custom\nprivate/", config), /分区/);

  const protectedPaths = [".gitignore", ".git/config", "child/.git", "node_modules/module/index.js",
    ".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".obsidian/cache/x",
    ".obsidian/plugins/simple-one/sync-api-local.json", ".obsidian/plugins/simple-one/sync-local.json.recovery",
    ".obsidian/plugins/simple-one/sync-log.json", ".obsidian/plugins/simple-one/share-local.json",
    ".obsidian/plugins/simple-one/data.json.bak", ".obsidian/plugins/simple-link/data.json"];
  const allowedPaths = ["normal.md", "photo.png", ".obsidian/hotkeys.json", ".obsidian/themes/theme/theme.css",
    ".obsidian/app.json", ".obsidian/plugins/simple-one/data.json", ".obsidian/plugins/third-party/data.json"];
  const broad = rootIgnoreMatcher(organizedLocalIgnore("*.md\n*.png\n!**\n", config), config);
  for (const path of protectedPaths) assert(broad(path), `fixed protection survives !**: ${path}`);
  for (const path of allowedPaths) assert(!broad(path), `ordinary content remains open under !**: ${path}`);
  const explicit = organizedLocalIgnore("# keep explanation\n!.obsidian/workspace.json\n!ordinary.md\n", config);
  assert(!explicit.split(/\r?\n/).includes("!.obsidian/workspace.json"), "an exact exception to fixed protection must be commented out");
  assert(explicit.includes("# keep explanation"));
  assert(explicit.split(/\r?\n/).includes("!ordinary.md"), "ordinary exceptions remain active");

  const options = { syncImages: false, syncPlugins: false, plugins: [], ignorePatterns: ["private/", "!docs/keep.md"] };
  const migrated = rootIgnoreMatcher(organizedLocalIgnore("", config,
    legacyScopeRules(options).map(line => line.replaceAll("{config}", config))), config);
  for (const path of ["image.png", "nested/image.heif", ".obsidian/plugins/example/main.js", "private/note.md"]) assert(migrated(path), `legacy exclusion: ${path}`);
  assert(!migrated(".obsidian/hotkeys.json"));
  const selected = rootIgnoreMatcher(organizedLocalIgnore("", config,
    legacyScopeRules({ ...options, syncImages: true, syncPlugins: true, plugins: ["simple-one"] })
      .map(line => line.replaceAll("{config}", config))), config);
  assert(!selected(".obsidian/plugins/simple-one/data.json"), "private vault keeps normal plugin settings");
  assert(selected(".obsidian/plugins/other/main.js"));
  assert(!selected(".obsidian/plugins/simple-one/main.js"));

  const files = new Map([[".gitignore", "old\n"]]);
  const writes = [];
  const adapter = { exists: async path => files.has(path), read: async path => files.get(path),
    write: async (path, value) => { writes.push(path); files.set(path, value); } };
  await assert.rejects(writeRootIgnore(adapter, "stale", "new\n", config), /已变化/);
  assert.deepEqual(writes, [], "stale preview writes nothing");
  await writeRootIgnore(adapter, "old\n", "old\n", config);
  assert.deepEqual(writes, [], "unchanged rules write nothing");
  await writeRootIgnore(adapter, "old\n", "new\n", config);
  assert.equal(files.get(".obsidian/plugins/simple-one/sync-local.json.gitignore-recovery"), "old\n");
  assert.equal(files.get(".gitignore"), "new\n");
  const failed = { ...adapter, write: async (path, value) => {
    if (path === ".gitignore") throw new Error("fixture write failure");
    files.set(path, value);
  } };
  await assert.rejects(writeRootIgnore(failed, "new\n", "next\n", config), /写入未完成/);
  assert.equal(files.get(".gitignore"), "new\n");
  assert.equal(files.get(".obsidian/plugins/simple-one/sync-local.json.gitignore-recovery"), "new\n");
  await writeRootIgnore(adapter, "new\n", "custom config rules\n", ".custom-config");
  assert.equal(files.get(".custom-config/plugins/simple-one/sync-local.json.gitignore-recovery"), "new\n", "recovery follows the actual configured directory");
  console.log("Local root ignore: real Git parity, four-section idempotence, fixed protection, legacy migration and recovery passed");
} finally {
  if (!resolve(folder).startsWith(output + sep)) throw new Error("Unsafe fixture cleanup path");
  await rm(folder, { recursive: true, force: true });
}
