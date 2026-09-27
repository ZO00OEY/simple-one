import { Notice } from "obsidian";
import type SimplePlugin from "../main";

/** Copy the text of rendered Markdown inline-code spans when clicked. */
export function registerInlineCodeCopy(plugin: SimplePlugin): void {
  plugin.registerDomEvent(document, "click", (event: MouseEvent) => {
    if (!plugin.settings.enableInlineCodeCopy || event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    const code = target?.closest("code");
    if (!(code instanceof HTMLElement)) return;
    if (code.closest("pre")) return;
    if (!code.closest(".markdown-reading-view, .markdown-preview-view, .markdown-rendered")) return;

    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard.writeText(code.textContent ?? "")
      .then(() => new Notice("已复制行内代码"))
      .catch(() => new Notice("复制失败，请检查剪贴板权限"));
  }, { capture: true });
}
