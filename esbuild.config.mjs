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
  minify: prod,
  outfile: "main.js",
  plugins: [{ name: "share-reader", setup(build) {
    build.onLoad({ filter: /readerPayload\.ts$/ }, async () => {
      const reader = await esbuild.build({ entryPoints: { app: "src/features/share/reader/app.ts" }, bundle: true, write: false, outdir: "reader", format: "esm", splitting: true, minify: true, target: "es2020", loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" }, logLevel: "warning", metafile: true, plugins: [{ name: "modern-fonts", setup(readerBuild) {
        readerBuild.onLoad({ filter: /katex\.min\.css$/ }, async args => ({ contents: (await fs.readFile(args.path, "utf8")).replace(/,url\([^)]*\.(?:woff|ttf)\) format\([^)]*\)/g, ""), loader: "css", resolveDir: path.dirname(args.path) }));
      } }] });
      const entries = reader.outputFiles.map(file => [path.relative(process.cwd(), file.path).replaceAll("\\", "/"), Buffer.from(file.contents).toString("base64")]);
      const files = Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
      const packageNames = new Set();
      for (const input of Object.keys(reader.metafile.inputs)) {
        const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
        if (match) packageNames.add(match[1]);
      }
      const licenses = [];
      for (const name of [...packageNames].sort()) {
        const directory = `node_modules/${name}`;
        const filenames = (await fs.readdir(directory)).sort();
        const file = ["license", "license.md", "license.txt", "copying"]
          .map(candidate => filenames.find(filename => filename.toLowerCase() === candidate)).find(Boolean);
        if (file) licenses.push(`\n=== ${name} ===\n${(await fs.readFile(`${directory}/${file}`, "utf8")).replace(/\r\n/g, "\n")}`);
      }
      files["reader/licenses.txt"] = Buffer.from(licenses.join("\n")).toString("base64");
      const compressed = gzipSync(Buffer.from(JSON.stringify(files)), { level: 9 });
      // The gzip OS byte otherwise differs between Windows and Linux builds.
      compressed[9] = 255;
      const archive = compressed.toString("base64");
      return { contents: `export const readerArchive = ${JSON.stringify(archive)};`, loader: "ts", watchFiles: Object.keys(reader.metafile.inputs).map(file => path.resolve(file)) };
    });
  } }],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  if ((await fs.stat("main.js")).size > 5_000_000) throw new Error("main.js exceeds the Obsidian Sync Standard 5 MB limit");
  console.log("Build complete.");
} else {
  await context.watch();
  console.log("Watching for changes...");
}
