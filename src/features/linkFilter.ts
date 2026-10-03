import { reportError } from "../shared/async";
// ============================================================
// Feature: URL paste handling — link filter + title fetch
// ============================================================
import { Editor, Notice } from "obsidian";
import type SimplePlugin from "../main";
import type { FilterRule } from "../types";
import { fetchPageTitle } from "../shared/webFetch";
import { applyTextReformatRules } from "./noteReformatRules";

export function registerLinkFilter(plugin: SimplePlugin): void {
  let plainTextPasteShortcutPressed = false;
  plugin.registerDomEvent(
    document,
    "keydown",
    (evt: KeyboardEvent) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.shiftKey && evt.key.toLowerCase() === "v") {
        plainTextPasteShortcutPressed = true;
      }
    },
    true
  );
  plugin.registerDomEvent(
    document,
    "keyup",
    (evt: KeyboardEvent) => {
      if (evt.key.toLowerCase() === "v") plainTextPasteShortcutPressed = false;
    },
    true
  );

  plugin.registerEvent(
    plugin.app.workspace.on(
      "editor-paste",
      (evt: ClipboardEvent, editor: Editor) => {
        if (evt.defaultPrevented) { plainTextPasteShortcutPressed = false; return; }
        const usedPlainTextPasteShortcut = plainTextPasteShortcutPressed;
        plainTextPasteShortcutPressed = false;
        const clipboardText = evt.clipboardData?.getData("text/plain") ?? "";
        const text = clipboardText.trim();
        if (!text) return;
        const isSingleLink = text.startsWith("obsidian://") || isURL(text);
        const bypassLinkProcessing = usedPlainTextPasteShortcut && (
          isSingleLink
            ? plugin.settings.plainTextPasteSkipsSingleLinkProcessing
            : plugin.settings.plainTextPasteSkipsContentLinkScan
        );
        if (plugin.settings.diary.reformat.autoReformatAfterPaste) {
          evt.preventDefault();
          const settings = plugin.settings.diary.reformat;
          const shouldProcessLinks = !bypassLinkProcessing && (
            isSingleLink
              ? (text.startsWith("obsidian://") ? plugin.settings.autoProcessObsidian : plugin.settings.autoProcessPaste)
              : plugin.settings.autoProcessPastedTextLinks || settings.runLinkConversion
          );
          void reformatPastedTextBeforeInsert(
            plugin,
            editor,
            isSingleLink ? text : clipboardText,
            shouldProcessLinks
          );
          return;
        }
        if (bypassLinkProcessing) return;

        if (plugin.settings.autoProcessObsidian && text.startsWith("obsidian://")) {
          evt.preventDefault();
          const cursor = editor.getCursor();
          const wikilink = parseObsidianUri(text);
          editor.replaceRange(wikilink, cursor);
          editor.setCursor({ line: cursor.line, ch: cursor.ch + wikilink.length });
          return;
        }

        if (!plugin.settings.autoProcessPaste) {
          return;
        }
        if (!isURL(text)) {
          if (!plugin.settings.autoProcessPastedTextLinks || !hasConvertibleLinks(text)) {
            return;
          }
          evt.preventDefault();
          const cursor = editor.getCursor();
          new Notice("正在整理粘贴内容里的链接...");
          void convertTextLinks(plugin, text).then(({ text: converted, changed }) => {
            editor.replaceRange(converted, cursor);
            new Notice(changed > 0 ? `已整理 ${changed} 个链接` : "没有发现需要整理的链接");
          }).catch(reportError);
          return;
        }
        evt.preventDefault();
        const url = text;
        const cursor = editor.getCursor();
        const placeholder = `[⏳ 获取标题中...](${url})`;
        editor.replaceRange(placeholder, cursor);
        void fetchPageTitle(url).then((title) => {
          const filtered = applyRules(url, title ?? url, plugin.settings.filterRules);
          const result = `[${filtered}](${url})`;
          const line = editor.getLine(cursor.line);
          const index = line.indexOf(placeholder);
          if (index !== -1) {
            editor.replaceRange(
              result,
              { line: cursor.line, ch: index },
              { line: cursor.line, ch: index + placeholder.length }
            );
            editor.setCursor({ line: cursor.line, ch: index + result.length });
          }
        }).catch(reportError);
      }
    )
  );

  plugin.addCommand({
    id: "insert-filtered-link-from-clipboard",
    name: "从剪贴板插入过滤链接",
    callback: async () => {
      const url = await navigator.clipboard.readText();
      if (!url || !isURL(url)) {
        new Notice("剪贴板中没有有效链接");
        return;
      }
      await insertFilteredLink(plugin, url.trim());
    },
  });
}

