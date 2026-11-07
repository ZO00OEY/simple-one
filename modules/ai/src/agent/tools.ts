import { isRecord } from "./json";
import { NoteSearch, inScope } from "./search";
import { App, TFile, TFolder } from "obsidian";
import { notePath, numberArg, referencePaths, type AgentSettings, type Call, type Change, type Session, type Tool } from "./types";
import { skillsFor } from "./skills";
const str = { type: "string" };
const integer = { type: "integer", minimum: 0 };
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool {
  return { name, description, parameters: { type: "object", properties, required, additionalProperties: false } };
}
export const noteTools: Tool[] = [
  tool("create_folder", "在笔记库内创建文件夹，可补齐缺失父目录；已有同名目录不重复创建，不覆盖文件。", { path: str }, ["path"]),
  tool("delete_folder", "将文件夹及内容移入 Obsidian 回收站，不永久删除。先列目录核对范围；自动模式下非空目录生成待确认方案。不能操作隐藏配置或包含规则、技能、记忆的目录。", { path: str }, ["path"]),
  tool("move_folder", "移动或重命名文件夹及内容，通过 Obsidian FileManager 更新链接。目标父目录须存在；不能覆盖、移入自身或操作受保护内容。", { path: str, target: str }, ["path", "target"]),
  tool("inspect_path", "查询路径是否存在、类型、文件大小或目录直接子项数量，不读取正文。", { path: str }, ["path"]),
  tool("delegate_task", "将目标和责任范围明确、可独立完成的子任务交给子 Agent。task写清目标、范围、必要背景与用户纠正、相关资料、预期交付和完成标准；skillIds填写本任务需要的已启用技能ID，插件会在首次子模型请求前加载正文；task中写目标和约束，无需手抄技能正文。不自动携带主聊天历史。同一回复可派发多个独立任务，一项可涵盖相关的多项工作。多个候选时必须从已勾选列表填写sourceId和modelId，只有一个候选时可省略；按使用场景选择，不得调用未勾选的模型。用户点名时使用对应来源。requestLimit可限制本任务该模型的累计请求次数（正整数），遵守用户要求。子 Agent只读，主 Agent集中审核后写入；避免为微小任务增加委派往返。", { task: str, skillIds: { type: "array", items: { type: "string" }, uniqueItems: true, description: "从技能目录选择本任务所需ID，首次请求预加载正文。" }, sourceId: str, modelId: str, requestLimit: integer }, ["task"]),
  tool("list_folder", "列出目录的直接子项。path为空、.或./均表示根目录，offset分页；不包括隐藏配置。", { path: str, offset: integer }, ["path"]),
  tool("search_notes", "本地关键词搜索，优先标题/别名/标签。先用 mode=metadata 定位，再用全文搜索。createdDays/modifiedDays 查询最近笔记，此时 query 可为空。offset 为结果分页。", { query: str, folder: str, offset: integer, mode: str, createdDays: integer, modifiedDays: integer }, ["query"]),
  tool("read_note", "读取笔记并登记当前版本，编辑前必须读取。offset 按字符分页，每页最多16000字符。", { path: str, offset: integer }, ["path"]),
  tool("create_note", "创建 .md/.canvas/.base 文件；不覆盖已有文件。父目录必须已经存在。", { path: str, content: str }, ["path", "content"]),
  tool("edit_note", "精确替换已读取笔记中唯一出现的 oldText，保留其他内容。若版本已变或匹配不唯一则失败。", { path: str, oldText: str, newText: str }, ["path", "oldText", "newText"]),
  tool("delete_note", "将已读取的单篇 .md/.canvas/.base 笔记移入 Obsidian 回收站。检查版本；自动模式生成待确认项，完全授权模式直接执行。规则、技能、记忆文件受保护。不是API密钥权限。", { path: str }, ["path"]),
  tool("move_note", "移动或重命名已读取笔记，遵循 Obsidian 链接更新设置。目标父目录必须存在，不能覆盖。", { path: str, target: str }, ["path", "target"]),
  tool("inspect_image", "重新查看本会话原始截图，核实文字摘要不明确的细节。", { id: str, question: str }, ["id", "question"]),
  tool("propose_changes", "生成可勾选应用的批量方案，不修改笔记库。items 为对象数组，每项 name 是操作工具名，不能填笔记标题；arguments是该工具参数。例如 name=move_note，arguments={path:旧.md,target:目录/新.md}。支持 create_note/edit_note/move_note/delete_note/create_folder/delete_folder/move_folder。编辑或移动笔记前须读取。依赖新目录的笔记应在目录创建后再操作。", { items: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", properties: { name: { type: "string", enum: ["create_note", "edit_note", "move_note", "delete_note", "create_folder", "delete_folder", "move_folder"] }, arguments: { type: "object", description: "对应工具的参数，参照该工具定义。" } }, required: ["name", "arguments"], additionalProperties: false } } }, ["items"]),
  tool("apply_plan", "仅完全授权模式可用：执行已生成方案中指定的待应用项。ids 是方案 ID 的 JSON 字符串数组。检查版本，失败时保留已完成项。", { ids: str }, ["ids"]),
  tool("read_skill", "按技能 ID 读取完整技能正文。", { id: str }, ["id"]),
];
export const toolLabels: Record<string, string> = { delegate_task: "委派辅助任务", apply_plan: "执行整理方案", inspect_image: "核对原图", propose_changes: "生成整理方案", list_folder: "查看目录", search_notes: "搜索笔记", read_note: "读取笔记", create_note: "创建笔记", edit_note: "修改笔记", move_note: "移动或重命名", read_skill: "读取技能说明" };
export function validateCall(call: Call): void {
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error("arguments必须为参数对象。");
  const def = noteTools.find(t => t.name === call.name);
  if (!def) throw new Error(`未知工具：${call.name}`);
  const props = def.parameters.properties as Record<string, { type: string }>;
  for (const name of def.parameters.required as string[]) if (!(name in call.arguments)) throw new Error(`缺少参数：${name}`);
  for (const [key, value] of Object.entries(call.arguments)) {
    if (!props[key]) throw new Error(`未知参数：${key}`);
    if (props[key].type === "array" && !Array.isArray(value) && !(call.name === "propose_changes" && typeof value === "string")) throw new Error(`${key} 必须为对象数组。`);
    if (props[key].type === "string" && typeof value !== "string") throw new Error(`${key} 必须是字符串。`);
    if (props[key].type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) throw new Error(`${key} 必须为非负整数。`);
  }
}
Object.assign(toolLabels, { delete_note: "笔记移入回收站", create_folder: "创建文件夹", delete_folder: "删除文件夹", move_folder: "移动/重命名文件夹", inspect_path: "检查路径" });

export function folderSnapshot(folder: TFolder): string {
  const entries: { path: string; folder: boolean; size?: number; mtime?: number }[] = [];
  const visit = (parent: TFolder) => {
    for (const child of parent.children) {
      if (entries.length >= 2000) throw new Error("目录超过 2000 个子项，请缩小操作范围。");
      entries.push({ path: child.path, folder: child instanceof TFolder, ...(child instanceof TFile ? { size: child.stat.size, mtime: child.stat.mtime } : {}) });
      if (child instanceof TFolder) visit(child);
    }
  };
  visit(folder); return JSON.stringify(entries.sort((a, b) => a.path.localeCompare(b.path)));
}
export function changeCall(change: Change): Call {
  const name = { delete: "delete_note", create: "create_note", edit: "edit_note", move: "move_note", "folder-create": "create_folder", "folder-delete": "delete_folder", "folder-move": "move_folder" }[change.kind];
  return { id: crypto.randomUUID(), name, arguments: change.kind === "create" ? { path: change.path, content: change.after } : change.kind === "edit" ? { path: change.path, oldText: change.before, newText: change.after } : change.target ? { path: change.path, target: change.target } : { path: change.path } };
}
export class VaultTools {
  private reads = new Map<string, string>();
  constructor(private app: App, private session: Session, private settings: AgentSettings, private save: () => Promise<void>, private stopped: () => boolean, private search = new NoteSearch(app), private batchId = crypto.randomUUID(), private approved = false) {}
  restoreReads(messages: Session["messages"]): void {
    const calls = new Map(messages.flatMap(m => (m.calls ?? []).filter(c => c.name === "read_note").map(c => [c.id, c])));
    for (const message of messages) {
      if (message.role !== "tool" || message.error || message.process || !calls.has(message.callId ?? "")) continue;
      try { const result: unknown = JSON.parse(message.text); if (isRecord(result) && typeof result.path === "string" && typeof result.content === "string" && result.totalChars === result.content.length) this.reads.set(result.path, result.content); } catch { continue; }
    }
  }
  private check(): void { if (this.stopped()) throw new Error("任务已停止。"); }
  private scope(path: string): void { if (!inScope(this.session, path) && !this.session.references?.includes(path)) throw new Error("笔记不在本会话参考范围内。"); }
  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile) || !["md", "canvas", "base"].includes(f.extension)) throw new Error("只支持已存在的 Markdown、Canvas 或 Bases 笔记。");
    return f;
  }
  private parent(path: string): void {
    if (!/\.(md|canvas|base)$/i.test(path)) throw new Error("仅允许 .md/.canvas/.base 笔记。");
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!parent) return;
    if (!(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new Error("父目录不存在，请选用已有目录。");
  }
  private async fresh(path: string): Promise<string> {
    const current = await this.app.vault.read(this.file(path));
    if (!this.reads.has(path) || this.reads.get(path) !== current) throw new Error("笔记尚未读取或内容已发生变化，请重新读取后修改。");
    return current;
  }
  async prepareChange(change: Change): Promise<Call> {
    if (change.kind.startsWith("folder-") && change.kind !== "folder-create") {
      const folder = this.app.vault.getAbstractFileByPath(change.path);
      if (!(folder instanceof TFolder) || folderSnapshot(folder) !== change.before) throw new Error(`目录已变化，方案已过期：${change.path}`);
    } else if (change.kind === "edit" || change.kind === "move" || change.kind === "delete") {
      const current = await this.app.vault.read(this.file(change.path));
      if (current !== change.before) throw new Error(`方案已过期：${change.path}`);
      this.reads.set(change.path, current);
    }
    return changeCall(change);
  }
  private async folderOperation(call: Call, path: string, preview: boolean): Promise<unknown> {
    const vault = this.app.vault;
    if (!inScope(this.session, path)) throw new Error("目录不在本会话范围内。");
    if (!preview && !this.approved && this.session.permission !== "full" && this.session.changes.some(c => c.state === "proposed")) throw new Error("已有待确认方案，不能绕过确认修改目录。");
    const current = vault.getAbstractFileByPath(path);
    const protect = (p: string) => {
      notePath(p);
      if (!inScope(this.session, p)) throw new Error("目录包含范围外的内容。");
      if (referencePaths(this.settings, [p]).includes(p) || p === this.settings.memory.path || this.settings.skills.some(s => s.path === p)) throw new Error("目录包含受保护的规则、技能或记忆文件，不能操作。");
    };
    protect(path);
    let before = "", target: string | undefined;
    const createdFolders: string[] = [];
    if (call.name === "create_folder") {
      if (current instanceof TFolder) return { ok: true, path, existed: true };
      if (current) throw new Error("路径已被文件占用。");
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/"); const existing = vault.getAbstractFileByPath(p);
        if (existing && !(existing instanceof TFolder)) throw new Error("父路径被文件占用。");
        if (!existing) { protect(p); createdFolders.push(p); }
      }
    } else {
      if (!(current instanceof TFolder)) throw new Error("目录不存在或路径不是目录。");
      before = folderSnapshot(current);
      for (const entry of JSON.parse(before) as { path: string }[]) protect(entry.path);
      if (call.name === "move_folder") {
        target = notePath(call.arguments.target); protect(target);
        if (target === path || target.startsWith(path + "/")) throw new Error("不能移动到自身或自身子目录。");
        if (vault.getAbstractFileByPath(target)) throw new Error("目标已存在，不会覆盖。");
        const parent = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
        if (parent && !(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new Error("目标父目录不存在，请先创建。");
        for (const entry of JSON.parse(before) as { path: string }[]) protect(target + entry.path.slice(path.length));
      }
    }
    const requiresApproval = call.name === "delete_folder" && before !== "[]" && !this.approved && this.session.permission !== "full";
    const change: Change = { id: call.id, kind: call.name === "create_folder" ? "folder-create" : call.name === "delete_folder" ? "folder-delete" : "folder-move", path, target, before, after: "[]", createdFolders,
      state: preview || requiresApproval ? "proposed" : "pending", batchId: this.batchId };
    this.session.changes.push(change); await this.save(); this.check();
    if (change.state === "proposed") {
      const entries: unknown = before ? JSON.parse(before) : [];
      return { proposed: true, changeId: change.id, path, target, entries, instruction: "待用户在操作记录确认应用，尚未操作目录。删除后可从 Obsidian 回收站恢复。" };
    }
    try {
      if (change.kind === "folder-create") {
        for (const p of createdFolders) { this.check(); await vault.createFolder(p); }
      } else {
        const folder = vault.getAbstractFileByPath(path);
        if (!(folder instanceof TFolder) || folderSnapshot(folder) !== before) throw new Error("目录已变化，请重新核对。");
        if (change.kind === "folder-delete") await this.app.fileManager.trashFile(folder);
        else {
          change.links = [];
          for (const [p, links] of Object.entries(this.app.metadataCache?.resolvedLinks ?? {})) {
            if (p.startsWith(path + "/") || !Object.keys(links).some(link => link.startsWith(path + "/"))) continue;
            const file = vault.getAbstractFileByPath(p);
            if (file instanceof TFile) change.links.push({ path: p, before: await vault.read(file), after: "" });
          }
          await this.save(); this.check();
          await this.app.fileManager.renameFile(folder, target!);
          const moved = vault.getAbstractFileByPath(target!);
          if (!(moved instanceof TFolder)) throw new Error("移动后未找到目录，请核对。");
          change.after = folderSnapshot(moved);
          for (const link of change.links) { const file = vault.getAbstractFileByPath(link.path); if (file instanceof TFile) link.after = await vault.read(file); }
        }
      }
      change.state = "done"; change.completedAt = Date.now();
    } catch (error) { change.state = "failed"; await this.save(); throw error; }
    this.search.invalidate(path); if (target) this.search.invalidate(target);
    await this.save(); return { ok: true, path: target ?? path, changeId: change.id, ...(change.kind === "folder-delete" ? { recovery: "Obsidian 回收站" } : {}) };
  }
  async execute(call: Call, preview = false): Promise<unknown> {
    this.check(); validateCall(call);
    const a = call.arguments;
    if (call.name === "apply_plan") {
      if (this.session.permission !== "full") throw new Error("自动模式需要用户通过确认按钮应用方案。");
      const ids: unknown = JSON.parse(a.ids as string);
      if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((id: unknown): id is string => typeof id === "string")) throw new Error("请提供1至50个方案 ID。");
      const applied: string[] = [];
      for (const id of [...new Set(ids)]) {
        const c = this.session.changes.find(c => c.id === id && c.state === "proposed");
        if (!c) throw new Error(`方案不存在或已经处理：${id}`);
        this.scope(c.path);
        await this.execute(await this.prepareChange(c));
        c.state = "applied"; applied.push(id); await this.save();
      }
      return { applied };
    }
    if (call.name === "propose_changes") {
      let items: unknown;
      try { items = typeof a.items === "string" ? JSON.parse(a.items) : a.items; } catch { throw new Error("items格式错误：提供对象数组，每项name为操作工具名，arguments为参数对象。"); }
      if (!Array.isArray(items) || !items.length || items.length > 50) throw new Error("每份方案需要1至50项。");
      const start = this.session.changes.length;
      try {
        const proposals: unknown[] = items;
        for (const [index, item] of proposals.entries()) {
          if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.arguments) || !["create_note", "edit_note", "move_note", "delete_note", "create_folder", "delete_folder", "move_folder"].includes(item.name)) throw new Error(`方案第${index + 1}项name错误：应为create_note/edit_note/move_note/delete_note/create_folder/delete_folder/move_folder，不能填笔记标题。`);
          try { await this.execute({ id: crypto.randomUUID(), name: item.name, arguments: item.arguments }, true); } catch (error) { throw new Error(`方案第${index + 1}项 ${item.name}：${error instanceof Error ? error.message : String(error)}`); }
        }
      } catch (error) { this.session.changes.splice(start); await this.save(); throw error; }
      return { proposed: this.session.changes.slice(start).map(c => ({ id: c.id, path: c.path, target: c.target })), instruction: "仅生成方案，用户可在操作记录勾选应用。未修改笔记。" };
    }
    if (call.name === "read_skill") {
      const s = skillsFor(this.settings).find(s => s.id === a.id);
      if (!s || this.session.skillIds && !this.session.skillIds.includes(s.id)) throw new Error("技能不存在或本会话未启用。");
      const body = s.path ? await this.app.vault.read(this.file(notePath(s.path))) : s.body;
      if (body.length > 32000) throw new Error("技能超过32000字符，请拆分正文和参考文件。");
      return { name: s.name, body };
    }
    if (call.name === "search_notes") {
      if (a.folder) a.folder = notePath(a.folder);
      if (a.mode && !["metadata", "full"].includes(a.mode as string)) throw new Error("搜索 mode 为 metadata 或 full。");
      return this.search.search(this.session, a, this.stopped);
    }
    if (call.name === "list_folder") {
      const path = !a.path || a.path === "." || a.path === "./" ? "" : notePath(a.path); const f = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
      if (!(f instanceof TFolder)) throw new Error("目录不存在。");
      const children = f.children.filter(c => !c.name.startsWith(".") && (inScope(this.session, c.path) || this.session.folders?.some(p => p.startsWith(c.path + "/")))).sort((x, y) => x.path.localeCompare(y.path));
      const offset = numberArg(a.offset, 0, children.length);
      return { path, entries: children.slice(offset, offset + 100).map(c => ({ path: c.path, folder: c instanceof TFolder })), nextOffset: offset + 100 < children.length ? offset + 100 : null };
    }
    const path = notePath(a.path); this.scope(path);
    if (call.name === "inspect_path") {
      const file = this.app.vault.getAbstractFileByPath(path);
      return !file ? { path, exists: false } : file instanceof TFolder ? { path, exists: true, type: "folder", children: file.children.filter(f => !f.name.startsWith(".")).length } : { path, exists: true, type: "file", ...(file instanceof TFile ? { size: file.stat.size, modified: file.stat.mtime } : {}) };
    }
    if (["create_folder", "delete_folder", "move_folder"].includes(call.name)) return this.folderOperation(call, path, preview);
    if (call.name === "read_note") {
      const text = await this.app.vault.read(this.file(path)); this.reads.set(path, text);
      const offset = numberArg(a.offset, 0, text.length);
      return { path, content: text.slice(offset, offset + 16000), totalChars: text.length, nextOffset: offset + 16000 < text.length ? offset + 16000 : null };
    }
    this.parent(path);
    if (!preview && !this.approved && this.session.permission !== "full" && this.session.changes.some(c => c.state === "proposed")) throw new Error("已有待确认方案。请等待用户应用或放弃，不能直接写入绕过确认。");
    if (!inScope(this.session, path)) throw new Error("只能修改目录范围内的笔记。");
    if (referencePaths(this.settings, [path]).includes(path) || path === this.settings.memory.path || this.settings.skills.some(s => s.path === path)) throw new Error("参考规则、技能和自动记忆文件请通过设置管理，笔记工具不修改这些文件。");
    let before = "", after = "", target: string | undefined;
    if (call.name === "create_note") {
      if (this.app.vault.getAbstractFileByPath(path)) throw new Error("文件已存在，不会覆盖。");
      after = a.content as string;
    } else {
      before = await this.fresh(path); after = before;
      if (call.name === "edit_note") {
        const old = a.oldText as string;
        if (!old || before.split(old).length !== 2) throw new Error("oldText 必须在笔记中精确出现一次，请补充上下文。");
        after = before.replace(old, () => a.newText as string);
      } else if (call.name !== "delete_note") {
        target = notePath(a.target); this.scope(target); if (!inScope(this.session, target)) throw new Error("目标不在目录范围内。"); this.parent(target);
        if (referencePaths(this.settings, [target]).includes(target) || target === this.settings.memory.path) throw new Error("不能覆盖记忆或规则路径。");
        if (this.app.vault.getAbstractFileByPath(target)) throw new Error("目标已存在。");
      }
    }
    if (after.length > 250000) throw new Error("单篇笔记超过250000字符，请拆分任务。");
    if (call.name !== "delete_note" && path.endsWith(".canvas")) { const data: unknown = JSON.parse(after); if (!isRecord(data) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error("Canvas 必须包含 nodes 与 edges 数组。"); }
    const change: Change = { id: call.id, kind: call.name === "create_note" ? "create" : call.name === "edit_note" ? "edit" : call.name === "delete_note" ? "delete" : "move", path, target, before, after, state: preview || call.name === "delete_note" && !this.approved && this.session.permission !== "full" ? "proposed" : "pending", batchId: this.batchId };
    this.session.changes.push(change); await this.save(); this.check();
    if (change.state === "proposed") return { proposed: true, changeId: change.id, path, target, instruction: "待用户在操作记录中应用，尚未写入。" };
    try {
      if (change.kind === "create") await this.app.vault.create(path, after);
      else if (change.kind === "edit") await this.app.vault.process(this.file(path), current => { this.check(); if (current !== before) throw new Error("写入前笔记已变化。"); return after; });
      else if (change.kind === "delete") { await this.fresh(path); this.check(); await this.app.fileManager.trashFile(this.file(path)); }
      else {
        await this.fresh(path); this.check();
        const links = Object.entries(this.app.metadataCache?.resolvedLinks ?? {}).filter(([p, links]) => p !== path && links[path]).map(([p]) => p);
        change.links = [];
        for (const p of links) { const f = this.app.vault.getAbstractFileByPath(p); if (f instanceof TFile) change.links.push({ path: p, before: await this.app.vault.read(f), after: "" }); }
        await this.save(); this.check(); await this.app.fileManager.renameFile(this.file(path), target!);
        after = await this.app.vault.read(this.file(target!)); change.after = after;
        for (const link of change.links) { const f = this.app.vault.getAbstractFileByPath(link.path); if (f instanceof TFile) link.after = await this.app.vault.read(f); }
      }
      change.state = "done"; change.completedAt = Date.now(); this.reads.set(target ?? path, after); if (target) this.reads.delete(path);
    } catch (e) { change.state = "failed"; await this.save(); throw e; }
    this.search.invalidate(path); if (target) this.search.invalidate(target);
    await this.save(); return { ok: true, path: target ?? path, changeId: change.id };
  }
}
export async function undoChange(app: App, change: Change): Promise<void> {
  if (change.state !== "done") throw new Error("这条记录不能自动撤销。");
  if (change.kind.startsWith("folder-")) {
    if (change.kind === "folder-delete") {
      if (change.before !== "[]") throw new Error("非空目录删除请从 Obsidian 回收站恢复，不能自动重建内容。");
      if (app.vault.getAbstractFileByPath(change.path)) throw new Error("原路径已被占用。");
      await app.vault.createFolder(change.path);
    } else if (change.kind === "folder-create") {
      const paths = [...change.createdFolders ?? [change.path]].reverse();
      for (const p of paths) {
        const folder = app.vault.getAbstractFileByPath(p);
        if (!(folder instanceof TFolder) || folder.children.some(c => !paths.includes(c.path))) throw new Error("新建目录已被使用，不能自动撤销。");
      }
      for (const p of paths) { const folder = app.vault.getAbstractFileByPath(p); if (!(folder instanceof TFolder) || folder.children.length) throw new Error("目录已变化。"); await app.fileManager.trashFile(folder); }
    } else {
      const folder = app.vault.getAbstractFileByPath(change.target!);
      if (!(folder instanceof TFolder) || folderSnapshot(folder) !== change.after) throw new Error("移动后的目录已变化，不能自动撤销。");
      if (app.vault.getAbstractFileByPath(change.path)) throw new Error("原路径已被占用。");
      for (const link of change.links ?? []) { const file = app.vault.getAbstractFileByPath(link.path); if (!(file instanceof TFile) || await app.vault.read(file) !== link.after) throw new Error("关联笔记已改变，不能安全撤销移动。"); }
      await app.fileManager.renameFile(folder, change.path);
      for (const link of change.links ?? []) { const file = app.vault.getAbstractFileByPath(link.path); if (file instanceof TFile) await app.vault.process(file, current => { if (current !== link.after && current !== link.before) throw new Error("关联笔记已变化。"); return link.before; }); }
    }
    change.state = "undone"; return;
  }
  if (change.kind === "delete") {
    if (app.vault.getAbstractFileByPath(change.path)) throw new Error("原路径已被占用，不能恢复覆盖。");
    const parent = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
    if (parent && !(app.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new Error("原目录不存在，请从回收站恢复。");
    await app.vault.create(change.path, change.before); change.state = "undone"; return;
  }
  const path = change.target ?? change.path; const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || await app.vault.read(file) !== change.after) throw new Error("文件已被后续修改，无法自动撤销，请查看操作记录。");
  for (const link of change.links ?? []) { const f = app.vault.getAbstractFileByPath(link.path); if (!(f instanceof TFile) || await app.vault.read(f) !== link.after) throw new Error("关联笔记已改变，不能安全撤销移动。"); }
  if (change.kind === "create") await app.fileManager.trashFile(file);
  else if (change.kind === "edit") await app.vault.process(file, current => { if (current !== change.after) throw new Error("文件已变化。"); return change.before; });
  else { if (app.vault.getAbstractFileByPath(change.path)) throw new Error("原路径已被占用。"); await app.fileManager.renameFile(file, change.path); }
  for (const link of change.links ?? []) { const f = app.vault.getAbstractFileByPath(link.path); if (f instanceof TFile) await app.vault.process(f, current => { if (current !== link.after && current !== link.before) throw new Error("关联笔记已变化，请手动检查。"); return link.before; }); }
  change.state = "undone";
}
