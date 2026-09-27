import {
  App,
  htmlToMarkdown,
  ItemView,
  Modal,
  Notice,
  normalizePath,
  setIcon,
  setTooltip,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type SimplePlugin from "../main";
import type {
  FieldExtraction,
  PageRequest,
  PageUrlFromRule,
  SiteRule,
  TemplateCategory,
  UrlReplaceRule,
} from "../types";
import { fetchDecodedHtml, runWebviewScript } from "../shared/webFetch";
import { toYamlValue } from "../shared/yaml";
import { trimTrailingUrlPunctuation } from "./linkFilter";
import { TEMPLATE_FILL_ICON } from "./templateFillAction";

export const VIEW_TYPE = "simple-template-fill";
const SEARCH_CONCURRENCY = 3;

type UrlMatch = {
  cat: TemplateCategory;
  pattern: string;
  siteRule: SiteRule;
  fields: FieldExtraction[];
};

type SearchCandidate = {
  cat: TemplateCategory;
  siteRule: SiteRule;
  title: string;
  author: string;
  intro: string;
  url: string;
  hydrated?: boolean;
};

type SearchGroup = {
  key: string;
  cat: TemplateCategory;
  siteRule: SiteRule;
  candidates: SearchCandidate[];
  pageUrl: string;
  pageIndex: number;
  prevPageUrl: string;
  nextPageUrl: string;
};

export class TemplateFillView extends ItemView {
  plugin: SimplePlugin;
  private urlInput!: HTMLTextAreaElement;
  private infoEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private createBtn!: HTMLButtonElement;
  private matchedCat: TemplateCategory | null = null;
  private matchedFields: FieldExtraction[] = [];
  private matchedRule: UrlMatch | null = null;
  private extractedFields: Record<string, string> = {};
  private pendingSearchFields: Record<string, string> | null = null;
  private searchGroups: SearchGroup[] = [];
  private lastSearchQuery = "";
  private searchFilterKey = "all";
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SimplePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "快速新建笔记"; }
  getIcon(): string { return TEMPLATE_FILL_ICON; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("simple-template-fill");
    container.setAttr("style", "display:flex; flex-direction:column; height:100%; padding:12px 12px 60px 12px; min-width:0; overflow-x:hidden;");

    this.urlInput = container.createEl("textarea", {
      attr: { style: "width:100%; height:80px; resize:none; box-sizing:border-box; flex-shrink:0;", placeholder: "直接粘贴网址，预览笔记；\n输入关键词后，Enter搜索，预览笔记" },
    });
    this.urlInput.addEventListener("input", () => this.onUrlChange());
    this.urlInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      const input = this.urlInput.value.trim();
      if (!input) return;
      event.preventDefault();
      const url = normalizeInputUrl(input);
      if (url) {
        this.showUrlPreview(url);
      } else {
        void this.searchByTitle(input);
      }
    });
    this.urlInput.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      const text = await navigator.clipboard.readText();
      if (text) {
        this.urlInput.value = text;
        this.urlInput.dispatchEvent(new Event("input"));
      }
    });

    this.infoEl = container.createDiv({
      attr: { style: "margin-top:10px; padding:8px; background:var(--background-secondary); border-radius:6px; font-size:0.85em; line-height:1.6; flex-shrink:0;" },
    });
    this.infoEl.setText("粘贴网址会生成笔记；输入书名后按 Enter 搜索候选。");

    this.previewEl = container.createDiv({ cls: "simple-template-preview" });

    this.createBtn = container.createEl("button", {
      attr: { style: "width:100%; margin-top:10px; flex-shrink:0;" },
    });
    this.createBtn.setText("新建文件");
    this.createBtn.addClass("mod-cta");
    this.createBtn.disabled = true;
    this.createBtn.addEventListener("click", () => this.onCreateFile());
  }

  async onClose(): Promise<void> {}

  setInput(text: string): void {
    const input = text.trim();
    this.urlInput.value = input;
    this.urlInput.dispatchEvent(new Event("input"));
    if (input && !normalizeInputUrl(input)) void this.searchByTitle(input);
  }

  private onUrlChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    const input = this.urlInput.value.trim();
    const url = normalizeInputUrl(input);
    if (!input) {
      this.infoEl.setText("等待网址或书名...");
      this.matchedCat = null;
      this.matchedFields = [];
      this.matchedRule = null;
      this.createBtn.disabled = true;
      this.previewEl.removeClass("is-active");
      return;
    }

    if (!url) {
      this.matchedCat = null;
      this.matchedFields = [];
      this.matchedRule = null;
      this.createBtn.disabled = true;
      this.infoEl.setText("检测到文字，按 Enter 在已配置的网站中搜索书名。");
      this.previewEl.removeClass("is-active");
      return;
    }

    this.showUrlPreview(url);
  }

  private showUrlPreview(url: string, knownMatch?: UrlMatch): void {
    if (!knownMatch) {
      this.searchGroups = [];
      this.lastSearchQuery = "";
      this.searchFilterKey = "all";
      this.pendingSearchFields = null;
    }
    const result = knownMatch ?? this.matchUrl(url);
    if (result) {
      this.matchedCat = result.cat;
      this.matchedFields = result.fields;
      this.matchedRule = result;
      this.infoEl.empty();
      this.infoEl.createDiv({ text: `分类：${result.cat.name}` });
      this.infoEl.createDiv({ text: `输出：${result.cat.outputFolder || "当前库根目录"}` });
      this.infoEl.createDiv({ text: `匹配网站：${result.pattern}` });

      this.debounceTimer = setTimeout(() => this.fetchPreview(url, result.siteRule), 500);
    } else {
      this.matchedCat = null;
      this.matchedFields = [];
      this.matchedRule = null;
      this.infoEl.setText("未匹配到规则，请在设置中配置。");
      this.createBtn.disabled = true;
      this.previewEl.removeClass("is-active");
    }
  }

  private matchUrl(url: string): UrlMatch | null {
    for (const cat of this.plugin.settings.templateCategories) {
      for (const siteRule of cat.siteRules) {
        if (!siteRule.urlPattern) continue;
        try {
          if (new RegExp(siteRule.urlPattern, "i").test(url)) {
            return { cat, pattern: siteRule.urlPattern, siteRule, fields: siteRule.fields || [] };
          }
        } catch {
          // Invalid user regex: skip this rule.
        }
      }
    }
    return null;
  }

  private async searchByTitle(query: string): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.matchedCat = null;
    this.matchedFields = [];
    this.matchedRule = null;
    this.createBtn.disabled = true;
    this.previewEl.addClass("is-active");
    this.previewEl.empty();
    this.previewEl.createDiv({ text: "正在搜索各网站第一页..." });

    this.lastSearchQuery = query;
    this.searchFilterKey = "all";
    this.searchGroups = [];
    const groups = await searchNovelGroups(query, this.plugin.settings.templateCategories, (group) => {
      if (this.urlInput.value.trim() !== query || (!this.plugin.settings.showEmptySearchGroups && group.candidates.length === 0)) return;
      this.searchGroups.push(group);
      this.infoEl.empty();
      this.infoEl.createDiv({ text: `书名搜索：${query}` });
      this.infoEl.createDiv({ text: `候选：${this.searchGroups.reduce((sum, entry) => sum + entry.candidates.length, 0)} 个` });
      this.renderSearchGroups();
    });
    if (this.urlInput.value.trim() !== query) return;

    this.previewEl.empty();
    if (this.searchGroups.length === 0 && groups.every((group) => group.candidates.length === 0)) {
      this.infoEl.setText("没有搜索到候选；请检查网站搜索规则。");
      this.previewEl.createDiv({ text: "没有候选结果。" });
      return;
    }

    if (this.searchGroups.length === 0) {
      this.searchGroups = this.plugin.settings.showEmptySearchGroups
        ? groups
        : groups.filter((group) => group.candidates.length > 0);
    }
    this.infoEl.empty();
    this.infoEl.createDiv({ text: `书名搜索：${query}` });
    this.infoEl.createDiv({ text: `候选：${this.searchGroups.reduce((sum, group) => sum + group.candidates.length, 0)} 个` });
    this.renderSearchGroups();
  }

  private renderSearchGroups(): void {
    this.renderUnifiedSearchGroups();
    return;
    this.previewEl.addClass("is-active");
    this.previewEl.empty();
    for (const searchGroup of this.searchGroups) {
      const group = this.previewEl.createDiv({ cls: "simple-search-group" });
      const header = group.createDiv({ cls: "simple-search-group-header" });
      header.createDiv({
        cls: "simple-search-group-title",
        text: `${searchGroup.cat.name} · ${siteLabel(searchGroup.siteRule)}`,
      });
      const actions = header.createDiv({ cls: "simple-search-group-actions" });
      const prev = actions.createEl("button", { cls: "simple-soft-button simple-search-more" });
      prev.setText("上一页");
      prev.disabled = !searchGroup.prevPageUrl;
      if (searchGroup.prevPageUrl) prev.addEventListener("click", () => void this.loadSearchPage(searchGroup, "prev"));
      const more = actions.createEl("button", { cls: "simple-soft-button simple-search-more" });
      more.setText("下一页");
      more.disabled = !searchGroup.nextPageUrl;
      if (searchGroup.nextPageUrl) more.addEventListener("click", () => void this.loadSearchPage(searchGroup, "next"));

      const stack = group.createDiv({ cls: "simple-search-stack" });
      stack.addEventListener("mouseleave", () => this.clearSearchCandidateActivation(stack));
      stack.addEventListener("focusout", (event) => {
        if (!stack.contains(event.relatedTarget as Node | null)) this.clearSearchCandidateActivation(stack);
      });
      this.renderSearchCandidateRows(stack, searchGroup);
    }
  }

  private renderUnifiedSearchGroups(): void {
    this.previewEl.addClass("is-active");
    this.previewEl.empty();
    if (this.searchFilterKey !== "all" && !this.searchGroups.some((group) => group.key === this.searchFilterKey)) {
      this.searchFilterKey = "all";
    }

    this.renderSearchFilterBar();
    const groups = this.visibleSearchGroups();
    this.renderUnifiedSearchPager(groups);

    const stack = this.previewEl.createDiv({ cls: "simple-search-stack simple-search-stack-unified" });
    stack.addEventListener("mouseleave", () => this.clearSearchCandidateActivation(stack));
    stack.addEventListener("focusout", (event) => {
      if (!stack.contains(event.relatedTarget as Node | null)) this.clearSearchCandidateActivation(stack);
    });
    this.renderUnifiedSearchRows(stack, groups);
  }

  private renderSearchFilterBar(): void {
    const bar = this.previewEl.createDiv({ cls: "simple-search-filter-bar" });
    this.renderSearchFilterButton(bar, "all", "全部");
    for (const group of this.searchGroups) {
      this.renderSearchFilterButton(bar, group.key, siteLabel(group.siteRule));
    }
  }

  private renderSearchFilterButton(parent: HTMLElement, key: string, label: string): void {
    const button = parent.createEl("button", { cls: "simple-search-filter" });
    button.toggleClass("is-active", this.searchFilterKey === key);
    button.setText(label);
    button.addEventListener("click", () => {
      this.searchFilterKey = key;
      this.renderSearchGroups();
    });
  }

  private visibleSearchGroups(): SearchGroup[] {
    return this.searchFilterKey === "all"
      ? this.searchGroups
      : this.searchGroups.filter((group) => group.key === this.searchFilterKey);
  }

  private renderUnifiedSearchPager(groups: SearchGroup[]): void {
    const pager = this.previewEl.createDiv({ cls: "simple-search-pager" });
    const prev = pager.createEl("button", { cls: "simple-soft-button simple-search-page-button" });
    prev.setText("上一页");
    prev.empty();
    setIcon(prev, "chevron-left");
    setTooltip(prev, "上一页");
    prev.setAttr("aria-label", "上一页");
    prev.disabled = !groups.some((group) => group.prevPageUrl);
    if (!prev.disabled) prev.addEventListener("click", () => void this.loadSearchPageForFilter("prev"));

    pager.createDiv({
      cls: "simple-search-page-label",
      text: this.searchFilterKey === "all" ? "全部站点" : groups[0] ? siteLabel(groups[0].siteRule) : "当前站点",
    });

    const next = pager.createEl("button", { cls: "simple-soft-button simple-search-page-button" });
    next.setText("下一页");
    next.empty();
    setIcon(next, "chevron-right");
    setTooltip(next, "下一页");
    next.setAttr("aria-label", "下一页");
    next.disabled = !groups.some((group) => group.nextPageUrl);
    if (!next.disabled) next.addEventListener("click", () => void this.loadSearchPageForFilter("next"));
  }

  private renderUnifiedSearchRows(stack: HTMLElement, groups: SearchGroup[]): void {
    const rows = groups.flatMap((group) => group.candidates.map((candidate) => ({ group, candidate })))
      .sort((a, b) => searchCandidateRelevance(b.candidate, this.lastSearchQuery)
        - searchCandidateRelevance(a.candidate, this.lastSearchQuery));
    if (rows.length === 0) {
      stack.createDiv({ cls: "simple-search-empty", text: "没有搜索结果，或网站拦截了搜索页。" });
      return;
    }

    stack.addClass("has-results");
    for (const { group, candidate } of rows) {
      const row = stack.createDiv({ cls: "simple-search-candidate" });
      row.tabIndex = 0;
      row.addEventListener("mouseenter", () => this.activateSearchCandidate(row));
      row.addEventListener("focusin", () => this.activateSearchCandidate(row));
      row.createDiv({ cls: "simple-search-site-tag", text: `[${siteLabel(group.siteRule)}]` });
      const main = row.createDiv({ cls: "simple-search-candidate-main" });
      main.createDiv({ cls: "simple-search-title", text: candidate.title || "(未命名)" });
      const detail = main.createDiv({ cls: "simple-search-detail" });
      const meta = [candidate.author].filter(Boolean).join(" · ");
      if (meta) detail.createDiv({ cls: "simple-search-meta", text: meta });
      if (candidate.intro) detail.createDiv({ cls: "simple-search-intro", text: candidate.intro });
      const openCandidate = () => {
        this.urlInput.value = candidate.url;
        this.pendingSearchFields = {
          "书名": candidate.title,
          "作者": cleanSearchAuthor(candidate.author),
          "文案": candidate.intro,
        };
        this.showUrlPreview(candidate.url, {
          cat: candidate.cat,
          pattern: candidate.siteRule.urlPattern,
          siteRule: candidate.siteRule,
          fields: candidate.siteRule.fields || [],
        });
      };
      row.addEventListener("click", openCandidate);
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openCandidate();
      });
    }
  }

  private async loadSearchPageForFilter(direction: "prev" | "next"): Promise<void> {
    const groups = this.visibleSearchGroups().filter((group) => direction === "next" ? group.nextPageUrl : group.prevPageUrl);
    if (groups.length === 0) return;
    this.infoEl.setText(direction === "next" ? "正在加载下一页..." : "正在加载上一页...");
    await Promise.all(groups.map((group) => this.loadSearchPageData(group, direction)));
    this.renderSearchInfo();
    this.renderSearchGroups();
  }

  private async loadSearchPageData(group: SearchGroup, direction: "prev" | "next"): Promise<void> {
    const targetUrl = direction === "next" ? group.nextPageUrl : group.prevPageUrl;
    if (!targetUrl) return;
    const targetPageIndex = group.pageIndex + (direction === "next" ? 1 : -1);
    const currentUrl = group.pageUrl;
    const next = await searchSitePage(this.lastSearchQuery, group.cat, group.siteRule, targetUrl, targetPageIndex);
    group.pageUrl = targetUrl;
    group.pageIndex = targetPageIndex;
    group.prevPageUrl = direction === "next" ? currentUrl : previousSearchPageUrl(group);
    group.nextPageUrl = next.nextPageUrl;
    group.candidates = next.candidates;
  }

  private renderSearchInfo(): void {
    this.infoEl.empty();
    this.infoEl.createDiv({ text: `书名搜索：${this.lastSearchQuery}` });
    this.infoEl.createDiv({ text: `候选：${this.searchGroups.reduce((sum, entry) => sum + entry.candidates.length, 0)} 个` });
  }

  private renderSearchCandidateRows(stack: HTMLElement, searchGroup: SearchGroup): void {
    if (searchGroup.candidates.length === 0) {
      stack.createDiv({ cls: "simple-search-empty", text: "没有搜索结果，或网站拦截了搜索页。" });
      return;
    }
    stack.addClass("has-results");
    const start = searchResultStartNumber(searchGroup);
    for (let index = 0; index < searchGroup.candidates.length; index++) {
      const candidate = searchGroup.candidates[index];
      const row = stack.createDiv({ cls: "simple-search-candidate" });
      row.tabIndex = 0;
      row.addEventListener("mouseenter", () => this.activateSearchCandidate(row));
      row.addEventListener("focusin", () => this.activateSearchCandidate(row));
      row.createDiv({ cls: "simple-search-index", text: String(start + index) });
      const main = row.createDiv({ cls: "simple-search-candidate-main" });
      main.createDiv({ cls: "simple-search-title", text: candidate.title || "(未命名)" });
      const detail = main.createDiv({ cls: "simple-search-detail" });
      const meta = [candidate.author].filter(Boolean).join(" · ");
      if (meta) detail.createDiv({ cls: "simple-search-meta", text: meta });
      if (candidate.intro) detail.createDiv({ cls: "simple-search-intro", text: candidate.intro });
      const openCandidate = () => {
        this.urlInput.value = candidate.url;
        this.pendingSearchFields = {
          "书名": candidate.title,
          "作者": cleanSearchAuthor(candidate.author),
          "文案": candidate.intro,
        };
        this.showUrlPreview(candidate.url, {
          cat: candidate.cat,
          pattern: candidate.siteRule.urlPattern,
          siteRule: candidate.siteRule,
          fields: candidate.siteRule.fields || [],
        });
      };
      row.addEventListener("click", openCandidate);
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openCandidate();
      });
    }
  }

  private activateSearchCandidate(row: HTMLElement): void {
    const stack = row.closest<HTMLElement>(".simple-search-stack");
    if (stack) this.clearSearchCandidateActivation(stack);
    row.addClass("is-active");
  }

  private clearSearchCandidateActivation(stack: HTMLElement): void {
    stack.querySelectorAll(".simple-search-candidate.is-active").forEach((item) => item.removeClass("is-active"));
  }

  private async loadSearchPage(group: SearchGroup, direction: "prev" | "next"): Promise<void> {
    const targetUrl = direction === "next" ? group.nextPageUrl : group.prevPageUrl;
    if (!targetUrl) return;
    const buttonText = `${siteLabel(group.siteRule)} 正在加载${direction === "next" ? "下一页" : "上一页"}...`;
    this.infoEl.setText(buttonText);
    const targetPageIndex = group.pageIndex + (direction === "next" ? 1 : -1);
    const currentUrl = group.pageUrl;
    const next = await searchSitePage(this.lastSearchQuery, group.cat, group.siteRule, targetUrl, targetPageIndex);
    group.pageUrl = targetUrl;
    group.pageIndex = targetPageIndex;
    group.prevPageUrl = direction === "next" ? currentUrl : previousSearchPageUrl(group);
    group.nextPageUrl = next.nextPageUrl;
    group.candidates = next.candidates;
    this.infoEl.empty();
    this.infoEl.createDiv({ text: `书名搜索：${this.lastSearchQuery}` });
    this.infoEl.createDiv({ text: `候选：${this.searchGroups.reduce((sum, entry) => sum + entry.candidates.length, 0)} 个` });
    this.renderSearchGroups();
  }

  private renderSearchBackButton(): void {
    if (this.searchGroups.length === 0) return;
    const back = this.previewEl.createEl("button", { cls: "simple-soft-button simple-search-back" });
    back.setText("返回搜索结果");
    back.addEventListener("click", () => {
      this.createBtn.disabled = true;
      this.infoEl.empty();
      this.infoEl.createDiv({ text: `书名搜索：${this.lastSearchQuery}` });
      this.infoEl.createDiv({ text: `候选：${this.searchGroups.reduce((sum, group) => sum + group.candidates.length, 0)} 个` });
      this.renderSearchGroups();
    });
  }

  private async fetchPreview(url: string, siteRule: SiteRule): Promise<void> {
    this.previewEl.addClass("is-active");
    this.previewEl.empty();
    this.renderSearchBackButton();
    this.previewEl.createDiv({ text: "⏳ 正在抓取..." });

    const pageMap = await fetchPageMap(url, siteRule);
    if (!hasFetchedPage(pageMap)) {
      this.previewEl.empty();
      this.previewEl.createDiv({ text: "❌ 无法访问该网址" });
      return;
    }

    this.extractedFields = {};
    for (const field of siteRule.fields || []) {
      const page = field.page
        ? pageMap.get(field.page)
        : pageMap.get(firstPageId(siteRule)) ?? firstPage(pageMap);
      if (field.source === "inputUrl" || field.source === "原始网址") {
        this.extractedFields[field.fieldName] = applyFieldRegex(pageMap.get("input")?.url ?? url, field);
      } else if (field.source === "baseUrl" || field.source === "网址") {
        this.extractedFields[field.fieldName] = applyFieldRegex(pageMap.get("base")?.url ?? url, field);
      } else {
        this.extractedFields[field.fieldName] = page ? extractField(page.html, field) : "";
      }
    }

    this.extractedFields["网址"] = pageMap.get("base")?.url ?? url;
    if (isQidianRule(siteRule)) {
      const qidianFields = extractBestQidianBookData(pageMap);
      for (const [name, value] of Object.entries(qidianFields)) {
        if (name === "文案") {
          if (value) this.extractedFields[name] = value;
        } else if (!this.extractedFields[name] && value) {
          this.extractedFields[name] = value;
        }
      }
    }
    if (this.pendingSearchFields) {
      for (const [name, value] of Object.entries(this.pendingSearchFields)) {
        if (!this.extractedFields[name] && value) this.extractedFields[name] = value;
      }
    }
    if (this.matchedCat?.name === "网文书评") {
      this.extractedFields["我的评分"] = "";
    }

    this.previewEl.empty();
    this.renderSearchBackButton();
    this.renderEditableFields();
    this.createBtn.disabled = false;
  }

  private renderEditableFields(): void {
    this.previewEl.addClass("is-active");

    const fieldOrder = getPreviewFieldOrder(
      this.matchedCat,
      this.matchedFields,
      this.extractedFields
    );
    const fields = fieldOrder
      .map((name) => ({ name, value: this.extractedFields[name] }))
      .filter((field): field is { name: string; value: string } => field.value !== undefined);
    const longFields = fields.filter((field) => isLongPreviewValue(field.value));
    const totalLongLength = longFields.reduce((sum, field) => sum + field.value.length, 0);
    const longFieldWeights = new Map(
      longFields.map((field) => [
        field.name,
        totalLongLength > 0
          ? Math.max(1, Math.round((field.value.length / totalLongLength) * 100))
          : 1,
      ])
    );

    for (const field of fields) {
      this.renderPreviewField(field.name, field.value, {
        longFieldCount: longFields.length,
        longFieldWeight: longFieldWeights.get(field.name) ?? 1,
      });
    }
  }

  private renderPreviewField(
    name: string,
    value: string,
    previewLayout: { longFieldCount: number; longFieldWeight: number }
  ): void {
    const isLong = isLongPreviewValue(value);
    const row = this.previewEl.createDiv({
      cls: "simple-preview-field",
    });

    if (!isLong) {
      row.addClass("simple-preview-field-short");
      row.createSpan({
        cls: "simple-preview-label",
        text: name,
      });
      row.createSpan({
        cls: "simple-preview-value",
        text: value,
      });
      row.createEl("input", {
        type: "hidden",
        attr: { "data-field": name, value },
      });
      return;
    }

    const flexGrow = previewLayout.longFieldCount > 1 ? previewLayout.longFieldWeight : 1;
    row.setAttr(
      "style",
      `display:flex; flex-direction:column; flex:${flexGrow} 1 140px; min-height:120px;`
    );
    row.addClass("simple-preview-field-long");
    const hidden = row.createEl("input", {
      type: "hidden",
      attr: { "data-field": name, value },
    });
    row.createDiv({
      cls: "simple-preview-long-label",
      text: `${name}（已抓取 ${value.length} 字）`,
    });
    const textarea = row.createEl("textarea", {
      cls: "simple-preview-textarea",
    });
    textarea.value = value;
    textarea.addEventListener("input", () => {
      hidden.value = textarea.value;
    });
  }

  private async onCreateFile(): Promise<void> {
    const url = normalizeInputUrl(this.urlInput.value);
    if (!url) {
      new Notice("请输入有效网址");
      return;
    }
    const result = this.matchedRule ?? this.matchUrl(url);
    if (!result) {
      new Notice("未匹配到规则");
      return;
    }
    const cat = result.cat;

    const editedFields: Record<string, string> = {};
    this.previewEl.querySelectorAll("[data-field]").forEach((element) => {
      const name = element.getAttribute("data-field");
      if (!name) return;
      editedFields[name] = element instanceof HTMLTextAreaElement
        ? element.value
        : (element as HTMLInputElement).value;
    });

    let content = cat.noteFormat?.trim()
      ? applyNoteFormat(cat.noteFormat, editedFields)
      : buildDefaultNoteContent(editedFields, cat.filenameField);
    content = addSiteBodyMarker(content, result.siteRule);

    const rawName = editedFields[cat.filenameField] || "未命名";
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_");

    const folderPath = cat.outputFolder.trim() ? normalizePath(cat.outputFolder) : "";
    const filePath = folderPath ? normalizePath(`${folderPath}/${safeName}.md`) : `${safeName}.md`;

    if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      const shouldMerge = await confirmMergeExistingNote(this.app, safeName);
      if (!shouldMerge) {
        new Notice("已取消合并");
        return;
      }

      const oldContent = await this.app.vault.read(existingFile);
      const mergedContent = mergeNoteContent(content, oldContent);
      await this.app.vault.modify(existingFile, mergedContent);
      new Notice(`已合并：${safeName}.md`);

      const leaf = this.app.workspace.getLeaf();
      await leaf.openFile(existingFile);
      return;
    }

    const newFile = await this.app.vault.create(filePath, content);
    new Notice(`已创建：${safeName}.md`);

    const leaf = this.app.workspace.getLeaf();
    await leaf.openFile(newFile instanceof TFile ? newFile : this.app.vault.getFileByPath(filePath)!);
  }
}

