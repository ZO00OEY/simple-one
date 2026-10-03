import type { App, DataAdapter } from "obsidian";

const localPath = (configDir: string, pluginId: string) => `${configDir}/plugins/${pluginId}/sync-local.json`;

function readObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("同步配置格式错误，已保留原文件。");
  return value as Record<string, unknown>;
}

export async function readLocalSyncSettings(adapter: DataAdapter, configDir: string, pluginId: string): Promise<unknown> {
  const path = localPath(configDir, pluginId);
  return await adapter.exists(path) ? readObject(await adapter.read(path)) : null;
}

export async function writeLocalSyncSettings(adapter: DataAdapter, configDir: string, pluginId: string, value: unknown): Promise<void> {
  await adapter.write(localPath(configDir, pluginId), JSON.stringify(value, null, 2));
}

/** Copy once; never write Simple One's data.json or overwrite established state. */
export async function migrateLinkFiles(adapter: DataAdapter, configDir: string, pluginId: string, copyState = true, sharedKeys: ReadonlySet<string> = new Set()): Promise<void> {
  const oldRoot = `${configDir}/plugins/simple-link/`;
  if (!await adapter.exists(`${oldRoot}data.json`)) return;
  const current = await readLocalSyncSettings(adapter, configDir, pluginId) as Record<string, unknown> | null;
  if (current && current.legacyMigrationPending !== true) return;
  const legacy = readObject(await adapter.read(`${oldRoot}data.json`));
  const local = current ?? { ...legacy, enabled: false, legacyMigrationPending: !copyState,
    // Recheck the new plugin privacy rules before native Git resumes.
    setupComplete: legacy.desktopLightweightEnabled === true ? legacy.setupComplete : false,
    setupStep: 1, setupFlowVersion: 2, setupVerified: undefined, setupBackup: undefined };
  const mobile = local.mobile;
  if (!current && mobile && typeof mobile === "object" && !Array.isArray(mobile)) {
    const options = mobile as Record<string, unknown>;
    if (Array.isArray(options.plugins)) options.plugins = options.plugins.map((id: unknown) => id === "simple-link" ? pluginId : id);
  }
  const hasState = await adapter.exists(`${configDir}/plugins/${pluginId}/link-state.json`);
  const files = [...(!current ? ["sync-settings.json"] : []), ...(copyState && !hasState ? ["link-state.json.recovery", "link-state.json", "mobile-ignore.json"] : [])];
  const copies: Array<{ path: string; content: string }> = [];
  for (const name of files) {
    const path = `${configDir}/plugins/${pluginId}/${name}`;
    if (await adapter.exists(path) || !await adapter.exists(oldRoot + name)) continue;
    const value = readObject(await adapter.read(oldRoot + name));
    const shareable = name === "sync-settings.json"
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "enabled" && sharedKeys.has(key))) : value;
    copies.push({ path, content: JSON.stringify(shareable, null, 2) });
  }
  // Validate all input before any write; local settings mark completion last.
  for (const copy of copies) await adapter.write(copy.path, copy.content);
  local.legacyMigrationPending = !copyState;
  await writeLocalSyncSettings(adapter, configDir, pluginId, local);
}

export function legacySyncRunning(app: App): boolean {
  const plugins = (app as App & { plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, { settings?: { enabled?: boolean } }> } }).plugins;
  if (plugins?.plugins?.["simple-link"]?.settings?.enabled === false) return false;
  return plugins?.enabledPlugins?.has("simple-link") === true || plugins?.plugins?.["simple-link"]?.settings?.enabled === true;
}
