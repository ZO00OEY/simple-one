import { getAllTags, Menu, Modal, Notice, Setting, type CachedMetadata } from "obsidian";
import type SimplePlugin from "../main";

const canonical = (tag: string) => tag.replace(/^#/, "").toLowerCase();
export function renamedTag(tag: string, oldName: string, newName: string): string {
  const raw = tag.replace(/^#/, "");
  const key = canonical(raw), old = canonical(oldName);
  return key === old || key.startsWith(`${old}/`) ? newName + raw.slice(oldName.length) : raw;
}
export function replaceBodyTags(source: string, cache: CachedMetadata, oldName: string, newName: string): string {
  const edits = (cache.tags ?? []).filter(t => renamedTag(t.tag, oldName, newName) !== t.tag.replace(/^#/, ""));
  for (const tag of edits.sort((a, b) => b.position.start.offset - a.position.start.offset)) {
    const { start, end } = tag.position;
    if (source.slice(start.offset, end.offset) !== tag.tag) throw new Error("标签位置已变化，请稍后重试");
    source = source.slice(0, start.offset) + "#" + renamedTag(tag.tag, oldName, newName) + source.slice(end.offset);
  }
  return source;
}

class RenameTagModal extends Modal {
  constructor(plugin: SimplePlugin, private oldName: string) { super(plugin.app); }
  onOpen() {
    this.modalEl.addClass("simple-tag-rename-modal");
    this.setTitle("在全库中重命名标签");
    let value = "";
    const message = this.contentEl.createEl("p", { cls: "simple-tag-rename-message", attr: { "aria-live": "polite" } });
    let confirmedName = "", busy = false;
    const row = new Setting(this.contentEl).setName("新标签名");
    row.addText(input => input.setPlaceholder(`原标签：#${this.oldName}`).setValue(value).onChange(v => { value = v; confirmedName = ""; message.empty(); }));
    new Setting(this.contentEl).addButton(b => b.setButtonText("取消").onClick(() => this.close()))
      .addButton(button => button.setButtonText("应用到全库").setCta().onClick(async () => {
        if (busy) return;
        const name = value.trim().replace(/^#/, "");
        if (!name || !/^[\p{L}\p{N}_/-]+$/u.test(name) || !/[\p{L}_-]/u.test(name) || name.split("/").some(s => !s)) {
          message.setText("请输入有效标签名：不能包含空格或特殊符号，也不能只有数字。"); return;
        }
        if (name === this.oldName) { this.close(); return; }
        const files = this.app.vault.getMarkdownFiles();
        const tags = files.flatMap(f => getAllTags(this.app.metadataCache.getFileCache(f) ?? {}) ?? []);
        const destinations = new Set(tags.filter(t => canonical(t) === canonical(this.oldName) || canonical(t).startsWith(canonical(this.oldName) + "/")).map(t => canonical(renamedTag(t, this.oldName, name))));
        const collision = tags.some(t => destinations.has(canonical(t)) && !(canonical(t) === canonical(this.oldName) || canonical(t).startsWith(canonical(this.oldName) + "/")));
        if (collision && confirmedName !== name) {
          message.setText(`目标标签 #${name}（或对应子标签）已存在。是否将全库中的 #${this.oldName} 全部更名为 #${name}，并合并到已有标签？再次点击“确认合并”执行。`);
          confirmedName = name; button.setButtonText("确认合并"); return;
        }
        busy = true; button.setDisabled(true);
        let changed = 0;
        try {
          for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache || !(getAllTags(cache) ?? []).some(t => canonical(t) === canonical(this.oldName) || canonical(t).startsWith(canonical(this.oldName) + "/"))) continue;
            const original = await this.app.vault.read(file);
            const body = replaceBodyTags(original, cache, this.oldName, name);
            if (body !== original) await this.app.vault.process(file, current => {
              if (current !== original) throw new Error(`${file.path} 已变化，请重试`);
              return body;
            });
            if (cache.frontmatter?.tags !== undefined) await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
              const tags = fm.tags;
              if (tags === undefined) return;
              const values: unknown[] = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[,\s]+/).filter(Boolean) : [];
              if (!values.some(t => typeof t === "string" && renamedTag(t, this.oldName, name) !== t.replace(/^#/, ""))) return;
              const renamed = values.map(t => typeof t === "string" ? renamedTag(t, this.oldName, name) : t);
              fm.tags = renamed.filter((t, i) => renamed.findIndex(other => typeof t === "string" && typeof other === "string" ? canonical(t) === canonical(other) : t === other) === i);
            });
            changed++;
          }
          new Notice(`已将 #${this.oldName} 更名为 #${name}，更新 ${changed} 篇笔记`);
          this.close();
        } catch (error) { message.setText(`已处理 ${changed} 篇笔记，操作中止：${String(error)}`); }
        finally { busy = false; button.setDisabled(false); }
      }));
  }
  onClose() { this.contentEl.empty(); }
}

export function registerTagRename(plugin: SimplePlugin): void {
  let pending: string | null = null;
  let active = true;
  const bound = new WeakSet<Document>();
  const decorated = new WeakSet<Menu>();
  const addAction = (menu: Menu, tag: string) => {
    if (!active || !plugin.settings.enableVaultTagRename || decorated.has(menu)) return;
    decorated.add(menu);
    menu.addItem(item => item.setTitle("在全库中重命名此标签…").setIcon("tags").onClick(() => new RenameTagModal(plugin, tag).open()));
  };
  const nativeMenu = Menu as typeof Menu & { forEvent?: (event: MouseEvent) => Menu };
  // Preserve the exact method for unload; the wrapper supplies its receiver with .call(Menu).
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve method identity for unload; wrapper supplies Menu as receiver.
  const originalForEvent = nativeMenu.forEvent;
  const wrappedForEvent = originalForEvent ? function (event: MouseEvent): Menu {
    const menu = originalForEvent.call(Menu, event);
    const element = event.target as HTMLElement | null;
    const pill = element?.closest('.metadata-property[data-property-key="tags"] .multi-select-pill');
    const tag = (pill?.querySelector(".multi-select-pill-content")?.textContent ?? pill?.textContent ?? "").trim().replace(/^#/, "");
    if (tag) addAction(menu, tag);
    return menu;
  } : undefined;
  if (wrappedForEvent) nativeMenu.forEvent = wrappedForEvent;
  plugin.register(() => { if (nativeMenu.forEvent === wrappedForEvent) nativeMenu.forEvent = originalForEvent; });
  // Preserve the exact prototype method; .apply(this, args) retains each menu's receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve method identity for unload; wrapper applies the current menu receiver.
  const original = Menu.prototype.showAtPosition;
  const wrapped: typeof original = function (this: Menu, ...args) {
    if (active && pending && plugin.settings.enableVaultTagRename) {
      const tag = pending; pending = null;
      addAction(this, tag);
    }
    return original.apply(this, args);
  };
  Menu.prototype.showAtPosition = wrapped;
  plugin.register(() => { active = false; if (Menu.prototype.showAtPosition === wrapped) Menu.prototype.showAtPosition = original; pending = null; });
  const bind = (doc: Document) => {
    if (bound.has(doc)) return;
    bound.add(doc);
    plugin.registerDomEvent(doc, "contextmenu", event => {
    pending = null;
    if (!plugin.settings.enableVaultTagRename) return;
    const element = event.target as HTMLElement | null;
    const pill = element?.closest('.metadata-property[data-property-key="tags"] .multi-select-pill');
    if (!pill) return;
    const tag = (pill.querySelector(".multi-select-pill-content")?.textContent ?? pill.textContent ?? "").trim().replace(/^#/, "");
    if (!tag) return;
    pending = tag;
    window.setTimeout(() => { pending = null; }, 0);
    }, { capture: true });
  };
  bind(document);
  plugin.app.workspace.iterateAllLeaves(leaf => { const doc = leaf.getContainer().doc; if (doc !== document) bind(doc); });
  plugin.registerEvent(plugin.app.workspace.on("window-open", win => bind(win.doc)));
}
