import { confirmAction } from "../shared/confirm";
import { Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type SimplePlugin from "../main";
import { applyModalScale, getMainAppWindow } from "../shared/popupSizing";

type UnusedAttachment = {
  file: TFile;
  checked: boolean;
};

type RenamePlan = {
  file: TFile;
  source: TFile;
  targetPath: string;
  checked: boolean;
};

type AttachmentOrganizePlan = {
  file: TFile;
  source: TFile;
  references: TFile[];
  targetPath: string;
  checked: boolean;
};

type InlineImagePlan = {
  source: TFile;
  match: string;
  base64: string;
  start: number;
  end: number;
  targetPath: string;
  checked: boolean;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
const NOTE_EXTENSIONS = new Set(["md", "canvas", "base"]);
const INLINE_IMAGE_RE = /!\[[^\]]*]\(data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,([A-Za-z0-9+/=\r\n]+)\)/g;

export type AttachmentLocation =
  | { mode: "fixed-folder"; raw: string; folder: string }
  | { mode: "vault-root"; raw: string }
  | { mode: "same-folder"; raw: string }
  | { mode: "current-subfolder"; raw: string; subfolder: string }
  | { mode: "unknown"; raw: string | null };

export function readObsidianAttachmentLocation(plugin: SimplePlugin): AttachmentLocation {
  const vault = plugin.app.vault as unknown as { getConfig?: (key: string) => unknown };
  const value = vault.getConfig?.("attachmentFolderPath");
  if (typeof value !== "string" || !value.trim()) return { mode: "unknown", raw: null };

  const raw = value.trim().replace(/\\/g, "/");
  if (raw === "/") return { mode: "vault-root", raw };
  if (raw === "." || raw === "./") return { mode: "same-folder", raw };
  if (raw.startsWith("./")) {
    const subfolder = normalizePath(raw.slice(2));
    return subfolder
      ? { mode: "current-subfolder", raw, subfolder }
      : { mode: "same-folder", raw };
  }
  return { mode: "fixed-folder", raw, folder: normalizePath(raw) };
}

export function describeAttachmentLocation(location: AttachmentLocation): string {
  switch (location.mode) {
    case "fixed-folder": return `指定的文件夹：${location.folder}`;
    case "vault-root": return "Vault 根目录（/）";
    case "same-folder": return "当前文件所在的文件夹（./）";
    case "current-subfolder": return `当前文件夹的子文件夹（./${location.subfolder}）`;
    default: return location.raw ? `无法识别：${location.raw}` : "无法读取当前设置";
  }
}

export async function checkUnusedAttachments(plugin: SimplePlugin): Promise<void> {
  const location = requireAttachmentMode(plugin, "清理未引用附件", ["fixed-folder"]);
  if (!location || location.mode !== "fixed-folder") return;
  const folder = getFixedAttachmentFolder(plugin, location);
  if (!folder) return;

  const used = referencedPaths(plugin);
  const items = filesInFolder(folder)
    .filter((file) => isAttachmentCandidate(file) && !used.has(file.path))
    .map((file) => ({ file, checked: isImage(file) }));

  if (!items.length) {
    new Notice("未发现未引用附件");
    return;
  }

  new UnusedAttachmentModal(plugin, items).open();
}

export async function planAttachmentImageRename(plugin: SimplePlugin): Promise<void> {
  const location = requireAttachmentMode(plugin, "图片重命名并按笔记归位", ["fixed-folder", "same-folder", "current-subfolder"]);
  if (!location) return;

  const references = attachmentReferences(plugin);
  const ambiguousNameBases = ambiguousAttachmentNameBases(plugin);
  const counters = new Map<string, number>();
  const existingTargets = new Set(plugin.app.vault.getFiles().map((file) => file.path));
  const plans: RenamePlan[] = [];
  const candidates = imageRenameCandidates(plugin, location, references);

  for (const file of candidates) {
    if (!isImage(file)) continue;

    const source = pickSourceNote(plugin, file, references.get(file.path), location);
    if (!source) continue;

    const targetFolder = imageTargetFolderForSource(plugin, location, file, source);
    const desiredPath = looksMeaningless(file.basename)
      ? nextNumberedPath(
          targetFolder,
          attachmentNameBaseForSource(plugin, source, ambiguousNameBases),
          file.extension,
          existingTargets,
          counters
        )
      : normalizePath(`${targetFolder}/${file.name}`);
    const targetPath = desiredPath === file.path ? desiredPath : uniquePath(desiredPath, existingTargets);
    existingTargets.add(targetPath);
    if (targetPath !== file.path) plans.push({ file, source, targetPath, checked: true });
  }

  if (!plans.length) {
    new Notice("未发现需要重命名或归位的图片");
    return;
  }

  new RenamePlanModal(plugin, plans).open();
}

export async function planAttachmentOrganization(plugin: SimplePlugin): Promise<void> {
  const location = requireAttachmentMode(plugin, "非图片附件按笔记归位", ["fixed-folder", "current-subfolder"]);
  if (!location) return;

  const references = attachmentReferences(plugin);
  const existingTargets = new Set(plugin.app.vault.getFiles().map((file) => file.path));
  const plans: AttachmentOrganizePlan[] = [];
  const candidates = organizationCandidates(plugin, location, references);

  for (const file of candidates) {
    // Markdown files are notes, and images have their own rename/classify flow.
    if (!isAttachmentCandidate(file) || isImage(file)) continue;
    const linkedNotes = (references.get(file.path) ?? []).sort((a, b) => a.path.localeCompare(b.path));
    const source = pickSourceNote(plugin, file, linkedNotes, location);
    if (!source) continue;

    const targetFolder = preciseTargetFolderForSource(location, source);
    const desiredPath = normalizePath(`${targetFolder}/${file.name}`);
    const targetPath = file.path === desiredPath ? desiredPath : uniquePath(desiredPath, existingTargets);
    existingTargets.add(targetPath);
    if (targetPath !== file.path) {
      plans.push({ file, source, references: linkedNotes, targetPath, checked: true });
    }
  }

  if (!plans.length) {
    new Notice("未发现需要归位的非图片附件");
    return;
  }

  new AttachmentOrganizationModal(plugin, plans).open();
}

export async function planInlineImageExtraction(plugin: SimplePlugin): Promise<void> {
  const location = requireAttachmentMode(plugin, "内嵌图片转为附件", ["fixed-folder", "same-folder", "current-subfolder"]);
  if (!location) return;
  const existingTargets = new Set(plugin.app.vault.getFiles().map((file) => file.path));
  const counters = new Map<string, number>();
  const ambiguousNameBases = ambiguousAttachmentNameBases(plugin);
  const plans: InlineImagePlan[] = [];

  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const content = await plugin.app.vault.cachedRead(file);
    for (const match of content.matchAll(INLINE_IMAGE_RE)) {
      const mimeExt = match[1].toLowerCase() === "svg+xml" ? "svg" : match[1].toLowerCase().replace("jpeg", "jpg");
      const nameBase = attachmentNameBaseForSource(plugin, file, ambiguousNameBases);
      const targetPath = location.mode === "fixed-folder"
        ? nextNumberedPath(imageTargetFolderForSource(plugin, location, file, file), nameBase, mimeExt, existingTargets, counters)
        : await nextObsidianAttachmentPath(plugin, file, nameBase, mimeExt, existingTargets, counters);
      existingTargets.add(targetPath);
      plans.push({
        source: file,
        match: match[0],
        base64: match[2],
        start: match.index,
        end: match.index + match[0].length,
        targetPath,
        checked: true,
      });
    }
  }

  if (!plans.length) {
    new Notice("未发现 base64 内嵌图片");
    return;
  }

  new InlineImagePlanModal(plugin, plans).open();
}

