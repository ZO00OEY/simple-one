import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { Component, MarkdownRenderer, Notice, editorInfoField, editorLivePreviewField, setIcon, setTooltip, type App } from "obsidian";
import { reportError } from "../shared/async";

const quote = /^ {0,3}>[ \t]?/;
const title = /^ {0,3}>[ \t]?\[!([^\]\s|]+)(?:\|[^\]]*)?\]([+-])?[ \t]*/;
const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const list = /^(\s*)([-+*]|\d{1,9}[.)])[ \t]+(\[[ xX]\][ \t]+)?/;
const fence = /^ {0,3}(`{3,}|~{3,})/;
const tableSeparator = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const inlineFormat = /<(span|strong|em|del|u|mark)(?: style="((?:(?:color|background):\s*#[\da-f]{6}(?:[\da-f]{2})?;\s*|font-style:\s*italic;\s*)+)")?>([^<>]+)<\/\1>/gi;

function calloutAt(doc: Text, pos: number) {
  let line = doc.lineAt(pos);
  while (quote.test(line.text)) {
    const header = title.exec(line.text);
    if (header) {
      let last = line.number;
      while (last < doc.lines && quote.test(doc.line(last + 1).text) && !title.test(doc.line(last + 1).text)) last++;
      return { first: line.number, last, from: line.from, to: doc.line(last).to, header };
    }
    if (line.number === 1) break;
    line = doc.line(line.number - 1);
  }
  return null;
}

type Callout = NonNullable<ReturnType<typeof calloutAt>>;
type Appearance = { from: number; style: string };
const showSource = StateEffect.define<number>();
const setAppearance = StateEffect.define<Appearance>();
const display = StateField.define<{ raw: number | null; appearance: Appearance | null }>({
  create: () => ({ raw: null, appearance: null }),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && tr.effects.length === 0) return value;
    let raw = value.raw === null ? null : tr.changes.mapPos(value.raw, -1);
    let appearance = value.appearance;
    if (appearance && tr.docChanged) appearance = { ...appearance, from: tr.changes.mapPos(appearance.from, -1) };
    for (const effect of tr.effects) {
      if (effect.is(showSource)) raw = effect.value;
      if (effect.is(setAppearance)) appearance = effect.value;
    }
    if (raw !== null && tr.selection && !tr.state.selection.ranges.some(range => calloutAt(tr.newDoc, range.head)?.from === raw)) raw = null;
    return raw === value.raw && appearance === value.appearance ? value : { raw, appearance };
  },
});

function activeCallouts(state: EditorState): Callout[] {
  if (!isLive(state)) return [];
  const blocks = new Map<number, Callout>();
  for (const range of state.selection.ranges) {
    for (const pos of [range.from, range.to]) {
      const block = calloutAt(state.doc, pos);
      if (!block || blocks.has(block.from) || block.from === state.field(display, false)?.raw) continue;
      const token = syntaxTree(state).resolveInner(block.from + block.header[0].indexOf("[!"), 1);
      if (token.name.includes("hmd-callout")) blocks.set(block.from, block);
    }
  }
  return [...blocks.values()];
}

function quotedBody(doc: Text, number: number): string {
  return doc.line(number).text.replace(quote, "");
}

function tableBoundaries(body: string): number[] {
  const separators = [...body.matchAll(/\\[\s\S]|[^|\\]+|(\|)/g)]
    .filter(match => match[1]).map(match => match.index);
  const bounds = [-1, ...separators, body.length];
  if (separators.length && !body.slice(0, separators[0]).trim()) bounds.shift();
  if (separators.length && !body.slice(separators[separators.length - 1] + 1).trim()) bounds.pop();
  return bounds;
}

function* calloutTables(doc: Text, block: Callout) {
  let code: string | undefined;
  for (let number = block.first + 1; number < block.last; number++) {
    const body = quotedBody(doc, number);
    const delimiter = fence.exec(body)?.[1];
    if (code || delimiter) {
      if (!code) code = delimiter;
      else if (delimiter?.startsWith(code)) code = undefined;
      continue;
    }
    const separator = quotedBody(doc, number + 1);
    if (!body.includes("|") || !tableSeparator.test(separator) || tableBoundaries(body).length !== tableBoundaries(separator).length) continue;
    const first = number;
    number++;
    while (number < block.last) {
      const next = quotedBody(doc, number + 1);
      if (!next.trim() || heading.test(next) || list.test(next) || fence.test(next) || quote.test(next) || /^ {0,3}(?:([-*_])(?:\s*\1){2,})\s*$/.test(next)) break;
      number++;
    }
    yield { first, last: number };
  }
}

// Match visible characters in source order, skipping Markdown delimiters.
function textOffsets(source: string, rendered: string): number[] {
  const positions: number[] = [];
  let cursor = 0;
  for (let index = 0; index < rendered.length; index++) {
    const next = source.indexOf(rendered[index], cursor);
    if (next < 0 || next - cursor > 80) break;
    positions.push(next);
    cursor = next + 1;
  }
  return positions;
}

function caretTextOffset(element: Element, event: MouseEvent): number {
  const caret = element.ownerDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (!caret || !element.contains(caret.offsetNode)) return 0;
  const prefix = element.ownerDocument.createRange();
  prefix.setStart(element, 0);
  prefix.setEnd(caret.offsetNode, caret.offset);
  return prefix.toString().trimStart().length;
}

function tableCellRange(doc: Text, first: number, last: number, row: number, column: number) {
  const number = first + row + (row === 0 ? 0 : 1);
  if (number < 1 || number > Math.min(last, doc.lines)) return null;
  const line = doc.line(number);
  const prefix = quote.exec(line.text);
  if (!prefix) return null;
  const body = line.text.slice(prefix[0].length);
  const boundaries = tableBoundaries(body);
  if (column >= boundaries.length - 1) {
    const end = line.from + prefix[0].length + boundaries[boundaries.length - 1];
    return { from: end, to: end, source: "", padding: " | ".repeat(column - boundaries.length + 2) };
  }
  const begin = boundaries[column] + 1;
  const text = body.slice(begin, boundaries[column + 1]);
  const source = text.trim();
  const leading = source ? text.length - text.trimStart().length : Math.min(1, text.length);
  const from = line.from + prefix[0].length + begin + leading;
  return { from, to: from + source.length, source, padding: "" };
}

type TableRange = { first: number; last: number };
const cellEdits = new WeakMap<EditorView, (save: boolean) => void>();
let tableCellLabelId = 0;

function renderedTableRange(view: EditorView, grid: HTMLTableElement): TableRange | undefined {
  const widget = grid.closest<HTMLElement>(".simple-callout-table, .cm-callout.cm-embed-block");
  if (!widget?.isConnected) return;
  const { doc } = view.state;
  const pos = view.posAtDOM(widget);
  const block = calloutAt(doc, pos);
  if (!block) return;
  const tables = [...calloutTables(doc, block)];
  if (widget.matches(".simple-callout-table")) return tables.find(table => table.first === doc.lineAt(pos).number);
  const rendered = [...widget.querySelectorAll(".callout-content table")];
  if (tables.length === rendered.length) return tables[rendered.indexOf(grid)];
}

function editTableCell(
  view: EditorView, event: PointerEvent, cell: HTMLTableCellElement,
): void {
  const row = cell.closest<HTMLTableRowElement>("tr")?.rowIndex;
  const grid = cell.closest<HTMLTableElement>("table");
  const table = grid && renderedTableRange(view, grid);
  if (!table || row === undefined || cell.querySelector("textarea")) return;
  const column = cell.cellIndex;
  event.preventDefault();
  event.stopPropagation();
  cellEdits.get(view)?.(true);
  if (!cell.isConnected) {
    const doc = view.state.doc;
    const reopen = (remaining: number) => {
      if (view.state.doc !== doc || !view.dom.isConnected || cellEdits.has(view)) return;
      const grid = [...view.contentDOM.querySelectorAll<HTMLTableElement>("table")]
        .find(grid => renderedTableRange(view, grid)?.first === table.first);
      const next = grid?.rows[row]?.cells[column];
      if (next) editTableCell(view, event, next);
      else if (remaining > 0) view.dom.ownerDocument.defaultView?.requestAnimationFrame(() => reopen(remaining - 1));
    };
    queueMicrotask(() => reopen(6));
    return;
  }
  const source = tableCellRange(view.state.doc, table.first, table.last, row, column);
  if (!source) return;

  const offset = caretTextOffset(cell, event);
  const offsets = textOffsets(source.source, cell.textContent.trim());
  const caret = offsets[offset] ?? source.source.length;
  const original = [...cell.childNodes];
  const previousWidth = cell.style.minWidth;
  const width = cell.getBoundingClientRect().width;
  const labelId = `simple-callout-cell-label-${++tableCellLabelId}`;
  const label = cell.ownerDocument.win.createSpan({
    text: `编辑表格第 ${row + 1} 行第 ${column + 1} 列`, attr: { id: labelId, hidden: "" },
  });
  const input = cell.ownerDocument.win.createEl("textarea", {
    cls: "simple-callout-cell-input", attr: { rows: "1", "aria-labelledby": labelId },
  });
  input.value = source.source;
  cell.style.minWidth = `${width}px`;
  cell.replaceChildren(input, label);
  const resize = () => {
    input.setCssProps({ height: "auto" });
    input.setCssProps({ height: `${input.scrollHeight}px` });
  };
  input.addEventListener("input", resize);
  resize();

  let pending = true;
  const finish = (save: boolean) => {
    if (!pending) return;
    pending = false;
    cellEdits.delete(view);
    const text = input.value.trim();
    cell.style.minWidth = previousWidth;
    cell.replaceChildren(...original);
    if (!save || text === source.source) return;
    const currentTable = renderedTableRange(view, grid);
    const current = currentTable && tableCellRange(view.state.doc, currentTable.first, currentTable.last, row, column);
    if (!current || current.source !== source.source || current.padding !== source.padding) {
      new Notice("表格内容已变化，本次单元格编辑未写入。");
      return;
    }
    const escaped = text.replace(/(\\[\s\S])|\|/g, (_value, alreadyEscaped: string | undefined) => alreadyEscaped ?? "\\|")
      .replace(/\r?\n/g, "<br>");
    view.dispatch({ changes: { from: current.from, to: current.to, insert: current.padding + escaped }, userEvent: "input" });
  };
  cellEdits.set(view, finish);
  input.addEventListener("blur", () => finish(true), { once: true });
  input.addEventListener("keydown", key => {
    key.stopPropagation();
    if (key.isComposing || (key.key !== "Enter" && key.key !== "Escape")) return;
    key.preventDefault();
    finish(key.key === "Enter");
    view.focus();
  });
  input.focus();
  input.setSelectionRange(caret, caret);
}

function clickedSourcePosition(view: EditorView, event: MouseEvent, element: HTMLElement, start: number): number | null {
  const { doc } = view.state;
  const block = calloutAt(doc, start);
  if (!block || block.from !== start) return null;
  const content = element.closest("h1, h2, h3, h4, h5, h6, p, li, pre");
  if (!content || !element.closest(".callout")?.contains(content)) return null;
  const rawText = content.textContent.trim();
  const fullOffset = caretTextOffset(content, event);
  const segmentStart = fullOffset === 0 ? 0 : rawText.lastIndexOf("\n", fullOffset - 1) + 1;
  const segmentEnd = rawText.indexOf("\n", fullOffset);
  const rendered = rawText.slice(segmentStart, segmentEnd < 0 ? undefined : segmentEnd).trim();
  if (!rendered) return null;
  const offset = Math.max(0, fullOffset - segmentStart);
  const matches: number[] = [];
  for (let number = block.first + 1; number <= block.last; number++) {
    const line = doc.line(number);
    const prefix = quote.exec(line.text)![0].length;
    const body = line.text.slice(prefix);
    const h = heading.exec(body);
    if (/^H[1-6]$/.test(content.tagName) && h?.[1].length !== Number(content.tagName[1])) continue;
    if (content.matches("li") && !list.test(body)) continue;
    if (content.matches("p") && (h || list.test(body))) continue;
    const offsets = textOffsets(body, rendered);
    if (offsets.length !== rendered.length) continue;
    const column = offsets[offset] ?? offsets[offsets.length - 1] + 1;
    matches.push(line.from + prefix + column);
  }
  if (matches.length === 1) return matches[0];
  const duplicates = [...element.closest(".callout")!.querySelectorAll(content.tagName)]
    .filter(candidate => candidate.textContent.trim() === rawText);
  return matches.length === duplicates.length ? matches[duplicates.indexOf(content)] ?? null : null;
}

class TaskCheckbox extends WidgetType {
  constructor(private checked: boolean) { super(); }
  eq(other: TaskCheckbox): boolean { return this.checked === other.checked; }
  toDOM(view: EditorView): HTMLElement {
    const input = view.dom.ownerDocument.win.createEl("input");
    input.type = "checkbox";
    input.className = "task-list-item-checkbox simple-callout-task";
    input.setAttribute("aria-label", "切换任务状态");
    input.checked = this.checked;
    input.addEventListener("mousedown", event => event.preventDefault());
    input.addEventListener("change", () => {
      const from = view.posAtDOM(input);
      const marker = view.state.doc.sliceString(from, from + 3);
      if (/^\[[ xX]\]$/.test(marker)) {
        view.dispatch({ changes: { from: from + 1, to: from + 2, insert: input.checked ? "x" : " " }, userEvent: "input" });
      }
    });
    return input;
  }
}

class CalloutSourceButton extends WidgetType {
  eq(): boolean { return true; }

  toDOM(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.win.createEl("button", {
      cls: "clickable-icon simple-callout-source-button",
      attr: { type: "button", "aria-label": "编辑这个区块" },
    });
    setIcon(button, "code-2");
    setTooltip(button, "编辑这个区块");
    button.addEventListener("pointerdown", event => event.preventDefault());
    button.addEventListener("click", () => {
      const block = calloutAt(view.state.doc, view.posAtDOM(button));
      if (!block) return;
      view.focus();
      view.dispatch({ effects: showSource.of(block.from), selection: { anchor: block.to, head: block.from } });
    });
    return button;
  }
}

function isLive(state: EditorState): boolean {
  return !!state.field(editorLivePreviewField, false);
}

function foldingTitle(target: HTMLElement): HTMLElement | null {
  if (target.closest("a, button, input, .callout-fold")) return null;
  const live = target.closest<HTMLElement>(".simple-callout-foldable-title");
  if (live) return live;
  const native = target.closest<HTMLElement>(".cm-callout .callout.is-collapsible > .callout-title");
  return native?.parentElement?.parentElement?.closest(".callout") ? null : native;
}

const calloutLiveEditing = ViewPlugin.fromClass(class {
  decorations = Decoration.none;

  constructor(private view: EditorView) {
    view.contentDOM.addEventListener("pointerdown", this.pointerDown, true);
    view.contentDOM.addEventListener("click", this.click, true);
    this.draw();
  }

  destroy(): void {
    this.view.contentDOM.removeEventListener("pointerdown", this.pointerDown, true);
    this.view.contentDOM.removeEventListener("click", this.click, true);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        update.startState.field(display, false) !== update.state.field(display, false) ||
        isLive(update.startState) !== isLive(update.state) || syntaxTree(update.startState) !== syntaxTree(update.state)) this.draw();
  }

  private click = (event: MouseEvent): void => {
    const { view } = this;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || !isLive(view.state)) return;
    const title = foldingTitle(event.target as HTMLElement);
    if (!title) return;
    event.preventDefault();
    event.stopPropagation();
    if (title.matches(".callout-title")) {
      title.querySelector<HTMLElement>(".callout-fold")?.click();
      return;
    }
    const { doc } = view.state;
    const block = calloutAt(doc, view.posAtDOM(title));
    if (!block) return;
    const outside = block.from > 0 ? block.from - 1 : block.to < doc.length ? block.to + 1 : null;
    if (outside === null) view.contentDOM.blur();
    view.dispatch({ selection: { anchor: outside ?? block.from }, userEvent: "select.pointer" });
    const preview = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-callout")]
      .find(widget => view.posAtDOM(widget) === block.from);
    preview?.querySelector<HTMLElement>(".callout.is-collapsible:not(.is-collapsed) > .callout-title > .callout-fold")?.click();
  };

  private pointerDown = (event: PointerEvent): void => {
    const { view } = this;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || !isLive(view.state)) return;
    const target = event.target as HTMLElement;
    if (foldingTitle(target)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const widget = target.closest<HTMLElement>(".cm-callout.cm-embed-block");
    if (!widget) return;
    const start = view.posAtDOM(widget);
    if (target.closest(".edit-block-button")) {
      view.dispatch({ effects: showSource.of(start) });
      return;
    }
    if (target.closest("a, button, input, .callout-title, .internal-embed, .external-link")) return;
    const callout = target.closest<HTMLElement>(".callout");
    if (!callout || callout.parentElement?.closest(".callout")) return;
    const cell = target.closest<HTMLTableCellElement>("th, td");
    if (cell) {
      editTableCell(view, event, cell);
      return;
    }
    const pos = clickedSourcePosition(view, event, target, start);
    if (pos === null) return;
    const win = widget.ownerDocument.defaultView!;
    const background = win.getComputedStyle(callout).backgroundColor;
    const color = win.getComputedStyle(callout.querySelector(".callout-title") ?? callout).color;
    const appearance = { from: start, style: `--simple-callout-bg:${background};--simple-callout-fg:${color}` };
    // Obsidian delays rebuilding its widget while a native mouse selection is in progress.
    event.preventDefault();
    event.stopPropagation();
    view.focus();
    view.dispatch({ effects: setAppearance.of(appearance), selection: { anchor: event.shiftKey ? view.state.selection.main.anchor : pos, head: pos }, scrollIntoView: true, userEvent: "select.pointer" });
  };

  private draw(): void {
    const { state, visibleRanges } = this.view;
    const ranges = [];
    const appearance = state.field(display, false)?.appearance;
    for (const block of activeCallouts(state)) {
      let code: string | undefined;
      const type = block.header[1].toLowerCase();
      const style = appearance?.from === block.from ? appearance.style : "";
      for (let number = block.first; number <= block.last; number++) {
        const line = state.doc.line(number);
        const active = state.selection.ranges.some(range => range.from <= line.to && range.to >= line.from);
        const header = number === block.first;
        const prefix = quote.exec(line.text)![0].length;
        const body = line.text.slice(prefix);
        const delimiter = fence.exec(body)?.[1];
        const inCode = Boolean(code || delimiter);
        if (!code) code = delimiter;
        else if (delimiter?.startsWith(code)) code = undefined;
        if (!visibleRanges.some(range => range.from <= line.to && range.to >= line.from)) continue;

        const classes = ["simple-callout-line"];
        if (active) classes.push("simple-callout-edit-line");
        if (header) classes.push("simple-callout-title-line");
        if (header && block.header[2]) classes.push("simple-callout-foldable-title");
        if (number === block.last) classes.push("simple-callout-last-line");
        const h = header || inCode ? null : heading.exec(body);
        const item = header || inCode || h ? null : list.exec(body);
        if (h) classes.push("simple-callout-heading");
        if (item) classes.push("simple-callout-list");
        const attributes: Record<string, string> = { class: classes.join(" "), "data-simple-callout": type, style };
        if (h) attributes["data-heading-level"] = String(h[1].length);
        if (item) attributes.style += `;--simple-callout-indent:${item[1].replace(/\t/g, "    ").length}ch`;
        ranges.push(Decoration.line({ attributes }).range(line.from));
        if (header) ranges.push(Decoration.widget({ widget: new CalloutSourceButton(), side: 1 }).range(line.to));

        const markerEnd = header && !active ? block.header[0].length : prefix;
        if (markerEnd) ranges.push(Decoration.replace({}).range(line.from, line.from + markerEnd));
        const bodyFrom = line.from + prefix;
        if (h && !active) ranges.push(Decoration.replace({}).range(bodyFrom, bodyFrom + h[0].length));
        if (h && active) ranges.push(Decoration.mark({ class: "simple-callout-heading-marker" }).range(bodyFrom, bodyFrom + h[1].length));
        // Obsidian can expose the toolbar's inline HTML as text when the callout opens for editing.
        if (!active && !inCode) {
          for (const match of body.matchAll(inlineFormat)) {
            const from = bodyFrom + match.index;
            if (!syntaxTree(state).resolveInner(from, 1).name.includes("hmd-html-begin")) continue;
            const textFrom = from + match[0].indexOf(">") + 1;
            const textTo = textFrom + match[3].length;
            ranges.push(
              Decoration.replace({}).range(from, textFrom),
              Decoration.mark({ tagName: match[1].toLowerCase(), attributes: { style: match[2] ?? "" } }).range(textFrom, textTo),
              Decoration.replace({}).range(textTo, from + match[0].length),
            );
          }
        }
        if (!item || active) continue;
        const markerFrom = bodyFrom + item[1].length;
        const markerTo = bodyFrom + item[0].length - (item[3]?.length ?? 0);
        if (item[3]) {
          ranges.push(Decoration.replace({}).range(bodyFrom, markerTo));
          ranges.push(Decoration.replace({ widget: new TaskCheckbox(item[3][1].toLowerCase() === "x") }).range(markerTo, bodyFrom + item[0].length));
        } else if (item[2].length === 1 && /[-+*]/.test(item[2])) {
          ranges.push(Decoration.mark({ class: "simple-callout-bullet" }).range(markerFrom, markerTo));
        }
      }
    }
    this.decorations = Decoration.set(ranges, true);
  }
}, { decorations: plugin => plugin.decorations });

class CalloutTable extends WidgetType {
  private static components = new WeakMap<HTMLElement, Component>();
  constructor(private app: App, private path: string, private lines: string[], private style: string) { super(); }
  eq(other: CalloutTable): boolean {
    return this.path === other.path && this.style === other.style && this.lines.join("\n") === other.lines.join("\n");
  }
  toDOM(view: EditorView): HTMLElement {
    const host = view.dom.ownerDocument.win.createDiv({ cls: "markdown-rendered simple-callout-table" });
    host.style.cssText = this.style;
    const component = new Component();
    component.load();
    CalloutTable.components.set(host, component);
    void MarkdownRenderer.render(this.app, this.lines.join("\n"), host, this.path, component).catch(reportError);
    host.addEventListener("pointerdown", event => {
      const target = event.target as HTMLElement;
      if (event.button !== 0 || event.ctrlKey || event.metaKey || target.closest("a, input, button")) return;
      const cell = target.closest<HTMLTableCellElement>("th, td");
      if (!cell) return;
      editTableCell(view, event, cell);
    });
    return host;
  }
  destroy(dom: HTMLElement): void {
    CalloutTable.components.get(dom)?.unload();
    CalloutTable.components.delete(dom);
  }
}

export function calloutEditingExtensions(app: App) {
  const tables = (state: EditorState) => {
    const ranges = [];
    const appearance = state.field(display, false)?.appearance;
    const path = state.field(editorInfoField, false)?.file?.path ?? "";
    for (const block of activeCallouts(state)) {
      const style = appearance?.from === block.from ? appearance.style : "";
      for (const table of calloutTables(state.doc, block)) {
        const from = state.doc.line(table.first).from;
        const to = state.doc.line(table.last).to;
        const lines = Array.from({ length: table.last - table.first + 1 }, (_, offset) => quotedBody(state.doc, table.first + offset));
        ranges.push(Decoration.replace({ block: true, widget: new CalloutTable(app, path, lines, style) }).range(from, to));
      }
    }
    return Decoration.set(ranges, true);
  };
  const tableWidgets = StateField.define({
    create: tables,
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.startState.field(display, false) !== tr.state.field(display, false) ||
          syntaxTree(tr.startState) !== syntaxTree(tr.state) || isLive(tr.startState) !== isLive(tr.state)) return tables(tr.state);
      return value;
    },
    provide: field => EditorView.decorations.from(field),
  });
  return [display, calloutLiveEditing, tableWidgets, EditorView.atomicRanges.of(view => view.state.field(tableWidgets, false) ?? Decoration.none)];
}
