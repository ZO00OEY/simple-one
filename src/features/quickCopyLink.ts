import { MarkdownView, Menu, Notice, setIcon, setTooltip, type TFile } from "obsidian";
import type SimplePlugin from "../main";
import type { QuickCopyLinkMode } from "../types";
import { registerMarkdownAction } from "../shared/markdownAction";

const MODE_LABELS: Record<QuickCopyLinkMode, string> = {
  "obsidian-url": "Obsidian URL",
  "absolute-path": "绝对路径",
  "navigator-folder-absolute-path": "导航目录绝对路径",
};

const MODE_ICONS: Record<QuickCopyLinkMode, string> = {
  "obsidian-url": "link",
  "absolute-path": "hard-drive",
  "navigator-folder-absolute-path": "folder",
};

const ACTION_ATTR = "data-simple-quick-copy-link";
const NOTEBOOK_NAVIGATOR_ID = "notebook-navigator";

export function registerQuickCopyLink(plugin: SimplePlugin): void {
  let openMenu: Menu | null = null;

  const syncAllActions = registerMarkdownAction(
    plugin,
    ACTION_ATTR,
    () => !plugin.isMobile && plugin.settings.enhancements.quickCopyLink.enabled,
    (view) => {
      const action = view.addAction(modeIcon(plugin.settings.enhancements.quickCopyLink.lastMode), actionTitle(plugin), async () => {
        await copyLink(plugin, view, plugin.settings.enhancements.quickCopyLink.lastMode);
      });
      action.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        openMenu?.hide();
        openMenu = createModeMenu(plugin, view, syncAllActions);
        openMenu.showAtMouseEvent(evt);
      });
      return action;
    },
    (action) => syncActionButton(plugin, action)
  );
  plugin.register(() => openMenu?.hide());
}

function createModeMenu(plugin: SimplePlugin, view: MarkdownView, syncAllActions: () => void): Menu {
  const menu = new Menu();
  const current = plugin.settings.enhancements.quickCopyLink.lastMode;
  for (const mode of Object.keys(MODE_LABELS) as QuickCopyLinkMode[]) {
    menu.addItem((item) => {
      item
        .setTitle(MODE_LABELS[mode])
        .setIcon(MODE_ICONS[mode])
        .setChecked(current === mode)
        .onClick(async () => {
          plugin.settings.enhancements.quickCopyLink.lastMode = mode;
          await plugin.saveSettings();
          syncAllActions();
          await copyLink(plugin, view, mode);
        });
    });
  }
  return menu;
}

async function copyLink(plugin: SimplePlugin, view: MarkdownView, mode: QuickCopyLinkMode): Promise<void> {
  const file = view.file;
  if (!file && mode !== "navigator-folder-absolute-path") {
    new Notice("当前视图没有对应的笔记文件");
    return;
  }

  const value = makeCopyValue(plugin, file, mode);

  if (!value) {
    new Notice(mode === "navigator-folder-absolute-path" ? "没有找到左侧导航选中的文件夹" : "当前环境无法生成绝对路径");
    return;
  }

  await navigator.clipboard.writeText(value);
  new Notice(`已复制${MODE_LABELS[mode]}`);
}

function makeCopyValue(plugin: SimplePlugin, file: TFile | null, mode: QuickCopyLinkMode): string {
  if (mode === "navigator-folder-absolute-path") return makeNavigatorFolderAbsolutePath(plugin);
  if (!file) return "";
  if (mode === "obsidian-url") return makeObsidianUrl(plugin, file);
  return makeAbsolutePath(plugin, file);
}

function makeObsidianUrl(plugin: SimplePlugin, file: TFile): string {
  const vault = encodeURIComponent(plugin.app.vault.getName());
  const path = encodeURIComponent(file.path);
  return `obsidian://open?vault=${vault}&file=${path}`;
}

function makeAbsolutePath(plugin: SimplePlugin, file: TFile): string {
  return makeVaultAbsolutePath(plugin, file.path);
}

function makeNavigatorFolderAbsolutePath(plugin: SimplePlugin): string {
  const folderPath = getNotebookNavigatorSelectedFolderPath(plugin);
  if (folderPath === null) return "";
  return makeVaultAbsolutePath(plugin, folderPath === "/" ? "" : folderPath);
}

function getNotebookNavigatorSelectedFolderPath(plugin: SimplePlugin): string | null {
  const pluginPath = getNotebookNavigatorPluginFolderPath(plugin);
  if (pluginPath !== null) return pluginPath;

  const selected = document.querySelector<HTMLElement>(".nn-navitem.nn-selected[data-nav-item-type='folder']");
  const folderPath = selected?.getAttribute("data-path") ?? "";
  return folderPath || null;
}

function getNotebookNavigatorPluginFolderPath(plugin: SimplePlugin): string | null {
  const notebookNavigator = (plugin.app as {
    plugins?: { plugins?: Record<string, unknown> };
  }).plugins?.plugins?.[NOTEBOOK_NAVIGATOR_ID] as {
    api?: { selection?: { getNavItem?: () => { type?: string; folder?: { path?: string } | null } } };
  } | undefined;
  const navItem = notebookNavigator?.api?.selection?.getNavItem?.();
  return navItem?.type === "folder" ? navItem.folder?.path ?? null : null;
}

function makeVaultAbsolutePath(plugin: SimplePlugin, vaultRelativePath: string): string {
  const basePath = (plugin.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? "";
  if (!basePath) return "";
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(basePath);
  const separator = isWindowsPath ? "\\" : "/";
  const normalizedBasePath = isWindowsPath
    ? basePath.replace(/\//g, "\\")
    : basePath.replace(/\\/g, "/");
  const normalizedRelativePath = isWindowsPath
    ? vaultRelativePath.replace(/\//g, "\\")
    : vaultRelativePath.replace(/\\/g, "/");
  const cleanBasePath = normalizedBasePath.replace(/[\\/]+$/, "");
  const cleanRelativePath = normalizedRelativePath.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  return cleanRelativePath ? `${cleanBasePath}${separator}${cleanRelativePath}` : cleanBasePath;
}

function actionTitle(plugin: SimplePlugin): string {
  const mode = plugin.settings.enhancements.quickCopyLink.lastMode;
  return `点击复制当前笔记${MODE_LABELS[mode]}`;
}

export function modeIcon(mode: QuickCopyLinkMode): string {
  return MODE_ICONS[mode];
}

function syncActionButton(plugin: SimplePlugin, action: HTMLElement): void {
  setIcon(action, modeIcon(plugin.settings.enhancements.quickCopyLink.lastMode));
  action.addClass("simple-copy-link-action");
  setTooltip(action, actionTitle(plugin));
}
