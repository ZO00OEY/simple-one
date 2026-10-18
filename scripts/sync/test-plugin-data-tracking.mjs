import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const output = resolve("../../../.codex/output");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "plugin-data-tracking-"));
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (cwd) => git(cwd, [
  "-c", "user.name=Test", "-c", "user.email=test@example.com",
  "-c", "commit.gpgsign=false", "commit", "-m", "tracking fixture"
]);

try {
  const vault = join(folder, "vault");
  const plugin = join(vault, ".obsidian/plugins/simple-one");
  const data = ".obsidian/plugins/simple-one/data.json";
  await mkdir(plugin, { recursive: true });
  git(vault, ["init"]);
  git(plugin, ["init"]);
  await writeFile(join(vault, ".gitignore"), ".obsidian/plugins/simple-one/.git/\n");
  await writeFile(join(plugin, ".gitignore"), "data.json*\n");
  await writeFile(join(plugin, "data.json"), '{"fixture":1}\n');
  git(plugin, ["add", ".gitignore"]);
  commit(plugin);
  git(vault, ["add", ".gitignore"]);
  const blob = git(vault, ["hash-object", "-w", "--", data]);
  git(vault, ["update-index", "--add", "--cacheinfo", `100644,${blob},${data}`]);
  git(vault, ["add", "-f", data, ".obsidian/plugins/simple-one/.gitignore"]);
  commit(vault);
  assert.equal(git(plugin, ["ls-files", "--", "data.json"]), "");
  assert.equal(git(vault, ["ls-files", "--", data]), data);

  const clone = join(folder, "clone");
  git(folder, ["clone", "--no-local", vault, clone]);
  const clonedPlugin = join(clone, ".obsidian/plugins/simple-one");
  assert.deepEqual(JSON.parse(await readFile(join(clone, data), "utf8")), { fixture: 1 });
  await writeFile(join(clone, data), '{"fixture":2}\n');
  git(clone, ["add", "-A"]);
  commit(clone);
  assert.equal(git(clone, ["show", `HEAD:${data}`]), '{"fixture":2}');
  git(clonedPlugin, ["init"]);
  git(clonedPlugin, ["add", "-A"]);
  assert.equal(git(clonedPlugin, ["ls-files", "--", "data.json"]), "");
  console.log("Plugin settings: vault tracking, clone updates and child exclusion passed");
} finally {
  if (!resolve(folder).startsWith(output + sep)) throw new Error("Unsafe fixture cleanup path");
  await rm(folder, { recursive: true, force: true });
}
