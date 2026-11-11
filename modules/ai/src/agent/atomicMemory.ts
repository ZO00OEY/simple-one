import type { MemoryItem, MemorySummary } from "./types";
import { decodeMemoryItem } from "./storageSchema";

export const memoryStart = "<!-- simple-ai:memory:start -->", memoryEnd = "<!-- simple-ai:memory:end -->";
const format = "记忆条目 v1";
export function memoryRegion(text: string): { body: string; before: string; after: string; exists: boolean } {
  const a = text.indexOf(memoryStart), b = text.indexOf(memoryEnd);
  if ((a >= 0) !== (b >= 0) || b < a || a >= 0 && (text.indexOf(memoryStart, a + 1) >= 0 || text.indexOf(memoryEnd, b + 1) >= 0)) throw new Error("自动记忆区域标记不完整或重复，未写入。");
  return a < 0 ? { body: "", before: text, after: "", exists: false } : { body: text.slice(a + memoryStart.length, b).trim(), before: text.slice(0, a), after: text.slice(b + memoryEnd.length), exists: true };
}
const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/</g, "\\l");
function cells(line: string): string[] {
  const result: string[] = []; let cell = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") { const next = line[++i]; if (next === undefined || !["n", "r", "l", "|", "\\"].includes(next)) throw new Error("记忆转义格式无效。"); cell += next === "n" ? "\n" : next === "r" ? "\r" : next === "l" ? "<" : next; }
    else if (c === "|") { result.push(cell.trim()); cell = ""; } else cell += c;
  }
  result.push(cell.trim()); return result;
}
export function parseMemoryItems(text: string): MemoryItem[] | undefined {
  const body = memoryRegion(text).body;
  if (!body.startsWith(format)) return;
  const lines = body.split(/\r?\n/);
  if (lines[1] !== "正文 | ID | 种类 | 置信度 | 状态 | 来源 | 首次时间 | 确认时间 | 范围 | 置顶 | 废弃原因") throw new Error("记忆条目表头无效，未覆盖文件。");
  const items = lines.slice(2).filter(line => line.trim()).map(line => {
    if (!line.startsWith("- ")) throw new Error("记忆条目格式无效，未覆盖文件。");
    const [text, id, kind, confidence, status, sourceSessionId, source, confirmed, scope, pinned, retiredReason, extra] = cells(line.slice(2));
    if (extra !== undefined || retiredReason === undefined || !["是", "否"].includes(pinned) || !/^\d{4}-/.test(source) || !/^\d{4}-/.test(confirmed)) throw new Error("记忆条目字段无效。");
    return decodeMemoryItem({ text, id, kind, confidence, status, sourceSessionId, sourceDate: Date.parse(source), lastConfirmedAt: Date.parse(confirmed), scope, pinned: pinned === "是", retiredReason });
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("记忆 ID 重复，未覆盖文件。");
  return items;
}
export function renderMemoryItems(items: MemoryItem[]): string {
  return format + "\n正文 | ID | 种类 | 置信度 | 状态 | 来源 | 首次时间 | 确认时间 | 范围 | 置顶 | 废弃原因\n" + items.map(raw => {
    const item = decodeMemoryItem(raw);
    return "- " + [item.text, item.id, item.kind, item.confidence, item.status, item.sourceSessionId ?? "", new Date(item.sourceDate).toISOString(), new Date(item.lastConfirmedAt).toISOString(), item.scope ?? "", item.pinned ? "是" : "否", item.retiredReason ?? ""].map(escape).join(" | ");
  }).join("\n");
}
export function replaceMemoryItems(before: string, items: MemoryItem[]): string {
  const region = memoryRegion(before), block = memoryStart + "\n" + renderMemoryItems(items) + "\n" + memoryEnd;
  return region.exists ? region.before + block + region.after : before + (before ? "\n\n" : "# Simple AI 记忆\n\n") + block + "\n";
}
export const memoryIdentity = (text: string, scope = "") => (scope + "\n" + text).normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
/** Legacy prose is unverified: retain it verbatim as pending, never invent certainty. */
export function migrateMemoryItems(summaries: Record<string, MemorySummary>, existing: MemoryItem[] = [], forgotten: string[] = []): MemoryItem[] {
  const items = existing.map(item => ({ ...item }));
  for (const [sourceSessionId, summary] of Object.entries(summaries)) {
    if (forgotten.includes(sourceSessionId) || !summary.text.trim() || summary.text.trim() === "NONE") continue;
    for (const line of summary.text.split(/\r?\n/).filter(line => line.trim())) {
      const key = memoryIdentity(line);
      if (items.some(item => item.sourceSessionId === sourceSessionId && memoryIdentity(item.text) === key)) continue;
      items.push({ id: crypto.randomUUID(), kind: "fact", text: line, sourceSessionId, sourceDate: summary.updated, lastConfirmedAt: summary.updated, confidence: "low", status: "pending" });
    }
  }
  return items;
}
