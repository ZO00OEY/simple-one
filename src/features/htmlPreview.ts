import { runAsync } from "../shared/async";
import { editorInfoField, Notice } from "obsidian";
import { confirmAction } from "../shared/confirm";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { HtmlPreviewRule } from "../types";

export const refreshHtmlPreview = StateEffect.define<void>();
const toggleHtmlSource = StateEffect.define<number>();
const inlineHtmlSources = new WeakMap<HTMLElement, Node[]>();
const previewStyles = new WeakMap<HTMLElement, CSSStyleSheet>();

type HtmlPreviewState = {
  decorations: DecorationSet;
  expanded: Set<number>;
};

type PreviewRange = {
  from: number;
  to: number;
};

class HtmlPreviewWidget extends WidgetType {
  constructor(
    private readonly html: string,
    private readonly from: number,
    private readonly to: number,
    private readonly source: string,
    private readonly expanded: boolean
  ) {
    super();
  }

  eq(other: HtmlPreviewWidget): boolean {
    return other.html === this.html &&
      other.from === this.from &&
      other.to === this.to &&
      other.source === this.source &&
      other.expanded === this.expanded;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = createDiv();
    wrap.className = "simple-html-preview-live-container";
    wrap.append(createHtmlPreview(this.html));

    const actions = createDiv();
    actions.className = "simple-html-preview-actions";

    const button = createEl("button");
    button.className = "simple-html-preview-toggle";
    button.type = "button";
    button.textContent = this.expanded ? "\u6536\u8d77\u6e90\u7801" : "\u5c55\u5f00\u6e90\u7801";
    const toggle = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: toggleHtmlSource.of(this.from) });
    };
    button.addEventListener("pointerdown", toggle);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      toggle(event);
    });
    actions.append(button);

    const copyButton = createActionButton("复制", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard.writeText(this.source).then(() => {
        copyButton.textContent = "已复制";
        window.setTimeout(() => {
          copyButton.textContent = "复制";
        }, 1000);
      }).catch(() => {
        copyButton.textContent = "复制失败";
        window.setTimeout(() => {
          copyButton.textContent = "复制";
        }, 1200);
      });
    });
    actions.append(copyButton);

    const cutButton = createActionButton("剪贴", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard.writeText(this.source).then(() => {
        view.dispatch({ changes: { from: this.from, to: this.to, insert: "" } });
      });
    });
    actions.append(cutButton);

    const deleteButton = createActionButton("删除", runAsync(async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const doc = view.state.doc;
      const info = view.state.field(editorInfoField, false);
      if (!info || !await confirmAction(info.app, "删除整段 HTML 源码？")) return;
      if (view.state.doc !== doc) { new Notice("笔记已变化，请重新选择要删除的内容。"); return; }
      view.dispatch({ changes: { from: this.from, to: this.to, insert: "" } });
    }));
    actions.append(deleteButton);

    wrap.append(actions);
    if (this.expanded) {
      const sourcePanel = createEl("pre");
      sourcePanel.className = "simple-html-preview-source-panel";
      sourcePanel.textContent = this.source;
      const bottomActions = createDiv();
      bottomActions.className = "simple-html-preview-bottom-actions";
      bottomActions.append(createIconActionButton("eye-off", "\u6536\u8d77\u6e90\u7801", toggle));
      sourcePanel.append(bottomActions);
      wrap.append(sourcePanel);
    }

    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    clearPreviewStyles(dom);
  }
}

function createActionButton(text: string, onPointerDown: (event: Event) => void): HTMLButtonElement {
  const button = createEl("button");
  button.className = "simple-html-preview-toggle";
  button.type = "button";
  button.textContent = text;
  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return button;
}

function createIconActionButton(icon: string, label: string, onPointerDown: (event: Event) => void): HTMLButtonElement {
  const button = createActionButton("", onPointerDown);
  button.classList.add("simple-html-preview-icon-toggle");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  const svg = createSvg("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (icon === "eye-off") {
    svg.innerHTML = '<path d="M10.7 5.1A9.7 9.7 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13.1 13.1 0 0 1-2.1 3.2" /><path d="M6.6 6.6A13.5 13.5 0 0 0 2.5 12c1 2.5 4.5 7 9.5 7a9.7 9.7 0 0 0 4.4-1.1" /><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2" /><path d="M3 3l18 18" />';
  }
  button.append(svg);
  return button;
}

