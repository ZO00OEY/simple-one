import { confirmAction } from "../shared/confirm";
import { styleActionFooter, styleActionButton } from "../shared/actionButton";
import { Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type SimplePlugin from "../main";
import { applyModalScale, getMainAppWindow } from "../shared/popupSizing";

type UnusedAttachment = {
  file: TFile | TFolder;
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

type AutomaticRun = {
  active: () => boolean;
  paths?: ReadonlySet<string>;
  notes?: TFile[];
  canDelete?: (file: TFile | TFolder) => boolean;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
const NOTE_EXTENSIONS = new Set(["md", "canvas", "base"]);
const INLINE_IMAGE_RE = /!\[[^\]]*]\(data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,([A-Za-z0-9+/=\r\n]+)\)/g;

export const DEFAULT_ATTACHMENT_FOLDER = "999 attachment";
const referenceReadiness = new WeakMap<SimplePlugin, () => boolean>();
export function registerAttachmentCleanupGuard(plugin: SimplePlugin, ready: () => boolean): void {
  referenceReadiness.set(plugin, ready);
}
function attachmentReferencesReady(plugin: SimplePlugin): boolean {
  return referenceReadiness.get(plugin)?.() === true
    && plugin.app.vault.getMarkdownFiles().every(file => Boolean(plugin.app.metadataCache.getFileCache(file)));
}
const REFERENCES_PENDING = "笔记引用索引尚未完成，请等待后重新扫描附件。";

export async function initializeAttachmentDefaults(plugin: SimplePlugin): Promise<void> {
  if (plugin.settings.attachmentDefaultsInitialized) return;
  const vault = plugin.app.vault as typeof plugin.app.vault & {
    getConfig?: (key: string) => unknown;
    setConfig?: (key: string, value: string) => void | Promise<void>;
  };
  if (!vault.getConfig) return;
  const current = vault.getConfig("attachmentFolderPath");
  if (current === undefined || current === null || current === "" || current === "/") {
    if (!vault.setConfig) return;
    const folder = vault.getAbstractFileByPath(DEFAULT_ATTACHMENT_FOLDER);
    if (folder && !(folder instanceof TFolder)) throw new Error(`${DEFAULT_ATTACHMENT_FOLDER} 已被文件占用，请手动选择附件文件夹`);
    if (!folder) await vault.createFolder(DEFAULT_ATTACHMENT_FOLDER);
    await vault.setConfig("attachmentFolderPath", DEFAULT_ATTACHMENT_FOLDER);
    if (vault.getConfig("attachmentFolderPath") !== DEFAULT_ATTACHMENT_FOLDER) throw new Error("Obsidian 未应用默认附件目录设置");
  }
  plugin.settings.attachmentDefaultsInitialized = true;
  await plugin.saveSettings();
}

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

export async function checkUnusedAttachments(plugin: SimplePlugin, automatic?: AutomaticRun): Promise<void> {
  const location = requireAttachmentMode(plugin, "清理未引用附件与空文件夹", ["fixed-folder"], Boolean(automatic));
  if (!location || location.mode !== "fixed-folder") return;
  const folder = getFixedAttachmentFolder(plugin, location, Boolean(automatic));
  if (!folder) return;
  if (!attachmentReferencesReady(plugin)) { if (!automatic) new Notice(REFERENCES_PENDING); return; }

  const used = referencedPaths(plugin);
  const items: UnusedAttachment[] = [...filesInFolder(folder), ...rootAttachmentFiles(plugin).filter(isImage)]
    .filter((file) => isAttachmentCandidate(file) && !used.has(file.path))
    .map((file) => ({ file, checked: isImage(file) && !isRootFile(file) }));
  items.push(...(await emptyFoldersInFolder(plugin, folder)).map((file) => ({ file, checked: true })));
  if (!attachmentReferencesReady(plugin)) { if (!automatic) new Notice(REFERENCES_PENDING); return; }

  if (automatic) {
    const selected = items.filter(item => item.checked && automatic.canDelete?.(item.file));
    if (automatic.active()) await deleteUnusedAttachments(plugin, selected, automatic.active);
    return;
  }

  if (!items.length) {
    new Notice("未发现未引用附件或空文件夹");
    return;
  }

  new UnusedAttachmentModal(plugin, items).open();
}

export async function planAttachmentImageRename(plugin: SimplePlugin, automatic?: AutomaticRun): Promise<void> {
  const location = requireAttachmentMode(plugin, "重命名图片并整理存放", ["fixed-folder", "same-folder", "current-subfolder"], Boolean(automatic));
  if (!location) return;

  const references = attachmentReferences(plugin);
  const ambiguousNameBases = ambiguousAttachmentNameBases(plugin);
  const counters = new Map<string, number>();
  const existingTargets = new Set(plugin.app.vault.getFiles().map((file) => file.path));
  const plans: RenamePlan[] = [];
  for (const file of organizationCandidates(plugin, location, references, Boolean(automatic))) {
    if (!isImage(file) || (automatic?.paths && !automatic.paths.has(file.path))) continue;
    const source = pickSourceNote(plugin, file, references.get(file.path), location);
    if (!source) continue;
    const targetFolder = location.mode === "fixed-folder"
      ? attachmentTargetFolder(location, source, plugin.settings.imageAttachmentFolderMode === "note")
      : imageTargetFolderForSource(plugin, location, file, source);
    const nameBase = attachmentNameBaseForSource(plugin, source, ambiguousNameBases);
    const alreadyNamed = file.basename.startsWith(`${nameBase} `) && /^\d+$/.test(file.basename.slice(nameBase.length + 1));
    const desiredPath = !alreadyNamed && looksMeaningless(file.basename)
      ? nextNumberedPath(targetFolder, nameBase, file.extension, existingTargets, counters)
      : normalizePath(`${targetFolder}/${file.name}`);
    const targetPath = file.path === desiredPath ? desiredPath : uniquePath(desiredPath, existingTargets);
    existingTargets.add(targetPath);
    if (targetPath !== file.path) plans.push({ file, source, targetPath, checked: true });
  }
  if (automatic) {
    await applyAutomaticMoves(plugin, plans, automatic.active);
    return;
  }
  if (!plans.length) {
    new Notice("未发现需要重命名或整理的图片");
    return;
  }
  new ImageRenameModal(plugin, plans).open();
}

export async function planAttachmentOrganization(plugin: SimplePlugin, automatic?: AutomaticRun): Promise<void> {
  const location = requireAttachmentMode(plugin, "分类附件", ["fixed-folder", "current-subfolder"], Boolean(automatic));
  if (!location) return;

  const references = attachmentReferences(plugin);
  const existingTargets = new Set(plugin.app.vault.getFiles().map((file) => file.path));
  const plans: AttachmentOrganizePlan[] = [];
  const candidates = organizationCandidates(plugin, location, references, Boolean(automatic));

  for (const file of candidates) {
    if (!isAttachmentCandidate(file) || isImage(file) || (automatic?.paths && !automatic.paths.has(file.path))) continue;
    const linkedNotes = (references.get(file.path) ?? []).sort((a, b) => a.path.localeCompare(b.path));
    const source = pickSourceNote(plugin, file, linkedNotes, location);
    if (!source) continue;

    const targetFolder = location.mode === "fixed-folder"
      ? attachmentTargetFolder(location, source, plugin.settings.attachmentFolderMode !== "category")
      : preciseTargetFolderForSource(location, source);
    const desiredPath = normalizePath(`${targetFolder}/${file.name}`);
    const targetPath = file.path === desiredPath ? desiredPath : uniquePath(desiredPath, existingTargets);
    existingTargets.add(targetPath);
    if (targetPath !== file.path) {
      plans.push({ file, source, references: linkedNotes, targetPath, checked: true });
    }
  }

  if (automatic) {
    await applyAutomaticMoves(plugin, plans, automatic.active);
    return;
  }
  if (!plans.length) {
    new Notice("未发现需要分类的非图片附件");
    return;
  }

  new AttachmentOrganizationModal(plugin, plans).open();
}

export async function planInlineImageExtraction(plugin: SimplePlugin, automatic?: AutomaticRun): Promise<void> {
  const location = requireAttachmentMode(plugin, "内嵌 Base64 图片转为常规图片", ["fixed-folder", "same-folder", "current-subfolder"], Boolean(automatic));
  if (!location) return;
  const existingTargets = new Set(plugin.app.vault.getFiles().map((file) => file.path));
  const counters = new Map<string, number>();
  const plans: InlineImagePlan[] = [];

  for (const file of automatic?.notes ?? plugin.app.vault.getMarkdownFiles()) {
    if (automatic && !automatic.active()) return;
    const content = await plugin.app.vault.cachedRead(file);
    for (const match of content.matchAll(INLINE_IMAGE_RE)) {
      const mimeExt = match[1].toLowerCase() === "svg+xml" ? "svg" : match[1].toLowerCase().replace("jpeg", "jpg");
      const targetPath = await nextObsidianAttachmentPath(plugin, file, safeName(file.basename), mimeExt, existingTargets, counters);
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

  if (automatic) {
    await applyInlineImages(plugin, plans, automatic.active);
    return;
  }
  if (!plans.length) {
    new Notice("未发现 base64 内嵌图片");
    return;
  }

  new InlineImagePlanModal(plugin, plans).open();
}

function getFixedAttachmentFolder(plugin: SimplePlugin, location: Extract<AttachmentLocation, { mode: "fixed-folder" }>, silent = false): TFolder | null {
  const folder = plugin.app.vault.getAbstractFileByPath(location.folder);
  if (folder instanceof TFolder) return folder;
  if (!silent) new Notice(`附件目录不存在：${location.folder}`);
  return null;
}

function requireAttachmentMode(
  plugin: SimplePlugin,
  feature: string,
  allowed: AttachmentLocation["mode"][],
  silent = false
): AttachmentLocation | null {
  const location = readObsidianAttachmentLocation(plugin);
  if (allowed.includes(location.mode)) return location;
  if (!silent) new Notice(`${feature}在“${describeAttachmentLocation(location)}”模式下已禁用`);
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

async function emptyFoldersInFolder(plugin: SimplePlugin, root: TFolder): Promise<TFolder[]> {
  const empty: TFolder[] = [];
  const paths = new Set<string>();
  const visit = async (folder: TFolder): Promise<void> => {
    for (const child of folder.children) {
      if (child instanceof TFolder) await visit(child);
    }
    if (folder === root || folder.children.some((child) => !paths.has(child.path))) return;
    // Check disk too: Obsidian may omit hidden or unsupported files from its tree.
    const listing = await plugin.app.vault.adapter.list(folder.path);
    if (listing.files.length || listing.folders.some((path) => !paths.has(path))) return;
    paths.add(folder.path);
    empty.push(folder);
  };
  await visit(root);
  return empty;
}

async function deleteUnusedAttachments(plugin: SimplePlugin, selected: UnusedAttachment[], active = () => true): Promise<{ files: number; folders: number }> {
  const deleted = { files: 0, folders: 0 };
  // Children must be removed first; a deselected child keeps its parent nonempty.
  const ordered = [...selected].sort((a, b) => b.file.path.split("/").length - a.file.path.split("/").length);
  for (const item of ordered) {
    if (!active()) break;
    if (!attachmentReferencesReady(plugin)) throw new Error(REFERENCES_PENDING);
    if (plugin.app.vault.getAbstractFileByPath(item.file.path) !== item.file) continue;
    if (item.file instanceof TFolder) {
      if (item.file.children.length) continue;
      const listing = await plugin.app.vault.adapter.list(item.file.path);
      if (listing.files.length || listing.folders.length) continue;
      if (!active()) break;
      if (!attachmentReferencesReady(plugin)) throw new Error(REFERENCES_PENDING);
      await plugin.app.fileManager.trashFile(item.file);
      deleted.folders++;
    } else {
      if (referencedPaths(plugin).has(item.file.path)) continue;
      await plugin.app.fileManager.trashFile(item.file);
      deleted.files++;
    }
  }
  return deleted;
}

function isAttachmentCandidate(file: TFile): boolean {
  return !NOTE_EXTENSIONS.has(file.extension.toLowerCase());
}

function isRootFile(file: TFile): boolean {
  return !file.path.includes("/");
}

function rootAttachmentFiles(plugin: SimplePlugin): TFile[] {
  return plugin.app.vault.getFiles().filter((file) => isRootFile(file) && isAttachmentCandidate(file));
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

function attachmentTargetFolder(location: Extract<AttachmentLocation, { mode: "fixed-folder" }>, source: TFile, noteDirectory: boolean): string {
  if (noteDirectory) return preciseTargetFolderForSource(location, source);
  const parent = source.parent?.path;
  return normalizePath([location.folder, parent && parent !== "/" ? safePath(parent) : ""].filter(Boolean).join("/"));
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

function organizationCandidates(
  plugin: SimplePlugin,
  location: AttachmentLocation,
  references: Map<string, TFile[]>,
  silent = false
): TFile[] {
  if (location.mode === "fixed-folder") {
    const folder = getFixedAttachmentFolder(plugin, location, silent);
    return folder ? [...filesInFolder(folder), ...rootAttachmentFiles(plugin)] : [];
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

function attachmentModalHeader(modal: Modal, plugin: SimplePlugin, title: string, description: string, rename = false): void {
  modal.modalEl.addClass("simple-attachment-modal");
  if (rename) modal.modalEl.addClass("simple-rename-modal");
  applyModalScale(modal.modalEl, plugin.displaySettings.popupWindowScale, getMainAppWindow(plugin.app));
  modal.contentEl.empty();
  modal.contentEl.createEl("h2", { text: title });
  modal.contentEl.createDiv({ cls: "setting-item-description", text: description });
}

function attachmentModalActions<T extends { checked: boolean }>(modal: Modal, items: T[], title: string, apply: () => Promise<void>): void {
  const actions = modal.contentEl.createDiv({ cls: "simple-json-actions simple-json-modal-footer" });
  styleActionButton(actions.createEl("button", { text: "全选" }), "text").addEventListener("click", () => setChecked(modal.contentEl, items, true));
  styleActionButton(actions.createEl("button", { text: "反选" }), "text").addEventListener("click", () => invertChecked(modal.contentEl, items));
  styleActionButton(actions.createEl("button", { text: "取消" }), "text").addEventListener("click", () => modal.close());
  const execute = styleActionButton(actions.createEl("button", { text: title, cls: title.startsWith("删除") ? "mod-warning" : "mod-cta" }), "text");
  execute.addEventListener("click", () => {
    execute.disabled = true;
    void apply().catch(error => new Notice(error instanceof Error ? error.message : String(error)))
      .finally(() => { execute.disabled = false; });
  });
  styleActionFooter(actions);
}

class UnusedAttachmentModal extends Modal {
  constructor(private plugin: SimplePlugin, private items: UnusedAttachment[]) {
    super(plugin.app);
  }

  onOpen(): void {
    attachmentModalHeader(this, this.plugin, "清理未引用附件与空文件夹", "附件目录内的图片和空文件夹（含整条为空的子目录链）默认勾选；根目录图片及非图片附件默认不勾选。保留附件根目录，确认后移入 Obsidian 回收站；执行前再次检查，跳过已变化的项目。");
    renderChecklist(this.contentEl, this.items, (item) => item.file instanceof TFolder ? `${item.file.path}/\n空文件夹（含仅包含空子目录的文件夹）` : item.file.path);
    attachmentModalActions(this, this.items, "删除勾选项", async () => {
      const selected = this.items.filter((item) => item.checked);
      if (!selected.length) return;
      const folders = selected.filter((item) => item.file instanceof TFolder).length;
      if (!await confirmAction(this.plugin.app, `将选中的 ${selected.length - folders} 个未引用附件、${folders} 个空文件夹移入 Obsidian 回收站？`)) return;
      const deleted = await deleteUnusedAttachments(this.plugin, selected);
      new Notice(`已删除 ${deleted.files} 个附件、${deleted.folders} 个空文件夹；跳过 ${selected.length - deleted.files - deleted.folders} 个已变化、已被引用或非空的项目`);
      this.close();
    });
  }

}

async function applyAttachmentMoves(
  modal: Modal, plugin: SimplePlugin, plans: RenamePlan[], progress: HTMLElement | null,
  confirmText: (count: number) => string, completedText: (count: number) => string,
): Promise<void> {
  const selected = plans.filter(plan => plan.checked);
  if (!selected.length || !await confirmAction(plugin.app, confirmText(selected.length))) return;
  document.body.classList.add("simple-hide-notices");
  try {
    for (let index = 0; index < selected.length; index++) {
      const plan = selected[index];
      progress?.setText(`处理进度：${index + 1} / ${selected.length}`);
      await ensureFolder(plugin, plan.targetPath.split("/").slice(0, -1).join("/"));
      await plugin.app.fileManager.renameFile(plan.file, plan.targetPath);
    }
    modal.close();
    new Notice(completedText(selected.length));
  } catch (error) {
    progress?.setText(`处理失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    document.body.classList.remove("simple-hide-notices");
  }
}

class ImageRenameModal extends Modal {
  private progressEl: HTMLElement | null = null;

  constructor(private plugin: SimplePlugin, private plans: RenamePlan[]) {
    super(plugin.app);
  }

  onOpen(): void {
    attachmentModalHeader(this, this.plugin, "重命名图片并整理存放清单", "根据引用笔记修改自动生成的图片名，保留有意义的原名；按所选目录规则整理存放，重名时自动避让。", true);
    renderRenameChecklist(this.contentEl, this.plans);
    attachmentModalActions(this, this.plans, "执行", () => this.applyPlans());
    this.progressEl = this.contentEl.createDiv({ cls: "simple-attachment-progress" });
  }

  private async applyPlans(): Promise<void> {
    await applyAttachmentMoves(this, this.plugin, this.plans, this.progressEl,
      count => `重命名并整理选中的 ${count} 张图片？`, count => `已处理 ${count} 张图片`);
  }
}

class AttachmentOrganizationModal extends Modal {
  private progressEl: HTMLElement | null = null;

  constructor(private plugin: SimplePlugin, private plans: AttachmentOrganizePlan[]) {
    super(plugin.app);
  }

  onOpen(): void {
    attachmentModalHeader(this, this.plugin, "分类附件清单", "非图片附件保留原名，按所选目录规则分类；多处引用时采用路径最靠前的笔记，重名时添加数字避让。", true);
    renderRenameChecklist(this.contentEl, this.plans);
    attachmentModalActions(this, this.plans, "执行", () => this.applyPlans());
    this.progressEl = this.contentEl.createDiv({ cls: "simple-attachment-progress" });
  }

  private async applyPlans(): Promise<void> {
    await applyAttachmentMoves(this, this.plugin, this.plans, this.progressEl,
      count => `分类选中的 ${count} 个非图片附件？`, count => `已处理 ${count} 个非图片附件`);
  }
}

async function applyAutomaticMoves(plugin: SimplePlugin, plans: RenamePlan[], active: () => boolean): Promise<void> {
  for (const plan of plans) {
    if (!active()) return;
    if (plugin.app.vault.getAbstractFileByPath(plan.file.path) !== plan.file) continue;
    if (!attachmentReferences(plugin).get(plan.file.path)?.includes(plan.source)) continue;
    if (plugin.app.vault.getAbstractFileByPath(plan.targetPath)) continue;
    await ensureFolder(plugin, plan.targetPath.split("/").slice(0, -1).join("/"));
    if (!active()) return;
    await plugin.app.fileManager.renameFile(plan.file, plan.targetPath);
  }
}

async function applyInlineImages(
  plugin: SimplePlugin, selected: InlineImagePlan[], active = () => true,
  progress?: (text: string) => void, onConverted?: (count: number) => void,
): Promise<number> {
  const groups = [...groupBySource(selected)];
  const replace = (content: string, plans: InlineImagePlan[]): string => {
    for (const plan of [...plans].sort((a, b) => b.start - a.start)) {
      if (content.slice(plan.start, plan.end) !== plan.match) throw new Error(`笔记已变化，请重新扫描：${plan.source.path}`);
      content = `${content.slice(0, plan.start)}![[${plan.targetPath}]]${content.slice(plan.end)}`;
    }
    return content;
  };
  for (const [source, plans] of groups) replace(await plugin.app.vault.read(source), plans);
  let converted = 0, completed = 0;
  for (const [source, plans] of groups) {
    if (!active()) break;
    const created: TFile[] = [];
    try {
      for (const plan of plans) {
        if (!active()) throw new Error("图片转换已停止");
        progress?.(`处理进度：${++completed} / ${selected.length}`);
        await ensureFolder(plugin, plan.targetPath.split("/").slice(0, -1).join("/"));
        created.push(await plugin.app.vault.createBinary(plan.targetPath, base64ToArrayBuffer(plan.base64)));
      }
      if (!active()) throw new Error("图片转换已停止");
      await plugin.app.vault.process(source, content => {
        if (!active()) throw new Error("图片转换已停止");
        return replace(content, plans);
      });
      converted += plans.length;
      onConverted?.(converted);
    } catch (error) {
      for (const file of created) await plugin.app.fileManager.trashFile(file);
      throw error;
    }
  }
  return converted;
}

class InlineImagePlanModal extends Modal {
  private progressEl: HTMLElement | null = null;

  constructor(private plugin: SimplePlugin, private plans: InlineImagePlan[]) {
    super(plugin.app);
  }

  onOpen(): void {
    attachmentModalHeader(this, this.plugin, "内嵌 Base64 图片转为常规图片", "将 Markdown 中的 Base64 图片保存为图片文件，并将原内嵌内容替换为图片链接。");
    renderChecklist(this.contentEl, this.plans, (plan) => `${plan.source.path}\n→ ${plan.targetPath}`);
    attachmentModalActions(this, this.plans, "执行勾选项", () => this.applyPlans());
    this.progressEl = this.contentEl.createDiv({ cls: "simple-attachment-progress" });
  }

  private async applyPlans(): Promise<void> {
    const selected = this.plans.filter((plan) => plan.checked);
    if (!selected.length) return;
    if (!await confirmAction(this.plugin.app, `将选中的 ${selected.length} 张内嵌 Base64 图片转换为常规图片？`)) return;

    let converted = 0;
    try {
      await applyInlineImages(this.plugin, selected, () => true,
        text => this.progressEl?.setText(text), count => { converted = count; });

      this.close();
      new Notice(`已将 ${selected.length} 张内嵌 Base64 图片转换为常规图片`);
    } catch (error) {
      if (converted) {
        this.close();
        new Notice(`已转换 ${converted} 张图片；其余处理失败，请重新扫描：${error instanceof Error ? error.message : String(error)}`);
      }
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
    const detail = label.createDiv({ cls: "simple-attachment-detail", attr: { "aria-label": lines.join("\n") } });
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
      attr: { "aria-label": `修改前：${plan.file.path}\n修改后：${plan.targetPath}` },
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
