import {
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  parseYaml,
} from "obsidian";
import type SimplePlugin from "../main";
import { nextId, type NewNoteDatabaseRule } from "../types";

export function registerNewNoteDefaults(plugin: SimplePlugin): void {
  plugin.registerEvent(plugin.app.vault.on("create", (file) => {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    window.setTimeout(() => {
      void applyNewNoteDefaults(plugin, file);
    }, 0);
  }));
}

export async function applyNewNoteDefaults(plugin: SimplePlugin, file: TFile): Promise<void> {
  if (!plugin.settings.newNoteDefaults.enabled) return;
  if (file.extension !== "md") return;
  const content = await plugin.app.vault.read(file);
  if (content.trim()) return;

  const rule = findRule(plugin, file.parent);
  if (rule) {
    await applyRule(plugin, file, rule);
    return;
  }

  const folder = file.parent;
  if (!folder) return;
  const bases = baseFilesInFolder(folder);
  if (bases.length === 0) return;
  if (bases.length === 1) {
    const created = rememberRule(plugin, folder.path, bases[0].path);
    await plugin.saveSettings();
    await applyRule(plugin, file, created);
    return;
  }

  new BaseChoiceModal(plugin, folder.path, bases, async (base) => {
    const created = rememberRule(plugin, folder.path, base.path);
    await plugin.saveSettings();
    await applyRule(plugin, file, created);
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

async function applyRule(plugin: SimplePlugin, file: TFile, rule: NewNoteDatabaseRule): Promise<void> {
  const properties = await databaseProperties(plugin, rule.databasePath);
  if (properties.length === 0) return;

  await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
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
    private readonly plugin: SimplePlugin,
    private readonly folder: string,
    private readonly bases: TFile[],
    private readonly onChoose: (base: TFile) => Promise<void>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("选择新笔记参考数据库");
    this.contentEl.createEl("p", { text: `当前目录存在多个数据库文件：${this.folder}` });
    for (const base of this.bases) {
      new Setting(this.contentEl)
        .setName(base.basename)
        .setDesc(base.path)
        .addButton((button) => button
          .setButtonText("使用")
          .setCta()
          .onClick(async () => {
            this.close();
            await this.onChoose(base);
            new Notice(`已记录参考数据库：${base.basename}`);
          }));
    }
  }
}