export function isURL(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export function parseObsidianUri(uri: string): string {
  try {
    const url = new URL(uri);
    const file = url.searchParams.get("file");
    if (file) {
      const decoded = decodeURIComponent(file);
      const filename = decoded.split("/").pop()?.replace(/\.md$/i, "") ?? decoded;
      return `[[${filename}]]`;
    }
  } catch { /* Clipboard permission may be unavailable. */ }
  return uri;
}

export function applyRules(url: string, title: string, rules: FilterRule[]): string {
  for (const rule of rules) {
    if (!rule.enabled || !rule.titleRegex) continue;
    if (rule.urlPattern) {
      try {
        if (!new RegExp(rule.urlPattern, "i").test(url)) continue;
      } catch {
        continue;
      }
    }

    try {
      const regex = new RegExp(rule.titleRegex);
      const match = title.match(regex);
      if (match) {
        if (rule.replaceWith) return title.replace(regex, rule.replaceWith);
        const groups = match.slice(1).filter((group) => group !== undefined);
        return groups.length > 0 ? groups.join("") : match[0];
      }
    } catch {
      // Invalid user regex: skip this rule.
    }
  }

  return title;
}

type ConvertibleLink = {
  start: number;
  end: number;
  url: string;
  kind: "web" | "obsidian";
};

export function hasConvertibleLinks(text: string): boolean {
  return collectConvertibleLinks(text).length > 0;
}

export async function convertTextLinks(
  plugin: SimplePlugin,
  text: string
): Promise<{ text: string; changed: number }> {
  const links = collectConvertibleLinks(text);
  if (!links.length) return { text, changed: 0 };

  const titleCache = new Map<string, string>();
  const replacements = new Map<ConvertibleLink, string>();
  for (const link of links) {
    if (link.kind === "obsidian") {
      replacements.set(link, parseObsidianUri(link.url));
      continue;
    }

    let title = titleCache.get(link.url);
    if (title === undefined) {
      title = await fetchPageTitle(link.url) ?? link.url;
      title = applyRules(link.url, title, plugin.settings.filterRules);
      titleCache.set(link.url, title);
    }
    replacements.set(link, `[${escapeMarkdownLinkText(title)}](${link.url})`);
  }

  let output = "";
  let cursor = 0;
  for (const link of links) {
    output += text.slice(cursor, link.start);
    output += replacements.get(link) ?? link.url;
    cursor = link.end;
  }
  output += text.slice(cursor);

  return { text: output, changed: links.length };
}

function collectConvertibleLinks(text: string): ConvertibleLink[] {
  const matches: ConvertibleLink[] = [];
  const regex = /\bhttps?:\/\/[^\s<>"']+|\bobsidian:\/\/[^\s<>"']+/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    const rawUrl = trimTrailingUrlPunctuation(match[0]);
    const start = match.index;
    const end = start + rawUrl.length;
    if (!rawUrl) continue;
    if (isAlreadyLinked(text, start, end)) continue;

    matches.push({
      start,
      end,
      url: rawUrl,
      kind: rawUrl.startsWith("obsidian://") ? "obsidian" : "web",
    });
  }

  return matches;
}

function isAlreadyLinked(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, end + 1);
  if (before.endsWith("](") && after === ")") return true;
  if (text[start - 1] === "<" && text[end] === ">") return true;
  if (text.slice(Math.max(0, start - 2), start) === "[[") return true;
  return false;
}

export function trimTrailingUrlPunctuation(url: string): string {
  return url.replace(/[)\].,;!?，。；！？、]+$/u, "");
}

async function reformatPastedTextBeforeInsert(
  plugin: SimplePlugin,
  editor: Editor,
  pastedText: string,
  processLinks: boolean
): Promise<void> {
  const settings = plugin.settings.diary.reformat;
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  let output = applyTextReformatRules(pastedText, settings.formatRules);
  if (processLinks && hasConvertibleLinks(output)) {
    output = (await convertTextLinks(plugin, output)).text;
  }

  editor.replaceRange(output, from, to);
  const lines = output.split("\n");
  editor.setCursor(lines.length === 1
    ? { line: from.line, ch: from.ch + lines[0].length }
    : { line: from.line + lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 });
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[[\]\\]/g, "\\$&").replace(/\n+/g, " ").trim();
}

async function insertFilteredLink(plugin: SimplePlugin, url: string): Promise<void> {
  const editor = plugin.app.workspace.activeEditor?.editor;
  if (!editor) {
    new Notice("没有打开的编辑器");
    return;
  }

  const cursor = editor.getCursor();
  const placeholder = `[⏳ 获取标题中...](${url})`;
  editor.replaceRange(placeholder, cursor);
  const title = await fetchPageTitle(url);
  const filtered = applyRules(url, title ?? url, plugin.settings.filterRules);
  const line = editor.getLine(cursor.line);
  const index = line.indexOf(placeholder);
  if (index !== -1) {
    const result = `[${filtered}](${url})`;
    editor.replaceRange(
      result,
      { line: cursor.line, ch: index },
      { line: cursor.line, ch: index + placeholder.length }
    );
    editor.setCursor({ line: cursor.line, ch: index + result.length });
  }
}

