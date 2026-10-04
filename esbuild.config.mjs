import esbuild from "esbuild";
import process from "process";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import { writeDefaultReader } from "./scripts/build-share-reader.mjs";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "@codemirror/state",
    "@codemirror/view",
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
  await writeDefaultReader();
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
