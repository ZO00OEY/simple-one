import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const output = await build({
  entryPoints: ["src/features/sync/remoteFilenameRepair.ts"],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { repairRemoteFilenames, isInvalidGitPathError, hasCaseInsensitivePathCollisions } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
);
assert(isInvalidGitPathError(new Error('error: invalid path \'bad"title.md\'\nMerge with strategy ort failed.')));
assert(isInvalidGitPathError("fatal: invalid path 'bad'"));
for (const message of ["permission denied", "TLS connection failed", "CONFLICT (content)", "invalid path configuration"]) {
  assert.equal(isInvalidGitPathError(new Error(message)), false);
}
assert(hasCaseInsensitivePathCollisions(['Notes/A.md', 'notes/B.md']));
assert(hasCaseInsensitivePathCollisions(['Note.md', 'note.md']));
assert(!hasCaseInsensitivePathCollisions(['Notes/A.md', 'Notes/B.md']));
const syncSource = readFileSync("src/features/sync/index.ts", "utf8");
const syncMethod = syncSource.slice(syncSource.indexOf("private async desktopFetchAndMerge("), syncSource.indexOf("private async recordSuccessfulPull("));
assert(syncMethod.indexOf("hasCaseInsensitivePathCollisions(") < syncMethod.indexOf('this.git(["merge", "--no-edit", "FETCH_HEAD"])'));
assert(syncMethod.lastIndexOf("repairRemoteFilenames(") > syncMethod.indexOf('this.git(["merge", "--no-edit", "FETCH_HEAD"])'));
assert(syncMethod.includes("allowFilenameRepair && isInvalidGitPathError(error)"));
assert(syncMethod.includes("desktopFetchAndMerge(pushAfterResolve, false)"));
const root = mkdtempSync(path.resolve("../../..", ".codex/output/remote-filename-test-"));
const origin = path.join(root, "origin.git");
const local = path.join(root, "local");
const run = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", input, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
execFileSync("git", ["init", "--bare", origin], { stdio: "pipe" });
execFileSync("git", ["init", "-b", "master", local], { stdio: "pipe" });
run(local, ["config", "user.name", "Test"]);
run(local, ["config", "user.email", "test@example.invalid"]);
run(local, ["remote", "add", "origin", origin]);
const blob = run(local, ["hash-object", "-w", "--stdin"], "original content\n").trim();
const line = name => `100644 blob ${blob}\t${name}\0`;
const child = run(local, ["mktree", "-z"], line('bad"title.md') + line("badtitle.md") + line("CON.md") + line("Note.md") + line("note.md")).trim();
const tree = run(local, ["mktree", "-z"], `040000 tree ${child}\tbad:folder\0`).trim();
const initial = run(local, ["commit-tree", tree, "-m", "seed"]).trim();
run(local, ["push", "origin", `${initial}:refs/heads/master`]);
run(local, ["fetch", "origin", "master"]);
const git = async (args, authenticated, input) => run(local, args, input);
const renames = await repairRemoteFilenames(git, "master");
assert.equal(renames.length, 4);
const remote = run(origin, ["rev-parse", "master"]).trim();
assert.equal(run(origin, ["rev-parse", "master^"]).trim(), initial);
assert.equal(run(origin, ["rev-parse", "master:badfolder/badtitle 1.md"]).trim(), blob);
assert.equal(run(origin, ["rev-parse", "master:badfolder/badtitle.md"]).trim(), blob);
assert.equal(run(origin, ["rev-parse", "master:badfolder/_CON.md"]).trim(), blob);
assert.equal(run(origin, ["rev-parse", "master:badfolder/Note.md"]).trim(), blob);
assert.equal(run(origin, ["rev-parse", "master:badfolder/note 1.md"]).trim(), blob);
assert.equal(run(local, ["ls-files", "-z"]), "");
assert.deepEqual(await repairRemoteFilenames(git, "master"), []);
assert.equal(run(origin, ["rev-parse", "master"]).trim(), remote);
run(local, ["fetch", "origin", `${initial}`]);
let fetchedAfterFailure = false;
await assert.rejects(repairRemoteFilenames(async (args, auth, input) => {
  if (args[0] === "push") throw new Error("permission denied");
  if (args[0] === "fetch") fetchedAfterFailure = true;
  return git(args, auth, input);
}, "master"), /修复提交未能推送/);
assert.equal(fetchedAfterFailure, false);
assert.equal(run(origin, ["rev-parse", "master"]).trim(), remote);
console.log(`Remote filename repair tests passed; fixtures: ${root}`);
