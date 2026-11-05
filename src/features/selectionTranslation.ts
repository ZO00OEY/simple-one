import { Setting } from "../shared/settingControls";
import { styleActionButton } from "../shared/actionButton";
import { Modal, Notice, getLanguage, requireApiVersion, moment } from "obsidian";
import { TRANSLATION_PROMPTS, translationPreferences } from "./translationPreferences";
import type { TranslationSettings } from "../types";
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
export function translationLocale(): string {
  return requireApiVersion("1.8.7") ? getLanguage() : moment.locale();
}

export function translationService(plugin: SimplePlugin): TranslationBridge | undefined {
  return plugin.ai?.getTranslationModels().length ? plugin.ai : undefined;
}

export class TranslationSettingsModal extends Modal {
  constructor(private plugin: SimplePlugin) { super(plugin.app); }
  onOpen(): void {
    trackTranslationModal(this.plugin, this);
    this.titleEl.setText("AI 翻译");
    this.modalEl.addClass("simple-translation-settings-modal");
    this.contentEl.addClass("simple-settings");
    const current = this.plugin.settings.enhancements.quickFormat.translation;
    const draft: TranslationSettings = { sourceId: current?.sourceId ?? "", modelId: current?.modelId ?? "", preset: current?.preset ?? "parallel", ...translationPreferences(current, translationLocale()) };
    const management = settingsFieldset(this.contentEl, "设置管理");
    const sourceControls = management.createDiv();
    const renderModels = () => {
      sourceControls.empty();
      const models = this.plugin.ai?.getTranslationModels() ?? [];
      const selected = models.find(model => model.sourceId === draft.sourceId && model.modelId === draft.modelId) ?? models[0];
      if (selected) { draft.sourceId = selected.sourceId; draft.modelId = selected.modelId; }
      const modelSetting = new Setting(sourceControls).setClass("simple-translation-management-row").setName("翻译模型");
      if (!models.length) modelSetting.setDesc("在拓展中启用 AI 并配置模型；配置后即使关闭 AI 也可翻译。");
      modelSetting.addDropdown(dropdown => {
        dropdown.selectEl.setAttribute("aria-label", "翻译模型");
        if (!models.length) dropdown.addOption("", "请先配置 AI 模型");
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
        void (async () => {
          const previous = this.plugin.settings.enhancements.quickFormat.translation;
          button.setDisabled(true);
          try {
            this.plugin.settings.enhancements.quickFormat.translation = draft;
            await this.plugin.saveSettings(); this.plugin.refreshQuickFormatActions(); this.close();
          } catch {
            this.plugin.settings.enhancements.quickFormat.translation = previous;
            new Notice("翻译设置保存失败。"); button.setDisabled(false);
          }
        })();
      });
    });
  }
  onClose(): void { openTranslationModals.get(this.plugin)?.delete(this); this.contentEl.empty(); }
}
