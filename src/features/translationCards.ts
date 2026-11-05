import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { Component, MarkdownRenderChild, MarkdownRenderer, Notice, setIcon } from "obsidian";
import { translationService, translationLocale } from "./selectionTranslation";
import { translationPreferences } from "./translationPreferences";
import { paragraphTranslationRequest, interleaveTranslation } from "./translationParagraphs";
import { styleActionButton } from "../shared/actionButton";
import type SimplePlugin from "../main";

type CardRange = { from: number; to: number; markdown: string; original?: string };
function cardContent(source: string): { markdown: string; original?: string } {
  const match = /^<!-- simple-translation-original:(.*?) -->\r?\n/.exec(source);
  if (match) {
    try { return { markdown: source.slice(match[0].length), original: decodeURIComponent(match[1]) }; } catch { /* Keep malformed metadata editable. */ }
  }
  return { markdown: source };
}
export function translationCardSource(text: string, original?: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  const metadata = original === undefined ? "" : `<!-- simple-translation-original:${encodeURIComponent(original)} -->${newline}`;
  return `${fence}simple-translation${newline}${metadata}${text.trimEnd()}${newline}${fence}`;
}

export function translationCardRanges(state: EditorState): CardRange[] {
  const cards: CardRange[] = [];
  let fence: { marker: string; from: number; content: number; translation: boolean } | undefined;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!match) continue;
    if (!fence) {
      fence = { marker: match[1], from: line.from, content: line.to + 1, translation: match[2].trim() === "simple-translation" };
    } else if (match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) {
      if (fence.translation) cards.push({ from: fence.from, to: line.to, ...cardContent(state.sliceDoc(fence.content, line.from).replace(/\r?\n$/, "")) });
      fence = undefined;
    }
  }
  return cards;
}

function cardShell(parent: HTMLElement): { host: HTMLElement; header: HTMLElement; body: HTMLElement } {
  const host = parent.createDiv({ cls: "simple-inline-translation-host simple-saved-translation" });
  const stack = host.createDiv({ cls: "simple-inline-translation-stack" });
  stack.createDiv({ cls: "simple-inline-translation-back", attr: { "aria-hidden": "true" } });
  const card = stack.createDiv({ cls: "simple-inline-translation-card" });
  const header = card.createDiv({ cls: "simple-inline-translation-header" });
  header.createSpan({ text: "翻译" });
  const body = card.createDiv({ cls: "markdown-rendered simple-saved-translation-content" });
  return { host, header, body };
}

const toggleSource = StateEffect.define<number>();
class SavedCard extends WidgetType {
  private component?: Component;
  private controller?: AbortController;
  constructor(private plugin: SimplePlugin, private range: CardRange, private expanded: boolean) { super(); }
  eq(other: SavedCard): boolean { return this.range.from === other.range.from && this.range.markdown === other.range.markdown && this.range.original === other.range.original && this.expanded === other.expanded; }
  toDOM(view: EditorView): HTMLElement {
    const root = view.dom.ownerDocument.win.createDiv();
    const shell = this.expanded ? { host: root, header: root, body: root } : cardShell(root);
    const button = shell.header.createEl("button", { cls: "simple-saved-translation-source", attr: { type: "button", "aria-label": this.expanded ? "预览卡片" : "编辑卡片源码" } });
    setIcon(button, this.expanded ? "eye" : "code");
    button.addEventListener("click", () => view.dispatch({ effects: toggleSource.of(this.range.from) }));
    if (!this.expanded) {
      const footer = shell.body.parentElement!.createDiv({ cls: "simple-inline-translation-footer" });
      const actions = footer.createDiv({ cls: "simple-inline-translation-actions" });
      const action = (icon: string, title: string, run: () => void) => {
        const button = styleActionButton(actions.createEl("button", { attr: { type: "button", "aria-label": title } }), "bordered");
        setIcon(button, icon); button.addEventListener("click", run); return button;
      };
      const snapshot = view.state.doc.toString();
      const replace = (text: string) => {
        if (view.state.doc.toString() !== snapshot) { new Notice("笔记已变化，请重新操作；未写入内容。"); return; }
        view.dispatch({ changes: { from: this.range.from, to: this.range.to, insert: text } });
      };
      const retry = action("rotate-cw", "重新翻译", () => {
        const bridge = translationService(this.plugin), config = this.plugin.settings.enhancements.quickFormat.translation;
        if (!bridge || !config) { new Notice("请先配置翻译模型。"); return; }
        try {
          const preferences = translationPreferences(config, translationLocale());
          const original = this.range.original ?? this.range.markdown;
          const request = paragraphTranslationRequest(original, preferences.prompt, preferences.languageA, preferences.languageB);
          this.controller = new AbortController(); retry.disabled = true;
          void bridge.translateSelection({ ...config, text: request.text, prompt: request.prompt }, this.controller.signal).then(reply => {
            if (!this.controller?.signal.aborted) replace(translationCardSource(interleaveTranslation(request.blocks, reply), original));
          }).catch(error => { if (!this.controller?.signal.aborted) new Notice(`翻译失败：${String(error)}`); }).finally(() => { retry.disabled = false; });
        } catch (error) { new Notice(String(error)); }
      });
      action("type", "转为普通文字", () => replace(this.range.markdown));
      shell.body.addEventListener("click", event => {
        if ((event.target as HTMLElement).closest("a, button, input")) return;
        view.dispatch({ effects: toggleSource.of(this.range.from), selection: { anchor: view.state.doc.lineAt(this.range.from).to + 1 } });
        view.focus();
      });
      this.component = new Component(); this.component.load();
      void MarkdownRenderer.render(this.plugin.app, this.range.markdown, shell.body, this.plugin.app.workspace.getActiveFile()?.path || "", this.component)
        .then(() => view.requestMeasure()).catch(() => { shell.body.textContent = this.range.markdown; });
    }
    return root;
  }
  destroy(): void { this.controller?.abort(); this.component?.unload(); }
  ignoreEvent(): boolean { return true; }
}

export function registerTranslationCards(plugin: SimplePlugin): void {
  plugin.registerMarkdownCodeBlockProcessor("simple-translation", (source, element, context) => {
    const shell = cardShell(element);
    const child = new MarkdownRenderChild(shell.host); context.addChild(child);
    return MarkdownRenderer.render(plugin.app, cardContent(source).markdown, shell.body, context.sourcePath, child);
  });
  const field = StateField.define<{ expanded: Set<number>; decorations: DecorationSet }>({
    create: state => build(state, new Set()),
    update(value, transaction) {
      const expanded = new Set([...value.expanded].map(pos => transaction.changes.mapPos(pos)));
      let toggled = false;
      for (const effect of transaction.effects) if (effect.is(toggleSource)) {
        if (expanded.has(effect.value)) expanded.delete(effect.value); else expanded.add(effect.value);
        toggled = true;
      }
      return transaction.docChanged || toggled ? build(transaction.state, expanded) : value;
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
  function build(state: EditorState, expanded: Set<number>) {
    const ranges = translationCardRanges(state);
    return { expanded, decorations: Decoration.set(ranges.map(range => expanded.has(range.from)
      ? Decoration.widget({ widget: new SavedCard(plugin, range, true), block: true, side: -1 }).range(range.from)
      : Decoration.replace({ widget: new SavedCard(plugin, range, false), block: true }).range(range.from, range.to))) };
  }
  plugin.registerEditorExtension(field);
}
