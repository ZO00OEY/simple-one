import { Unzip, UnzipInflate } from "fflate";
import { Manifest, safePath } from "./linkDiff";

// Limit pending extraction data; consumed files release this budget.
const MAX_SELECTED_BYTES = 96 * 1024 * 1024;

export interface ArchiveSource {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface ImportFile extends ArchiveSource { name: string; webkitRelativePath?: string }

/** Match the reviewed cloud paths, rather than assuming a .obsidian folder is present. */
export function directoryEntries(files: readonly ImportFile[], wanted: Manifest): Map<string, ImportFile> {
  const candidates = new Map<string, Map<string, ImportFile>>();
  for (const file of files) {
    const source = safePath(file.webkitRelativePath || file.name);
    const parts = source.split("/");
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(index).join("/");
      if (!Object.prototype.hasOwnProperty.call(wanted, path)) continue;
      const root = parts.slice(0, index).join("/");
      const entries = candidates.get(root) ?? new Map<string, ImportFile>();
      if (entries.has(path)) throw new Error("导入目录包含重复文件路径。");
      entries.set(path, file); candidates.set(root, entries);
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.size - a.size);
  if (!ranked.length) throw new Error("所选目录没有本次待下载的文件，请选择仓库根目录或它的外层目录。");
  if (ranked[1]?.size === ranked[0].size) throw new Error("所选目录包含多个可能的仓库，请直接选择其中一个仓库目录。");
  return ranked[0];
}

export async function extractRepositoryArchive(bytes: Uint8Array | ArchiveSource, wanted: Manifest,
  progress: (message: string) => void, consume?: (path: string, content: Uint8Array) => Promise<void>): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const ready: Array<{ path: string; content: Uint8Array }> = [];
  const selected = new Set<string>();
  let root: string | undefined, total = 0, completed = 0, failure: Error | undefined;
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
      throw new Error("当前待保存的解压内容超过 96 MiB 内存上限");
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, data, final) => {
      if (error) { failure = error; return; }
      total += data.length; length += data.length;
      if (total > MAX_SELECTED_BYTES) { failure = new Error("当前待保存的解压内容超过 96 MiB 内存上限"); file.terminate(); return; }
      chunks.push(data);
      if (final) {
        const content = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
        if (consume) ready.push({ path, content });
        else files.set(path, content);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const size = bytes instanceof Uint8Array ? bytes.length : bytes.size;
  for (let offset = 0; offset < size; offset += 64 * 1024) {
    const end = Math.min(size, offset + 64 * 1024);
    const chunk = bytes instanceof Uint8Array ? bytes.subarray(offset, end) : new Uint8Array(await bytes.slice(offset, end).arrayBuffer());
    if (chunk.length !== end - offset) throw new Error("ZIP 分片读取不完整，请重新选择文件。");
    unzip.push(chunk, end >= size);
    if (failure) throw failure;
    while (ready.length) {
      const file = ready.shift()!;
      await consume!(file.path, file.content);
      total -= file.content.length;
      completed++;
    }
    progress(`云端压缩包下载成功 · 正在解压并暂存 · 已处理 ${consume ? completed : files.size} 个文件`);
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }
  if (!root) throw new Error("仓库压缩包为空或无效。");
  if ((consume ? completed : files.size) !== selected.size) throw new Error("仓库压缩包未完整解压。");
  return files;
}
