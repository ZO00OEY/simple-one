import type { App, TFile } from "obsidian";
import type { Session } from "./types";

export function inScope(session: Session, path: string): boolean {
  return !session.folders?.length || session.folders.some(folder => path === folder || path.startsWith(folder + "/"));
}
// A bounded, lazy local cache. Vault events invalidate content immediately; stat checks
// also protect against stale entries if an event was missed. No vault uploads.
export class NoteSearch {
  private cache = new Map<string, { mtime: number; size: number; body: string }>();
  private chars = 0;
  constructor(private app: App) {}
  invalidate(path: string): void { const old = this.cache.get(path); if (old) this.chars -= old.body.length; this.cache.delete(path); }
  private async body(file: TFile): Promise<string> {
    const cached = this.cache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) return cached.body;
    this.invalidate(file.path); const body = await this.app.vault.cachedRead(file);
    if (body.length < 2000000) {
      while (this.chars + body.length > 8000000 && this.cache.size) this.invalidate(this.cache.keys().next().value!);
      this.cache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, body }); this.chars += body.length;
    }
    return body;
  }
  async search(session: Session, args: Record<string, unknown>, stopped: () => boolean) {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query && !args.modifiedDays && !args.createdDays) throw new Error("请提供关键词，或最近创建/修改天数。");
    const terms = query.split(/\s+/).filter(Boolean); const now = Date.now();
    const files = this.app.vault.getMarkdownFiles().filter(f => !f.path.split("/").some(p => p.startsWith(".")) && inScope(session, f.path)
      && (!args.folder || f.path.startsWith(args.folder + "/"))
      && (!args.modifiedDays || now - f.stat.mtime <= Number(args.modifiedDays) * 86400000)
      && (!args.createdDays || now - f.stat.ctime <= Number(args.createdDays) * 86400000));
    const results: { path: string; excerpt: string; score: number; modified: number; created: number }[] = [];
    let scanned = 0;
    // Metadata pass lets narrow title/tag requests avoid reading every document.
    for (const file of files) {
      if (stopped()) throw new Error("搜索已停止。");
      const meta = this.app.metadataCache?.getFileCache(file);
      const title = (file.basename ?? file.name.replace(/\.md$/i, "")).toLowerCase();
      const metadata = JSON.stringify([meta?.frontmatter?.aliases, meta?.frontmatter?.tags, meta?.tags?.map(t => t.tag)]).toLowerCase();
      let score = terms.reduce((n, t) => n + (title.includes(t) ? 20 : file.path.toLowerCase().includes(t) ? 8 : metadata.includes(t) ? 12 : 0), 0);
      const metaHit = terms.every(t => (title + " " + file.path.toLowerCase() + " " + metadata).includes(t));
      let body = "";
      if (args.mode !== "metadata") body = await this.body(file);
      scanned++;
      const lower = body.toLowerCase();
      if (!metaHit && !terms.every(t => (file.path.toLowerCase() + " " + metadata + " " + lower).includes(t))) continue;
      if (!metaHit && args.mode === "metadata") continue;
      score += terms.filter(t => lower.includes(t)).length;
      const index = Math.max(0, lower.indexOf(terms[0] ?? "") - 60);
      results.push({ path: file.path, excerpt: body.slice(index, index + 240), score, modified: file.stat.mtime, created: file.stat.ctime });
      if (scanned % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    results.sort((a, b) => b.score - a.score || b.modified - a.modified || a.path.localeCompare(b.path));
    const offset = Math.min(Number(args.offset) || 0, results.length);
    return { matches: results.slice(offset, offset + 30), scanned, totalFiles: files.length, totalMatches: results.length,
      nextOffset: offset + 30 < results.length ? offset + 30 : null, method: args.mode === "metadata" ? "标题/路径/别名/标签排名；未搜索正文" : "本地关键词匹配，标题/别名/标签优先；分页针对匹配结果" };
  }
}
