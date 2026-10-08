import type { App, DataAdapter } from "obsidian";

const localPath = (configDir: string, pluginId: string) => `${configDir}/plugins/${pluginId}/sync-local.json`;
const apiWrites = new WeakMap<DataAdapter, Promise<void>>();
export async function readApiLocal(adapter: DataAdapter, configDir: string, pluginId: string): Promise<Record<string, unknown>> {
  const path = `${configDir}/plugins/${pluginId}/sync-api-local.json`;
  for (const candidate of [path, path + ".recovery"]) {
    if (!await adapter.exists(candidate)) continue;
    try { return readObject(await adapter.read(candidate)); } catch (error) {
      if (candidate.endsWith(".recovery")) throw error;
    }
  }
  if (await adapter.exists(path)) throw new Error("API 本机数据损坏，已停止覆盖，请保留文件检查。");
  return {};
}
export function writeApiLocal(adapter: DataAdapter, configDir: string, pluginId: string, patch: Record<string, unknown>): Promise<void> {
  const operation = (apiWrites.get(adapter) ?? Promise.resolve()).then(async () => {
    const value = { ...await readApiLocal(adapter, configDir, pluginId), ...patch };
    const path = `${configDir}/plugins/${pluginId}/sync-api-local.json`;
    const text = JSON.stringify(value);
    await adapter.write(path + ".recovery", text);
    await adapter.write(path, text);
  });
  apiWrites.set(adapter, operation.catch(() => {}));
  return operation;
}

function readObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("同步配置格式错误，已保留原文件。");
  return value as Record<string, unknown>;
}

export async function readLocalSyncSettings(adapter: DataAdapter, configDir: string, pluginId: string): Promise<unknown> {
  const path = localPath(configDir, pluginId);
  const local = await adapter.exists(path) ? readObject(await adapter.read(path)) : {};
  const api = await readApiLocal(adapter, configDir, pluginId);
  if (api.settings && typeof api.settings === "object") Object.assign(local, api.settings);
  const logPath = `${configDir}/plugins/${pluginId}/sync-log.json`;
  if (await adapter.exists(logPath)) {
    const logs = readObject(await adapter.read(logPath));
    for (const key of ["errorLogs", "lastSyncAt", "lastPullAt"]) if (logs[key] !== undefined) local[key] = logs[key];
  }
  return Object.keys(local).length ? local : null;
}

export async function writeLocalSyncSettings(adapter: DataAdapter, configDir: string, pluginId: string, value: unknown): Promise<void> {
  const settings = { ...(value as Record<string, unknown>) };
  const apiSettings: Record<string, unknown> = {};
  for (const key of ["mobile", "mobileSyncEnabled", "lightweightGuideProgress"]) {
    if (settings[key] !== undefined) apiSettings[key] = settings[key];
    delete settings[key];
  }
  if (Object.keys(apiSettings).length) await writeApiLocal(adapter, configDir, pluginId, { settings: apiSettings });
  const logs: Record<string, unknown> = {};
  for (const key of ["errorLogs", "lastSyncAt", "lastPullAt"]) {
    if (settings[key] !== undefined) logs[key] = settings[key];
    delete settings[key];
  }
  if (Object.keys(logs).length) await adapter.write(`${configDir}/plugins/${pluginId}/sync-log.json`, JSON.stringify(logs, null, 2));
  await adapter.write(localPath(configDir, pluginId), JSON.stringify(settings, null, 2));
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
