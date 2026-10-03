import { DataAdapter } from "obsidian";
import { defaultSyncIgnorePatterns, isPrivateSyncPath, shouldIgnore } from "./dirty";

export interface MobileOptions {
  mode: "github" | "server";
  repoUrl: string;
  branch: string;
  token: string;
  syncImages: boolean;
  syncPlugins: boolean;
  plugins: string[];
  cacheEnabled: boolean;
  trackPaths: boolean;
  ignorePatterns: string[];
  autoSyncMinutes: number;
  bound: boolean;
}

export const DEFAULT_MOBILE_OPTIONS: MobileOptions = {
  mode: "github", repoUrl: "", branch: "", token: "", syncImages: true,
  syncPlugins: false, plugins: [], cacheEnabled: true,
  trackPaths: true, ignorePatterns: [], autoSyncMinutes: 0, bound: false
};

export interface FileEntry { sha: string; mode: string; rawSha?: string }
export function sameContent(a?: FileEntry, b?: FileEntry): boolean {
  return !!a && !!b && (a.sha === b.sha || a.rawSha === b.sha || b.rawSha === a.sha);
}
export interface CacheEntry extends FileEntry { mtime: number; ctime: number; size: number; verifiedAt: number; hashVersion?: number }
const SYNC_HASH_VERSION = 2;

/** Compare and upload UTF-8 text with LF, while retaining its exact disk hash for write guards. */
export function syncBytes(bytes: Uint8Array): Uint8Array {
  // Preserve binary data and invalid UTF-8 byte for byte.
  if (bytes.includes(0)) return bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.includes("\r\n")) return bytes;
    return new TextEncoder().encode(text.replace(/\r\n/g, "\n"));
  } catch { return bytes; }
}
export type Manifest = Record<string, FileEntry>;
export interface PathRecords {
  moves: Record<string, string>;
}
export const newPathRecords = (): PathRecords => ({ moves: {} });

/** Accept old state without carrying creation/deletion records into Path. */
export function normalizePaths(value: PathRecords | Record<string, string | null>): PathRecords {
  const moves = value.moves && typeof value.moves === "object" ? value.moves : value;
  return { moves: Object.fromEntries(Object.entries(moves).filter(([from, to]) => typeof to === "string" && from !== to)) };
}
export interface LinkChange {
  status: "added" | "deleted" | "modified" | "renamed";
  basePath: string | null;
  currentPath: string | null;
  baseBlobSha: string | null;
  currentBlobSha: string | null;
  contentChanged: boolean;
  renameSource?: "event" | "hash" | "remote";
}
export interface LocalState {
  schema: 1;
  binding: string;
  baseCommitSha: string | null;
  baseScope?: string;
  base: Manifest;
  cache: Record<string, CacheEntry>;
  dirty: Record<string, number>;
  paths: PathRecords;
  revision: number;
  lastCacheAt: number;
}

export function newLocalState(binding = ""): LocalState {
  return { schema: 1, binding, baseCommitSha: null, base: {}, cache: {}, dirty: {}, paths: newPathRecords(), revision: 0, lastCacheAt: 0 };
}

export function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || [...path].some(character => character.charCodeAt(0) < 32) ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("仓库中存在无法安全写入的路径，已停止同步。");
  }
  return path;
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "avif", "heic", "heif", "apng"];

export function mobileIgnores(options: MobileOptions, configDir: string, pluginId: string): string[] {
  const generated = [...defaultSyncIgnorePatterns(configDir), ...options.ignorePatterns];
  if (!options.syncImages) generated.push(...IMAGE_EXTENSIONS.map((ext) => `*.${ext}`));
  if (!options.syncPlugins) generated.push(`${configDir}/plugins/`);
  // The generated list is informational; hard exclusions below cannot be negated.
  generated.push(`${configDir}/plugins/${pluginId}/sync-local.json`, `${configDir}/plugins/${pluginId}/data.json`, `${configDir}/plugins/${pluginId}/link-state.json`,
    `${configDir}/plugins/${pluginId}/link-state.json.recovery`, `${configDir}/plugins/${pluginId}/mobile-ignore.json`, ".git/", ".simple-link/");
  generated.push(`!${configDir}/plugins/${pluginId}/sync-settings.json`);
  return generated;
}

