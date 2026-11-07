import { newState, type Call, type Change, type ImageInput, type MemorySummary, type Message, type PrivateState, type Session, type TextInput } from "./types";

// Decode copies, retaining unknown fields for newer versions. Missing historical
// fields may receive defaults; present but malformed collections must never be
// replaced with empty arrays (a later save could otherwise delete attachments).
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("存储对象格式无效。");
  return { ...value };
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("存储文本格式无效。");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("存储数字格式无效。");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("存储布尔值格式无效。");
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  const result = string(value);
  const match = values.find(entry => entry === result);
  if (match === undefined) throw new Error("存储状态格式无效。");
  return match;
}
function id(value: unknown): string {
  const result = string(value);
  if (!/^[\w-]+$/.test(result)) throw new Error("存储标识格式无效。");
  return result;
}
function array<T>(value: unknown, decode: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("存储列表格式无效。");
  return value.map(decode);
}
function optional(o: ObjectValue, key: string, decode: (value: unknown) => unknown): void {
  if (o[key] !== undefined) o[key] = decode(o[key]);
}
function fields(o: ObjectValue, keys: string[], decode: (value: unknown) => unknown): void {
  for (const key of keys) optional(o, key, decode);
}
const strings = (value: unknown) => array(value, string);
function selection(value: unknown): Session["selected"] {
  if (value === null) return null;
  const o = object(value); return { ...o, sourceId: string(o.sourceId), modelId: string(o.modelId) };
}
function image(value: unknown): ImageInput {
  const o = object(value);
  o.name = string(o.name); o.mime = string(o.mime);
  optional(o, "summary", string); optional(o, "id", id); optional(o, "addedAt", number);
  // Persisted images omit inline data, while legacy snapshots still contain it.
  optional(o, "data", string);
  if (o.id === undefined && o.data === undefined) throw new Error("图片引用格式无效。");
  o.data ??= "";
  return { ...o, name: string(o.name), mime: string(o.mime), data: string(o.data) };
}
function file(value: unknown): TextInput {
  const o = object(value); optional(o, "addedAt", number); return { ...o, name: string(o.name), text: string(o.text) };
}
function call(value: unknown): Call {
  const o = object(value); return { ...o, id: string(o.id), name: string(o.name), arguments: object(o.arguments) };
}
function message(value: unknown): Message {
  const o = object(value);
  if (!["user", "assistant", "tool"].includes(string(o.role))) throw new Error("消息角色格式无效。");
  o.text = string(o.text);
  fields(o, ["reasoning", "process", "delegateCallId", "taskId", "callId"], string);
  optional(o, "process", v => choice(v, ["auxiliary"]));
  fields(o, ["inherited", "diagnostic", "error", "generated"], boolean);
  optional(o, "timestamp", number); fields(o, ["editHistory", "skills"], strings);
  optional(o, "images", v => array(v, image)); optional(o, "files", v => array(v, file)); optional(o, "calls", v => array(v, call));
  optional(o, "usage", value => { const usage = object(value); fields(usage, ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"], number); return usage; });
  optional(o, "execution", value => {
    const execution = object(value);
    fields(execution, ["recordId", "taskId", "sourceId", "sourceName", "modelId", "modelName", "role", "state"], string);
    for (const key of ["recordId", "sourceId", "modelId"]) execution[key] = string(execution[key]);
    execution.role = choice(execution.role, ["main", "auxiliary", "memory", "examiner", "review"]);
    optional(execution, "state", v => choice(v, ["running", "done", "failed", "interrupted"]));
    fields(execution, ["started", "ended"], number); return execution;
  });
  return { ...o, role: choice(o.role, ["user", "assistant", "tool"]), text: string(o.text) };
}
// The other private JSON stores use the same lossless boundary checks.
export { object, string, number, boolean, choice, array, optional, fields, strings, selection, message as decodeMessage };
function version(value: unknown): ObjectValue {
  const o = object(value); for (const key of ["path", "before", "after"]) o[key] = string(o[key]); return o;
}
function change(value: unknown): Change {
  const o = version(value); o.id = string(o.id);
  o.kind = choice(o.kind, ["create", "edit", "move", "delete", "folder-create", "folder-delete", "folder-move"]);
  o.state = choice(o.state, ["proposed", "applied", "skipped", "pending", "done", "undone", "failed"]);
  fields(o, ["target", "batchId"], string); optional(o, "completedAt", number); optional(o, "createdFolders", strings);
  optional(o, "links", v => array(v, version));
  return { ...o, id: string(o.id), path: string(o.path), before: string(o.before), after: string(o.after),
    kind: choice(o.kind, ["create", "edit", "move", "delete", "folder-create", "folder-delete", "folder-move"]),
    state: choice(o.state, ["proposed", "applied", "skipped", "pending", "done", "undone", "failed"]) };
}
export function decodeSession(value: unknown, expectedId?: string): Session {
  const o = object(value); o.id = id(o.id);
  if (expectedId !== undefined && o.id !== expectedId) throw new Error("会话标识不匹配。");
  const messages = array(o.messages, message), images = array(o.images, image), changes = array(o.changes, change);
  optional(o, "files", v => array(v, file));
  fields(o, ["title", "draft", "problem", "summary", "status", "permission"], string);
  optional(o, "status", v => choice(v, ["idle", "running", "interrupted"]));
  optional(o, "permission", v => choice(v, ["auto", "full"]));
  fields(o, ["updated", "revision", "archivedAt", "contextStart"], number);
  fields(o, ["archived", "pinned", "historyEdited"], boolean);
  fields(o, ["references", "folders", "skillIds", "draftSkills"], strings); optional(o, "selected", selection);
  optional(o, "parent", value => { const parent = object(value); parent.sessionId = id(parent.sessionId); parent.messageIndex = number(parent.messageIndex); return parent; });
  // These scalar/collection defaults predate split storage. No existing value is discarded.
  return { ...o, id: id(o.id), title: string(o.title ?? "新会话"), updated: number(o.updated ?? 0), revision: number(o.revision ?? 0), archived: boolean(o.archived ?? false), selected: selection(o.selected ?? null),
    draft: string(o.draft ?? ""), images, changes, messages,
    status: choice(o.status ?? "idle", ["idle", "running", "interrupted"]), problem: string(o.problem ?? ""), summary: string(o.summary ?? "") };
}
export function decodeMemory(value: unknown): PrivateState["memory"] {
  const o = object(value), rawSummaries = object(o.summaries), summaries: Record<string, MemorySummary> = {};
  for (const [key, value] of Object.entries(rawSummaries)) {
    const summary = object(value);
    summary.text = string(summary.text); summary.revision = number(summary.revision); summary.updated = number(summary.updated);
    fields(summary, ["fingerprint", "prefixHash"], string); optional(summary, "processedChars", number); optional(summary, "complete", boolean);
    Object.defineProperty(summaries, key, { value: { ...summary, text: string(summary.text), revision: number(summary.revision), updated: number(summary.updated) }, enumerable: true, writable: true, configurable: true });
  }
  const versions = array(o.versions, value => { const v = version(value); return { ...v, path: string(v.path), before: string(v.before), after: string(v.after) }; });
  optional(o, "forgotten", strings);
  fields(o, ["merged", "day", "lastError"], string); fields(o, ["requests", "lastRunAt"], number);
  optional(o, "lastResult", value => { const result = object(value); result.kind = choice(result.kind, ["success", "error", "paused"]); result.text = string(result.text); result.at = number(result.at); return result; });
  return { ...o, summaries, versions,
    merged: string(o.merged ?? ""), day: string(o.day ?? ""), requests: number(o.requests ?? 0), lastError: string(o.lastError ?? "") };
}
export function decodeIndex(value: unknown): { version: 2; active: string; sessions: string[] } {
  const o = object(value);
  if (o.version !== 2) throw new Error("会话索引版本无效。");
  const sessions = array(o.sessions, id); optional(o, "active", string);
  if (new Set(sessions).size !== sessions.length) throw new Error("会话索引包含重复标识。");
  return { ...o, version: 2, active: string(o.active ?? ""), sessions };
}
export function decodePrivateState(value: unknown, sessionOnlySnapshot = false): PrivateState {
  const o = object(value), sessions = array(o.sessions, v => decodeSession(v));
  optional(o, "active", string);
  // Attachment cleanup also supports historical session-only recovery exports;
  // runtime loading must never treat a missing memory store as empty memory.
  return { ...o, active: string(o.active ?? ""), sessions,
    memory: o.memory === undefined && sessionOnlySnapshot ? newState().memory : decodeMemory(o.memory) };
}
