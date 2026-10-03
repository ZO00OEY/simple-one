import { Menu, Notice, setIcon, setTooltip, type Editor } from "obsidian";
import type SimplePlugin from "../main";
import {
  QUICK_FORMAT_CALLOUTS,
  type QuickFormatHeadingLevel,
  type QuickFormatMode,
} from "../types";
import { registerMarkdownAction } from "../shared/markdownAction";
import { readCalloutColor } from "../shared/calloutColor";

const ACTION_ATTR = "data-simple-quick-format";
const quickFormatSheets = new WeakMap<Document, CSSStyleSheet>();
export const QUICK_FORMAT_ICON = "heading";
export const QUICK_FORMAT_NAME = "快速设置文本格式";

type ColumnFormatTarget = { apply: (mode: QuickFormatMode) => boolean; hold: (value: boolean) => void };
let activeColumnFormatTarget: ColumnFormatTarget | null = null;

export function setQuickFormatColumnTarget(target: ColumnFormatTarget): () => void {
  activeColumnFormatTarget = target;
  return () => { if (activeColumnFormatTarget === target) activeColumnFormatTarget = null; };
}

const MODE_LABELS: Record<string, string> = {
  h1: "一级标题",
  h2: "二级标题",
  h3: "三级标题",
  h4: "四级标题",
  h5: "五级标题",
  h6: "六级标题",
  quote: "引用",
};

const MODES: QuickFormatMode[] = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "quote",
  ...QUICK_FORMAT_CALLOUTS.map(({ type }) => `callout-${type}` as QuickFormatMode),
];

export function applyQuickFormatStyles(plugin: SimplePlugin, extraDoc?: Document): void {
  const quickFormat = plugin.settings.enhancements.quickFormat;
  const rules: string[] = [];

  for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"] as QuickFormatHeadingLevel[]) {
    const color = quickFormat.headingColors[level];
    if (isHexColor(color)) {
      rules.push(`body{--${level}-color:${color};--${level}-color-rgb:${hexToRgbTriplet(color)};}`);
    }
    const size = Number(quickFormat.headingSizes[level]);
    if (Number.isFinite(size) && size >= 10 && size <= 96) {
      rules.push(`body{--${level}-size:${size}px;}`);
    }
  }

  for (const definition of QUICK_FORMAT_CALLOUTS) {
    const { type } = definition;
    const color = quickFormat.calloutColors[type];
    if (!isHexColor(color)) continue;
    const rgb = hexToRgbTriplet(color);
    for (const alias of [type, ...definition.aliases]) {
      rules.push(`body{--callout-${alias}:${rgb};}`);
      addCalloutColorRules(rules, alias, rgb);
    }
  }
  for (const callout of quickFormat.customCallouts) {
    if (!isHexColor(callout.color) || !callout.type.trim()) continue;
    const type = callout.type.trim().toLowerCase();
    const rgb = hexToRgbTriplet(callout.color);
    rules.push(`body{--callout-${type}:${rgb};}`);
    addCalloutColorRules(rules, type, rgb);
  }

  const css = rules.join("\n");
  for (const doc of quickFormatDocuments(plugin, extraDoc)) {
    doc.getElementById("simple-quick-format-style")?.remove();
    let sheet = quickFormatSheets.get(doc);
    if (!sheet) {
      sheet = new doc.win.CSSStyleSheet();
      quickFormatSheets.set(doc, sheet);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      const ownedSheet = sheet;
      plugin.register(() => {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item) => item !== ownedSheet);
        quickFormatSheets.delete(doc);
      });
    }
    sheet.replaceSync(css);
  }
}

function quickFormatDocuments(plugin: SimplePlugin, extraDoc?: Document): Set<Document> {
  const docs = new Set<Document>([document]);
  if (extraDoc) docs.add(extraDoc);
  plugin.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.getContainer().doc));
  return docs;
}

function addCalloutColorRules(rules: string[], type: string, rgb: string): void {
  const selector = `body.simple-one-active .callout[data-callout="${cssEscape(type)}"]`;
  rules.push(`${selector}{--callout-color:${rgb};border-color:rgba(${rgb},0.35);background-color:rgba(${rgb},0.08);}`);
  rules.push(`${selector}{border-inline-start-color:rgb(${rgb});}`);
  rules.push(`${selector} .callout-title,${selector} .callout-icon{color:rgb(${rgb});}`);
  rules.push(`${selector} .callout-icon svg{stroke:currentColor;}`);
  rules.push(`body.simple-one-active .markdown-source-view.mod-cm6 .HyperMD-callout[data-callout="${cssEscape(type)}"]{border-color:rgba(${rgb},0.18);background-color:rgba(${rgb},0.08);}`);
  rules.push(`body .markdown-source-view.mod-cm6 .HyperMD-callout[data-callout="${cssEscape(type)}"] .callout-title{color:rgb(${rgb});}`);
}