export function included(path: string, options: MobileOptions, configDir: string, pluginId: string): boolean {
  if (path === `${configDir}/__link_scan__` || path === `${configDir}/plugins/__link_scan__` ||
      path === `${configDir}/plugins/${pluginId}/__link_scan__`) return true;
  const parts = path.split("/");
  if (parts.some((part) => part === ".git" || part === "node_modules" || part === ".codex") ||
      path === ".simple-link" || path.startsWith(".simple-link/") ||
      path === ".trash" || path.startsWith(".trash/") ||
      path.startsWith(".codex/") || path.startsWith(".claudian/sessions/")) return false;
  if (isPrivateSyncPath(path, configDir)) return false;
  if (path === `${configDir}/plugins/${pluginId}/sync-settings.json`) return true;
  const ownPrefix = configDir + "/plugins/" + pluginId + "/";
  if (path.startsWith(ownPrefix)) {
    const relative = path.slice(ownPrefix.length);
    // Device state and recovery/backup variants cannot be enabled by ignore rules.
    if (/^(?:data\.json|sync-local\.json|link-state\.json|mobile-ignore\.json)(?:$|[.~_-])/i.test(relative)) return false;
  }
  if (path.startsWith(`${configDir}/plugins/`)) {
    const id = path.slice(`${configDir}/plugins/`.length).split("/")[0];
    if (!options.syncPlugins || (id !== "__link_scan__" && !options.plugins.includes(id))) return false;
    // Device credentials and runtime plugin state never travel through API sync.
    if (/\/(?:data|sync-settings)\.json$/i.test(path)) return false;
  }
  else if (path === configDir || path.startsWith(`${configDir}/`)) return false;
  if (!options.syncImages && IMAGE_EXTENSIONS.includes(path.split(".").pop()!.toLowerCase())) return false;
  return !shouldIgnore(path, [...defaultSyncIgnorePatterns(configDir), ...options.ignorePatterns], configDir);
}

export async function blobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.length + bytes.length);
  payload.set(header); payload.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function noteChange(state: LocalState, type: "create" | "modify" | "delete" | "rename", path: string, oldPath?: string): void {
  const revision = ++state.revision;
  state.dirty[path] = revision;
  if (oldPath) state.dirty[oldPath] = revision;
  if (type !== "rename" || !oldPath) return;
  const { moves } = state.paths;
  // Includes directory renames: paths of descendants are rewritten as a group.
  const destinations = new Set(Object.values(moves));
  const origins = new Set([...Object.keys(state.base), ...Object.keys(moves), ...Object.keys(state.cache), oldPath]);
  for (const base of origins) {
    const current = moves[base] ?? base;
    if (!(base in moves) && destinations.has(base)) continue;
    if (current === oldPath || current.startsWith(`${oldPath}/`)) {
      const target = path + current.slice(oldPath.length);
      if (target === base) delete moves[base]; else moves[base] = target;
    }
  }
  for (const [cachedPath, entry] of Object.entries(state.cache)) {
    if (cachedPath === oldPath || cachedPath.startsWith(`${oldPath}/`)) {
      const target = path + cachedPath.slice(oldPath.length);
      state.cache[target] = entry;
      state.dirty[target] = revision;
      delete state.cache[cachedPath];
    }
  }
}

export async function listIncluded(adapter: DataAdapter, allowed: (path: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const listing = await adapter.list(dir);
    for (const file of listing.files) {
      const path = safePath(file.replace(/^\/+/, ""));
      if (allowed(path)) files.push(path);
    }
    for (const folder of listing.folders) {
      const path = safePath(folder.replace(/^\/+/, ""));
      if ([".git", "node_modules", ".simple-link", ".trash", ".codex"].includes(path.split("/").pop()!)) continue;
      // Use a neutral filename so plugin selection and directory patterns prune subtrees.
      if (allowed(`${path}/__link_scan__`)) await visit(path);
    }
  };
  await visit("/");
  return files.sort();
}

