import { MarkdownView, Notice, setIcon, type Editor, type EditorPosition } from "obsidian";
import type SimplePlugin from "../main";
import type { QuickFormatMode } from "../types";
import { formatSelection, isHeadingMode, modeIcon, modeLabel, visibleModes } from "./quickFormat";
import { applyInlineStyle, clearSpecialFormatting, colorSelection, highlightSelection, orderedFormatTools, useThemeStyle, type FormatTool, type InlineFormatTool } from "./selectionFormatText";
import { setFormatIcon } from "../shared/formatIcon";
import { FAVORITE_COLORS, ThemeColorPicker } from "../shared/themeColorPicker";
import { readCalloutColor } from "../shared/calloutColor";
import { selectionColors, tintSelectionColor } from "./selectionPalettes";
import { translationBridge, SelectionTranslationModal, TranslationSettingsModal } from "./selectionTranslation";

const LABELS: Record<FormatTool, string> = { textColor: "字体颜色", bold: "加粗", italic: "斜体", strike: "删除线", underline: "下划线", highlight: "高亮", heading: "标题", quote: "引用与 Callout" };
const ICONS: Record<FormatTool, string> = { textColor: "baseline", bold: "bold", italic: "italic", strike: "strikethrough", underline: "underline", highlight: "highlighter", heading: "heading", quote: "quote" };
type Target = { view: MarkdownView; editor: Editor; from: EditorPosition; to: EditorPosition; text: string; document: string; file?: string };
let labelId = 0;

