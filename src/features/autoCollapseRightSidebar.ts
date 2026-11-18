import type SimplePlugin from "../main";

export function registerAutoCollapseRightSidebar(plugin: SimplePlugin): () => void {
  if (plugin.isMobile) return () => {};
  const workspace = plugin.app.workspace;
  let root: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let timer: number | undefined;
  let disposed = false;
  let collapsedForSpace = false;
  let sidebarWidth = 0;
  const refresh = (): void => {
    if (disposed || !root) return;
    window.clearTimeout(timer);
    // Wait for sidebar transitions and layout changes to settle before measuring.
    timer = window.setTimeout(() => {
      if (!root || !plugin.settings.enableAutoCollapseRightSidebar) {
        collapsedForSpace = false;
        return;
      }
      const width = root.getBoundingClientRect().width;
      if (!root.isConnected || width <= 0) return;
      const right = workspace.rightSplit;
      if (!right.collapsed) {
        const sidebar = (right as unknown as { containerEl?: HTMLElement }).containerEl;
        sidebarWidth = sidebar?.getBoundingClientRect().width ?? sidebarWidth;
      }
      // Recover only when an open sidebar would fit, not from our own collapse.
      const availableWidth = width - (right.collapsed ? sidebarWidth : 0);
      if (availableWidth >= 400) collapsedForSpace = false;
      if (!right.collapsed && width < 400 && !collapsedForSpace) {
        collapsedForSpace = true;
        right.collapse();
      }
    }, 150);
  };
  plugin.registerEvent(workspace.on("layout-change", refresh));
  plugin.register(() => {
    disposed = true;
    window.clearTimeout(timer);
    observer?.disconnect();
  });
  workspace.onLayoutReady(() => {
    if (disposed) return;
    root = (workspace.rootSplit as { containerEl?: HTMLElement } | null)?.containerEl;
    if (!root) return;
    observer = new ResizeObserver(refresh);
    observer.observe(root);
    refresh();
  });
  return refresh;
}
