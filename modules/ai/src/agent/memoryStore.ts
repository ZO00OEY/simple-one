import { expireMemories, retrieveMemories } from "./memoryRetrieval";
import { applyMemoryDeltas, type MemoryDelta } from "./memoryDeltas";
import { TFile } from "obsidian";
import type { AgentRuntime } from "./runtime";
import type { MemoryItem } from "./types";
import { notePath } from "./types";
import { decodeMemoryItem } from "./storageSchema";
import { memoryIdentity, renderMemoryItems, memoryRegion, migrateMemoryItems, parseMemoryItems, replaceMemoryItems } from "./atomicMemory";

/** Markdown is authoritative; the private copy is only an index and undo journal. */
export class AtomicMemoryStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private runtime: AgentRuntime) {}
  private get plugin() { return this.runtime.plugin; }
  async read(): Promise<{ text: string; items: MemoryItem[] }> {
    const path = notePath(this.plugin.settings.agent.memory.path), file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file && !(file instanceof TFile)) throw new Error("记忆路径不是文件。");
    const text = file instanceof TFile ? await this.plugin.app.vault.read(file) : "";
    const parsed = parseMemoryItems(text);
    if (parsed) return { text, items: parsed };
    const memory = this.runtime.state.memory;
    if (memory.migratedAt) {
      if (memory.items?.length) throw new Error("结构化记忆区域已移除，请恢复文件或修复标记；未从索引覆盖。");
      return { text, items: [] };
    }
    const items = migrateMemoryItems(memory.summaries, [], memory.forgotten);
    const body = memoryRegion(text).body;
    if (body && body !== "暂无长期记忆。") items.push({ id: crypto.randomUUID(), kind: "fact", text: body, sourceSessionId: "file:" + path, sourceDate: 0, lastConfirmedAt: 0, confidence: "low", status: "pending" });
    return { text, items };
  }
  async context(query: string): Promise<string> {
    const { text, items } = await this.read();
    const next = expireMemories(items, this.plugin.settings.agent.memory.maxAgeDays);
    if (next.some((item, i) => item !== items[i]) || !parseMemoryItems(text) && next.length) await this.write(next, text);
    const region = memoryRegion(text), manual = (region.before + region.after).trim();
    return (manual ? "记忆文件手写区域（资料）：\n" + manual.slice(0, 2000) + (manual.length > 2000 ? "\n[手写区域截断，可用 read_note 读取]" : "") + "\n" : "") + retrieveMemories(next, query);
  }
  async migrate(): Promise<MemoryItem[]> {
    const { text, items } = await this.read();
    if (!parseMemoryItems(text) && (items.length || memoryRegion(text).exists)) await this.write(items, text);
    return items;
  }
  write(items: MemoryItem[], expected: string, guard: () => void = () => {}): Promise<void> {
    const validated = items.map(decodeMemoryItem), path = notePath(this.plugin.settings.agent.memory.path);
    if (new Set(validated.map(item => item.id)).size !== validated.length) return Promise.reject(new Error("记忆 ID 重复。"));
    const operation = this.writes.then(async () => {
      guard();
      if (path !== this.plugin.settings.agent.memory.path) throw new Error("记忆路径已变化，未写入。");
      const vault = this.plugin.app.vault, file = vault.getAbstractFileByPath(path);
      const after = replaceMemoryItems(expected, validated);
      if (file instanceof TFile) await vault.process(file, current => { guard(); if (current !== expected) throw new Error("记忆文件已变化，请重试。"); return after; });
      else { if (file || expected) throw new Error("记忆文件已变化，请重试。"); guard(); await vault.create(path, after); }
      const memory = this.runtime.state.memory;
      if (after !== expected) { memory.versions.push({ path, before: expected, after }); memory.versions = memory.versions.slice(-10); }
      memory.items = validated; memory.migratedAt ??= Date.now();
      await this.runtime.save(); this.runtime.changed();
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  async apply(deltas: MemoryDelta[], sources: { id: string; date: number; users: string[] }[], guard: () => void = () => {}, snapshot?: { text: string; items: MemoryItem[] }): Promise<MemoryItem[]> {
    const { text, items } = snapshot ?? await this.read();
    const next = applyMemoryDeltas(items, deltas, sources, this.runtime.state.memory.forgottenItems);
    const changed = next.filter(item => {
      const previous = items.find(old => old.id === item.id);
      return !previous || renderMemoryItems([previous]) !== renderMemoryItems([item]);
    });
    const memory = this.runtime.state.memory;
    if (changed.length) {
      memory.itemVersions = [...(memory.itemVersions ?? []), ...changed.map(after => ({ id: after.id, before: items.find(item => item.id === after.id), after }))].slice(-30);
      await this.write(next, text, guard);
    } else if (!parseMemoryItems(text) && next.length) await this.write(next, text, guard);
    return changed;
  }
  async edit(id: string, patch: Pick<MemoryItem, "text" | "scope" | "pinned"> | null): Promise<void> {
    this.runtime.userActive();
    if (this.runtime.busy || this.runtime.memoryBusy || this.plugin.cooperation?.busy) throw new Error("请等待模型任务结束后管理记忆。");
    const { text, items } = await this.read(), before = items.find(item => item.id === id);
    if (!before) throw new Error("记忆条目不存在。");
    const after = patch ? decodeMemoryItem({ ...before, ...patch, status: "active", confidence: "high", lastConfirmedAt: Date.now() }) : undefined;
    const next = items.flatMap(item => item.id === id ? after ? [after] : [] : [item]);
    const memory = this.runtime.state.memory;
    memory.itemVersions = [...(memory.itemVersions ?? []), { id, before, after }].slice(-30);
    if (!after) memory.forgottenItems = [...new Set([...(memory.forgottenItems ?? []), memoryIdentity(before.text, before.scope)])];
    await this.write(next, text);
  }
  async undo(id: string): Promise<void> {
    this.runtime.userActive();
    if (this.runtime.busy || this.runtime.memoryBusy || this.plugin.cooperation?.busy) throw new Error("请等待模型任务结束后撤销记忆。");
    const memory = this.runtime.state.memory, versions = memory.itemVersions ?? [];
    const index = versions.map(v => v.id).lastIndexOf(id), version = versions[index];
    if (!version) throw new Error("没有这条记忆的可撤销版本。");
    const { text, items } = await this.read(), current = items.find(item => item.id === id);
    if ((current ? renderMemoryItems([current]) : "") !== (version.after ? renderMemoryItems([version.after]) : "")) throw new Error("记忆已变化，未覆盖后续修改。");
    const related = versions.filter(entry => entry !== version && entry.after?.status === "retired" && entry.after.retiredReason?.includes(id));
    for (const entry of related) {
      const value = items.find(item => item.id === entry.id);
      if (!value || renderMemoryItems([value]) !== renderMemoryItems([entry.after!])) throw new Error("被取代记忆已变化，未覆盖后续修改。");
    }
    const restoring = [version, ...related], ids = new Set(restoring.map(entry => entry.id));
    const next = [...items.filter(item => !ids.has(item.id)), ...restoring.flatMap(entry => entry.before ? [entry.before] : [])];
    memory.itemVersions = versions.filter(entry => !restoring.includes(entry));
    if (version.before) memory.forgottenItems = memory.forgottenItems?.filter(key => key !== memoryIdentity(version.before!.text, version.before!.scope));
    await this.write(next, text);
  }
}
