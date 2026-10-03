import { StateEffect } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

const COLOR_PATTERN =
  /#[0-9a-fA-F]{3,4}\b|#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|rgba?\(\s*[^)\r\n]+\)|hsla?\(\s*[^)\r\n]+\)/g;
const EXACT_COLOR_PATTERN =
  /^(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|rgba?\(\s*[^)\r\n]+\)|hsla?\(\s*[^)\r\n]+\))$/;

export const refreshColorPreview = StateEffect.define<void>();

class ColorSwatchWidget extends WidgetType {
  constructor(private readonly color: string) {
    super();
  }

  eq(other: ColorSwatchWidget): boolean {
    return other.color === this.color;
  }

  toDOM(): HTMLElement {
    return createColorSwatch(this.color);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function observeRenderedColorPreviews(
  root: HTMLElement,
  isEnabled: () => boolean
): MutationObserver {
  const update = (node: Node) => {
    if (!(node.instanceOf(HTMLElement))) return;
    if (isEnabled()) {
      decorateRenderedTables(node);
    } else {
      clearRenderedColorPreviews(node);
    }
  };

  update(root);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) update(node);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}

export function refreshRenderedColorPreviews(
  root: HTMLElement,
  enabled: boolean
): void {
  if (enabled) {
    decorateRenderedTables(root);
  } else {
    clearRenderedColorPreviews(root);
  }
}

export function colorPreviewExtension(isEnabled: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, isEnabled());
      }

      update(update: ViewUpdate): void {
        const shouldRefresh =
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(refreshColorPreview))
          );

        if (shouldRefresh) {
          this.decorations = buildDecorations(update.view, isEnabled());
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    }
  );
}

function buildDecorations(view: EditorView, enabled: boolean): DecorationSet {
  if (!enabled) return Decoration.none;

  const decorations: Array<{
    from: number;
    to: number;
    value: Decoration;
  }> = [];
  const excludedLines = findFrontmatterLines(view);

  for (const range of view.visibleRanges) {
    let position = range.from;

    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      if (!excludedLines.has(line.number)) {
        COLOR_PATTERN.lastIndex = 0;
        for (const match of line.text.matchAll(COLOR_PATTERN)) {
          if (match.index === undefined || !isValidCssColor(match[0])) continue;

          const from = line.from + match.index;
          const to = from + match[0].length;
          decorations.push(
            {
              from,
              to: from,
              value: Decoration.widget({
                widget: new ColorSwatchWidget(match[0]),
                side: -1,
              }),
            },
            {
              from,
              to,
              value: Decoration.mark({
                class: "simple-color-value",
              }),
            }
          );
        }
      }

      if (line.to >= range.to || line.number === view.state.doc.lines) break;
      position = line.to + 1;
    }
  }

  return Decoration.set(
    decorations.map(({ from, to, value }) => value.range(from, to)),
    true
  );
}

function findFrontmatterLines(view: EditorView): Set<number> {
  const excluded = new Set<number>();
  const doc = view.state.doc;
  let inFrontmatter = doc.lines > 0 && doc.line(1).text.trim() === "---";

  for (let number = 1; number <= doc.lines; number++) {
    const text = doc.line(number).text.trim();

    if (inFrontmatter) {
      excluded.add(number);
      if (number > 1 && text === "---") inFrontmatter = false;
    }
  }

  return excluded;
}

function isValidCssColor(value: string): boolean {
  return CSS.supports("color", value);
}

function decorateRenderedTables(root: HTMLElement): void {
  const wrappers = root.matches(".table-cell-wrapper")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(".table-cell-wrapper"));

  for (const wrapper of wrappers) {
    const valueElement = findRenderedColorElement(wrapper);
    if (!valueElement || valueElement.dataset.simpleColorPreview === "true") {
      continue;
    }

    const color = valueElement.textContent?.trim() ?? "";
    if (!EXACT_COLOR_PATTERN.test(color) || !isValidCssColor(color)) continue;

    valueElement.dataset.simpleColorPreview = "true";
    valueElement.classList.add("simple-rendered-color-value");
    const swatch = createColorSwatch(color, true);
    if (valueElement === wrapper) {
      wrapper.prepend(swatch);
    } else {
      valueElement.before(swatch);
    }
  }
}

function findRenderedColorElement(wrapper: HTMLElement): HTMLElement | null {
  const directElements = Array.from(wrapper.children).filter(
    (element): element is HTMLElement =>
      element.instanceOf(HTMLElement) &&
      !element.classList.contains("simple-color-swatch")
  );

  if (directElements.length === 1) return directElements[0];
  if (directElements.length === 0 && wrapper.textContent?.trim()) return wrapper;
  return null;
}

function clearRenderedColorPreviews(root: HTMLElement): void {
  if (root.matches(".simple-rendered-color-swatch")) root.remove();
  root
    .querySelectorAll<HTMLElement>(".simple-rendered-color-swatch")
    .forEach((element) => element.remove());

  const values = root.matches(".simple-rendered-color-value")
    ? [root]
    : Array.from(
        root.querySelectorAll<HTMLElement>(".simple-rendered-color-value")
      );
  for (const value of values) {
    value.classList.remove("simple-rendered-color-value");
    delete value.dataset.simpleColorPreview;
  }
}

function createColorSwatch(color: string, rendered = false): HTMLElement {
  const swatch = createSpan();
  swatch.className = rendered
    ? "simple-color-swatch simple-rendered-color-swatch"
    : "simple-color-swatch";
  swatch.style.backgroundColor = color;
  swatch.setAttribute("aria-label", `颜色预览：${color}`);
  swatch.setAttribute("title", color);
  return swatch;
}
