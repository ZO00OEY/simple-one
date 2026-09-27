import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Component, MarkdownRenderChild, MarkdownRenderer, MarkdownView, Notice, TFile, addIcon, setIcon, setTooltip } from "obsidian";
import type SimplePlugin from "../main";
import type { QuickFormatMode } from "../types";
import { DEFAULT_COLUMNS_HOTKEY } from "../shared/commandHotkey";
import { formatSelection, isHeadingMode, setQuickFormatColumnTarget } from "./quickFormat";

type Columns = { widths: number[]; content: string[] };
type Block = { from: number; to: number; source: string; columns: Columns };
const FENCE = "```simple-columns";
const COLUMN_DRAG_ICON = "simple-columns-drag-bars";
addIcon(COLUMN_DRAG_ICON, '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"><path d="M20 32h60M20 50h60M20 68h60"/></g>');

function widths(count: number): number[] {
  const base = Math.floor(100 / count);
  return Array.from({ length: count }, (_, index) => base + (index < 100 % count ? 1 : 0));
}

function widthsWithAddedColumn(current: number[], side: "left" | "right"): number[] {
  const added = Math.round(100 / (current.length + 1));
  const available = 100 - added;
  const scaled = current.map((value) => value * available / 100);
  const adjusted = scaled.map((value) => Math.max(10, Math.floor(value)));
  let remaining = available - adjusted.reduce((sum, value) => sum + value, 0);
  while (remaining !== 0) {
    const candidates = adjusted.map((value, index) => ({ index, error: scaled[index] - value })).filter(({ index }) => remaining > 0 || adjusted[index] > 10);
    candidates.sort((a, b) => remaining > 0 ? b.error - a.error : a.error - b.error);
    adjusted[candidates[0].index] += remaining > 0 ? 1 : -1;
    remaining += remaining > 0 ? -1 : 1;
  }
  return side === "left" ? [added, ...adjusted] : [...adjusted, added];
}

function parse(source: string): Columns | null {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const match = /^widths: ([\d:]+)$/.exec(lines[0] || "");
  if (!match) return null;
  const sizes = match[1].split(":").map(Number);
  const raw = lines.slice(1).join("\n").split(/^---column---$/m);
  const content = raw.map((part, index) => {
    const start = index && part.startsWith("\n") ? 1 : 0;
    const end = index < raw.length - 1 && part.endsWith("\n") ? part.length - 1 : part.length;
    return part.slice(start, end);
  });
  if (content.length < 2 || content.length > 4 || sizes.length !== content.length || sizes.some((n) => !Number.isFinite(n) || n < 10) || sizes.reduce((a, b) => a + b, 0) !== 100) return null;
  return { widths: sizes, content };
}

function serialize(columns: Columns): string {
  return `${FENCE}\nwidths: ${columns.widths.join(":")}\n${columns.content.join("\n---column---\n")}\n\`\`\``;
}

function removeColumn(columns: Columns, index: number): { remaining: string; extracted: string } {
  const content = columns.content.filter((_, number) => number !== index);
  const extracted = columns.content[index];
  if (content.length === 1) return { remaining: content[0].replace(/^\n+|\n+$/g, ""), extracted };
  const original = columns.widths.filter((_, number) => number !== index);
  const total = original.reduce((sum, width) => sum + width, 0);
  const scaled = original.map((width) => Math.floor(width * 100 / total));
  let rest = 100 - scaled.reduce((sum, width) => sum + width, 0);
  for (let number = 0; rest > 0; number = (number + 1) % scaled.length, rest--) scaled[number]++;
  return { remaining: serialize({ widths: scaled, content }), extracted };
}

function moveColumnInDocument(source: string, from: number, to: number, columns: Columns, index: number, target: number | null, side: "left" | "right"): string {
  const { remaining, extracted } = removeColumn(columns, index);
  const without = source.slice(0, from) + remaining + source.slice(to);
  if (target === null) return without;
  const at = Math.max(0, Math.min(without.length, target <= from ? target : target >= to ? target + remaining.length - (to - from) : from + remaining.length));
  const block = serialize({ widths: widths(2), content: side === "left" ? [extracted, ""] : ["", extracted] });
  const before = at ? "\n".repeat(Math.max(0, 2 - (/\n*$/.exec(without.slice(0, at))?.[0].length || 0))) : "";
  const after = at < without.length ? "\n".repeat(Math.max(0, 2 - (/^\n*/.exec(without.slice(at))?.[0].length || 0))) : "";
  const next = without.slice(0, at) + before + block + after + without.slice(at);
  return next + terminalColumnsLineSuffix(next);
}

function findBlocks(doc: string): Block[] {
  const blocks: Block[] = [];
  const regex = /^```simple-columns\n([\s\S]*?)^```[ \t]*(?:\n|$)/gm;
  for (const match of doc.matchAll(regex)) {
    const columns = parse(match[1].replace(/\n$/, ""));
    if (columns) blocks.push({ from: match.index, to: match.index + match[0].trimEnd().length, source: match[0].trimEnd(), columns });
  }
  return blocks;
}

function terminalColumnsLineSuffix(source: string): string {
  const last = findBlocks(source).at(-1);
  if (!last) return "";
  const trailing = source.slice(last.to);
  return /^\n?$/.test(trailing) ? "\n".repeat(2 - trailing.length) : "";
}

type ActiveBlock = {
  index: number;
  part: number;
  parts: string[];
  holder: HTMLElement;
  textarea: HTMLTextAreaElement;
  leading: string;
  trailing: string;
};

type NativeTextDrag = { view: EditorView; from: number; to: number; selected: string };
let nativeTextDrag: NativeTextDrag | null = null;

function dragRemovalRange(drag: NativeTextDrag): { from: number; to: number } | null {
  const doc = drag.view.state.doc;
  if (doc.sliceString(drag.from, drag.to) !== drag.selected) return null;
  let { from, to } = drag;
  const first = doc.lineAt(from);
  const last = doc.lineAt(Math.max(from, to - 1));
  const prefix = doc.sliceString(first.from, from);
  const suffix = to <= last.to ? doc.sliceString(to, last.to) : "";
  if ((prefix.trim() === "" || /^\s*(?:#{1,6}|[-*+]|>)\s*$/.test(prefix)) && !suffix.trim()) {
    from = first.from;
    to = Math.min(doc.length, last.to + 1);
  }
  return { from, to };
}

function editableParts(source: string): string[] {
  if (!source) return [""];
  const lines = source.split("\n");
  const parts: string[] = [];
  let current = "";
  let fence = "";
  lines.forEach((text, index) => {
    const line = text + (index < lines.length - 1 ? "\n" : "");
    if (!line) return;
    if (!fence && !text.trim()) {
      if (current) { parts.push(current); current = ""; }
      parts.push(line);
      return;
    }
    const heading = !fence && /^#{1,6}\s/.test(text);
    const image = !fence && isImageLine(text);
    if ((heading || image) && current.trim()) { parts.push(current); current = ""; }
    current += line;
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1] || "";
    if (fence) {
      if (marker.startsWith(fence[0]) && marker.length >= fence.length) { fence = ""; parts.push(current); current = ""; }
    } else if (marker) {
      fence = marker;
    } else if (heading || image) {
      parts.push(current);
      current = "";
    }
  });
  if (current || !parts.length) parts.push(current);
  if (source.endsWith("\n")) parts.push("");
  return parts;
}

function columnMarkdownStyle(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const heading = /^(#{1,6})([ \t]+)/.exec(line.text);
    if (heading) {
      ranges.push(Decoration.line({ attributes: { class: `simple-columns-live-heading simple-columns-live-h${heading[1].length}` } }).range(line.from));
      ranges.push(Decoration.mark({ class: "simple-columns-live-markup" }).range(line.from, line.from + heading[0].length));
    }
    const quote = /^(\s*>[ \t]?)/.exec(line.text);
    if (quote) {
      ranges.push(Decoration.line({ attributes: { class: "simple-columns-live-quote" } }).range(line.from));
      ranges.push(Decoration.mark({ class: "simple-columns-live-markup" }).range(line.from, line.from + quote[0].length));
      const callout = /^\[![\w-]+\]/.exec(line.text.slice(quote[0].length));
      if (callout) ranges.push(Decoration.mark({ class: "simple-columns-live-callout" }).range(line.from + quote[0].length, line.from + quote[0].length + callout[0].length));
    }
    for (const match of line.text.matchAll(/\*\*([^*]+)\*\*/g)) {
      const from = line.from + match.index;
      ranges.push(Decoration.mark({ class: "simple-columns-live-markup" }).range(from, from + 2));
      ranges.push(Decoration.mark({ class: "simple-columns-live-strong" }).range(from + 2, from + 2 + match[1].length));
      ranges.push(Decoration.mark({ class: "simple-columns-live-markup" }).range(from + match[0].length - 2, from + match[0].length));
    }
    for (const match of line.text.matchAll(/==([^=]+)==/g)) {
      const from = line.from + match.index;
      ranges.push(Decoration.mark({ class: "simple-columns-live-markup" }).range(from, from + 2));
      ranges.push(Decoration.mark({ class: "simple-columns-live-highlight" }).range(from + 2, from + 2 + match[1].length));
      ranges.push(Decoration.mark({ class: "simple-columns-live-markup" }).range(from + match[0].length - 2, from + match[0].length));
    }
  }
  return Decoration.set(ranges, true);
}

const columnMarkdownStyleField = StateField.define<DecorationSet>({
  create: columnMarkdownStyle,
  update: (value, transaction) => transaction.docChanged ? columnMarkdownStyle(transaction.state) : value,
  provide: (field) => EditorView.decorations.from(field),
});

const COLUMN_FORMAT_COMMANDS = [
  "editor:toggle-bold", "editor:toggle-italics", "editor:toggle-strikethrough",
  "editor:toggle-highlight", "editor:toggle-code", "editor:toggle-inline-math",
  "editor:set-heading-0", "editor:set-heading-1", "editor:set-heading-2",
  "editor:set-heading-3", "editor:set-heading-4", "editor:set-heading-5",
  "editor:set-heading-6", "editor:toggle-blockquote", "editor:insert-callout",
] as const;
let activeColumnCommandTarget: { apply: (command: string) => void; hasFocus: () => boolean } | null = null;

function isImageLine(source: string): boolean {
  return /^\s*!(?:\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\))\s*$/.test(source.trim());
}

function imageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i.test(file.name));
}

function imageFilename(file: File): string {
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const name = /\.[a-z0-9]+$/i.test(file.name) ? file.name : `image-${Date.now()}.${extension}`;
  return name.replace(/[\\/:*?"<>|]/g, "-");
}

const columnSourceParts = new WeakMap<HTMLElement, string[]>();

function selectedColumnMarkdown(body: HTMLElement): string | null {
  const selection = body.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const parts = columnSourceParts.get(body);
  if (!parts) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(body)) return null;
  const selected = Array.from(body.querySelectorAll<HTMLElement>(".simple-columns-edit-block"))
    .filter((holder) => range.intersectsNode(holder))
    .map((holder) => parts[Number(holder.dataset.part)] || "");
  return selected.join("").replace(/^\n+|\n+$/g, "") || null;
}

function targetAt(view: EditorView, y: number): { from: number; to: number; text: string; columns?: Columns } | null {
  const body = view.contentDOM.getBoundingClientRect();
  const blocks = findBlocks(view.state.doc.toString());
  for (const element of Array.from(view.dom.querySelectorAll<HTMLElement>(".simple-columns"))) {
    const rect = element.getBoundingClientRect();
    if (y < rect.top || y > rect.bottom) continue;
    const position = element.dataset.columnsFrom
      ? Number(element.dataset.columnsFrom)
      : view.posAtCoords({ x: body.left + 8, y: rect.top + Math.min(10, rect.height / 2) });
    const block = blocks.find((item) => position !== null && position >= item.from && position <= item.to);
    if (block) return { from: block.from, to: block.to, text: block.source, columns: block.columns };
  }
  const end = view.coordsAtPos(view.state.doc.length);
  if (end && y > end.bottom + 8) return { from: view.state.doc.length, to: view.state.doc.length, text: "" };
  const position = view.posAtCoords({ x: Math.max(body.left + 8, Math.min(body.right - 8, body.left + body.width / 2)), y });
  if (position === null) return null;
  const line = view.state.doc.lineAt(position);
  if (/^\s*(```|~~~)/.test(line.text)) return null;
  return { from: line.from, to: line.to, text: line.text };
}

function relocateInEditor(view: EditorView, from: number, expectedSource: string, value: Columns, index: number, point: { x: number; y: number }, remove: boolean, side: "left" | "right", root: HTMLElement): void {
  const source = view.state.doc.toString();
  const current = findBlocks(source).find((block) => block.from === from);
  if (!current || current.source !== expectedSource && JSON.stringify(current.columns) !== JSON.stringify(value)) {
    new Notice("列组已变化，请重新拖动");
    return;
  }
  const target = remove ? null : targetAt(view, point.y);
  if (!remove && !target) { new Notice("无法定位放置位置，请重新拖动"); return; }
  const targetPosition = target && target.from >= current.from && target.from < current.to
    ? point.y < root.getBoundingClientRect().top ? current.from : current.to
    : target?.from ?? null;
  const next = moveColumnInDocument(source, current.from, current.to, value, index, targetPosition, side);
  let prefix = 0, suffix = 0;
  while (prefix < source.length && prefix < next.length && source[prefix] === next[prefix]) prefix++;
  while (suffix < source.length - prefix && suffix < next.length - prefix && source[source.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  view.dispatch({ changes: { from: prefix, to: source.length - suffix, insert: next.slice(prefix, next.length - suffix) } });
}

class ColumnsSurface {
  private renderComponent: Component | null = null;
  private draft: Columns;
  private active: ActiveBlock | null = null;
  private columnEditor: { index: number; view: EditorView } | null = null;
  private dirty = false;
  private formatMenuOpen = false;
  private releaseFormatTarget: (() => void) | null = null;
  private releaseCommandTarget: (() => void) | null = null;
  private shortcutCapture: ((event: KeyboardEvent) => void) | null = null;
  private pasteCapture: ((event: ClipboardEvent) => void) | null = null;
  private pendingImages = 0;
  private renderVersion = new WeakMap<HTMLElement, number>();
  private stageCleanup: (() => void) | null = null;
  constructor(private plugin: SimplePlugin, private sourcePath: string, columns: Columns, private root: HTMLElement, private save: (value: Columns, drag?: NativeTextDrag) => void, private relocate?: (value: Columns, index: number, point: { x: number; y: number }, remove: boolean, side: "left" | "right") => void) {
    this.draft = { widths: [...columns.widths], content: [...columns.content] };
    this.render();
  }

  private render(): void {
    this.renderComponent?.unload();
    this.renderComponent = new Component();
    this.renderComponent.load();
    this.stageCleanup?.();
    if (this.columnEditor) {
      this.releaseFormatTarget?.();
      this.releaseFormatTarget = null;
      this.releaseCommandTarget?.();
      this.releaseCommandTarget = null;
      this.draft.content[this.columnEditor.index] = this.columnEditor.view.state.doc.toString();
      this.columnEditor.view.destroy();
      this.columnEditor = null;
    }
    this.root.empty();
    this.root.addClass("simple-columns");
    const toolbar = this.root.createDiv({ cls: "simple-columns-toolbar" });
    const atColumnLimit = this.draft.content.length >= 4;
    const addColumn = toolbar.createEl("button", { cls: "simple-columns-add-column", attr: { title: atColumnLimit ? "最多四列" : "在右侧添加一列", "aria-label": atColumnLimit ? "最多四列" : "在右侧添加一列" } });
    setIcon(addColumn, "plus");
    addColumn.classList.toggle("is-at-limit", atColumnLimit);
    addColumn.addEventListener("pointerdown", (event) => event.preventDefault());
    addColumn.addEventListener("click", () => {
      if (atColumnLimit) {
        new Notice("双列视图最多支持四列");
        return;
      }
      this.commitActive(false);
      this.draft.widths = widthsWithAddedColumn(this.draft.widths, "right");
      this.draft.content.push("");
      this.persist();
      this.render();
    });
    const layout = this.root.createDiv({ cls: "simple-columns-editor" });
    layout.style.gridTemplateColumns = this.draft.widths.map((n) => `minmax(0, ${n}fr)`).join(" 8px ");
    this.draft.content.forEach((content, index) => {
      if (index) this.addDivider(layout, index);
      const column = layout.createDiv({ cls: "simple-columns-editor-column" });
      const body = column.createDiv({ cls: "simple-columns-editor-body markdown-rendered" });
      const handle = column.createEl("button", { cls: "simple-columns-move-handle", attr: { type: "button", title: "列拖拽把手" } });
      setIcon(handle, COLUMN_DRAG_ICON);
      setTooltip(handle, `拖拽第 ${index + 1} 列，可左右调整或删除`);
      column.prepend(handle);
      this.addReorderHandle(handle, column, layout, index);
      const parts = editableParts(content);
      columnSourceParts.set(body, parts);
      body.addEventListener("dragstart", (event) => {
        if (this.columnEditor?.index === index) return;
        if (event.target instanceof HTMLTextAreaElement) return;
        const markdown = selectedColumnMarkdown(body);
        if (!markdown || !event.dataTransfer) return;
        event.dataTransfer.clearData();
        event.dataTransfer.setData("text/plain", markdown);
        event.dataTransfer.setData("text/markdown", markdown);
        event.dataTransfer.effectAllowed = "copy";
        event.stopPropagation();
      });
      body.addEventListener("dragover", (event) => {
        if (this.columnEditor?.index === index) return;
        if (imageFiles(event.dataTransfer?.files || []).length) {
          event.preventDefault();
          event.dataTransfer!.dropEffect = "copy";
          return;
        }
        if (event.target instanceof HTMLTextAreaElement || !event.dataTransfer?.types.includes("text/plain")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = nativeTextDrag ? "move" : "copy";
      });
      body.addEventListener("drop", (event) => {
        if (this.columnEditor?.index === index) return;
        const images = imageFiles(event.dataTransfer?.files || []);
        if (images.length) {
          event.preventDefault();
          event.stopPropagation();
          const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".simple-columns-edit-block") : null;
          const part = target ? Number(target.dataset.part) : parts.length - 1;
          const holder = body.querySelector<HTMLElement>(`.simple-columns-edit-block[data-part="${part}"]`);
          if (holder) {
            this.editBlock(index, part, parts, holder);
            void this.insertImages(images, !(event.target instanceof HTMLTextAreaElement));
          }
          return;
        }
        if (event.target instanceof HTMLTextAreaElement) return;
        const dropped = event.dataTransfer?.getData("text/plain");
        if (!dropped) return;
        event.preventDefault();
        event.stopPropagation();
        this.commitActive(false);
        const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".simple-columns-edit-block") : null;
        const part = target ? Number(target.dataset.part) : parts.length - 1;
        const drag = nativeTextDrag;
        const matches = drag && (drag.selected.trim() === dropped.trim() ||
          drag.selected.replace(/^\s*(?:#{1,6}|[-*+]|>)\s*/gm, "").trim() === dropped.trim());
        const range = matches && drag ? dragRemovalRange(drag) : null;
        const source = range && drag ? drag : undefined;
        const incoming = (range && source ? source.view.state.doc.sliceString(range.from, range.to) : dropped).replace(/^\n+|\n+$/g, "");
        const trailing = /\n*$/.exec(parts[part])?.[0] || "";
        const existing = parts[part].slice(0, parts[part].length - trailing.length);
        parts[part] = `${existing}${existing ? "\n" : ""}${incoming}${trailing}`;
        if (part < parts.length - 1 && !parts[part].endsWith("\n") && !parts[part + 1].startsWith("\n")) parts[part] += "\n";
        this.draft.content[index] = parts.join("");
        this.dirty = true;
        const holder = body.querySelector<HTMLElement>(`.simple-columns-edit-block[data-part="${part}"]`);
        if (holder) this.renderBlock(holder, parts[part]);
        nativeTextDrag = null;
        this.persist(source);
      });
      parts.forEach((part, number) => {
        const holder = body.createDiv({ cls: "simple-columns-edit-block", attr: { tabindex: "0", role: "button", "data-part": String(number), "aria-label": `编辑第 ${index + 1} 列的段落` } });
        holder.classList.toggle("is-terminal-line", number === parts.length - 1 && part === "" && content.endsWith("\n"));
        this.renderBlock(holder, part);
        holder.addEventListener("mouseup", () => {
          const selection = holder.ownerDocument.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
          const range = selection.getRangeAt(0);
          if (!holder.contains(range.startContainer) || !holder.contains(range.endContainer)) return;
          const selected = selection.toString();
          if (!selected) return;
          const offset = part.indexOf(selected);
          if (offset < 0) return;
          const start = parts.slice(0, number).join("").length + offset;
          window.setTimeout(() => {
            if (!holder.isConnected || this.columnEditor?.index === index) return;
            holder.ownerDocument.getSelection()?.removeAllRanges();
            this.editColumn(index, start, start + selected.length);
          }, 0);
        });
        holder.addEventListener("click", (event) => {
          if (event.ctrlKey || event.metaKey) return;
          if (event.target instanceof Element && event.target.closest(".simple-columns-image-zoom, .simple-columns-image-preview img, a")) return;
          if (event.target instanceof Element && event.target.closest(".simple-columns-image-edit")) {
            this.editBlock(index, number, parts, holder);
            return;
          }
          const selection = holder.ownerDocument.getSelection();
          if (selection && !selection.isCollapsed && selection.containsNode(holder, true)) return;
          this.editColumn(index, parts.slice(0, number).join("").length);
        });
        holder.addEventListener("keydown", (event) => {
          if (event.target !== holder || event.key !== "Enter") return;
          event.preventDefault();
          this.editColumn(index, parts.slice(0, number).join("").length);
        });
      });
      column.addEventListener("click", (event) => {
        if (event.target !== column && event.target !== body) return;
        const holders = Array.from(body.querySelectorAll<HTMLElement>(".simple-columns-edit-block"));
        const last = holders[holders.length - 1];
        if (last && event.clientY > last.getBoundingClientRect().bottom) return this.editColumn(index, this.draft.content[index].length);
        const nearest = holders.reduce<HTMLElement | null>((closest, holder) => {
          if (!closest) return holder;
          const distance = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            return Math.max(rect.top - event.clientY, event.clientY - rect.bottom, 0);
          };
          return distance(holder) < distance(closest) ? holder : closest;
        }, null);
        const part = nearest ? Number(nearest.dataset.part) : 0;
        this.editColumn(index, parts.slice(0, part).join("").length);
      });
    });

  }

  getValue(): Columns {
    this.commitActive(false);
    if (this.columnEditor) this.draft.content[this.columnEditor.index] = this.columnEditor.view.state.doc.toString();
    return { widths: [...this.draft.widths], content: [...this.draft.content] };
  }

  private editColumn(index: number, position: number, endPosition = position): void {
    this.commitActive(true);
    if (this.columnEditor?.index === index) {
      const view = this.columnEditor.view;
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length), head: Math.min(endPosition, view.state.doc.length) }, scrollIntoView: true });
      return;
    }
    if (this.columnEditor) this.finishColumnEdit();
    const body = this.root.querySelectorAll<HTMLElement>(".simple-columns-editor-body")[index];
    if (!body) return;
    body.empty();
    body.removeClass("markdown-rendered");
    body.addClass("is-editing-column");
    const view = new EditorView({
      parent: body,
      doc: this.draft.content[index],
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        EditorView.lineWrapping,
        columnMarkdownStyleField,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          this.draft.content[index] = update.state.doc.toString();
          this.dirty = true;
        }),
        EditorView.domEventHandlers({
          paste: (event) => {
            const images = imageFiles(event.clipboardData?.files || []);
            if (!images.length) return false;
            event.preventDefault();
            void this.insertColumnImages(index, images);
            return true;
          },
        }),
      ],
    });
    this.columnEditor = { index, view };
    this.releaseFormatTarget = setQuickFormatColumnTarget({
      apply: (mode) => this.formatColumnSelection(mode),
      hold: (value) => {
        this.formatMenuOpen = value;
        if (!value && this.columnEditor?.view === view && !view.hasFocus) this.finishColumnEdit();
      },
    });
    const commandTarget = { apply: (command: string) => this.applyColumnCommand(command, view), hasFocus: () => view.dom.isConnected };
    activeColumnCommandTarget = commandTarget;
    this.releaseCommandTarget = () => { if (activeColumnCommandTarget === commandTarget) activeColumnCommandTarget = null; };
    view.dom.addEventListener("focusout", () => window.setTimeout(() => {
      if (this.columnEditor?.view === view && !view.hasFocus && !this.formatMenuOpen && !this.pendingImages) this.finishColumnEdit();
    }, 0));
    view.focus();
    view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length), head: Math.min(endPosition, view.state.doc.length) }, scrollIntoView: true });
  }

  private finishColumnEdit(): void {
    if (!this.columnEditor) return;
    this.releaseFormatTarget?.();
    this.releaseFormatTarget = null;
    this.releaseCommandTarget?.();
    this.releaseCommandTarget = null;
    this.draft.content[this.columnEditor.index] = this.columnEditor.view.state.doc.toString();
    this.columnEditor.view.destroy();
    this.columnEditor = null;
    if (this.dirty) this.persist();
    if (this.root.isConnected) this.render();
  }

  private async insertColumnImages(index: number, images: File[]): Promise<void> {
    const view = this.columnEditor?.index === index ? this.columnEditor.view : null;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    this.pendingImages++;
    try {
      const links: string[] = [];
      for (const image of images) {
        const path = await this.plugin.app.fileManager.getAvailablePathForAttachment(imageFilename(image), this.sourcePath);
        const attachment = await this.plugin.app.vault.createBinary(path, await image.arrayBuffer());
        const link = this.plugin.app.fileManager.generateMarkdownLink(attachment, this.sourcePath);
        links.push(link.startsWith("!") ? link : `!${link}`);
      }
      if (this.columnEditor?.view === view) view.dispatch({ changes: { from, to, insert: links.join("\n") } });
    } catch (error) {
      new Notice(`插入图片失败：${String(error)}`);
    } finally {
      this.pendingImages--;
      if (!this.pendingImages && this.columnEditor?.view === view && !view.hasFocus) this.finishColumnEdit();
    }
  }

  private addReorderHandle(handle: HTMLElement, column: HTMLElement, layout: HTMLElement, index: number): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, y: event.clientY };
      let destination = index;
      let mode: "reorder" | "split" | "delete" = "reorder";
      let shownMode: "reorder" | "split" | "delete" | null = null;
      let moved = false;
      const columns = Array.from(layout.querySelectorAll<HTMLElement>(".simple-columns-editor-column"));
      const bounds = columns.map((item) => item.getBoundingClientRect());
      const marker = layout.createDiv({ cls: "simple-columns-reorder-marker" });
      const layoutLeft = layout.getBoundingClientRect().left;
      const preview = handle.ownerDocument.body.createDiv({ cls: "simple-columns-stage simple-columns-drag-preview" });
      const previewGrid = preview.createDiv({ cls: "simple-columns-stage-grid" });
      previewGrid.createDiv({ cls: "simple-columns-stage-preview", text: this.draft.content[index].trim().slice(0, 90) || "空白列" });
      previewGrid.createDiv({ cls: "simple-columns-stage-empty" });
      const previewStatus = preview.createEl("small", { cls: "simple-columns-stage-status" });
      preview.setAttribute("aria-hidden", "true");
      const content = this.root.closest<HTMLElement>(".cm-content") || this.root.closest<HTMLElement>(".markdown-preview-view")?.querySelector<HTMLElement>(".markdown-preview-sizer") || layout;
      const viewport = this.root.closest<HTMLElement>(".markdown-source-view")?.querySelector<HTMLElement>(".cm-scroller") || this.root.closest<HTMLElement>(".markdown-preview-view") || content;
      const editor = this.root.closest<HTMLElement>(".cm-editor");
      const view = editor ? EditorView.findFromDOM(editor) : null;
      const caret = handle.ownerDocument.body.createDiv({ cls: "simple-columns-insert-caret" });
      caret.createSpan({ text: "插入到此行" });
      column.addClass("simple-columns-dragging");
      const move = (next: PointerEvent) => {
        const x = next.clientX;
        const y = next.clientY;
        moved ||= Math.hypot(x - start.x, y - start.y) > 5;
        if (!moved) return;
        const group = layout.getBoundingClientRect();
        const body = content.getBoundingClientRect();
        const visible = viewport.getBoundingClientRect();
        const insideGroup = x >= group.left && x <= group.right && y >= group.top && y <= group.bottom;
        const insideBody = x >= body.left && x <= body.right && y >= visible.top && y <= visible.bottom;
        mode = insideGroup ? "reorder" : insideBody ? "split" : "delete";
        const target = mode === "split" && view ? targetAt(view, y) : null;
        caret.style.display = mode === "split" && (!view || !!target) ? "block" : "none";
        if (caret.style.display === "block") {
          const targetGroup = target?.columns && Array.from(view!.dom.querySelectorAll<HTMLElement>(".simple-columns"))
            .find((element) => Number(element.dataset.columnsFrom) === target.from);
          const rect = targetGroup?.getBoundingClientRect();
          const coords = target && view?.coordsAtPos(target.from);
          const hovered = handle.ownerDocument.elementFromPoint(x, y) as HTMLElement | null;
          const fallback = hovered?.getBoundingClientRect();
          caret.style.left = `${body.left + 2}px`;
          caret.style.top = `${rect?.top ?? coords?.top ?? fallback?.top ?? y}px`;
          caret.style.height = `${rect?.height ?? Math.max(22, (coords?.bottom ?? fallback?.bottom ?? y + 22) - (coords?.top ?? fallback?.top ?? y))}px`;
          caret.firstElementChild!.textContent = target?.columns ? "插入到此列组" : "插入到此行";
        }
        preview.addClass("is-visible");
        preview.classList.toggle("is-delete", mode === "delete");
        preview.style.left = `${Math.max(4, Math.min(x + 5, handle.ownerDocument.documentElement.clientWidth - 230))}px`;
        preview.style.top = `${Math.max(4, Math.min(y + 5, handle.ownerDocument.documentElement.clientHeight - 100))}px`;
        if (mode !== shownMode) {
          previewStatus.textContent = mode === "delete" ? "释放即删除" : mode === "split" ? "释放后选择插入位置" : "释放后调整顺序";
          shownMode = mode;
        }
        column.classList.toggle("simple-columns-delete-target", mode === "delete");
        if (mode !== "reorder") {
          marker.removeClass("is-visible");
          columns.forEach((item) => { item.style.removeProperty("transform"); });
          return;
        }
        destination = bounds.findIndex((rect) => x < rect.right);
        if (destination < 0) destination = columns.length - 1;
        columns.forEach((item, number) => {
          let offset = 0;
          if (number === index) offset = x - start.x;
          else if (destination > index && number > index && number <= destination) offset = bounds[number - 1].left - bounds[number].left;
          else if (destination < index && number >= destination && number < index) offset = bounds[number + 1].left - bounds[number].left;
          item.style.transform = offset ? `translateX(${offset}px)` : "";
        });
        marker.style.left = `${bounds[destination].left - layoutLeft}px`;
        marker.style.width = `${bounds[destination].width}px`;
        marker.toggleClass("is-visible", destination !== index);
      };
      handle.addEventListener("pointermove", move);
      const stop = (up: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        marker.remove();
        preview.remove();
        caret.remove();
        column.removeClass("simple-columns-dragging");
        column.removeClass("simple-columns-delete-target");
        columns.forEach((item) => { item.style.removeProperty("transform"); });
        if (up.type === "pointercancel" || !moved) return;
        if (mode !== "reorder") {
          if (mode === "delete") this.relocate?.(this.getValue(), index, { x: up.clientX, y: up.clientY }, true, "left");
          else this.showColumnStage(index, { x: up.clientX, y: up.clientY });
          return;
        }
        if (destination === index) return;
        const content = this.draft.content.splice(index, 1)[0];
        const width = this.draft.widths.splice(index, 1)[0];
        this.draft.content.splice(destination, 0, content);
        this.draft.widths.splice(destination, 0, width);
        this.persist();
        this.render();
      };
      handle.addEventListener("pointerup", stop, { once: true });
      handle.addEventListener("pointercancel", stop, { once: true });
    });
  }

  private showColumnStage(index: number, point: { x: number; y: number }): void {
    this.stageCleanup?.();
    const doc = this.root.ownerDocument;
    const card = doc.body.createDiv({ cls: "simple-columns-stage" });
    card.setAttribute("title", "移动到目标行，左键插入左侧，右键插入右侧；Esc 取消");
    const grid = card.createDiv({ cls: "simple-columns-stage-grid" });
    grid.createDiv({ cls: "simple-columns-stage-preview", text: this.draft.content[index].trim().slice(0, 90) || "空白列" });
    grid.createDiv({ cls: "simple-columns-stage-empty" });
    card.createEl("small", { cls: "simple-columns-stage-status", text: "左键点击插入左侧，右键点击插入右侧" });
    const caret = doc.body.createDiv({ cls: "simple-columns-insert-caret" });
    caret.createSpan({ text: "插入到此行" });
    const content = this.root.closest<HTMLElement>(".cm-content") || this.root.closest<HTMLElement>(".markdown-preview-view")?.querySelector<HTMLElement>(".markdown-preview-sizer") || this.root;
    const viewport = this.root.closest<HTMLElement>(".markdown-source-view")?.querySelector<HTMLElement>(".cm-scroller") || this.root.closest<HTMLElement>(".markdown-preview-view") || content;
    const editor = this.root.closest<HTMLElement>(".cm-editor");
    const view = editor ? EditorView.findFromDOM(editor) : null;
    const cleanup = (right = false) => {
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("mousedown", down, true);
      doc.removeEventListener("keydown", key, true);
      if (right) window.setTimeout(() => doc.removeEventListener("contextmenu", menu, true), 800);
      else doc.removeEventListener("contextmenu", menu, true);
      card.remove();
      caret.remove();
      if (this.stageCleanup === cancel) this.stageCleanup = null;
    };
    const cancel = () => cleanup();
    const move = (event: MouseEvent) => {
      if (!this.root.isConnected) { cleanup(); return; }
      card.style.left = `${Math.max(4, Math.min(event.clientX + 5, doc.documentElement.clientWidth - 230))}px`;
      card.style.top = `${Math.max(4, Math.min(event.clientY + 5, doc.documentElement.clientHeight - 100))}px`;
      const bounds = content.getBoundingClientRect();
      const visible = viewport.getBoundingClientRect();
      const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= visible.top && event.clientY <= visible.bottom;
      const target = inside && view ? targetAt(view, event.clientY) : null;
      card.classList.toggle("simple-columns-stage-ready", inside && (!view || !!target));
      caret.style.display = inside && (!view || !!target) ? "block" : "none";
      if (!inside) return;
      const group = target?.columns && Array.from(view!.dom.querySelectorAll<HTMLElement>(".simple-columns"))
        .find((element) => Number(element.dataset.columnsFrom) === target.from);
      const rect = group?.getBoundingClientRect();
      const coords = target && view?.coordsAtPos(target.from);
      const hovered = doc.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const fallback = hovered?.getBoundingClientRect();
      caret.style.left = `${bounds.left + 2}px`;
      caret.style.top = `${rect?.top ?? coords?.top ?? fallback?.top ?? event.clientY}px`;
      caret.style.height = `${rect?.height ?? Math.max(22, (coords?.bottom ?? fallback?.bottom ?? event.clientY + 22) - (coords?.top ?? fallback?.top ?? event.clientY))}px`;
      caret.firstElementChild!.textContent = target?.columns ? "插入到此列组" : "插入到此行";
    };
    const down = (event: MouseEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      const bounds = content.getBoundingClientRect();
      const visible = viewport.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < visible.top || event.clientY > visible.bottom) return;
      if (view && !targetAt(view, event.clientY)) return;
      event.preventDefault();
      event.stopPropagation();
      const side = event.button === 0 ? "left" : "right";
      cleanup(side === "right");
      this.relocate?.(this.getValue(), index, { x: event.clientX, y: event.clientY }, false, side);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cleanup(); } };
    const menu = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("mousedown", down, true);
    doc.addEventListener("keydown", key, true);
    doc.addEventListener("contextmenu", menu, true);
    this.stageCleanup = cancel;
    move(new MouseEvent("mousemove", { clientX: point.x, clientY: point.y }));
  }

  private addDivider(layout: HTMLElement, index: number): void {
    const divider = layout.createDiv({ cls: "simple-columns-divider", attr: { title: "拖动调整宽度", role: "separator" } });
    divider.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const start = event.clientX;
      const before = [...this.draft.widths];
      let changed = false;
      divider.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        const change = Math.round((next.clientX - start) / layout.clientWidth * 100);
        const left = Math.max(15, Math.min(before[index - 1] + before[index] - 15, before[index - 1] + change));
        this.draft.widths[index - 1] = left;
        this.draft.widths[index] = before[index - 1] + before[index] - left;
        changed = changed || left !== before[index - 1];
        layout.style.gridTemplateColumns = this.draft.widths.map((n) => `minmax(0, ${n}fr)`).join(" 8px ");
        divider.title = `${this.draft.widths[index - 1]}% : ${this.draft.widths[index]}%`;
      };
      divider.addEventListener("pointermove", move);
      const stop = (up: PointerEvent) => {
        divider.removeEventListener("pointermove", move);
        if (up.type === "pointercancel") {
          this.draft.widths = before;
          layout.style.gridTemplateColumns = before.map((n) => `minmax(0, ${n}fr)`).join(" 8px ");
          return;
        }
        if (changed || this.dirty) this.persist();
      };
      divider.addEventListener("pointerup", stop, { once: true });
      divider.addEventListener("pointercancel", stop, { once: true });
    });
  }

  private renderBlock(holder: HTMLElement, source: string): void {
    const version = (this.renderVersion.get(holder) || 0) + 1;
    this.renderVersion.set(holder, version);
    holder.empty();
    const blankLine = !source.trim() && (!!source || holder.classList.contains("is-terminal-line"));
    holder.classList.toggle("is-blank-line", blankLine);
    if (!source.trim()) {
      if (!blankLine) holder.createSpan({ cls: "simple-columns-empty-block", text: "点击编辑" });
      return;
    }
    if (isImageLine(source)) {
      this.addImagePreview(holder, source);
      const actions = holder.createDiv({ cls: "simple-columns-image-actions" });
      if (this.plugin.settings.enableImageZoom) {
        const zoom = actions.createEl("button", { cls: "simple-columns-image-zoom", attr: { title: "放大图片", "aria-label": "放大图片" } });
        setIcon(zoom, "zoom-in");
        zoom.addEventListener("pointerdown", (event) => event.stopPropagation());
      }
      const edit = actions.createEl("button", { cls: "simple-columns-image-edit", attr: { title: "编辑这个区块", "aria-label": "编辑这个区块" } });
      setIcon(edit, "code-2");
      edit.addEventListener("pointerdown", (event) => event.stopPropagation());
      return;
    }
    const rendered = holder.ownerDocument.createElement("div");
    void MarkdownRenderer.render(this.plugin.app, source, rendered, this.sourcePath, this.renderComponent!).then(() => {
      if (this.renderVersion.get(holder) !== version || !holder.isConnected) return;
      holder.replaceChildren(...Array.from(rendered.childNodes));
    });
  }

  private addImagePreview(holder: HTMLElement, source: string): HTMLElement {
    const preview = holder.createDiv({ cls: "simple-columns-image-preview" });
    this.renderImagePreview(preview, source);
    return preview;
  }

  private renderImagePreview(preview: HTMLElement, source: string): void {
    const version = (this.renderVersion.get(preview) || 0) + 1;
    this.renderVersion.set(preview, version);
    if (!isImageLine(source)) { preview.empty(); return; }
    const rendered = preview.ownerDocument.createElement("div");
    void MarkdownRenderer.render(this.plugin.app, source, rendered, this.sourcePath, this.renderComponent!).then(() => {
      if (this.renderVersion.get(preview) !== version || !preview.isConnected) return;
      preview.replaceChildren(...Array.from(rendered.childNodes));
    });
  }

  private editBlock(index: number, part: number, parts: string[], holder: HTMLElement): void {
    if (this.active?.holder === holder) return;
    this.commitActive(false);
    this.renderVersion.set(holder, (this.renderVersion.get(holder) || 0) + 1);
    const existingImagePreview = holder.querySelector<HTMLElement>(".simple-columns-image-preview");
    existingImagePreview?.remove();
    holder.empty();
    holder.removeAttribute("tabindex");
    const textarea = holder.createEl("textarea", { cls: "simple-columns-source", attr: { rows: "1", "aria-label": `第 ${index + 1} 列 Markdown 源码` } });
    const leading = !parts[part].trim() ? "" : /^\n*/.exec(parts[part])?.[0] || "";
    const body = parts[part].slice(leading.length);
    const trailing = /\n*$/.exec(body)?.[0] || "";
    textarea.value = body.slice(0, body.length - trailing.length);
    const imagePreview = isImageLine(textarea.value) ? existingImagePreview || this.addImagePreview(holder, textarea.value) : null;
    if (existingImagePreview && imagePreview) holder.appendChild(existingImagePreview);
    if (imagePreview) holder.addClass("is-editing-image");
    this.active = { index, part, parts, holder, textarea, leading, trailing };
    const update = () => {
      const next = leading + textarea.value + trailing;
      if (parts[part] !== next) this.dirty = true;
      parts[part] = next;
      this.draft.content[index] = parts.join("");
      textarea.style.removeProperty("height");
      textarea.style.height = `${textarea.scrollHeight}px`;
      if (imagePreview) this.renderImagePreview(imagePreview, textarea.value);
    };
    textarea.addEventListener("input", update);
    textarea.addEventListener("keydown", (event) => this.handleShortcut(event, textarea));
    this.pasteCapture = (event) => {
      if (!textarea.isConnected) { this.removePasteCapture(); return; }
      if (event.target !== textarea) return;
      const images = imageFiles(event.clipboardData?.files || []);
      if (!images.length) return;
      event.preventDefault();
      event.stopPropagation();
      void this.insertImages(images);
    };
    window.addEventListener("paste", this.pasteCapture, true);
    this.shortcutCapture = (event) => {
      if (!textarea.isConnected) { this.removeShortcutCapture(); return; }
      if (event.target === textarea) this.handleShortcut(event, textarea);
    };
    window.addEventListener("keydown", this.shortcutCapture, true);
    textarea.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!this.pendingImages && !textarea.matches(":focus") && this.active?.textarea === textarea) this.commitActive(true);
      }, 0);
    });
    update();
    textarea.focus();
  }

  private commitActive(save: boolean): void {
    const active = this.active;
    if (!active) return;
    active.parts[active.part] = active.leading + active.textarea.value + active.trailing;
    this.draft.content[active.index] = active.parts.join("");
    this.active = null;
    this.removeShortcutCapture();
    this.removePasteCapture();
    active.holder.setAttribute("tabindex", "0");
    active.holder.removeClass("is-editing-image");
    this.renderBlock(active.holder, active.parts[active.part]);
    if (save && this.dirty) this.persist();
  }

  private persist(drag?: NativeTextDrag): void {
    this.dirty = false;
    this.save(this.getValue(), drag);
  }

  private removeShortcutCapture(): void {
    if (!this.shortcutCapture) return;
    window.removeEventListener("keydown", this.shortcutCapture, true);
    this.shortcutCapture = null;
  }

  private removePasteCapture(): void {
    if (!this.pasteCapture) return;
    window.removeEventListener("paste", this.pasteCapture, true);
    this.pasteCapture = null;
  }

  private async insertImages(files: File[], appendBlock = false): Promise<void> {
    const active = this.active;
    if (!active || !this.sourcePath) return;
    const { textarea, parts, part, index, holder } = active;
    const marker = `simple-image-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (appendBlock) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const prefix = appendBlock && textarea.value.trim() && !textarea.value.endsWith("\n") ? "\n" : "";
    textarea.setRangeText(prefix + marker, textarea.selectionStart, textarea.selectionEnd, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    this.pendingImages++;
    const links: string[] = [];
    try {
      for (const image of files) {
        const path = await this.plugin.app.fileManager.getAvailablePathForAttachment(imageFilename(image), this.sourcePath);
        const attachment = await this.plugin.app.vault.createBinary(path, await image.arrayBuffer());
        const link = this.plugin.app.fileManager.generateMarkdownLink(attachment, this.sourcePath);
        links.push(link.startsWith("!") ? link : `!${link}`);
      }
    } catch (error) {
      new Notice(`插入图片失败：${String(error)}`);
    } finally {
      const replacement = links.join("\n");
      if (this.active?.textarea === textarea) {
        const at = textarea.value.indexOf(marker);
        if (at >= 0) textarea.setRangeText(replacement, at, at + marker.length, "end");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        this.pendingImages--;
        if (!this.pendingImages && !textarea.matches(":focus")) this.commitActive(true);
      } else {
        parts[part] = parts[part].replace(marker, replacement);
        this.draft.content[index] = parts.join("");
        this.dirty = true;
        this.pendingImages--;
        if (this.root.isConnected) {
          if (holder.isConnected) this.renderBlock(holder, parts[part]);
          this.persist();
        } else {
          const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
          if (file instanceof TFile) await this.plugin.app.vault.process(file, (text) => text.replace(marker, replacement));
        }
      }
    }
  }

  private handleShortcut(event: KeyboardEvent, textarea: HTMLTextAreaElement): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (!mod && !event.altKey && !event.shiftKey && key === "enter" && this.insertLineAfterImage(event, textarea)) return;
    if (!mod && !event.altKey && !event.shiftKey && (key === "backspace" || key === "delete") &&
      this.removeBlankLine(event, textarea, key === "backspace")) return;
    if (!mod && !event.altKey && !event.shiftKey && (key === "arrowup" || key === "arrowdown") && this.moveBetweenBlocks(event, textarea, key === "arrowup" ? -1 : 1)) return;
    if (mod && !event.altKey && key === "b") return this.wrapShortcut(event, textarea, "**");
    if (mod && !event.altKey && key === "i") return this.wrapShortcut(event, textarea, "*");
    if (mod && !event.altKey && key === "e") return this.wrapShortcut(event, textarea, "`");
    if (mod && !event.altKey && key === "k") return this.wrapShortcut(event, textarea, "[[", "]]");
    if (event.altKey && !mod && key === "k") return this.insertLink(event, textarea);
    if (event.altKey && !mod && key === "h") return this.wrapShortcut(event, textarea, "==");
    if (event.altKey && !mod && key === "d") return this.wrapShortcut(event, textarea, "~~");
    if (mod && !event.altKey && key === "\\") return this.insertCallout(event, textarea);
    if (event.altKey && !mod && /^[1-6]$/.test(key)) {
      event.preventDefault(); event.stopPropagation();
      this.setHeading(textarea, Number(key));
    }
    if (event.altKey && !mod && key === "a") {
      event.preventDefault(); event.stopPropagation();
      const line = this.currentLine(textarea);
      const current = /^#{1,6}(?=\s)/.exec(line)?.[0].length || 0;
      this.setHeading(textarea, current === 6 ? 0 : current + 1);
    }
  }

  private insertLineAfterImage(event: KeyboardEvent, textarea: HTMLTextAreaElement): boolean {
    const active = this.active;
    if (!active || active.textarea !== textarea || !isImageLine(textarea.value) ||
      textarea.selectionStart !== textarea.value.length || textarea.selectionEnd !== textarea.value.length) return false;
    event.preventDefault();
    event.stopPropagation();
    const { index, part, parts } = active;
    this.commitActive(false);
    parts[part] += "\n";
    this.draft.content[index] = parts.join("");
    this.dirty = true;
    this.render();
    const body = this.root.querySelectorAll<HTMLElement>(".simple-columns-editor-body")[index];
    const nextParts = body && columnSourceParts.get(body);
    const holder = body?.querySelector<HTMLElement>(`.simple-columns-edit-block[data-part="${part + 1}"]`);
    if (holder && nextParts) this.editBlock(index, part + 1, nextParts, holder);
    else this.persist();
    return true;
  }

  private removeBlankLine(event: KeyboardEvent, textarea: HTMLTextAreaElement, backward: boolean): boolean {
    const active = this.active;
    if (!active || active.textarea !== textarea || textarea.value || active.parts[active.part].trim()) return false;
    if (!active.parts[active.part] && (!backward || active.part === 0)) return false;
    event.preventDefault();
    event.stopPropagation();
    const { index, part, parts } = active;
    this.commitActive(false);
    if (!parts[part]) parts[part - 1] = parts[part - 1].replace(/\n$/, "");
    parts.splice(part, 1);
    if (!parts.length) parts.push("");
    const before = parts.slice(0, part).join("");
    const caret = backward ? before.replace(/\n+$/, "").length : before.length;
    this.draft.content[index] = parts.join("");
    this.dirty = true;
    this.render();
    const body = this.root.querySelectorAll<HTMLElement>(".simple-columns-editor-body")[index];
    const nextParts = body && columnSourceParts.get(body);
    let nextPart = 0;
    let start = 0;
    if (nextParts) {
      while (nextPart < nextParts.length - 1) {
        const end = start + nextParts[nextPart].length;
        if (caret < end || backward && caret === end) break;
        start = end;
        nextPart++;
      }
    }
    const holder = body?.querySelector<HTMLElement>(`.simple-columns-edit-block[data-part="${nextPart}"]`);
    if (holder && nextParts) {
      this.editBlock(index, nextPart, nextParts, holder);
      const active = this.active;
      if (active) {
        const position = Math.max(0, Math.min(active.textarea.value.length, caret - start - active.leading.length));
        active.textarea.setSelectionRange(position, position);
      }
    } else this.persist();
    return true;
  }

  private moveBetweenBlocks(event: KeyboardEvent, textarea: HTMLTextAreaElement, direction: -1 | 1): boolean {
    const active = this.active;
    if (!active || active.textarea !== textarea || textarea.selectionStart !== textarea.selectionEnd) return false;
    const nextPart = active.part + direction;
    if (nextPart < 0 || nextPart >= active.parts.length) return false;
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24;
    const singleLine = textarea.scrollHeight <= lineHeight * 1.5;
    const caret = textarea.selectionStart;
    if (!singleLine && (direction < 0 ? caret !== 0 : caret !== textarea.value.length)) return false;
    const lineStart = textarea.value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    const column = caret - lineStart;
    const nextHolder = active.holder.parentElement?.querySelector<HTMLElement>(`.simple-columns-edit-block[data-part="${nextPart}"]`);
    if (!nextHolder) return false;
    event.preventDefault();
    event.stopPropagation();
    this.editBlock(active.index, nextPart, active.parts, nextHolder);
    const next = this.active?.textarea;
    if (!next) return true;
    const start = direction < 0 ? next.value.lastIndexOf("\n") + 1 : 0;
    const end = direction < 0 ? next.value.length : next.value.indexOf("\n");
    const position = start + Math.min(column, (end < 0 ? next.value.length : end) - start);
    next.setSelectionRange(position, position);
    return true;
  }

  private wrapShortcut(event: KeyboardEvent, textarea: HTMLTextAreaElement, startMarker: string, endMarker = startMarker): void {
    event.preventDefault(); event.stopPropagation();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    const before = textarea.value.slice(start - startMarker.length, start);
    const after = textarea.value.slice(end, end + endMarker.length);
    if (before === startMarker && after === endMarker) {
      textarea.setRangeText(selected, start - startMarker.length, end + endMarker.length, "select");
    } else {
      textarea.setRangeText(`${startMarker}${selected}${endMarker}`, start, end, "select");
      textarea.setSelectionRange(start + startMarker.length, end + startMarker.length);
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private insertLink(event: KeyboardEvent, textarea: HTMLTextAreaElement): void {
    event.preventDefault(); event.stopPropagation();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end) || "标题";
    const replacement = `[${selected}](url)`;
    textarea.setRangeText(replacement, start, end, "end");
    textarea.setSelectionRange(start + replacement.length - 4, start + replacement.length - 1);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private insertCallout(event: KeyboardEvent, textarea: HTMLTextAreaElement): void {
    event.preventDefault(); event.stopPropagation();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) {
      const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
      const lineEndAt = textarea.value.indexOf("\n", start);
      const lineEnd = lineEndAt < 0 ? textarea.value.length : lineEndAt;
      textarea.setRangeText(formatSelection(this.plugin, textarea.value.slice(lineStart, lineEnd), "callout-note"), lineStart, lineEnd, "end");
    } else {
      textarea.setRangeText(formatSelection(this.plugin, textarea.value.slice(start, end), "callout-note"), start, end, "end");
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private currentLine(textarea: HTMLTextAreaElement): string {
    const start = textarea.value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
    const end = textarea.value.indexOf("\n", textarea.selectionStart);
    return textarea.value.slice(start, end < 0 ? undefined : end);
  }

  private setHeading(textarea: HTMLTextAreaElement, level: number): void {
    const start = textarea.value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
    const endAt = textarea.value.indexOf("\n", textarea.selectionStart);
    const end = endAt < 0 ? textarea.value.length : endAt;
    const body = textarea.value.slice(start, end).replace(/^#{1,6}\s*/, "");
    textarea.setRangeText(level ? `${"#".repeat(level)} ${body}` : body, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private formatColumnSelection(mode: QuickFormatMode): boolean {
    const view = this.columnEditor?.view;
    if (!view) return false;
    const { from, to } = view.state.selection.main;
    if (isHeadingMode(mode)) this.setColumnHeading(view, Number(mode.slice(1)));
    else {
      if (from === to) { new Notice("请先选中要转换的内容"); return false; }
      const replacement = formatSelection(this.plugin, view.state.doc.sliceString(from, to), mode);
      view.dispatch({ changes: { from, to, insert: replacement }, selection: { anchor: from + replacement.length } });
    }
    view.focus();
    return true;
  }

  private setColumnHeading(view: EditorView, level: number): void {
    const line = view.state.doc.lineAt(view.state.selection.main.from);
    const text = line.text.replace(/^#{1,6}\s+/, "").trimStart();
    const replacement = level ? `${"#".repeat(level)} ${text}` : text;
    view.dispatch({ changes: { from: line.from, to: line.to, insert: replacement }, selection: { anchor: line.from + replacement.length } });
  }

  private toggleColumnMarkup(view: EditorView, marker: string): void {
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc;
    const selected = doc.sliceString(from, to);
    const size = marker.length;
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= size * 2) {
      view.dispatch({ changes: { from, to, insert: selected.slice(size, -size) }, selection: { anchor: from, head: to - size * 2 } });
    } else if (from >= size && doc.sliceString(from - size, from) === marker && doc.sliceString(to, to + size) === marker) {
      view.dispatch({ changes: [{ from: from - size, to: from }, { from: to, to: to + size }], selection: { anchor: from - size, head: to - size } });
    } else {
      view.dispatch({ changes: { from, to, insert: `${marker}${selected}${marker}` }, selection: { anchor: from + size, head: from + size + selected.length } });
    }
    view.focus();
  }

  private applyColumnCommand(command: string, view: EditorView): void {
    if (this.columnEditor?.view !== view) return;
    if (command.startsWith("editor:set-heading-")) {
      this.setColumnHeading(view, Number(command.at(-1)));
    } else if (command === "editor:toggle-blockquote" || command === "editor:insert-callout") {
      const { from, to } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const end = to === from ? line.to : to;
      const source = view.state.doc.sliceString(from === to ? line.from : from, end);
      const replacement = formatSelection(this.plugin, source, command === "editor:toggle-blockquote" ? "quote" : "callout-note");
      view.dispatch({ changes: { from: from === to ? line.from : from, to: end, insert: replacement }, selection: { anchor: (from === to ? line.from : from) + replacement.length } });
    } else {
      const markers: Record<string, string> = {
        "editor:toggle-bold": "**", "editor:toggle-italics": "*", "editor:toggle-strikethrough": "~~",
        "editor:toggle-highlight": "==", "editor:toggle-code": "`", "editor:toggle-inline-math": "$",
      };
      this.toggleColumnMarkup(view, markers[command]);
    }
  }

  destroy(): void {
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.stageCleanup?.();
    this.releaseFormatTarget?.();
    this.releaseCommandTarget?.();
    this.columnEditor?.view.destroy();
    this.columnEditor = null;
  }

}

class ColumnsWidget extends WidgetType {
  private readonly surfaces = new WeakMap<HTMLElement, ColumnsSurface>();
  constructor(private plugin: SimplePlugin, private block: Block) { super(); }
  eq(other: ColumnsWidget): boolean { return other.block.source === this.block.source && other.block.from === this.block.from; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement("div");
    element.dataset.columnsFrom = String(this.block.from);
    const sourcePath = pathForView(this.plugin, view);
    const surface = new ColumnsSurface(this.plugin, sourcePath, this.block.columns, element, (value, drag) => {
      window.setTimeout(() => {
        if (!view.dom.isConnected) return;
        if (view.state.doc.sliceString(this.block.from, this.block.to) !== this.block.source) { new Notice("列组已变化，请重新编辑"); return; }
        const removal = drag?.view === view ? dragRemovalRange(drag) : null;
        if (drag?.view === view && (!removal || removal.from < this.block.to && removal.to > this.block.from)) {
          new Notice("无法安全移动所选内容，请重新选择");
          return;
        }
        view.dispatch({ changes: removal ? [
          { from: removal.from, to: removal.to, insert: "" },
          { from: this.block.from, to: this.block.to, insert: serialize(value) },
        ] : { from: this.block.from, to: this.block.to, insert: serialize(value) } });
      }, 0);
    }, (value, index, point, remove, side) => {
      window.setTimeout(() => {
        if (!view.dom.isConnected) return;
        relocateInEditor(view, this.block.from, this.block.source, value, index, point, remove, side, element);
      }, 0);
    });
    this.surfaces.set(element, surface);
    return element;
  }
  destroy(dom: HTMLElement): void {
    this.surfaces.get(dom)?.destroy();
    this.surfaces.delete(dom);
  }
  ignoreEvent(): boolean { return true; }
}

function pathForView(plugin: SimplePlugin, editorView: EditorView): string {
  let path = "";
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(editorView.dom)) path = leaf.view.file?.path || "";
  });
  return path;
}

export function registerNotionColumns(plugin: SimplePlugin): void {
  const commands = (plugin.app as unknown as { commands: { executeCommand: (command: { id: string }, event?: unknown) => boolean } }).commands;
  const executeCommand = commands.executeCommand;
  const executeWithColumn = function (this: typeof commands, command: { id: string }, event?: unknown): boolean {
    const target = activeColumnCommandTarget;
    if (target?.hasFocus() && COLUMN_FORMAT_COMMANDS.includes(command.id as typeof COLUMN_FORMAT_COMMANDS[number])) {
      target.apply(command.id);
      return true;
    }
    return executeCommand.call(this, command, event);
  };
  commands.executeCommand = executeWithColumn;
  plugin.register(() => { if (commands.executeCommand === executeWithColumn) commands.executeCommand = executeCommand; });
  const selectionSource = document.body.createDiv({ cls: "simple-columns-selection-source" });
  selectionSource.hidden = true;
  selectionSource.createDiv({ cls: "simple-columns-selection-source-label", text: "将复制的 Markdown" });
  const selectionCode = selectionSource.createEl("pre");
  plugin.register(() => selectionSource.remove());
  plugin.registerDomEvent(document, "selectionchange", () => {
    const markdown = plugin.settings.enableNotionColumns
      ? Array.from(document.querySelectorAll<HTMLElement>(".simple-columns-editor-body"))
        .map(selectedColumnMarkdown).find(Boolean)
      : null;
    selectionSource.hidden = !markdown;
    if (markdown) selectionCode.textContent = markdown;
  });
  plugin.registerDomEvent(document, "copy", (event: ClipboardEvent) => {
    if (!plugin.settings.enableNotionColumns || !event.clipboardData) return;
    const markdown = Array.from(document.querySelectorAll<HTMLElement>(".simple-columns-editor-body"))
      .map(selectedColumnMarkdown).find(Boolean);
    if (!markdown) return;
    event.clipboardData.setData("text/plain", markdown);
    event.clipboardData.setData("text/markdown", markdown);
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });
  plugin.addCommand({
    id: "create-two-column-view",
    name: "在当前位置创建双列视图",
    hotkeys: [DEFAULT_COLUMNS_HOTKEY],
    editorCheckCallback: (checking, editor) => {
      if (!plugin.settings.enableNotionColumns) return false;
      if (!checking) {
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        const before = editor.getLine(from.line).slice(0, from.ch);
        const after = editor.getLine(to.line).slice(to.ch);
        const block = serialize({ widths: widths(2), content: [editor.getSelection().trim(), ""] });
        const atEnd = to.line === editor.lastLine() && !after;
        editor.replaceSelection(`${before ? "\n" : ""}${block}${atEnd ? "\n\n" : after ? "\n" : ""}`);
      }
      return true;
    },
  });
  plugin.registerMarkdownCodeBlockProcessor("simple-columns", (source, el, ctx) => {
    if (!plugin.settings.enableNotionColumns) { el.createEl("pre").createEl("code", { text: source }); return; }
    const columns = parse(source);
    if (!columns) { el.setText("列视图格式无效"); return; }
    const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
    const surface = new ColumnsSurface(plugin, ctx.sourcePath, columns, el, (value, drag) => {
      if (!(file instanceof TFile)) return;
      const section = ctx.getSectionInfo(el);
      if (!section) { new Notice("无法定位列组源代码"); return; }
      if (drag && pathForView(plugin, drag.view) === ctx.sourcePath) {
        const doc = drag.view.state.doc;
        const blockStart = doc.line(section.lineStart + 1).from;
        const block = findBlocks(doc.toString()).find((item) => item.from === blockStart);
        const removal = dragRemovalRange(drag);
        if (!block || !removal || removal.from < block.to && removal.to > block.from) {
          new Notice("无法安全移动所选内容，请重新选择");
          return;
        }
        drag.view.dispatch({ changes: [
          { from: removal.from, to: removal.to, insert: "" },
          { from: block.from, to: block.to, insert: serialize(value) },
        ] });
        return;
      }
      void plugin.app.vault.process(file, (text) => {
        const lines = text.split("\n");
        const current = lines.slice(section.lineStart, section.lineEnd + 1).join("\n");
        const currentBody = /^```simple-columns\n([\s\S]*?)\n```\s*$/.exec(current)?.[1];
        if (currentBody === undefined || currentBody.trim() !== source.trim()) { new Notice("列组位置已变化，请重新编辑"); return text; }
        lines.splice(section.lineStart, section.lineEnd - section.lineStart + 1, serialize(value));
        return lines.join("\n");
      });
    }, (value, index, point, remove, side) => {
      if (!(file instanceof TFile)) return;
      const section = ctx.getSectionInfo(el);
      if (!section) { new Notice("无法定位列组源代码"); return; }
      let targetLine: number | null = null;
      const editorElement = el.closest<HTMLElement>(".cm-editor");
      const editorView = editorElement && EditorView.findFromDOM(editorElement);
      if (editorView && pathForView(plugin, editorView) === ctx.sourcePath) {
        const hint = editorView.state.doc.line(section.lineStart + 1).from;
        const block = findBlocks(editorView.state.doc.toString())
          .filter((item) => /^```simple-columns\n([\s\S]*?)\n```\s*$/.exec(item.source)?.[1].trim() === source.trim())
          .sort((a, b) => Math.abs(a.from - hint) - Math.abs(b.from - hint))[0];
        if (!block) { new Notice("列组已变化，请重新拖动"); return; }
        if (!remove) {
          const target = targetAt(editorView, point.y);
          if (!target) { new Notice("无法定位放置位置，请重新拖动"); return; }
          targetLine = target.from >= block.from && target.from < block.to
            ? point.y < el.getBoundingClientRect().top ? section.lineStart : section.lineEnd + 1
            : target.from === editorView.state.doc.length ? editorView.state.doc.lines : editorView.state.doc.lineAt(target.from).number - 1;
        }
      }
      const preview = el.closest(".markdown-preview-view");
      if (!remove && targetLine === null) {
        let target = el.ownerDocument.elementFromPoint(point.x, point.y) as HTMLElement | null;
        while (target && preview?.contains(target)) {
          const info = ctx.getSectionInfo(target);
          if (info) { targetLine = info.lineStart; break; }
          target = target.parentElement;
        }
        if (targetLine === null) targetLine = point.y < el.getBoundingClientRect().top ? section.lineStart : section.lineEnd + 1;
      }
      void plugin.app.vault.process(file, (text) => {
        const lines = text.split("\n");
        const current = lines.slice(section.lineStart, section.lineEnd + 1).join("\n");
        const currentBody = /^```simple-columns\n([\s\S]*?)\n```\s*$/.exec(current)?.[1];
        if (currentBody === undefined || currentBody.trim() !== source.trim()) { new Notice("列组位置已变化，请重新拖动"); return text; }
        const offset = (line: number) => Math.min(text.length, lines.slice(0, line).join("\n").length + (line > 0 ? 1 : 0));
        const from = offset(section.lineStart);
        const to = from + current.length;
        const targetPosition = targetLine === null ? null : offset(targetLine);
        return moveColumnInDocument(text, from, to, value, index, targetPosition, side);
      });
    });
    const child = new MarkdownRenderChild(el);
    child.register(() => surface.destroy());
    ctx.addChild(child);
  });

  type SelectionDrag = { view: EditorView; from: number; to: number; selected: string; x: number; y: number };
  type StagedDrag = SelectionDrag & { element: HTMLElement; cleanup: () => void; armed: boolean };
  let staged: StagedDrag | null = null;
  const refreshColumns = StateEffect.define<void>();
  const field = StateField.define<DecorationSet>({
    create: (state) => decorations(state),
    update: (value, transaction) => transaction.docChanged || transaction.effects.some((effect) => effect.is(refreshColumns))
      ? decorations(transaction.state) : value,
    provide: (field) => EditorView.decorations.from(field),
  });
  function decorations(state: EditorState): DecorationSet {
    if (!plugin.settings.enableNotionColumns) return Decoration.none;
    const ranges = findBlocks(state.doc.toString()).map((block) => Decoration.replace({ widget: new ColumnsWidget(plugin, block), block: true }).range(block.from, block.to));
    if (staged && staged.view.state.doc === state.doc && staged.from < staged.to &&
        !ranges.some((range) => range.from < staged!.to && range.to > staged!.from)) {
      ranges.push(Decoration.replace({}).range(staged.from, staged.to));
    }
    return Decoration.set(ranges, true);
  }
  function clearStage(refresh = true): void {
    const item = staged;
    if (!item) return;
    staged = null;
    item.cleanup();
    item.element.remove();
    if (refresh && item.view.dom.isConnected) item.view.dispatch({ effects: refreshColumns.of() });
  }

  function showStage(selection: SelectionDrag, event: MouseEvent): void {
    clearStage();
    const doc = selection.view.dom.ownerDocument;
    const card = doc.createElement("div");
    card.className = "simple-columns-stage";
    card.setAttribute("title", "移动到目标行，左键插入左侧，右键插入右侧；Esc 取消");
    const grid = doc.createElement("div");
    grid.className = "simple-columns-stage-grid";
    const preview = doc.createElement("div");
    preview.className = "simple-columns-stage-preview";
    preview.textContent = selection.selected.trim().slice(0, 90) || "已选内容";
    const empty = doc.createElement("div");
    empty.className = "simple-columns-stage-empty";
    grid.append(preview, empty);
    const status = doc.createElement("small");
    status.className = "simple-columns-stage-status";
    status.textContent = "左键点击插入左侧，右键点击插入右侧";
    card.append(grid, status);
    doc.body.append(card);
    const caret = doc.createElement("div");
    caret.className = "simple-columns-insert-caret";
    const caretLabel = doc.createElement("span");
    caretLabel.textContent = "插入到此行";
    caret.append(caretLabel);
    doc.body.append(caret);
    let rightDrop = false;
    const move = (next: MouseEvent) => {
      card.style.left = `${Math.max(4, Math.min(next.clientX + 5, doc.documentElement.clientWidth - 230))}px`;
      card.style.top = `${Math.max(4, Math.min(next.clientY + 5, doc.documentElement.clientHeight - 100))}px`;
      const editor = selection.view.dom.getBoundingClientRect();
      const inside = next.clientY >= editor.top && next.clientY <= editor.bottom && next.clientX >= editor.left && next.clientX <= editor.right;
      const target = inside ? targetAt(selection.view, next.clientY) : null;
      card.classList.toggle("simple-columns-stage-ready", !!target);
      caret.style.display = target ? "block" : "none";
      if (!target) return;
      const body = selection.view.contentDOM.getBoundingClientRect();
      const group = target.columns && Array.from(selection.view.dom.querySelectorAll<HTMLElement>(".simple-columns"))
        .find((element) => Number(element.dataset.columnsFrom) === target.from);
      const groupRect = group?.getBoundingClientRect();
      const coords = selection.view.coordsAtPos(target.from);
      const end = selection.view.coordsAtPos(selection.view.state.doc.length);
      const append = target.from === selection.view.state.doc.length && !target.text && end && next.clientY > end.bottom + 8;
      caret.style.left = `${Math.max(editor.left + 4, body.left + 2)}px`;
      caret.style.top = `${groupRect?.top ?? (append ? end.bottom + 3 : coords?.top ?? next.clientY)}px`;
      caret.style.height = `${groupRect?.height ?? Math.max(22, (coords?.bottom ?? next.clientY + 22) - (coords?.top ?? next.clientY))}px`;
      const inPlace = !target.columns && target.from < selection.to && target.to > selection.from;
      caretLabel.textContent = target.columns ? "插入到此列组" : inPlace ? "原地生成双列" : "插入到此行";
    };
    const down = (next: MouseEvent) => {
      if (!staged?.armed || staged.view !== selection.view || next.button !== 0 && next.button !== 2) return;
      const editor = selection.view.dom.getBoundingClientRect();
      if (next.clientX < editor.left || next.clientX > editor.right || next.clientY < editor.top || next.clientY > editor.bottom) return;
      next.preventDefault();
      next.stopPropagation();
      rightDrop = next.button === 2;
      finishStage(staged, selection.view, next, next.button === 0 ? "left" : "right");
    };
    const key = (next: KeyboardEvent) => { if (next.key === "Escape") { next.preventDefault(); clearStage(); } };
    const menu = (next: MouseEvent) => { next.preventDefault(); next.stopPropagation(); };
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("mousedown", down, true);
    doc.addEventListener("keydown", key, true);
    doc.addEventListener("contextmenu", menu, true);
    staged = { ...selection, element: card, armed: false, cleanup: () => {
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("mousedown", down, true);
      doc.removeEventListener("keydown", key, true);
      caret.remove();
      if (rightDrop) doc.defaultView?.setTimeout(() => doc.removeEventListener("contextmenu", menu, true), 900);
      else doc.removeEventListener("contextmenu", menu, true);
    } };
    move(event);
    const start = selection.view.coordsAtPos(selection.from);
    if (start && !doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const end = selection.view.coordsAtPos(selection.to);
      const originWidth = Math.max(36, Math.min(230, (end?.left ?? start.right) - start.left));
      const destinationX = Number.parseFloat(card.style.left);
      const destinationY = Number.parseFloat(card.style.top);
      card.animate([
        { transform: `translate(${start.left - destinationX}px, ${start.top - destinationY}px) scale(${originWidth / 220}, .5)`, opacity: .25 },
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
      ], { duration: 230, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    selection.view.dispatch({ effects: refreshColumns.of() });
  }

  function finishStage(item: StagedDrag, view: EditorView, event: MouseEvent, side: "left" | "right"): boolean {
    const target = targetAt(view, event.clientY);
    if (!target) return false;
    event.preventDefault();
    event.stopPropagation();
    if (view.state.doc.sliceString(item.from, item.to) !== item.selected) {
      new Notice("原文已变化，请重新选择");
      clearStage();
      return true;
    }
    const inPlace = !target.columns && target.from < item.to && target.to > item.from;
    if (target.columns && target.columns.content.length >= 4) {
      new Notice("最多支持四列");
      return true;
    }
    const selected = item.selected.trim();
    const replaceFrom = inPlace ? view.state.doc.lineAt(item.from).from : target.from;
    const replaceTo = inPlace ? view.state.doc.lineAt(Math.max(item.from, item.to - 1)).to : target.to;
    const targetText = inPlace
      ? view.state.doc.sliceString(replaceFrom, item.from) + view.state.doc.sliceString(item.to, replaceTo)
      : target.text;
    const content = target.columns
      ? side === "left" ? [selected, ...target.columns.content] : [...target.columns.content, selected]
      : side === "left" ? [selected, targetText] : [targetText, selected];
    const nextWidths = target.columns ? widthsWithAddedColumn(target.columns.widths, side) : widths(2);
    const serialized = serialize({ widths: nextWidths, content });
    const replacement = target.from === target.to && target.from === view.state.doc.length && view.state.doc.length > 0
      ? `${view.state.doc.toString().endsWith("\n") ? "\n" : "\n\n"}${serialized}`
      : serialized;
    const changes = inPlace
      ? [{ from: replaceFrom, to: replaceTo, insert: replacement }]
      : [
        { from: item.from, to: item.to, insert: "" },
        { from: target.from, to: target.to, insert: replacement },
      ];
    const next = view.state.changes(changes).apply(view.state.doc).toString();
    const suffix = terminalColumnsLineSuffix(next);
    if (suffix) {
      const ending = changes.find((change) => change.to === view.state.doc.length);
      if (ending) ending.insert += suffix;
      else changes.push({ from: view.state.doc.length, to: view.state.doc.length, insert: suffix });
    }
    clearStage();
    view.dispatch({ changes });
    return true;
  }

  plugin.registerEditorExtension([field, ViewPlugin.fromClass(class {
    private candidate: SelectionDrag | null = null;
    private chordActive = false;
    private suppressMenuUntil = 0;
    constructor(private view: EditorView) {
      view.contentDOM.addEventListener("mousedown", this.mouseDown, true);
      view.contentDOM.addEventListener("contextmenu", this.contextMenu, true);
      view.contentDOM.addEventListener("dragstart", this.dragStart, true);
      view.contentDOM.addEventListener("dragend", this.dragEnd, true);
      view.dom.ownerDocument.addEventListener("mousemove", this.mouseMove, true);
      view.dom.ownerDocument.addEventListener("mouseup", this.mouseUp, true);
    }
    private selectionAt(event: MouseEvent): SelectionDrag | null {
      const { from, to } = this.view.state.selection.main;
      const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      const selected = this.view.state.doc.sliceString(from, to);
      return from < to && position !== null && position >= from && position <= to && selected.trim()
        ? { view: this.view, from, to, selected, x: event.clientX, y: event.clientY }
        : null;
    }
    private mouseDown = (event: MouseEvent): void => {
      if (!plugin.settings.enableNotionColumns || event.button !== 0 && event.button !== 2) return;
      if (staged?.view === this.view) return;
      if ((event.buttons & 3) === 3) {
        this.beginChord(event);
        return;
      }
      this.candidate = this.selectionAt(event);
      if (event.button === 2 && this.candidate) this.suppressMenuUntil = Date.now() + 700;
    };
    private beginChord(event: MouseEvent): void {
      if (this.chordActive || !this.candidate) return;
      if (Math.hypot(event.clientX - this.candidate.x, event.clientY - this.candidate.y) > 32) return;
      event.preventDefault();
      event.stopPropagation();
      this.chordActive = true;
      this.suppressMenuUntil = Date.now() + 900;
      showStage(this.candidate, event);
    }
    private mouseMove = (event: MouseEvent): void => {
      if (this.candidate && !this.chordActive && (event.buttons & 3) === 3) this.beginChord(event);
    };
    private mouseUp = (event: MouseEvent): void => {
      if (!this.chordActive) {
        if ((event.buttons & 3) === 0) this.candidate = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if ((event.buttons & 3) !== 0) return;
      this.chordActive = false;
      this.candidate = null;
      if (staged?.view === this.view) staged.armed = true;
    };
    private contextMenu = (event: MouseEvent): void => {
      if (this.candidate || this.chordActive || Date.now() < this.suppressMenuUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    private dragStart = (event: DragEvent): void => {
      if (this.chordActive || (event.buttons & 3) === 3) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.target instanceof HTMLElement && event.target.closest(".simple-columns")) return;
      const { from, to } = this.view.state.selection.main;
      nativeTextDrag = from < to ? { view: this.view, from, to, selected: this.view.state.doc.sliceString(from, to) } : null;
    };
    private dragEnd = (): void => { nativeTextDrag = null; };
    destroy(): void {
      this.view.contentDOM.removeEventListener("mousedown", this.mouseDown, true);
      this.view.contentDOM.removeEventListener("contextmenu", this.contextMenu, true);
      this.view.contentDOM.removeEventListener("dragstart", this.dragStart, true);
      this.view.contentDOM.removeEventListener("dragend", this.dragEnd, true);
      this.view.dom.ownerDocument.removeEventListener("mousemove", this.mouseMove, true);
      this.view.dom.ownerDocument.removeEventListener("mouseup", this.mouseUp, true);
      if (staged?.view === this.view) clearStage(false);
    }
  })]);
}
