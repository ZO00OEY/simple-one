import { Notice, setIcon } from "obsidian";
import type { MobileGithub, MobilePlan } from "./mobileGithub";
import { downloadSummary, type SyncStrategy } from "./syncPlan";

function page(root: HTMLElement, title: string): HTMLElement {
  const content = root.createDiv({ cls: "simple-one-sync-transfer" });
  content.createEl("h3", { text: title });
  return content;
}

function button(root: HTMLElement, text: string, action: () => void, primary = false): HTMLButtonElement {
  const el = root.createEl("button", { text, cls: primary ? "mod-cta" : "", attr: { type: "button" } });
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
  content.createEl("p", { text: `本地待上传或确认 ${local.size.toLocaleString()} 个，云端待下载或确认 ${remote.size.toLocaleString()} 个。同名差异会在下一步处理，最终数量以确认后的计划为准。` });
  const choices: Array<[SyncStrategy, string, string]> = [
    ["merge", "合并两端内容", "保留两端独有文件；相同内容的不同路径保留两份，同名内容差异继续逐项确认。"],
    ["remote", "完全以云端为准", "同步范围内严格对齐云端。本地独有文件将列入待删除，下一步会显示清单并再次确认。"],
    ["local", "完全以本地为准", "同步范围内严格对齐本地。云端独有文件将列入待删除，下一步会显示清单并再次确认。"],
    ["custom", "自定义", "沿用文件与内容差异列表，逐项选择跟随本地、跟随云端或手动合并。"]
  ];
  const options = content.createDiv({ cls: "simple-one-sync-transfer__strategies" });
  for (const [choice, title, description] of choices) {
    const el = button(options, "", () => resolve(choice));
    el.createEl("strong", { text: title });
    el.createSpan({ text: description });
  }
  button(content, "暂不处理", () => resolve(null));
}

export function renderPlanConfirmation(root: HTMLElement, plan: MobilePlan, resolve: (confirmed: boolean) => void): void {
  const content = page(root, "确认本次同步计划");
  content.addClass("simple-one-sync-plan-confirmation");
  content.createEl("p", { text: `上传 ${plan.uploads.length.toLocaleString()} 个 · 下载 ${plan.downloads.length.toLocaleString()} 个` });
  content.createEl("p", { cls: "simple-one-sync-plan-deletions", text: `删除本地 ${plan.localDeletes.length.toLocaleString()} 个 · 删除云端 ${plan.remoteDeletes.length.toLocaleString()} 个` });
  for (const [title, paths] of [["待上传", plan.uploads], ["待下载", plan.downloads], ["待删除本地文件", plan.localDeletes], ["待删除云端文件", plan.remoteDeletes]] as const) {
    if (!paths.length) continue;
    const details = content.createEl("details");
    details.createEl("summary", { text: `${title}（${paths.length.toLocaleString()}）` });
    // The full paths stay in the confirmed plan; avoid mounting thousands of rows.
    details.createEl("pre", { text: paths.slice(0, 100).join("\n") + (paths.length > 100 ? `\n…其余 ${paths.length - 100} 个` : "") });
    if (paths.length > 100) button(details, "查看全部清单", () => {
      details.querySelector("pre")?.setText(paths.join("\n"));
    });
  }
  const actions = content.createDiv({ cls: "simple-one-sync-transfer__buttons" });
  button(actions, "返回预览", () => resolve(false));
  button(actions, plan.localDeletes.length || plan.remoteDeletes.length ? "确认同步及上述删除" : "确认同步", () => resolve(true), true);
}

