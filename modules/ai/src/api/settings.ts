import { ButtonComponent, Setting } from "../ui";
import { setNativeTooltip } from "../tooltipText";
import { App, Modal, Notice, PluginSettingTab } from "obsidian";
import type SimpleAIPlugin from "../main";
import { ApiClient, endpoint, safeError, completeSourceAddresses } from "./client";
import { ApiSource, label, ModelEntry, newSource, validateSource } from "./types";
import { agentSettings, agentSettingsPage } from "../agent/settings";
import { modelSettings } from "../agent/modelSettings";
import { settingsSection, settingsCheckbox } from "../settingsLayout";
import { settingsNavigation } from "../settingsNavigation";
import { auxiliarySettings } from "../agent/auxiliarySettings";
import { auxiliaryAssessmentPage } from "../agent/examinerView";
import { trafficSettingsPage } from "../agent/trafficSettings";

class ConfirmDelete extends Modal {
  constructor(app: App, private name: string, private remove: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.titleEl.setText("删除 API 来源");
    this.contentEl.createEl("p", { text: `删除“${this.name}”及其已选模型？` });
    new Setting(this.contentEl).addButton(b => b.setButtonText("取消").onClick(() => this.close()))
      .addButton(b => b.setButtonText("删除").setWarning().onClick(async () => {
        b.setDisabled(true);
        try { await this.remove(); this.close(); } catch { new Notice("删除失败，请重试。"); b.setDisabled(false); }
      }));
  }
}

