import type SimplePlugin from "../main";

export function registerThemeAppearance(plugin: SimplePlugin): () => void {
  const documents = new Set<Document>();
  const clear = (doc: Document): void => {
    doc.body.classList.remove("simple-theme-sidebar-background");
    doc.body.style.removeProperty("--simple-theme-sidebar-background");
  };
  const apply = (doc: Document): void => {
    documents.add(doc);
    const color = plugin.settings.themeBackgroundColor;
    if (/^#[0-9a-f]{6}$/i.test(color)) {
      doc.body.style.setProperty("--simple-theme-sidebar-background", color);
      doc.body.classList.add("simple-theme-sidebar-background");
    } else clear(doc);
  };
  const refresh = (): void => {
    apply(document);
    plugin.app.workspace.iterateAllLeaves(leaf => apply(leaf.getContainer().doc));
  };
  plugin.registerEvent(plugin.app.workspace.on("window-open", win => apply(win.doc)));
  plugin.registerEvent(plugin.app.workspace.on("window-close", win => { clear(win.doc); documents.delete(win.doc); }));
  plugin.register(() => { for (const doc of documents) clear(doc); documents.clear(); });
  refresh();
  return refresh;
}
