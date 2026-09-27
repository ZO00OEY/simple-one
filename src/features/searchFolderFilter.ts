import { Modal, Setting, TFolder, normalizePath, setIcon } from "obsidian";
import type SimplePlugin from "../main";
import type { SearchFolderSettings } from "../types";

type SearchViewLike = {
  containerEl: HTMLElement;
  getQuery?: () => string;
  setQuery?: (query: string) => void;
  searchQuery?: { query?: string };
  searchComponent?: {
    inputEl?: HTMLInputElement;
  };
};

type SearchControlState = {
  view: SearchViewLike;
  applying: boolean;
  composing: boolean;
  inputTimer: number | null;
  onInput?: (event: Event) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
};

export function registerSearchFolderFilter(plugin: SimplePlugin): () => void {
  const states = new Map<HTMLElement, SearchControlState>();

  const queryInput = (view: SearchViewLike): HTMLInputElement | null =>
    view.searchComponent?.inputEl
      ?? view.containerEl.querySelector<HTMLInputElement>(".global-search-input-container input[type='search']");

  const setVisibleQuery = (view: SearchViewLike, value: string): void => {
    const input = queryInput(view);
    if (input) input.value = value;
  };

  const setInternalQuery = (state: SearchControlState, query: string, visibleQuery: string): void => {
    state.applying = true;
    if (state.view.setQuery) {
      state.view.setQuery(query);
    } else {
      const input = queryInput(state.view);
      if (input) {
        input.value = query;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      }
    }
    setVisibleQuery(state.view, visibleQuery);
    window.setTimeout(() => { state.applying = false; }, 0);
  };

  const applyState = (state: SearchControlState): void => {
    const input = queryInput(state.view);
    if (!input) return;
    const base = stripKnownFolderFilters(input.value, plugin.settings.searchFolders);
    const nextFilter = plugin.settings.searchFolders.enabled
      ? buildFolderFilter(plugin.settings.searchFolders)
      : "";
    const next = [base.trim(), nextFilter].filter(Boolean).join(" ");
    const currentInternal = state.view.searchQuery?.query ?? state.view.getQuery?.() ?? input.value;
    if (currentInternal !== next || input.value !== base) {
      setInternalQuery(state, next, base);
    }
  };

  const applyAll = (): void => {
    for (const state of states.values()) applyState(state);
  };

  const syncStateUi = (state: SearchControlState): void => {
    const config = plugin.settings.searchFolders;
    const root = state.view.containerEl;
    root.querySelector<HTMLElement>(".simple-search-folder-setting .setting-item-description")
      ?.setText(searchFolderSummary(config));
    syncFolderRow(root, "include", config.includeFolders);
    syncFolderRow(root, "exclude", config.excludeFolders);
  };

  const syncAllUi = (): void => {
    for (const state of states.values()) syncStateUi(state);
  };

  const updateConfig = async (update: (config: SearchFolderSettings) => void): Promise<void> => {
    update(plugin.settings.searchFolders);
    await plugin.saveSettings();
    applyAll();
    syncAllUi();
  };

  const inject = (view: SearchViewLike): void => {
    const params = view.containerEl.querySelector<HTMLElement>(".search-params");
    const input = queryInput(view);
    if (!params || !input || states.has(view.containerEl)) return;
    params.querySelectorAll(".simple-search-folder-setting, .simple-search-folder-panel")
      .forEach((element) => element.remove());

    const state: SearchControlState = {
      view,
      applying: false,
      composing: false,
      inputTimer: null,
    };
    states.set(view.containerEl, state);

    const row = new Setting(params)
      .setClass("simple-search-folder-setting")
      .setName("搜索增强")
      .setDesc(searchFolderSummary(plugin.settings.searchFolders));
    const chevron = row.controlEl.createEl("button", {
      cls: "clickable-icon simple-search-folder-chevron",
      attr: { "aria-label": "展开搜索增强", "aria-expanded": "false" },
    });
    setIcon(chevron, "chevron-down");

    const panel = params.createDiv({ cls: "simple-search-folder-panel" });
    panel.hidden = true;
    panel.createDiv({
      cls: "simple-search-folder-hint",
      text: "两个条件可同时生效；限定范围使用 Obsidian 原生 path:，屏蔽范围使用 -path:。",
    });

    new Setting(panel)
      .setClass("simple-search-include-folders")
      .setName("仅搜索所选文件夹")
      .setDesc(folderListDescription(plugin.settings.searchFolders.includeFolders))
      .addButton((button) =>
        button.setButtonText("选择").onClick(() => {
          openSearchFolderPicker(
            plugin,
            plugin.settings.searchFolders.includeFolders,
            (folders) => updateConfig((config) => { config.includeFolders = folders; }),
            "选择限定搜索的文件夹"
          );
        })
      );

    new Setting(panel)
      .setClass("simple-search-exclude-folders")
      .setName("屏蔽所选文件夹")
      .setDesc(folderListDescription(plugin.settings.searchFolders.excludeFolders))
      .addButton((button) =>
        button.setButtonText("选择").onClick(() => {
          openSearchFolderPicker(
            plugin,
            plugin.settings.searchFolders.excludeFolders,
            (folders) => updateConfig((config) => { config.excludeFolders = folders; }),
            "选择需要屏蔽的文件夹"
          );
        })
      );

    const togglePanel = (): void => {
      panel.hidden = !panel.hidden;
      chevron.toggleClass("is-expanded", !panel.hidden);
      chevron.setAttr("aria-expanded", String(!panel.hidden));
    };
    chevron.addEventListener("click", togglePanel);
    row.infoEl.addEventListener("click", togglePanel);

    const scheduleApply = (delay = 120): void => {
      if (state.inputTimer !== null) window.clearTimeout(state.inputTimer);
      state.inputTimer = window.setTimeout(() => {
        state.inputTimer = null;
        applyState(state);
      }, delay);
    };
    const onInput = (event: Event): void => {
      const inputEvent = event as InputEvent;
      if (
        state.applying
        || state.composing
        || inputEvent.isComposing
        || !plugin.settings.searchFolders.enabled
      ) return;
      scheduleApply();
    };
    const onCompositionStart = (): void => {
      state.composing = true;
      if (state.inputTimer !== null) {
        window.clearTimeout(state.inputTimer);
        state.inputTimer = null;
      }
    };
    const onCompositionEnd = (): void => {
      state.composing = false;
      if (plugin.settings.searchFolders.enabled) scheduleApply(30);
    };
    state.onInput = onInput;
    state.onCompositionStart = onCompositionStart;
    state.onCompositionEnd = onCompositionEnd;
    input.addEventListener("input", onInput);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);

    applyState(state);
  };

  const refresh = (): void => {
    for (const [root, state] of states) {
      if (!root.isConnected || !plugin.settings.searchFolders.enabled) {
        if (state.inputTimer !== null) window.clearTimeout(state.inputTimer);
        const input = queryInput(state.view);
        if (input && state.onInput) input.removeEventListener("input", state.onInput);
        if (input && state.onCompositionStart) input.removeEventListener("compositionstart", state.onCompositionStart);
        if (input && state.onCompositionEnd) input.removeEventListener("compositionend", state.onCompositionEnd);
        if (!plugin.settings.searchFolders.enabled && input) {
          const visible = stripKnownFolderFilters(input.value, plugin.settings.searchFolders);
          setInternalQuery(state, visible, visible);
        }
        root.querySelector(".simple-search-folder-setting")?.remove();
        root.querySelector(".simple-search-folder-panel")?.remove();
        states.delete(root);
      }
    }
    if (!plugin.settings.searchFolders.enabled) return;
    for (const leaf of plugin.app.workspace.getLeavesOfType("search")) {
      inject(leaf.view as unknown as SearchViewLike);
    }
    applyAll();
    syncAllUi();
  };

  const scheduleRefresh = (): void => { window.setTimeout(refresh, 0); };
  plugin.registerEvent(plugin.app.workspace.on("layout-change", scheduleRefresh));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", scheduleRefresh));
  plugin.app.workspace.onLayoutReady(refresh);
  plugin.register(() => {
    for (const state of states.values()) {
      const input = queryInput(state.view);
      if (state.inputTimer !== null) window.clearTimeout(state.inputTimer);
      if (input && state.onInput) input.removeEventListener("input", state.onInput);
      if (input && state.onCompositionStart) input.removeEventListener("compositionstart", state.onCompositionStart);
      if (input && state.onCompositionEnd) input.removeEventListener("compositionend", state.onCompositionEnd);
      if (input) {
        const visible = stripKnownFolderFilters(input.value, plugin.settings.searchFolders);
        setInternalQuery(state, visible, visible);
      }
      state.view.containerEl.querySelector(".simple-search-folder-setting")?.remove();
      state.view.containerEl.querySelector(".simple-search-folder-panel")?.remove();
    }
    states.clear();
  });
  return refresh;
}

