import { Unzip, UnzipInflate } from "fflate";
import { Manifest, safePath } from "./linkDiff";

// Keep archive extraction within a mobile-friendly memory budget.
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_SELECTED_BYTES = 96 * 1024 * 1024;

export async function extractRepositoryArchive(bytes: Uint8Array, wanted: Manifest,
  progress: (message: string) => void): Promise<Map<string, Uint8Array>> {
  if (bytes.length > MAX_COMPRESSED_BYTES) throw new Error("仓库压缩包较大，改用逐文件下载。");
  const files = new Map<string, Uint8Array>();
  const selected = new Set<string>();
  let root: string | undefined, total = 0, failure: Error | undefined;
  const unzip = new Unzip(file => {
    const slash = file.name.indexOf("/");
    if (slash <= 0) throw new Error("仓库压缩包缺少根目录。");
    const prefix = file.name.slice(0, slash);
    if (root && root !== prefix) throw new Error("仓库压缩包根目录不一致。");
    root = prefix;
    const path = file.name.slice(slash + 1);
    if (!path || path.endsWith("/")) return;
    safePath(path);
    if (!Object.prototype.hasOwnProperty.call(wanted, path)) return;
    if (selected.has(path)) throw new Error("仓库压缩包包含重复文件路径。");
    selected.add(path);
    if (file.originalSize !== undefined && total + file.originalSize > MAX_SELECTED_BYTES) {
      throw new Error("所选文件较大，改用逐文件下载。");
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, data, final) => {
      if (error) { failure = error; return; }
      total += data.length; length += data.length;
      if (total > MAX_SELECTED_BYTES) { failure = new Error("解压内容较大，改用逐文件下载。"); file.terminate(); return; }
      chunks.push(data);
      if (final) {
        const content = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
        files.set(path, content);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    unzip.push(bytes.subarray(offset, offset + 64 * 1024), offset + 64 * 1024 >= bytes.length);
    if (failure) throw failure;
    progress(`正在解压云端仓库 · 已筛选 ${files.size} 个文件`);
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }
  if (!root) throw new Error("仓库压缩包为空或无效。");
  if (files.size !== selected.size) throw new Error("仓库压缩包未完整解压。");
  return files;
}
