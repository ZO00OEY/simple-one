import { App, Modal, Platform, setIcon } from "obsidian";
import type { ConflictChoice } from "./mobileGithub";
import { resolveTextParts, textParts, TextPart } from "./textDiff";

type Side = "local" | "remote";
type FileChoice = Side | "latest" | "both" | "delete";
type BlockMethod = Side | "merged";
type ChoiceTone = Side | "mixed";

interface PreviewBlock {
  line: number;
  local: string;
  remote: string;
}

export interface PreviewFile {
  path: string;
  label?: string;
  description?: string;
  localPaths?: string[];
  remotePaths?: string[];
  localChoiceLabel?: string;
  remoteChoiceLabel?: string;
  missingLabel?: string;
  keepSide?: Side;
  reviewStage?: "file" | "content";
  showPaths?: boolean;
  allowBoth?: boolean;
  mergeable?: boolean;
  totalLines: number;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  blocks: PreviewBlock[];
}

export interface LiveReview {
  editableColumns?: boolean;
  title?: string;
  description?: string;
  files: PreviewFile[];
  read(file: PreviewFile): Promise<{ local: string | null; remote: string | null }>;
}

interface BlockSelection {
  method: BlockMethod;
  text?: string;
}

const SAMPLE_FILES: PreviewFile[] = [
  {
    path: "示例/项目方案.md",
    totalLines: 1218,
    localUpdatedAt: "2026-09-27T00:41:00+08:00",
    remoteUpdatedAt: "2026-09-26T23:58:00+08:00",
    blocks: [
      { line: 318, local: "先整理现有笔记，再逐步调整分类。", remote: "先完成分类规则，再批量整理现有笔记。" },
      { line: 742, local: "1. 检查重复笔记\n2. 确认链接\n3. 归档", remote: "1. 确认链接\n2. 归档\n3. 检查重复笔记" }
    ]
  },
  { path: "示例/阅读记录.md", totalLines: 864, localUpdatedAt: "2026-09-26T21:12:00+08:00", remoteUpdatedAt: "2026-09-27T00:18:00+08:00", blocks: [{ line: 205, local: "保留原文摘录，之后补充想法。", remote: "整理为三条要点，方便之后检索。" }] },
  { path: "示例/周会纪要.md", totalLines: 176, localUpdatedAt: "2026-09-27T00:22:00+08:00", remoteUpdatedAt: "2026-09-26T22:46:00+08:00", blocks: [{ line: 86, local: "周三完成初稿。", remote: "周五完成初稿，并邀请大家核对。" }] },
  {
    path: "示例/写作提纲.md",
    totalLines: 392,
    localUpdatedAt: "2026-09-26T20:30:00+08:00",
    remoteUpdatedAt: "2026-09-27T00:36:00+08:00",
    blocks: [
      { line: 34, local: "第一章从主人公的回忆开始。", remote: "第一章从一封来信开始。" },
      { line: 112, local: "结尾保留悬念。", remote: "结尾交代故事的时间线。" }
    ]
  },
  { path: "示例/工具清单.md", totalLines: 98, localUpdatedAt: "2026-09-26T23:44:00+08:00", remoteUpdatedAt: "2026-09-26T22:16:00+08:00", blocks: [{ line: 52, local: "- 本地备份：每周一次", remote: "- 本地备份：每天一次" }] },
  { path: "示例/日记.md", totalLines: 64, localUpdatedAt: "2026-09-26T19:50:00+08:00", remoteUpdatedAt: "2026-09-27T00:07:00+08:00", blocks: [{ line: 29, local: "今天先整理旧项目。", remote: "今天先完成新项目的准备。" }] },
  { path: "示例/分类规则.md", totalLines: 631, localUpdatedAt: "2026-09-27T00:29:00+08:00", remoteUpdatedAt: "2026-09-26T23:20:00+08:00", blocks: [{ line: 441, local: "待整理内容先放入收集箱。", remote: "待整理内容按主题直接归类。" }] },
  { path: "示例/旅行清单.md", totalLines: 82, localUpdatedAt: "2026-09-26T22:02:00+08:00", remoteUpdatedAt: "2026-09-27T00:25:00+08:00", blocks: [{ line: 63, local: "- 带充电器和雨伞", remote: "- 带充电器、雨伞和备用眼镜" }] }
];

