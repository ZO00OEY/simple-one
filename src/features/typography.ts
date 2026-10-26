import { syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type SimplePlugin from "../main";
import { isStandaloneBoldLine, normalizeTypography } from "../shared/typography";
import { displayParameterEnabled } from "../shared/displayProfile";

// Each manually entered body line gets a first-line indent; soft wraps do not.
export function paragraphDecorations(view: EditorView): DecorationSet {
  const lines = new Map<number, Set<string>>();
  const add = (pos: number, cls: string): void => {
    const from = view.state.doc.lineAt(pos).from;
    if (!lines.has(from)) lines.set(from, new Set());
    lines.get(from)!.add(cls);
  };
  for (const range of view.visibleRanges) {
    const doc = view.state.doc;
    const first = Math.max(1, doc.lineAt(range.from).number - 1);
    const last = Math.min(doc.lines, doc.lineAt(range.to).number + 1);
    const blocked = new Set<number>();
    // Obsidian's HyperMD tree omits plain paragraphs; classify its block lines.
    syntaxTree(view.state).iterate({ from: doc.line(first).from, to: doc.line(last).to, enter(ref) {
      if (!/HyperMD-(header|list|quote|codeblock|table|hr)|hmd-frontmatter|Blockquote|ListItem|FencedCode|CodeBlock|Table|HTMLBlock|HorizontalRule|ATXHeading|SetextHeading/.test(ref.name)) return;
      for (let n = doc.lineAt(ref.from).number; n <= doc.lineAt(Math.max(ref.from, ref.to - 1)).number; n++) blocked.add(n);
      return false;
    } });
    const plain = (n: number): boolean => n >= first && n <= last && !blocked.has(n)
      && !!doc.line(n).text.trim()
      && !/^\s*(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3}|~{3}|(?:[-*_]\s*){3,}$|!\[|<)/.test(doc.line(n).text);
    for (let n = first; n <= last; n++) {
      if (!plain(n)) continue;
      const line = doc.line(n);
      if (line.to < range.from || line.from > range.to) continue;
      add(line.from, "simple-typography-paragraph-start");
      if (isStandaloneBoldLine(line.text)) add(line.from, "simple-typography-bold-line");
      if (n === doc.lines || (n < last && !plain(n + 1))) add(line.from, "simple-typography-paragraph-end");
    }
  }
  return Decoration.set([...lines].sort(([a], [b]) => a - b).map(([from, classes]) =>
    Decoration.line({ class: [...classes].join(" ") }).range(from)));
}

export function decorateRenderedLineIndents(root: HTMLElement): void {
  const paragraphs = root.matches("p") ? [root] : [...root.querySelectorAll<HTMLElement>("p")];
  for (const paragraph of paragraphs) {
    if (paragraph.closest("li, blockquote, .callout, td, th, pre")) continue;
    const segments = [{ br: null as HTMLBRElement | null, hasText: false, allBold: true }];
    const visit = (node: Node, bold: boolean): void => {
      const segment = segments[segments.length - 1];
      if (node.nodeType === 3) {
        if (node.textContent?.trim()) { segment.hasText = true; segment.allBold &&= bold; }
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as HTMLElement;
      if (element.classList.contains("simple-typography-line-indent")) return;
      if (element.tagName === "BR") {
        segments.push({ br: element as HTMLBRElement, hasText: false, allBold: true });
        return;
      }
      for (const child of element.childNodes) visit(child, bold || element.tagName === "STRONG" || element.tagName === "B");
    };
    visit(paragraph, false);
    paragraph.classList.toggle("simple-typography-bold-line", segments[0].hasText && segments[0].allBold);
    for (const br of paragraph.querySelectorAll("br")) {
      // Keep the original break and inline markup; the marker only supplies space.
      let marker = br.nextElementSibling;
      if (!marker?.classList.contains("simple-typography-line-indent")) {
        marker = br.doc.win.createSpan({ cls: "simple-typography-line-indent", attr: { "aria-hidden": "true" } });
        br.after(marker);
      }
      const segment = segments.find(segment => segment.br === br)!;
      marker.classList.toggle("simple-typography-bold-line", segment.hasText && segment.allBold);
    }
  }
}

export function registerTypography(plugin: SimplePlugin): () => void {
  if (plugin.isMobile) return () => {};
  const documents = new Set<Document>();
  const properties = ["font-size", "line-height", "letter-spacing", "paragraph-spacing"];
  const clear = (doc: Document): void => {
    doc.body.classList.remove("simple-desktop-typography", "simple-chinese-reading");
    for (const property of properties) doc.body.style.removeProperty('--simple-typography-' + property);
    for (const property of properties) doc.body.classList.remove(`simple-typography-${property}`);
  };
  const apply = (doc: Document): void => {
    documents.add(doc);
    const settings = normalizeTypography(plugin.settings.desktopTypography);
    clear(doc);
    if (settings.paragraphStyle === "indent") {
      doc.body.classList.add("simple-chinese-reading");
    }
    const keys = ["fontSize", "lineHeight", "letterSpacing", "paragraphSpacing"] as const;
    if (!keys.some(key => displayParameterEnabled(plugin.settings, false, key))) return;
    doc.body.classList.add("simple-desktop-typography");
    const values = [
      settings.fontSize + 'px', String(settings.lineHeight),
      settings.letterSpacing + 'px', settings.paragraphSpacing + 'em',
    ];
    properties.forEach((property, i) => {
      if (!displayParameterEnabled(plugin.settings, false, keys[i])) return;
      doc.body.classList.add(`simple-typography-${property}`);
      doc.body.style.setProperty('--simple-typography-' + property, values[i]);
    });
  };
  plugin.registerEditorExtension(ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = paragraphDecorations(view); }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = paragraphDecorations(update.view);
      }
    }
  }, { decorations: view => view.decorations }));
  const refresh = (): void => {
    const docs = new Set<Document>([document, ...documents]);
    plugin.app.workspace.iterateAllLeaves(leaf => {
      docs.add(leaf.getContainer().doc);
      decorateRenderedLineIndents(leaf.view.containerEl);
    });
    for (const doc of docs) apply(doc);
  };
  plugin.registerMarkdownPostProcessor(decorateRenderedLineIndents);
  plugin.registerEvent(plugin.app.workspace.on("window-open", win => apply(win.doc)));
  plugin.registerEvent(plugin.app.workspace.on("window-close", win => {
    clear(win.doc);
    documents.delete(win.doc);
  }));
  plugin.register(() => {
    for (const doc of documents) {
      clear(doc);
      doc.querySelectorAll(".simple-typography-line-indent").forEach(marker => marker.remove());
      doc.querySelectorAll(".simple-typography-bold-line").forEach(element => element.classList.remove("simple-typography-bold-line"));
    }
    documents.clear();
  });
  refresh();
  return refresh;
}
