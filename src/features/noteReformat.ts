import { Notice } from "obsidian";
import type SimplePlugin from "../main";
import { convertTextLinks, hasConvertibleLinks } from "./linkFilter";
import { applyTextReformatRules } from "./noteReformatRules";

type ReformatResult = {
  text: string;
  formatChanged: boolean;
  linksChanged: number;
};

export async function reformatCurrentNote(plugin: SimplePlugin): Promise<void> {
  const editor = plugin.app.workspace.activeEditor?.editor;
  if (!editor) {
    new Notice("没有打开的编辑器");
    return;
  }

  const settings = plugin.settings.diary.reformat;
  if (!settings.runFormatReflow && !settings.runLinkConversion) {
    new Notice("还没有勾选任何重排版选项");
    return;
  }

  const original = editor.getValue();
  if (!original) {
    new Notice("当前笔记是空的");
    return;
  }

  new Notice("正在重排版当前笔记...");
  const cursor = editor.getCursor();
  const result = await reformatText(plugin, original);
  if (result.text === original) {
    new Notice("当前笔记没有需要重排版的内容");
    return;
  }

  editor.setValue(result.text);
  editor.setCursor(cursor);
  const parts: string[] = [];
  if (result.formatChanged) parts.push("格式重排版");
  if (result.linksChanged > 0) parts.push(`链接 ${result.linksChanged} 个`);
  new Notice(`已重排版：${parts.join("，")}`);
}

export async function reformatText(plugin: SimplePlugin, text: string): Promise<ReformatResult> {
  let output = text;
  let formatChanged = false;
  let linksChanged = 0;
  const settings = plugin.settings.diary.reformat;

  if (settings.runFormatReflow) {
    const formatted = applyTextReformatRules(output, settings.formatRules);
    output = formatted;
    formatChanged = formatted !== text;
  }

  if (settings.runLinkConversion && hasConvertibleLinks(output)) {
    const converted = await convertTextLinks(plugin, output);
    output = converted.text;
    linksChanged = converted.changed;
  }

  return { text: output, formatChanged, linksChanged };
}
