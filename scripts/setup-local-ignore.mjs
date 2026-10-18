import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rules = `# Local dependencies and temporary files
node_modules/
.codex/
AGENTS.md
.env
.env.*
*.log

# Private settings, credentials, and sync state
data.json*
sync-settings.json*
sync-local.json*
sync-api-local.json*
sync-log.json*
link-state.json*
mobile-ignore.json*
private/

# Private sharing records and templates
share-manifest.json*
share-local.json*
share-template*.html
custom-*.html
share-template-selection.json*
`;

let gitRoot;
try {
  gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
} catch {
  process.exit(0);
}
if (resolve(gitRoot).toLowerCase() !== root.toLowerCase()) process.exit(0);

try {
  await writeFile(resolve(root, ".gitignore"), rules, { flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}

const gitExclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const excludePath = resolve(root, gitExclude);
const exclude = await readFile(excludePath, "utf8").catch(error => {
  if (error.code === "ENOENT") return "";
  throw error;
});
if (!exclude.split(/\r?\n/).includes(".gitignore")) {
  await writeFile(excludePath, `${exclude}${exclude && !exclude.endsWith("\n") ? "\n" : ""}.gitignore\n`);
}
