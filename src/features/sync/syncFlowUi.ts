import { createFileListLayout, renderLayoutToggle, FileListLayout, renderPathTree } from "./fileTree";
import { styleActionButton } from "../../shared/actionButton";
import type { MobileGithub, MobilePlan } from "./mobileGithub";
import type { SyncStrategy } from "./syncPlan";

function page(root: HTMLElement, title: string): HTMLElement {
  const content = root.createDiv({ cls: "simple-one-sync-transfer" });
  content.createEl("h3", { text: title });
  return content;
}

function button(root: HTMLElement, text: string, action: () => void, primary = false): HTMLButtonElement {
  const el = root.createEl("button", { text, cls: primary ? "mod-cta" : "", attr: { type: "button" } });
  styleActionButton(el, "text");
  el.addEventListener("click", action);
  return el;
}

export function renderStrategy(root: HTMLElement, plan: MobilePlan, resolve: (choice: SyncStrategy | null) => void): void {
  const content = page(root, "先选择两端内容的处理方式");
  content.createEl("p", { text: `同步范围：云端 ${Object.keys(plan.remote.files).length.toLocaleString()} 个文件，本地 ${Object.keys(plan.local).length.toLocaleString()} 个文件。` });
  const local = new Set(plan.uploads), remote = new Set(plan.downloads);
  for (const conflict of plan.conflicts) {
    for (const path of conflict.localFiles?.map(file => file.path) ?? (conflict.local ? [conflict.local.path] : [])) local.add(path);
    for (const path of conflict.remoteFiles?.map(file => file.path) ?? (conflict.remote ? [conflict.remote.path] : [])) remote.add(path);
  }
  content.createEl("p", { text: `本地待上传或确认 ${local.size.toLocaleString()} 个，云端待下载或确认 ${remote.size.toLocaleString()} 个。最终数量以确认后的计划为准。` });
  const options = content.createDiv({ cls: "simple-one-sync-transfer__strategies" });
  for (const group of [
    { title: "合并两端", description: "自动合并两端变更，无法合并时采用所选端。", choices: [["merge-remote", "优先云端"], ["merge-local", "优先本地"]] },
    { title: "重建一端", description: "目标端将与来源端完全一致，目标端独有文件也会删除。仅处理同步范围内的文件。", choices: [["remote", "保留云端"], ["local", "保留本地"]] }
  ] satisfies Array<{ title: string; description: string; choices: Array<[SyncStrategy, string]> }>) {
    const box = options.createDiv({ cls: "simple-one-sync-transfer__strategy-box" });
    box.createEl("h4", { text: group.title });
    box.createEl("p", { text: group.description, cls: "simple-one-sync-transfer__strategy-description" });
    if (group.title === "合并两端") box.createEl("p", { text: "出现差异时：" });
    const actions = box.createDiv({ cls: "simple-one-sync-transfer__strategy-actions", attr: { role: "group", "aria-label": group.title } });
    for (const [choice, title] of group.choices) button(actions, title, () => resolve(choice));
  }
  const actions = content.createDiv({ cls: "simple-one-sync-transfer__strategy-actions" });
  button(actions, "暂不处理", () => resolve(null));
}

export function renderPlanConfirmation(root: HTMLElement, plan: MobilePlan, resolve: (confirmed: boolean) => void, layout: FileListLayout = createFileListLayout()): void {
  const content = page(root, "确认本次同步计划");
  content.addClass("simple-one-sync-plan-confirmation");
  renderLayoutToggle(content, layout);
  for (const [title, paths] of [["待删除云端文件", plan.remoteDeletes], ["待上传", plan.uploads], ["待删除本机文件", plan.localDeletes], ["待下载", plan.downloads]] as const) {
    if (!paths.length) continue;
    const details = content.createEl("details");
    details.createEl("summary", { text: `${title}（${paths.length.toLocaleString()}）` });
    renderPathTree(details, paths, path => title.includes("删除") ? "−"
      : (title === "待上传" ? plan.remote.files[path] : plan.local[path]) ? "M" : "+", layout);
  }
  const actions = content.createDiv({ cls: "simple-one-sync-transfer__buttons" });
  button(actions, "返回选择", () => resolve(false));
  button(actions, plan.localDeletes.length || plan.remoteDeletes.length ? "确认同步及上述删除" : "确认同步", () => resolve(true), true);
}

export function renderDownloadTask(root: HTMLElement, engine: MobileGithub,
  run: (action: () => Promise<void>) => Promise<void>): void {
  const task = engine.downloadTask;
  if (!task) return;
  const content = page(root, task.reviewRequired ? "下载需要重新检查" : "下载尚未完成");
  const card = content.createDiv({ cls: "simple-one-sync-transfer__strategy-box" });
  card.createEl("h4", { text: "自动继续下载" });
  card.createEl("p", { text: "进度已保存在本机，关闭或重启后仍可继续。", cls: "simple-one-sync-transfer__strategy-description" });
  const info = card.createDiv({ cls: "simple-one-sync-transfer__download-info" });
  const completed = task.completed;
  info.createEl("p", { text: `待下载：${completed === undefined ? "待核对" : Math.max(0, task.downloads - completed).toLocaleString() + " 个文件"}` });
  info.createEl("p", { text: `已下载：${completed === undefined ? "待核对" : completed.toLocaleString() + " 个文件"} / 共 ${task.downloads.toLocaleString()} 个` });
  const commit = engine.state.pending?.commit;
  const version = info.createEl("p", { text: "目标 commit：" });
  version.createEl("code", { text: commit ? commit.slice(0, 12) : "待核对", attr: { title: commit ?? "" } });
  card.createEl("p", { text: "下载及验证完成后，才会确认新的共同基准。", cls: "simple-one-sync-transfer__strategy-description" });
  if (task.reviewRequired) card.createEl("p", { text: "两端内容已变化，需要重新预览差异。已下载文件和本地新修改会保留。", cls: "simple-one-sync-transfer__error" });
  const actions = card.createDiv({ cls: "simple-one-sync-transfer__strategy-actions" });
  button(actions, task.reviewRequired ? "重新检查同步" : "继续自动下载", () => void run(() => task.reviewRequired ? engine.resetDownloadProgress() : engine.resumeAutomaticDownload()));
  card.createEl("p", { cls: "simple-one-sync-transfer__feedback simple-one-sync-transfer__progress", attr: { role: "status", "aria-live": "polite" } });
}