function getFixedAttachmentFolder(plugin: SimplePlugin, location: Extract<AttachmentLocation, { mode: "fixed-folder" }>): TFolder | null {
  const folder = plugin.app.vault.getAbstractFileByPath(location.folder);
  if (folder instanceof TFolder) return folder;
  new Notice(`附件目录不存在：${location.folder}`);
  return null;
}

function requireAttachmentMode(
  plugin: SimplePlugin,
  feature: string,
  allowed: AttachmentLocation["mode"][]
): AttachmentLocation | null {
  const location = readObsidianAttachmentLocation(plugin);
  if (allowed.includes(location.mode)) return location;
  new Notice(`${feature}在“${describeAttachmentLocation(location)}”模式下已禁用`);
  return null;
}

function filesInFolder(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile) out.push(child);
    if (child instanceof TFolder) out.push(...filesInFolder(child));
  }
  return out;
}

function isAttachmentCandidate(file: TFile): boolean {
  return !NOTE_EXTENSIONS.has(file.extension.toLowerCase());
}

function referencedPaths(plugin: SimplePlugin): Set<string> {
  const paths = new Set<string>();
  for (const links of Object.values(plugin.app.metadataCache.resolvedLinks)) {
    for (const path of Object.keys(links)) paths.add(path);
  }
  return paths;
}

