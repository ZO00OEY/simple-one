import { tooltipText } from "../../shared/tooltipText";
import { isReviewImage, type ReviewImage } from "./reviewImage";
import { textParts } from "./textDiff";
import { createFileListLayout, renderLayoutToggle, FileListLayout, renderFileTree } from "./fileTree";
import { styleActionButton } from "../../shared/actionButton";
import { App, Modal, Platform } from "obsidian";
import type { ConflictChoice } from "./mobileGithub";

type Side = "local" | "remote";
type Contents = { local: string | null; remote: string | null; partial?: boolean; notes?: Partial<Record<Side, string>> };

export interface PreviewFile {
  path: string;
  label?: string;
  description?: string;
  localPaths?: string[];
  remotePaths?: string[];
  localMissingLabel?: string;
  remoteMissingLabel?: string;
}

export interface LiveReview {
  layout?: FileListLayout;
  title?: string;
  description?: string;
  confirmLabel?: string;
  initialChoices?: Record<string, Side>;
  apply?(choices: Record<string, ConflictChoice>): void;
  files: PreviewFile[];
  read(file: PreviewFile): Promise<Contents>;
  readImage?(file: PreviewFile, side: Side): Promise<ReviewImage | null>;
}

/** One whole-file decision, shared by first alignment and unresolved sync files. */
export class ZoeySyncConflictPreviewModal extends Modal {
  private active = false;
  private inline = false;
  private page = 0;
  private collapsedFolders = new Set<string>();
  private disposeFiles?: () => void;
  private wholeContents = new Map<string, Contents>();
  private loading = new Set<string>();
  private readErrors = new Map<string, string>();
  private renderScheduled = false;
  private fileChoices = new Map<string, Side>();
  private detailPath?: string;
  private detailTab: Side = "local";
  private listScroll = 0;
  private imageUrl?: string;
  private imageKey?: string;
  private imageError?: string;
  private imageRequest = 0;
  private diffCache = new Map<string, Array<{ kind: string; text: string }>>();
  private resolve?: (choices: Record<string, ConflictChoice> | null) => void;

  constructor(app: App, private live: LiveReview) {
    super(app);
    this.live.layout ??= createFileListLayout();
    for (const file of live.files) {
      const choice = live.initialChoices?.[file.path];
      if (choice === "local" || choice === "remote") this.fileChoices.set(file.path, choice);
    }
  }

  wait(): Promise<Record<string, ConflictChoice> | null> {
    const result = new Promise<Record<string, ConflictChoice> | null>(resolve => { this.resolve = resolve; });
    this.open(); return result;
  }

  waitIn(container: HTMLElement): Promise<Record<string, ConflictChoice> | null> {
    this.inline = true;
    this.contentEl = container;
    container.addClass("is-mobile-review", "is-sidebar-review");
    this.active = true;
    const result = new Promise<Record<string, ConflictChoice> | null>(resolve => { this.resolve = resolve; });
    this.render(false);
    return result;
  }

  close(): void { if (this.inline) this.onClose(); else super.close(); }
  private compact(): boolean { return this.inline || Platform.isMobile; }

  onOpen(): void {
    this.active = true;
    this.modalEl.addClass("simple-one-sync-preview-modal", "simple-one-sync-version-modal");
    this.modalEl.toggleClass("is-mobile-review-modal", this.compact());
    this.modalEl.parentElement?.toggleClass("simple-one-sync-mobile-review-container", this.compact());
    this.contentEl.toggleClass("is-mobile-review", this.compact());
    this.render(false);
  }

  onClose(): void {
    this.active = false;
    this.clearImage();
    this.disposeFiles?.();
    this.modalEl.parentElement?.removeClass("simple-one-sync-mobile-review-container");
    this.resolve?.(null); this.resolve = undefined;
    this.contentEl.empty();
  }

  private scroller(): HTMLElement { return this.contentEl.querySelector<HTMLElement>(".simple-one-sync-preview__mobile-scroll") ?? this.contentEl; }

