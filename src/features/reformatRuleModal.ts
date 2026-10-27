import { App, Modal, Setting } from "obsidian";
import { setActionIcon, setDeleteIcon, styleActionFooter } from "../shared/actionButton";
import type { TextReformatRule } from "../types";
import { applyTextReformatRules, parseReformatExpression } from "./noteReformatRules";

export class ReformatRuleModal extends Modal {
  constructor(
    app: App,
    private readonly rule: TextReformatRule,
    private readonly onSave: (rule: TextReformatRule, source: string) => Promise<void>,
    private readonly options: {
      title?: string;
      source?: string;
      preview?: (source: string, rule: TextReformatRule) => string;
      onDelete?: () => Promise<void>;
      onImport?: (ownerDocument: Document) => Promise<{ rule: TextReformatRule; source?: string } | null>;
      onExport?: (rule: TextReformatRule, source: string, ownerDocument: Document) => void;
    } = {},
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-reformat-editor-modal");
    this.titleEl.setText(this.options.title ?? "编辑排版规则");
    const draft = { ...this.rule };
    let expression = `/${draft.pattern}/${draft.flags || "g"}`;
    const nameLabel = this.contentEl.createEl("label", { text: "名称" });
    const name = nameLabel.createEl("input", { type: "text", attr: { "aria-label": "名称" } });
    name.value = draft.name;
    name.addEventListener("input", () => { draft.name = name.value; });
    const patternLabel = this.contentEl.createEl("label", { text: "匹配正则" });
    const pattern = patternLabel.createEl("textarea", {
      cls: "simple-reformat-expression",
      attr: { "aria-label": "匹配正则", spellcheck: "false" },
    });
    pattern.value = expression;
    const replacementLabel = this.contentEl.createEl("label", { text: "替换为" });
    const replacement = replacementLabel.createEl("textarea", {
      cls: "simple-reformat-expression",
      attr: { "aria-label": "替换为", spellcheck: "false" },
    });
    replacement.value = draft.replaceWith;
    const error = this.contentEl.createDiv({ cls: "simple-reformat-editor-error", attr: { role: "status" } });
    const preview = this.contentEl.createDiv({ cls: "simple-reformat-preview" });
    const sourceLabel = preview.createEl("label", { text: "原始文本" });
    const source = sourceLabel.createEl("textarea", { attr: { "aria-label": "原始文本", spellcheck: "false" } });
    source.value = this.options.source ?? "";
    const resultLabel = preview.createEl("label", { text: "替换后文本" });
    const result = resultLabel.createEl("textarea", { attr: { "aria-label": "替换后文本", readonly: "true" } });
    const actions = new Setting(this.contentEl);
    actions.settingEl.removeClass("setting-item");
    actions.settingEl.addClass("simple-reformat-editor-actions");
    let saveButton: HTMLButtonElement;
    const left = actions.settingEl.createDiv({ cls: "simple-reformat-editor-left-actions" });
    actions.settingEl.prepend(left);
    if (this.options.onDelete) {
      actions.addButton(button => {
        left.appendChild(button.buttonEl);
        setDeleteIcon(button.buttonEl);
        button.setTooltip("删除规则");
        button.buttonEl.setAttribute("aria-label", "删除规则");
        return button.onClick(async () => {
          button.setDisabled(true);
          try {
            await this.options.onDelete!();
            this.close();
          } catch (reason) {
            error.setText(reason instanceof Error ? reason.message : String(reason));
            button.setDisabled(false);
          }
        });
      });
    }
    if (this.options.onImport) {
      const button = left.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: "导入单条规则", "aria-label": "导入单条规则" } });
      setActionIcon(button, "download", "bordered");
      button.addEventListener("click", () => {
        void this.options.onImport!(this.contentEl.ownerDocument).then(imported => {
          if (!imported) return;
          Object.assign(draft, imported.rule, { id: this.rule.id });
          name.value = draft.name;
          expression = `/${draft.pattern}/${draft.flags || "g"}`;
          pattern.value = expression;
          replacement.value = draft.replaceWith;
          source.value = imported.source ?? "";
          update();
        }).catch(reason => error.setText(reason instanceof Error ? reason.message : String(reason)));
      });
    }
    if (this.options.onExport) {
      const button = left.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: "导出单条规则", "aria-label": "导出单条规则" } });
      setActionIcon(button, "upload", "bordered");
      button.addEventListener("click", () => {
        try {
          Object.assign(draft, parseReformatExpression(expression));
          this.options.onExport!(draft, source.value, this.contentEl.ownerDocument);
        } catch (reason) { error.setText(reason instanceof Error ? reason.message : String(reason)); }
      });
    }
    actions.addButton(button => button.setButtonText("取消").onClick(() => this.close()));
    actions.addButton(button => {
      saveButton = button.buttonEl;
      button.setButtonText("保存").setCta().onClick(async () => {
        try {
          Object.assign(draft, parseReformatExpression(expression));
          await this.onSave(draft, source.value);
          this.close();
        } catch (reason) {
          error.setText(reason instanceof Error ? reason.message : String(reason));
        }
      });
    });
    const update = (): void => {
      try {
        Object.assign(draft, parseReformatExpression(expression));
        error.empty();
        saveButton.disabled = false;
        result.value = this.options.preview
          ? this.options.preview(source.value, draft)
          : applyTextReformatRules(source.value, [{ ...draft, enabled: true }]);
      } catch (reason) {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        result.value = "";
        saveButton.disabled = true;
      }
    };
    pattern.addEventListener("input", () => { expression = pattern.value; update(); });
    replacement.addEventListener("input", () => { draft.replaceWith = replacement.value; update(); });
    source.addEventListener("input", update);
    update();
    styleActionFooter(actions.settingEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