export function registerQuickFormat(plugin: SimplePlugin): () => void {
  let openMenu: Menu | null = null;

  const syncAllActions = registerMarkdownAction(
    plugin,
    ACTION_ATTR,
    () => {
      const settings = plugin.settings.enhancements.quickFormat;
      return settings.enabled && (plugin.isMobile ? settings.showMobileEntry : settings.showDesktopEntry);
    },
    (view) => {
      const action = view.addAction(QUICK_FORMAT_ICON, actionTitle(plugin), () => applyQuickFormat(plugin));
      action.addEventListener("pointerdown", (event) => { if (activeColumnFormatTarget) event.preventDefault(); });
      action.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        openMenu?.hide();
        const target = activeColumnFormatTarget;
        target?.hold(true);
        openMenu = createQuickFormatMenu(plugin, syncAllActions);
        openMenu.onHide(() => target?.hold(false));
        openMenu.showAtMouseEvent(evt);
      });
      return action;
    },
    (action) => syncActionButton(plugin, action)
  );
  plugin.register(() => openMenu?.hide());
  return syncAllActions;
}

function createQuickFormatMenu(plugin: SimplePlugin, syncAllActions: () => void): Menu {
  const menu = new Menu();
  const current = plugin.settings.enhancements.quickFormat.lastMode;
  const modes = visibleModes(plugin);
  const headingModes = modes.filter(isHeadingMode);
  if (headingModes.length) {
    menu.addItem((item) => item.setTitle("当前行").setIcon("heading").setDisabled(true));
    for (const mode of headingModes) addQuickFormatMenuItem(menu, plugin, syncAllActions, current, mode);
  }

  const selectionModes = modes.filter((mode) => !isHeadingMode(mode));
  if (selectionModes.length) {
    if (headingModes.length) menu.addSeparator();
    menu.addItem((item) => item.setTitle("指定选中内容").setIcon("text-select").setDisabled(true));
    for (const mode of selectionModes) addQuickFormatMenuItem(menu, plugin, syncAllActions, current, mode);
  }
  return menu;
}

function addQuickFormatMenuItem(
  menu: Menu,
  plugin: SimplePlugin,
  syncAllActions: () => void,
  current: QuickFormatMode,
  mode: QuickFormatMode
): void {
  menu.addItem((item) => {
    const isCallout = mode.startsWith("callout-") || mode.startsWith("custom-callout:");
    const color = isCallout ? calloutColor(plugin, calloutTypeFromMode(plugin, mode)) : "";
    const menuItem = item
      .setTitle(menuTitle(plugin, mode, color))
      .setIcon(modeIcon(mode))
      .setChecked(current === mode);
    if (color) setMenuItemIconColor(menuItem, color);
    menuItem.onClick(async () => {
      plugin.settings.enhancements.quickFormat.lastMode = mode;
      applyQuickFormat(plugin);
      await plugin.saveSettings();
      syncAllActions();
    });
  });
}