export function searchFolderSummary(config: SearchFolderSettings): string {
  if (!config.enabled) return "已关闭";
  const parts: string[] = [];
  if (config.includeFolders.length) parts.push("限定 " + config.includeFolders.length);
  if (config.excludeFolders.length) parts.push("屏蔽 " + config.excludeFolders.length);
  return parts.length ? parts.join(" · ") : "全部文件夹";
}

export function openSearchFolderPicker(
  plugin: SimplePlugin,
  selected: string[],
  onSave: (folders: string[]) => void | Promise<void>,
  title = "选择搜索文件夹"
): void {
  new SearchFolderPickerModal(plugin, selected, onSave, title).open();
}

function buildFolderFilter(config: SearchFolderSettings): string {
  const includes = normalizeFolderList(config.includeFolders);
  const excludes = normalizeFolderList(config.excludeFolders);
  const includeClauses = includes.map((folder) => folderPathClause(folder));
  const excludeClauses = excludes.map((folder) => "-" + folderPathClause(folder));
  const includeFilter = includeClauses.length > 1
    ? "(" + includeClauses.join(" OR ") + ")"
    : includeClauses[0] ?? "";
  return [includeFilter, ...excludeClauses].filter(Boolean).join(" ");
}

function folderPathClause(folder: string): string {
  return 'path:"' + escapeSearchPath(folder + "/") + '"';
}

