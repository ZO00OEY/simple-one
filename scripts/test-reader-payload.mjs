import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync as decode, strFromU8 } from "fflate";
import { gunzipSync } from "node:zlib";
import { writeDefaultReader } from "./build-share-reader.mjs";

async function buildPayload() {
  await writeDefaultReader();
  const source = await readFile("src/features/share/readerPayload.ts", "utf8");
  return Buffer.from(JSON.parse(/export const readerPayload = (.+);/.exec(source)[1]), "base64");
}
const first = await buildPayload(), second = await buildPayload();
assert.deepEqual(first, second);
assert.deepEqual([...first.slice(4, 8)], [0, 0, 0, 0]);
const content = JSON.stringify({ template: await readFile("default.html", "utf8"), licenses: await readFile("reader-licenses.txt", "utf8") });
assert.equal(gunzipSync(first).toString("utf8"), content);
assert.equal(strFromU8(decode(first)), content);
console.log("Reader build: deterministic gzip, zero timestamp and exact HTML/licenses round-trip in both decoders passed.");
