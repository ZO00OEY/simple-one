export const SHARE_FOLDER = ".gitshare";
export const ID_PATTERN = /^[a-z0-9]{12}$/;
export function formatShareLink(title: string, url: string): string {
  return `${title.replace(/\r?\n/g, " ")} ${url}`;
}
export interface ShareEntry {
  enabled: boolean;
  sourcePath: string;
  category: string;
  publicName?: string;
  revision: number;
  baseIntent?: string;
  baseHash?: string;
}
export interface ShareManifest {
  version: 1;
  enabled: boolean;
  site: { owner: string; repo: string; branch: string; initialized?: boolean };
  notes: Record<string, ShareEntry>;
}
export interface PublishedNote {
  title: string;
  category: string;
  hash: string;
  assets: string[];
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
  if (typeof value.site.owner !== "string" || typeof value.site.repo !== "string" || !/^[A-Za-z0-9._/-]+$/.test(value.site.branch) || value.site.branch.includes("..")) throw new Error("分享仓库配置不正确。");
  if (value.site.initialized !== undefined && typeof value.site.initialized !== "boolean") throw new Error("分享网站初始化记录不正确。");
  for (const [id, entry] of Object.entries(value.notes)) {
    if (!ID_PATTERN.test(id) || !entry || typeof entry.enabled !== "boolean" || typeof entry.sourcePath !== "string" || typeof entry.category !== "string" || !Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error("分享清单记录不正确。");
    if ([entry.baseIntent, entry.baseHash].some(value => value !== undefined && !/^[a-f0-9]{64}$/.test(value))) throw new Error("分享清单的发布依据不正确。");
    if (entry.publicName !== undefined && (typeof entry.publicName !== "string" || /[\\/\r\n]/.test(entry.publicName))) throw new Error("公开文件名不正确，不能包含目录分隔符或换行。");
  }
  return value;
}
export function serializeManifest(value: ShareManifest): string {
  return JSON.stringify({ ...value, notes: Object.fromEntries(Object.entries(value.notes).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + "\n";
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
    if (!state.files.includes(`notes/${id}.md`) || entry.assets.some(path => !state.files.includes(path))) throw new Error("公开发布记录未登记正文或附件。");
  }
  if (state.intents) for (const [id, intent] of Object.entries(state.intents)) {
    if (!ID_PATTERN.test(id) || !intent || typeof intent.enabled !== "boolean" || typeof intent.category !== "string" || !/^[a-f0-9]{64}$/.test(intent.hash)) throw new Error("公开分享意图记录异常。");
    if (intent.publicName !== undefined && (typeof intent.publicName !== "string" || /[\\/\r\n]/.test(intent.publicName))) throw new Error("公开文件名记录异常。");
  }
  return state;
}
export function intentHash(entry: Pick<ShareEntry, "enabled" | "category" | "publicName">): Promise<string> {
  return sha256(JSON.stringify({ enabled: entry.enabled, category: entry.category, ...(entry.publicName ? { publicName: entry.publicName } : {}) }));
}
export function remoteConflict(entry: ShareEntry, remote: PublishState, id: string, currentHash?: string): boolean {
  const intent = remote.intents?.[id];
  if (intent && entry.baseIntent !== intent.hash && (entry.enabled !== intent.enabled || entry.category !== intent.category || (entry.publicName || "") !== (intent.publicName || ""))) return true;
  const hash = remote.notes[id]?.hash;
  return entry.enabled && !!hash && hash !== entry.baseHash && !!currentHash && currentHash !== hash;
}
export function managedPath(path: string): boolean {
  return ["index.html", ".nojekyll", "catalog.json", "publish-state.json"].includes(path) || /^notes\/[a-z0-9]{12}\.md$/.test(path) || /^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(path) || /^reader\/[a-zA-Z0-9._/-]+$/.test(path) && !path.includes("..");
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