export function htmlPreviewExtension(
  isEnabled: () => boolean,
  getRules: () => HtmlPreviewRule[] = () => []
) {
  return StateField.define<HtmlPreviewState>({
    create(state): HtmlPreviewState {
      const expanded = new Set<number>();
      return {
        expanded,
        decorations: buildHtmlDecorations(state, isEnabled(), expanded, getRules()),
      };
    },
    update(value, transaction): HtmlPreviewState {
      const shouldRefresh =
        transaction.docChanged ||
        transaction.effects.some((effect) =>
          effect.is(refreshHtmlPreview) || effect.is(toggleHtmlSource)
        );

      if (!shouldRefresh) return value;

      const expanded = new Set<number>();
      value.expanded.forEach((position) => {
        expanded.add(transaction.changes.mapPos(position));
      });
      for (const effect of transaction.effects) {
        if (!effect.is(toggleHtmlSource)) continue;
        const position = effect.value;
        if (expanded.has(position)) {
          expanded.delete(position);
        } else {
          expanded.add(position);
        }
      }

      return {
        expanded,
        decorations: buildHtmlDecorations(transaction.state, isEnabled(), expanded, getRules()),
      };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });
}

export function observeRenderedHtmlPreviews(
  root: HTMLElement,
  isEnabled: () => boolean,
  getRules: () => HtmlPreviewRule[] = () => []
): MutationObserver {
  const update = (node: Node) => {
    if (!(node.instanceOf(HTMLElement))) return;
    if (isEnabled()) {
      decorateHtmlPreviews(node, getRules());
      decorateInlineHtmlEmbeds(node, getRules());
    } else {
      clearHtmlPreviews(node);
      clearInlineHtmlEmbeds(node);
    }
  };

  update(root);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) update(node);
      for (const node of mutation.removedNodes) {
        if (node.instanceOf(HTMLElement)) clearPreviewStyles(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}

export function refreshRenderedHtmlPreviews(
  root: HTMLElement,
  enabled: boolean,
  rules: HtmlPreviewRule[] = []
): void {
  if (!enabled) {
    clearHtmlPreviews(root);
    return;
  }

  clearHtmlPreviews(root);
  clearInlineHtmlEmbeds(root);
  decorateHtmlPreviews(root, rules);
  decorateInlineHtmlEmbeds(root, rules);
}

function buildHtmlDecorations(
  state: EditorState,
  enabled: boolean,
  expanded: Set<number>,
  rules: HtmlPreviewRule[] = []
): DecorationSet {
  if (!enabled) return Decoration.none;

  const decorations: Array<ReturnType<Decoration["range"]>> = [];
  const ranges: PreviewRange[] = [];
  const doc = state.doc;
  let lineNo = 1;

  while (lineNo <= doc.lines) {
    const startLine = doc.line(lineNo);
    if (!/^```html\s*$/i.test(startLine.text.trim())) {
      lineNo++;
      continue;
    }

    const content: string[] = [];
    let endLineNo = lineNo + 1;
    while (endLineNo <= doc.lines) {
      const line = doc.line(endLineNo);
      if (/^```\s*$/.test(line.text.trim())) break;
      content.push(line.text);
      endLineNo++;
    }

    const html = content.join("\n");
    if (looksLikeHtml(html)) {
      const isExpanded = expanded.has(startLine.from);
      const endLine = doc.line(Math.min(endLineNo, doc.lines));
      const to = endLineNo < doc.lines ? endLine.to + 1 : endLine.to;
      const source = doc.sliceString(startLine.from, to);
      ranges.push({ from: startLine.from, to });
      const widget = new HtmlPreviewWidget(
        applyHtmlPreviewRules(html, rules),
        startLine.from,
        to,
        source,
        isExpanded
      );
      if (isExpanded) {
        decorations.push(
          Decoration.replace({
            widget,
            block: true,
          }).range(startLine.from, to)
        );
      } else {
        decorations.push(
          Decoration.replace({
            widget,
            block: true,
          }).range(startLine.from, endLine.to)
        );
      }
    }

    lineNo = endLineNo + 1;
  }

  const text = doc.toString();
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue;
    let regex: RegExp;
    try {
      regex = makeRuleRegex(rule, true);
    } catch {
      continue;
    }
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined || !match[0]) continue;
      const from = match.index;
      const to = from + match[0].length;
      const sourceRange = expandFenceRange(doc, from, to);
      if (ranges.some((range) => sourceRange.from < range.to && sourceRange.to > range.from)) continue;
      const html = unwrapHtmlFence(match[0].replace(makeRuleRegex(rule), rule.replaceWith));
      if (!looksLikeHtml(html)) continue;
      ranges.push(sourceRange);
      const isExpanded = expanded.has(sourceRange.from);
      const widget = new HtmlPreviewWidget(
        html,
        sourceRange.from,
        sourceRange.to,
        doc.sliceString(sourceRange.from, sourceRange.to),
        isExpanded
      );
      if (isExpanded) {
        decorations.push(
          Decoration.replace({
            widget,
            block: true,
          }).range(sourceRange.from, sourceRange.to)
        );
      } else {
        decorations.push(
          Decoration.replace({
            widget,
            block: true,
          }).range(sourceRange.from, sourceRange.to)
        );
      }
    }
  }

  return Decoration.set(decorations, true);
}

