import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const artifacts = ["main.js", "styles.css", "manifest.json", "default.html", "reader-licenses.txt", "src/features/share/readerPayload.ts"];
async function build() {
  // Remove derived inputs as well as outputs to catch stale generated payloads.
  for (const file of artifacts.filter(file => !["styles.css", "manifest.json"].includes(file))) await rm(file, { force: true });
  execFileSync(process.execPath, [process.env.npm_execpath, "run", "build"], { stdio: "inherit", windowsHide: true });
  const result = {};
  for (const file of artifacts) {
    const bytes = await readFile(file);
    result[file] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return result;
}
const first = await build(), second = await build();
assert.deepEqual(second, first, "Clean rebuild changed artifacts");
assert(second["main.js"].bytes <= 5_000_000);
await mkdir(".codex/output", { recursive: true });
await writeFile(".codex/output/build-hashes.json", JSON.stringify({ node: process.version, platform: process.platform, artifacts: second }, null, 2) + "\n");
console.log(JSON.stringify(second, null, 2));
