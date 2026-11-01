import { styleActionButton } from "../shared/actionButton";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { Notice, setIcon, type Editor, type EditorPosition, type MarkdownView } from "obsidian";
import { translationPreferences } from "./translationPreferences";
import type SimplePlugin from "../main";
import { interleaveTranslation, paragraphTranslationRequest, partialTranslations } from "./translationParagraphs";
import { translationBridge, translationLocale, TranslationSettingsModal } from "./selectionTranslation";
import { translationCardSource } from "./translationCards";

type Selection = { view: MarkdownView; editor: Editor; from: EditorPosition; to: EditorPosition; text: string; document: string; file?: string };
type Preview = { from: number; to: number; widget: Card; cancel: (update?: boolean) => void };
const setPreview = StateEffect.define<Preview | null>();
const previewField = StateField.define<Preview | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged && value) { value.cancel(false); value = null; }
    for (const effect of transaction.effects) if (effect.is(setPreview)) value = effect.value;
    return value;
  },
  provide: field => [
    EditorView.decorations.from(field, value => value
      ? Decoration.set([Decoration.replace({ block: true, widget: value.widget }).range(value.from, value.to)]) : Decoration.none),
    EditorView.editorAttributes.from(field, value => ({ class: value ? "simple-inline-translation-active" : "" })),
  ],
});

class Card extends WidgetType {
  constructor(readonly element: HTMLElement) { super(); }
  eq(other: Card): boolean { return this.element === other.element; }
  toDOM(): HTMLElement { return this.element; }
  ignoreEvent(): boolean { return true; }
}

const sessions = new WeakMap<SimplePlugin, Set<() => void>>();

export function translationCardMarkdown(text: string, original?: string): string {
  return translationCardSource(text, original);
}

export function previewRange(state: EditorState, from: number, to: number): { from: number; to: number; prefix: string; suffix: string } {
  const first = state.doc.lineAt(from), last = state.doc.lineAt(to);
  return { from: first.from, to: last.to, prefix: state.sliceDoc(first.from, from), suffix: state.sliceDoc(to, last.to) };
}

