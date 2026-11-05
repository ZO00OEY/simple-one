import { Notice, setIcon } from "obsidian";
import { styleActionButton } from "../../shared/actionButton";

export type FileListMode = "list" | "tree";
export interface FileListLayout { get(): FileListMode; set(mode: FileListMode): Promise<void>; subscribe(draw: () => void): () => void }
export function createFileListLayout(settings: { viewLayout?: FileListMode } = {}, save: () => Promise<void> = async () => {}): FileListLayout {
  const listeners = new Set<() => void>();
  return { get: () => settings.viewLayout ?? "list", set: async mode => {
    const previous = settings.viewLayout; settings.viewLayout = mode;
    try { await save(); } catch (error) { settings.viewLayout = previous; throw error; }
    listeners.forEach(draw => draw());
  }, subscribe: draw => { listeners.add(draw); return () => { listeners.delete(draw); }; } };
}
export function renderLayoutToggle(parent: HTMLElement, layout: FileListLayout): void {
  const button = styleActionButton(parent.createEl("button", { cls: "simple-one-sync-layout-toggle", attr: { type: "button" } }), "plain");
  const update = (): void => { const label = layout.get() === "tree" ? "切换为平铺列表" : "切换为目录树";
    button.setAttr("aria-label", label); button.setAttribute("aria-label", label); setIcon(button, layout.get() === "tree" ? "list" : "folder-tree"); };
  update(); button.addEventListener("click", () => { button.disabled = true; void layout.set(layout.get() === "tree" ? "list" : "tree")
    .then(update).catch(() => new Notice("显示方式未能保存，请重试。")) .finally(() => { button.disabled = false; }); });
}
const panels = new WeakMap<HTMLElement, FileListLayout>();
/** One preference and one toggle for a panel containing several directional lists. */
export function fileListPanel(parent: HTMLElement, settings: { viewLayout?: FileListMode }, save: () => Promise<void>): FileListLayout {
  let layout = panels.get(parent);
  if (!layout) { layout = createFileListLayout(settings, save); panels.set(parent, layout); }
  if (!parent.querySelector(":scope > .simple-one-sync-layout-toggle")) renderLayoutToggle(parent, layout);
  return layout;
}

interface Branch<T> { name: string; path: string; count: number; children: Map<string, Branch<T>>; files: T[] }

/** Presentation only: callers retain file actions, choices and paging. */
export function renderFileTree<T>(parent: HTMLElement, items: readonly T[], pathOf: (item: T) => string,
  renderFile: (parent: HTMLElement, item: T, fullPath: boolean) => void, options: { collapsed?: Set<string>; layout?: FileListLayout } = {}): () => void {
  const root: Branch<T> = { name: "", path: "", count: 0, children: new Map(), files: [] };
  for (const item of items) {
    const parts = pathOf(item).split("/").filter(Boolean); parts.pop();
    let node = root; node.count++;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) { child = { name: part, path: node.path ? node.path + "/" + part : part, count: 0, children: new Map(), files: [] }; node.children.set(part, child); }
      child.count++; node = child;
    }
    node.files.push(item);
  }
  const tree = parent.createDiv();
  const collapsed = options.collapsed ?? new Set<string>();
  const branch = (host: HTMLElement, initial: Branch<T>, depth: number): void => {
    let node = initial, name = node.name;
    // Compress single-directory chains to leave room for filenames on phones.
    while (!node.files.length && node.children.size === 1) { node = [...node.children.values()][0]; name += "/" + node.name; }
    const group = host.createEl("details", { cls: "simple-one-sync-view__group" });
    group.setAttr("data-folder", node.path); group.setAttribute("aria-label", node.path || "Vault 根目录");
    group.style.marginInlineStart = depth > 0 && depth < 3 ? "8px" : "0";
    group.open = !collapsed.has(node.path);
    group.addEventListener("toggle", () => { if (group.open) collapsed.delete(node.path); else collapsed.add(node.path); });
    const summary = group.createEl("summary", { cls: "simple-one-sync-view__group-label" });
    setIcon(summary.createSpan({ cls: "simple-one-sync-view__group-chevron" }), "chevron-right");
    setIcon(summary.createSpan(), "folder-closed");
    summary.createSpan({ text: name || "Vault 根目录", cls: "simple-one-sync-file-tree__folder-name" });
    summary.createSpan({ text: String(node.count), cls: "simple-one-sync-view__group-count" });
    for (const child of [...node.children.values()].sort((a,b) => a.name.localeCompare(b.name))) branch(group, child, depth + 1);
    for (const item of node.files) renderFile(group, item, false);
  };
  const draw = (): void => {
    tree.empty(); tree.className = (options.layout?.get() ?? "list") === "list" ? "simple-one-sync-file-list" : "simple-one-sync-file-tree";
    if (options.layout?.get() === "list") { for (const item of items) renderFile(tree, item, true); return; }
    for (const child of [...root.children.values()].sort((a,b) => a.name.localeCompare(b.name))) branch(tree, child, 0);
    if (root.files.length) branch(tree, { ...root, name: "Vault 根目录", count: root.files.length, children: new Map() }, 0);
  };
  draw(); return options.layout?.subscribe(draw) ?? (() => {});
}

export function renderPathTree(parent: HTMLElement, paths: readonly string[], mark: string | ((path: string) => string) = "M", layout?: FileListLayout): void {
  const host = parent.createDiv(); const collapsed = new Set<string>(); let page = 0; let dispose = (): void => {};
  const draw = (): void => {
    dispose(); host.empty(); const pages = Math.max(1, Math.ceil(paths.length / 100));
    const visible = paths.slice(page * 100, (page + 1) * 100);
    dispose = renderFileTree(host, visible, path => path, (folder, path, fullPath) => {
      const value = typeof mark === "function" ? mark(path) : mark;
      const row = folder.createDiv({ cls: "simple-one-sync-view__change" }); row.setAttribute("aria-label", path);
      row.setAttr("data-kind", value === "+" ? "added" : value === "−" ? "deleted" : "modified");
      row.createSpan({ text: value, cls: "simple-one-sync-view__mark" });
      row.createSpan({ text: fullPath ? path : path.split("/").pop() ?? path, cls: "simple-one-sync-view__path" });
    }, { collapsed, layout });
    if (pages > 1) {
      const pager = host.createDiv({ cls: "simple-one-sync-file-tree__pager" });
      const prev = styleActionButton(pager.createEl("button", { text: "上一页" }), "text"); prev.disabled = page === 0;
      prev.addEventListener("click", () => { page--; draw(); });
      pager.createSpan({ text: "第 " + (page + 1) + "/" + pages + " 页 · 本页 " + visible.length + "/" + paths.length + " 个" });
      const next = styleActionButton(pager.createEl("button", { text: "下一页" }), "text"); next.disabled = page === pages - 1;
      next.addEventListener("click", () => { page++; draw(); });
    }
  }; draw();
}
