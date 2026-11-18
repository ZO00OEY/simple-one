import {
  Modal,
  MarkdownView,
  Notice,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  parseYaml,
} from "obsidian";
import type SimplePlugin from "../main";
import { styleActionButton } from "../shared/actionButton";
import { nextId, type NewNoteDatabaseRule } from "../types";
import { reportError } from "../shared/async";

const CREATED = "创建时间";
const MODIFIED = "最后编辑时间";

/** Obsidian's datetime-local property control displays clock fields without converting UTC. */
export function noteTimestamp(date = new Date()): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export function registerNewNoteDefaults(plugin: SimplePlugin): void {
  let disposed = false;
  plugin.register(() => { disposed = true; });
  const active = () => !disposed && plugin.app.workspace.layoutReady;
  const writing = new Set<TFile>();
  // The new-note buttons, commands and link creation use FileManager; sync/import uses Vault.
  const manager = plugin.app.fileManager as typeof plugin.app.fileManager & {
    createNewMarkdownFile(parent: TFolder | null, name?: string, content?: string): Promise<TFile | null>;
  };
  /* eslint-disable @typescript-eslint/unbound-method -- Calls bind the receiver; cleanup needs the original identity. */
  const originalCreate = manager.createNewMarkdownFile;
  const originalProperties = manager.processFrontMatter;
  const originalSave = MarkdownView.prototype.save;
  /* eslint-enable @typescript-eslint/unbound-method -- Subsequent calls use explicit receivers. */
  const saveDescriptor = Object.getOwnPropertyDescriptor(MarkdownView.prototype, "save");
  const ensureDateType = async (name: string) => {
    const types = (plugin.app as typeof plugin.app & { metadataTypeManager?: {
      getAssignedWidget(name: string): string | null;
      setType(name: string, type: string): Promise<void>;
    } }).metadataTypeManager;
    if (active() && types && !types.getAssignedWidget(name)) await types.setType(name, "datetime").catch(reportError);
  };
  const timestamp = async (file: TFile, created: boolean) => {
    if (!active() || plugin.app.vault.getAbstractFileByPath(file.path) !== file || file.extension !== "md") return;
    const settings = plugin.settings.newNoteDefaults;
    if (!(created && settings.recordCreationTime) && !settings.updateModifiedTime) return;
    writing.add(file);
    try {
      if (created && settings.recordCreationTime) await ensureDateType(CREATED);
      if (settings.updateModifiedTime) await ensureDateType(MODIFIED);
      if (!active()) return;
      await originalProperties.call(manager, file, (properties: Record<string, unknown>) => {
        if (!active()) return;
        const now = noteTimestamp();
        if (created && settings.recordCreationTime && !properties[CREATED]) properties[CREATED] = now;
        if (settings.updateModifiedTime) properties[MODIFIED] = now;
      });
    } finally { writing.delete(file); }
  };
  const create: typeof originalCreate = async function (this: typeof manager, ...args) {
    const file = await originalCreate.apply(this, args);
    if (!file || !active() || file.extension !== "md") return file;
    writing.add(file);
    try {
      await applyNewNoteDefaults(plugin, file, active).catch(reportError);
      await timestamp(file, true);
    } catch (error) { reportError(error); }
    finally { writing.delete(file); }
    return file;
  };
  const properties: typeof originalProperties = async function (this: typeof manager, file, edit, options) {
    if (!active() || writing.has(file) || file.extension !== "md" || !plugin.settings.newNoteDefaults.updateModifiedTime) {
      return originalProperties.call(this, file, edit, options);
    }
    await ensureDateType(MODIFIED);
    return originalProperties.call(this, file, (frontmatter: Record<string, unknown>) => {
      const before = JSON.stringify(frontmatter);
      edit(frontmatter);
      if (active() && before !== JSON.stringify(frontmatter)) frontmatter[MODIFIED] = noteTimestamp();
    }, options);
  };
  const save: typeof originalSave = async function (this: MarkdownView, ...args) {
    const file = this.file;
    const changed = file && active() && plugin.settings.newNoteDefaults.updateModifiedTime
      && this.data !== this.getViewData();
    await originalSave.apply(this, args);
    if (file && changed && active() && !writing.has(file)) {
      await timestamp(file, false).catch(reportError);
    }
  };
  manager.createNewMarkdownFile = create;
  manager.processFrontMatter = properties;
  MarkdownView.prototype.save = save;
  plugin.register(() => {
    if (manager.createNewMarkdownFile === create) manager.createNewMarkdownFile = originalCreate;
    if (manager.processFrontMatter === properties) manager.processFrontMatter = originalProperties;
    if (MarkdownView.prototype.save === save) {
      if (saveDescriptor) Object.defineProperty(MarkdownView.prototype, "save", saveDescriptor);
      else delete (MarkdownView.prototype as Partial<MarkdownView>).save;
    }
  });
}

