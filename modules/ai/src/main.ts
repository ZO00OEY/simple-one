import { migrateAuxiliary } from "./agent/types";
import { Notice, Plugin, requestUrl, requireApiVersion } from "obsidian";
import { ApiClient } from "./api/client";
import { LibraryPicker } from "./api/settings";
import { ApiSource, defaults, Settings } from "./api/types";
import { agentDefaults, cooperationDefaults, defaultAuxiliaryUsage } from "./agent/types";
import { Cooperation } from "./agent/cooperation";
import { AgentRuntime } from "./agent/runtime";
import { ChatView, CHAT_VIEW } from "./agent/view";

class AIInterface extends Plugin { onload(): void {} }

export default class SimpleAIPlugin extends Plugin {
  openSettings: () => void = () => {};
  async translateSelection(input: { text: string; prompt: string; sourceId: string; modelId: string }, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<string> {
    if (!input.text.trim()) throw new Error("翻译内容不能为空。");
    if (!input.prompt.trim()) throw new Error("翻译提示词不能为空。");
    const reply = await this.cooperation.request("main", { sourceId: input.sourceId, modelId: input.modelId }, input.prompt,
      [{ role: "user", text: input.text }], [], signal, { stage: "AI 翻译 · Simple One", maxOutputTokens: null,
        onUpdate: onUpdate ? reply => { if (!signal?.aborted) onUpdate(reply.text); } : undefined });
    if (!reply.text.trim()) throw new Error("模型未返回翻译文本。");
    return reply.text;
  }
  settings: Settings = defaults();
  client = new ApiClient(request => requestUrl({ ...request, throw: false }), 30000, (url, init) => fetch(url, init));
  private writes: Promise<void> = Promise.resolve();
  private keyCursor = new Map<string, number>();
  runtime = new AgentRuntime(this);
  cooperation = new Cooperation(this);
  lastFocusedNote = "";
  private lastCacheCheck = 0;
  private startupStage = "初始化";
  private active = true;
  private ui?: Plugin;
  private requestsReady?: Promise<void>;
  prepareRequests(): Promise<void> {
    return this.requestsReady ??= this.initializeRequests().catch(error => { this.requestsReady = undefined; throw error; });
  }
  stopUI(): void {
    this.runtime.stop(); this.cooperation.stop();
    if (this.ui) { const ui = this.ui; this.ui = undefined; this.removeChild(ui); }
  }
  onload(): void {}
  async start(): Promise<void> {
    try { await this.initialize(); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Simple AI 启动失败（${this.startupStage}）`, error);
      new Notice(`Simple AI 加载失败（${this.startupStage}）：${detail}`, 0);
      throw error;
    }
  }
  private async initializeRequests(): Promise<void> {
    this.startupStage = "读取设置";
    this.settings = { ...defaults(), ...await this.loadData() };
    const localPath = `${this.manifest.dir}/private/settings.json`;
    if (await this.app.vault.adapter.exists(localPath)) {
      const local = JSON.parse(await this.app.vault.adapter.read(localPath));
      // Only the API catalogue comes from the synchronised data.json.
      this.settings = { ...this.settings, ...local, sources: this.settings.sources };
    }
    if (!this.active) return;
    const cfg = this.settings.agent;
    const co = cfg?.cooperation, base = cooperationDefaults();
    this.settings.agent = { ...agentDefaults(), ...cfg, memory: { ...agentDefaults().memory, ...cfg?.memory }, cooperation: { auxiliary: { ...base.auxiliary, ...co?.auxiliary }, examiner: { ...base.examiner, ...co?.examiner } } };
    this.settings.agent.cooperation.auxiliary.enabled = true;
    migrateAuxiliary(this.settings.agent.cooperation.auxiliary, this.settings.selected);
    if (!this.settings.agent.cooperation.auxiliary.description?.trim()) this.settings.agent.cooperation.auxiliary.description = defaultAuxiliaryUsage;
    const legacyDescriptions: Record<string, string> = {
      "Codex 常用的项目指令文件；其他 Agent 也可能读取。不是自动生成记忆的固定文件名。": "Codex 的项目规则文件。",
      "Claude Code 常用的项目指令文件，与它单独保存的自动记忆不同。": "Claude Code 的项目规则文件。",
    };
    for (const rule of this.settings.agent.referenceRules) rule.description = legacyDescriptions[rule.description] ?? rule.description;
    this.startupStage = "读取会话与记忆";
    await this.runtime.load();
    if (!this.active) return;
    this.startupStage = "读取模型协作记录";
    await this.cooperation.load();
    if (!this.active) return;
    await this.cooperation.initializeTraffic();
    if (!this.active) return;
    await this.update(this.settings);
    if (!this.active) return;
  }
  private async initialize(): Promise<void> {
    await this.prepareRequests();
    if (!this.active || this.ui) return;
    const ui = this.addChild(new AIInterface(this.app, this.manifest));
    this.ui = ui;
    this.startupStage = "注册界面与命令";
    const rememberNote = () => { const file = this.app.workspace.getActiveFile(); if (file?.extension === "md") this.lastFocusedNote = file.path; };
    rememberNote();
    ui.registerEvent(this.app.workspace.on("file-open", file => { if (file?.extension === "md") this.lastFocusedNote = file.path; }));
    ui.registerEvent(this.app.workspace.on("active-leaf-change", rememberNote));
    ui.registerEvent(this.app.vault.on("modify", file => this.runtime.search.invalidate(file.path)));
    ui.registerEvent(this.app.vault.on("delete", file => this.runtime.search.invalidate(file.path)));
    ui.registerEvent(this.app.vault.on("rename", (file, old) => {
      this.runtime.search.invalidate(old); this.runtime.search.invalidate(file.path);
      const moved = (path: string) => path === old ? file.path : path.startsWith(old + "/") ? file.path + path.slice(old.length) : path;
      this.lastFocusedNote = moved(this.lastFocusedNote);
      let changed = false;
      for (const session of this.runtime.state.sessions) if (session.references?.some(path => moved(path) !== path)) { session.references = session.references.map(moved); changed = true; }
      if (changed) { this.runtime.changed(); void this.runtime.save().catch(() => new Notice("关联笔记路径保存失败。")); }
    }));
    ui.registerView(CHAT_VIEW, leaf => new ChatView(leaf, this));
    ui.addRibbonIcon("bot", "AI", () => { void this.openChat(); });
    ui.addCommand({ id: "open-chat", name: "打开聊天", callback: () => { void this.openChat(); } });
    const memoryCheck = () => { void (async () => { await this.checkAttachmentCleanup(); await this.runtime.checkMemory(); await this.cooperation.autoCheck(); })().catch(() => new Notice("闲时任务状态保存失败。")); };
    ui.registerInterval(window.setInterval(memoryCheck, 60000));
    ui.registerDomEvent(document, "pointerdown", () => this.runtime.userActive());
    ui.registerDomEvent(document, "keydown", () => this.runtime.userActive());
    ui.registerDomEvent(document, "visibilitychange", () => { if (document.hidden) this.runtime.stop(); else { this.runtime.userActive(); memoryCheck(); } });
    let alive = true; ui.register(() => { alive = false; });
    this.app.workspace.onLayoutReady(() => { if (alive) memoryCheck(); });

    ui.addCommand({
      id: "show-status",
      name: "查看 AI 状态",
      callback: () => {
        new Notice("AI：聊天、笔记工具、技能库与记忆。设置 → Simple One → AI。");
      },
    });
    ui.addCommand({ id: "select-model", name: "切换默认模型", callback: () => {
      const entries = this.settings.sources.flatMap(source => source.models.map(model => ({ source, model })));
      if (!entries.length) { new Notice("请先在 AI 设置中添加来源和模型。"); return; }
      new LibraryPicker(this, entries, entry => {
        void this.update({ ...this.settings, selected: { sourceId: entry.source.id, modelId: entry.model.id } }).catch(() => new Notice("模型选择保存失败。"));
      }).open();
    } });
  }
  async openChat(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: CHAT_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  async checkAttachmentCleanup(): Promise<void> {
    const days = this.settings.cacheCleanupDays;
    const archivedDays = this.settings.archivedCacheCleanupDays;
    if (!Number.isSafeInteger(days) || days < 0 || !Number.isSafeInteger(archivedDays) || archivedDays < 0 || days + archivedDays === 0 || document.hidden || this.runtime.busy || this.runtime.memoryBusy || this.cooperation.busy || Date.now() - this.lastCacheCheck < 3600000) return;
    this.lastCacheCheck = Date.now();
    try { await this.runtime.cleanAttachments(days, archivedDays); }
    catch { new Notice("图片及附件自动清理失败，稍后会重试。"); }
  }
  onunload(): void { this.active = false; this.stopUI(); }
  getKeys(id: string): { id: string; value: string }[] {
    if (requireApiVersion("1.11.4")) {
      const source = this.settings.sources.find(s => s.id === id);
      return (source?.keyIds ?? [id]).map(keyId => ({ id: keyId, value: this.app.secretStorage.getSecret(`simple-one-ai-${keyId}`) ?? "" }));
    } else {
      throw new Error("AI requires Obsidian 1.11.4 or later.");
    }
  }
  getKey(id: string): string {
    const source = this.settings.sources.find(s => s.id === id);
    const keys = this.getKeys(id);
    return keys.find(key => key.id === source?.activeKeyId)?.value ?? keys.find(key => key.value)?.value ?? "";
  }
  getRequestKey(id: string): string {
    const source = this.settings.sources.find(s => s.id === id);
    const keys = this.getKeys(id).filter(key => key.value.trim());
    if (!source?.rotateKeys || keys.length < 2) return this.getKey(id);
    const index = (this.keyCursor.get(id) ?? 0) % keys.length;
    this.keyCursor.set(id, index + 1);
    return keys[index].value;
  }
  update(settings: Settings): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(settings)) as Settings;
    // Remove the retired master switch from settings saved by older versions.
    delete (snapshot as Settings & { enabled?: boolean }).enabled;
    for (const source of snapshot.sources) delete (source as ApiSource & { streaming?: boolean }).streaming;
    const auxiliary = snapshot.agent?.cooperation?.auxiliary;
    if (auxiliary) { auxiliary.enabled = true; migrateAuxiliary(auxiliary, snapshot.selected); }
    if (auxiliary && !auxiliary.description?.trim()) auxiliary.description = defaultAuxiliaryUsage;
    const operation = this.writes.then(async () => {
      const { sources, ...local } = snapshot;
      const root = `${this.manifest.dir}/private`;
      if (!await this.app.vault.adapter.exists(root)) await this.app.vault.adapter.mkdir(root);
      await this.app.vault.adapter.write(`${root}/settings.json`, JSON.stringify(local));
      await this.saveData({ sources });
      this.settings = snapshot; this.runtime?.changed();
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async saveSourceKeys(source: ApiSource, keys: { id: string; value: string }[]): Promise<void> {
    if (requireApiVersion("1.11.4")) {
      const oldIds = this.getKeys(source.id).map(key => key.id);
      const ids = [...new Set([...oldIds, ...keys.map(key => key.id)])];
      const previous = ids.map(id => ({ id, value: this.app.secretStorage.getSecret(`simple-one-ai-${id}`) ?? "" }));
      source = { ...source, keyIds: keys.map(key => key.id),
        activeKeyId: keys.some(key => key.id === source.activeKeyId) ? source.activeKeyId : keys[0]?.id };
      const sources = this.settings.sources.filter(s => s.id !== source.id);
      const index = this.settings.sources.findIndex(s => s.id === source.id);
      sources.splice(index < 0 ? sources.length : index, 0, source);
      const selected = this.settings.selected;
      const valid = sources.some(s => s.id === selected?.sourceId && s.models.some(m => m.id === selected.modelId));
      try {
        for (const id of ids) this.app.secretStorage.setSecret(`simple-one-ai-${id}`, keys.find(key => key.id === id)?.value ?? "");
        await this.update({ ...this.settings, sources, selected: valid ? selected : null });
      }
      catch (error) {
        for (const key of previous) this.app.secretStorage.setSecret(`simple-one-ai-${key.id}`, key.value);
        throw error;
      }
    } else {
      throw new Error("AI requires Obsidian 1.11.4 or later.");
    }
  }
  async deleteSource(id: string): Promise<void> {
    if (requireApiVersion("1.11.4")) {
      const keys = this.getKeys(id);
      await this.update({ ...this.settings, sources: this.settings.sources.filter(s => s.id !== id), selected: this.settings.selected?.sourceId === id ? null : this.settings.selected });
      for (const key of keys) this.app.secretStorage.setSecret(`simple-one-ai-${key.id}`, "");
    } else {
      throw new Error("AI requires Obsidian 1.11.4 or later.");
    }
  }
}
