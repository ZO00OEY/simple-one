import { ButtonComponent, Notice } from "obsidian";
import type SimpleAIPlugin from "../main";
import { label } from "../api/types";
import type { Session } from "./types";

export class ModelPopover {
  private el: HTMLElement;
  private cleanup: () => void;
  constructor(private plugin: SimpleAIPlugin, host: HTMLElement, anchor: HTMLElement, session: Session, private changed: () => void, onClose: () => void) {
    const doc = host.ownerDocument, win = doc.defaultView!;
    this.el = host.createDiv("simple-ai-model-popover"); this.el.setAttribute("role", "dialog"); this.el.setAttribute("aria-label", "模型与审批");
    const search = this.el.createEl("input", { type: "search", placeholder: "搜索模型或来源", attr: { "aria-label": "搜索模型或来源" } });
    const list = this.el.createDiv("simple-ai-model-groups");
    const footer = this.el.createDiv("simple-ai-approval-options");
    footer.createSpan({ text: "审批模式", cls: "simple-ai-approval-label" });
    const choices = footer.createDiv("simple-ai-approval-segments"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "审批模式");
    const buttons: { value: "auto" | "full"; element: HTMLButtonElement }[] = [];
    for (const [value, title] of [["auto", "自动审批"], ["full", "无需审批"]] as const) {
      const button = new ButtonComponent(choices).setButtonText(title).onClick(() => {
        if (plugin.runtime.busy) { new Notice("请先停止当前任务再修改审批。"); return; }
        session.permission = value; plugin.runtime.userActive(); this.persist();
        for (const item of buttons) item.element.setAttribute("aria-pressed", String(item.value === value));
      });
      button.buttonEl.setAttribute("aria-pressed", String((session.permission ?? "auto") === value));
      if (value === "full") button.buttonEl.addClass("simple-ai-no-approval");
      buttons.push({ value, element: button.buttonEl });
    }
    const collapsed = new Set<string>();
    const selected = session.selected ?? plugin.settings.selected;
    for (const source of plugin.settings.sources) if (selected && source.id !== selected.sourceId) collapsed.add(source.id);
    const render = () => {
      list.empty(); const query = search.value.trim().toLowerCase(); let count = 0;
      for (const source of plugin.settings.sources) {
        const models = source.models.filter(m => `${source.name} ${m.id} ${m.alias}`.toLowerCase().includes(query));
        if (!models.length) continue; count += models.length;
        const group = list.createEl("details", { cls: "simple-ai-model-group" }); group.open = !!query || !collapsed.has(source.id);
        group.createEl("summary", { text: `${source.name} · ${models.length}` });
        group.addEventListener("toggle", () => { if (!query) { if (group.open) collapsed.delete(source.id); else collapsed.add(source.id); } });
        for (const model of models) {
          const button = new ButtonComponent(group).setButtonText(label(source, model, false)).setTooltip(model.id).onClick(() => {
            if (plugin.runtime.busy) { new Notice("请先停止当前任务再切换模型。"); return; }
            session.selected = { sourceId: source.id, modelId: model.id }; this.persist(); this.close();
          });
          button.buttonEl.addClass("simple-ai-group-model");
          button.buttonEl.setAttribute("aria-pressed", String(selected?.sourceId === source.id && selected.modelId === model.id));
        }
      }
      if (!count) list.createEl("p", { text: plugin.settings.sources.length ? "没有匹配模型。" : "请先在 API 管理中添加来源和模型。", cls: "simple-ai-hint" });
    };
    const position = () => {
      const root = host.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
      const viewportTop = win.visualViewport?.offsetTop ?? 0;
      this.el.style.bottom = Math.max(0, root.bottom - rect.top + 6) + "px";
      this.el.style.maxHeight = Math.max(100, rect.top - Math.max(root.top, viewportTop) - 14) + "px";
    };
    const outside = (event: Event) => { const node = event.target as Node; if (!this.el.contains(node) && !anchor.contains(node)) this.close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); this.close(); anchor.focus(); } };
    const resize = new ResizeObserver(position); resize.observe(host); resize.observe(anchor);
    search.oninput = render; render(); position(); search.focus({ preventScroll: true });
    doc.addEventListener("pointerdown", outside, true); this.el.addEventListener("keydown", escape);
    win.visualViewport?.addEventListener("resize", position); win.addEventListener("resize", position);
    this.cleanup = () => { resize.disconnect(); doc.removeEventListener("pointerdown", outside, true); win.visualViewport?.removeEventListener("resize", position); win.removeEventListener("resize", position); this.el.remove(); onClose(); };
  }
  private persist(): void { void this.plugin.runtime.save().catch(() => new Notice("设置保存失败。")); this.changed(); }
  close(): void { const cleanup = this.cleanup; this.cleanup = () => {}; cleanup?.(); }
}
