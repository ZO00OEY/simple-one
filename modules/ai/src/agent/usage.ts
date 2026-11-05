import type { RequestUsage, Session } from "./types";
import type { WorkRecord } from "./cooperation";

// Keep accounting independent of the bounded, text-heavy cooperation history.
export function trafficRecord(record: WorkRecord): WorkRecord {
  return { ...record, input: "", output: "", rules: "", evidence: undefined, error: undefined };
}

export function modelUsage(records: WorkRecord[]): { sourceName: string; modelId: string; requests: number; input: number; output: number; missingInput: number; missingOutput: number }[] {
  const models = new Map<string, ReturnType<typeof modelUsage>[number]>();
  for (const record of records) {
    const key = JSON.stringify([record.sourceId, record.modelId]);
    let model = models.get(key);
    if (!model) { model = { sourceName: record.sourceName, modelId: record.modelId, requests: 0, input: 0, output: 0, missingInput: 0, missingOutput: 0 }; models.set(key, model); }
    model.requests++;
    if (record.usage?.inputTokens === undefined) model.missingInput++; else model.input += record.usage.inputTokens;
    if (record.usage?.outputTokens === undefined) model.missingOutput++; else model.output += record.usage.outputTokens;
  }
  return [...models.values()];
}

// A local text estimate for heterogeneous providers, not a tokenizer or billed usage.
export function estimateTextTokens(text: string): number {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const other = Array.from(text).length - cjk;
  return Math.ceil(cjk * 1.5 + other / 4);
}

export function usageRecords(records: WorkRecord[], sessions: Session[], sessionId?: string): WorkRecord[] {
  const result = new Map(records.filter(r => !sessionId || r.sessionId === sessionId).map(r => [r.id, r]));
  for (const session of sessions) {
    if (sessionId && session.id !== sessionId) continue;
    for (const message of session.messages) {
      const actor = message.execution;
      if (message.inherited || message.role !== "assistant" || !actor || result.has(actor.recordId)) continue;
      result.set(actor.recordId, { id: actor.recordId, taskId: actor.taskId ?? message.taskId ?? "", sessionId: session.id,
        sourceId: actor.sourceId, sourceName: actor.sourceName ?? actor.sourceId, modelId: actor.modelId, role: actor.role,
        started: actor.started ?? message.timestamp ?? session.updated, ended: actor.ended, stage: "聊天记录",
        state: actor.state ?? (message.error ? "failed" : "done"), usage: message.usage, input: "", output: "", rules: "", truncated: false });
    }
  }
  return [...result.values()].sort((a, b) => b.started - a.started);
}

export function usageText(usage?: RequestUsage): string {
  return `输入 ${usage?.inputTokens ?? 0} / 输出 ${usage?.outputTokens ?? 0} / 缓存读取 ${usage?.cacheReadTokens ?? 0}`;
}
