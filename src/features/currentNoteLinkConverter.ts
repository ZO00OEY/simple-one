import { Menu, Notice, addIcon, setIcon, setTooltip } from "obsidian";
import type SimplePlugin from "../main";
import { registerMarkdownAction } from "../shared/markdownAction";
import { reformatCurrentNote } from "./noteReformat";

const ACTION_ATTR = "data-simple-current-note-link-converter";
export const REFORMAT_ICON = "simple-reformat";
export const REFORMAT_NAME = "快速排版";
const CHECKBOX_CHECKED_ICON = "simple-square-check-contained";

addIcon(
  CHECKBOX_CHECKED_ICON,
  '<g fill="none" stroke="currentColor" stroke-width="8.333" stroke-linecap="round" stroke-linejoin="round"><rect x="12.5" y="12.5" width="75" height="75" rx="8.333"/><path d="m29.167 50.417 13.333 13.333 29.167-30"/></g>'
);

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
        openMenu = createLinkConverterMenu(plugin, syncAllActions);
        openMenu.showAtMouseEvent(evt);
      });
      return action;
    },
    (action) => syncActionButton(plugin, action)
  );
  plugin.register(() => openMenu?.hide());
  return syncAllActions;
}

function createLinkConverterMenu(plugin: SimplePlugin, syncAllActions: () => void): Menu {
  const menu = new Menu();
  const reformat = plugin.settings.diary.reformat;
  const checkboxIcon = (checked: boolean): string => checked ? CHECKBOX_CHECKED_ICON : "square";
  const keepOpenAfterClick = createMenuKeepOpenController(menu);

  if (plugin.settings.enhancements.currentNoteLinkConverter.showReformatCurrentNoteMenuItem) {
    menu.addItem((item) => {
      item
        .setTitle("快捷操作")
        .setIcon(REFORMAT_ICON)
        .setDisabled(true);
    });
    menu.addItem((item) => {
      item
        .setTitle("重排版当前笔记")
        .setIcon(REFORMAT_ICON)
        .onClick(async () => {
          await reformatCurrentNote(plugin);
        });
    });
    menu.addSeparator();
  }

  menu.addItem((item) => {
    item
      .setTitle("URL 粘贴设置")
      .setIcon("folder")
      .setDisabled(true);
  });
  menu.addItem((item) => {
    item
      .setTitle("单个 URL 自动处理为超链接")
      .setIcon(checkboxIcon(plugin.settings.autoProcessPaste && plugin.settings.autoProcessObsidian))
      .onClick(async () => {
        const value = !(plugin.settings.autoProcessPaste && plugin.settings.autoProcessObsidian);
        plugin.settings.autoProcessPaste = value;
        plugin.settings.autoProcessObsidian = value;
        item.setIcon(checkboxIcon(value));
        keepOpenAfterClick();
        await plugin.saveSettings();
        syncAllActions();
        new Notice(value ? "已开启单链接转换" : "已关闭单链接转换");
      });
  });
  menu.addItem((item) => {
    item
      .setTitle("文本中的 URL 自动处理为超链接")
      .setIcon(checkboxIcon(plugin.settings.autoProcessPastedTextLinks))
      .onClick(async () => {
        plugin.settings.autoProcessPastedTextLinks = !plugin.settings.autoProcessPastedTextLinks;
        item.setIcon(checkboxIcon(plugin.settings.autoProcessPastedTextLinks));
        keepOpenAfterClick();
        await plugin.saveSettings();
        syncAllActions();
        new Notice(plugin.settings.autoProcessPastedTextLinks ? "已开启粘贴内容链接扫描" : "已关闭粘贴内容链接扫描");
      });
  });
  menu.addSeparator();
  menu.addItem((item) => {
    item
      .setTitle("重排版设置")
      .setIcon("settings-2")
      .setDisabled(true);
  });
  menu.addItem((item) => {
    item
      .setTitle("重排版时链接格式化")
      .setIcon(checkboxIcon(reformat.runLinkConversion))
      .onClick(async () => {
        reformat.runLinkConversion = !reformat.runLinkConversion;
        item.setIcon(checkboxIcon(reformat.runLinkConversion));
        keepOpenAfterClick();
        await plugin.saveSettings();
        syncAllActions();
        new Notice(reformat.runLinkConversion ? "已开启重排版时链接格式化" : "已关闭重排版时链接格式化");
      });
  });
  menu.addItem((item) => {
    item
      .setTitle("粘贴文本时自动触发重排版")
      .setIcon(checkboxIcon(reformat.autoReformatAfterPaste))
      .onClick(async () => {
        reformat.autoReformatAfterPaste = !reformat.autoReformatAfterPaste;
        item.setIcon(checkboxIcon(reformat.autoReformatAfterPaste));
        keepOpenAfterClick();
        await plugin.saveSettings();
        syncAllActions();
        new Notice(reformat.autoReformatAfterPaste ? "已开启粘贴文本时自动触发重排版" : "已关闭粘贴文本时自动触发重排版");
      });
  });
  return menu;
}

function createMenuKeepOpenController(menu: Menu): () => void {
  const hide = menu.hide.bind(menu);
  let skipNextHide = false;

  menu.hide = () => {
    if (skipNextHide) {
      skipNextHide = false;
      return menu;
    }
    return hide();
  };

  return () => {
    skipNextHide = true;
  };
}

function actionTitle(plugin: SimplePlugin): string {
  const reformat = plugin.settings.diary.reformat;
  const enabledSteps = [
    reformat.runFormatReflow ? "文本整理" : "",
    reformat.runLinkConversion ? "链接格式化" : "",
  ].filter(Boolean);
  return [
    `点击重排版当前笔记${enabledSteps.length ? `：${enabledSteps.join(" → ")}` : ""}`,
    "右键：打开排版设置",
  ].join("\n");
}

function syncActionButton(plugin: SimplePlugin, action: HTMLElement): void {
  setIcon(action, REFORMAT_ICON);
  action.addClass("simple-reformat-action");
  setTooltip(action, REFORMAT_NAME);
}
