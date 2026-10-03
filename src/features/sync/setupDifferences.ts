import { App, Modal } from "obsidian";
import type { OverlapChoice, SetupOverlapContent } from "./onboarding";

/** Whole-file choices for the real onboarding snapshot. */
export class SetupDifferencesModal extends Modal {
  private choices: Record<string, OverlapChoice>;
  private active = false;

  constructor(app: App, private paths: string[], choices: Record<string, OverlapChoice>,
    private read: (path: string) => Promise<SetupOverlapContent>,
    private apply: (choices: Record<string, OverlapChoice>) => void) {
    super(app);
    this.choices = { ...choices };
  }

  onOpen(): void {
    this.active = true;
    this.modalEl.addClass("simple-one-sync-preview-modal");
    const root = this.contentEl;
    root.addClass("simple-one-sync-preview");
    root.createEl("h2", { text: "处理文件差异" });
    root.createDiv({ cls: "simple-one-sync-preview__notice", text: "按文件选择保留本机或采用 GitHub。这里保存接入计划，完成接入时才应用。文本预览最多显示前 10,000 个字符，选择会应用整个文件。" });
    const toolbar = root.createDiv({ cls: "simple-one-sync-preview__toolbar" });
    const count = toolbar.createSpan({ cls: "simple-one-sync-preview__count" });
    const bulk = toolbar.createDiv({ cls: "simple-one-sync-preview__bulk" });
    const selects: HTMLSelectElement[] = [];
    const update = () => {
      const remaining = this.paths.filter(path => !this.choices[path]).length;
      count.setText(`待处理 ${remaining} / ${this.paths.length} 个文件`);
      save.disabled = remaining > 0;
    };
    for (const side of ["local", "remote"] as const) {
      const button = bulk.createEl("button", { text: side === "local" ? "全部选本机" : "全部选 GitHub" });
      button.addEventListener("click", () => {
        this.paths.forEach((path, index) => { this.choices[path] = side; selects[index].value = side; });
        update();
      });
    }
    const list = root.createDiv({ cls: "simple-one-sync-preview__list" });
    for (const path of this.paths) {
      const file = list.createDiv({ cls: "simple-one-sync-preview__file" });
      const summary = file.createDiv({ cls: "simple-one-sync-preview__summary" });
      summary.createSpan({ text: path, cls: "simple-one-sync-preview__path" });
      const select = summary.createEl("select");
      for (const [value, label] of [["", "请选择"], ["local", "保留本机"], ["remote", "采用 GitHub"]]) select.createEl("option", { value, text: label });
      select.value = this.choices[path] || "";
      selects.push(select);
      select.addEventListener("change", () => {
        if (select.value) this.choices[path] = select.value as OverlapChoice;
        else delete this.choices[path];
        update();
      });
      const detail = file.createEl("details", { cls: "simple-one-sync-setup-files" });
      detail.createEl("summary", { text: "展开对照两端内容" });
      const content = detail.createDiv({ cls: "simple-one-sync-setup-comparison" });
      let loaded = false;
      detail.addEventListener("toggle", () => {
        if (!detail.open || loaded) return;
        loaded = true;
        content.setText("正在读取…");
        void this.read(path).then(result => {
          if (!this.active) return;
          content.empty();
          for (const [label, text] of [["本机", result.local], ["GitHub", result.remote]]) {
            const side = content.createDiv();
            side.createEl("strong", { text: label });
            side.createEl("pre", { text });
          }
        }).catch(error => {
          if (!this.active) return;
          content.addClass("simple-one-sync-setup-error");
          content.setText(`读取失败：${error instanceof Error ? error.message : String(error)}。收起后可重试。`);
          loaded = false;
        });
      });
    }
    const footer = root.createDiv({ cls: "simple-one-sync-preview__footer" });
    const cancel = footer.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { text: "确认选择", cls: "mod-cta" });
    save.addEventListener("click", () => {
      if (this.paths.some(path => !this.choices[path])) return;
      this.apply(this.choices);
      this.close();
    });
    update();
  }

  onClose(): void { this.active = false; this.contentEl.empty(); }
}
