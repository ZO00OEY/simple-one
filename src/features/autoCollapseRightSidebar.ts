import type SimplePlugin from "../main";

export function registerAutoCollapseRightSidebar(plugin: SimplePlugin): () => void {
  if (plugin.isMobile) return () => {};
  const workspace = plugin.app.workspace;
  const root = (workspace.rootSplit as unknown as { containerEl?: HTMLElement }).containerEl;
  if (!root) return () => {};
  let timer: number | undefined;
  let disposed = false;
  let collapsedForSpace = false;
  let sidebarWidth = 0;
  const refresh = (): void => {
    if (disposed) return;
    window.clearTimeout(timer);
    // Wait for sidebar transitions and layout changes to settle before measuring.
    timer = window.setTimeout(() => {
      if (!plugin.settings.enableAutoCollapseRightSidebar) {
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
  const observer = new ResizeObserver(refresh);
  observer.observe(root);
  plugin.registerEvent(workspace.on("layout-change", refresh));
  plugin.register(() => {
    disposed = true;
    window.clearTimeout(timer);
    observer.disconnect();
  });
  workspace.onLayoutReady(refresh);
  return refresh;
}
