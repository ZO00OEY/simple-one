import { TFile } from "obsidian";
import type SimplePlugin from "../../main";
import { sha256, type ShareManifest } from "./model";
export interface ExportedNote { source: string; hash: string; assets: Map<string, ArrayBuffer>; title: string; category: string }
export async function exportNote(host: SimplePlugin, file: TFile, category: string, manifest: ShareManifest, index: Map<string, TFile[]>, publicName = ""): Promise<ExportedNote> {
  const assets = new Map<string, ArrayBuffer>();
  let source = await host.app.vault.read(file);
  if (/^\uFEFF?---\r?\n/.test(source) && !/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source)) throw new Error("笔记属性区未闭合，停止导出以免公开私人属性。");
  source = source.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  // Comments are intentionally removed from the public copy, including hidden metadata.
  source = source.replace(/%%[\s\S]*?%%/g, "");
  const resolve = (target: string) => host.app.metadataCache.getFirstLinkpathDest(target, file.path);
  const attachment = async (target: TFile): Promise<string> => {
    if (target.path.startsWith(".gitshare/") || target.path.startsWith(host.app.vault.configDir + "/") || target.path.split("/").some(part => part.startsWith("."))) throw new Error("附件位于私人配置或隐藏目录，停止导出。");
    const extension = target.extension.toLowerCase();
    if (!new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "pdf", "mp3", "ogg", "wav", "m4a", "mp4", "webm", "txt", "csv"]).has(extension)) throw new Error(`暂不公开此附件格式：${target.name}。请改用常规图片、音视频或文档。`);
    const data = await host.app.vault.readBinary(target);
    if (data.byteLength > 25 * 1024 * 1024) throw new Error(`附件超过 25 MB：${target.name}`);
    const path = `assets/${await sha256(data)}.${extension}`;
    assets.set(path, data); return path;
  };
  const link = async (targetText: string, label: string, embedded: boolean): Promise<string> => {
    const split = targetText.indexOf("#");
    const targetPath = split < 0 ? targetText : targetText.slice(0, split);
    const anchor = split < 0 ? "" : targetText.slice(split + 1);
    const safeLabel = label.replace(/[[\]<>]/g, "").replace(/\r?\n/g, " ");
    const anchorId = anchor.startsWith("^") ? anchor.trim() : anchor.trim().toLowerCase().replace(/\s+/g, "-");
    if (!targetPath && anchor) return `[${safeLabel}](#${encodeURIComponent(anchorId)})`;
    const target = resolve(targetPath);
    if (!target) { if (embedded) throw new Error(`找不到引用附件：${targetPath}`); return safeLabel; }
    if (target.extension === "md") {
      const id = host.app.metadataCache.getFileCache(target)?.frontmatter?.share_id as unknown;
      if (typeof id !== "string" || !manifest.notes[id]?.enabled || index.get(id)?.length !== 1) return `${safeLabel}（未公开）`;
      const suffix = anchor ? "/" + encodeURIComponent(anchorId) : "";
      return `[${safeLabel}](#/notes/${id}${suffix})`;
    }
    const path = await attachment(target);
    if (!embedded) return `[${safeLabel}](${path})`;
    if (["mp3", "ogg", "wav", "m4a"].includes(target.extension.toLowerCase())) return `<audio controls src="${path}"></audio>`;
    if (["mp4", "webm"].includes(target.extension.toLowerCase())) return `<video controls src="${path}"></video>`;
    if (target.extension.toLowerCase() === "pdf") return `[${safeLabel}](${path})`;
    const dimensions = /^(\d+)(?:x(\d+))?$/.exec(label);
    const size = Number(dimensions?.[1] || 0), height = Number(dimensions?.[2] || 0);
    if (size && size <= 4096 && height <= 4096) return `<img src="${path}" width="${size}"${height ? ` height="${height}"` : ""} alt="">`;
    return `![${safeLabel}](${path})`;
  };
  const rewrite = async (text: string): Promise<string> => {
    // Keep inline code literal. All columns go through the same resolver.
    const parts = text.split(/(`+[^`\n]*`+)/g);
    for (let i = 0; i < parts.length; i += 2) {
      const matches = Array.from(parts[i].matchAll(/(!?)\[\[([^\]\n]+)\]\]|(!?)\[([^\]\n]*)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g));
      let result = "", start = 0;
      for (const match of matches) {
        result += parts[i].slice(start, match.index);
        if (match[2]) {
          const [target, ...labels] = match[2].split("|");
          result += await link(target, labels.join("|") || target.split("/").pop() || target, match[1] === "!");
        } else {
          const url = match[5].replace(/^<|>$/g, "");
          if (/^(?:https?:|mailto:|#)/i.test(url)) result += match[0];
          else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) result += match[4];
          else result += await link(decodeURIComponent(url), match[4], match[3] === "!");
        }
        start = match.index + match[0].length;
      }
      parts[i] = result + parts[i].slice(start);
    }
    return parts.join("");
  };
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
  let fence = "", columns = false, body = "";
  let lineCount = 0;
  for (const line of lines) {
    if (++lineCount % 200 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    const marker = /^\s*(`{3,}|~{3,})([^\n]*)/.exec(line);
    if (!fence && marker) { fence = marker[1]; columns = marker[2].trim() === "simple-columns"; body += line; continue; }
    if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { fence = ""; columns = false; body += line; continue; }
    body += !fence || columns ? await rewrite(line) : line;
  }
  // Raw HTML local sources cannot be resolved safely by Markdown link parsing.
  if (/<(?:img|audio|video|source)\b[^>]*\bsrc\s*=\s*["'](?!https?:\/\/|assets\/)[^"']+/i.test(body)) throw new Error("正文含原始 HTML 本地附件，请改为 Markdown 附件链接后分享。");
  const title = publicName || file.basename;
  const hash = await sha256(JSON.stringify({ body, title, category, assets: [...assets.keys()].sort() }));
  return { source: body, hash, assets, title, category };
}