function expandFenceRange(doc: EditorState["doc"], from: number, to: number): PreviewRange {
  let start = from;
  let end = to;
  const startLine = doc.lineAt(from);
  if (startLine.number > 1) {
    const previous = doc.line(startLine.number - 1);
    if (/^```(?:html)?\s*$/i.test(previous.text.trim())) {
      start = previous.from;
    }
  }

  const endLine = doc.lineAt(to);
  if (endLine.number < doc.lines) {
    const next = doc.line(endLine.number + 1);
    if (/^```\s*$/.test(next.text.trim())) {
      end = next.to;
    }
  }
  return { from: start, to: end };
}

function decorateHtmlPreviews(root: HTMLElement, rules: HtmlPreviewRule[] = []): void {
  for (const pre of findHtmlCodeBlocks(root)) {
    if (pre.dataset.simpleHtmlPreview === "true") continue;

    const raw = unwrapHtmlFence(pre.textContent ?? "");
    if (!looksLikeHtml(raw)) continue;

    pre.dataset.simpleHtmlPreview = "true";
    pre.before(createHtmlPreview(applyHtmlPreviewRules(raw, rules)));
  }
}

function clearHtmlPreviews(root: HTMLElement): void {
  const previews = root.matches(".simple-html-preview")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(".simple-html-preview"));
  previews.forEach((preview) => {
    clearPreviewStyles(preview);
    const pre = preview.nextElementSibling;
    if (pre instanceof HTMLElement) delete pre.dataset.simpleHtmlPreview;
    preview.remove();
  });
}

function decorateInlineHtmlEmbeds(root: HTMLElement, rules: HtmlPreviewRule[] = []): void {
  for (const embed of findInlineHtmlEmbeds(root)) {
    if (embed.dataset.simpleHtmlRulePreview === "true") continue;
    const raw = embed.innerHTML;
    const html = applyHtmlPreviewRules(raw, rules);
    if (html === raw || !looksLikeHtml(html)) continue;
    embed.dataset.simpleHtmlRulePreview = "true";
    inlineHtmlSources.set(embed, Array.from(embed.childNodes));
    embed.replaceChildren(renderHtmlPreview(html));
  }
}

function clearInlineHtmlEmbeds(root: HTMLElement): void {
  const embeds = root.matches(".cm-html-embed[data-simple-html-rule-preview='true']")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(".cm-html-embed[data-simple-html-rule-preview='true']"));
  embeds.forEach((embed) => {
    clearPreviewStyles(embed);
    const originalNodes = inlineHtmlSources.get(embed);
    if (originalNodes) embed.replaceChildren(...originalNodes);
    inlineHtmlSources.delete(embed);
    delete embed.dataset.simpleHtmlRulePreview;
  });
}

function findInlineHtmlEmbeds(root: HTMLElement): HTMLElement[] {
  const selector = ".markdown-source-view.is-live-preview .cm-html-embed";
  const embeds = root.matches(selector)
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(selector));
  return embeds.filter((embed): embed is HTMLElement => embed.instanceOf(HTMLElement));
}