class SourceEditor extends Modal {
  private draft: ApiSource;
  private keys: { id: string; value: string }[];
  private active = true;
  private busy = false;
  private selecting = false;
  private modelsFetched = false;
  private selected = new Set<string>();
  private keyCursor = 0;
  constructor(private plugin: SimpleAIPlugin, source: ApiSource, private done: () => void) {
    super(plugin.app);
    this.draft = JSON.parse(JSON.stringify(source));
    this.keys = plugin.getKeys(source.id);
    if (!this.keys.length) this.keys.push({ id: crypto.randomUUID(), value: "" });
    this.draft.activeKeyId ??= this.keys[0]?.id;
  }
  onOpen(): void { this.modalEl.addClass("simple-ai-editor"); this.render(); }
  onClose(): void { this.active = false; this.keys = []; this.contentEl.empty(); }
  private currentKey(): string { return this.keys.find(key => key.id === this.draft.activeKeyId)?.value.trim() ?? ""; }
  private requestKey(): string {
    const keys = this.keys.filter(key => key.value.trim());
    if (!this.draft.rotateKeys || keys.length < 2) return this.currentKey();
    return keys[this.keyCursor++ % keys.length].value.trim();
  }
  private error(error: unknown): string {
    let message = safeError(error, this.currentKey());
    for (const key of this.keys) message = safeError(new Error(message), key.value);
    return message;
  }
  private field(parent: HTMLElement, name: string, value: string, update: (value: string) => void, description?: string): void {
    const setting = new Setting(parent).setName(name);
    if (description) setting.setDesc(description);
    setting.addText(t => t.setValue(value).onChange(update));
  }
  private render(): void {
    this.contentEl.empty();
    this.titleEl.setText(this.plugin.settings.sources.some(s => s.id === this.draft.id) ? "编辑来源" : "添加来源");
    const form = this.contentEl.createEl("fieldset", { cls: "simple-ai-form" });
    const draft = this.draft;
    draft.modelsUrlMode ??= draft.modelsUrl.trim() ? "full" : "base";
    const invalidate = () => { draft.discoveredModels = []; this.selected.clear(); this.selecting = false; this.modelsFetched = false; renderModels(); renderPicker(); };
    const basic = settingsSection(form, "API 基础信息", "simple-ai-api-basic");
    this.field(basic, "来源名称", draft.name, value => { draft.name = value; });
    const protocol = new Setting(basic).setName("协议");
    protocol.settingEl.addClass("simple-ai-protocol");
    protocol.addDropdown(d => d.addOptions({ openai: "OpenAI 兼容", anthropic: "Anthropic 兼容" }).setValue(draft.protocol).onChange(value => {
      draft.protocol = value as ApiSource["protocol"]; draft.discoveredModels = []; this.selected.clear(); this.selecting = false; this.modelsFetched = false; this.render();
    }));
    const address = new Setting(basic).setName("请求地址");
    address.settingEl.addClass("simple-ai-address");
    let requestInput!: HTMLInputElement;
    address.addText(t => {
      requestInput=t.inputEl;
      t.setPlaceholder("请求地址，自动补全接口路径").setValue(draft.url).onChange(value => { draft.url = value; invalidate(); renderEndpoint(); renderModelsHint(); });
    });
    const requestLock = new ButtonComponent(address.controlEl).setIcon("lock");
    requestLock.buttonEl.addClass("simple-ai-endpoint-lock");
    const renderEndpoint = () => {
      const locked=draft.urlMode === "full";
      requestLock.buttonEl.setAttribute("aria-pressed",String(locked));
      const hint=locked ? "不自动补全，需填写完整请求地址。" : "自动补全请求地址，完整路径不重复添加。";
      requestLock.setTooltip(hint); requestInput.placeholder=hint; setNativeTooltip(requestInput, hint);
      try { setNativeTooltip(requestInput, (requestInput.getAttribute("aria-label") || "") + ("\n实际请求地址：" + endpoint(draft,"chat"))); } catch { /* Keep the routing description while the field is empty. */ }
    };
    requestLock.onClick(() => { draft.urlMode=draft.urlMode === "full" ? "base" : "full"; invalidate(); renderEndpoint(); renderModelsHint(); });
    renderEndpoint();

    const keySection = basic.createDiv("simple-ai-key-section");
    const keysEl = keySection.createDiv();
    const renderKeys = () => {
      keysEl.empty();
      this.keys.forEach((key, index) => {
        const row = keysEl.createDiv("simple-ai-key-row");
        const label = row.createEl("label", { text: index ? `密钥 ${index + 1}` : "API 密钥", cls: "simple-ai-field-label" });
        if (this.keys.length > 1) {
          const choice = row.createEl("input", { type: "radio" });
          choice.name = `simple-ai-key-${draft.id}`; choice.checked = draft.activeKeyId === key.id;
          choice.setAttribute("aria-label", `使用密钥 ${index + 1}`);
          choice.onchange = () => { draft.activeKeyId = key.id; invalidate(); };
        }
        const input = row.createEl("input", { type: "password", placeholder: "无需密钥的本地服务可留空" });
        input.id = `simple-ai-secret-${key.id}`; label.htmlFor = input.id;
        input.autocomplete = "off"; input.value = key.value; setNativeTooltip(input, `API 密钥 ${index + 1}`);
        input.oninput = () => { key.value = input.value; invalidate(); };
        const visibility = new ButtonComponent(row).setIcon("eye").setTooltip("显示或隐藏密钥").onClick(() => { input.type = input.type === "password" ? "text" : "password"; });
        visibility.buttonEl.addClass("simple-ai-secret-toggle");
        new ButtonComponent(row).setIcon("plus").setTooltip("添加密钥").onClick(() => {
          this.keys.push({ id: crypto.randomUUID(), value: "" }); renderKeys();
        });
        new ButtonComponent(row).setIcon("minus").setTooltip("移除密钥").onClick(() => {
          if (this.keys.length === 1) key.value = "";
          else this.keys.splice(index, 1);
          if (!this.keys.some(item => item.id === draft.activeKeyId)) draft.activeKeyId = this.keys[0]?.id;
          invalidate(); renderKeys();
        });
      });
    };
    renderKeys();
    const rotation = keySection.createDiv("simple-ai-completion simple-ai-key-rotation");
    const rotate = rotation.createEl("input", { type: "checkbox" }); rotate.checked = !!draft.rotateKeys;
    rotate.id = `simple-ai-rotate-${draft.id}`;
    rotation.createEl("label", { text: "密钥轮询", attr: { for: rotate.id } });
    rotate.onchange = () => { draft.rotateKeys = rotate.checked; this.keyCursor = 0; };
    const status = form.createDiv({ cls: "simple-ai-status", attr: { role: "status", "aria-live": "polite" } });
    const modelSection = settingsSection(form, "模型列表", "simple-ai-model-list-section");
    let modelsInput!: HTMLInputElement;
    let customModelsUrl = draft.modelsUrlMode === "full" ? draft.modelsUrl : "";
    const modelsAddress = new Setting(modelSection).setName("列表地址").addText(t => {
      modelsInput = t.inputEl;
      t.setValue(draft.modelsUrl).onChange(value => {
        if (draft.modelsUrlMode !== "full") return;
        customModelsUrl = draft.modelsUrl = value; invalidate();
      });
    });
    modelsAddress.settingEl.addClass("simple-ai-models-address");
    const modelsLock = new ButtonComponent(modelsAddress.controlEl).setIcon("lock");
    modelsLock.buttonEl.addClass("simple-ai-endpoint-lock");
    const renderModelsHint = () => {
      const locked=draft.modelsUrlMode === "full";
      modelsLock.buttonEl.setAttribute("aria-pressed",String(locked));
      const hint=locked ? "不自动补全，需填写完整模型列表地址。" : "自动补全模型列表地址，完整路径不重复添加。";
      modelsLock.setTooltip(hint); setNativeTooltip(modelsInput, hint);
      modelsInput.readOnly = draft.modelsUrlMode === "base";
      modelsInput.placeholder = hint;
      if (draft.modelsUrlMode === "full") { modelsInput.value = draft.modelsUrl; return; }
      try {
        modelsInput.value = endpoint(draft, "models");
      } catch { modelsInput.value = ""; }
    };
    modelsLock.onClick(() => {
      const value=draft.modelsUrlMode === "full" ? "base" : "full";
      draft.modelsUrlMode=value; draft.modelsUrl=value === "full" ? customModelsUrl : "";
      invalidate(); renderModelsHint();
    });
    renderModelsHint();
    const fetchStatus = modelSection.createDiv({ cls: "simple-ai-status", attr: { role: "status", "aria-live": "polite" } });
    const results = modelSection.createDiv("simple-ai-fetched-models");
    results.hidden = !this.modelsFetched;
    const search = results.createEl("input", { type: "search", placeholder: "搜索并选择模型" });
    search.setAttribute("aria-label", "搜索并选择模型"); search.addClass("simple-ai-model-search");
    const pickerEl = results.createDiv();
    const count = results.createDiv("simple-ai-hint simple-ai-model-count");
    const added = settingsSection(form, "已添加模型", "simple-ai-added-models");
    const addedHeading = added.createDiv("simple-ai-section-heading");
    const addedCount = addedHeading.createSpan();
    const modelsEl = added.createDiv();
    const renderModels = () => {
      results.hidden = !this.modelsFetched;
      count.setText(`已拉取 ${draft.discoveredModels.length} 个 · 已勾选 ${this.selected.size} 个`);
      addedCount.setText(`共 ${draft.models.length} 个`);
      modelsEl.empty();
      draft.models.forEach(model => {
        const item = modelsEl.createDiv("simple-ai-model-item");
        const row = item.createDiv("simple-ai-model-row");
        const result = item.createDiv({ cls: "simple-ai-model-test-result", attr: { role: "status", "aria-live": "polite" } });
        const clearTest = () => {
          result.empty(); result.removeClass("is-success"); test.buttonEl.removeClass("is-success");
          test.setTooltip("测试此模型（会产生少量 API 用量）");
        };
        const id = row.createEl("input", { type: "text", placeholder: "模型 ID" }); id.value = model.id;
        id.setAttribute("aria-label", "模型 ID"); id.oninput = () => { this.selected.delete(model.id.trim()); model.id = id.value; clearTest(); renderPicker(); };
        const alias = row.createEl("input", { type: "text", placeholder: "别名（可选）" }); alias.value = model.alias;
        alias.setAttribute("aria-label", "模型别名"); alias.oninput = () => { model.alias = alias.value; };
        const test = new ButtonComponent(row).setIcon("zap").setTooltip("测试此模型（会产生少量 API 用量）");
        test.buttonEl.addClass("simple-ai-source-model-test");
        test.onClick(async () => {
          if (this.busy) return;
          clearTest(); status.empty(); test.buttonEl.setAttribute("aria-busy", "true"); result.addClass("is-pending");
          try {
            await this.run(form, result, async client => {
              const modelId = model.id.trim();
              if (!modelId) throw new Error("请填写模型 ID。");
              const response = await client.test(draft, this.requestKey(), modelId);
              if (this.active) {
                test.buttonEl.addClass("is-success"); result.addClass("is-success");
                test.setTooltip(`通信成功 · ${response.ms} ms\n${response.reply}`);
              }
              return `✓ 通信成功 · ${response.ms} ms`;
            });
          } finally { test.buttonEl.removeAttribute("aria-busy"); result.removeClass("is-pending"); }
        });
        new ButtonComponent(row).setIcon("x").setTooltip("移除此模型").onClick(() => { this.selected.delete(model.id.trim()); draft.models.splice(draft.models.indexOf(model), 1); renderModels(); renderPicker(); });
      });
      if (!draft.models.length) modelsEl.createEl("p", { cls: "simple-ai-hint", text: "从端点拉取并勾选模型，或手动添加。可在模型行点击闪电测试。" });
    };
    const renderPicker = () => {
      pickerEl.empty();
      if (!this.selecting || !this.modelsFetched) return;
      const panel = pickerEl.createDiv("simple-ai-model-picker");
      const selectAll = panel.createDiv("simple-ai-picker-all");
      const all = selectAll.createEl("input", { type: "checkbox" }); all.setAttribute("aria-label", "选择当前搜索结果中的未添加模型");
      selectAll.createSpan({ text: "全选当前结果" });
      const selectedCount = selectAll.createSpan();
      const list = panel.createDiv("simple-ai-options");
      const actions = panel.createDiv("simple-ai-picker-actions");
      const apply = new ButtonComponent(actions).setCta().onClick(() => {
        for (const id of this.selected) if (!draft.models.some(model => model.id.trim() === id)) draft.models.push({ id, alias: "" });
        this.selected.clear(); this.selecting = false; renderModels(); renderPicker();
      });
      const existing = new Set(draft.models.map(model => model.id.trim()));
      const values = draft.discoveredModels.filter(id => id.toLowerCase().includes(search.value.toLowerCase()));
      const available = values.filter(id => !existing.has(id));
      const choices: { id: string; input: HTMLInputElement }[] = [];
      const refreshSelection = () => {
        all.disabled = !available.length; all.checked = available.length > 0 && available.every(id => this.selected.has(id));
        all.indeterminate = !all.checked && available.some(id => this.selected.has(id));
        selectedCount.setText(`${this.selected.size} / ${draft.discoveredModels.filter(id => !existing.has(id)).length}`);
        apply.setButtonText(`完成选择（${this.selected.size}）`).setDisabled(!this.selected.size);
        count.setText(`已拉取 ${draft.discoveredModels.length} 个 · 已勾选 ${this.selected.size} 个`);
        for (const choice of choices) choice.input.checked = existing.has(choice.id) || this.selected.has(choice.id);
      };
      for (const id of values) {
        const option = list.createEl("label", { cls: "simple-ai-picker-option" });
        if (existing.has(id)) option.addClass("is-added");
        const checkbox = option.createEl("input", { type: "checkbox" }); checkbox.disabled = existing.has(id); checkbox.checked = existing.has(id) || this.selected.has(id);
        choices.push({ id, input: checkbox });
        option.createSpan({ text: id }); if (existing.has(id)) option.createSpan({ text: "已添加", cls: "simple-ai-hint" });
        checkbox.onchange = () => {
          if (checkbox.checked) {
            this.selected.add(id);
          } else {
            this.selected.delete(id);
          }
          refreshSelection();
        };
      }
      if (!values.length) list.createEl("p", { text: "没有匹配模型，可手动添加。", cls: "simple-ai-hint" });
      all.onchange = () => {
        for (const id of available) {
          if (all.checked) this.selected.add(id);
          else this.selected.delete(id);
        }
        refreshSelection();
      };
      refreshSelection();
    };
    search.onfocus = () => { if (draft.discoveredModels.length) { this.selecting = true; renderPicker(); } };
    search.oninput = () => { this.selecting = true; renderPicker(); };
    new ButtonComponent(modelsAddress.controlEl).setIcon("search").setTooltip("拉取模型列表").onClick(() => void this.run(form, fetchStatus, async client => {
      draft.discoveredModels = await client.listModels(draft, this.requestKey()); this.selected.clear(); this.selecting = true; this.modelsFetched = true;
      renderModels(); renderPicker(); return "";
    }));
    renderModels(); renderPicker();
    new ButtonComponent(addedHeading).setButtonText("＋ 手动添加模型").onClick(() => { const model = { id: "", alias: "" }; draft.models.push(model); renderModels(); renderPicker(); });
    const footer = new Setting(form); footer.settingEl.addClass("simple-ai-editor-footer");
    if (this.plugin.settings.sources.some(source => source.id === draft.id)) {
      footer.addButton(button => {
        button.setIcon("trash-2").setTooltip("删除来源");
        button.buttonEl.addClass("simple-ai-source-delete");
        button.onClick(() => {
          if (this.busy) return;
          new ConfirmDelete(this.app, draft.name, async () => {
            await this.plugin.deleteSource(draft.id); this.done(); this.close();
          }).open();
        });
      });
    }
    footer.addButton(b => b.setButtonText("取消").onClick(() => this.close()))
      .addButton(b => b.setButtonText("保存来源").setCta().onClick(async () => {
        if (this.busy) return;
        try {
          if (this.selected.size) throw new Error("请先点击“完成选择”，再保存来源。");
          validateSource(draft); endpoint(draft, "chat"); if (draft.modelsUrl.trim() || draft.modelsUrlMode === "full") endpoint(draft, "models");
          form.disabled = true; this.busy = true;
          const saved = { ...completeSourceAddresses(draft), name: draft.name.trim(), models: draft.models.map(model => ({ id: model.id.trim(), alias: model.alias.trim() })) };
          delete (saved as ApiSource & { group?: string }).group;
          delete (saved as ApiSource & { prefix?: string }).prefix;
          await this.plugin.saveSourceKeys(saved, this.keys.map(key => ({ id: key.id, value: key.value.trim() })));
          if (this.active) { this.done(); this.close(); new Notice("API 来源已保存。"); }
        } catch (error) { if (this.active) { status.classList.add("is-error"); status.setText(this.error(error)); } }
        finally { this.busy = false; if (this.active) form.disabled = false; }
      }));
  }
  private async run(form: HTMLFieldSetElement, status: HTMLElement, action: (client: ApiClient) => Promise<string>): Promise<void> {
    if (this.busy) return;
    this.busy = true; form.disabled = true; status.classList.remove("is-error"); status.setText("请求中…");
    try { const message = await action(this.plugin.client); if (this.active) status.setText(message); }
    catch (error) { if (this.active) { status.classList.add("is-error"); status.setText(this.error(error)); } }
    finally { this.busy = false; if (this.active) form.disabled = false; }
  }
}
export class ApiSettingsTab extends PluginSettingTab {
  private stopAgentStatus?: () => void;
  hide(): void { this.stopAgentStatus?.(); this.stopAgentStatus = undefined; }
  private page: "overview" | "sources" | "skills" | "memory" | "examiner" | "auxiliary" | "auxiliaryAssessment" | "traffic" | "rules" | "compression" = "overview";
  constructor(private plugin: SimpleAIPlugin) { super(plugin.app, plugin); }
  display(): void { this.render(); }
  renderInto(container: HTMLElement): void { this.containerEl = container; this.render(); }
  render(): void {
    this.hide();
    const el = this.containerEl; el.empty(); el.addClass("simple-ai-settings");
    el.classList.toggle("simple-ai-settings-overview", this.page === "overview");
    if (this.page === "traffic") {
      const heading = el.createDiv("simple-ai-library-header").createDiv("simple-ai-library-heading");
      new ButtonComponent(heading).setIcon("arrow-left").setTooltip("返回 AI 设置").onClick(() => { this.page = "overview"; this.display(); });
      new Setting(heading).setName("Token 用量统计").setHeading().setClass("simple-ai-page-heading");
      trafficSettingsPage(el.createDiv(), this.plugin);
      return;
    }
    if (this.page === "sources") { this.displaySources(el); return; }
    if (this.page === "auxiliary") {
      const header = el.createDiv("simple-ai-library-header");
      const heading = header.createDiv("simple-ai-library-heading");
      new ButtonComponent(heading).setIcon("arrow-left").setTooltip("返回 AI 设置").onClick(() => { this.page = "overview"; this.display(); });
      new Setting(heading).setName("子 Agent").setHeading().setClass("simple-ai-page-heading");
      auxiliarySettings(settingsSection(el, "子 Agent 配置"), this.plugin, () => this.display());
      return;
    }
    if (this.page === "auxiliaryAssessment") {
      const header = el.createDiv("simple-ai-library-header");
      const heading = header.createDiv("simple-ai-library-heading");
      new ButtonComponent(heading).setIcon("arrow-left").setTooltip("返回模型考核").onClick(() => { this.page = "examiner"; this.display(); });
      new Setting(heading).setName("考核子 Agent工作成果").setHeading().setClass("simple-ai-page-heading");
      this.stopAgentStatus = auxiliaryAssessmentPage(el.createDiv("simple-ai-examiner-settings"), this.plugin);
      return;
    }
    if (this.page === "examiner") {
      const header = el.createDiv("simple-ai-library-header");
      const heading = header.createDiv("simple-ai-library-heading");
      new ButtonComponent(heading).setIcon("arrow-left").setTooltip("返回 AI 设置").onClick(() => { this.page = "overview"; this.display(); });
      new Setting(heading).setName("模型考核").setHeading().setClass("simple-ai-page-heading");
      modelSettings(el.createDiv(), this.plugin, page => { this.page = page; this.display(); }, "examiner");
      return;
    }
    if (this.page === "skills" || this.page === "memory" || this.page === "rules" || this.page === "compression") {
      const header = el.createDiv("simple-ai-library-header");
      const heading = header.createDiv("simple-ai-library-heading");
      const parent = "overview" as const;
      new ButtonComponent(heading).setIcon("arrow-left").setTooltip("返回 AI 设置").onClick(() => { this.page = parent; this.display(); });
      new Setting(heading).setName({ skills: "技能库", memory: "自动记忆", rules: "模型共用提示词", compression: "自动压缩设置" }[this.page]).setHeading().setClass("simple-ai-page-heading");
      this.stopAgentStatus = agentSettingsPage(el.createDiv(), this.plugin, this.page, this.page === "memory"
        ? parent => modelSettings(parent, this.plugin, page => { this.page = page; this.display(); }, "memory")
        : undefined);
      return;
    }
    const models = settingsSection(el, "模型管理");
    settingsNavigation(new Setting(models).setName(`API 来源 · ${this.plugin.settings.sources.length} 个来源 · ${this.plugin.settings.sources.reduce((count, source) => count + source.models.length, 0)} 个模型`),
      () => { this.page = "sources"; this.display(); });
    modelSettings(models.createDiv(), this.plugin, page => { this.page = page; this.display(); });
    settingsNavigation(new Setting(models).setName("子 Agent"), () => { this.page = "auxiliary"; this.display(); });
    const assistant = settingsSection(el, "助手设置");
    agentSettings(assistant, this.plugin, page => { this.page = page; this.display(); });
    let choice: "enter" | "shift-enter" = this.plugin.settings.sendShortcut === "shift-enter" ? "shift-enter" : "enter";
    const shortcut = new Setting(assistant).setName("快捷发送").setClass("simple-ai-send-shortcut-setting");
    shortcut.addToggle(t => settingsCheckbox(t).setValue(this.plugin.settings.sendShortcut !== "off").onChange(async enabled => {
      t.setDisabled(true);
      try { await this.plugin.update({ ...this.plugin.settings, sendShortcut: enabled ? choice : "off" }); }
      catch { t.setValue(this.plugin.settings.sendShortcut !== "off"); new Notice("快捷发送保存失败。"); }
      finally { t.setDisabled(false); }
    }));
    shortcut.addDropdown(dropdown => dropdown.addOptions({ enter: "Enter", "shift-enter": "Shift + Enter" }).setValue(choice).onChange(async value => {
      const previous = choice;
      choice = value === "shift-enter" ? "shift-enter" : "enter";
      if (this.plugin.settings.sendShortcut === "off") return;
      dropdown.setDisabled(true);
      try { await this.plugin.update({ ...this.plugin.settings, sendShortcut: choice }); }
      catch { choice = previous; dropdown.setValue(previous); new Notice("快捷发送保存失败。"); }
      finally { dropdown.setDisabled(false); }
    }));
      const group = settingsSection(el, "模型协作");
      for (const [page, name, description] of [
        ["memory", "自动记忆", "提取工作习惯，生成记忆文件。"],
        ["examiner", "模型考核", "评估模型表现和工作成果。"],
      ] as const) settingsNavigation(new Setting(group).setName(name).setDesc(description), () => { this.page = page; this.display(); });
      const compression = settingsSection(el, "上下文压缩");
      settingsNavigation(new Setting(compression).setName("自动压缩设置").setDesc("触发点、压缩目标与自定义提示词。"), () => { this.page = "compression"; this.display(); });
      this.displayCacheSettings(el);
      this.displayUsageSettings(el);
  }
  private displayUsageSettings(el: HTMLElement): void {
    const group = settingsSection(el, "用量统计");
    settingsNavigation(new Setting(group).setName("Token 用量统计").setDesc("查看模型调用及累计 Token 用量。"), () => { this.page = "traffic"; this.display(); });
  }
  private displayCacheSettings(el: HTMLElement, existingGroup?: HTMLElement): void {
    const group = existingGroup ?? settingsSection(el, "缓存维护");
    let cleanAll = false;
    new Setting(group).setName("清理调用详情").setDesc("清除思考过程、工具参数与结果等详细记录；保留聊天正文、Token 累计用量和笔记修改记录。清理也覆盖备份，无法恢复。")
      .addDropdown(d => d.addOptions({ current: "当前对话", all: "全部对话" }).onChange(value => { cleanAll = value === "all"; }))
      .addButton(b => b.setButtonText("清理详情").onClick(async () => {
        b.setDisabled(true);
        try { await this.plugin.runtime.cleanCallDetails(cleanAll); new Notice("调用详情已清理，累计用量保留。"); }
        catch (error) { new Notice(error instanceof Error ? error.message : "清理失败。"); }
        finally { b.setDisabled(false); }
      }));
    new Setting(group).setName("清理图片及附件缓存").setDesc("清除全部聊天图片、附件及无用缓存，保留聊天文字；清理后附件无法恢复。")
      .addButton(b => b.setButtonText("立即清理").onClick(async () => {
        b.setDisabled(true);
        try { const count = await this.plugin.runtime.cleanAttachments(); new Notice(`清理完成，移除 ${count} 处图片及附件引用，并清除无用缓存。`); }
        catch (error) { new Notice(error instanceof Error ? error.message : "清理失败，请重试。"); }
        finally { b.setDisabled(false); }
      }));
    for (const [key, name, description] of [
      ["archivedCacheCleanupDays", "已归档对话（天）", "归档后保留图片及附件的天数，默认 1 天；0 表示不自动清理。"],
      ["cacheCleanupDays", "未归档对话（天）", "图片及附件保存天数，默认 7 天；0 表示不自动清理。"],
    ] as const) new Setting(group).setName(name).setDesc(description)
      .addText(t => {
        t.inputEl.type = "number"; t.inputEl.min = "0"; t.inputEl.step = "1";
        t.setValue(String(this.plugin.settings[key])).onChange(async value => {
          const days = Number(value);
          if (!value.trim() || !Number.isSafeInteger(days) || days < 0) return;
          try { await this.plugin.update({ ...this.plugin.settings, [key]: days }); }
          catch { new Notice("自动清理设置保存失败。"); }
        });
      });
  }
  private displaySources(el: HTMLElement): void {
    const header = el.createDiv("simple-ai-library-header");
    const heading = header.createDiv("simple-ai-library-heading");
    new ButtonComponent(heading).setIcon("arrow-left").setTooltip("返回 AI 设置").onClick(() => { this.page = "overview"; this.display(); });
    new Setting(heading).setName("API 来源").setHeading().setClass("simple-ai-page-heading");
    const group = settingsSection(el, "来源管理");
    if (!this.plugin.settings.sources.length) group.createEl("p", { text: "添加一个来源，再选择或手动填写模型。", cls: "simple-ai-hint" });
    for (const source of this.plugin.settings.sources) {
      const row = new Setting(group).setName(source.name).setClass("simple-ai-source-row");
      row.nameEl.createSpan({ cls: "simple-ai-source-summary", text: " · " + (source.protocol === "openai" ? "OpenAI" : "Anthropic") + " 兼容 · " + source.models.length + " 个模型" });
      row.addButton(button => button.setIcon("settings").setTooltip("管理来源").onClick(() => new SourceEditor(this.plugin, source, () => this.display()).open()));
    }
    const actions = group.createDiv("simple-ai-source-add");
    new ButtonComponent(actions).setIcon("plus").setTooltip("添加来源")
      .onClick(() => new SourceEditor(this.plugin, newSource(), () => this.display()).open());
  }
}

