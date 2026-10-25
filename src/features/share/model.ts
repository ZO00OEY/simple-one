import { libraryManifest, validateLibraries, type ShareLibraries } from "./libraries";
export const SHARE_FOLDER = ".gitshare";
export const ID_PATTERN = /^[a-z0-9]{12}$/;
export interface ShareCopyContent { title: boolean; github: boolean; pageOne: boolean; excludedDomains?: string[] }
export interface ShareDomain { id: string; name: string; baseUrl: string }
export interface ShareEdgeOneDomains { projectId: string; domains: Array<{ domain: string; status: string }>; selected?: string[] }
export const DEFAULT_SHARE_COPY_CONTENT: ShareCopyContent = { title: true, github: true, pageOne: true };
export function normalizeShareDomainUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error("请输入以 https:// 开头、不含参数或 # 的分享站点网址。");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
}
export function shareDomainNoteUrl(baseUrl: string, noteId: string): string {
  return `${baseUrl}#/notes/${encodeURIComponent(noteId)}`;
}
export function formatShareContent(title: string, github: string, pageOne: string, selected: ShareCopyContent, domains: ReadonlyArray<{ name: string; url: string }> = []): string {
  if (!selected.title && !selected.github && !selected.pageOne && !domains.length) throw new Error("请在复制内容设置中至少勾选一项。");
  const lines: string[] = [];
  if (selected.title) lines.push(`《${title.replace(/\r?\n/g, " ")}》`);
  const links = [selected.github && github ? { name: "GitHub 链接", url: github } : undefined,
    selected.pageOne && pageOne ? { name: "EdgeOne Makers 链接", url: pageOne } : undefined,
    ...domains].filter((link): link is { name: string; url: string } => !!link?.url);
  for (const link of links) lines.push(`${selected.title || links.length > 1 ? `${link.name}：` : ""}${link.url}`);
  return lines.join("\n");
}
export interface ShareEntry {
  enabled: boolean;
  deleted?: boolean;
  sourcePath: string;
  category: string;
  directoryCode?: string;
  publicName?: string;
  revision: number;
}
export interface ShareManifest {
  version: 1;
  libraries?: ShareLibraries;
  enabled: boolean;
  defaultPath?: "root" | "source";
  copyContent?: ShareCopyContent;
  customDomains?: ShareDomain[];
  edgeOneDomains?: ShareEdgeOneDomains;
  site: { owner: string; repo: string; branch: string; initialized?: boolean; guideProgress?: number; hosting?: "github" | "edgeone" };
  notes: Record<string, ShareEntry>;
  directories?: Record<string, string>;
}
export interface PublishedNote {
  title: string;
  category: string;
  hash: string;
  assets: string[];
  path?: string;
}
export interface PublishState {
  version: 1;
  notes: Record<string, PublishedNote>;
  files: string[];
  intents?: Record<string, { enabled: boolean; category: string; publicName?: string; hash: string }>;
}
export function emptyManifest(): ShareManifest {
  return { version: 1, enabled: true, site: { owner: "", repo: "", branch: "main" }, notes: {} };
}
export function parseManifest(source: string): ShareManifest {
  const value = JSON.parse(source) as ShareManifest;
  if (!value || value.version !== 1 || typeof value.enabled !== "boolean" || !value.site || !value.notes || typeof value.notes !== "object" || Array.isArray(value.notes)) throw new Error("分享清单版本或格式不正确；已停止覆盖。");
  if (value.defaultPath !== undefined && value.defaultPath !== "root" && value.defaultPath !== "source") throw new Error("默认分享路径设置不正确。");
  if (value.copyContent !== undefined && (!value.copyContent || ["title", "github", "pageOne"].some(key => typeof value.copyContent![key as keyof ShareCopyContent] !== "boolean"))) throw new Error("复制内容设置不正确。");
  if (value.copyContent?.excludedDomains !== undefined && (!Array.isArray(value.copyContent.excludedDomains) || value.copyContent.excludedDomains.some(key => typeof key !== "string") || new Set(value.copyContent.excludedDomains).size !== value.copyContent.excludedDomains.length)) throw new Error("复制渠道设置不正确。");
  if (value.customDomains !== undefined) {
    if (!Array.isArray(value.customDomains) || new Set(value.customDomains.map(domain => domain.id)).size !== value.customDomains.length) throw new Error("分享域名记录格式不正确。");
    for (const domain of value.customDomains) {
      if (!domain || typeof domain.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(domain.id) || typeof domain.name !== "string" || !domain.name.trim() || domain.name.length > 50 || /[\r\n：]/.test(domain.name) || typeof domain.baseUrl !== "string" || normalizeShareDomainUrl(domain.baseUrl) !== domain.baseUrl) throw new Error("分享域名名称或网址格式不正确。");
    }
  }
  if (value.edgeOneDomains !== undefined) {
    const settings = value.edgeOneDomains;
    if (!settings || typeof settings.projectId !== "string" || !settings.projectId || !Array.isArray(settings.domains) ||
      settings.domains.some(item => !item || typeof item.domain !== "string" || !item.domain || typeof item.status !== "string") ||
      settings.selected !== undefined && (!Array.isArray(settings.selected) || settings.selected.some(domain => typeof domain !== "string") || new Set(settings.selected).size !== settings.selected.length)) {
      throw new Error("EdgeOne 自定义域名记录格式不正确。");
    }
  }
  if (typeof value.site.owner !== "string" || typeof value.site.repo !== "string" || !/^[A-Za-z0-9._/-]+$/.test(value.site.branch) || value.site.branch.includes("..")) throw new Error("分享仓库配置不正确。");
  if (value.site.initialized !== undefined && typeof value.site.initialized !== "boolean") throw new Error("分享网站初始化记录不正确。");
  if (value.site.guideProgress !== undefined && (!Number.isInteger(value.site.guideProgress) || value.site.guideProgress < 1 || value.site.guideProgress > 7)) throw new Error("分享引导进度不正确。");
  if (value.directories !== undefined) {
    if (!value.directories || typeof value.directories !== "object" || Array.isArray(value.directories)) throw new Error("分享目录映射不正确。");
    for (const [code, path] of Object.entries(value.directories)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(code) || typeof path !== "string") throw new Error("分享目录代码或路径不正确。");
      value.directories[code] = normalizeShareDirectory(path);
    }
  }
  if (value.libraries) validateLibraries(value.libraries);
  if (value.site.hosting !== undefined && !["github", "edgeone"].includes(value.site.hosting)) throw new Error("分享网站类型不正确。");
  for (const [id, entry] of Object.entries(value.notes)) {
    if (!ID_PATTERN.test(id) || !entry || typeof entry.enabled !== "boolean" || typeof entry.sourcePath !== "string" || typeof entry.category !== "string" || !Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error("分享清单记录不正确。");
    // Migrate old publishing baselines; the manifest now describes only desired content.
    delete (entry as unknown as Record<string, unknown>).baseIntent;
    delete (entry as unknown as Record<string, unknown>).baseHash;
    if (entry.publicName !== undefined && (typeof entry.publicName !== "string" || /[\\/\r\n]/.test(entry.publicName))) throw new Error("公开文件名不正确，不能包含目录分隔符或换行。");
    if (entry.deleted !== undefined && (typeof entry.deleted !== "boolean" || entry.deleted && entry.enabled)) throw new Error("分享删除记录不正确。");
    if (entry.directoryCode !== undefined) {
      if (typeof entry.directoryCode !== "string" || !value.directories || !Object.prototype.hasOwnProperty.call(value.directories, entry.directoryCode)) throw new Error("笔记引用了不存在的分享目录代码。");
      entry.category = value.directories[entry.directoryCode];
    }
  }
  return value;
}
export function serializeManifest(value: ShareManifest): string {
  const libraries = value.libraries ? { ...value.libraries, entries: { ...value.libraries.entries, [value.libraries.active]: libraryManifest(value) } } : undefined;
  return JSON.stringify({ ...value, ...(libraries ? { libraries } : {}), notes: Object.fromEntries(Object.entries(value.notes).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + "\n";
}
export function pruneWithdrawnDirectories(manifest: ShareManifest, remoteOnlyCategories: string[] = []): void {
  const notes = Object.values(manifest.notes);
  const inside = (category: string, path: string) => category === path || category.startsWith(path + "/");
  const candidates = new Set(Object.entries(manifest.directories || {}).filter(([, path]) =>
    notes.some(note => note.deleted && inside(note.category, path)) &&
    !notes.some(note => !note.deleted && inside(note.category, path)) &&
    !remoteOnlyCategories.some(category => inside(category, path))).map(([code]) => code));
  for (const code of candidates) {
    const path = manifest.directories![code];
    // Keep a parent if it still contains an independently created empty folder.
    if (Object.entries(manifest.directories!).some(([child, category]) => !candidates.has(child) && inside(category, path))) continue;
    delete manifest.directories![code];
    for (const note of notes) if (note.directoryCode === code) delete note.directoryCode;
  }
}
export function newShareId(existing: ReadonlySet<string>): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let id = "";
    while (id.length < 12) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      for (const byte of bytes) {
        if (byte < 252 && id.length < 12) id += alphabet[byte % 36];
      }
    }
    if (!existing.has(id)) return id;
  }
  throw new Error("无法生成不重复的分享 ID。");
}
export function parsePublishState(source: string): PublishState {
  const state = JSON.parse(source) as PublishState;
  if (!state || state.version !== 1 || !state.notes || typeof state.notes !== "object" || Array.isArray(state.notes) || !Array.isArray(state.files) || state.files.some(path => typeof path !== "string" || !managedPath(path)) || new Set(state.files).size !== state.files.length) throw new Error("公开发布记录异常，停止删除文件。");
  for (const [id, entry] of Object.entries(state.notes)) {
    if (!ID_PATTERN.test(id) || !entry || typeof entry.title !== "string" || typeof entry.category !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash) || !Array.isArray(entry.assets) || entry.assets.some(path => !/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(path))) throw new Error("公开笔记记录异常。");
    if (entry.path !== undefined && (typeof entry.path !== "string" || !managedNotePath(entry.path) || !entry.path.endsWith(`/${id}.md`))) throw new Error("公开笔记路径不正确。");
    if (!state.files.includes(entry.path ?? `notes/${id}.md`) || entry.assets.some(path => !state.files.includes(path))) throw new Error("公开发布记录未登记正文或附件。");
  }
  if (state.intents) for (const [id, intent] of Object.entries(state.intents)) {
    if (!ID_PATTERN.test(id) || !intent || typeof intent.enabled !== "boolean" || typeof intent.category !== "string" || !/^[a-f0-9]{64}$/.test(intent.hash)) throw new Error("公开分享意图记录异常。");
    if (intent.publicName !== undefined && (typeof intent.publicName !== "string" || /[\\/\r\n]/.test(intent.publicName))) throw new Error("公开文件名记录异常。");
  }
  return state;
}
export function managedPath(path: string): boolean {
  return ["index.html", ".nojekyll", "catalog.json", "publish-state.json"].includes(path) || managedNotePath(path) || /^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(path) || /^reader\/[a-zA-Z0-9._/-]+$/.test(path) && !path.includes("..");
}
export function normalizeShareDirectory(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (normalized && normalized.split("/").some(part => !part || part.startsWith(".") || /[\\:*?"<>|]/.test(part) || [...part].some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(part))) throw new Error("分享目录不能包含隐藏目录、路径跳转或非法文件名字符。");
  return normalized;
}
export function shareNotePath(id: string, entry: Pick<ShareEntry, "category" | "directoryCode">): string {
  const folder = entry.directoryCode ? normalizeShareDirectory(entry.category) : "";
  return `notes/${folder ? folder + "/" : ""}${id}.md`;
}
function managedNotePath(path: string): boolean {
  if (!/^notes\/(?:.+\/)?[a-z0-9]{12}\.md$/.test(path)) return false;
  try { return normalizeShareDirectory(path.slice(6, path.lastIndexOf("/"))) === path.slice(6, path.lastIndexOf("/")); }
  catch { return false; }
}
export function siteUrl(site: ShareManifest["site"]): string {
  if (!site.owner || !site.repo) return "";
  return `https://${site.owner}.github.io/${site.repo.toLowerCase() === `${site.owner.toLowerCase()}.github.io` ? "" : encodeURIComponent(site.repo) + "/"}`;
}
export async function sha256(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