  private render(preserveScroll = true): void {
    const root = this.contentEl, scrollTop = preserveScroll ? this.scroller().scrollTop : this.detailPath ? 0 : this.listScroll;
    this.disposeFiles?.(); root.empty();
    root.addClass("simple-one-sync-preview", "simple-one-sync-version-choice");
    const header = root.createDiv({ cls: "simple-one-sync-preview__header" });
    header.createEl("h2", { text: this.detailPath ? "文件版本详情" : this.live.title ?? "选择文件版本" });
    if (!this.detailPath) renderLayoutToggle(header, this.live.layout!);
    const body = this.compact() ? root.createDiv({ cls: "simple-one-sync-preview__mobile-scroll" }) : root.createDiv();
    if (this.detailPath) {
      const file = this.live.files.find(file => file.path === this.detailPath);
      if (file) this.renderDetail(body, file);
    } else this.renderList(body);
    this.scroller().scrollTop = scrollTop;
  }

  private renderList(body: HTMLElement): void {
    body.createDiv({ text: this.live.description ?? "请选择各文件最终保留的版本；点文件查看差异，行内本/云可直接选择。", cls: "simple-one-sync-preview__notice" });
    const pages = Math.max(1, Math.ceil(this.live.files.length / 100));
    this.page = Math.min(this.page, pages - 1);
    const files = this.live.files.slice(this.page * 100, (this.page + 1) * 100);
    const list = body.createDiv({ cls: "simple-one-sync-preview__list" });
    this.disposeFiles = renderFileTree(list, files, file => file.label ?? file.path,
      (folder, file, fullPath) => this.renderFile(folder, file, fullPath), { collapsed: this.collapsedFolders, layout: this.live.layout });
    if (pages > 1) {
      const pager = body.createDiv({ cls: "simple-one-sync-preview__toolbar" });
      this.button(pager, "上一页", () => { this.page--; this.listScroll = 0; this.render(false); }).disabled = this.page === 0;
      pager.createSpan({ text: (this.page + 1) + " / " + pages + " 页 · 本页 " + files.length + " / 共 " + this.live.files.length + " 个" });
      this.button(pager, "下一页", () => { this.page++; this.listScroll = 0; this.render(false); }).disabled = this.page === pages - 1;
    }
    const remaining = this.live.files.filter(file => !this.fileChoices.has(file.path)).length;
    const footer = this.contentEl.createDiv({ cls: "simple-one-sync-preview__footer" });
    footer.createSpan({ text: remaining ? "还有 " + remaining + " 个文件未选择" : "所有文件已选择" });
    const actions = footer.createDiv({ cls: "simple-one-sync-preview__footer-actions" });
    this.button(actions, "取消", () => this.close());
    this.button(actions, this.live.confirmLabel ?? "确认并继续同步", () => this.applyReadyFiles(), "mod-cta").disabled = remaining > 0;
  }

  private choiceLabel(file: PreviewFile, side: Side): string {
    const missing = side === "local" ? file.localMissingLabel : file.remoteMissingLabel;
    return missing ? missing + "；选择后两端均不保留此文件" : "采用" + (side === "local" ? "本地" : "云端") + "完整版本";
  }

  private renderChoices(parent: HTMLElement, file: PreviewFile, compact: boolean): void {
    const controls = parent.createDiv({ cls: "simple-one-sync-version-choice__row-choices", attr: { role: "group", "aria-label": (file.label ?? file.path) + "的版本" } });
    for (const side of ["local", "remote"] as const) {
      const button = this.button(controls, compact ? side === "local" ? "本" : "云" : side === "local" ? "采用本地" : "采用云端", () => this.selectFile(file, side));
      button.addClass("simple-one-sync-version-choice__quick", "is-" + side);
      button.toggleClass("is-selected", this.fileChoices.get(file.path) === side);
      button.setAttr("aria-pressed", String(this.fileChoices.get(file.path) === side));
      button.setAttr("aria-label", this.choiceLabel(file, side) + "：" + (file.label ?? file.path));
      button.setAttribute("aria-label", this.choiceLabel(file, side));
    }
  }

  private renderFile(list: HTMLElement, file: PreviewFile, fullPath: boolean): void {
    const displayPath = file.label ?? file.path;
    const row = list.createDiv({ cls: "simple-one-sync-view__change simple-one-sync-version-row", attr: { "data-path": file.path, "aria-label": displayPath } });
    const name = row.createEl("button", { cls: "simple-one-sync-version-row__file", attr: { type: "button", "aria-label": tooltipText("查看文件差异：" + displayPath, displayPath) } });
    name.createSpan({ text: fullPath ? displayPath : displayPath.split("/").pop() ?? displayPath, cls: "simple-one-sync-view__path" });
    name.addEventListener("click", () => { this.listScroll = this.scroller().scrollTop; this.clearImage(); this.detailPath = file.path; this.detailTab = this.fileChoices.get(file.path) ?? "local"; this.render(false); });
    this.renderChoices(row, file, true);
  }