function attachmentReferences(plugin: SimplePlugin): Map<string, TFile[]> {
  const out = new Map<string, TFile[]>();
  for (const [sourcePath, links] of Object.entries(plugin.app.metadataCache.resolvedLinks)) {
    const source = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile) || source.extension !== "md") continue;
    for (const path of Object.keys(links)) {
      const list = out.get(path) ?? [];
      list.push(source);
      out.set(path, list);
    }
  }
  return out;
}

function pickSourceNote(
  plugin: SimplePlugin,
  attachment: TFile,
  files: TFile[] | undefined,
  location: AttachmentLocation
): TFile | null {
  const sorted = [...(files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  if (location.mode === "fixed-folder") {
    return sorted.find((file) => isFixedFolderSource(plugin, file, location)) ?? null;
  }
  if (location.mode === "same-folder") {
    return sorted.find((file) => file.parent?.path === attachment.parent?.path) ?? null;
  }
  if (location.mode === "current-subfolder") {
    return sorted.find((file) => isPathInside(attachment.path, currentSubfolderForSource(location, file))) ?? null;
  }
  return null;
}

function isFixedFolderSource(
  plugin: SimplePlugin,
  source: TFile,
  location: Extract<AttachmentLocation, { mode: "fixed-folder" }>
): boolean {
  if (isPathInside(source.path, location.folder)) return false;
  const templateFolder = plugin.getTemplateFolder();
  return (!templateFolder || !isPathInside(source.path, templateFolder))
    && source.path !== plugin.app.vault.configDir
    && !source.path.startsWith(`${plugin.app.vault.configDir}/`);
}

function attachmentNameBaseForSource(plugin: SimplePlugin, source: TFile, ambiguousNameBases: Set<string>): string {
  const top = topLevelForSource(plugin, source);
  const parent = source.parent?.name && source.parent.path !== top ? source.parent.name : "";
  const base = parent ? safeName(`${parent}-${source.basename}`) : safeName(source.basename);
  if (top && !ambiguousNameBases.has(`${top}/${base}`)) return base;
  return safeName(`${base} ${formatTimestamp(source.stat.ctime || source.stat.mtime)}`);
}

function ambiguousAttachmentNameBases(plugin: SimplePlugin): Set<string> {
  const counts = new Map<string, number>();
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const top = topLevelForSource(plugin, file);
    if (!top) continue;
    const parent = file.parent?.name && file.parent.path !== top ? file.parent.name : "";
    const base = parent ? safeName(`${parent}-${file.basename}`) : safeName(file.basename);
    const key = `${top}/${base}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

function imageTargetFolderForSource(plugin: SimplePlugin, location: AttachmentLocation, attachment: TFile, source: TFile): string {
  if (location.mode === "fixed-folder") {
    const top = topLevelForSource(plugin, source, location);
    return top ? normalizePath(`${location.folder}/${top}`) : location.folder;
  }
  return attachment.parent?.path === "/" ? "" : attachment.parent?.path ?? "";
}

function preciseTargetFolderForSource(location: AttachmentLocation, source: TFile): string {
  const noteFolderName = safeName(source.basename);
  if (location.mode === "fixed-folder") {
    const noteFolder = source.parent?.path ? safePath(source.parent.path) : "";
    return normalizePath([location.folder, noteFolder, noteFolderName].filter(Boolean).join("/"));
  }
  if (location.mode === "current-subfolder") {
    return normalizePath(`${currentSubfolderForSource(location, source)}/${noteFolderName}`);
  }
  return source.parent?.path ?? "";
}

function safePath(path: string): string {
  return path.split("/").map((part) => safeName(part)).filter(Boolean).join("/");
}

function topLevelForSource(plugin: SimplePlugin, source: TFile, location = readObsidianAttachmentLocation(plugin)): string | null {
  const parts = source.path.split("/");
  if (parts.length < 2) return null;
  const templateFolder = plugin.getTemplateFolder();
  if (templateFolder && isPathInside(source.path, templateFolder)) return null;
  const top = parts[0];
  const attachmentTop = location.mode === "fixed-folder" ? location.folder.split("/")[0] : "";
  const excluded = new Set([attachmentTop, plugin.app.vault.configDir.split("/")[0]]);
  if (!top || excluded.has(top)) return null;
  return top;
}

function currentSubfolderForSource(
  location: Extract<AttachmentLocation, { mode: "current-subfolder" }>,
  source: TFile
): string {
  const parent = source.parent?.path;
  return normalizePath([parent === "/" ? "" : parent, location.subfolder].filter(Boolean).join("/"));
}

function isPathInside(path: string, folder: string): boolean {
  const normalizedFolder = normalizePath(folder).replace(/\/$/, "");
  return path === normalizedFolder || path.startsWith(`${normalizedFolder}/`);
}

function imageRenameCandidates(
  plugin: SimplePlugin,
  location: AttachmentLocation,
  references: Map<string, TFile[]>
): TFile[] {
  if (location.mode === "fixed-folder") {
    const folder = getFixedAttachmentFolder(plugin, location);
    return folder ? filesInFolder(folder) : [];
  }
  return referencedAttachmentFiles(plugin, references).filter((file) =>
    Boolean(pickSourceNote(plugin, file, references.get(file.path), location))
  );
}

function organizationCandidates(
  plugin: SimplePlugin,
  location: AttachmentLocation,
  references: Map<string, TFile[]>
): TFile[] {
  if (location.mode === "fixed-folder") {
    const folder = getFixedAttachmentFolder(plugin, location);
    return folder ? filesInFolder(folder) : [];
  }
  return referencedAttachmentFiles(plugin, references).filter((file) =>
    Boolean(pickSourceNote(plugin, file, references.get(file.path), location))
  );
}

function referencedAttachmentFiles(plugin: SimplePlugin, references: Map<string, TFile[]>): TFile[] {
  const files: TFile[] = [];
  for (const path of references.keys()) {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && isAttachmentCandidate(file)) files.push(file);
  }
  return files;
}

function isImage(file: TFile): boolean {
  return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
}

function looksMeaningless(name: string): boolean {
  return /^Pasted image \d+/i.test(name)
    || /^IMG[_-]?\d{3,}$/i.test(name)
    || /^\d{8,}/.test(name)
    || /^[a-f0-9]{12,}$/i.test(name)
    || /^[A-Za-z0-9_-]{16,}$/.test(name)
    || (/^[A-Za-z0-9()[\]{}_-]{12,}$/.test(name) && !/[a-z]{4,}/i.test(name));
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim() || "attachment";
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function uniquePath(path: string, existing: Set<string>): string {
  if (!existing.has(path)) return path;
  const dot = path.lastIndexOf(".");
  const base = dot >= 0 ? path.slice(0, dot) : path;
  const ext = dot >= 0 ? path.slice(dot) : "";
  let index = 2;
  while (existing.has(`${base} ${index}${ext}`)) index++;
  return `${base} ${index}${ext}`;
}

function nextNumberedPath(
  targetFolder: string,
  nameBase: string,
  extension: string,
  existing: Set<string>,
  counters: Map<string, number>
): string {
  const key = `${targetFolder}/${nameBase}.${extension.toLowerCase()}`;
  let next = counters.get(key);
  if (!next) {
    const prefix = normalizePath(`${targetFolder}/${nameBase} `);
    const suffix = `.${extension.toLowerCase()}`;
    let max = 0;
    for (const path of existing) {
      const lower = path.toLowerCase();
      if (!lower.startsWith(prefix.toLowerCase()) || !lower.endsWith(suffix)) continue;
      const number = Number(path.slice(prefix.length, path.length - suffix.length));
      if (Number.isInteger(number) && number > max) max = number;
    }
    next = max + 1;
  }
  counters.set(key, next + 1);
  return uniquePath(normalizePath(`${targetFolder}/${nameBase} ${next}.${extension}`), existing);
}

async function nextObsidianAttachmentPath(
  plugin: SimplePlugin,
  source: TFile,
  nameBase: string,
  extension: string,
  existing: Set<string>,
  counters: Map<string, number>
): Promise<string> {
  const key = `${source.path}/${nameBase}.${extension.toLowerCase()}`;
  let next = counters.get(key) ?? 1;
  while (true) {
    const filename = `${nameBase} ${next}.${extension}`;
    const path = normalizePath(await plugin.app.fileManager.getAvailablePathForAttachment(filename, source.path));
    next++;
    if (existing.has(path)) continue;
    counters.set(key, next);
    return path;
  }
}

async function ensureFolder(plugin: SimplePlugin, path: string): Promise<void> {
  if (!path || path === "/") return;
  const parts = normalizePath(path).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) await plugin.app.vault.createFolder(current);
  }
}

class UnusedAttachmentModal extends Modal {
  constructor(private plugin: SimplePlugin, private items: UnusedAttachment[]) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-attachment-modal");
    applyModalScale(this.modalEl, this.plugin.displaySettings.popupWindowScale, getMainAppWindow(this.plugin.app));
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "未引用附件" });
    this.contentEl.createDiv({ cls: "setting-item-description", text: "图片默认勾选；JSON、txt 等非图片默认不勾选。确认后删除到 Obsidian 回收站。" });
    renderChecklist(this.contentEl, this.items, (item) => item.file.path);
    this.renderActions(async () => {
      const selected = this.items.filter((item) => item.checked);
      if (!selected.length) return;
      if (!await confirmAction(this.plugin.app, `删除选中的 ${selected.length} 个未引用附件？`)) return;
      for (const item of selected) await this.plugin.app.fileManager.trashFile(item.file);
      new Notice(`已删除 ${selected.length} 个附件`);
      this.close();
    });
  }

  private renderActions(onConfirm: () => Promise<void>): void {
    const actions = this.contentEl.createDiv({ cls: "simple-json-actions" });
    actions.createEl("button", { text: "全选" }).addEventListener("click", () => {
      setChecked(this.contentEl, this.items, true);
    });
    actions.createEl("button", { text: "反选" }).addEventListener("click", () => {
      invertChecked(this.contentEl, this.items);
    });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "删除勾选项" }).addEventListener("click", () => void onConfirm());
  }
}

class RenamePlanModal extends Modal {
  private progressEl: HTMLElement | null = null;

  constructor(private plugin: SimplePlugin, private plans: RenamePlan[]) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-attachment-modal", "simple-rename-modal");
    applyModalScale(this.modalEl, this.plugin.displaySettings.popupWindowScale, getMainAppWindow(this.plugin.app));
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "图片重命名并按笔记归位清单" });
    this.contentEl.createDiv({ cls: "setting-item-description", text: "只处理勾选项；执行时会让 Obsidian 更新引用。" });
    renderRenameChecklist(this.contentEl, this.plans);
    const actions = this.contentEl.createDiv({ cls: "simple-json-actions" });
    const execute = actions.createEl("button", { text: "执行", cls: "mod-cta" });
    execute.addEventListener("click", () => {
      execute.disabled = true;
      void this.applyPlans().finally(() => { execute.disabled = false; });
    });
    this.progressEl = this.contentEl.createDiv({ cls: "simple-attachment-progress" });
  }

  private async applyPlans(): Promise<void> {
    const selected = this.plans.filter((plan) => plan.checked);
    if (!selected.length) return;
    if (!await confirmAction(this.plugin.app, `重命名/移动选中的 ${selected.length} 张图片？`)) return;
    document.body.classList.add("simple-hide-notices");
    try {
      for (let index = 0; index < selected.length; index++) {
        const plan = selected[index];
        if (this.progressEl) this.progressEl.setText(`处理进度：${index + 1} / ${selected.length}`);
        await ensureFolder(this.plugin, plan.targetPath.split("/").slice(0, -1).join("/"));
        await this.plugin.app.fileManager.renameFile(plan.file, plan.targetPath);
      }
      this.close();
      new Notice(`已处理 ${selected.length} 张图片`);
    } catch (error) {
      if (this.progressEl) this.progressEl.setText(`处理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      document.body.classList.remove("simple-hide-notices");
    }
  }
}