export function registerSelectionToolbar(plugin: SimplePlugin, changed: () => void) {
  let editing = false, dragged: FormatTool | undefined, target: Target | undefined;
  let bar: HTMLElement | undefined, timer: number | undefined, disposed = false;
  let menuCloseTimer: number | undefined;
  let colorRefreshers: (() => void)[] = [];
  const documents = new Map<Document, () => void>();
  const settings = () => plugin.settings.enhancements.quickFormat;
  let cancelDrag: (() => void) | undefined;
  const hide = () => { cancelDrag?.(); if (menuCloseTimer !== undefined) window.clearTimeout(menuCloseTimer); bar?.remove(); bar = undefined; target = undefined; editing = false; dragged = undefined; };
  const save = () => { void plugin.saveSettings().catch(error => new Notice(String(error))); };
  const labelButton = (el: HTMLElement, label: string) => {
    const name = `simple-selection-label-${++labelId}`;
    el.removeAttribute("aria-label"); el.removeAttribute("title");
    el.setAttribute("aria-labelledby", name);
    const description = el.parentElement!.createSpan({ cls: "simple-selection-control-label", text: label, attr: { id: name } });
    description.hidden = true;
  };
  const button = (parent: HTMLElement, label: string, icon?: string) => {
    // Obsidian turns aria-label into a hover tooltip; labelledby retains the accessible name without it.
    const el = parent.createEl("button", { attr: { type: "button" } });
    if (icon) setFormatIcon(el, icon); else el.setText(label);
    labelButton(el, label);
    return el;
  };
  const customColor = (parent: HTMLElement, label: string, value: string, refresh: () => void) => {
    const refreshAll = () => { if (colorRefreshers.length) for (const update of colorRefreshers) update(); else refresh(); };
    const picker = new ThemeColorPicker(parent, plugin, "manage").setValue(value).onChange(color => {
      plugin.settings.themeFavoriteColors = [...new Set([...(plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS), color])];
      save(); refreshAll();
    }).onClose(refreshAll);
    picker.buttonEl.classList.add("simple-selection-custom-swatch");
    setIcon(picker.buttonEl, "palette"); labelButton(picker.buttonEl, label);
  };
  const apply = (transform: (text: string) => string, wholeLines = false): boolean => {
    const current = target;
    if (!current || current.editor.getValue() !== current.document || current.view.file?.path !== current.file || !current.view.containerEl.isConnected) { hide(); return false; }
    try {
      let from = current.from, to = current.to;
      if (wholeLines) {
        from = { line: from.line, ch: 0 };
        const lastLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
        to = { line: lastLine, ch: current.editor.getLine(lastLine).length };
      }
      const original = current.editor.getRange(from, to);
      const replacement = transform(original);
      if (replacement === original) { current.editor.focus(); hide(); return true; }
      current.editor.replaceRange(replacement, from, to);
      current.editor.setSelection(from, current.editor.offsetToPos(current.editor.posToOffset(from) + replacement.length));
      current.editor.focus(); hide(); return true;
    } catch (error) { new Notice(String(error)); return false; }
  };
  const position = (rect: DOMRect, win: Window) => {
    if (!bar) return;
    const width = bar.offsetWidth, height = bar.offsetHeight;
    bar.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - width - 8))}px`;
    const above = rect.top >= height + 14;
    bar.classList.toggle("is-below", !above);
    const top = Math.max(8, Math.min(above ? rect.top - height - 8 : rect.bottom + 8, win.innerHeight - height - 8));
    bar.style.top = `${top}px`;
    const belowSpace = win.innerHeight - top - height - 16, aboveSpace = top - 16;
    const menuAbove = belowSpace < Math.min(280, aboveSpace);
    bar.classList.toggle("is-menu-above", menuAbove);
    bar.style.setProperty("--simple-selection-menu-height", `${Math.max(40, menuAbove ? aboveSpace : belowSpace)}px`);
  };
  const render = (rect: DOMRect, doc: Document) => {
    bar?.remove();
    colorRefreshers = [];
    const barName = `simple-selection-label-${++labelId}`;
    bar = doc.body.createDiv({ cls: "simple-selection-toolbar", attr: { role: "toolbar", "aria-labelledby": barName } });
    bar.createSpan({ cls: "simple-selection-control-label", text: "浮动编辑栏", attr: { id: barName } }).hidden = true;
    bar.toggleClass("is-editing", editing);
    bar.addEventListener("pointerleave", () => {
      menuCloseTimer = window.setTimeout(() => {
        bar?.querySelectorAll(".is-open").forEach(element => { element.classList.remove("is-open"); element.querySelector("button")?.setAttribute("aria-expanded", "false"); });
      }, 110);
    });
    bar.addEventListener("pointerdown", event => {
      if (!(event.target as Element).closest("input") && !editing) event.preventDefault();
    });
    const config = settings();
    const appearance: Record<string, { color: string; background: string; fontStyle: string; border: string }> = {};
    const probe = doc.body.createDiv({ cls: "markdown-rendered markdown-preview-view" }); probe.hidden = true;
    for (const [id, tag] of [["textColor", "span"], ["bold", "strong"], ["italic", "em"], ["strike", "del"], ["underline", "u"], ["highlight", "mark"], ["quote", "blockquote"]] as const) {
      const sample = probe.createEl(tag, { text: "A" });
      const style = doc.defaultView!.getComputedStyle(sample);
      appearance[id] = { color: style.color, background: style.backgroundColor, fontStyle: style.fontStyle, border: style.borderInlineStartColor || style.borderLeftColor };
    }
    probe.remove();
    const blockMode = (id: "heading" | "quote"): QuickFormatMode | "paragraph" => {
      const saved = config.toolbarLastStyles[id];
      const allowed = id === "heading" ? ["paragraph", "h1", "h2", "h3", "h4", "h5", "h6"] : visibleModes(plugin).filter(mode => !isHeadingMode(mode));
      return allowed.includes(saved) ? saved as QuickFormatMode | "paragraph" : id === "heading" ? "h3" : "quote";
    };
    const applyBlock = (mode: QuickFormatMode | "paragraph") => apply(text => mode === "paragraph" ? text.replace(/^#{1,6}\s+/gm, "") : isHeadingMode(mode) ? text.split("\n").map(line => `${"#".repeat(Number(mode.slice(1)))} ${line.replace(/^#{1,6}\s+/, "")}`).join("\n") : formatSelection(plugin, text, mode), true);
    const styleBlock = (element: HTMLElement, mode: QuickFormatMode | "paragraph") => {
      if (mode !== "paragraph" && isHeadingMode(mode)) {
        const sampleView = doc.body.createDiv({ cls: "markdown-rendered markdown-preview-view" }); sampleView.hidden = true;
        const sample = sampleView.createEl(mode as "h1", { text: "A" });
        const style = doc.defaultView!.getComputedStyle(sample);
        element.style.color = style.color; element.style.fontWeight = style.fontWeight;
        element.style.fontStyle = style.fontStyle; element.style.textDecoration = style.textDecoration;
        if (parseFloat(style.borderBottomWidth)) element.style.borderBottom = style.borderBottom;
        sampleView.remove();
      } else if (mode === "quote") {
        element.style.color = appearance.quote.color;
      } else if (mode !== "paragraph") {
        const custom = config.customCallouts.find(c => `custom-callout:${c.id}` === mode);
        const type = custom?.type || mode.replace("callout-", "");
        element.style.color = custom?.color || config.calloutColors[type as keyof typeof config.calloutColors] || readCalloutColor(type, target?.view.contentEl || doc.body);
      }
    };
    const submenu = (group: HTMLElement, control: HTMLElement, click = true) => {
      control.setAttribute("aria-haspopup", "true"); control.setAttribute("aria-expanded", "false");
      const menu = group.createDiv({ cls: "simple-selection-submenu" });
      const closeOthers = () => {
        if (menuCloseTimer !== undefined) window.clearTimeout(menuCloseTimer);
        bar?.querySelectorAll(".is-open").forEach(element => { element.classList.remove("is-open"); element.querySelector("button")?.setAttribute("aria-expanded", "false"); });
      };
      const open = () => { closeOthers(); group.classList.add("is-open"); control.setAttribute("aria-expanded", "true"); position(rect, doc.defaultView!); };
      group.addEventListener("pointerenter", open);
      group.addEventListener("pointerleave", event => {
        if (event.relatedTarget && bar?.contains(event.relatedTarget as Node)) return;
        menuCloseTimer = window.setTimeout(() => { group.classList.remove("is-open"); control.setAttribute("aria-expanded", "false"); }, 110);
      });
      menu.addEventListener("pointerenter", () => { if (menuCloseTimer !== undefined) window.clearTimeout(menuCloseTimer); });
      control.addEventListener("keydown", event => {
        if (event.key === "ArrowDown") { event.preventDefault(); open(); menu.querySelector<HTMLButtonElement>("button")?.focus(); }
      });
      if (click) control.addEventListener("click", () => { if (group.classList.contains("is-open")) closeOthers(); else open(); });
      return menu;
    };
    const reorderTargets = new Map<Element, (event: PointerEvent) => void>();
    let previousTool: FormatTool | undefined;
    for (const id of orderedFormatTools(config.toolbarOrder)) {
      if (!editing && (config.toolbarHidden.includes(id) || id === "textColor" && config.toolbarHidden.includes("color"))) continue;
      const group = bar.createDiv({ cls: `simple-selection-tool simple-selection-tool-${id}` });
      group.classList.toggle("has-group-divider", !!previousTool && (id === "heading" || id === "quote") && previousTool !== "heading" && previousTool !== "quote");
      previousTool = id;
      const control = button(group, LABELS[id], ICONS[id]);
      control.dataset.formatTool = id;
      const theme = plugin.settings.themeFormatting;
      const formatColor = { textColor: theme.textColor, bold: theme.boldColor, italic: theme.italicColor, strike: theme.strikethroughColor, underline: theme.underlineColor, highlight: theme.highlightColor };
      if (id in formatColor && formatColor[id as keyof typeof formatColor]) control.style.color = formatColor[id as keyof typeof formatColor];
      else if (appearance[id]) control.style.color = appearance[id].color;
      if (id === "highlight") control.style.backgroundColor = theme.highlightBackground || appearance.highlight.background;
      if (id === "heading" || id === "quote") {
        const mode = blockMode(id);
        setFormatIcon(control, mode === "paragraph" ? "baseline" : modeIcon(mode)); styleBlock(control, mode);
      }
      if (editing) {
        control.draggable = false;
        control.setAttribute("aria-pressed", String(!config.toolbarHidden.includes(id)));
        control.classList.toggle("is-hidden-tool", config.toolbarHidden.includes(id));
        control.addEventListener("click", () => {
          config.toolbarHidden = config.toolbarHidden.includes(id) ? config.toolbarHidden.filter(tool => tool !== id) : [...config.toolbarHidden, id];
          save(); render(rect, doc);
        });
        control.addEventListener("dragstart", event => event.preventDefault());
        const moveBefore = (event: PointerEvent) => {
          if (!dragged || dragged === id || !bar) return;
          const source = bar.querySelector(`[data-format-tool="${dragged}"]`)?.parentElement;
          if (!source) return;
          const before = new Map([...bar.children].map(element => [element, element.getBoundingClientRect()]));
          const box = group.getBoundingClientRect();
          bar.insertBefore(source, event.clientX > box.left + box.width / 2 ? group.nextSibling : group);
          for (const [element, old] of before) {
            if (element === source) continue;
            const next = element.getBoundingClientRect();
            if (!doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) element.animate?.([{ transform: `translate(${old.left - next.left}px, ${old.top - next.top}px)` }, { transform: "translate(0, 0)" }], { duration: 110 });
          }
        };
        reorderTargets.set(control, moveBefore);
        control.addEventListener("pointerdown", event => {
          if (event.button !== 0) return;
          const x = event.clientX, y = event.clientY;
          let ghost: HTMLElement | undefined;
          cancelDrag = () => {
            doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", end); doc.removeEventListener("pointercancel", end);
            ghost?.remove(); doc.documentElement.classList.remove("simple-selection-dragging"); cancelDrag = undefined;
          };
          const move = (next: PointerEvent) => {
            if (!ghost && Math.hypot(next.clientX - x, next.clientY - y) < 5) return;
            if (!ghost) {
              dragged = id; group.classList.add("is-drag-source");
              doc.documentElement.classList.add("simple-selection-dragging");
              ghost = control.cloneNode(true) as HTMLElement; ghost.className = "simple-selection-drag-ghost";
              ghost.removeAttribute("aria-labelledby"); doc.body.append(ghost);
            }
            ghost.style.left = `${next.clientX + 12}px`; ghost.style.top = `${next.clientY - 15}px`;
            const hit = doc.elementFromPoint?.(next.clientX, next.clientY) ?? next.target as Element | null;
            const destination = hit?.closest?.("[data-format-tool]");
            if (destination) reorderTargets.get(destination)?.(next);
          };
          const end = (next: PointerEvent) => {
            cancelDrag?.();
            if (!ghost) return;
            next.preventDefault();
            ghost.remove(); doc.documentElement.classList.remove("simple-selection-dragging");
            if (next.type !== "pointercancel" && bar) {
              config.toolbarOrder = [...bar.querySelectorAll<HTMLElement>("[data-format-tool]")].map(element => element.dataset.formatTool!); save();
            }
            dragged = undefined; render(rect, doc);
          };
          doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", end); doc.addEventListener("pointercancel", end);
        });
        control.addEventListener("keydown", event => {
          if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault(); const order = orderedFormatTools(config.toolbarOrder), index = order.indexOf(id);
          const next = Math.max(0, Math.min(order.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
          [order[index], order[next]] = [order[next], order[index]]; config.toolbarOrder = order; save(); render(rect, doc);
          bar?.querySelector<HTMLButtonElement>(`[data-format-tool="${id}"]`)?.focus();
        });
        continue;
      }
      if (["textColor", "bold", "italic", "strike", "underline"].includes(id)) {
        const menu = submenu(group, control, false);
        const useStyle = (color: string) => {
          apply(text => color === "theme" ? useThemeStyle(text, id as InlineFormatTool | "textColor") : id === "textColor" ? colorSelection(useThemeStyle(text, "textColor"), "color", color) : applyInlineStyle(text, id as InlineFormatTool, color));
        };
        const colors = menu.createDiv({ cls: "simple-selection-colors" });
        const clearColors = (parent: HTMLElement) => {
          for (const element of parent.querySelectorAll("button")) {
            doc.getElementById(element.getAttribute("aria-labelledby") || "")?.remove();
          }
          parent.replaceChildren();
        };
        const addColors = (parent: HTMLElement, values: string[]) => {
          for (const color of [...new Set(values)].filter(value => /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value))) {
            const swatch = button(parent, `${LABELS[id]}颜色 ${color}`, ICONS[id]);
            swatch.dataset.formatStyle = color; swatch.classList.add("simple-selection-swatch");
            swatch.style.setProperty("--simple-selection-color", color);
            swatch.addEventListener("click", () => useStyle(color));
          }
        };
        const refresh = () => {
          clearColors(colors);
          const presets = selectionColors();
          addColors(colors, presets);
          customColor(colors, `管理${LABELS[id]}预选颜色`, "#824ce6", refresh);
          addColors(colors, selectionColors(plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS).filter(color => !presets.includes(color)));
        };
        colorRefreshers.push(refresh);
        refresh();
        control.addEventListener("click", () => useStyle("theme"));
      }
      else {
        const menu = submenu(group, control, id !== "highlight" && id !== "quote" && id !== "heading");
        if (id === "quote" || id === "heading") control.addEventListener("click", () => applyBlock(blockMode(id)));
        if (id === "highlight") {
          let foreground: string | undefined, background: string | undefined;
          const refreshPalettes: (() => void)[] = [];
          const pairing = button(menu, "合并字体与背景颜色", "baseline");
          pairing.classList.add("simple-selection-pairing-toggle");
          pairing.style.color = appearance.highlight.color;
          const icon = pairing.querySelector("svg")!;
          const fill = doc.win.createSvg("rect");
          for (const [key, value] of Object.entries({ x: "1", y: "1", width: "22", height: "22", rx: "3", fill: theme.highlightBackground || appearance.highlight.background, stroke: "none" })) fill.setAttribute(key, value);
          icon.prepend(fill);
          pairing.setAttribute("aria-pressed", String(!!config.highlightPairing));
          const pending = menu.createDiv({ cls: "simple-selection-pending", attr: { role: "status", "aria-live": "polite" } });
          pending.hidden = true;
          pairing.addEventListener("click", () => {
            config.highlightPairing = !config.highlightPairing;
            pairing.setAttribute("aria-pressed", String(config.highlightPairing)); foreground = background = undefined; pending.hidden = true;
            save(); for (const refresh of refreshPalettes) refresh();
          });
          const choose = (property: "color" | "background-color", color: string) => {
            if (property === "color") foreground = color; else background = color;
            menu.querySelectorAll<HTMLElement>(`[data-highlight-property="${property}"]`).forEach(element => element.setAttribute("aria-pressed", String(element.dataset.highlightColor === color)));
            if (foreground !== undefined && background !== undefined) apply(text => highlightSelection(text, foreground!, background!));
            else { pending.hidden = false; pending.setText(foreground === undefined ? "尚未选择字体颜色" : "尚未选择背景颜色"); }
          };
          control.addEventListener("click", () => apply(text => useThemeStyle(text, "highlight")));
          for (const property of ["color", "background-color"] as const) {
            const colors = menu.createDiv({ cls: "simple-selection-colors" });
            colors.dataset.highlightColors = property;
            const refreshPalette = () => {
              const paired = !!config.highlightPairing;
              colors.hidden = paired && property === "background-color";
              colors.querySelectorAll(".simple-selection-swatch, .simple-selection-custom-swatch").forEach(element => {
                doc.getElementById(element.getAttribute("aria-labelledby") || "")?.remove(); element.remove();
              });
              const presets = selectionColors();
              const textColors = [...presets, ...selectionColors(plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS).filter(color => !presets.includes(color))];
              if (property === "color") colors.append(pairing);
              for (const textColor of textColors) {
                if (property === "color" && textColors.indexOf(textColor) === presets.length) customColor(colors, "管理高亮预选颜色", "#824ce6", () => { for (const refresh of refreshPalettes) refresh(); });
                const color = property === "color" ? textColor : tintSelectionColor(textColor, 0.2);
                const swatch = button(colors, `${property === "color" ? "字体" : "背景"} ${color}`);
                swatch.dataset.selectionColor = color;
                swatch.dataset.highlightProperty = property; swatch.dataset.highlightColor = color;
                swatch.style.setProperty("--simple-selection-color", color);
                swatch.classList.add("simple-selection-swatch");
                if (property === "color") setFormatIcon(swatch, "baseline"); else swatch.replaceChildren();
                if (property === "background-color") { swatch.classList.add("is-background"); swatch.style.color = appearance.highlight.color; }
                if (paired && property === "color") { swatch.style.color = textColor; swatch.style.backgroundColor = tintSelectionColor(textColor, 0.2); }
                swatch.addEventListener("click", () => {
                  if (config.highlightPairing) apply(text => highlightSelection(text, textColor, tintSelectionColor(textColor, 0.2)));
                  else choose(property, color);
                });
              }
              if (property === "color" && textColors.length === presets.length) customColor(colors, "管理高亮预选颜色", "#824ce6", () => { for (const refresh of refreshPalettes) refresh(); });
            };
            refreshPalettes.push(refreshPalette); colorRefreshers.push(refreshPalette); refreshPalette();
          }
        } else {
          const modes: (QuickFormatMode | "paragraph")[] = id === "heading" ? ["paragraph", "h1", "h2", "h3", "h4", "h5", "h6"] : visibleModes(plugin).filter(mode => !isHeadingMode(mode));
          for (const mode of modes) {
            const item = button(menu, mode === "paragraph" ? "正文" : modeLabel(plugin, mode));
            item.classList.add("simple-selection-block-option");
            if (mode !== "paragraph") {
              const icon = item.createSpan(); item.prepend(icon); setIcon(icon, modeIcon(mode));
              if (isHeadingMode(mode)) { styleBlock(item, mode); }
              else if (mode === "quote") {
                item.classList.add("simple-selection-quote-preview");
                item.style.color = appearance.quote.color;
                item.style.backgroundColor = appearance.quote.background;
                item.style.fontStyle = appearance.quote.fontStyle;
                item.style.borderInlineStartColor = appearance.quote.border || "var(--blockquote-border-color, var(--interactive-accent))";
              } else {
                const custom = config.customCallouts.find(c => `custom-callout:${c.id}` === mode);
                const type = custom?.type || mode.replace("callout-", "");
                const color = custom?.color || config.calloutColors[type as keyof typeof config.calloutColors];
                item.classList.add("simple-selection-callout");
                item.style.setProperty("--simple-selection-callout", color || readCalloutColor(type, target?.view.contentEl || doc.body));
              }
            }
            item.addEventListener("click", () => { config.toolbarLastStyles[id] = mode; save(); applyBlock(mode); });
          }
        }
      }
    }
    const toolbox = bar.createDiv({ cls: "simple-selection-tool simple-selection-toolbox has-group-divider" });
    const toolboxButton = button(toolbox, "搜索工具箱", "layout-grid");
    toolboxButton.disabled = editing;
    const toolboxMenu = submenu(toolbox, toolboxButton);
    const vaultSearch = button(toolboxMenu, "笔记库内搜索", "search");
    const webSearch = button(toolboxMenu, "网页搜索", "globe");
    vaultSearch.classList.add("simple-selection-block-option"); webSearch.classList.add("simple-selection-block-option");
    vaultSearch.createSpan({ text: "笔记库内搜索" }); webSearch.createSpan({ text: "网页搜索" });
    vaultSearch.addEventListener("click", () => {
      const query = target?.text.trim(); if (!query) return;
      void (async () => {
        try {
          const leaf = plugin.app.workspace.getLeavesOfType("search")[0] || plugin.app.workspace.getLeftLeaf(true);
          if (!leaf) throw new Error("请先启用 Obsidian 核心插件“搜索”");
          await leaf.setViewState({ type: "search", state: { query: JSON.stringify(query) } });
          await plugin.app.workspace.revealLeaf(leaf);
        } catch (error) { new Notice(`搜索未打开：${String(error)}`); }
      })();
      hide();
    });
    webSearch.addEventListener("click", () => {
      const query = target?.text.trim(); if (!query) return;
      window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, "_blank", "noopener"); hide();
    });
    if (translationBridge(plugin.app)) {
      const row = toolboxMenu.createDiv({ cls: "simple-selection-translation-row" });
      const translate = button(row, "翻译", "languages"); translate.classList.add("simple-selection-block-option"); translate.createSpan({ text: "翻译" });
      const configure = button(row, "翻译模型与提示词", "settings");
      translate.addEventListener("click", () => {
        const selected = target;
        if (!selected || selected.editor.getValue() !== selected.document) { hide(); return; }
        hide();
        new SelectionTranslationModal(plugin, selected.text, result => {
          if (disposed || !selected.view.containerEl.isConnected || selected.view.file?.path !== selected.file || selected.editor.getValue() !== selected.document) return false;
          selected.editor.replaceRange(result, selected.from, selected.to); return true;
        }).open();
      });
      configure.addEventListener("click", () => { hide(); new TranslationSettingsModal(plugin).open(); });
    }
    const clearGroup = bar.createDiv({ cls: "simple-selection-tool" });
    const clear = button(clearGroup, "清除选中文字的局部格式代码", "trash-2");
    clear.classList.add("simple-selection-clear"); clear.disabled = editing;
    clear.addEventListener("click", () => apply(clearSpecialFormatting));
    const edit = button(bar, editing ? "完成编辑" : "编辑工具栏：点击显隐，拖动排序；Alt＋方向键也可排序", editing ? "check" : "settings");
    edit.classList.add("simple-selection-edit");
    edit.classList.toggle("is-done", editing);
    edit.addEventListener("click", () => { editing = !editing; render(rect, doc); });
    position(rect, doc.defaultView!);
  };
  const update = (doc: Document) => {
    if (disposed) return;
    if (!settings().enabled || !settings().selectionToolbar) { hide(); return; }
    if (editing && bar) return;
    if (bar && (bar.querySelector(".is-open") || bar.matches(":hover") || bar.contains(doc.activeElement) || doc.querySelector(".modal-container"))) return;
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = doc.getSelection();
    if (!view || view.getMode() !== "source" || view.containerEl.ownerDocument !== doc || !selection?.rangeCount || !view.contentEl.contains(selection.anchorNode) || !view.contentEl.contains(selection.focusNode)) { hide(); return; }
    const editor = view.editor, text = editor.getSelection();
    if (!text.trim() || editor.listSelections().length !== 1) { hide(); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }
    target = { view, editor, text, from: editor.getCursor("from"), to: editor.getCursor("to"), document: editor.getValue(), file: view.file?.path };
    render(rect, doc);
  };
  const observe = () => {
    for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
      const doc = leaf.view.containerEl.ownerDocument;
      if (documents.has(doc)) continue;
      let selecting = false;
      const schedule = () => { if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(() => { if (!selecting) update(doc); }, 100); };
      const up = () => { selecting = false; schedule(); };
      const down = (event: PointerEvent) => { if (bar?.contains(event.target as Node) || (event.target as Element).closest(".modal-container")) return; selecting = true; hide(); };
      const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !(event.target as Element).closest(".simple-selection-toolbar, .modal-container")) hide(); };
      const scroll = (event: Event) => { if (!bar?.contains(event.target as Node)) hide(); };
      doc.addEventListener("selectionchange", schedule); doc.addEventListener("pointerup", up); doc.addEventListener("pointercancel", up); doc.addEventListener("keyup", schedule);
      doc.addEventListener("pointerdown", down); doc.addEventListener("keydown", key); doc.addEventListener("scroll", scroll, true);
      const blur = () => hide(); doc.defaultView?.addEventListener("blur", blur);
      documents.set(doc, () => {
        doc.removeEventListener("selectionchange", schedule); doc.removeEventListener("pointerup", up); doc.removeEventListener("pointercancel", up); doc.removeEventListener("keyup", schedule);
        doc.removeEventListener("pointerdown", down); doc.removeEventListener("keydown", key); doc.removeEventListener("scroll", scroll, true); doc.defaultView?.removeEventListener("blur", blur);
      });
    }
  };
  plugin.registerEvent(plugin.app.workspace.on("layout-change", observe));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", hide));
  plugin.app.workspace.onLayoutReady(observe);
  plugin.register(() => { disposed = true; hide(); if (timer !== undefined) window.clearTimeout(timer); for (const cleanup of documents.values()) cleanup(); });
  return {
    toggle: () => { settings().selectionToolbar = !settings().selectionToolbar; hide(); changed(); save(); new Notice(settings().selectionToolbar ? "浮动编辑栏已恢复" : "浮动编辑栏已禁用"); },
    isPaused: () => !settings().selectionToolbar,
    refresh: () => { if (!settings().enabled || !settings().selectionToolbar) hide(); observe(); },
  };
}