/** Temporary editor decoration: no source changes until the user accepts. */
export function startInlineTranslation(plugin: SimplePlugin, selected: Selection): void {
  const cm = (selected.editor as Editor & { cm?: EditorView }).cm;
  if (!cm) { new Notice("当前编辑器不支持原位预览，请在编辑模式中翻译。"); return; }
  const bridge = translationBridge(plugin.app), config = plugin.settings.enhancements.quickFormat.translation;
  if (!bridge || !config || !bridge.getTranslationModels().some(model => model.sourceId === config.sourceId && model.modelId === config.modelId)) {
    new TranslationSettingsModal(plugin).open(); return;
  }
  if (cm.state.doc.toString() !== selected.document || selected.view.file?.path !== selected.file) return;
  let request: ReturnType<typeof paragraphTranslationRequest>;
  const preferences = translationPreferences(config, translationLocale());
  try { request = paragraphTranslationRequest(selected.text, preferences.prompt, preferences.languageA, preferences.languageB); }
  catch (error) { new Notice(String(error)); return; }
  if (!cm.state.field(previewField, false)) cm.dispatch({ effects: StateEffect.appendConfig.of([
    previewField, ViewPlugin.fromClass(class {
      constructor(private view: EditorView) {}
      destroy(): void { this.view.state.field(previewField, false)?.cancel(false); }
    }),
  ]) });
  cm.state.field(previewField)?.cancel();
  const range = previewRange(cm.state, selected.editor.posToOffset(selected.from), selected.editor.posToOffset(selected.to));
  const doc = cm.dom.ownerDocument;
  const host = doc.win.createDiv({ cls: "simple-inline-translation-host" });
  if (range.prefix) host.createDiv({ cls: "simple-inline-translation-surrounding", text: range.prefix });
  const stack = host.createDiv({ cls: "simple-inline-translation-stack" });
  const back = stack.createDiv({ cls: "simple-inline-translation-back", attr: { "aria-hidden": "true" } });
  back.createSpan({ text: "原文" });
  const card = stack.createDiv({ cls: "simple-inline-translation-card" });
  const header = card.createDiv({ cls: "simple-inline-translation-header" });
  header.createSpan({ text: "翻译" });
  const cancelButton = header.createEl("button", { cls: "simple-inline-translation-close", attr: { type: "button", title: "关闭预览" } });
  setIcon(cancelButton, "x");
  const body = card.createDiv({ cls: "simple-inline-translation-body", attr: { "aria-label": "翻译对照预览" } });
  const translations = new Map<number, HTMLElement>();
  let index = 0;
  for (const block of request.blocks) {
    if (!block.text.trim()) continue;
    body.createDiv({ cls: "simple-inline-translation-original", text: block.text.trimEnd() });
    if (block.translate) translations.set(++index, body.createDiv({ cls: "simple-inline-translation-text" }));
  }
  const footer = card.createDiv({ cls: "simple-inline-translation-footer" });
  const status = footer.createSpan({ attr: { role: "status", "aria-live": "polite" } });
  status.hidden = true;
  const generating = footer.createSpan({ cls: "simple-inline-translation-generating", text: "待生成答案", attr: { role: "status" } });
  const dots = generating.createSpan({ cls: "simple-inline-translation-dots", attr: { "aria-hidden": "true" } });
  for (let n = 0; n < 3; n++) dots.createSpan({ text: "·" });
  const actions = footer.createDiv({ cls: "simple-inline-translation-actions" });
  actions.hidden = true;
  const iconButton = (icon: string, label: string, cls: string): HTMLButtonElement => {
    const button = styleActionButton(actions.createEl("button", { cls, attr: { type: "button", title: label } }), "bordered");
    setIcon(button, icon); return button;
  };
  const retry = iconButton("rotate-cw", "重新生成", "simple-inline-translation-retry");
  const insertText = iconButton("type", "插入文本", "simple-inline-translation-insert-text");
  const insertCard = iconButton("check", "插入卡片", "simple-inline-translation-insert-card");
  if (range.suffix) host.createDiv({ cls: "simple-inline-translation-surrounding", text: range.suffix });
  const controller = new AbortController();
  let closed = false, result = "", timer: number | undefined, pending = "";
  let active = sessions.get(plugin);
  if (!active) {
    active = new Set(); sessions.set(plugin, active);
    const all = active;
    plugin.register(() => { for (const cancel of [...all]) cancel(); sessions.delete(plugin); });
  }
  const cancel = (update = true): void => {
    if (closed) return;
    closed = true; controller.abort();
    if (timer !== undefined) doc.defaultView!.clearTimeout(timer);
    active?.delete(cancel);
    if (update && cm.state.field(previewField, false)?.widget.element === host) cm.dispatch({ effects: setPreview.of(null) });
  };
  active.add(cancel);
  cancelButton.addEventListener("click", () => cancel());
  const render = (reply: string): void => {
    if (closed) return;
    for (const [id, text] of partialTranslations(reply)) {
      const element = translations.get(id);
      if (element) element.textContent = text;
    }
    cm.requestMeasure();
  };
  const insert = (mode: "text" | "card"): void => {
    if (closed || !result) return;
    if (!selected.view.containerEl.isConnected || selected.view.file?.path !== selected.file || selected.editor.getValue() !== selected.document) {
      cancel(); new Notice("原文已变化，预览已取消；未写入笔记。"); return;
    }
    let replacement = result;
    if (mode === "card") {
      const newline = selected.document.includes("\r\n") ? "\r\n" : "\n";
      const before = selected.document.slice(0, selected.editor.posToOffset(selected.from));
      const after = selected.document.slice(selected.editor.posToOffset(selected.to));
      replacement = (before && !before.endsWith(newline + newline) ? newline + newline : "")
        + translationCardMarkdown(result, selected.text)
        + (after && !after.startsWith(newline + newline) ? newline + newline : "");
    }
    cancel(); selected.editor.replaceRange(replacement, selected.from, selected.to); selected.editor.focus();
  };
  insertText.addEventListener("click", () => insert("text"));
  insertCard.addEventListener("click", () => insert("card"));
  retry.addEventListener("click", () => { if (!closed) { cancel(); startInlineTranslation(plugin, selected); } });
  host.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } });
  cm.dispatch({ effects: setPreview.of({ from: range.from, to: range.to, widget: new Card(host), cancel }) });
  // Match the same snapshot for request, preview and final validation.
  void bridge.translateSelection({ ...config, text: request.text, prompt: request.prompt }, controller.signal, reply => {
    if (closed) return;
    pending = reply;
    if (timer === undefined) timer = doc.defaultView!.setTimeout(() => { timer = undefined; render(pending); }, 60);
  }).then(reply => {
    if (closed) return;
    if (timer !== undefined) { doc.defaultView!.clearTimeout(timer); timer = undefined; }
    result = interleaveTranslation(request.blocks, reply);
    render(reply); generating.hidden = true; actions.hidden = false;
  }).catch(error => {
    if (closed) return;
    if (timer !== undefined) { doc.defaultView!.clearTimeout(timer); timer = undefined; }
    status.hidden = false; status.textContent = `翻译失败：${error instanceof Error ? error.message : String(error)}`;
    generating.hidden = true; actions.hidden = false; insertText.hidden = true; insertCard.hidden = true;
  });
}