class MergeExistingNoteModal extends Modal {
  private readonly fileName: string;
  private readonly onSubmit: (confirmed: boolean) => void;
  private submitted = false;

  constructor(app: App, fileName: string, onSubmit: (confirmed: boolean) => void) {
    super(app);
    this.fileName = fileName;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "发现同名笔记" });
    contentEl.createDiv({
      text: `${this.fileName}.md 已经存在。是否合并属性栏，并保留旧笔记正文？`,
      cls: "setting-item-description",
    });

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const cancel = footer.createEl("button");
    cancel.setText("取消");
    cancel.addEventListener("click", () => {
      this.submitted = true;
      this.onSubmit(false);
      this.close();
    });

    const merge = footer.createEl("button", { cls: "mod-cta" });
    merge.setText("合并");
    merge.addEventListener("click", () => {
      this.submitted = true;
      this.onSubmit(true);
      this.close();
    });
  }

  onClose(): void {
    if (!this.submitted) {
      this.onSubmit(false);
    }
    this.contentEl.empty();
  }
}

function confirmMergeExistingNote(app: App, fileName: string): Promise<boolean> {
  return new Promise((resolve) => {
    new MergeExistingNoteModal(app, fileName, resolve).open();
  });
}

function extractField(html: string, field: FieldExtraction): string {
  let raw = "";
  const source = field.source;

  if (source === "title") {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    raw = match ? match[1].trim() : "";
  } else if (source === "h1") {
    raw = extractSelectorText(html, "h1");
  } else if (source === "skillsContent") {
    raw = extractSkillsContent(html);
  } else if (source.startsWith("#")) {
    const id = source.slice(1);
    for (const tryId of [id, id + "_whole"]) {
      raw = extractSelectorText(html, `#${cssEscape(tryId)}`);
      if (raw) {
        raw = raw.replace(/^简介[：:]\s*/i, "");
        raw = raw.split("\n").map((line) => line.trim()).join("\n").trim();
        break;
      }
    }
  } else if (source.startsWith(".")) {
    raw = extractSelectorText(html, source);
  } else if (source.startsWith("meta[")) {
    const attrMatch = source.match(/^meta\[(.+)\]$/);
    if (attrMatch) {
      raw = extractMetaContent(html, attrMatch[1]);
    }
  } else if (source) {
    raw = extractSelectorText(html, source);
  }

  return applyFieldRegex(raw, field);
}

