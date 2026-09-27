import { Notice, setIcon, setTooltip } from "obsidian";
import type SimplePlugin from "../main";
import { registerMarkdownAction } from "../shared/markdownAction";

const ACTION_ATTR = "data-simple-template-fill";
export const TEMPLATE_FILL_ICON = "file-plus-2";

export function registerTemplateFillAction(plugin: SimplePlugin): () => void {
  return registerMarkdownAction(
    plugin,
    ACTION_ATTR,
    () => plugin.settings.enableTemplateFill && plugin.settings.enableTemplateFillAction,
    (view) => {
      const action = view.addAction(TEMPLATE_FILL_ICON, "快速新建笔记", async () => {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text) {
          new Notice("剪贴板没有可处理的网址或搜索词");
          return;
        }
        await plugin.activateTemplateFill(text);
      });
      return action;
    },
    syncActionButton
  );
}

function syncActionButton(action: HTMLElement): void {
  setIcon(action, TEMPLATE_FILL_ICON);
  action.addClass("simple-template-fill-action");
  setTooltip(action, "快速新建笔记");
}
