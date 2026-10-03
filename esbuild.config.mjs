import esbuild from "esbuild";
import process from "process";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

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
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  plugins: [{ name: "share-reader", setup(build) {
    build.onLoad({ filter: /readerPayload\.ts$/ }, async () => {
      const reader = await esbuild.build({ entryPoints: { app: "src/features/share/reader/app.ts" }, bundle: true, write: false, outdir: "reader", format: "esm", splitting: true, minify: true, target: "es2020", loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" }, logLevel: "warning", metafile: true });
      const files = Object.fromEntries(reader.outputFiles.map(file => [path.relative(process.cwd(), file.path).replaceAll("\\", "/"), Buffer.from(file.contents).toString("base64")]));
      const packageNames = new Set();
      for (const input of Object.keys(reader.metafile.inputs)) {
        const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
        if (match) packageNames.add(match[1]);
      }
      const licenses = [];
      for (const name of [...packageNames].sort()) {
        for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "COPYING"]) {
          try { licenses.push(`\n=== ${name} ===\n${await fs.readFile(`node_modules/${name}/${file}`, "utf8")}`); break; } catch { /* optional filename */ }
        }
      }
      files["reader/licenses.txt"] = Buffer.from(licenses.join("\n")).toString("base64");
      const archive = gzipSync(Buffer.from(JSON.stringify(files))).toString("base64");
      return { contents: `export const readerArchive = ${JSON.stringify(archive)};`, loader: "ts", watchFiles: Object.keys(reader.metafile.inputs).map(file => path.resolve(file)) };
    });
  } }],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  console.log("Build complete.");
} else {
  await context.watch();
  console.log("Watching for changes...");
}
