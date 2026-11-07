export interface ImageInput { name: string; mime: string; data: string; id?: string; summary?: string; addedAt?: number; }
export interface Call { id: string; name: string; arguments: Record<string, unknown>; }
export interface TextInput { name: string; text: string; addedAt?: number; }
export interface RequestUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; }
export interface Message {
  process?: "auxiliary";
  delegateCallId?: string;
  usage?: RequestUsage;
  taskId?: string;
  execution?: { recordId: string; taskId?: string; sourceId: string; sourceName?: string; modelId: string; modelName?: string; role: RecordedModelRole; started?: number; ended?: number; state?: "running" | "done" | "failed" | "interrupted" };
  timestamp?: number;
  inherited?: boolean;
  diagnostic?: boolean;
  role: "user" | "assistant" | "tool";
  text: string;
  editHistory?: string[];
  reasoning?: string;
  images?: ImageInput[];
  files?: TextInput[];
  skills?: string[];
  calls?: Call[];
  callId?: string;
  error?: boolean;
  generated?: boolean;
}
export interface Tool { name: string; description: string; parameters: Record<string, unknown>; }
export interface Skill { id: string; name: string; description: string; body: string; path?: string; enabled: boolean; }
export interface AgentSettings {
  cooperation: CooperationSettings;
  instructions: string;
  instructionsEnabled?: boolean;
  references: string[];
  referenceRules: { id: string; pattern: string; description: string; enabled: boolean }[];
  disabledSkills: string[];
  skills: Skill[];
  contextChars: number;
  autoCompactTokens?: number;
  compactTargetTokens?: number;
  compactInstructions?: string;
  memory: { selected: Session["selected"]; follow?: "main" | "auxiliary"; quietMinutes: number; requestGapSeconds: number; enabled: boolean; path: string; idleHours: number; intervalHours?: number; inputLimitChars?: number; maxAgeDays: number; batch: number; dailyRequests: number; ignored: string; };
}
export const agentDefaults = (): AgentSettings => ({
  cooperation: cooperationDefaults(),
  instructions: "", references: [], disabledSkills: [], skills: [], contextChars: 100000, autoCompactTokens: 200000, compactTargetTokens: 4000, compactInstructions: "",
  referenceRules: [
    { id: "codex-agents", pattern: "AGENTS.md", description: "Codex 的项目规则文件。", enabled: true },
    { id: "claude-project", pattern: "CLAUDE.md", description: "Claude Code 的项目规则文件。", enabled: false },
  ],
  memory: { selected: null, follow: "auxiliary", quietMinutes: 5, requestGapSeconds: 60, enabled: false, path: "SIMPLE_AI.md", idleHours: 6, intervalHours: 12, inputLimitChars: 0, maxAgeDays: 30, batch: 16, dailyRequests: 20, ignored: "" },
});
export type ModelRole = "main" | "auxiliary" | "memory" | "examiner";
// Retired roles remain readable in history, never as new request/configuration roles.
export type RecordedModelRole = ModelRole | "review";
export type ModelSelection = { sourceId: string; modelId: string } | null;
export interface AuxiliaryCandidate {
  sourceId: string; modelId: string; description: string;
}
export interface CooperationSettings {
  auxiliary: { enabled: boolean; selected: ModelSelection; follow?: "main"; mode: "single" | "multiple"; candidates: AuxiliaryCandidate[]; supplementalInstructions?: string; description: string };
  examiner: { enabled: boolean; selected: ModelSelection; follow?: "main" | "auxiliary"; automatic: boolean; quietMinutes: number; idleHours: number; dailyRequests: number; gapSeconds: number };
}
export const defaultAuxiliaryUsage = "批量摘要、资料索引、资料检索；该模型执行能力强，但对复杂内容理解能力弱。";
export const cooperationDefaults = (): CooperationSettings => ({
  auxiliary: { enabled: true, selected: null, mode: "multiple", candidates: [], supplementalInstructions: "", description: defaultAuxiliaryUsage },
  examiner: { enabled: false, selected: null, automatic: false, quietMinutes: 10, idleHours: 6, dailyRequests: 6, gapSeconds: 60 },
});
export function normalizeReferencePattern(pattern: string): string {
  const normalized = notePath(pattern.trim().replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!normalized.toLowerCase().endsWith(".md")) throw new Error("请选择 Markdown 文件，或填写以 .md 结尾的路径规则。");
  return normalized;
}
export function matchesReferenceRule(path: string, pattern: string): boolean {
  try { path = notePath(path); pattern = normalizeReferencePattern(pattern); } catch { return false; }
  if (!path.toLowerCase().endsWith(".md") || !pattern.includes("/") && path.includes("/")) return false;
  const escaped = pattern.split("").map(c => c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return !!escaped && new RegExp(`^${escaped}$`, "i").test(path);
}
export function referencePaths(settings: AgentSettings, paths: string[]): string[] {
  return [...new Set([...settings.references, ...paths.filter(path => path !== settings.memory.path && (settings.referenceRules ?? []).some(r => r.enabled && matchesReferenceRule(path, r.pattern)))])];
}
export interface Change { id: string; kind: "create" | "edit" | "move" | "delete" | "folder-create" | "folder-delete" | "folder-move"; path: string; target?: string; before: string; after: string; createdFolders?: string[]; state: "proposed" | "applied" | "skipped" | "pending" | "done" | "undone" | "failed"; completedAt?: number; batchId?: string; links?: { path: string; before: string; after: string }[]; }
export interface Session {
  historyEdited?: boolean;
  parent?: { sessionId: string; messageIndex: number };
  id: string; title: string; updated: number; revision: number; archived: boolean; archivedAt?: number; pinned?: boolean;
  selected: { sourceId: string; modelId: string } | null;
  contextStart?: number; references?: string[]; folders?: string[]; skillIds?: string[]; permission?: "auto" | "full";
  draftSkills?: string[]; files?: TextInput[];
  messages: Message[]; draft: string; images: ImageInput[]; changes: Change[];
  status: "idle" | "running" | "interrupted"; problem: string; summary: string;
}
export interface MemorySummary { revision: number; text: string; updated: number; fingerprint?: string; processedChars?: number; prefixHash?: string; complete?: boolean; }
export interface PrivateState {
  sessions: Session[]; active: string;
  memory: { lastRunAt?: number; forgotten?: string[]; summaries: Record<string, MemorySummary>; merged: string; day: string; requests: number; versions: { path: string; before: string; after: string }[]; lastError: string; lastResult?: { kind: "success" | "error" | "paused"; text: string; at: number }; };
}
export const newState = (): PrivateState => ({ sessions: [], active: "", memory: { summaries: {}, merged: "", day: "", requests: 0, versions: [], lastError: "" } });
export function newSession(selected: Session["selected"]): Session {
  return { id: crypto.randomUUID(), title: "新会话", updated: Date.now(), revision: 0, archived: false, selected,
    messages: [], draft: "", images: [], changes: [], status: "idle", problem: "", summary: "" };
}
export function notePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("路径不能为空。");
  const path = value.trim().replace(/\\/g, "/");
  if (path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === ".." || p.startsWith(".")) || /[:\x00-\x1f]/.test(path)) throw new Error("只允许笔记库内的普通相对路径，不允许隐藏目录或上级路径。");
  return path;
}
export function numberArg(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}
export function memoryCandidates(sessions: Session[], summaries: Record<string, MemorySummary>, settings: AgentSettings["memory"], now: number): Session[] {
  return sessions.filter(s => s.status !== "running" && (s.revision > (summaries[s.id]?.revision ?? 0) || summaries[s.id]?.complete === false)
    && now - s.updated >= settings.idleHours * 3600000)
    .sort((a, b) => a.updated - b.updated);
}

/** Convert legacy single-model settings once; candidates are the sole active selection. */
export function migrateAuxiliary(cfg: CooperationSettings["auxiliary"], main: ModelSelection): void {
  if (cfg.mode !== "multiple") {
    const selected = cfg.selected ?? (cfg.enabled ? main : null);
    cfg.candidates = selected ? [{ ...selected, description: cfg.description || defaultAuxiliaryUsage }] : [];
  }
  cfg.candidates ??= [];
  cfg.candidates = cfg.candidates.filter((c, i, all) => all.findIndex(v => v.sourceId === c.sourceId && v.modelId === c.modelId) === i);
  cfg.mode = "multiple"; cfg.selected = null;
}
