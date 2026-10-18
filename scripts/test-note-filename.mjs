import assert from "node:assert/strict";
import { build } from "esbuild";

const output = await build({
  entryPoints: ["src/shared/noteFilename.ts"],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { sanitizeNoteFilename, availableNotePath } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
);
assert.equal(sanitizeNoteFilename('如何写出"咒术回战式"的雷霆感'), "如何写出咒术回战式的雷霆感");
assert.equal(sanitizeNoteFilename('a\\/:*?"<>|b\u0000\n'), "ab");
assert.equal(sanitizeNoteFilename(" title.  "), "title");
assert.equal(sanitizeNoteFilename("..."), "未命名");
assert.equal(sanitizeNoteFilename('""'), "未命名");
for (const name of ["CON", "nul", "COM1", "lpt9", "aux.test", "COM¹"]) {
  assert.equal(sanitizeNoteFilename(name), `_${name}`);
}
for (const name of ["CONtext", "COM10", "正常“标题”", "[4] Step 5 Preview"]) {
  assert.equal(sanitizeNoteFilename(name), name);
}
const occupied = new Set(["notes/title.md", "notes/title 1.md"]);
assert.equal(availableNotePath("notes", "title", path => occupied.has(path)), "notes/title 2.md");
assert.equal(availableNotePath("", "title", () => false), "title.md");
console.log("Note filename tests passed");