export function renderDownloadTask(root: HTMLElement, engine: MobileGithub,
  run: (action: () => Promise<void>) => Promise<void>, close: () => void): void {
  const task = engine.downloadTask;
  if (!task) return;
  const content = page(root, "整库下载待办");
  const summary = downloadSummary(task.downloads, task.total);
  content.createEl("p", { text: `待下载 ${task.downloads.toLocaleString()} 个文件，占同步完成后范围内 ${task.total.toLocaleString()} 个文件的 ${(summary.ratio * 100).toFixed(1)}%。` });
  content.createEl("p", { text: task.downloads > 1000 ? "待下载文件已超过 1000 个，建议手动下载整库 ZIP 后导入。" : "本次下载覆盖至少一半同步文件，建议手动下载整库 ZIP 后导入。" });
  content.createEl("p", { text: `逐文件下载可能需要大量 API 请求。个人 Token 通常每小时有 5000 次主限额，并可能触发额外限流。${engine.remaining === null ? "剩余额度尚未获取。" : `最近响应的剩余额度：${engine.remaining.toLocaleString()} 次。`}` });
  content.createEl("p", { text: "云端更新已确认。此待办已保存在本机，关闭或重启 Obsidian 后仍可继续；下载或导入完成前不会确认新的共同基准。" });
  if (task.reviewRequired) content.createEl("p", { text: "两端状态已变化，待办仍保留。请重置进度，再重新预览同步。", cls: "simple-one-sync-transfer__error" });
  const actions = content.createDiv({ cls: "simple-one-sync-transfer__buttons" });
  button(actions, "手动下载整库并导入", () => void run(() => engine.chooseManualDownload()), task.mode !== "manual");
  button(actions, "继续自动下载", () => void run(() => engine.resumeAutomaticDownload()));
  const link = content.createDiv({ cls: "simple-one-sync-transfer__download" });
  link.createEl("h4", { text: "1 · 下载固定版本的 ZIP" });
  const url = engine.downloadUrl!;
  link.createEl("a", { text: url, attr: { href: url, target: "_blank", rel: "noopener noreferrer" } });
  button(link, "复制下载链接", () => void run(async () => { await navigator.clipboard.writeText(url); new Notice("已复制下载链接"); }));
  link.createEl("p", { text: "私有仓库请先在浏览器登录有权限的 GitHub 账号。插件 token 不会自动登录浏览器；请使用上面的固定版本链接。" });
  const imports = content.createDiv();
  imports.createEl("h4", { text: "2 · 选择下载文件并导入" });
  const pick = (directory: boolean): void => {
    const input = imports.createEl("input", { cls: "simple-one-sync-transfer__file", attr: { type: "file", "aria-label": directory ? "选择已解压仓库文件夹" : "选择仓库 ZIP" } });
    if (directory) { input.setAttribute("webkitdirectory", ""); input.multiple = true; }
    else input.accept = ".zip,application/zip,application/x-zip-compressed";
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (files.length) void run(() => engine.importDownload(directory ? files : files[0]));
    }, { once: true });
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.click();
  };
  const importActions = imports.createDiv({ cls: "simple-one-sync-transfer__buttons" });
  button(importActions, "选择 ZIP 并导入", () => pick(false), true);
  button(importActions, "选择已解压文件夹", () => pick(true));
  imports.createEl("p", { text: "ZIP 按小块读取，所需文件逐个校验并写入磁盘暂存区；完成后只应用确认清单。单个文件仍受当前 96 MiB 解压处理限制。" });
  imports.createEl("p", { text: "文件夹选择取决于系统和 Obsidian 版本；较新的苹果系统才支持。若无法选择文件夹，请使用 ZIP。支持仓库外层目录；检测到多个仓库时，请直接选择其中一个。" });
  const feedback = content.createEl("p", { cls: "simple-one-sync-transfer__feedback", attr: { role: "status", "aria-live": "polite" } });
  feedback.createSpan({ cls: "simple-one-sync-transfer__progress" });
  button(content, "稍后处理，返回文件列表", close);
  const reset = content.createEl("details");
  reset.createEl("summary", { text: "重置进度" });
  reset.createEl("p", { text: "清除这次待办和暂存进度，保留上一次已完成的共同基准。已上传、已导入和新修改的文件不会回滚；重置后请重新预览同步。" });
  button(reset, "确认重置进度", () => void run(() => engine.resetDownloadProgress()));
  const hint = content.createSpan({ cls: "simple-one-sync-transfer__hint" });
  setIcon(hint, "triangle-alert");
  hint.setAttr("aria-label", "未完成待办保留在上方红色提醒中");
}
