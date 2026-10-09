import { emptyManifest, parseManifest, type ShareManifest } from "./model";

export interface ShareLibraries {
  active: string;
  default: string;
  entries: Record<string, ShareManifest>;
}

/** The top-level manifest remains the active library for existing consumers. */
export function libraryManifest(manifest: ShareManifest): ShareManifest {
  const { libraries: _libraries, ...value } = manifest;
  return JSON.parse(JSON.stringify(value)) as ShareManifest;
}

export function ensureLibraries(manifest: ShareManifest): ShareLibraries {
  return manifest.libraries ??= { active: "legacy", default: "legacy", entries: { legacy: libraryManifest(manifest) } };
}

export function libraryOptions(manifest: ShareManifest): Record<string, string> {
  const libraries = ensureLibraries(manifest);
  return Object.fromEntries(Object.entries(libraries.entries).filter(([id, stored]) => !!(id === libraries.active ? manifest : stored).site.repo).map(([id, stored]) => {
    const value = id === libraries.active ? manifest : stored;
    return [id, value.site.repo ? `${value.site.owner}/${value.site.repo}` : "待配置分享库"]; }));
}

export function selectLibrary(manifest: ShareManifest, id: string): void {
  const libraries = ensureLibraries(manifest);
  libraries.entries[libraries.active] = libraryManifest(manifest);
  const selected = libraries.entries[id];
  if (!selected) throw new Error("分享库不存在。");
  libraries.active = id;
  for (const key of Object.keys(manifest)) delete (manifest as unknown as Record<string, unknown>)[key];
  Object.assign(manifest, libraryManifest(selected), { libraries });
}

export function addLibrary(manifest: ShareManifest): void {
  if (!manifest.site.repo && !Object.keys(manifest.notes).length) return;
  const libraries = ensureLibraries(manifest);
  const id = crypto.randomUUID();
  libraries.entries[id] = emptyManifest();
  selectLibrary(manifest, id);
}

export function validateLibraries(value: ShareLibraries): void {
  if (!value || !value.entries || Array.isArray(value.entries) || !value.entries[value.active] || !value.entries[value.default]) throw new Error("分享库列表格式不正确。");
  for (const [id, manifest] of Object.entries(value.entries)) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || manifest.libraries) throw new Error("分享库记录格式不正确。");
    parseManifest(JSON.stringify(manifest));
  }
}