function applyFieldRegex(raw: string, field: FieldExtraction): string {
  if (field.regex && raw) {
    try {
      const regex = new RegExp(field.regex);
      const match = raw.match(regex);
      if (match) {
        if (field.replaceWith) {
          raw = field.replaceWith.replace(/\$(\d+)/g, (_, number) => match[parseInt(number)] || "");
        } else {
          const groups = match.slice(1).filter((group) => group !== undefined);
          raw = groups.length > 0 ? groups.join("") : match[0];
        }
      } else {
        raw = "";
      }
    } catch {
      // Invalid user regex: keep the unfiltered raw value.
    }
  }

  return raw;
}

function extractSkillsContent(html: string): string {
  const doc = parseHtml(html);
  const proseBlocks = Array.from(doc?.querySelectorAll<HTMLElement>("main .prose") ?? []);
  const summary = proseBlocks[0] ? elementToMarkdown(proseBlocks[0]).trim() : "";
  const skill = proseBlocks[1] ? demoteMarkdownHeadings(elementToMarkdown(proseBlocks[1]), 2).trim() : "";
  return [
    summary ? `## Summary\n\n${summary}` : "",
    skill ? `## SKILL.md\n\n${skill}` : "",
  ].filter(Boolean).join("\n\n");
}

function demoteMarkdownHeadings(markdown: string, levels: number): string {
  return markdown.replace(/^(#{1,6})\s/gm, (_, hashes: string) => {
    return `${"#".repeat(Math.min(6, hashes.length + levels))} `;
  });
}