function normalizeFolderList(folders: string[]): string[] {
  return [...new Set(folders.map((folder) => normalizePath(folder.trim())).filter(Boolean))];
}

function escapeSearchPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripKnownFolderFilters(query: string, config: SearchFolderSettings): string {
  const includes = normalizeFolderList(config.includeFolders);
  const includeClauses = includes.map((folder) => folderPathClause(folder));
  const includeFilter = includeClauses.length > 1
    ? "(" + includeClauses.join(" OR ") + ")"
    : includeClauses[0] ?? "";
  const tokens = [
    includeFilter,
    ...normalizeFolderList(config.excludeFolders).map((folder) => "-" + folderPathClause(folder)),
  ].filter(Boolean);
  let visible = query;
  for (const token of tokens) visible = visible.split(token).join(" ");
  return visible.replace(/\s+/g, " ").trim();
}

function folderListDescription(folders: string[]): string {
  return folders.length ? folders.join("、") : "尚未选择文件夹";
}

function syncFolderRow(root: HTMLElement, kind: "include" | "exclude", folders: string[]): void {
  root.querySelector<HTMLElement>(".simple-search-" + kind + "-folders .setting-item-description")
    ?.setText(folderListDescription(folders));
}

function folderChildren(folder: TFolder): TFolder[] {
  return folder.children
    .filter((child): child is TFolder => child instanceof TFolder)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

class SearchFolderPickerModal extends Modal {
  private selected: Set<string>;
  private expanded = new Set<string>();

  constructor(
    private readonly plugin: SimplePlugin,
    selected: string[],
    private readonly onSave: (folders: string[]) => void | Promise<void>,
    private readonly title: string
  ) {
    super(plugin.app);
    this.selected = new Set(selected);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-search-folder-modal");
    this.contentEl.createEl("h2", { text: this.title });
    const search = this.contentEl.createEl("input", {
      cls: "simple-search-folder-picker-search",
      attr: { type: "search", placeholder: "筛选文件夹…" },
    });
    const selectionSummary = this.contentEl.createDiv({ cls: "simple-search-folder-picker-summary" });
    const list = this.contentEl.createDiv({ cls: "simple-search-folder-picker-list" });
    const rootFolders = folderChildren(this.plugin.app.vault.getRoot());
    const allFolders = this.plugin.app.vault.getAllFolders()
      .filter((folder): folder is TFolder => folder instanceof TFolder && folder.path.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));

    const render = (): void => {
      const scrollTop = list.scrollTop;
      list.empty();
      const needle = search.value.trim().toLocaleLowerCase();
      selectionSummary.setText(this.selected.size ? "已选 " + this.selected.size + " 个文件夹" : "尚未选择文件夹");

      const renderCheckbox = (parent: HTMLElement, path: string, label: string): void => {
        const checkbox = parent.createEl("input", { attr: { type: "checkbox" } });
        checkbox.checked = this.selected.has(path);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selected.add(path);
          else this.selected.delete(path);
          render();
        });
        const name = parent.createSpan({ cls: "simple-search-folder-picker-name", text: label });
        name.setAttr("title", path);
        name.addEventListener("click", () => checkbox.click());
      };

      const renderTreeFolder = (folder: TFolder, depth: number): void => {
        const children = folderChildren(folder);
        const row = list.createDiv({ cls: "simple-search-folder-picker-row simple-search-folder-tree-row" });
        row.style.setProperty("--simple-folder-depth", String(depth));

        if (children.length) {
          const expand = row.createEl("button", {
            cls: "clickable-icon simple-search-folder-expand",
            attr: {
              "aria-label": this.expanded.has(folder.path) ? "折叠文件夹" : "展开文件夹",
              "aria-expanded": String(this.expanded.has(folder.path)),
            },
          });
          setIcon(expand, "chevron-right");
          expand.toggleClass("is-expanded", this.expanded.has(folder.path));
          expand.addEventListener("click", () => {
            if (this.expanded.has(folder.path)) this.expanded.delete(folder.path);
            else this.expanded.add(folder.path);
            render();
          });
        } else {
          row.createSpan({ cls: "simple-search-folder-expand-placeholder" });
        }

        renderCheckbox(row, folder.path, folder.name);
        const selectedChildren = [...this.selected].filter((path) => path.startsWith(folder.path + "/")).length;
        if (selectedChildren) {
          row.createSpan({
            cls: "simple-search-folder-selected-count",
            text: "已选 " + selectedChildren,
          });
        }

        if (this.expanded.has(folder.path)) {
          for (const child of children) renderTreeFolder(child, depth + 1);
        }
      };

      if (needle) {
        for (const folder of allFolders) {
          if (!folder.path.toLocaleLowerCase().includes(needle)) continue;
          const row = list.createDiv({ cls: "simple-search-folder-picker-row simple-search-folder-search-row" });
          renderCheckbox(row, folder.path, folder.path);
        }
      } else {
        for (const folder of rootFolders) renderTreeFolder(folder, 0);
      }
      list.scrollTop = scrollTop;
    };
    search.addEventListener("input", render);
    render();

    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    new Setting(actions)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText("保存").onClick(() => {
        const folders = [...this.selected].sort((a, b) => a.localeCompare(b, "zh-CN"));
        void this.onSave(folders);
        this.close();
      }));
    window.setTimeout(() => search.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