export class LibraryPicker extends Modal {
  constructor(private plugin: SimpleAIPlugin, private options: { source: ApiSource; model: ModelEntry }[], private choose: (entry: { source: ApiSource; model: ModelEntry }) => void) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText("切换模型");
    const visibility = this.contentEl.createDiv("simple-ai-source-visibility");
    const checkbox = visibility.createEl("input", { type: "checkbox" });
    checkbox.id = "simple-ai-show-source"; checkbox.checked = this.plugin.settings.showSourceName;
    visibility.createEl("label", { text: "显示来源名称", attr: { for: checkbox.id } });
    checkbox.onchange = async () => {
      checkbox.disabled = true;
      try { await this.plugin.update({ ...this.plugin.settings, showSourceName: checkbox.checked }); render(); }
      catch { checkbox.checked = this.plugin.settings.showSourceName; new Notice("设置保存失败。"); }
      finally { checkbox.disabled = false; }
    };
    const search = this.contentEl.createEl("input", { type: "search", placeholder: "搜索来源或模型", cls: "simple-ai-search" });
    search.setAttribute("aria-label", "搜索来源或模型");
    const list = this.contentEl.createDiv("simple-ai-options");
    const render = () => {
      list.empty();
      const items = this.options.filter(o => `${o.source.name} ${o.model.alias} ${o.model.id}`.toLowerCase().includes(search.value.toLowerCase()));
      if (!items.length) list.createEl("p", { text: "没有匹配模型。" });
      for (const item of items) {
        const button = list.createEl("button", { text: label(item.source, item.model, this.plugin.settings.showSourceName), cls: "simple-ai-option" });
        button.onclick = () => { this.choose(item); this.close(); };
      }
    };
    search.oninput = render; render(); search.focus();
  }
  onClose(): void { this.contentEl.empty(); }
}