type PageMapEntry = {
  url: string;
  html: string;
};

async function fetchPageMap(
  inputUrl: string,
  siteRule: SiteRule
): Promise<Map<string, PageMapEntry>> {
  const pageMap = new Map<string, PageMapEntry>();
  const baseUrl = applyBaseUrlRule(inputUrl, siteRule.input?.baseUrl);
  pageMap.set("input", { url: inputUrl, html: "" });
  pageMap.set("base", { url: baseUrl, html: "" });

  const pages = siteRule.pages?.length
    ? siteRule.pages
    : [{ id: "main", url: "{{inputUrl}}" }];

  for (const page of pages) {
    const pageUrl = resolvePageUrl(page, pageMap);
    if (!pageUrl) continue;
    const html = await fetchRulePageHtml(pageUrl, siteRule);
    if (!html) continue;
    pageMap.set(page.id, { url: pageUrl, html });
    if (isQidianRule(siteRule) && hasQidianIntroDetail(html)) break;
  }

  return pageMap;
}

async function fetchRulePageHtml(url: string, siteRule: SiteRule): Promise<string | null> {
  if (!isQidianRule(siteRule)) return await fetchDecodedHtml(url);

  if (isQidianDesktopBookUrl(url)) {
    const rendered = await fetchQidianRenderedBookHtml(url);
    if (hasQidianIntroDetail(rendered)) return rendered;
  }
  return await fetchDecodedHtml(url, { fallbackToWebview: false });
}

