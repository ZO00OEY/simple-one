import { setIcon } from "obsidian";
import type SimplePlugin from "../main";
import { enhanceMermaid } from "../shared/mermaidViewer";

export function registerMermaidEnhancer(plugin: SimplePlugin): () => void {
  const pendingMermaids = new Set<HTMLElement>();
  const viewers = new Map<HTMLElement, { dispose: () => void; source: HTMLElement | null }>();
  let queued = false;
  let disposed = false;
  const enhance = (node: HTMLElement) => {
    if (!plugin.settings.enableMermaidEnhancer || viewers.has(node)) return;
    if (!node.closest(".markdown-reading-view, .markdown-preview-view, .markdown-rendered, .markdown-source-view.is-live-preview")) return;
    const source = node.parentElement;
    const dispose = enhanceMermaid(node, setIcon);
    if (dispose) viewers.set(node, { dispose, source });
  };

  const collectMermaids = (root: ParentNode) => {
    if (root.instanceOf(HTMLElement)) {
      if (root.matches(".mermaid")) pendingMermaids.add(root);
      const owner = root.closest<HTMLElement>(".mermaid");
      if (owner) pendingMermaids.add(owner);
    }
    root.querySelectorAll<HTMLElement>(".mermaid").forEach((mermaid) => pendingMermaids.add(mermaid));
  };

  const scheduleEnhance = (root?: ParentNode) => {
    if (disposed) return;
    if (root) collectMermaids(root);
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      if (disposed) return;
      for (const [node, viewer] of viewers) {
        if (!viewer.source?.isConnected || !node.isConnected) { viewer.dispose(); viewers.delete(node); }
      }
      pendingMermaids.forEach(enhance);
      pendingMermaids.clear();
    });
  };

  plugin.registerMarkdownPostProcessor((el) => {
    window.setTimeout(() => scheduleEnhance(el), 0);
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.instanceOf(HTMLElement)) collectMermaids(node);
      });
    }
    if (pendingMermaids.size > 0 || (viewers.size > 0 && mutations.some(mutation => mutation.removedNodes.length > 0))) scheduleEnhance();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  plugin.app.workspace.onLayoutReady(() => scheduleEnhance(document.body));

  const refresh = () => {
    if (plugin.settings.enableMermaidEnhancer) {
      scheduleEnhance(document.body);
      return;
    }

    viewers.forEach(viewer => viewer.dispose());
    viewers.clear();
  };

  plugin.register(() => {
    disposed = true;
    observer.disconnect();
    pendingMermaids.clear();
    viewers.forEach(viewer => viewer.dispose());
    viewers.clear();
  });

  return refresh;
}
