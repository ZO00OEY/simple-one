import { setNativeTooltip } from "../shared/tooltipText";
import { styleActionButton } from "../shared/actionButton";
import { Modal, Notice, Setting, getLanguage, requireApiVersion, moment, type App } from "obsidian";
import { TRANSLATION_PROMPTS, translationPreferences } from "./translationPreferences";
import type { TranslationApiSettings, TranslationSettings } from "../types";
import { customTranslate, fetchTranslationModels, normalizeTranslationModels, translationEndpoint, completeTranslationAddresses } from "./translationApi";
import { settingsFieldset } from "../shared/settingsLayout";
import type SimplePlugin from "../main";

type Model = { sourceId: string; modelId: string; label: string };
interface TranslationBridge {
  getTranslationModels(): Model[];
  translateSelection(input: { text: string; prompt: string; sourceId: string; modelId: string }, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<string>;
}
const openTranslationModals = new WeakMap<SimplePlugin, Set<Modal>>();
function trackTranslationModal(plugin: SimplePlugin, modal: Modal): void {
  let open = openTranslationModals.get(plugin);
  if (!open) {
    open = new Set<Modal>();
    openTranslationModals.set(plugin, open);
    const active = open;
    plugin.register(() => {
      for (const item of active) item.close();
      active.clear(); openTranslationModals.delete(plugin);
    });
  }
  open.add(modal);
}
export { TRANSLATION_PROMPTS } from "./translationPreferences";
export function translationBridge(app: App): TranslationBridge | undefined {
  const plugin = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.["simple-ai"] as Partial<TranslationBridge> | undefined;
  if (typeof plugin?.getTranslationModels === "function" && typeof plugin.translateSelection === "function" && plugin.getTranslationModels().length) return plugin as TranslationBridge;
  return undefined;
}
export function translationLocale(): string {
  return requireApiVersion("1.8.7") ? getLanguage() : moment.locale();
}

export function translationProvider(config: TranslationSettings | undefined): "custom" | "simple-ai" {
  return config?.provider ?? (config?.sourceId ? "simple-ai" : "custom");
}
function translationSecretId(plugin: SimplePlugin): string { return `${plugin.manifest.id}-translation-api`; }
function translationKey(plugin: SimplePlugin): string {
  return requireApiVersion("1.11.4") ? plugin.app.secretStorage?.getSecret(translationSecretId(plugin)) ?? "" : "";
}
function saveTranslationKey(plugin: SimplePlugin, key: string): void {
  if (requireApiVersion("1.11.4")) plugin.app.secretStorage.setSecret(translationSecretId(plugin), key);
  else throw new Error("请升级至 Obsidian 1.11.4 或更高版本以保存 API 密钥。");
}
export function translationService(plugin: SimplePlugin): TranslationBridge | undefined {
  const config = plugin.settings.enhancements.quickFormat.translation;
  if (translationProvider(config) === "simple-ai") return translationBridge(plugin.app);
  if (!config?.api?.url.trim() || !config.modelId || !config.api.models.includes(config.modelId)) return undefined;
  const api = { ...config.api, models: [...config.api.models] };
  return {
    getTranslationModels: () => api.models.map(modelId => ({ sourceId: "custom", modelId, label: modelId })),
    translateSelection: async (input, signal, update) => {
      const text = await customTranslate(api, translationKey(plugin), input, signal);
      if (!signal?.aborted) update?.(text);
      return text;
    },
  };
}

export class TranslationSettingsModal extends Modal {
  constructor(private plugin: SimplePlugin) { super(plugin.app); }
  onOpen(): void {
    trackTranslationModal(this.plugin, this);
    this.titleEl.setText("AI 翻译");
    this.modalEl.addClass("simple-translation-settings-modal");
    this.contentEl.addClass("simple-settings");
    const current = this.plugin.settings.enhancements.quickFormat.translation;
    let draftKey = translationKey(this.plugin), keyEdited = false;
    const draft: TranslationSettings = { ...current, provider: translationProvider(current), sourceId: current?.sourceId ?? "", modelId: current?.modelId ?? "", preset: current?.preset ?? "parallel", ...translationPreferences(current, translationLocale()) };
    if(current?.api) draft.api = { ...current.api, models: [...current.api.models] };
    const management = settingsFieldset(this.contentEl, "设置管理");
    const sourceControls = management.createDiv();
    const renderModels = () => {
      sourceControls.empty();
      const source = new Setting(sourceControls).setClass("simple-translation-management-row").setName("模型来源");
      if (draft.provider === "custom") source.addButton(button => {
        styleActionButton(button.buttonEl, "bordered");
        button.setIcon("settings").setTooltip("自定义 API 设置").onClick(() => new TranslationApiModal(this.plugin, draft.api, draftKey, (api, key) => {
          draft.api = api; draftKey = key; keyEdited = true; draft.sourceId = "custom"; renderModels();
        }).open());
      });
      source.addDropdown(dropdown => {
        dropdown.selectEl.setAttribute("aria-label", "模型来源");
        dropdown.addOptions({ custom: "自定义 API", "simple-ai": "引用 Simple AI" }).setValue(draft.provider!).onChange(value => { draft.provider = value as typeof draft.provider; renderModels(); });
      });
      const models = draft.provider === "custom" ? (draft.api?.models ?? []).map(modelId => ({ sourceId: "custom", modelId, label: modelId })) : translationBridge(this.app)?.getTranslationModels() ?? [];
      const selected = models.find(model => model.sourceId === draft.sourceId && model.modelId === draft.modelId) ?? models[0];
      if (selected) { draft.sourceId = selected.sourceId; draft.modelId = selected.modelId; }
      new Setting(sourceControls).setClass("simple-translation-management-row").setName("翻译模型").addDropdown(dropdown => {
        dropdown.selectEl.setAttribute("aria-label", "翻译模型");
        if (!models.length) dropdown.addOption("", draft.provider === "custom" ? "请先配置 API 和模型" : "Simple AI 尚无可用模型");
        models.forEach((model, index) => { dropdown.addOption(String(index), model.label); });
        dropdown.setValue(selected ? String(models.indexOf(selected)) : "").setDisabled(!models.length).onChange((value): void => {
          const model = models[Number(value)]; if (model) { draft.sourceId = model.sourceId; draft.modelId = model.modelId; }
        });
      });
    };
    renderModels();
    for (const [key, name] of [["languageA", "母语"], ["languageB", "学习语言"]] as const) new Setting(management).setClass("simple-translation-management-row").setName(name).addText(text => {
      text.inputEl.maxLength = 80; text.inputEl.setAttribute("aria-label", name);
      text.setValue(draft[key] ?? "").onChange(value => { draft[key] = value; });
    });
    let promptInput: HTMLTextAreaElement;
    new Setting(this.contentEl).setName("翻译提示词").addDropdown(dropdown => dropdown.addOptions({ parallel: "忠实翻译 · 分段对照", concise: "简洁翻译 · 分段对照", custom: "自定义" }).setValue(draft.preset).onChange(value => {
      draft.preset = value;
      if (TRANSLATION_PROMPTS[value]) { draft.prompt = TRANSLATION_PROMPTS[value]; promptInput.value = draft.prompt; }
    }));
    new Setting(this.contentEl).setClass("simple-translation-prompt-editor").addTextArea(text => {
      promptInput = text.inputEl; promptInput.rows = 8; promptInput.setAttribute("aria-label", "翻译提示词内容");
      text.setValue(draft.prompt).onChange(value => { draft.prompt = value; });
    });
    new Setting(this.contentEl).addButton(button => {
      styleActionButton(button.buttonEl, "text"); button.setButtonText("保存").setCta().onClick(() => {
        if (!draft.prompt.trim()) { new Notice("请填写翻译提示词。"); return; }
        if (!draft.languageA?.trim() || !draft.languageB?.trim() || draft.languageA.trim() === draft.languageB.trim()) { new Notice("请填写两种不同的互译语言。"); return; }
        if (draft.languageA.length > 80 || draft.languageB.length > 80) { new Notice("每种语言名称最多 80 个字符。"); return; }
        if (draft.provider === "custom") {
          try { if (!draft.api || !draft.api.models.includes(draft.modelId)) throw new Error("请先配置 API 并选择翻译模型。"); translationEndpoint(draft.api, "chat"); }
          catch(error) { new Notice(error instanceof Error ? error.message : "API 配置不完整"); return; }
        }
        void (async () => {
          const previous = this.plugin.settings.enhancements.quickFormat.translation, previousKey = translationKey(this.plugin);
          let keySaved = false; button.setDisabled(true);
          try {
            if (keyEdited) { saveTranslationKey(this.plugin, draftKey); keySaved = true; }
            this.plugin.settings.enhancements.quickFormat.translation = draft;
            await this.plugin.saveSettings(); this.plugin.refreshQuickFormatActions(); this.close();
          } catch {
            this.plugin.settings.enhancements.quickFormat.translation = previous;
            if (keySaved) { try { saveTranslationKey(this.plugin, previousKey); } catch { new Notice("密钥恢复失败，请重新检查 API 设置。"); } }
            new Notice("翻译设置保存失败。"); button.setDisabled(false);
          }
        })();
      });
    });
  }
  onClose(): void { openTranslationModals.get(this.plugin)?.delete(this); this.contentEl.empty(); }
}

class TranslationApiModal extends Modal {
  private controller?: AbortController;
  constructor(private plugin: SimplePlugin, private current: TranslationApiSettings | undefined, private draftKey: string, private saved: (api: TranslationApiSettings, key: string) => void) { super(plugin.app); }
  onOpen(): void {
    trackTranslationModal(this.plugin, this);
    this.titleEl.setText("自定义翻译 API");
    this.modalEl.addClass("simple-translation-settings-modal", "simple-translation-api-modal");
    this.contentEl.addClass("simple-settings");
    const draft: TranslationApiSettings = { modelsUrlMode: this.current?.modelsUrlMode ?? (this.current?.modelsUrl.trim() ? "full" : "base"), urlMode: this.current?.urlMode ?? "base", protocol: this.current?.protocol ?? "openai", url: this.current?.url ?? "", modelsUrl: this.current?.modelsUrl ?? "", models: [...(this.current?.models ?? [])] };
    let key = this.draftKey;
    const basic = settingsFieldset(this.contentEl, "API 基础信息");
    let addressInput: HTMLInputElement;
    let refreshModelsHint = () => {}, refreshRequestTooltip = () => {};
    const requestHint = () => draft.urlMode === "full" ? "不自动补全，需填写完整请求地址。" : "自动补全请求地址，完整路径不重复添加。";
    const updateHint = () => {
      addressInput.placeholder=requestHint(); setNativeTooltip(addressInput, requestHint());
      try { setNativeTooltip(addressInput, (addressInput.getAttribute("aria-label") || "") + ("\n实际请求地址：" + translationEndpoint(draft,"chat"))); } catch { /* Keep the routing description while the field is empty. */ }
      refreshModelsHint(); refreshRequestTooltip();
    };
    new Setting(basic).setClass("simple-translation-protocol-row").setName("协议").addDropdown(dropdown => dropdown.addOptions({ openai: "OpenAI 兼容", anthropic: "Anthropic 兼容" }).setValue(draft.protocol).onChange(value => { draft.protocol = value as typeof draft.protocol; updateHint(); }));
    const address = new Setting(basic).setName("请求地址").addText(text => {
      addressInput = text.inputEl; addressInput.setAttribute("aria-label", "请求地址");
      text.setPlaceholder("请求地址，自动补全接口路径").setValue(draft.url).onChange(value => { draft.url = value; updateHint(); });
    });
    address.addButton(button => {
      styleActionButton(button.buttonEl, "plain"); button.buttonEl.addClass("simple-translation-endpoint-lock"); button.setIcon("lock");
      refreshRequestTooltip=()=>{button.setTooltip(requestHint());};
      const sync = () => { const locked=draft.urlMode === "full"; button.buttonEl.setAttribute("aria-pressed",String(locked)); button.setTooltip(requestHint()); updateHint(); };
      button.onClick(() => { draft.urlMode=draft.urlMode === "full" ? "base" : "full"; sync(); }); sync();
    });
    const secret = new Setting(basic).setClass("simple-translation-secret-row").setName("API 密钥");
    let secretInput: HTMLInputElement;
    secret.addText(text => { secretInput = text.inputEl; secretInput.type = "password"; secretInput.autocomplete = "new-password"; secretInput.setAttribute("aria-label", "API 密钥"); text.setPlaceholder("API 密钥，免密接口可留空").setValue(key).onChange(value => { key = value; }); });
    secret.addButton(button => {
      styleActionButton(button.buttonEl, "plain"); button.buttonEl.addClass("simple-translation-secret-toggle");
      button.setIcon("eye").setTooltip("显示或隐藏密钥").onClick(() => { secretInput.type=secretInput.type === "password" ? "text" : "password"; button.buttonEl.setAttribute("aria-pressed",String(secretInput.type === "text")); });
    });
    const models = settingsFieldset(this.contentEl, "模型列表");
    const list = new Setting(models).setName("列表地址");
    let modelsInput: HTMLInputElement;
    let customModelsUrl=draft.modelsUrlMode === "full" ? draft.modelsUrl : "";
    const modelsHint = () => draft.modelsUrlMode === "full" ? "不自动补全，需填写完整模型列表地址。" : "自动补全模型列表地址，完整路径不重复添加。";
    list.addText(text => { modelsInput=text.inputEl; modelsInput.setAttribute("aria-label", "模型列表地址"); text.setValue(draft.modelsUrl).onChange(value => { if(draft.modelsUrlMode === "full") customModelsUrl=draft.modelsUrl=value; }); });
    list.addButton(button => {
      styleActionButton(button.buttonEl,"plain"); button.buttonEl.addClass("simple-translation-endpoint-lock","simple-translation-models-lock"); button.setIcon("lock");
      refreshModelsHint = () => {
        const locked=draft.modelsUrlMode === "full"; button.buttonEl.setAttribute("aria-pressed",String(locked)); button.setTooltip(modelsHint());
        modelsInput.readOnly=!locked; modelsInput.placeholder=modelsHint(); setNativeTooltip(modelsInput, modelsHint());
        if(locked) modelsInput.value=draft.modelsUrl;
        else { try { modelsInput.value=translationEndpoint(draft,"models"); setNativeTooltip(modelsInput, (modelsInput.getAttribute("aria-label") || "") + ("\n实际列表地址："+modelsInput.value)); } catch { modelsInput.value=""; } }
      };
      button.onClick(() => { draft.modelsUrlMode=draft.modelsUrlMode === "full" ? "base" : "full"; draft.modelsUrl=draft.modelsUrlMode === "full" ? customModelsUrl : ""; refreshModelsHint(); });
      refreshModelsHint();
    });
    const status = models.createEl("p", { cls: "setting-item-description simple-translation-fetch-status", attr: { role: "status", "aria-live": "polite" } });
    status.hidden = true;
    const modelHeader = new Setting(models).setClass("simple-translation-model-header").setName("已添加模型");
    const modelRows = models.createDiv({ cls: "simple-translation-models" });
    const updateCount = () => modelHeader.setName(`已添加模型 · ${normalizeTranslationModels(draft.models).length}`);
    const renderModels = () => {
      modelRows.empty(); updateCount();
      if (!draft.models.length) modelRows.createEl("p", { cls: "setting-item-description", text: "暂无模型，可拉取或点＋添加。" });
      draft.models.forEach((id, index) => {
        const row = new Setting(modelRows).setClass("simple-translation-model-row");
        row.addText(text => {
          text.inputEl.setAttribute("aria-label", `模型 ID ${index + 1}`);
          text.setPlaceholder("输入模型 ID").setValue(id).onChange(value => { draft.models[index] = value; updateCount(); });
        });
        row.addButton(button => {
          styleActionButton(button.buttonEl, "plain");
          button.setIcon("x").setTooltip(`删除模型 ${index + 1}`).onClick(() => { draft.models.splice(index, 1); renderModels(); });
        });
      });
    };
    modelHeader.addButton(button => {
      styleActionButton(button.buttonEl, "plain");
      button.setIcon("plus").setTooltip("手动添加模型").onClick(() => {
        draft.models.push(""); renderModels(); modelRows.querySelector<HTMLInputElement>(".simple-translation-model-row:last-child input")?.focus();
      });
    });
    renderModels();
    list.addButton(button => {
      styleActionButton(button.buttonEl, "bordered"); button.setIcon("search").setTooltip("拉取模型列表").onClick(() => {
        this.controller?.abort(); const controller = new AbortController(); this.controller = controller;
        button.setDisabled(true); status.classList.remove("is-error"); status.hidden = false; status.setText("正在拉取…");
        const signature = JSON.stringify([draft.protocol, draft.url, draft.urlMode, draft.modelsUrl, draft.modelsUrlMode, key]);
        void fetchTranslationModels({ ...draft }, key.trim(), controller.signal).then(found => {
          if (controller.signal.aborted) return;
          if (signature !== JSON.stringify([draft.protocol, draft.url, draft.urlMode, draft.modelsUrl, draft.modelsUrlMode, key])) { status.setText("配置已变化，请重新拉取模型。"); return; }
          draft.models = normalizeTranslationModels([...draft.models, ...found]); renderModels(); status.hidden = true;
        }).catch(error => { if (!controller.signal.aborted) { status.classList.add("is-error"); status.setText(error instanceof Error ? error.message : "模型列表拉取失败"); } })
          .finally(() => { if (!controller.signal.aborted) button.setDisabled(false); });
      });
    });
    new Setting(this.contentEl).addButton(button => {
      styleActionButton(button.buttonEl, "text"); button.setButtonText("保存 API 设置").setCta().onClick(() => {
        try {
          const completed = completeTranslationAddresses(draft);
          draft.models = normalizeTranslationModels(draft.models);
          if (!requireApiVersion("1.11.4")) throw new Error("请升级 Obsidian 后使用密钥存储。");
          this.saved({ ...completed, models: draft.models }, key.trim()); this.close();
        } catch(error) { new Notice(error instanceof Error ? error.message : "API 设置保存失败"); }
      });
    });
  }
  onClose(): void { this.controller?.abort(); openTranslationModals.get(this.plugin)?.delete(this); this.contentEl.empty(); }
}