  private renderDetail(body: HTMLElement, file: PreviewFile): void {
    this.button(body, "返回文件列表", () => { this.clearImage(); this.detailPath = undefined; this.render(false); });
    body.createDiv({ text: file.label ?? file.path, cls: "simple-one-sync-version-detail__path" });
    this.renderChoices(body, file, false);
    if (file.description) body.createDiv({ text: file.description, cls: "simple-one-sync-preview__notice" });
    for (const side of ["local", "remote"] as const) {
      const paths = side === "local" ? file.localPaths : file.remotePaths;
      if (paths?.length) body.createDiv({ text: (side === "local" ? "本地路径：" : "云端路径：") + paths.join("、"), cls: "simple-one-sync-version-detail__path" });
    }
    const content = body.createDiv({ cls: "simple-one-sync-version-detail__content", attr: { role: "region", "aria-label": "所选版本内容" } });
    const side = this.detailTab, missing = side === "local" ? file.localMissingLabel : file.remoteMissingLabel;
    if (missing) { content.createDiv({ text: missing + "；采用此端会删除文件。" }); return; }
    if ([file.label ?? file.path, ...file.localPaths ?? [], ...file.remotePaths ?? []].some(isReviewImage)) { this.renderImage(content, file, side); return; }
    if (this.readErrors.has(file.path)) {
      content.createDiv({ text: "读取失败：" + this.readErrors.get(file.path), cls: "simple-one-sync-transfer__error" });
      this.button(content, "重试读取", () => { void this.loadFile(file); this.render(); });
    } else if (!this.wholeContents.has(file.path)) {
      content.createDiv({ text: "正在读取文件内容…" });
      if (!this.loading.has(file.path)) void this.loadFile(file);
    } else this.renderDiff(content, file);
  }

  private renderDiff(root: HTMLElement, file: PreviewFile): void {
    const content = this.wholeContents.get(file.path)!;
    for (const missing of [file.localMissingLabel, file.remoteMissingLabel]) if (missing) root.createDiv({ text: missing + "；采用该端会删除文件。" });
    for (const [side, note] of Object.entries(content.notes ?? {})) if (note) root.createDiv({ text: (side === "local" ? "本地：" : "云端：") + note });
    if (content.local === null || content.remote === null) {
      const value = content[this.detailTab];
      root.createDiv({ text: "无法可靠生成文本差异；以下仅展示所选端预览，选择仍采用完整文件。" });
      if (value !== null) { root.createEl("pre", { text: value.slice(0, 60000) || "（空文件）" }); if (value.length > 60000 || content.partial) root.createDiv({ text: "预览范围受限或已截断，未展示后续内容。" }); }
      else root.createDiv({ text: content.notes?.[this.detailTab] ?? "二进制文件，不提供文本预览。" });
      return;
    }
    let lines = this.diffCache.get(file.path);
    if (!lines) {
      lines = []; const local = content.local.replace(/\r\n/g, "\n"), remote = content.remote.replace(/\r\n/g, "\n");
      const clip = (value: string): string => value.slice(0, 60000).split("\n").slice(0, 2000).join("\n");
      const left = clip(local), right = clip(remote), truncated = !!content.partial || left !== local || right !== remote;
      const parts = textParts(left, right), changed = parts.some(part => part.common === undefined);
      if (!changed) lines.push({ kind: "note", text: file.localMissingLabel || file.remoteMissingLabel ? "文件存在状态不同；采用删除端会删除文件，采用另一端会保留完整文件。" : truncated ? "当前预览范围内无差异；较长内容已截断，未比较后续内容。" : "两端内容相同。" });
      for (let index = 0; changed && index < parts.length; index++) {
        const part = parts[index];
        if (part.common !== undefined) {
          const values = part.common.split("\n");
          const context = index === 0 ? values.slice(-3) : index === parts.length - 1 ? values.slice(0,3) : values.length > 6 ? [...values.slice(0,3), "…省略相同内容…", ...values.slice(-3)] : values;
          context.forEach(text => lines!.push({ kind: "common", text }));
        } else for (const [kind, value] of [["local", part.local], ["remote", part.remote]] as const) if (value) value.split("\n").forEach(text => lines!.push({ kind, text }));
        if (lines.length > 1000) break;
      }
      if (truncated || lines.length > 1000) { lines = lines.slice(0,1000); lines.push({ kind: "note", text: "差异预览已限量截断；选择仍采用完整一端，不会只保存预览片段。" }); }
      this.diffCache.set(file.path, lines);
    }
    const diff = root.createEl("pre", { cls: "simple-one-sync-version-detail__diff" });
    for (const line of lines.filter(line => line.kind !== (this.detailTab === "local" ? "remote" : "local"))) diff.createSpan({ text: (line.kind === "local" ? "− " : line.kind === "remote" ? "+ " : "  ") + line.text + "\n", cls: "is-" + line.kind });
  }

