import { Notice, TFile } from "obsidian";
import type SimplePlugin from "../main";
import { availableNotePath, sanitizeNoteFilename } from "../shared/noteFilename";

export function registerNoteFilenameFilter(plugin: SimplePlugin): void {
  let pending = Promise.resolve();
  let disposed = false;
  plugin.register(() => { disposed = true; });
  const schedule = (file: unknown): void => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    pending = pending.then(async () => {
      if (disposed || plugin.app.vault.getAbstractFileByPath(file.path) !== file) return;
      const name = sanitizeNoteFilename(file.basename);
      if (name === file.basename) return;
      const folder = file.parent?.path === "/" ? "" : file.parent?.path ?? "";
      const path = availableNotePath(folder, name, candidate => {
        const existing = plugin.app.vault.getAbstractFileByPath(candidate);
        return existing !== null && existing !== file;
      });
      await plugin.app.fileManager.renameFile(file, path);
      new Notice(`已过滤笔记文件名中的非法字符：${file.name}`);
    }).catch(error => {
      console.error("Simple One: note filename filtering failed", error);
      new Notice("笔记文件名过滤失败，请手动修改文件名后再同步");
    });
  };
  plugin.registerEvent(plugin.app.vault.on("create", schedule));
  plugin.registerEvent(plugin.app.vault.on("rename", schedule));
}
