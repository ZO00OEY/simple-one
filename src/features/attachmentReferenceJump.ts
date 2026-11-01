import { FileView, Menu, Notice, TFile, type App, type MenuItem, type TAbstractFile } from "obsidian";
import type SimplePlugin from "../main";
import { reportError } from "../shared/async";

const NOTE_EXTENSIONS = new Set(["md", "canvas", "base"]);
const PREVIEW_VIEWS = new Set(["image", "pdf", "audio", "video"]);
type NavigatorMenus = {
  registerFileMenu: (callback: (context: { file: TAbstractFile; addItem: (build: (item: MenuItem) => void) => void }) => void) => () => void;
};

function isAttachment(file: unknown): file is TFile {
  return file instanceof TFile && !NOTE_EXTENSIONS.has(file.extension.toLowerCase());
}

export function attachmentReferencingNotes(app: App, attachment: TFile): TFile[] {
  const notes: TFile[] = [];
  for (const [path, links] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!links[attachment.path]) continue;
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && NOTE_EXTENSIONS.has(file.extension.toLowerCase())) notes.push(file);
  }
  return notes.sort((a, b) => a.path.localeCompare(b.path));
}

export function registerAttachmentReferenceJump(plugin: SimplePlugin): () => void {
  const { workspace } = plugin.app;
  const actions = new Map<FileView, HTMLElement>();
  let openMenu: Menu | null = null, disposed = false;
  let navigatorMenus: NavigatorMenus | undefined, unregisterNavigator: (() => void) | undefined;
  const enabled = () => !disposed && plugin.settings.enableAttachmentReferenceJump !== false;
  const openNotes = async (notes: TFile[]) => {
    for (const note of notes) {
      if (!enabled()) return;
      if (plugin.app.vault.getAbstractFileByPath(note.path) !== note) continue;
      await workspace.getLeaf("tab").openFile(note, { active: true });
    }
  };
  const jump = (file: TFile, event: MouseEvent | KeyboardEvent) => {
    if (!enabled()) return;
    const notes = attachmentReferencingNotes(plugin.app, file);
    if (!notes.length) { new Notice("没有找到引用此附件的笔记"); return; }
    if (notes.length === 1) { void openNotes(notes).catch(reportError); return; }
    openMenu?.hide();
    const menu = new Menu();
    openMenu = menu;
    menu.addItem(item => item.setTitle(`在新标签页打开全部引用笔记（${notes.length}）`)
      .setIcon("files").onClick(() => { void openNotes(notes).catch(reportError); }));
    menu.addSeparator();
    for (const note of notes) {
      menu.addItem(item => item.setTitle(note.path).setIcon("file-text")
        .onClick(() => { void openNotes([note]).catch(reportError); }));
    }
    if ("clientX" in event) menu.showAtMouseEvent(event);
    else menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  };
  plugin.registerEvent(workspace.on("file-menu", (menu, file) => {
    if (!enabled() || !isAttachment(file)) return;
    menu.addItem(item => item.setTitle("跳转到引用笔记").setIcon("search")
      .onClick(event => jump(file, event)));
  }));
  const refresh = () => {
    const navigator = (plugin.app as App & {
      plugins?: { plugins?: Record<string, { api?: { menus?: NavigatorMenus } }> };
    }).plugins?.plugins?.["notebook-navigator"];
    const menus = navigator?.api?.menus;
    if (menus !== navigatorMenus) {
      unregisterNavigator?.();
      navigatorMenus = menus;
      unregisterNavigator = menus?.registerFileMenu(({ file, addItem }) => {
        if (!enabled() || !isAttachment(file)) return;
        addItem(item => item.setTitle("跳转到引用笔记").setIcon("search").onClick(event => jump(file, event)));
      });
    }
    const views = new Set<FileView>();
    workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof FileView && PREVIEW_VIEWS.has(leaf.view.getViewType()) && isAttachment(leaf.view.file)) views.add(leaf.view);
    });
    for (const [view, action] of actions) {
      if (!enabled() || !views.has(view) || !action.isConnected) {
        action.remove();
        actions.delete(view);
      }
    }
    if (!enabled()) { openMenu?.hide(); return; }
    for (const view of views) {
      if (actions.has(view)) continue;
      const action = view.addAction("search", "跳转到引用笔记（新标签页）", event => {
        if (isAttachment(view.file)) jump(view.file, event);
      });
      action.classList.add("simple-attachment-reference-action");
      actions.set(view, action);
    }
  };
  let timer: number | undefined;
  const schedule = () => {
    if (disposed || timer !== undefined) return;
    timer = window.setTimeout(() => { timer = undefined; refresh(); }, 0);
  };
  plugin.registerEvent(workspace.on("layout-change", schedule));
  plugin.registerEvent(workspace.on("active-leaf-change", schedule));
  plugin.registerEvent(workspace.on("file-open", schedule));
  workspace.onLayoutReady(schedule);
  plugin.register(() => {
    disposed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    for (const action of actions.values()) action.remove();
    actions.clear();
    unregisterNavigator?.();
    openMenu?.hide();
  });
  return refresh;
}