export class ZoeySyncConflictPreviewModal extends Modal {
  private pending: Set<string>;
  private files: PreviewFile[];
  private parts = new Map<string, TextPart[]>();
  private loading = new Set<string>();
  private loaded = new Set<string>();
  private wholeContents = new Map<string, { local: string | null; remote: string | null }>();
  private readErrors = new Map<string, string>();
  private results: Record<string, ConflictChoice> = {};
  private resolve?: (choices: Record<string, ConflictChoice> | null) => void;
  private active = false;
  private inline = false;
  private page = 0;
  private expandedPath?: string;
  private fileChoices = new Map<string, FileChoice>();
  private blockChoices = new Map<string, BlockSelection>();
  private appliedCount = 0;
  private stage: "file" | "content" = "content";

  constructor(app: App, private live?: LiveReview) {
    super(app);
    this.files = live?.files ?? SAMPLE_FILES;
    this.pending = new Set(this.files.map(file => file.path));
    if (this.live && this.files.some(file => file.reviewStage === "file")) this.stage = "file";
  }

  wait(): Promise<Record<string, ConflictChoice> | null> {
    const result = new Promise<Record<string, ConflictChoice> | null>(resolve => { this.resolve = resolve; });
    this.open(); return result;
  }

  waitIn(container: HTMLElement): Promise<Record<string, ConflictChoice> | null> {
    this.inline = true;
    this.contentEl = container;
    this.contentEl.addClass("is-mobile-review");
    this.contentEl.addClass("is-sidebar-review");
    this.active = true;
    const result = new Promise<Record<string, ConflictChoice> | null>(resolve => { this.resolve = resolve; });
    this.render(false);
    return result;
  }

  close(): void {
    if (this.inline) this.onClose();
    else super.close();
  }

  private compact(): boolean { return this.inline || Platform.isMobile; }

  onOpen(): void {
    this.active = true;
    this.modalEl.addClass("simple-one-sync-preview-modal");
    this.modalEl.toggleClass("is-mobile-review-modal", this.compact());
    this.modalEl.parentElement?.toggleClass("simple-one-sync-mobile-review-container", this.compact());
    this.contentEl.toggleClass("is-mobile-review", this.compact());
    this.render(false);
    if (this.live?.editableColumns && this.files[0]) {
      this.expandedPath = this.files[0].path;
      void this.loadFile(this.files[0]);
    }
  }

  onClose(): void {
    this.modalEl.parentElement?.removeClass("simple-one-sync-mobile-review-container");
    this.active = false;
    this.resolve?.(null); this.resolve = undefined;
    this.contentEl.empty();
  }