function isQidianRule(siteRule: SiteRule): boolean {
  return siteRule.handler === "qidianBook" || /qidian/i.test(siteRule.urlPattern);
}

function isQidianDesktopBookUrl(url: string): boolean {
  return /^https?:\/\/(?:www\.)?qidian\.com\/book\/\d+\/?/i.test(url);
}

function hasQidianIntroDetail(html: string | null): boolean {
  return !!html && /\bid=["']book-intro-detail["']/.test(html);
}

async function fetchQidianRenderedBookHtml(url: string): Promise<string | null> {
  const script = `
    new Promise((resolve) => {
      const done = () => resolve(document.documentElement.outerHTML);
      if (document.querySelector("#book-intro-detail")) return done();
      const started = Date.now();
      const timer = setInterval(() => {
        if (document.querySelector("#book-intro-detail") || Date.now() - started > 15000) {
          clearInterval(timer);
          done();
        }
      }, 300);
    })
  `;
  return await runWebviewScript(url, script, 25000);
}

async function searchNovelGroups(
  query: string,
  categories: TemplateCategory[],
  onGroup?: (group: SearchGroup) => void
): Promise<SearchGroup[]> {
  const jobs: Array<{ cat: TemplateCategory; siteRule: SiteRule }> = [];
  for (const cat of categories) {
    for (const siteRule of cat.siteRules) {
      const search = siteRule.search;
      if (!search || search.enabled === false || !search.searchUrl || !search.resultList) continue;
      jobs.push({ cat, siteRule });
    }
  }

  const groups: SearchGroup[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const search = job.siteRule.search;
      if (!search) continue;
      const pageIndex = search.pageStart ?? 1;
      const searchUrl = applySearchUrlTemplate(search.searchUrl, query, pageIndex, search.resultLimit || 10);
      const result = await searchSitePage(query, job.cat, job.siteRule, searchUrl, pageIndex);
      const group = {
        key: `${job.cat.id}:${job.siteRule.id}`,
        cat: job.cat,
        siteRule: job.siteRule,
        candidates: result.candidates,
        pageUrl: searchUrl,
        pageIndex,
        prevPageUrl: "",
        nextPageUrl: result.nextPageUrl,
      };
      groups.push(group);
      onGroup?.(group);
    }
  };

  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, jobs.length) }, worker));
  return groups;
}

async function searchSitePage(
  query: string,
  cat: TemplateCategory,
  siteRule: SiteRule,
  pageUrl: string,
  pageIndex: number
): Promise<{ candidates: SearchCandidate[]; nextPageUrl: string }> {
  const search = siteRule.search;
  if (!search) return { candidates: [], nextPageUrl: "" };
  if (search.type === "fanqieApi" || siteRule.handler === "fanqieNovel") {
    return await searchFanqieApi(query, cat, siteRule, pageUrl, pageIndex);
  }

  const html = search.type === "webviewHtml"
    ? await fetchSearchWebviewHtml(pageUrl, search.resultList)
    : await fetchDecodedHtml(pageUrl);
  if (!html) return { candidates: [], nextPageUrl: "" };
  const doc = parseHtml(html);
  if (!doc) return { candidates: [], nextPageUrl: "" };

  const candidates: SearchCandidate[] = [];
  const limit = Math.max(1, search.resultLimit || 10);
  for (const item of Array.from(doc.querySelectorAll<HTMLElement>(search.resultList))) {
    const title = cleanSearchTitle(selectSearchText(item, search.resultTitle));
    const rawUrl = selectSearchHref(item, search.resultUrl || search.resultTitle);
    if (!title || !rawUrl) continue;
    candidates.push({
      cat,
      siteRule,
      title,
      author: search.resultAuthor ? selectSearchText(item, search.resultAuthor) : "",
      intro: search.resultIntro ? selectSearchText(item, search.resultIntro) : "",
      url: absolutizeUrl(rawUrl, pageUrl),
      hydrated: true,
    });
    if (candidates.length >= limit) break;
  }
  return {
    candidates,
    nextPageUrl: search.nextPage ? resolveSearchNextPage(pageUrl, html, search.nextPage) : "",
  };
}

async function fetchSearchWebviewHtml(url: string, resultList: string): Promise<string | null> {
  const script = `
    new Promise((resolve) => {
      const done = () => resolve(document.documentElement.outerHTML);
      if (document.querySelector(${JSON.stringify(resultList)})) return done();
      const started = Date.now();
      const timer = setInterval(() => {
        if (document.querySelector(${JSON.stringify(resultList)}) || Date.now() - started > 12000) {
          clearInterval(timer);
          done();
        }
      }, 300);
    })
  `;
  return await runWebviewScript(url, script, 25000);
}