function findHtmlCodeBlocks(root: HTMLElement): HTMLPreElement[] {
  const selector = [
    "pre",
    ".markdown-rendered pre",
    ".markdown-preview-view pre",
  ].join(",");

  const blocks = root.matches(selector)
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(selector));

  return blocks.filter((block): block is HTMLPreElement =>
    block.instanceOf(HTMLPreElement) &&
    isHtmlCodeBlock(block) &&
    block.closest(".simple-html-preview, .simple-html-preview-live-container") === null
  );
}

function isHtmlCodeBlock(pre: HTMLPreElement): boolean {
  const code = pre.querySelector("code");
  const className = `${pre.className} ${code?.className ?? ""}`;
  return /\blanguage-html\b|\blang-html\b/i.test(className) ||
    /^```html\s*$/i.test((pre.textContent ?? "").trim().split("\n")[0] ?? "");
}

function renderHtmlPreview(raw: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const css = Array.from(doc.querySelectorAll("style"))
    .map((node) => node.textContent ?? "")
    .join("\n");
  sanitizeDocument(doc);

  const fragment = createFragment();
  const surface = createDiv();
  const scope = `simple-html-scope-${Math.random().toString(36).slice(2)}`;
  surface.className = `simple-html-preview-surface ${scope}`;
  for (const className of Array.from(doc.body.classList)) {
    surface.classList.add(className);
  }
  Array.from(doc.body.childNodes).forEach((node) =>
    surface.append(node.cloneNode(true))
  );
  addPreviewInteractions(surface);
  if (css.trim()) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(scopeCss(css, scope));
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      previewStyles.set(surface, sheet);
    } catch {
      // Invalid CSS must not prevent the HTML preview from rendering.
    }
  }
  fragment.append(surface);
  return fragment;
}

function clearPreviewStyles(root: HTMLElement): void {
  const surfaces = root.matches(".simple-html-preview-surface")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(".simple-html-preview-surface"));
  for (const surface of surfaces) {
    const sheet = previewStyles.get(surface);
    if (!sheet) continue;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((current) => current !== sheet);
    previewStyles.delete(surface);
  }
}

function createHtmlPreview(raw: string): HTMLElement {
  const preview = createSpan();
  preview.className = "simple-html-preview";
  preview.append(renderHtmlPreview(raw));
  return preview;
}

function applyHtmlPreviewRules(raw: string, rules: HtmlPreviewRule[]): string {
  let html = raw;
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue;
    try {
      html = unwrapHtmlFence(html.replace(makeRuleRegex(rule), rule.replaceWith));
    } catch {
      // Invalid user regex should not break the preview.
    }
  }
  return html;
}

function makeRuleRegex(rule: HtmlPreviewRule, forceGlobal = false): RegExp {
  const flags = forceGlobal && !(rule.flags || "").includes("g")
    ? `${rule.flags || ""}g`
    : rule.flags || "g";
  return new RegExp(normalizeRulePattern(rule.pattern), flags);
}

function normalizeRulePattern(pattern: string): string {
  if (pattern === "([\\s\\S]*?)<\\/(think_nya~|thinking|think)>") {
    return "<(?:think_nya~|thinking|think)>([\\s\\S]*?)<\\/(?:think_nya~|thinking|think)>";
  }
  return pattern;
}

function sanitizeDocument(doc: Document): void {
  doc.querySelectorAll("script, iframe, object, embed, style, link").forEach((node) => node.remove());
  doc.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:")) {
        element.removeAttribute(attr.name);
      }
    }
  });
}

function addPreviewInteractions(surface: HTMLElement): void {
  const themeBtn =
    surface.querySelector("#themeBtn") ||
    Array.from(surface.querySelectorAll(".action-btn")).find((el) =>
      /墨色|主题|夜/.test(el.textContent || "")
    );
  if (themeBtn) {
    themeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      surface.classList.toggle("theme-ink");
      themeBtn.classList.toggle("active", surface.classList.contains("theme-ink"));
    });
  }

  surface
    .querySelectorAll(".recall-section .section-header, .supplement-section .section-header")
    .forEach((header) => {
      header.addEventListener("click", (event) => {
        event.preventDefault();
        header
          .closest(".recall-section, .supplement-section")
          ?.classList.toggle("collapsed");
      });
    });

  addTxPackInteractions(surface);
}

function addTxPackInteractions(surface: HTMLElement): void {
  const wrappers = surface.matches(".tx-pack-wrapper")
    ? [surface]
    : Array.from(surface.querySelectorAll<HTMLElement>(".tx-pack-wrapper"));
  wrappers.forEach((wrapper) => {
    if (wrapper.dataset.simpleTxPackBound === "true") return;
    wrapper.dataset.simpleTxPackBound = "true";

    wrapper.querySelector<HTMLElement>(".theme-switch")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      wrapper.classList.toggle("night-mode");
      const button = event.currentTarget;
      if (button instanceof HTMLElement) {
        button.textContent = wrapper.classList.contains("night-mode") ? "☀" : "🌙";
      }
    });

    wrapper.querySelector<HTMLElement>(".tx-pack-toggle")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ui = wrapper.querySelector<HTMLElement>(".tx-pack-interface");
      const icon = wrapper.querySelector<HTMLElement>(".tx-icon");
      if (!ui) return;
      const isHidden = getComputedStyle(ui).display === "none";
      ui.style.display = isHidden ? "block" : "none";
      if (icon) icon.textContent = isHidden ? "-" : "+";
      if (!isHidden || wrapper.dataset.parsed === "true") return;

      renderTxPackPanels(wrapper);
      wrapper.dataset.parsed = "true";
    });
  });
}

function renderTxPackPanels(wrapper: HTMLElement): void {
  const raw = wrapper.querySelector<HTMLElement>(".tx-pack-raw")?.innerHTML ?? "";
  const tabsBox = wrapper.querySelector<HTMLElement>(".tx-pack-tabs");
  const viewBox = wrapper.querySelector<HTMLElement>(".tx-pack-viewport");
  if (!raw || !tabsBox || !viewBox) return;

  const temp = new DOMParser().parseFromString(raw, "text/html");
  sanitizeDocument(temp);
  let isFirst = true;
  ["Snapshot", "abstract", "Todo", "seeds", "Events"].forEach((tag) => {
    const content = temp.querySelector(tag)?.innerHTML ??
      raw.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ??
      "";
    if (!content.trim()) return;

    const tab = createDiv();
    tab.className = `tx-pack-btn${isFirst ? " active" : ""}`;
    tab.textContent = tag.toUpperCase();

    const panel = createDiv();
    panel.className = `tx-pack-panel${isFirst ? " active" : ""}`;
    const panelDoc = new DOMParser().parseFromString(content.trim(), "text/html");
    sanitizeDocument(panelDoc);
    panel.append(...Array.from(panelDoc.body.childNodes).map((node) => node.cloneNode(true)));

    tab.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      tabsBox.querySelectorAll(".tx-pack-btn").forEach((button) => button.classList.remove("active"));
      viewBox.querySelectorAll(".tx-pack-panel").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      panel.classList.add("active");
    });

    tabsBox.append(tab);
    viewBox.append(panel);
    isFirst = false;
  });
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function unwrapHtmlFence(value: string): string {
  const match = value.trim().match(/^```(?:html)?\s*\n([\s\S]*?)(?:\n```)?$/i);
  return match ? match[1] : value;
}

function scopeCss(css: string, scope: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (full, rawSelector: string, body: string) => {
    const selector = rawSelector.trim();
    if (!selector || selector.startsWith("@")) return full;
    return `${selector
      .split(",")
      .map((part) => scopeSelector(part.trim(), scope))
      .join(", ")} {${body}}`;
  });
}

function scopeSelector(selector: string, scope: string): string {
  if (!selector) return selector;
  if (selector === ":root" || selector === "html" || selector === "body") return `.${scope}`;
  if (selector.startsWith(":root")) return selector.replace(/^:root/, `.${scope}`);
  if (selector.startsWith("html")) return selector.replace(/^html/, `.${scope}`);
  if (selector.startsWith("body")) return selector.replace(/^body/, `.${scope}`);
  return `.${scope} ${selector}`;
}
