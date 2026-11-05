import type SimplePlugin from "../main";

export function registerThemeAppearance(plugin: SimplePlugin): () => void {
  const documents = new Set<Document>();
  const clear = (doc: Document): void => {
    doc.body.classList.remove("simple-theme-sidebar-background", "simple-tags-follow-accent", "simple-inline-code-appearance");
    doc.body.style.removeProperty("--simple-theme-sidebar-background");
  };
  const apply = (doc: Document): void => {
    documents.add(doc);
    clear(doc);
    doc.body.classList.toggle("simple-tags-follow-accent", plugin.settings.themeTagsFollowAccent === true);
    doc.body.classList.toggle("simple-inline-code-appearance", plugin.settings.themeInlineCodeFollowsBody === true);
    const color = plugin.settings.themeBackgroundColor;
    if (/^#[0-9a-f]{6}$/i.test(color)) {
      doc.body.style.setProperty("--simple-theme-sidebar-background", color);
      doc.body.classList.add("simple-theme-sidebar-background");
    }
  };
  const refresh = (): void => {
    for (const doc of new Set([document, ...documents])) apply(doc);
    plugin.app.workspace.iterateAllLeaves(leaf => apply(leaf.getContainer().doc));
  };
  plugin.registerEvent(plugin.app.workspace.on("window-open", win => apply(win.doc)));
  plugin.registerEvent(plugin.app.workspace.on("window-close", win => { clear(win.doc); documents.delete(win.doc); }));
  plugin.register(() => { for (const doc of documents) clear(doc); documents.clear(); });
  refresh();
  return refresh;
}