function resolveSearchNextPage(pageUrl: string, html: string, rule: PageUrlFromRule): string {
  const pageMap = new Map<string, PageMapEntry>();
  pageMap.set("main", { url: pageUrl, html });
  return resolvePageUrlFrom(rule, pageMap) || "";
}

async function searchFanqieApi(
  query: string,
  cat: TemplateCategory,
  siteRule: SiteRule,
  pageUrl: string,
  pageIndex: number
): Promise<{ candidates: SearchCandidate[]; nextPageUrl: string }> {
  const search = siteRule.search;
  if (!search) return { candidates: [], nextPageUrl: "" };
  const limit = Math.max(1, search.resultLimit || 10);
  const apiPath = `/api/author/search/search_book/v1?filter=127,127,127,127&page_count=${limit}&page_index=${pageIndex}&query_type=0&query_word=${encodeURIComponent(query)}`;
  const script = `(async()=>{const r=await fetch(${JSON.stringify(apiPath)},{credentials:"include"});return await r.text();})()`;
  const jsonText = await runWebviewScript(pageUrl, script, 20000);
  if (!jsonText) return await searchFanqieRenderedPage(pageUrl, query, cat, siteRule, pageIndex);

  try {
    const value = JSON.parse(jsonText) as {
      code?: number;
      data?: {
        total_count?: number;
        search_book_data_list?: Array<Record<string, unknown>>;
      };
    };
    const result = await fanqieSearchResultFromBooks(
      value.data?.search_book_data_list ?? [],
      value.data?.total_count,
      query,
      cat,
      siteRule,
      search,
      pageIndex
    );
    return result.candidates.length ? result : await searchFanqieRenderedPage(pageUrl, query, cat, siteRule, pageIndex);
  } catch {
    return await searchFanqieRenderedPage(pageUrl, query, cat, siteRule, pageIndex);
  }
}

async function fanqieSearchResultFromBooks(
  books: Array<Record<string, unknown>>,
  totalCount: number | undefined,
  query: string,
  cat: TemplateCategory,
  siteRule: SiteRule,
  search: NonNullable<SiteRule["search"]>,
  pageIndex: number
): Promise<{ candidates: SearchCandidate[]; nextPageUrl: string }> {
  const limit = Math.max(1, search.resultLimit || 10);
  const candidates = books.slice(0, limit).map((book) => {
    const id = cleanFanqieSearchText(book.book_id);
    const url = id ? `https://fanqienovel.com/page/${id}?enter_from=search` : "";
    return {
      cat,
      siteRule,
      title: cleanFanqieSearchText(book.book_name),
      author: cleanFanqieSearchText(book.author),
      intro: cleanFanqieSearchText(book.book_abstract),
      url,
      hydrated: false,
    };
  });
    const hydrated = await hydrateSearchCandidates(candidates);
    const total = totalCount ?? candidates.length;
    const nextIndex = pageIndex + 1;
    return {
      candidates: hydrated.filter((candidate) => candidate.title && candidate.url),
      nextPageUrl: nextIndex * limit < total
        ? applySearchUrlTemplate(search.searchUrl, query, nextIndex, limit)
        : "",
    };
}

async function searchFanqieRenderedPage(
  pageUrl: string,
  query: string,
  cat: TemplateCategory,
  siteRule: SiteRule,
  pageIndex: number
): Promise<{ candidates: SearchCandidate[]; nextPageUrl: string }> {
  const script = `
    new Promise((resolve) => {
      const findReactBook = (node) => {
        const key = Object.keys(node).find((item) => item.startsWith("__reactFiber$") || item.startsWith("__reactInternalInstance$"));
        const root = key ? node[key] : null;
        const seen = new Set();
        const scan = (value, depth) => {
          if (!value || depth > 16 || seen.has(value)) return null;
          if (typeof value !== "object") return null;
          seen.add(value);
          if ((value.book_id || value.bookId) && (value.book_name || value.bookName)) return value;
          for (const key of Object.keys(value)) {
            if (key === "stateNode" || key === "baseState") continue;
            const found = scan(value[key], depth + 1);
            if (found) return found;
          }
          return null;
        };
        return scan(root, 0);
      };
      const done = () => {
        const books = Array.from(document.querySelectorAll(".search-book-item")).map((item) => {
          const data = findReactBook(item) || {};
          return {
            book_id: data.book_id || data.bookId || "",
            book_name: data.book_name || data.bookName || item.querySelector(".title")?.textContent || "",
            author: data.author || item.querySelector(".desc span")?.textContent?.replace(/^作者[:：]?\\s*/, "") || "",
            book_abstract: data.book_abstract || data.abstract || item.querySelector(".desc.abstract")?.textContent || "",
          };
        });
        resolve(JSON.stringify({ data: { search_book_data_list: books, total_count: books.length } }));
      };
      if (document.querySelector(".search-book-item")) return done();
      const started = Date.now();
      const timer = setInterval(() => {
        if (document.querySelector(".search-book-item") || Date.now() - started > 12000) {
          clearInterval(timer);
          done();
        }
      }, 300);
    })
  `;
  const jsonText = await runWebviewScript(pageUrl, script, 20000);
  if (!jsonText) return { candidates: [], nextPageUrl: "" };
  try {
    const value = JSON.parse(jsonText) as {
      data?: { search_book_data_list?: Array<Record<string, unknown>>; total_count?: number };
    };
    const search = siteRule.search;
    if (!search) return { candidates: [], nextPageUrl: "" };
    return await fanqieSearchResultFromBooks(
      value.data?.search_book_data_list ?? [],
      value.data?.total_count,
      query,
      cat,
      siteRule,
      search,
      pageIndex
    );
  } catch {
    return { candidates: [], nextPageUrl: "" };
  }
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function cleanFanqieSearchText(value: unknown): string {
  return stringFromUnknown(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF\uFFFC\uFFFD]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function hydrateFanqieCandidate(candidate: SearchCandidate): Promise<SearchCandidate> {
  if (candidate.hydrated || !candidate.url) return candidate;
  const html = await fetchDecodedHtml(candidate.url);
  if (!html) return candidate;

  const title = extractFanqieCandidateField(html, candidate.siteRule, "书名", ".info-name h1");
  const author = extractFanqieCandidateField(html, candidate.siteRule, "作者", ".author-name-text");
  const intro = extractFanqieCandidateField(html, candidate.siteRule, "文案", ".page-abstract-content");
  return {
    ...candidate,
    title: title || candidate.title,
    author: author || candidate.author,
    intro: intro || candidate.intro,
    hydrated: true,
  };
}

async function hydrateSearchCandidates(candidates: SearchCandidate[]): Promise<SearchCandidate[]> {
  return await Promise.all(candidates.map(hydrateFanqieCandidate));
}

function extractFanqieCandidateField(
  html: string,
  siteRule: SiteRule,
  fieldName: string,
  fallbackSource: string
): string {
  const field = siteRule.fields.find((item) => item.fieldName === fieldName)
    ?? siteRule.fields.find((item) => item.source === fallbackSource);
  return field ? extractField(html, field) : "";
}

function applySearchUrlTemplate(template: string, query: string, page: number, limit: number): string {
  return template
    .replace(/\{\{queryEncoded\}\}/g, encodeURIComponent(query))
    .replace(/\{\{query\}\}/g, query)
    .replace(/\{\{pageIndex\}\}/g, String(page))
    .replace(/\{\{limit\}\}/g, String(limit))
    .replace(/\{\{page\}\}/g, String(page));
}

function selectSearchText(root: HTMLElement, selector: string): string {
  const element = selectSearchElement(root, selector);
  return element ? elementToText(element).replace(/\s+/g, " ").trim() : "";
}

function selectSearchHref(root: HTMLElement, selector: string): string {
  const element = selectSearchElement(root, selector);
  if (!element) return "";
  if (element instanceof HTMLAnchorElement) return element.getAttribute("href") || element.href || "";
  return element.getAttribute("href") || element.querySelector<HTMLAnchorElement>("a")?.href || "";
}

function selectSearchElement(root: HTMLElement, selector: string): HTMLElement | null {
  if (!selector || selector === ":scope") return root;
  for (const part of selector.split(",").map((item) => item.trim()).filter(Boolean)) {
    try {
      const element = root.querySelector<HTMLElement>(part);
      if (element) return element;
    } catch {
      // Invalid user selector: try the next selector in the list.
    }
  }
  return null;
}

function cleanSearchTitle(title: string): string {
  return title.replace(/^\s*\d+[.、]\s*/, "").trim();
}

function applyBaseUrlRule(inputUrl: string, rule: UrlReplaceRule | undefined): string {
  if (!rule) return inputUrl;
  try {
    return inputUrl.replace(new RegExp(rule.regex), rule.replaceWith);
  } catch {
    return inputUrl;
  }
}

function resolvePageUrl(
  page: PageRequest,
  pageMap: Map<string, PageMapEntry>
): string | null {
  if (page.url) {
    return applyUrlTemplate(page.url, pageMap);
  }
  if (page.urlFrom) {
    return resolvePageUrlFrom(page.urlFrom, pageMap);
  }
  return null;
}

function resolvePageUrlFrom(
  rule: PageUrlFromRule,
  pageMap: Map<string, PageMapEntry>
): string | null {
  const sourcePage = pageMap.get(rule.page || "main");
  if (!sourcePage) return null;

  if (rule.type === "urlReplace") {
    try {
      return sourcePage.url.replace(new RegExp(rule.regex), rule.replaceWith);
    } catch {
      return null;
    }
  }

  if (rule.type === "selectorHref") {
    const href = findHrefBySelector(sourcePage.html, rule.selector);
    return href ? absolutizeUrl(href, sourcePage.url) : null;
  }

  if (rule.type === "regexFromHtml") {
    try {
      const match = sourcePage.html.match(new RegExp(rule.regex));
      if (!match) return null;
      const nextUrl = rule.replaceWith
        ? rule.replaceWith.replace(/\$(\d+)/g, (_, number) => match[parseInt(number)] || "")
        : match[1] || match[0];
      return absolutizeUrl(nextUrl, sourcePage.url);
    } catch {
      return null;
    }
  }

  if (rule.type === "queryParamIncrement") {
    try {
      const url = new URL(sourcePage.url);
      const current = parseInt(url.searchParams.get(rule.param) || String(rule.start ?? 1), 10);
      url.searchParams.set(rule.param, String((Number.isFinite(current) ? current : rule.start ?? 1) + 1));
      return url.toString();
    } catch {
      return null;
    }
  }

  return null;
}

function applyUrlTemplate(
  template: string,
  pageMap: Map<string, PageMapEntry>
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, rawName: string) => {
    const name = rawName.trim();
    if (name === "inputUrl") return pageMap.get("input")?.url ?? "";
    if (name === "baseUrl") return pageMap.get("base")?.url ?? "";
    return pageMap.get(name)?.url ?? "";
  });
}

