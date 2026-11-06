import { ButtonComponent, Setting } from "../ui";
import { settingsSection, settingsCheckbox } from "../settingsLayout";
import { AbstractInputSuggest, FuzzySuggestModal, Modal, Notice, TFile } from "obsidian";
import { settingsNavigation } from "../settingsNavigation";
import type SimpleAIPlugin from "../main";
import { builtins } from "./skills";
import { notePath, normalizeReferencePattern, matchesReferenceRule, referencePaths, type Skill, type AgentSettings } from "./types";

export function agentSettings(el: HTMLElement, plugin: SimpleAIPlugin, enter: (page: "skills" | "memory" | "rules") => void): void {
  new Setting(el).setName("自定义工作规则与使用偏好")
    .addToggle(t => settingsCheckbox(t).setValue(plugin.settings.agent.instructionsEnabled !== false).onChange(async value => {
      t.setDisabled(true);
      try { await plugin.update({ ...plugin.settings, agent: { ...plugin.settings.agent, instructionsEnabled: value } }); }
      catch { t.setValue(plugin.settings.agent.instructionsEnabled !== false); new Notice("保存失败。"); }
      finally { t.setDisabled(false); }
    }))
    .addButton(button => button.setIcon("settings").setTooltip("编辑工作规则与记忆").onClick(() => new AgentSettingsModal(plugin, "rules", undefined, undefined, () => { el.empty(); agentSettings(el, plugin, enter); }).open()));
  settingsNavigation(new Setting(el).setName("Skills 库"), () => enter("skills"));
}
export function openCompressionSettings(plugin: SimpleAIPlugin): void {
  new AgentSettingsModal(plugin, "compression").open();
}
export function agentSettingsPage(el: HTMLElement, plugin: SimpleAIPlugin, page: "skills" | "memory" | "rules" | "compression", renderModels?: (el: HTMLElement) => void): () => void {
  const settings = new AgentSettingsModal(plugin, page, el, renderModels); settings.onOpen();
  return () => settings.onClose();
}
class AgentSettingsModal extends Modal {
  private config!: AgentSettings;
  private unsubscribe?: () => void;
  onClose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.refresh?.(); }
  constructor(private plugin: SimpleAIPlugin, private page: "rules" | "compression" | "skills" | "memory", private embedded?: HTMLElement, private renderModels?: (el: HTMLElement) => void, private refresh?: () => void) { super(plugin.app); }
  private async save(): Promise<void> {
    const current = this.plugin.settings.agent;
    const agent = this.page === "rules" ? { ...current, instructions: this.config.instructions, instructionsEnabled: this.config.instructionsEnabled, memory: { ...current.memory, enabled: this.config.memory.enabled } } : this.config;
    await this.plugin.update({ ...this.plugin.settings, agent });
    this.refresh?.();
  }
  onOpen(): void {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.modalEl.addClass("simple-ai-config-modal"); let el = this.embedded ?? this.contentEl; el.empty();
    el.addClass("simple-ai-settings");
    const cfg = this.config = JSON.parse(JSON.stringify(this.plugin.settings.agent)) as AgentSettings;
    this.titleEl.setText({ rules: "工作约定与工作记忆", compression: "自动压缩设置", skills: "技能库", memory: "自动记忆" }[this.page]);
    const perform = async (fn: () => Promise<unknown>) => { try { await fn(); new Notice("已完成。"); } catch (e) { new Notice(e instanceof Error ? e.message : "操作失败。"); } };
    if (this.page === "rules") {
      const manual = settingsSection(el, "工作约定");
      new Setting(manual).setName("启用自定义工作规则与使用偏好")
        .addToggle(t => settingsCheckbox(t).setValue(cfg.instructionsEnabled !== false).onChange(async value => {
          cfg.instructionsEnabled = value; await perform(() => this.save());
        }));
      const field = manual.createEl("textarea", { cls: "simple-ai-config-text", attr: { "aria-label": "手写工作约定", placeholder: "在这里简单介绍你的工作习惯，以及希望与模型达成的约定，例如表达方式、处理笔记的偏好。默认留空。" } });
      field.value = cfg.instructions;
      field.onchange = () => { cfg.instructions = field.value; void perform(() => this.save()); };
      const memory = settingsSection(el, "工作记忆");
      memory.createEl("p", { cls: "simple-ai-hint", text: "AI 按自动记忆规则从会话中提取工作习惯，生成并更新工作记忆。开启后会在空闲时整理，并将记忆文件作为模型的工作参考；与模型协作中的自动记忆共用同一开关。" });
      new Setting(memory).setName("启用工作记忆")
        .addToggle(t => settingsCheckbox(t).setValue(cfg.memory.enabled).onChange(async value => {
          cfg.memory.enabled = value;
          if (!value) this.plugin.runtime.stopMemory();
          await perform(() => this.save());
        }));
      new Setting(memory).setName("记忆文件").setDesc(cfg.memory.path)
        .addButton(button => button.setIcon("file-text").setTooltip("打开工作记忆文件").onClick(() => {
          const file = this.app.vault.getAbstractFileByPath(cfg.memory.path);
          if (file instanceof TFile) { void this.app.workspace.getLeaf(false).openFile(file); this.close(); }
          else new Notice("尚未生成工作记忆；开启后由 AI 在空闲时整理生成。");
        }));
      const preview = memory.createEl("textarea", { cls: "simple-ai-config-text", attr: { "aria-label": "AI 生成的工作记忆", readonly: "true" } });
      const file = this.app.vault.getAbstractFileByPath(cfg.memory.path);
      if (file instanceof TFile) void this.app.vault.cachedRead(file).then(text => { preview.value = text; }).catch(() => new Notice("工作记忆读取失败。"));
      return;
    }
    if (this.page === "compression") {
      el = settingsSection(el, "压缩规则");
      new Setting(el).setName("自动压缩触发点（token）").setDesc("每次主 agent请求前，粗估规则、历史、当前任务及工具定义。达到后压缩旧历史并继续；默认 200000，0 关闭。请低于所用模型的上下文容量。")
        .addText(t => t.setValue(String(cfg.autoCompactTokens ?? 200000)).onChange(v => { const n = Number(v); if (v.trim() && Number.isInteger(n) && (n === 0 || n >= 10000 && n <= 1000000)) { cfg.autoCompactTokens = n; void this.save().catch(() => new Notice("保存失败")); } }));
      new Setting(el).setName("压缩目标（token）").setDesc("压缩后的摘要目标长度，默认约 4000 token，可设置 500–12000；实际长度由模型决定。")
        .addText(t => t.setValue(String(cfg.compactTargetTokens ?? 4000)).onChange(v => { const n = Number(v); if (v.trim() && Number.isInteger(n) && n >= 500 && n <= 12000) { cfg.compactTargetTokens = n; void this.save().catch(() => new Notice("保存失败")); } }));
      new Setting(el).setName("自定义压缩提示词").setDesc("补充摘要的保留重点和格式要求；留空使用默认规则。");
      const field = el.createEl("textarea", { cls: "simple-ai-config-text", attr: { "aria-label": "自定义压缩提示词", placeholder: "例如：保留关键决策、文件路径和未完成事项，按项目分组。" } });
      field.value = cfg.compactInstructions ?? ""; field.onchange = () => { cfg.compactInstructions = field.value; void perform(() => this.save()); };
      return;
    }
    if (this.page === "skills") {
      el.createEl("p", { text: "模型先看到简介，需要时读取正文。", cls: "simple-ai-hint" });
      const builtinGroup = settingsSection(el, "内置技能", "simple-ai-model-settings-module simple-ai-skills-group");
      for (const s of builtins) new Setting(builtinGroup).setName(s.name).setDesc(s.description)
        .addToggle(t => settingsCheckbox(t).setValue(!cfg.disabledSkills.includes(s.id)).onChange(async v => { cfg.disabledSkills = v ? cfg.disabledSkills.filter(id => id !== s.id) : [...cfg.disabledSkills, s.id]; await perform(() => this.save()); }))
        .addButton(b => b.setIcon("eye").setTooltip("查看技能").setClass("simple-ai-skill-preview").onClick(() => new SkillEditor(this.plugin, { ...s }, () => this.onOpen(), true).open()));
      const heading = el.createDiv("simple-ai-library-header simple-ai-skills-heading");
      heading.createEl("h3", { text: "自定义技能" });
      new ButtonComponent(heading).setButtonText("添加技能").setCta().onClick(() => new SkillEditor(this.plugin, { id: crypto.randomUUID(), name: "", description: "", body: "", enabled: true }, () => this.onOpen()).open());
      const customGroup = settingsSection(el, "技能列表", "simple-ai-skills-group");
      if (!cfg.skills.length) customGroup.createEl("p", { cls: "simple-ai-hint", text: "暂无自定义技能。" });
      for (const s of cfg.skills) new Setting(customGroup).setName(s.name).setDesc(s.description)
        .addToggle(t => settingsCheckbox(t).setValue(s.enabled).onChange(async v => { s.enabled = v; await perform(() => this.save()); }))
        .addButton(b => b.setButtonText("编辑").onClick(() => new SkillEditor(this.plugin, { ...s }, () => this.onOpen()).open()))
        .addExtraButton(b => b.setIcon("trash-2").setTooltip("删除自定义技能").onClick(async () => { cfg.skills = cfg.skills.filter(x => x.id !== s.id); await perform(() => this.save()); this.onOpen(); }));
      return;
    }
    el.addClass("simple-ai-memory-settings");
    const basic = settingsSection(el, "自动记忆", "simple-ai-memory-section");
    new Setting(basic).setName("Simple AI 自动记忆").setDesc("用于提取工作习惯并生成记忆文件。")
      .addToggle(t => settingsCheckbox(t).setValue(cfg.memory.enabled).onChange(async v => { cfg.memory.enabled = v; if (!v) this.plugin.runtime.stopMemory(); await perform(() => this.save()); }));
    this.renderModels?.(basic.createDiv("simple-ai-memory-model-row"));
    const memoryFile = new Setting(basic).setName("记忆文件位置");
    memoryFile.controlEl.createSpan({ text: cfg.memory.path, cls: "simple-ai-memory-filename" });
    new Setting(basic).setName("其他 AI 记忆文件").setDesc("启用后，将所选文件发送给当前模型，作为整理和编辑笔记的参考。")
      .addButton(b => b.setButtonText("管理文件").onClick(() => new ReferenceRulesModal(this.plugin, () => this.onOpen()).open()));
    const management = settingsSection(el, "记忆管理", "simple-ai-memory-section");
    let extract!: ButtonComponent;
    new Setting(management).setName("整理闲置会话，生成新记忆").setDesc("不区分是否归档；仍在进行或近期有更新的会话暂时跳过，只提取新增内容。")
      .addButton(b => { extract = b; b.setButtonText("立即提取").onClick(() => { void this.plugin.runtime.checkMemory(true).catch(e => new Notice(e instanceof Error ? e.message : "操作失败。")); }); });
    const status = management.createDiv({ cls: "simple-ai-memory-status", attr: { "aria-live": "polite" } });
    const renderStatus = () => {
      const runtime = this.plugin.runtime, memory = runtime.state.memory;
      const enabled = this.plugin.settings.agent.memory.enabled;
      status.empty();
      status.createEl("p", { cls: "simple-ai-hint", text: "当前状态：" + (runtime.memoryBusy ? "正在整理记忆…" : !enabled ? "自动记忆已关闭。" : runtime.busy || this.plugin.cooperation.busy ? "等待当前模型任务结束。" : "待机，满足空闲条件后自动整理。") });
      extract.setDisabled(!enabled || runtime.memoryBusy || runtime.busy || this.plugin.cooperation.busy);
      const legacyPaused = /已停止|已暂停|已中断/.test(memory.lastError);
      const result = memory.lastResult ?? (memory.lastError ? { kind: legacyPaused ? "paused" : "error", text: legacyPaused ? "上次整理已暂停，晚到结果未写入。" : memory.lastError, at: 0 } : undefined);
      if (result) status.createEl("p", { cls: "simple-ai-memory-result is-" + result.kind, text: "上次结果：" + result.text + (result.at ? "（" + new Date(result.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + "）" : "（时间未记录）") });
    };
    this.unsubscribe = this.plugin.runtime.subscribe(renderStatus); renderStatus();
    const options = settingsSection(el, "记忆整理设置", "simple-ai-memory-section");
    options.createEl("p", { cls: "simple-ai-hint", text: "打开 Obsidian 且停止操作 5 分钟后执行；错过的周期只补一次。已有进度保存在本机。" });
    for (const [key, name, min, max, fallback, description] of [
      ["intervalHours", "整理频率（小时）", 1, 720, 12, "距离上次完成整理的间隔；手动整理不受频率限制。"],
      ["idleHours", "会话闲置时长（小时）", 1, 720, 6, "会话最后更新距今达到此时长才处理，正在对话的会话跳过。"],
      ["inputLimitChars", "记忆上下文上限（字符）", 1000, 120000, 0, "限制每次记忆整理请求的总长度。留空或填 0 使用默认上限 6 万字符，自动分段；超出模型上限时会拆分重试。"]
    ] as const) {
      new Setting(options).setName(name).setDesc(description).addText(t => {
        t.inputEl.type = "number"; t.inputEl.min = key === "inputLimitChars" ? "0" : String(min); t.inputEl.max = String(max);
        const current = cfg.memory[key] ?? fallback;
        t.setPlaceholder(key === "inputLimitChars" ? "自动" : String(fallback)).setValue(current ? String(current) : "").onChange(v => {
          const n = v.trim() ? Number(v) : fallback;
          if (Number.isInteger(n) && (n >= min && n <= max || key === "inputLimitChars" && n === 0)) {
            this.plugin.runtime.stopMemory(); cfg.memory[key] = n; void this.save().catch(() => new Notice("保存失败"));
          }
        });
      });
    }
  }
}
class ReferenceRulesModal extends Modal {
  constructor(private plugin: SimpleAIPlugin, private refresh: () => void) { super(plugin.app); }
  onOpen(): void {
    this.modalEl.addClass("simple-ai-config-modal"); this.modalEl.addClass("simple-ai-reference-settings"); this.titleEl.setText("其他 AI 记忆文件");
    const el = this.contentEl; el.empty();
    const cfg = this.plugin.settings.agent;
    const save = async (agent: AgentSettings) => {
      try { await this.plugin.update({ ...this.plugin.settings, agent }); this.refresh(); this.onOpen(); }
      catch { new Notice("规则保存失败。"); }
    };
    const paths = this.app.vault.getMarkdownFiles().map(f => f.path);
    new Setting(el).setName("手动选择参考文件").setDesc("按文件名或路径搜索库内文件。")
      .addButton(b => b.setButtonText("选择文件").onClick(() => new ReferencePicker(this.plugin, path => { void save({ ...cfg, references: [...new Set([...cfg.references, path])] }); }).open()));
    for (const rule of cfg.referenceRules) {
      const matches = paths.filter(path => path !== cfg.memory.path && matchesReferenceRule(path, rule.pattern));
      const description = `${rule.description}\n${matches.length ? "找到：" + matches.join("、") : "未找到匹配文件"}`;
      const row = new Setting(el).setName(rule.pattern).setDesc(description)
        .addToggle(t => settingsCheckbox(t).setValue(rule.enabled).onChange(value => { void save({ ...cfg, referenceRules: cfg.referenceRules.map(r => r.id === rule.id ? { ...r, enabled: value } : r) }); }))
        .addButton(b => b.setButtonText("编辑").onClick(() => new ReferenceRuleEditor(this.plugin, rule, () => { this.refresh(); this.onOpen(); }).open()))
        .addExtraButton(b => b.setIcon("trash-2").setTooltip("删除匹配规则").onClick(() => { void save({ ...cfg, referenceRules: cfg.referenceRules.filter(r => r.id !== rule.id) }); }));
      row.nameEl.setAttribute("aria-label", rule.pattern); row.descEl.setAttribute("aria-label", description);
    }
    new ButtonComponent(el).setButtonText("添加匹配规则").setCta().onClick(() => new ReferenceRuleEditor(this.plugin, { id: crypto.randomUUID(), pattern: "", description: "", enabled: true }, () => { this.refresh(); this.onOpen(); }).open());
    if (cfg.references.length) {
      el.createEl("h3", { text: "此前手动选择的文件" });
      for (const path of cfg.references) new Setting(el).setName(path).addExtraButton(b => b.setIcon("x").setTooltip("取消参考此文件").onClick(() => { void save({ ...cfg, references: cfg.references.filter(p => p !== path) }); }));
    }
    const active = referencePaths(cfg, paths);
    el.createEl("p", { cls: "simple-ai-hint", text: active.length ? "当前参考：" + active.join("、") : "当前没有匹配到启用的参考文件。" });
  }
}
class ReferencePicker extends FuzzySuggestModal<TFile> {
  constructor(plugin: SimpleAIPlugin, private choose: (path: string) => void) { super(plugin.app); this.setPlaceholder("输入文件名或路径搜索参考文件"); }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles().filter(f => !f.path.split("/").some(p => p.startsWith("."))); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file.path); }
}
class ReferenceRuleEditor extends Modal {
  private pathSuggest?: ReferencePathSuggest;
  constructor(private plugin: SimpleAIPlugin, private rule: AgentSettings["referenceRules"][number], private refresh: () => void) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText("文件匹配规则"); const draft = { ...this.rule };
    new Setting(this.contentEl).setName("文件或路径").setDesc("输入路径搜索文件，也可填写 *.md 等匹配规则。")
      .addText(t => {
        t.setValue(draft.pattern).onChange(v => { draft.pattern = v.trim(); });
        this.pathSuggest = new ReferencePathSuggest(this.plugin, t.inputEl);
        this.pathSuggest.onSelect(file => { t.setValue(file.path); draft.pattern = file.path; this.pathSuggest?.close(); });
      });
    new Setting(this.contentEl).setName("说明").addTextArea(t => t.setValue(draft.description).onChange(v => { draft.description = v; }));
    new Setting(this.contentEl).addButton(b => b.setButtonText("取消").onClick(() => this.close()))
      .addButton(b => b.setButtonText("保存").setCta().onClick(async () => {
        try { draft.pattern = normalizeReferencePattern(draft.pattern); }
        catch (error) { new Notice(error instanceof Error ? error.message : "文件路径无效。"); return; }
        const cfg = this.plugin.settings.agent;
        if (cfg.referenceRules.some(r => r.id !== draft.id && r.pattern.toLowerCase() === draft.pattern.toLowerCase())) { new Notice("该匹配规则已存在。"); return; }
        try {
          const rules = cfg.referenceRules.some(r => r.id === draft.id) ? cfg.referenceRules.map(r => r.id === draft.id ? draft : r) : [...cfg.referenceRules, draft];
          await this.plugin.update({ ...this.plugin.settings, agent: { ...cfg, referenceRules: rules } }); this.refresh(); this.close();
        } catch { new Notice("保存失败。"); }
      }));
  }
  onClose(): void { this.pathSuggest?.close(); }
}
class ReferencePathSuggest extends AbstractInputSuggest<TFile> {
  constructor(private plugin: SimpleAIPlugin, input: HTMLInputElement) { super(plugin.app, input); }
  protected getSuggestions(query: string): TFile[] {
    const text = query.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    return this.plugin.app.vault.getMarkdownFiles().filter(file => !file.path.split("/").some(part => part.startsWith(".")) && file.path.toLowerCase().includes(text)).slice(0, 100);
  }
  renderSuggestion(file: TFile, el: HTMLElement): void { el.setText(file.path); }
}
class SkillEditor extends Modal {
  constructor(private plugin: SimpleAIPlugin, private draft: Skill, private refresh: () => void, private readonlyView = false) { super(plugin.app); }
  async onOpen(): Promise<void> {
    this.titleEl.setText(this.readonlyView ? "内置技能" : "自定义技能"); const el = this.contentEl; this.modalEl.addClass("simple-ai-config-modal");
    // Convert legacy file-backed skills into editable text when the user saves.
    if (this.draft.path) {
      try {
        const file = this.app.vault.getAbstractFileByPath(notePath(this.draft.path));
        if (!(file instanceof TFile)) throw new Error("参考文件不存在");
        this.draft.body = await this.app.vault.read(file);
      } catch {
        new Notice("旧技能的参考文件无法读取，已保留原有正文；请检查正文后保存。");
      }
    }
    const name = new Setting(el).setName("名称");
    if (this.readonlyView) name.controlEl.createSpan({ text: this.draft.name });
    else name.addText(t => t.setValue(this.draft.name).onChange(v => { this.draft.name = v; }));
    el.createDiv({ text: "简介：什么时候使用", cls: "simple-ai-skill-field-label" });
    const description = el.createEl("textarea", { cls: "simple-ai-config-text simple-ai-skill-description", attr: { "aria-label": "技能简介：什么时候使用", placeholder: "说明这个技能适合什么任务，AI 会根据简介决定是否读取正文。" } });
    description.value = this.draft.description; description.oninput = () => { this.draft.description = description.value; };
    description.readOnly = this.readonlyView;
    el.createDiv({ text: "技能正文", cls: "simple-ai-skill-field-label" });
    const area = el.createEl("textarea", { cls: "simple-ai-config-text", attr: { "aria-label": "技能正文", placeholder: "填写完整的方法、格式或参考说明" } });
    area.value = this.draft.body; area.oninput = () => { this.draft.body = area.value; };
    area.readOnly = this.readonlyView;
    if (this.readonlyView) {
      new Setting(el).addButton(b => b.setButtonText("关闭").onClick(() => this.close()));
      return;
    }
    new Setting(el).addButton(b => b.setButtonText("取消").onClick(() => this.close())).addButton(b => b.setButtonText("保存").setCta().onClick(async () => {
      try {
        if (!this.draft.name.trim() || !this.draft.description.trim()) throw new Error("请填写名称和简介。");
        if (!this.draft.body.trim()) throw new Error("请填写技能正文。");
        delete this.draft.path;
        const agent = { ...this.plugin.settings.agent, skills: [...this.plugin.settings.agent.skills.filter(s => s.id !== this.draft.id), this.draft] };
        await this.plugin.update({ ...this.plugin.settings, agent }); this.refresh(); this.close();
      } catch (e) { new Notice(e instanceof Error ? e.message : "保存失败。"); }
    }));
  }
}
