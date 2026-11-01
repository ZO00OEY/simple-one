import { styleActionButton } from "../shared/actionButton";
import { Modal, Notice, Setting, getLanguage, requireApiVersion, moment, type App } from "obsidian";
import { TRANSLATION_PROMPTS, translationPreferences } from "./translationPreferences";
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

export class TranslationSettingsModal extends Modal {
  constructor(private plugin: SimplePlugin) { super(plugin.app); }
  onOpen(): void {
    trackTranslationModal(this.plugin, this);
    this.titleEl.setText("AI 翻译");
    this.modalEl.addClass("simple-translation-settings-modal");
    this.contentEl.addClass("simple-settings");
    const models = translationBridge(this.app)?.getTranslationModels() ?? [];
    const current = this.plugin.settings.enhancements.quickFormat.translation;
    const draft = { sourceId: current?.sourceId ?? models[0]?.sourceId ?? "", modelId: current?.modelId ?? models[0]?.modelId ?? "", preset: current?.preset ?? "parallel", ...translationPreferences(current, translationLocale()) };
    const management = settingsFieldset(this.contentEl, "设置管理");
    if (!models.length) this.contentEl.createEl("p", { text: "请先安装、启用 AI 插件，并配置至少一个模型。" });
    new Setting(management).setClass("simple-translation-management-row").setName("翻译模型（引用 Simple AI）").addDropdown(dropdown => {
      models.forEach((model, index) => { dropdown.addOption(String(index), model.label); });
      const selected = models.findIndex(model => model.sourceId === draft.sourceId && model.modelId === draft.modelId);
      dropdown.setValue(selected < 0 ? "" : String(selected)).onChange(value => { const model = models[Number(value)]; if (model) { draft.sourceId = model.sourceId; draft.modelId = model.modelId; } });
    });
    for (const [key, name] of [["languageA", "母语"], ["languageB", "学习语言"]] as const) new Setting(management).setClass("simple-translation-management-row").setName(name).addText(text => {
      text.inputEl.maxLength = 80;
      text.inputEl.setAttribute("aria-label", name);
      text.setValue(draft[key]).onChange(value => { draft[key] = value; });
    });
    let promptInput: HTMLTextAreaElement;
    new Setting(this.contentEl).setName("翻译提示词").addDropdown(dropdown => dropdown.addOptions({ parallel: "忠实翻译 · 分段对照", concise: "简洁翻译 · 分段对照", custom: "自定义" }).setValue(draft.preset).onChange(value => {
      draft.preset = value;
      if (TRANSLATION_PROMPTS[value]) { draft.prompt = TRANSLATION_PROMPTS[value]; promptInput.value = draft.prompt; }
    }));
    new Setting(this.contentEl).setClass("simple-translation-prompt-editor").addTextArea(text => {
      promptInput = text.inputEl; promptInput.rows = 8;
      promptInput.setAttribute("aria-label", "翻译提示词内容");
      text.setValue(draft.prompt).onChange(value => { draft.prompt = value; });
    });
    new Setting(this.contentEl).addButton(button => { styleActionButton(button.buttonEl, "text"); return (button.setButtonText("保存").setCta().onClick(() => {
      if (!draft.prompt.trim()) { new Notice("请填写翻译提示词。"); return; }
      if (!draft.languageA.trim() || !draft.languageB.trim() || draft.languageA.trim() === draft.languageB.trim()) { new Notice("请填写两种不同的互译语言。"); return; }
      if (draft.languageA.length > 80 || draft.languageB.length > 80) { new Notice("每种语言名称最多 80 个字符。"); return; }
      void (async () => {
        try {
          this.plugin.settings.enhancements.quickFormat.translation = draft;
          await this.plugin.saveSettings(); this.plugin.refreshQuickFormatActions(); this.close();
        }
        catch { new Notice("翻译设置保存失败。"); }
      })();
    })); });
  }
  onClose(): void { openTranslationModals.get(this.plugin)?.delete(this); this.contentEl.empty(); }
}
