import { App, Modal, Notice, Setting, TFolder, normalizePath } from "obsidian";
import { nextId, type TemplateCategory } from "../types";
import { runAsync } from "../shared/async";

export function templatePropertyNames(template: TemplateCategory): string[] {
  return template.propertyFields ? [...template.propertyFields] : [...new Set([
    template.filenameField,
    ...Array.from((template.noteFormat ?? "").matchAll(/{{\s*([^{}]+?)\s*}}/g), match => match[1]),
    ...template.siteRules.flatMap(site => site.fields.map(field => field.fieldName)),
  ].filter(Boolean))];
}

export class TemplateCreateModal extends Modal {
  constructor(app: App, private readonly onSave: (template: TemplateCategory) => Promise<void>, private readonly template?: TemplateCategory) {
    super(app);
  }

  onOpen(): void {
    const root = this.contentEl;
    root.addClass("simple-template-create-modal");
    root.createEl("h2", { text: this.template ? "模板设置" : "新增模板" });
    let name = this.template?.name ?? "", folder = this.template?.outputFolder ?? "", filenameField = this.template?.filenameField ?? "";
    const noteFormat = this.template?.noteFormat ?? "";
    const properties = this.template ? templatePropertyNames(this.template) : [];
    const originalProperties = JSON.stringify(properties);
    const form = root.createEl("fieldset", { cls: "simple-template-create-form" });
    new Setting(form).setName("模板名称").addText(text => text.setValue(name).setPlaceholder("例如：网文书评、文章摘录").onChange(value => { name = value; }));
    new Setting(form).setName("文件保存目录")
      .addText(text => {
        text.setValue(folder).setPlaceholder("例如：阅读/书评").onChange(value => { folder = value; });
        const list = form.createEl("datalist", { attr: { id: `template-folders-${nextId()}` } });
        text.inputEl.setAttribute("list", list.id);
        for (const item of this.app.vault.getAllLoadedFiles()) {
          if (item instanceof TFolder && item.path !== "/") list.createEl("option", { value: item.path });
        }
      });
    const filename = new Setting(form).setName("用作文件名的笔记属性");
    filename.controlEl.addClass("simple-template-filename-control");
    const filenameSelect = filename.controlEl.createEl("select", { attr: { "aria-label": "用作文件名的笔记属性" } });
    const filenameError = filename.controlEl.createDiv({ cls: "simple-template-filename-error", text: "请选择用作文件名的笔记属性", attr: { id: `template-filename-error-${nextId()}`, "aria-live": "polite" } });
    filenameError.hidden = true;
    filenameSelect.setAttribute("aria-describedby", filenameError.id);
    filenameSelect.addEventListener("change", () => { filenameField = filenameSelect.value; renderTags(); });
    const propertySection = form.createDiv({ cls: "simple-template-properties" });
    propertySection.createDiv({ cls: "setting-item-name", text: "笔记属性" });
    const tags = propertySection.createDiv({ cls: "simple-template-property-tags" });
    const tagList = tags.createSpan({ cls: "simple-template-property-tag-list" });
    if (this.template) tagList.addClass("simple-template-property-rows");
    const editor = tags.createSpan({ cls: "simple-template-property-editor" });
    editor.hidden = true;
    const input = editor.createEl("input", { type: "text", attr: { placeholder: "属性名称", "aria-label": "新增属性名称" } });
    const confirm = editor.createEl("button", { text: "✓", attr: { type: "button", "aria-label": "确认添加属性" } });
    const add = tags.createEl("button", { text: "+", cls: "simple-template-property-add", attr: { type: "button", "aria-label": "添加属性" } });
    const renderTags = () => {
      if (!properties.includes(filenameField)) filenameField = "";
      filenameSelect.empty();
      filenameSelect.createEl("option", { text: properties.length ? "请选择笔记属性" : "请先添加笔记属性", value: "" });
      for (const property of properties) filenameSelect.createEl("option", { text: property, value: property });
      filenameSelect.value = filenameField;
      filenameSelect.disabled = !properties.length;
      filenameSelect.toggleClass("is-unselected", properties.length > 0 && !filenameField);
      if (filenameField) filenameError.hidden = true;
      filenameSelect.setAttribute("aria-invalid", String(!filenameError.hidden));
      tagList.empty();
      for (const property of properties) {
        const tag = tagList.createSpan({ cls: "simple-template-property-tag" });
        tag.toggleClass("is-filename", property === filenameField);
        const choose = tag.createEl("button", { text: property, attr: { type: "button", "aria-pressed": String(property === filenameField), "aria-label": `${property}，${property === filenameField ? "当前用于文件名" : "设为文件名"}` } });
        if (property === filenameField) choose.createSpan({ text: "文件名", cls: "simple-template-property-badge" });
        choose.addEventListener("click", () => { filenameField = property; renderTags(); });
        if (this.template) {
          for (const step of [-1, 1]) {
            const index = properties.indexOf(property);
            const move = tag.createEl("button", { text: step < 0 ? "↑" : "↓", attr: { type: "button", "aria-label": `${step < 0 ? "上移" : "下移"} ${property}` } });
            move.disabled = index + step < 0 || index + step >= properties.length;
            move.addEventListener("click", () => {
              [properties[index], properties[index + step]] = [properties[index + step], properties[index]];
              renderTags();
            });
          }
        }
        tag.createEl("button", { text: "×", cls: "simple-template-property-remove", attr: { type: "button", "aria-label": `移除属性 ${property}` } })
          .addEventListener("click", () => { properties.splice(properties.indexOf(property), 1); renderTags(); });
      }
    };
    const commitProperty = (): boolean => {
      const value = input.value.trim();
      if (!value) { editor.hidden = true; add.hidden = false; return true; }
      if (properties.includes(value)) { new Notice("该属性已存在"); input.focus(); return false; }
      properties.push(value);
      input.value = "";
      editor.hidden = true;
      add.hidden = false;
      renderTags();
      return true;
    };
    add.addEventListener("click", () => { editor.hidden = false; add.hidden = true; input.focus(); });
    confirm.addEventListener("click", () => { if (commitProperty()) add.focus(); });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); if (commitProperty()) add.focus(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = ""; editor.hidden = true; add.hidden = false; add.focus(); }
    });
    renderTags();
    if (this.template) {
      form.createEl("p", { cls: "setting-item-description", text: "属性与网站规则中的同名字段对应，未获取的内容可手动填写。提取与正则替换在各网站规则中设置。" });

    }
    const footer = root.createDiv({ cls: "simple-json-modal-footer" });
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { text: this.template ? "保存模板" : "创建模板", cls: "mod-cta" });
    save.addEventListener("click", runAsync(async () => {
      if (!commitProperty()) return;
      if (!filenameField) {
        filenameError.hidden = false;
        filenameSelect.setAttribute("aria-invalid", "true");
        if (!filenameSelect.disabled) filenameSelect.focus();
        return;
      }
      const fields = properties.map(value => value.trim());
      if (!name.trim()) { new Notice("请填写模板名称"); return; }
      if (!fields.length) { new Notice("请至少添加一个笔记属性"); return; }
      if (new Set(fields).size !== fields.length) { new Notice("属性名称不能重复"); return; }
      if (fields.some(value => /[\r\n]/.test(value))) { new Notice("属性名称不能包含换行"); return; }
      const path = folder.trim().replace(/\\/g, "/");
      if (path.startsWith("/") || path.split("/").some(part => part === ".." || part === ".") || /[:*?"<>|]/.test(path)) {
        new Notice("请填写笔记库内的相对目录"); return;
      }
      const outputFolder = path ? normalizePath(path) : "";
      const existing = outputFolder ? this.app.vault.getAbstractFileByPath(outputFolder) : null;
      if (existing && !(existing instanceof TFolder)) { new Notice("保存目录不能指向已有文件"); return; }
      save.disabled = form.disabled = true;
      try {
        await this.onSave({ ...(this.template ?? { id: nextId(), siteRules: [] }), name: name.trim(), outputFolder, filenameField,
          propertyFields: !this.template || JSON.stringify(fields) !== originalProperties ? fields : this.template.propertyFields, noteFormat });
        this.close();
      } finally { save.disabled = form.disabled = false; }
    }));
  }
}