function findHrefBySelector(html: string, selector: string): string | null {
  const doc = parseHtml(html);
  const element = doc?.querySelector<HTMLAnchorElement>(selector);
  return element?.getAttribute("href") ?? null;
}

function absolutizeUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function firstPageId(siteRule: SiteRule): string {
  return siteRule.pages?.[0]?.id ?? "main";
}

function firstPage(pageMap: Map<string, PageMapEntry>): PageMapEntry | null {
  for (const [id, page] of pageMap.entries()) {
    if (id !== "input" && id !== "base" && page.html) return page;
  }
  return null;
}

function hasFetchedPage(pageMap: Map<string, PageMapEntry>): boolean {
  for (const [id, page] of pageMap.entries()) {
    if (id !== "input" && id !== "base" && page.html) return true;
  }
  return false;
}

function extractSelectorText(html: string, selector: string): string {
  const doc = parseHtml(html);
  if (!doc) return "";
  for (const part of selector.split(",").map((item) => item.trim()).filter(Boolean)) {
    try {
      const element = doc.querySelector<HTMLElement>(part);
      if (element) return elementToText(element);
    } catch {
      // Invalid user selector: try the next selector in the list.
    }
  }
  return "";
}

function extractMetaContent(html: string, attrSelector: string): string {
  const doc = parseHtml(html);
  const selector = `meta[${attrSelector}]`;
  return doc?.querySelector<HTMLMetaElement>(selector)?.content.trim() ?? "";
}

function parseHtml(html: string): Document | null {
  try {
    return new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

function elementToText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  clone.querySelectorAll("p,div,section,article,li,h1,h2,h3,h4,h5,h6").forEach((block) => {
    block.append(document.createTextNode("\n"));
  });
  return (clone.textContent ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .trim();
}

function elementToMarkdown(element: HTMLElement): string {
  return normalizeMarkdown(htmlToMarkdown(element));
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
}

function buildDefaultNoteContent(
  fields: Record<string, string>,
  filenameField: string
): string {
  let content = "---\n";
  for (const [name, value] of Object.entries(fields)) {
    if (name === filenameField) continue;
    if (name === "原始网址") continue;
    content += `${name}: ${toYamlValue(value)}\n`;
  }
  content += "---\n";
  return content;
}

function addSiteBodyMarker(content: string, siteRule: SiteRule): string {
  const marker = "【完结可看】";
  if (!/52shuku/i.test(siteRule.urlPattern) || content.includes(marker)) {
    return content;
  }
  return `${content.trimEnd()}\n\n${marker}\n`;
}

type ParsedFrontmatter = {
  properties: Map<string, string>;
  body: string;
};

function mergeNoteContent(newContent: string, oldContent: string): string {
  const newNote = parseFrontmatter(newContent);
  const oldNote = parseFrontmatter(oldContent);
  const mergedProperties = new Map(oldNote.properties);

  for (const [key, value] of newNote.properties) {
    if (!value.trim() && mergedProperties.get(key)?.trim()) {
      continue;
    }
    mergedProperties.set(key, value);
  }

  return buildFrontmatter(mergedProperties) + oldNote.body.trimStart();
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {
      properties: new Map(),
      body: content,
    };
  }

  return {
    properties: parseYamlProperties(match[1]),
    body: normalized.slice(match[0].length),
  };
}

function parseYamlProperties(yaml: string): Map<string, string> {
  const properties = new Map<string, string>();
  let currentKey = "";
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentKey) return;
    properties.set(currentKey, currentLines.join("\n"));
  };

  for (const line of yaml.split(/\r?\n/)) {
    const keyMatch = line.match(/^([^\s:\n][^:\n]*):(?:\s*(.*))?$/);
    if (keyMatch) {
      flush();
      currentKey = keyMatch[1].trim();
      currentLines = [keyMatch[2] ?? ""];
      continue;
    }

    if (currentKey) {
      currentLines.push(line);
    }
  }

  flush();
  return properties;
}

