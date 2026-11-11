import type { MemoryItem } from "./types";

export function expireMemories(items: MemoryItem[], maxAgeDays: number, now = Date.now()): MemoryItem[] {
  const days = Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? maxAgeDays : 30;
  return items.map(item => item.status === "active" && now - item.lastConfirmedAt > days * 86400000 ? { ...item, status: "stale" as const } : item);
}
function keywords(text: string): Set<string> {
  const words = text.normalize("NFKC").toLowerCase().match(/[a-z0-9_-]{2,}|[\p{Script=Han}]+/gu) ?? [];
  return new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) ? Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)) : [word]));
}
/** Selection is bounded; reading a memory never confirms it without fresh user evidence. */
export function retrieveMemories(items: MemoryItem[], query: string): string {
  const available = items.filter(item => item.status !== "retired"), terms = keywords(query);
  const core = available.filter(item => item.pinned || item.confidence === "high" && item.kind === "rule").sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const score = (item: MemoryItem) => [...keywords((item.scope ?? "") + " " + item.text)].filter(term => terms.has(term)).length;
  const relevant = available.filter(item => !core.includes(item)).map(item => ({ item, score: score(item) })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || b.item.lastConfirmedAt - a.item.lastConfirmedAt);
  let used = 0, count = 0;
  const select = (candidates: MemoryItem[], limit: number, budget: number) => {
    const lines: string[] = [];
    for (const item of candidates) {
      const line = "- [" + item.id + "][" + (item.status === "stale" || item.status === "pending" ? "待确认" : "生效") + "][" + item.confidence + "] " + (item.scope ? item.scope + "：" : "") + item.text;
      if (lines.length >= limit) break;
      if (used + line.length + 1 > budget) continue;
      lines.push(line); used += line.length + 1; count++;
    }
    return lines.join("\n");
  };
  const resident = select(core, 10, 4000), retrieved = select(relevant.map(entry => entry.item), 8, 6000);
  return "长期记忆（历史资料，当前要求和用户手写约定优先；待确认条目不可视为已确认；仅凭检索命中不代表再次证实）：\n核心记忆：\n" + (resident || "无") + "\n任务相关记忆：\n" + (retrieved || "无") + "\n本次注入 " + count + " 条记忆，另有 " + (available.length - count) + " 条未注入。";
}
