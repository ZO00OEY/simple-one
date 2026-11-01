import { App } from "obsidian";
import { createFileListLayout, FileListLayout } from "./fileTree";
import type { ReviewImage } from "./reviewImage";
import { ZoeySyncConflictPreviewModal } from "./conflictPreview";
import type { OverlapChoice, SetupOverlapContent } from "./onboarding";

/** First alignment uses the same version cards without applying files early. */
export class SetupDifferencesModal extends ZoeySyncConflictPreviewModal {
  constructor(app: App, paths: string[], choices: Record<string, OverlapChoice>,
    read: (path: string) => Promise<SetupOverlapContent>,
    apply: (choices: Record<string, OverlapChoice>) => void,
    layout: FileListLayout = createFileListLayout(),
    readImage?: (path: string, side: "local" | "remote") => Promise<ReviewImage | null>) {
    super(app, {
      files: paths.map(path => ({ path })), layout, initialChoices: choices,
      description: "请选择最终保留的版本。这里仅保存接入计划，完成接入时才应用。文本预览最多显示前 10,000 个字符，选择会应用整个文件。",
      confirmLabel: "确认选择", read: async file => {
        const content = await read(file.path), preview = content.preview;
        return { local: preview && preview.local.kind !== "text" ? null : content.local,
          remote: preview && preview.remote.kind !== "text" ? null : content.remote,
          partial: !preview || preview.local.limited || preview.remote.limited,
          notes: { local: preview && preview.local.kind !== "text" ? content.local : undefined, remote: preview && preview.remote.kind !== "text" ? content.remote : undefined } };
      },
      readImage: readImage ? (file, side) => readImage(file.path, side) : undefined,
      apply: selected => apply(Object.fromEntries(paths.map(path => [path, selected[path].choice as OverlapChoice])))
    });
  }
}