export async function scanCurrent(
  adapter: DataAdapter, state: LocalState, options: MobileOptions,
  allowed: (path: string) => boolean, force: boolean, progress?: (message: string) => void
): Promise<Manifest> {
  const paths = await listIncluded(adapter, allowed);
  const current: Manifest = {};
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    const before = await adapter.stat(path);
    if (!before || before.type !== "file") throw new Error("扫描期间文件发生变化，请重试。");
    const cached = state.cache[path];
      const recentlyWritten = !!cached && Math.max(before.mtime, cached.mtime) >= cached.verifiedAt - 2000;
    if (!force && options.cacheEnabled && cached?.hashVersion === SYNC_HASH_VERSION && !state.dirty[path] && !recentlyWritten &&
        before.mtime === cached.mtime && before.ctime === cached.ctime && before.size === cached.size) {
      cached.mode = state.base[path]?.mode ?? cached.mode;
      current[path] = { sha: cached.sha, rawSha: cached.rawSha, mode: cached.mode };
    } else {
      const dirtyRevision = state.dirty[path];
      const bytes = new Uint8Array(await adapter.readBinary(path));
      const canonical = syncBytes(bytes);
      const sha = await blobSha(canonical);
      const rawSha = canonical === bytes ? sha : await blobSha(bytes);
      const after = await adapter.stat(path);
      if (!after || before.mtime !== after.mtime || before.size !== after.size || before.ctime !== after.ctime ||
          state.dirty[path] !== dirtyRevision) throw new Error("扫描期间文件正在修改，请稍后重试。");
      const entry = { sha, rawSha, mode: state.base[path]?.mode ?? "100644", mtime: after.mtime, ctime: after.ctime,
        size: after.size, verifiedAt: Date.now(), hashVersion: SYNC_HASH_VERSION };
      current[path] = { sha, rawSha, mode: entry.mode };
      if (options.cacheEnabled) state.cache[path] = entry;
      if (state.dirty[path] === dirtyRevision) delete state.dirty[path];
    }
    if (index % 25 === 0) {
      progress?.(`本地哈希 ${index + 1}/${paths.length}`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  for (const path of Object.keys(state.cache)) if (!(path in current)) delete state.cache[path];
  if (!options.cacheEnabled) state.cache = {};
  state.lastCacheAt = Date.now();
  return current;
}

/** Mapping is partial; explicit null means the base identity was deleted. */
export function identityPaths(base: Manifest, current: Manifest, recorded: Record<string, string | null>, hashFallback = true): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  const claimed = new Set<string>();
  for (const [from, to] of Object.entries(recorded)) {
    if (!base[from]) continue;
    if (to && current[to] && !claimed.has(to)) { mapping[from] = to; claimed.add(to); }
    else if (to === null || (to && !current[to])) mapping[from] = null;
  }
  for (const path of Object.keys(base)) {
    if (path in mapping) continue;
    if (current[path] && !claimed.has(path)) { mapping[path] = path; claimed.add(path); }
    else mapping[path] = null;
  }
  // Exact content fallback only for unambiguous disappeared/new pairs, never event tombstones.
  const missing = hashFallback ? Object.keys(base).filter((path) => mapping[path] === null && !(path in recorded)) : [];
  const added = Object.keys(current).filter((path) => !claimed.has(path));
  for (const from of missing) {
    const matches = added.filter((to) => !claimed.has(to) && current[to].sha === base[from].sha);
    const sources = missing.filter((path) => base[path].sha === base[from].sha);
    if (matches.length === 1 && sources.length === 1) {
      mapping[from] = matches[0]; claimed.add(matches[0]);
    }
  }
  return mapping;
}

export function linkDiff(base: Manifest, current: Manifest, records: PathRecords): LinkChange[] {
  const mapping = identityPaths(base, current, records.moves, false);
  const claimed = new Set(Object.values(mapping).filter((path): path is string => !!path));
  const changes: LinkChange[] = [];
  for (const [from, to] of Object.entries(mapping)) {
    const old = base[from]; const next = to ? current[to] : undefined;
    if (!next) changes.push({ status: "deleted", basePath: from, currentPath: null, baseBlobSha: old.sha,
      currentBlobSha: null, contentChanged: false });
    else if (from !== to || !sameContent(old, next) || old.mode !== next.mode) changes.push({
      status: from !== to ? "renamed" : "modified", basePath: from, currentPath: to,
      baseBlobSha: old.sha, currentBlobSha: next.sha, contentChanged: !sameContent(old, next),
      renameSource: from !== to ? "event" : undefined
    });
  }
  for (const path of Object.keys(current)) if (!claimed.has(path)) changes.push({ status: "added", basePath: null,
    currentPath: path, baseBlobSha: null, currentBlobSha: current[path].sha, contentChanged: true });
  return changes;
}