function applyQuickFormat(plugin: SimplePlugin): void {
  const mode = plugin.settings.enhancements.quickFormat.lastMode;
  if (activeColumnFormatTarget) {
    if (activeColumnFormatTarget.apply(mode)) new Notice(`已设置为${modeLabel(plugin, mode)}`);
    return;
  }
  const editor = plugin.app.workspace.activeEditor?.editor;
  if (!editor) {
    new Notice("没有打开的编辑器");
    return;
  }

  if (isHeadingMode(mode)) {
    formatCurrentLineAsHeading(editor, Number(mode.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6);
    new Notice(`已设置为${modeLabel(plugin, mode)}`);
    return;
  }

  const selection = editor?.getSelection();
  if (!selection) {
    new Notice("请先选中要转换的内容");
    return;
  }

  editor.replaceSelection(formatSelection(plugin, selection, mode));
  new Notice(`已设置为${modeLabel(plugin, mode)}`);
}

export function formatSelection(plugin: SimplePlugin, text: string, mode: QuickFormatMode): string {
  if (mode === "quote") return formatQuote(text);
  return formatCallout(text, calloutTypeFromMode(plugin, mode));
}

function formatCurrentLineAsHeading(editor: Editor, level: 1 | 2 | 3 | 4 | 5 | 6): void {
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  const prefix = `${"#".repeat(level)} `;
  const formatted = line.trim()
    ? prefix + line.replace(/^#{1,6}\s+/, "").trimStart()
    : prefix.trimEnd();
  editor.replaceRange(formatted, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
}

function formatQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => line.startsWith(">") ? line : `> ${line}`)
    .join("\n");
}

function formatCallout(text: string, type: string): string {
  const body = text
    .split("\n")
    .map((line) => line.replace(/^>\s?/, ""))
    .map((line) => line ? `> ${line}` : ">")
    .join("\n");
  return `> [!${type}]\n${body}`;
}

function modeIcon(mode: QuickFormatMode): string {
  if (mode.startsWith("h")) return "heading";
  if (mode === "quote") return "quote";
  if (mode.startsWith("callout-")) {
    return calloutDefinition(mode.replace("callout-", ""))?.icon ?? "message-square";
  }
  return "message-square";
}

export function isHeadingMode(mode: QuickFormatMode): mode is QuickFormatHeadingLevel {
  return /^h[1-6]$/.test(mode);
}

function menuTitle(plugin: SimplePlugin, mode: QuickFormatMode, color: string): DocumentFragment {
  const fragment = createFragment();
  const label = createSpan();
  label.textContent = modeLabel(plugin, mode);

  if (isHeadingMode(mode)) {
    label.addClass("simple-quick-format-heading-label");
    label.style.color = getCssVar(`--${mode}-color`, "--text-normal");
  } else if (mode.startsWith("callout-") || mode.startsWith("custom-callout:")) {
    label.style.color = color;
  }

  fragment.append(label);
  return fragment;
}

function calloutColor(plugin: SimplePlugin, type: string): string {
  const context = plugin.app.workspace.getMostRecentLeaf()?.view.containerEl ?? document.body;
  return readCalloutColor(type, context);
}

function setMenuItemIconColor(item: unknown, color: string): void {
  const dom = (item as { dom?: HTMLElement }).dom;
  const icon = dom?.querySelector<HTMLElement>(".menu-item-icon");
  if (!icon) return;
  icon.style.setProperty("color", color, "important");
  icon.addClass("simple-quick-format-colored-icon");
}

function getCssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function hexToRgbTriplet(hex: string): string {
  const value = hex.slice(1);
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ].join(", ");
}

function actionTitle(_plugin: SimplePlugin): string {
  return QUICK_FORMAT_NAME;
}

function syncActionButton(plugin: SimplePlugin, action: HTMLElement): void {
  setIcon(action, QUICK_FORMAT_ICON);
  action.addClass("simple-quick-format-action");
  setTooltip(action, QUICK_FORMAT_NAME);
}

export function visibleModes(plugin: SimplePlugin): QuickFormatMode[] {
  const visible = new Set<QuickFormatMode>([...plugin.settings.enhancements.quickFormat.visibleModes, "quote"]);
  const customModes = plugin.settings.enhancements.quickFormat.customCallouts
    .map((item): QuickFormatMode => `custom-callout:${item.id}`)
    .filter((mode) => visible.has(mode));
  const modes = [...MODES.filter((mode) => visible.has(mode)), ...customModes];
  return modes.length ? modes : ["h3", "h4", "h5"];
}

export function modeLabel(plugin: SimplePlugin, mode: QuickFormatMode): string {
  if (mode.startsWith("custom-callout:")) {
    const id = mode.slice("custom-callout:".length);
    const custom = plugin.settings.enhancements.quickFormat.customCallouts.find((item) => item.id === id);
    return custom?.label.trim() || custom?.type.trim() || "自定义 Callout";
  }
  if (mode.startsWith("callout-")) {
    return calloutDefinition(mode.replace("callout-", ""))?.label ?? "Callout";
  }
  return MODE_LABELS[mode];
}

function calloutTypeFromMode(plugin: SimplePlugin, mode: QuickFormatMode): string {
  if (mode.startsWith("custom-callout:")) {
    const id = mode.slice("custom-callout:".length);
    const custom = plugin.settings.enhancements.quickFormat.customCallouts.find((item) => item.id === id);
    return custom?.type.trim().toLowerCase() || "note";
  }
  return mode.replace("callout-", "");
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function calloutDefinition(type: string) {
  return QUICK_FORMAT_CALLOUTS.find((definition) => definition.type === type);
}
