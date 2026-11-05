import { agentDefaults, type AgentSettings } from "../agent/types";
export type Protocol = "openai" | "anthropic";
export interface ModelEntry { id: string; alias: string; }
export interface ApiSource {
  id: string;
  name: string;
  keyIds?: string[];
  activeKeyId?: string;
  rotateKeys?: boolean;
  protocol: Protocol;
  urlMode: "base" | "full";
  url: string;
  modelsUrl: string;
  modelsUrlMode?: "base" | "full";
  models: ModelEntry[];
  discoveredModels: string[];
}
export interface Settings {
  sendShortcut: "off" | "enter" | "shift-enter";
  agent: AgentSettings;
  cacheCleanupDays: number;
  archivedCacheCleanupDays: number;
  showSourceName: boolean;
  sources: ApiSource[];
  selected: { sourceId: string; modelId: string } | null;
}
export const defaults = (): Settings => ({ sendShortcut: "off", cacheCleanupDays: 7, archivedCacheCleanupDays: 1, showSourceName: true, sources: [], selected: null, agent: agentDefaults() });
export const newSource = (): ApiSource => ({
  id: crypto.randomUUID(), name: "", keyIds: [], protocol: "openai", urlMode: "base",
  url: "", modelsUrl: "", models: [], discoveredModels: [],
});
export function label(source: ApiSource, model: ModelEntry, showSourceName = true): string {
  const prefix = showSourceName ? source.name.trim() : "";
  return `${prefix ? `[${prefix}] ` : ""}${model.alias.trim() || model.id}`;
}
export function validateSource(source: ApiSource): void {
  if (!source.name.trim()) throw new Error("请填写来源名称。");
  const ids = source.models.map(m => m.id.trim());
  if (ids.some(id => !id)) throw new Error("请填写模型名称，或移除空白模型行。");
  if (new Set(ids).size !== ids.length) throw new Error("同一来源不能重复添加相同模型。");
}
