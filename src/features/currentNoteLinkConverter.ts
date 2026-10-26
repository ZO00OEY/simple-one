import { Menu, addIcon, setIcon, setTooltip } from "obsidian";
import type SimplePlugin from "../main";
import { registerMarkdownAction } from "../shared/markdownAction";
import { reformatCurrentNote } from "./noteReformat";

const ACTION_ATTR = "data-simple-current-note-link-converter";
export const REFORMAT_ICON = "simple-reformat";
export const REFORMAT_NAME = "自动排版";

addIcon(REFORMAT_ICON, `
<g transform="scale(6.25)" fill="currentColor">
  <path d="M7.5 5.5a.5.5 0 0 0-1 0v.634l-.549-.317a.5.5 0 1 0-.5.866L6 7l-.549.317a.5.5 0 1 0 .5.866l.549-.317V8.5a.5.5 0 1 0 1 0v-.634l.549.317a.5.5 0 1 0 .5-.866L8 7l.549-.317a.5.5 0 1 0-.5-.866l-.549.317zm-2 4.5a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1zm0 2a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1z"/>
  <path d="M14 14V4.5L9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2M9.5 3A1.5 1.5 0 0 0 11 4.5h2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5.5z"/>
</g>
`);

export function registerCurrentNoteLinkConverter(plugin: SimplePlugin): () => void {
  let openMenu: Menu | null = null;

  const syncAllActions = registerMarkdownAction(
    plugin,
    ACTION_ATTR,
    () => plugin.settings.enhancements.currentNoteLinkConverter.enabled,
    (view) => {
      const action = view.addAction(REFORMAT_ICON, actionTitle(plugin), async () => {
        await reformatCurrentNote(plugin);
      });
      action.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        openMenu?.hide();
        openMenu = createLinkConverterMenu(plugin);
        openMenu.showAtMouseEvent(evt);
      });
      return action;
    },
    (action) => syncActionButton(plugin, action)
  );
  plugin.register(() => openMenu?.hide());
  return syncAllActions;
}

function createLinkConverterMenu(plugin: SimplePlugin): Menu {
  const menu = new Menu();
  menu.addItem((item) => {
    item
      .setTitle("自动排版设置")
      .setIcon("settings-2")
      .onClick(() => plugin.openReformatSettings());
  });
  return menu;
}

function actionTitle(plugin: SimplePlugin): string {
  const reformat = plugin.settings.diary.reformat;
  const enabledSteps = [
    reformat.runFormatReflow ? "文本整理" : "",
    reformat.runLinkConversion ? "链接格式化" : "",
  ].filter(Boolean);
  return [
    `点击对当前笔记自动排版${enabledSteps.length ? `：${enabledSteps.join(" → ")}` : ""}`,
    "右键：打开自动排版设置",
  ].join("\n");
}

function syncActionButton(plugin: SimplePlugin, action: HTMLElement): void {
  setIcon(action, REFORMAT_ICON);
  action.addClass("simple-reformat-action");
  setTooltip(action, actionTitle(plugin));
}