class AttachmentOrganizationModal extends Modal {
  private progressEl: HTMLElement | null = null;

  constructor(private plugin: SimplePlugin, private plans: AttachmentOrganizePlan[]) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-attachment-modal", "simple-rename-modal");
    applyModalScale(this.modalEl, this.plugin.displaySettings.popupWindowScale, getMainAppWindow(this.plugin.app));
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "非图片附件按笔记归位清单" });
    this.contentEl.createDiv({
      cls: "setting-item-description",
      text: "按引用笔记归位至附件目录/笔记所在目录/笔记名；多处引用时采用路径最靠前的笔记。",
    });
    renderRenameChecklist(this.contentEl, this.plans);
    const actions = this.contentEl.createDiv({ cls: "simple-json-actions" });
    const execute = actions.createEl("button", { text: "执行", cls: "mod-cta" });
    execute.addEventListener("click", () => {
      execute.disabled = true;
      void this.applyPlans().finally(() => { execute.disabled = false; });
    });
    this.progressEl = this.contentEl.createDiv({ cls: "simple-attachment-progress" });
  }

  private async applyPlans(): Promise<void> {
    const selected = this.plans.filter((plan) => plan.checked);
    if (!selected.length) return;
    if (!await confirmAction(this.plugin.app, `将选中的 ${selected.length} 个附件按笔记归位？`)) return;
    document.body.classList.add("simple-hide-notices");
    try {
      for (let index = 0; index < selected.length; index++) {
        const plan = selected[index];
        if (this.progressEl) this.progressEl.setText(`处理进度：${index + 1} / ${selected.length}`);
        await ensureFolder(this.plugin, plan.targetPath.split("/").slice(0, -1).join("/"));
        await this.plugin.app.fileManager.renameFile(plan.file, plan.targetPath);
      }
      this.close();
      new Notice(`已归位 ${selected.length} 个附件`);
    } catch (error) {
      if (this.progressEl) this.progressEl.setText(`处理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      document.body.classList.remove("simple-hide-notices");
    }
  }
}

class InlineImagePlanModal extends Modal {
  private progressEl: HTMLElement | null = null;

  constructor(private plugin: SimplePlugin, private plans: InlineImagePlan[]) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-attachment-modal");
    applyModalScale(this.modalEl, this.plugin.displaySettings.popupWindowScale, getMainAppWindow(this.plugin.app));
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "内嵌图片转为附件清单" });
    this.contentEl.createDiv({ cls: "setting-item-description", text: "把 Markdown 中直接嵌入的 base64 图片保存为独立附件，并替换为 Obsidian 图片链接。" });
    renderChecklist(this.contentEl, this.plans, (plan) => `${plan.source.path}\n→ ${plan.targetPath}`);
    const actions = this.contentEl.createDiv({ cls: "simple-json-actions" });
    actions.createEl("button", { text: "全选" }).addEventListener("click", () => {
      setChecked(this.contentEl, this.plans, true);
    });
    actions.createEl("button", { text: "反选" }).addEventListener("click", () => {
      invertChecked(this.contentEl, this.plans);
    });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "执行勾选项" }).addEventListener("click", () => void this.applyPlans());
    this.progressEl = this.contentEl.createDiv({ cls: "simple-attachment-progress" });
  }

  private async applyPlans(): Promise<void> {
    const selected = this.plans.filter((plan) => plan.checked);
    if (!selected.length) return;
    if (!await confirmAction(this.plugin.app, `将选中的 ${selected.length} 张内嵌图片保存为附件？`)) return;

    try {
      for (let index = 0; index < selected.length; index++) {
        const plan = selected[index];
        if (this.progressEl) this.progressEl.setText(`处理进度：${index + 1} / ${selected.length}`);
        await ensureFolder(this.plugin, plan.targetPath.split("/").slice(0, -1).join("/"));
        await this.plugin.app.vault.createBinary(plan.targetPath, base64ToArrayBuffer(plan.base64));
      }

      for (const [source, plans] of groupBySource(selected)) {
        let content = await this.plugin.app.vault.cachedRead(source);
        for (const plan of [...plans].sort((a, b) => b.start - a.start)) {
          content = `${content.slice(0, plan.start)}![[${plan.targetPath}]]${content.slice(plan.end)}`;
        }
        await this.plugin.app.vault.modify(source, content);
      }

      this.close();
      new Notice(`已将 ${selected.length} 张内嵌图片保存为附件`);
    } catch (error) {
      if (this.progressEl) this.progressEl.setText(`处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function renderChecklist<T extends { checked: boolean }>(container: HTMLElement, items: T[], text: (item: T) => string): void {
  const list = container.createDiv({ cls: "simple-attachment-list" });
  for (const item of items) {
    const label = list.createEl("label", { cls: "simple-attachment-row" });
    const checkbox = label.createEl("input", { type: "checkbox" });
    checkbox.checked = item.checked;
    checkbox.addEventListener("change", () => {
      item.checked = checkbox.checked;
    });
    const lines = text(item).split("\n").map((line) => line.trim()).filter(Boolean);
    const detail = label.createDiv({ cls: "simple-attachment-detail", attr: { title: lines.join("\n") } });
    detail.createDiv({ cls: "simple-attachment-path", text: lines[0] ?? "" });
    for (const line of lines.slice(1)) {
      detail.createDiv({ cls: "simple-attachment-subpath", text: line });
    }
  }
}

function renderRenameChecklist(container: HTMLElement, plans: RenamePlan[]): void {
  const list = container.createDiv({ cls: "simple-attachment-list simple-rename-list" });
  for (const plan of plans) {
    const row = list.createEl("label", { cls: "simple-attachment-row simple-rename-row" });
    const checkbox = row.createEl("input", { type: "checkbox" });
    checkbox.checked = plan.checked;
    checkbox.addEventListener("change", () => {
      plan.checked = checkbox.checked;
    });

    const detail = row.createDiv({
      cls: "simple-attachment-detail simple-rename-comparison",
      attr: { title: `修改前：${plan.file.path}\n修改后：${plan.targetPath}` },
    });
    const diff = changedPathSegments(plan.file.path, plan.targetPath);
    renderRenamePath(detail, "修改前", diff.before, false);
    renderRenamePath(detail, "修改后", diff.after, true);
  }
}

type RenamePathSegment = {
  text: string;
  changed: boolean;
};

function changedPathSegments(beforePath: string, afterPath: string): {
  before: RenamePathSegment[];
  after: RenamePathSegment[];
} {
  const before = beforePath.split("/");
  const after = afterPath.split("/");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  // Collapse shared directories only; always keep each filename visible.
  const sharedDirectories = Math.min(prefix, before.length - 1, after.length - 1);
  const compact = (segments: RenamePathSegment[]): RenamePathSegment[] => sharedDirectories > 0
    ? [{ text: "...", changed: false }, ...segments.slice(sharedDirectories)]
    : segments;
  return {
    before: compact(before.map((text, index) => ({
      text,
      changed: index >= prefix && index < before.length - suffix,
    }))),
    after: compact(after.map((text, index) => ({
      text,
      changed: index >= prefix && index < after.length - suffix,
    }))),
  };
}

function renderRenamePath(
  container: HTMLElement,
  label: string,
  segments: RenamePathSegment[],
  emphasizeChanges: boolean
): void {
  container.createSpan({
    cls: `simple-rename-label ${emphasizeChanges ? "is-after" : "is-before"}`,
    text: label,
  });
  const path = container.createDiv({ cls: "simple-rename-path" });
  segments.forEach((segment, index) => {
    if (index > 0) path.createSpan({ text: "/" });
    path.createSpan({
      cls: emphasizeChanges && segment.changed ? "simple-rename-changed" : "",
      text: segment.text,
    });
  });
}

function groupBySource(plans: InlineImagePlan[]): Map<TFile, InlineImagePlan[]> {
  const out = new Map<TFile, InlineImagePlan[]>();
  for (const plan of plans) {
    const list = out.get(plan.source) ?? [];
    list.push(plan);
    out.set(plan.source, list);
  }
  return out;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function setChecked<T extends { checked: boolean }>(container: HTMLElement, items: T[], checked: boolean): void {
  for (const item of items) item.checked = checked;
  syncCheckboxes(container, items);
}

function invertChecked<T extends { checked: boolean }>(container: HTMLElement, items: T[]): void {
  for (const item of items) item.checked = !item.checked;
  syncCheckboxes(container, items);
}

function syncCheckboxes<T extends { checked: boolean }>(container: HTMLElement, items: T[]): void {
  const boxes = Array.from(container.querySelectorAll<HTMLInputElement>(".simple-attachment-row input[type='checkbox']"));
  boxes.forEach((box, index) => {
    box.checked = items[index]?.checked ?? false;
  });
}