export async function applyNewNoteDefaults(plugin: SimplePlugin, file: TFile, active = () => true): Promise<void> {
  if (!active() || !plugin.settings.newNoteDefaults.enabled) return;
  if (file.extension !== "md") return;
  const content = await plugin.app.vault.read(file);
  if (!active() || content.trim()) return;

  const rule = findRule(plugin, file.parent);
  if (rule) {
    await applyRule(plugin, file, rule, active);
    return;
  }

  const folder = file.parent;
  if (!folder) return;
  const bases = baseFilesInFolder(folder);
  if (bases.length === 0) return;
  if (bases.length === 1) {
    const created = rememberRule(plugin, folder.path, bases[0].path);
    await plugin.saveSettings();
    if (active()) await applyRule(plugin, file, created, active);
    return;
  }

  new BaseChoiceModal(plugin, folder.path, bases, async (base) => {
    if (!active()) return;
    const created = rememberRule(plugin, folder.path, base.path);
    await plugin.saveSettings();
    if (active()) await applyRule(plugin, file, created, active);
  }).open();
}

export async function databaseProperties(plugin: SimplePlugin, databasePath: string): Promise<string[]> {
  const file = plugin.app.vault.getAbstractFileByPath(normalizePath(databasePath));
  if (!(file instanceof TFile) || file.extension !== "base") return [];
  const yaml: unknown = parseYaml(await plugin.app.vault.read(file));
  return propertiesFromBaseModel(yaml);
}

function findRule(plugin: SimplePlugin, folder: TFolder | null): NewNoteDatabaseRule | null {
  if (!folder) return null;
  const path = normalizePath(folder.path);
  return plugin.settings.newNoteDefaults.rules
    .find((rule) => rule.databasePath && normalizePath(rule.folder) === path) ?? null;
}

async function applyRule(plugin: SimplePlugin, file: TFile, rule: NewNoteDatabaseRule, active = () => true): Promise<void> {
  const properties = await databaseProperties(plugin, rule.databasePath);
  if (!active() || properties.length === 0) return;

  await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (!active()) return;
    for (const property of properties) {
      if (!(property in frontmatter)) (frontmatter as Record<string, unknown>)[property] = null;
    }
  });
}

function rememberRule(plugin: SimplePlugin, folder: string, databasePath: string): NewNoteDatabaseRule {
  const normalizedFolder = normalizePath(folder);
  const existing = plugin.settings.newNoteDefaults.rules.find((rule) => normalizePath(rule.folder) === normalizedFolder);
  if (existing) {
    existing.databasePath = normalizePath(databasePath);
    existing.enabled = true;
    return existing;
  }
  const rule: NewNoteDatabaseRule = {
    id: nextId(),
    enabled: true,
    folder: normalizedFolder,
    databasePath: normalizePath(databasePath),
    includeSubfolders: false,
  };
  plugin.settings.newNoteDefaults.rules.push(rule);
  return rule;
}

function baseFilesInFolder(folder: TFolder): TFile[] {
  return folder.children
    .filter((child): child is TFile => child instanceof TFile && child.extension === "base")
    .sort((a, b) => a.basename.localeCompare(b.basename));
}

function propertiesFromBaseModel(value: unknown): string[] {
  const props = new Set<string>();
  for (const item of firstViewOrder(value)) addProperty(props, item);
  if (props.size === 0) {
    for (const item of modelColumns(value)) addProperty(props, item);
  }
  return [...props];
}

function firstViewOrder(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.views)) return [];
  const view = value.views.find(isRecord);
  return view && Array.isArray(view.order) ? view.order : [];
}

function modelColumns(value: unknown): unknown[] {
  if (!isRecord(value) || !isRecord(value.model) || !Array.isArray(value.model.columns)) return [];
  return value.model.columns;
}

function addProperty(props: Set<string>, item: unknown): void {
  const name = typeof item === "string" ? item : isRecord(item) ? stringValue(item.property) || stringValue(item.id) : "";
  const property = normalizePropertyName(name);
  if (property) props.add(property);
}

function normalizePropertyName(value: string): string {
  const name = value.trim().replace(/^note\./, "");
  if (!name || name.startsWith("file.") || name === "tags") return "";
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

class BaseChoiceModal extends Modal {
  constructor(
    plugin: SimplePlugin,
    private readonly folder: string,
    private readonly bases: TFile[],
    private readonly onChoose: (base: TFile) => Promise<void>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("选择新笔记参考数据库");
    this.modalEl.addClass("simple-one-modal");
    this.contentEl.createEl("p", { text: `当前目录存在多个数据库文件：${this.folder}` });
    for (const base of this.bases) {
      new Setting(this.contentEl)
        .setName(base.basename)
        .setDesc(base.path)
        .addButton((button) => {
          styleActionButton(button.buttonEl, "text");
          button.setButtonText("使用")
          .setCta()
          .onClick(async () => {
            this.close();
            await this.onChoose(base);
            new Notice(`已记录参考数据库：${base.basename}`);
          });
        });
    }
  }
}
