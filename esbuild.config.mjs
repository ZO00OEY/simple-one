import esbuild from "esbuild";
import process from "process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import { writeDefaultReader } from "./scripts/build-share-reader.mjs";

const prod = process.argv[2] === "production";
async function writeAIStyles() {
  const source = await fs.readFile("modules/ai/styles.css", "utf8");
  const css = (await fs.readFile("styles.css", "utf8")).replace(/\n\/\* Built-in AI styles \*\/[\s\S]*?\/\* End built-in AI styles \*\//, "");
  await fs.writeFile("styles.css", css.trimEnd() + "\n/* Built-in AI styles */\n" + source.trim() + "\n/* End built-in AI styles */\n");
}
await writeAIStyles();
if (prod) {
  await writeDefaultReader();
  execFileSync(process.execPath, [fileURLToPath(new URL("./node_modules/typescript/bin/tsc", import.meta.url)), "--noEmit", "--skipLibCheck"], { stdio: "inherit", windowsHide: true });
}

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  alias: { buffer: "buffer/" },
  external: [
    "obsidian",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
  ],
  format: "cjs",
  target: "es2020",
  charset: "utf8",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  if ((await fs.stat("main.js")).size > 5_000_000) throw new Error("main.js exceeds the Obsidian Sync Standard 5 MB limit");
  console.log("Build complete.");
} else {
  const watchFiles = await writeDefaultReader();
  let timer;
  for (const filename of watchFiles.filter(file => !file.includes("node_modules"))) {
    watch(filename, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void writeDefaultReader().catch(error => console.error(error)); }, 100);
    });
  }
  await context.watch();
  console.log("Watching for changes...");
}