  private clearImage(): void {
    this.imageRequest++;
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = undefined; this.imageKey = undefined; this.imageError = undefined;
  }

  private renderImage(root: HTMLElement, file: PreviewFile, side: Side): void {
    const key = file.path + ":" + side;
    if (!this.live.readImage) { root.createDiv({ text: "此入口不支持图片预览；选择仍采用完整文件。" }); return; }
    if (this.imageKey === key) {
      if (this.imageUrl) {
        const url = this.imageUrl, request = this.imageRequest;
        const image = root.createEl("img", { attr: { src: url, alt: (side === "local" ? "本地" : "云端") + "图片版本：" + (file.label ?? file.path) } });
        image.addEventListener("error", () => {
          if (!this.active || this.imageKey !== key || this.imageRequest !== request || this.imageUrl !== url) return;
          this.imageError = "图片无法解码，已省略预览；选择仍采用完整文件。";
          URL.revokeObjectURL(url); this.imageUrl = undefined; this.render();
        }, { once: true });
      } else if (this.imageError) {
        root.createDiv({ text: this.imageError, cls: "simple-one-sync-transfer__error" });
        this.button(root, "重试图片", () => { this.clearImage(); this.render(); });
      } else root.createDiv({ text: "正在读取图片…" });
      return;
    }
    this.clearImage(); this.imageKey = key; const request = this.imageRequest;
    root.createDiv({ text: "正在读取图片…" });
    void this.live.readImage(file, side).then(image => {
      if (!this.active || request !== this.imageRequest) return;
      if (image) this.imageUrl = URL.createObjectURL(new Blob([new Uint8Array(image.bytes).buffer], { type: image.mime }));
      else this.imageError = "该端没有可预览的图片；选择仍采用完整文件。";
    }).catch(error => { if (this.active && request === this.imageRequest) this.imageError = "图片读取失败：" + (error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (this.active && request === this.imageRequest && this.detailPath === file.path && this.detailTab === side) this.render(); });
  }

  private async loadFile(file: PreviewFile): Promise<void> {
    if (this.loading.has(file.path)) return;
    this.loading.add(file.path); this.readErrors.delete(file.path);
    try {
      const content = await this.live.read(file);
      if (this.active) { this.wholeContents.set(file.path, content); this.diffCache.delete(file.path); }
    } catch (error) {
      if (this.active) this.readErrors.set(file.path, error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.delete(file.path);
      if (this.active && this.detailPath === file.path && !this.renderScheduled) {
        this.renderScheduled = true;
        void Promise.resolve().then(() => {
          this.renderScheduled = false;
          if (this.active) this.render();
        });
      }
    }
  }

  private button(root: HTMLElement, text: string, action: () => void, cls?: string): HTMLButtonElement {
    const button = styleActionButton(root.createEl("button", { text, cls, attr: { type: "button" } }), "text");
    button.addEventListener("click", action);
    return button;
  }

  private selectFile(file: PreviewFile, side: Side): void {
    this.fileChoices.set(file.path, side);
    if (this.detailPath === file.path && this.detailTab !== side) { this.clearImage(); this.detailTab = side; }
    this.render();
  }

  private applyReadyFiles(): void {
    if (this.live.files.some(file => !this.fileChoices.has(file.path))) return;
    const choices = Object.fromEntries(this.live.files.map(file => [file.path, { choice: this.fileChoices.get(file.path)! }]));
    this.live.apply?.(choices);
    this.resolve?.(choices); this.resolve = undefined; this.close();
  }
}