function buildFrontmatter(properties: Map<string, string>): string {
  let content = "---\n";
  for (const [key, value] of properties) {
    content += `${key}: ${value}\n`;
  }
  content += "---\n\n";
  return content;
}

function getPreviewFieldOrder(
  category: TemplateCategory | null,
  fields: FieldExtraction[],
  extractedFields: Record<string, string>
): string[] {
  const order: string[] = [];

  if (category?.noteFormat?.trim()) {
    for (const name of extractTemplateFieldNames(category.noteFormat)) {
      pushUnique(order, name);
    }
    if (category.filenameField) pushUnique(order, category.filenameField);
  } else {
    for (const field of fields) {
      pushUnique(order, field.fieldName);
    }
    for (const name of Object.keys(extractedFields)) {
      pushUnique(order, name);
    }
  }

  return order.filter((name) => name !== "原始网址");
}

function extractTemplateFieldNames(format: string): string[] {
  const names: string[] = [];
  format.replace(/\{\{([^}]+)\}\}/g, (_, rawName: string) => {
    const name = rawName.trim();
    if (name) names.push(name);
    return "";
  });
  return names;
}

function pushUnique(values: string[], value: string): void {
  if (value && !values.includes(value)) values.push(value);
}

function siteLabel(siteRule: SiteRule): string {
  return siteRule.shortName || siteRule.name || siteRule.urlPattern;
}

function searchResultStartNumber(group: SearchGroup): number {
  const limit = Math.max(1, group.siteRule.search?.resultLimit || group.candidates.length || 10);
  const pageStart = group.siteRule.search?.pageStart ?? 1;
  return Math.max(0, group.pageIndex - pageStart) * limit + 1;
}

function extractBestQidianBookData(pageMap: Map<string, PageMapEntry>): Record<string, string> {
  let best: Record<string, string> = {};
  let bestScore = -1;
  for (const [id, page] of pageMap.entries()) {
    if (id === "input" || id === "base" || !page.html) continue;
    const fields = extractQidianBookData(page.html);
    const intro = fields["文案"] || "";
    const score = (fields["书名"] ? 1000 : 0) + (fields["作者"] ? 500 : 0) + intro.length;
    if (score > bestScore) {
      best = fields;
      bestScore = score;
    }
  }
  return best;
}

function extractQidianBookData(html: string): Record<string, string> {
  const doc = parseHtml(html);
  const rawIntro = extractQidianIntroDetailHtml(html);
  const domIntro = doc
    ? selectElementText(doc, "#book-intro-detail, .book-intro p, .book-intro, .book-info-detail .book-intro, .intro")
    : "";
  const domTitle = doc ? selectElementText(doc, "h1, .book-info h1, .book-information h1") : "";
  const domAuthor = doc
    ? selectElementText(doc, ".book-info .writer a, .book-info .writer, .author a, a[href*=\"/author/\"]")
    : "";
  const domTags = doc ? selectElementText(doc, ".book-info .tag, .tag, .book-label") : "";
  const primary = html.split('"innerBookRecom"')[0] || html;
  const title = domTitle || readJsonString(primary, "bookName");
  const author = cleanQidianAuthor(domAuthor) || readJsonString(primary, "authorName");
  const tags = [
    domTags,
    readJsonString(primary, "categoryName"),
    readJsonString(primary, "subCategoryName"),
    readJsonString(primary, "tagName"),
  ].filter(Boolean).join(" ");
  const intro = rawIntro || domIntro || [
    readJsonString(primary, "description"),
    readJsonString(primary, "bookIntro"),
    readJsonString(primary, "intro"),
  ].sort((a, b) => b.length - a.length)[0] || "";

  return {
    "书名": title,
    "作者": author,
    "特殊标签": tags,
    "文案": formatQidianIntro(intro),
  };
}

function extractQidianIntroDetailHtml(html: string): string {
  const match = html.match(/<p\b[^>]*\bid=["']book-intro-detail["'][^>]*>([\s\S]*?)<\/p>/i);
  return match ? htmlFragmentToText(match[1]) : "";
}

function selectElementText(doc: Document, selector: string): string {
  for (const part of selector.split(",").map((item) => item.trim()).filter(Boolean)) {
    try {
      const element = doc.querySelector<HTMLElement>(part);
      if (element) return elementToText(element);
    } catch {
      // Invalid selector: try the next one.
    }
  }
  return "";
}

function htmlFragmentToText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
  const doc = parseHtml(withBreaks);
  return doc ? elementToText(doc.body) : withBreaks.replace(/<[^>]+>/g, "").trim();
}

function cleanQidianAuthor(value: string): string {
  return value.replace(/^作者[:：]\s*/, "").trim();
}

function readJsonString(html: string, key: string): string {
  const match = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`).trim();
  } catch {
    return match[1].replace(/\\r\\n|\\n|\\r/g, "\n").trim();
  }
}

function formatQidianIntro(value: string): string {
  if (!value) return "";
  return decodeHtmlText(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlText(value: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function cleanSearchAuthor(value: string): string {
  return value.replace(/^作者[:：]\s*/, "").trim();
}

function searchCandidateRelevance(candidate: SearchCandidate, query: string): number {
  const needle = normalizeSearchText(query);
  if (!needle) return 0;
  const title = normalizeSearchText(candidate.title);
  const author = normalizeSearchText(cleanSearchAuthor(candidate.author));
  return Math.max(
    textRelevance(title, needle),
    textRelevance(author, needle) * 0.95,
    textRelevance(`${title}${author}`, needle) * 0.9
  );
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function textRelevance(value: string, needle: string): number {
  if (!value) return 0;
  if (value === needle) return 4;
  if (value.startsWith(needle)) return 3 + needle.length / value.length;
  const index = value.indexOf(needle);
  if (index >= 0) return 2 + needle.length / value.length - index / value.length;
  const chars = new Set(needle);
  return [...chars].filter((char) => value.includes(char)).length / chars.size;
}

function previousSearchPageUrl(group: SearchGroup): string {
  const search = group.siteRule.search;
  if (!search || group.pageIndex <= (search.pageStart ?? 1)) return "";
  if (search.nextPage?.type === "queryParamIncrement") {
    try {
      const url = new URL(group.pageUrl);
      const previous = group.pageIndex - 1;
      if (previous <= (search.nextPage.start ?? search.pageStart ?? 1)) {
        url.searchParams.delete(search.nextPage.param);
      } else {
        url.searchParams.set(search.nextPage.param, String(previous));
      }
      return url.toString();
    } catch {
      return "";
    }
  }
  return "";
}

function isLongPreviewValue(value: string): boolean {
  return value.includes("\n") || value.length > 120;
}

function applyNoteFormat(
  format: string,
  fields: Record<string, string>
): string {
  return format.replace(/\{\{([^}]+)\}\}/g, (_, rawName: string) => {
    const name = rawName.trim();
    return fields[name] ?? "";
  });
}

function normalizeInputUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const urls = Array.from(
    trimmed.matchAll(/https?:\/\/.*?(?=https?:\/\/|[\s<>"'，。；、]|$)/gi),
    (match) => match[0]
  );
  if (urls.length === 0) return "";

  const normalizedUrls = urls.map((url) => trimTrailingUrlPunctuation(url));
  const uniqueUrls = Array.from(new Set(normalizedUrls));
  if (uniqueUrls.length === 1) return uniqueUrls[0];

  return normalizedUrls[0];
}