  private render(preserveScroll = true): void {
    const root = this.contentEl;
    const scrollTop = preserveScroll ? (root.querySelector<HTMLElement>(".simple-one-sync-preview__mobile-scroll") ?? root).scrollTop : 0;
    root.empty();
    root.addClass("simple-one-sync-preview");
    const body = this.compact() ? root.createDiv({ cls: "simple-one-sync-preview__mobile-scroll" }) : root;

    const stageFiles = this.stageFiles();
    const hasContent = this.files.some(file => file.reviewStage !== "file");
    const header = (this.compact() ? root : body).createDiv({ cls: "simple-one-sync-preview__header" });
    const heading = header.createDiv();
    heading.createDiv({ text: this.live?.title ? "接入方案 · 规则确认" : this.live ? "轻量同步 · 文件与内容确认" : "界面预览 · 示例数据", cls: "simple-one-sync-preview__eyebrow" });
    const title = heading.createEl("h2", { text: this.live?.title ?? (this.live ? (this.stage === "file" ? "文件差异确认" : "内容差异确认") : "处理文件差异") });
    const count = title.createSpan({ cls: "simple-one-sync-preview__title-count" });
    count.createSpan({ text: String(stageFiles.length), cls: "simple-one-sync-preview__title-number" });
    count.createSpan({ text: " 项" });
    const reset = header.createEl("button", { text: "清空选择", cls: "simple-one-sync-preview__clear" });
    reset.addEventListener("click", () => this.clearStageChoices());
    if (this.compact()) {
      const close = this.createButton(header, "×", () => this.close(), "simple-one-sync-preview__close");
      close.setAttr("aria-label", "关闭差异确认");
    }

    if (this.live?.description) body.createDiv({ text: this.live.description, cls: "simple-one-sync-preview__notice" });
    const toolbar = body.createDiv({ cls: "simple-one-sync-preview__toolbar" });
    const bulk = toolbar.createDiv({ cls: "simple-one-sync-preview__bulk" });
    if (!this.live) this.createButton(bulk, "全选最新", () => this.selectAll("latest"), "simple-one-sync-preview__bulk-choice");
    if (this.live && this.stage === "file") {
      this.createButton(bulk, "全部保留", () => this.keepAll());
      this.createButton(bulk, "全部删除", () => {
        for (const file of stageFiles) {
          this.fileChoices.set(file.path, file.keepSide ? (file.keepSide === "local" ? "remote" : "local") : "delete");
          for (let i = 0; i < file.blocks.length; i++) this.blockChoices.delete(this.blockKey(file.path, i));
        }
        this.render();
      }, "simple-one-sync-preview__delete-all");
      this.createButton(bulk, "跟随本机", () => this.selectAll("local"), "simple-one-sync-preview__bulk-choice is-local");
      this.createButton(bulk, "跟随云端", () => this.selectAll("remote"), "simple-one-sync-preview__bulk-choice is-remote");
    } else {
      this.createButton(bulk, "跟随本机", () => this.selectAll("local"), "simple-one-sync-preview__bulk-choice is-local");
      this.createButton(bulk, "跟随云端", () => this.selectAll("remote"), "simple-one-sync-preview__bulk-choice is-remote");
    }

    if (this.appliedCount > 0) {
      body.createDiv({ text: `${this.live ? "已保存选择" : "示例中已应用"} ${this.appliedCount} 个，剩余 ${this.pending.size} 个待处理。`, cls: "simple-one-sync-preview__feedback" });
    }

    const list = body.createDiv({ cls: "simple-one-sync-preview__list" });
    const pendingFiles = stageFiles;
    const pages = Math.max(1, Math.ceil(pendingFiles.length / 100));
    this.page = Math.min(this.page, pages - 1);
    for (const file of pendingFiles.slice(this.page * 100, (this.page + 1) * 100)) this.renderFile(list, file);
    if (pages > 1) {
      const pager = body.createDiv({ cls: "simple-one-sync-preview__toolbar" });
      this.createButton(pager, "上一页", () => { this.page--; this.render(false); }).disabled = this.page === 0;
      pager.createSpan({ text: `${this.page + 1} / ${pages} 页` });
      this.createButton(pager, "下一页", () => { this.page++; this.render(false); }).disabled = this.page === pages - 1;
    }
    if (this.pending.size === 0) list.createDiv({ text: "示例文件已全部处理。可以点“重置示例”重新查看。", cls: "simple-one-sync-preview__empty" });

    const ready = this.getReadyFiles().filter(file => stageFiles.includes(file));
    const footer = root.createDiv({ cls: "simple-one-sync-preview__footer" });
    footer.createSpan({ text: `已选好 ${ready.length} 个 · 仍需选择 ${stageFiles.length - ready.length} 个` });
    const actions = footer.createDiv({ cls: "simple-one-sync-preview__footer-actions" });
    if (this.live && this.stage === "content" && this.files.some(file => file.reviewStage === "file")) this.createButton(actions, "返回文件确认", () => { this.stage = "file"; this.page = 0; this.expandedPath = undefined; this.render(false); });
    const apply = actions.createEl("button", { text: this.live ? (this.stage === "file" && hasContent ? "下一步：确认内容" : "确认同步") : `应用选择${ready.length > 0 ? ` (${ready.length})` : ""}`, cls: "mod-cta" });
    apply.disabled = ready.length === 0 || !!this.live && ready.length !== stageFiles.length;
    apply.addEventListener("click", () => this.applyReadyFiles());
    body.scrollTop = scrollTop;
  }

