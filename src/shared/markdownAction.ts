import { MarkdownView } from "obsidian";
import type SimplePlugin from "../main";

type ActionSync = (action: HTMLElement) => void;

export function registerMarkdownAction(
  plugin: SimplePlugin,
  attr: string,
  enabled: () => boolean,
  create: (view: MarkdownView) => HTMLElement,
  sync: ActionSync
): () => void {
  const actions = new WeakMap<MarkdownView, HTMLElement>();

  const refresh = () => {
    plugin.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      const view = leaf.view;
      const existing = actions.get(view);
      if (!enabled()) {
        existing?.remove();
        actions.delete(view);
        return;
      }
      if (existing?.isConnected) {
        sync(existing);
        existing.removeAttribute("title");
        return;
      }

      const action = create(view);
      action.setAttr(attr, "true");
      sync(action);
      action.removeAttribute("title");
      actions.set(view, action);
    });
  };

  const cleanup = () => document.querySelectorAll<HTMLElement>(`[${attr}="true"]`).forEach((action) => action.remove());
  let queued = false;
  const scheduleRefresh = () => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      refresh();
    }, 0);
  };

  plugin.registerEvent(plugin.app.workspace.on("layout-change", scheduleRefresh));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", scheduleRefresh));
  plugin.register(cleanup);
  plugin.app.workspace.onLayoutReady(scheduleRefresh);

  return refresh;
}