  private renderFile(list: HTMLElement, file: PreviewFile): void {
    const expanded = this.expandedPath === file.path;
    const row = list.createDiv({ cls: "simple-one-sync-preview__file" });
    row.toggleClass("is-expanded", expanded);
    const summary = row.createDiv({ cls: "simple-one-sync-preview__summary" });
    const toggle = summary.createEl("button", { cls: "simple-one-sync-preview__toggle" });
    toggle.setAttr("aria-expanded", String(expanded));
    toggle.setAttr("aria-label", `${expanded ? "收起" : "展开"}${file.path}`);
    setIcon(toggle.createSpan({ cls: "simple-one-sync-preview__chevron" }), "chevron-right");
    const name = toggle.createSpan({ cls: "simple-one-sync-preview__name" });
    const displayPath = file.label ?? file.path;
    name.createSpan({ text: this.compact() ? displayPath.split("/").pop() ?? displayPath : displayPath, cls: "simple-one-sync-preview__path" });
    if (!this.live) name.createSpan({ text: file.description ?? `${file.blocks.length} 处差异`, cls: "simple-one-sync-preview__meta" });
    else summary.createDiv({ text: file.description ?? "文件内容不同", cls: "simple-one-sync-preview__reason" });
    const toggleFile = () => {
      this.expandedPath = expanded ? undefined : file.path;
      if (!expanded && this.live && !this.loaded.has(file.path)) void this.loadFile(file);
      this.render();
    };
    summary.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".simple-one-sync-preview__choice-control")) return;
      toggleFile();
    });

    if (!this.live) {
    const times = summary.createDiv({ cls: "simple-one-sync-preview__times" });
    times.setAttr("aria-expanded", String(expanded));
    times.setAttr("aria-label", `${expanded ? "收起" : "展开"}${file.path}，本机与 GitHub 更新时间`);
    for (const [side, text, value] of [["local", "本机", file.localUpdatedAt], ["remote", "GitHub", file.remoteUpdatedAt]] as const) {
      const line = times.createSpan({ cls: "simple-one-sync-preview__time" });
      line.toggleClass("is-newer", !this.live && this.latestSide(file) === side);
      line.createSpan({ text: this.live ? text : `${text}更新` });
      if (this.live) line.createSpan({ text: (side === "local" ? file.localPaths : file.remotePaths)?.join("、") ?? file.missingLabel ?? "删除" });
      else {
        const time = line.createEl("time", { text: this.formatTime(value) });
        time.setAttr("datetime", value);
      }
    }
    }
    const selected = this.fileChoices.get(file.path);
    const control = summary.createDiv({ cls: "simple-one-sync-preview__choice-control" });
    control.setAttr("aria-label", `${file.path}当前${this.fileStatus(file)}`);
    const segments = control.createDiv({ cls: "simple-one-sync-preview__segments" });
    const options: [FileChoice, string][] = this.live ? [["local", file.localChoiceLabel ?? "本机"], ["remote", file.remoteChoiceLabel ?? "GitHub"]] : [["latest", "最新"], ["local", "本机"], ["remote", "GitHub"]];
    if (file.allowBoth) options.push(["both", "保留两边"]);
    if (selected === "delete") options.push(["delete", "删除文件"]);
    segments.style.gridTemplateColumns = `repeat(${options.length}, minmax(0, 1fr))`;
    for (const [choice, label] of options) {
      const option = segments.createEl("button", { text: label, cls: `simple-one-sync-preview__segment is-${choice === "latest" ? this.latestSide(file) : choice}` });
      option.toggleClass("is-selected", selected === choice);
      option.setAttr("aria-label", `${file.path}选择${label}`);
      option.setAttr("aria-pressed", String(selected === choice));
      option.addEventListener("click", () => this.selectFile(file, choice));
    }

    if (expanded) {
      if (this.compact() && !file.showPaths && displayPath.includes("/")) row.createDiv({ text: displayPath, cls: "simple-one-sync-preview__path-details" });
      if (file.showPaths) {
        const paths = row.createDiv({ cls: "simple-one-sync-preview__path-details" });
        paths.createDiv({ text: "本机路径：" + (file.localPaths?.join("、") ?? "不存在") });
        paths.createDiv({ text: "云端路径：" + (file.remotePaths?.join("、") ?? "不存在") });
      }
      if (this.loading.has(file.path)) row.createDiv({ text: "正在读取差异…", cls: "simple-one-sync-preview__notice" });
      else if (this.readErrors.has(file.path)) {
        row.createDiv({ text: this.readErrors.get(file.path), cls: "simple-one-sync-preview__notice" });
        this.createButton(row, "重试", () => { void this.loadFile(file); });
      } else if (this.wholeContents.has(file.path)) this.renderWholeContents(row, file);
      else if (!file.blocks.length) row.createDiv({ text: file.missingLabel ? "此项按文件存在状态选择同步方向。" : this.live?.editableColumns ? "本机和远端内容一致，没有需要合并的差异区块。" : "内容相同，按文件或路径选择即可。", cls: "simple-one-sync-preview__notice" });
      else this.renderBlocks(row, file);
    }
  }

  private async loadFile(file: PreviewFile): Promise<void> {
    if (!this.live || this.loading.has(file.path)) return;
    this.loading.add(file.path); this.readErrors.delete(file.path);
    try {
      const content = await this.live.read(file);
      if (!this.active) return;
      if (file.allowBoth) { file.blocks = []; this.loaded.add(file.path); return; }
      if (file.mergeable === false || content.local === null || content.remote === null) {
        this.wholeContents.set(file.path, content);
        file.mergeable = false;
        file.blocks = [{ line: 1, local: "二进制或超过 200 KB 的文件，请按完整文件选择。", remote: "二进制或超过 200 KB 的文件，请按完整文件选择。" }];
      } else {
        const parts = textParts(content.local, content.remote);
        this.parts.set(file.path, parts);
        let line = 1;
        file.blocks = [];
        for (const part of parts) {
          if (part.common === undefined) file.blocks.push({ line, local: part.local!, remote: part.remote! });
          line += ((part.common ?? part.local ?? "").match(/\n/g) ?? []).length;
        }
      }
      this.loaded.add(file.path);
    } catch (error) { this.readErrors.set(file.path, error instanceof Error ? error.message : String(error)); }
    finally { this.loading.delete(file.path); if (this.active) this.render(); }
  }

  private renderWholeContents(row: HTMLElement, file: PreviewFile): void {
    const details = row.createDiv({ cls: "simple-one-sync-preview__whole-details" });
    const content = this.wholeContents.get(file.path)!;
    for (const side of ["local", "remote"] as const) {
      const paths = side === "local" ? file.localPaths : file.remotePaths;
      if (!paths?.length) continue;
      details.createEl("h4", { text: side === "local" ? "本机内容" : "云端内容" });
      if (content[side] === null) details.createDiv({ text: "二进制或超过 200 KB 的文件，按完整文件选择，不展开正文。" });
      else details.createEl("pre", { text: content[side] || "（空文件）", cls: "simple-one-sync-preview__whole-content" });
    }
  }

  private renderBlocks(row: HTMLElement, file: PreviewFile): void {
    const details = row.createDiv({ cls: "simple-one-sync-preview__details" });
    details.toggleClass("is-mixed", this.selectionTone(file) === "mixed");
    const columns = !!this.live?.editableColumns && !this.compact();
    details.toggleClass("is-editable-columns", columns);
    const headings = details.createDiv({ cls: "simple-one-sync-preview__block-headers" });
    for (const label of columns ? ["本机区块", "远端区块", "合并结果"] : ["差异", "本机区块", "Git 区块"]) {
      headings.createSpan({ text: label, cls: "simple-one-sync-preview__block-heading" });
    }
    file.blocks.forEach((block, index) => {
      const key = this.blockKey(file.path, index);
      const wholeChoice = this.fileChoices.get(file.path);
      const selection: BlockSelection | undefined = this.blockChoices.get(key) ?? (wholeChoice ? { method: wholeChoice === "latest" ? this.latestSide(file) : wholeChoice === "both" || wholeChoice === "delete" ? "local" : wholeChoice } : undefined);
      const blockRow = details.createDiv({ cls: "simple-one-sync-preview__block" });
      const title = blockRow.createDiv({ cls: "simple-one-sync-preview__block-title" });
      const caption = title.createDiv({ cls: "simple-one-sync-preview__block-caption" });
      caption.createSpan({ text: `差异 ${index + 1} / ${file.blocks.length}` });
      caption.createSpan({ text: `约第 ${block.line} 行`, cls: "simple-one-sync-preview__line" });
      const merge = this.createButton(title, selection?.method === "merged" ? "取消合并" : this.compact() ? "合并 / 编辑" : "合并", () => this.toggleMerge(file, index), "simple-one-sync-preview__merge");
      if (file.mergeable === false) merge.hidden = true;
      merge.toggleClass("is-selected", selection?.method === "merged");
      merge.setAttr("aria-pressed", String(selection?.method === "merged"));
      if (this.compact() && selection?.method !== "merged") merge.hidden = true;

      if (columns) {
        this.renderSide(blockRow, "本机", block.local, "local", selection?.method === "local", () => this.selectBlock(file, index, "local"));
        this.renderSide(blockRow, "GitHub", block.remote, "remote", selection?.method === "remote", () => this.selectBlock(file, index, "remote"));
      }
      if (selection?.method === "merged") {
        const result = blockRow.createDiv({ cls: "simple-one-sync-preview__result" });
        result.createDiv({ text: "合并结果 · 可直接编辑", cls: "simple-one-sync-preview__result-label" });
        const editor = result.createEl("textarea", { cls: "simple-one-sync-preview__editor" });
        editor.rows = Math.min(8, Math.max(4, (selection.text ?? "").split("\n").length + 1));
        editor.value = selection.text ?? "";
        editor.setAttr("aria-label", `${file.path}第 ${index + 1} 处最终内容`);
        editor.addEventListener("input", () => { selection.text = editor.value; });
      } else if (columns) {
        blockRow.createDiv({ text: "点击「合并」可编辑本区块；也可直接选择本机或远端。", cls: "simple-one-sync-preview__result" });
      } else if (this.compact()) {
        for (const side of ["local", "remote"] as const) {
          const panel = blockRow.createDiv({ cls: `simple-one-sync-preview__mobile-content is-${side}` });
          panel.createDiv({ text: side === "local" ? "本机内容" : "云端内容", cls: "simple-one-sync-preview__side-label" });
          panel.createDiv({ text: block[side], cls: "simple-one-sync-preview__side-content" });
        }
        const choices = title.createDiv({ cls: "simple-one-sync-preview__mobile-block-choices" });
        for (const side of ["local", "remote"] as const) {
          const button = this.createButton(choices, side === "local" ? "采用本机" : "采用云端", () => this.selectBlock(file, index, side), `simple-one-sync-preview__segment is-${side}`);
          button.toggleClass("is-selected", selection?.method === side);
          button.setAttr("aria-pressed", String(selection?.method === side));
          button.disabled = file.mergeable === false;
        }
        if (file.mergeable !== false) this.createButton(choices, "合并 / 编辑", () => this.toggleMerge(file, index), "simple-one-sync-preview__merge");
      } else {
        this.renderSide(blockRow, "本机", block.local, "local", selection?.method === "local", () => this.selectBlock(file, index, "local"), file.mergeable === false);
        this.renderSide(blockRow, "GitHub", block.remote, "remote", selection?.method === "remote", () => this.selectBlock(file, index, "remote"), file.mergeable === false);
      }
    });
  }

  private renderSide(parent: HTMLElement, label: string, content: string, side: Side, selected: boolean, choose: () => void, disabled = false): void {
    const panel = parent.createEl("button", { cls: `simple-one-sync-preview__side is-${side}` });
    panel.toggleClass("is-selected", selected);
    panel.setAttr("aria-label", `采用${label}区块`);
    panel.setAttr("aria-pressed", String(selected));
    panel.createSpan({ text: content, cls: "simple-one-sync-preview__side-content" });
    panel.addEventListener("click", choose);
    panel.disabled = disabled;
  }

  private createButton(parent: HTMLElement, label: string, action: () => void, className?: string): HTMLButtonElement {
    const button = parent.createEl("button", { text: label, cls: className });
    button.addEventListener("click", action);
    return button;
  }

  private blockKey(path: string, index: number): string {
    return `${path}:${index}`;
  }

  private latestSide(file: PreviewFile): Side {
    return Date.parse(file.localUpdatedAt) >= Date.parse(file.remoteUpdatedAt) ? "local" : "remote";
  }

  private selectionTone(file: PreviewFile): ChoiceTone | undefined {
    const whole = this.fileChoices.get(file.path);
    if (whole === "delete") return undefined;
    if (whole) return whole === "latest" ? this.latestSide(file) : whole === "both" ? "mixed" : whole;
    const methods = file.blocks.map((_, index) => this.blockChoices.get(this.blockKey(file.path, index))?.method);
    if (!methods.length || methods.some((method) => !method)) return undefined;
    return methods.every((method) => method === "local") ? "local" : methods.every((method) => method === "remote") ? "remote" : "mixed";
  }

  private formatTime(value: string): string {
    return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  private fileStatus(file: PreviewFile): string {
    const whole = this.fileChoices.get(file.path);
    if (whole) return whole === "latest" ? `最新 · ${this.latestSide(file) === "local" ? "本机" : "GitHub"}` : whole === "delete" ? "删除文件" : whole === "both" ? "保留两边" : whole === "local" ? file.localChoiceLabel ?? "本机" : file.remoteChoiceLabel ?? "GitHub";
    const chosen = file.blocks.filter((_, index) => this.blockChoices.has(this.blockKey(file.path, index))).length;
    return chosen === 0 ? "未决定" : chosen === file.blocks.length ? "区块已选好" : `已决定 ${chosen}/${file.blocks.length} 处`;
  }

  private selectFile(file: PreviewFile, choice: FileChoice): void {
    this.fileChoices.set(file.path, choice);
    for (let index = 0; index < file.blocks.length; index += 1) this.blockChoices.delete(this.blockKey(file.path, index));
    this.render();
  }

  private selectAll(choice: FileChoice): void {
    for (const file of this.stageFiles()) {
      if (this.pending.has(file.path)) {
        this.fileChoices.set(file.path, choice);
        for (let index = 0; index < file.blocks.length; index += 1) this.blockChoices.delete(this.blockKey(file.path, index));
      }
    }
    this.render();
  }

  private selectBlock(file: PreviewFile, index: number, method: BlockMethod): void {
    const key = this.blockKey(file.path, index);
    const previous = this.blockChoices.get(key);
    const block = file.blocks[index];
    const text = method === "merged"
      ? previous?.method === "merged" ? previous.text : `${block.local}\n\n${block.remote}`
      : undefined;
    const wholeChoice = this.fileChoices.get(file.path);
    if (wholeChoice) {
      const side = wholeChoice === "latest" ? this.latestSide(file) : wholeChoice === "both" || wholeChoice === "delete" ? "local" : wholeChoice;
      for (let other = 0; other < file.blocks.length; other += 1) {
        this.blockChoices.set(this.blockKey(file.path, other), { method: side });
      }
    }
    this.fileChoices.delete(file.path);
    this.blockChoices.set(key, { method, text });
    this.render();
  }

  private toggleMerge(file: PreviewFile, index: number): void {
    const key = this.blockKey(file.path, index);
    if (this.blockChoices.get(key)?.method === "merged") {
      this.blockChoices.delete(key);
      this.render();
      return;
    }
    this.selectBlock(file, index, "merged");
  }

  private stageFiles(): PreviewFile[] {
    return this.files.filter(file => this.pending.has(file.path) && (!this.live || (file.reviewStage ?? "content") === this.stage));
  }

  private clearStageChoices(): void {
    for (const file of this.stageFiles()) {
      this.fileChoices.delete(file.path);
      for (let i = 0; i < file.blocks.length; i++) this.blockChoices.delete(this.blockKey(file.path, i));
    }
    this.render();
  }

  private keepAll(): void {
    for (const file of this.stageFiles()) {
      if (file.keepSide) this.fileChoices.set(file.path, file.keepSide);
      else if (file.allowBoth) this.fileChoices.set(file.path, "both");
      else this.fileChoices.set(file.path, "local");
    }
    this.render();
  }

  private getReadyFiles(): PreviewFile[] {
    return this.files.filter((file) => this.pending.has(file.path) && (
      this.fileChoices.has(file.path) || file.mergeable !== false && file.blocks.length > 0 && file.blocks.every((_, index) => this.blockChoices.has(this.blockKey(file.path, index)))
    ));
  }

  private applyReadyFiles(): void {
    const ready = this.getReadyFiles();
    if (this.live) {
      if (this.stageFiles().some(file => !ready.includes(file))) return;
      if (this.stage === "file" && this.files.some(file => file.reviewStage !== "file")) {
        this.stage = "content"; this.page = 0; this.expandedPath = undefined; this.render(false); return;
      }
      if (ready.length !== this.pending.size) return;
    }
    for (const file of ready) {
      if (this.live) {
        const whole = this.fileChoices.get(file.path);
        this.results[file.path] = whole ? { choice: whole === "latest" ? this.latestSide(file) : whole } : {
          choice: "manual", text: resolveTextParts(this.parts.get(file.path)!, file.blocks.map((block, index) => {
            const selected = this.blockChoices.get(this.blockKey(file.path, index))!;
            return selected.method === "merged" ? selected.text ?? "" : block[selected.method];
          }))
        };
      }
      this.pending.delete(file.path);
      this.fileChoices.delete(file.path);
      for (let index = 0; index < file.blocks.length; index += 1) this.blockChoices.delete(this.blockKey(file.path, index));
    }
    this.appliedCount += ready.length;
    if (this.expandedPath && !this.pending.has(this.expandedPath)) this.expandedPath = undefined;
    if (this.live && this.pending.size === 0) {
      this.resolve?.(this.results); this.resolve = undefined; this.close(); return;
    }
    this.render(false);
  }

  private reset(): void {
    this.pending = new Set(this.files.map((file) => file.path));
    this.results = {}; this.page = 0;
    this.stage = this.live && this.files.some(file => file.reviewStage === "file") ? "file" : "content";
    this.expandedPath = undefined;
    this.fileChoices.clear();
    this.blockChoices.clear();
    this.appliedCount = 0;
    this.render(false);
  }
}
