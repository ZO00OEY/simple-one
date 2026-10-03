// ============================================================
// Simple One — entry point
// ============================================================
import {
  Editor,
  MarkdownView,
  Plugin,
  Platform,
  WorkspaceLeaf,
} from "obsidian";
import {
  colorPreviewExtension,
  observeRenderedColorPreviews,
  refreshColorPreview,
  refreshRenderedColorPreviews,
} from "./features/colorPreview";
import { DIARY_VIEW_TYPE, DiaryView, openDiaryView } from "./features/diary";
import {
  htmlPreviewExtension,
  observeRenderedHtmlPreviews,
  refreshHtmlPreview,
  refreshRenderedHtmlPreviews,
} from "./features/htmlPreview";
import { registerCurrentNoteLinkConverter } from "./features/currentNoteLinkConverter";
import { registerImageZoom } from "./features/imageZoom";
import { registerMermaidEnhancer } from "./features/mermaidEnhancer";
import { registerLinkFilter } from "./features/linkFilter";
import { registerNewNoteDefaults } from "./features/newNoteDefaults";
import { registerPopupWindowSizing } from "./features/popupWindowSizing";
import { registerWindowPositionOptimization } from "./features/windowPositionOptimization";
import { registerQuickCopyLink } from "./features/quickCopyLink";
import { registerNotionColumns } from "./features/notionColumns";
import { applyQuickFormatStyles, registerQuickFormat } from "./features/quickFormat";
import { registerSearchFolderFilter } from "./features/searchFolderFilter";
import { registerTemplateFillAction, TEMPLATE_FILL_ICON } from "./features/templateFillAction";
import { TemplateFillView, VIEW_TYPE } from "./features/templateFill";
import { defaultTemplateCategories } from "./features/templateFillPresets";
import defaultData from "./default.json";
import SyncFeature from "./features/sync";
import { reportError } from "./shared/async";
import { SimpleSettingTab } from "./settings";
import { normalizePopupScalePercent } from "./shared/popupSizing";
import { activeDisplayProfile, loadMobileDisplayProfile } from "./shared/displayProfile";
import { applySwitchStates, collectSwitchStates, isSharedSwitchPath, mobileSettingsForSave, type SwitchStates } from "./shared/platformSwitches";
import {
  DEFAULT_SETTINGS,
  makeDefaultAnniversaries,
  makeDefaultTextReformatRules,
  nextId,
  type SimplePluginSettings,
  type QuickFormatMode,
  type HolidaySchedule,
  type DayScheduleStatus,
} from "./types";

type LoadedSettings = Partial<SimplePluginSettings> & { templateRules?: OldTemplateRule[] };

type OldTemplateRule = {
  id?: string;
  name?: string;
  outputFolder?: string;
  filenameField?: string;
  urlPattern?: string;
};

type RenderedPreviewObservers = {
  root: HTMLElement;
  color: MutationObserver;
  html: MutationObserver;
};

export default class SimplePlugin extends Plugin {
  settings!: SimplePluginSettings;
  sync!: SyncFeature;
  readonly isMobile = Platform.isMobile;

  get platformName(): string {
    if (Platform.isAndroidApp) return "Android";
    if (Platform.isIosApp) return "iOS / iPadOS";
    if (Platform.isWin) return "Windows";
    if (Platform.isMacOS) return "macOS";
    return this.isMobile ? "移动平台" : "桌面平台";
  }

  get displaySettings() {
    return activeDisplayProfile(this.settings, this.isMobile);
  }
  refreshTemplateFillActions: () => void = () => {};
  refreshSearchFolderControls: () => void = () => {};
  refreshMermaidEnhancements: () => void = () => {};
  refreshQuickFormatActions: () => void = () => {};
  refreshReformatActions: () => void = () => {};
  refreshPopupWindowSizing: () => void = () => {};
  private readableLineWidthDocuments = new Set<Document>();
  private templateFolder = "";
  private desktopSwitchStates: SwitchStates = {};
  private needsPlatformSwitchSave = false;
  private ownsFloatingButtonOptOut = false;

  async onload() {
    document.body.classList.add("simple-one-active");
    this.register(() => document.body.classList.remove("simple-one-active"));
    await this.loadSettings();
    if (this.needsPlatformSwitchSave) await this.saveSettings();
    applyQuickFormatStyles(this);
    this.applyReadableLineWidth();
    this.applyImageHeightLimit();
    this.applyMobileHeaderButtons();
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyMobileHeaderButtons()));
    this.register(() => {
      document.body.classList.remove("simple-mobile-header-size", "simple-mobile-native-header");
      document.body.style.removeProperty("--simple-mobile-header-button-size");
      if (this.ownsFloatingButtonOptOut) document.body.classList.remove("floating-button-off");
    });
    this.applyReadableCustomTagStyles();
    this.register(() => {
      document.body.classList.remove("simple-limit-image-height");
      document.body.style.removeProperty("--simple-image-max-height");
      this.readableLineWidthDocuments.forEach((doc) => {
        doc.body.style.removeProperty("--file-line-width");
        doc.body.classList.remove("simple-one-active", "simple-readable-custom-tags");
      });
      this.readableLineWidthDocuments.clear();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.applyImageHeightLimit();
      applyQuickFormatStyles(this);
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.applyImageHeightLimit()));
    this.registerEvent(this.app.workspace.on("window-open", (win) => {
      win.doc.body.classList.add("simple-one-active");
      applyQuickFormatStyles(this, win.doc);
      this.applyReadableLineWidth(win.doc);
      this.applyReadableCustomTagStyles();
    }));
    this.register(() => document.body.classList.remove("simple-readable-custom-tags"));

    // ── Feature 1: URL 粘贴处理 ──
    registerLinkFilter(this);

    // ── Feature 2: 快速笔记 ──
    if (this.settings.enableTemplateFill) {
      this.registerView(VIEW_TYPE, (leaf) => new TemplateFillView(leaf, this));
      const ribbon = this.addRibbonIcon(TEMPLATE_FILL_ICON, "快速新建笔记", async () => {
        let input = "";
        try {
          input = (await navigator.clipboard.readText()).trim();
        } catch { /* Clipboard permission may be unavailable. */ }
        await this.activateTemplateFill(input || undefined);
      });
      ribbon.setAttr("style", "order:999;");
    }

    // ── Feature 3: 颜色代码预览 ──
    this.registerEditorExtension(
      colorPreviewExtension(() => this.settings.enableColorPreview)
    );
    this.registerEditorExtension(
      htmlPreviewExtension(
        () => this.settings.enableHtmlPreview,
        () => this.settings.htmlPreviewRules
      )
    );
    this.registerRenderedPreviewObservers();
    this.registerMarkdownPostProcessor((el) => {
      this.decorateCustomTags(el);
      refreshRenderedHtmlPreviews(el, this.settings.enableHtmlPreview, this.settings.htmlPreviewRules);
    });

    // ── Feature 4: 日记 ──
    if (this.settings.diary.enabled) {
      this.registerView(DIARY_VIEW_TYPE, (leaf) => new DiaryView(leaf, this));
      const ribbon = this.addRibbonIcon("calendar-days", "日记", () => {
        void openDiaryView(this);
      });
      ribbon.setAttr("style", "order:998;");
    }

    // ── Feature 5: 功能增强 ──
    registerImageZoom(this);
    registerNotionColumns(this);
    this.refreshMermaidEnhancements = registerMermaidEnhancer(this);
    this.refreshTemplateFillActions = registerTemplateFillAction(this);
    registerNewNoteDefaults(this);
    registerQuickCopyLink(this);
    this.refreshQuickFormatActions = registerQuickFormat(this);
    this.refreshReformatActions = registerCurrentNoteLinkConverter(this);
    this.refreshSearchFolderControls = registerSearchFolderFilter(this);
    this.refreshPopupWindowSizing = registerPopupWindowSizing(this);
    registerWindowPositionOptimization(this);

    this.sync = this.addChild(new SyncFeature(this));
    await this.sync.initialize().catch(reportError);
    this.addSettingTab(new SimpleSettingTab(this.app, this));
  }

  applyMobileHeaderButtons(): void {
    if (!this.isMobile) return;
    const body = document.body;
    const profile = loadMobileDisplayProfile(this.settings.mobileDisplay);
    body.classList.toggle("simple-mobile-header-size", !!profile.headerButtonSize);
    if (profile.headerButtonSize) body.style.setProperty("--simple-mobile-header-button-size", `${profile.headerButtonSize}px`);
    else body.style.removeProperty("--simple-mobile-header-button-size");
    body.classList.toggle("simple-mobile-native-header", profile.disableThemeHeaderButtons);
    if (profile.disableThemeHeaderButtons) {
      if (!body.classList.contains("floating-button-off")) {
        body.classList.add("floating-button-off");
        this.ownsFloatingButtonOptOut = true;
      }
    } else if (this.ownsFloatingButtonOptOut) {
      body.classList.remove("floating-button-off");
      this.ownsFloatingButtonOptOut = false;
    }
  }

  async loadSettings() {
    const data = await this.loadData() as LoadedSettings | null;
    const dailyNotes = await this.readVaultConfig("daily-notes.json");
    const templates = await this.readVaultConfig("templates.json");
    this.templateFolder = vaultRelativePath(templates?.folder);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    normalizeEnhancements(this.settings, data);
    normalizeDiarySettings(this.settings, data);
    if (data?.diary?.folder === undefined && typeof dailyNotes?.folder === "string") {
      this.settings.diary.folder = vaultRelativePath(dailyNotes.folder);
    }
    if (data?.diary?.pathPattern === undefined && typeof dailyNotes?.format === "string" && dailyNotes.format.trim()) {
      const format = dailyNotes.format.trim();
      this.settings.diary.pathPattern = format.endsWith(".md") ? format : `${format}.md`;
    }
    if (data?.diary?.templatePath === undefined) {
      const template = vaultRelativePath(dailyNotes?.template);
      this.settings.diary.templatePath = template && !template.endsWith(".md") ? `${template}.md` : template;
    }
    normalizeTemplateCategories(this.settings, data);

    this.settings.newNoteDefaults = {
      ...DEFAULT_SETTINGS.newNoteDefaults,
      ...data?.newNoteDefaults,
      rules: data?.newNoteDefaults?.rules ?? [],
    };
    const loadedSearchFolders = data?.searchFolders;
    const legacySearchFolders = normalizeSearchFolders(loadedSearchFolders?.folders);
    this.settings.searchFolders = {
      enabled: loadedSearchFolders?.enabled ?? DEFAULT_SETTINGS.searchFolders.enabled,
      includeFolders: Array.isArray(loadedSearchFolders?.includeFolders)
        ? normalizeSearchFolders(loadedSearchFolders.includeFolders)
        : loadedSearchFolders?.mode === "include" ? legacySearchFolders : [],
      excludeFolders: Array.isArray(loadedSearchFolders?.excludeFolders)
        ? normalizeSearchFolders(loadedSearchFolders.excludeFolders)
        : loadedSearchFolders?.mode === "exclude" ? legacySearchFolders : [],
    };

    const enableUrlPaste = this.settings.autoProcessPaste || this.settings.autoProcessObsidian;
    this.settings.autoProcessPaste = enableUrlPaste;
    this.settings.autoProcessObsidian = enableUrlPaste;
    this.settings.autoProcessPastedTextLinks = data?.autoProcessPastedTextLinks ?? DEFAULT_SETTINGS.autoProcessPastedTextLinks;
    this.settings.plainTextPasteSkipsSingleLinkProcessing =
      data?.plainTextPasteSkipsSingleLinkProcessing ?? DEFAULT_SETTINGS.plainTextPasteSkipsSingleLinkProcessing;
    this.settings.plainTextPasteSkipsContentLinkScan =
      data?.plainTextPasteSkipsContentLinkScan ?? DEFAULT_SETTINGS.plainTextPasteSkipsContentLinkScan;
    this.settings.imageMaxHeight = normalizeImageMaxHeight(data?.imageMaxHeight);
    this.settings.readableLineWidth = normalizeReadableLineWidth(data?.readableLineWidth);
    this.settings.popupWindowScale = normalizePopupScalePercent(
      data?.popupWindowScale,
      DEFAULT_SETTINGS.popupWindowScale
    );
    this.settings.mobileDisplay = loadMobileDisplayProfile(data?.mobileDisplay);
    this.settings.enableMermaidEnhancer = data?.enableMermaidEnhancer ?? DEFAULT_SETTINGS.enableMermaidEnhancer;
    this.settings.enableImageZoom = data?.enableImageZoom ?? DEFAULT_SETTINGS.enableImageZoom;
    this.settings.enableHtmlPreview = data?.enableHtmlPreview ?? DEFAULT_SETTINGS.enableHtmlPreview;
    this.settings.enableReadableCustomTags = data?.enableReadableCustomTags ?? DEFAULT_SETTINGS.enableReadableCustomTags;
    this.settings.enableNotionColumns = data?.enableNotionColumns ?? DEFAULT_SETTINGS.enableNotionColumns;
    this.settings.htmlPreviewRules = data?.htmlPreviewRules ?? DEFAULT_SETTINGS.htmlPreviewRules;
    for (const rule of this.settings.htmlPreviewRules) {
      if (!rule.id) rule.id = nextId();
      if (!rule.importId) rule.importId = crypto.randomUUID?.() ?? rule.id;
      if (rule.enabled === undefined) rule.enabled = true;
      if (!rule.flags) rule.flags = "g";
      if (rule.replaceWith === undefined) rule.replaceWith = "";
    }
    for (const r of this.settings.filterRules) {
      if (!r.id) r.id = nextId();
    }
    const storedMobileSwitches = data?.mobileSwitches;
    this.settings.mobileSwitches = storedMobileSwitches && typeof storedMobileSwitches === "object"
      && !Array.isArray(storedMobileSwitches) ? storedMobileSwitches : {};
    this.settings.mobileSwitches = Object.fromEntries(
      Object.entries(this.settings.mobileSwitches).filter(([path]) => !isSharedSwitchPath(path))
    );
    this.needsPlatformSwitchSave = storedMobileSwitches !== undefined
      && JSON.stringify(this.settings.mobileSwitches) !== JSON.stringify(storedMobileSwitches);
    this.desktopSwitchStates = collectSwitchStates(this.settings);
    if (this.isMobile) {
      // Apply before any feature is registered, so startup follows mobile switches.
      this.settings = JSON.parse(JSON.stringify(this.settings)) as SimplePluginSettings;
      applySwitchStates(this.settings, this.settings.mobileSwitches);
      this.settings.mobileSwitches = collectSwitchStates(this.settings);
      this.needsPlatformSwitchSave = JSON.stringify(this.settings.mobileSwitches) !== JSON.stringify(storedMobileSwitches);
    }
  }

  async saveSettings() {
    const saved = this.isMobile ? mobileSettingsForSave(this.settings, this.desktopSwitchStates) : this.settings;
    await this.saveData(saved);
    if (this.isMobile) {
      this.settings.mobileSwitches = saved.mobileSwitches;
      this.desktopSwitchStates = collectSwitchStates(saved);
    }
    this.needsPlatformSwitchSave = false;
  }

  getTemplateFolder(): string { return this.templateFolder; }

  private async readVaultConfig(file: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/${file}`);
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  refreshDiaryViews(): void {
    this.app.workspace.getLeavesOfType(DIARY_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof DiaryView) leaf.view.refresh();
    });
  }

  refreshColorPreviews(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      const editorView = (leaf.view.editor as Editor & {
        cm?: { dispatch: (spec: unknown) => void };
      }).cm;
      editorView?.dispatch({ effects: refreshColorPreview.of() });
      refreshRenderedColorPreviews(leaf.view.containerEl, this.settings.enableColorPreview);
    });
  }

  refreshHtmlPreviews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      const editorView = (leaf.view.editor as Editor & {
        cm?: { dispatch: (spec: unknown) => void };
      }).cm;
      editorView?.dispatch({ effects: refreshHtmlPreview.of() });
      refreshRenderedHtmlPreviews(leaf.view.containerEl, this.settings.enableHtmlPreview, this.settings.htmlPreviewRules);
    }
  }

  applyReadableCustomTagStyles(): void {
    const docs = new Set<Document>([document]);
    this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.getContainer().doc));
    for (const doc of docs) {
      doc.body.classList.toggle("simple-readable-custom-tags", this.settings.enableReadableCustomTags);
      this.decorateCustomTags(doc.body);
    }
  }

  private decorateCustomTags(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>("thinking,think,content,todo,seeds,events").forEach((element) =>
      element.classList.add(`simple-custom-${element.tagName.toLowerCase()}`));
  }

  applyReadableLineWidth(doc: Document = document): void {
    this.readableLineWidthDocuments.add(doc);
    const width = this.isMobile
      ? loadMobileDisplayProfile(this.settings.mobileDisplay).readableLineWidth
      : normalizeReadableLineWidth(this.displaySettings.readableLineWidth);
    if (width) doc.body.style.setProperty("--file-line-width", `${width}px`);
    else doc.body.style.removeProperty("--file-line-width");
  }

  applyImageHeightLimit(): void {
    const height = this.isMobile
      ? loadMobileDisplayProfile(this.settings.mobileDisplay).imageMaxHeight
      : normalizeImageMaxHeight(this.displaySettings.imageMaxHeight);
    this.displaySettings.imageMaxHeight = height;
    document.body.classList.toggle("simple-limit-image-height", height !== "");
    if (height) {
      document.body.style.setProperty("--simple-image-max-height", `${height}px`);
    } else {
      document.body.style.removeProperty("--simple-image-max-height");
    }
  }

  async activateView() {
    await this.activateTemplateFill();
  }

  async activateTemplateFill(input?: string) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
    if (input && leaf?.view instanceof TemplateFillView) leaf.view.setInput(input);
  }

  private registerRenderedPreviewObservers(): void {
    const observers = new Map<MarkdownView, RenderedPreviewObservers>();
    const disconnect = (entry: RenderedPreviewObservers) => {
      entry.color.disconnect();
      entry.html.disconnect();
    };
    const refresh = () => {
      const openViews = new Set<MarkdownView>();
      this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
        if (!(leaf.view instanceof MarkdownView)) return;
        const view = leaf.view;
        const root = view.containerEl;
        openViews.add(view);

        const existing = observers.get(view);
        if (existing?.root === root && root.isConnected) return;
        if (existing) disconnect(existing);
        observers.set(view, {
          root,
          color: observeRenderedColorPreviews(root, () => this.settings.enableColorPreview),
          html: observeRenderedHtmlPreviews(root, () => this.settings.enableHtmlPreview, () => this.settings.htmlPreviewRules),
        });
      });

      for (const [view, entry] of observers) {
        if (openViews.has(view) && entry.root.isConnected) continue;
        disconnect(entry);
        observers.delete(view);
      }
    };
    let queued = false;
    const scheduleRefresh = () => {
      if (queued) return;
      queued = true;
      window.setTimeout(() => {
        queued = false;
        refresh();
      }, 0);
    };

    this.registerEvent(this.app.workspace.on("layout-change", scheduleRefresh));
    this.registerEvent(this.app.workspace.on("active-leaf-change", scheduleRefresh));
    this.app.workspace.onLayoutReady(scheduleRefresh);
    this.register(() => {
      for (const entry of observers.values()) disconnect(entry);
      observers.clear();
    });
  }
}

function normalizeEnhancements(settings: SimplePluginSettings, data: LoadedSettings | null): void {
  const quickCopyLink = {
    ...DEFAULT_SETTINGS.enhancements.quickCopyLink,
    ...data?.enhancements?.quickCopyLink,
  };
  if ((data?.enhancements?.quickCopyLink?.lastMode as string | undefined) === "folder-absolute-path") {
    quickCopyLink.lastMode = "navigator-folder-absolute-path";
  }

  const storedQuickFormat = data?.enhancements?.quickFormat;
  const legacyModes: Record<string, QuickFormatMode> = {
    "callout-summary": "callout-abstract",
    "callout-caution": "callout-warning",
  };
  const storedCalloutColors: Record<string, string> | undefined = storedQuickFormat?.calloutColors;
  const calloutColors = {
    ...DEFAULT_SETTINGS.enhancements.quickFormat.calloutColors,
    ...storedCalloutColors,
  };
  if (!calloutColors.abstract && storedCalloutColors?.summary) calloutColors.abstract = storedCalloutColors.summary;
  if (!calloutColors.warning && storedCalloutColors?.caution) calloutColors.warning = storedCalloutColors.caution;
  const storedVisibleModes = storedQuickFormat?.visibleModes;
  const visibleModes = storedVisibleModes
    ? [...new Set(storedVisibleModes.map((mode) => legacyModes[mode] ?? mode))]
    : [...DEFAULT_SETTINGS.enhancements.quickFormat.visibleModes];
  if (!visibleModes.includes("quote")) visibleModes.push("quote");
  const storedLastMode = storedQuickFormat?.lastMode;

  settings.enhancements = {
    quickCopyLink,
    quickFormat: {
      ...DEFAULT_SETTINGS.enhancements.quickFormat,
      ...storedQuickFormat,
      lastMode: storedLastMode ? legacyModes[storedLastMode] ?? storedLastMode : DEFAULT_SETTINGS.enhancements.quickFormat.lastMode,
      visibleModes,
      headingColors: {
        ...DEFAULT_SETTINGS.enhancements.quickFormat.headingColors,
        ...storedQuickFormat?.headingColors,
      },
      headingSizes: {
        ...DEFAULT_SETTINGS.enhancements.quickFormat.headingSizes,
        ...storedQuickFormat?.headingSizes,
      },
      calloutColors,
      customCallouts: storedQuickFormat?.customCallouts ?? DEFAULT_SETTINGS.enhancements.quickFormat.customCallouts.map((item) => ({ ...item })),
    },
    currentNoteLinkConverter: {
      ...DEFAULT_SETTINGS.enhancements.currentNoteLinkConverter,
      ...data?.enhancements?.currentNoteLinkConverter,
    },
  };
}

function normalizeImageMaxHeight(value: unknown): string {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : DEFAULT_SETTINGS.imageMaxHeight;
  if (!text) return "";
  const height = Math.round(Number(text));
  return Number.isFinite(height) && height > 0 ? String(height) : DEFAULT_SETTINGS.imageMaxHeight;
}

function vaultRelativePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path === "/") return "";
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return "";
  const parts = path.split("/").filter((part) => part && part !== ".");
  return parts.includes("..") ? "" : parts.join("/");
}

function normalizeReadableLineWidth(value: unknown): string {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : DEFAULT_SETTINGS.readableLineWidth;
  if (!text) return "";
  const width = Math.round(Number(text));
  return Number.isFinite(width) && width >= 400 && width <= 2000 ? String(width) : DEFAULT_SETTINGS.readableLineWidth;
}

function normalizeSearchFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((folder): folder is string =>
    typeof folder === "string" && folder.trim().length > 0
  ))];
}

function normalizeDiarySettings(settings: SimplePluginSettings, data: LoadedSettings | null): void {
  settings.diary = Object.assign({}, DEFAULT_SETTINGS.diary, data?.diary);
  settings.diary.dateManagement = {
    anniversaries: {
      ...DEFAULT_SETTINGS.diary.dateManagement.anniversaries,
      ...data?.diary?.dateManagement?.anniversaries,
    },
    nationalHolidays: {
      ...DEFAULT_SETTINGS.diary.dateManagement.nationalHolidays,
      ...data?.diary?.dateManagement?.nationalHolidays,
    },
    companyHolidays: {
      ...DEFAULT_SETTINGS.diary.dateManagement.companyHolidays,
      ...data?.diary?.dateManagement?.companyHolidays,
    },
    reminderWriting: {
      ...DEFAULT_SETTINGS.diary.dateManagement.reminderWriting,
      ...data?.diary?.dateManagement?.reminderWriting,
    },
    holidaySetupReminder: {
      ...DEFAULT_SETTINGS.diary.dateManagement.holidaySetupReminder,
      ...data?.diary?.dateManagement?.holidaySetupReminder,
    },
  };
  settings.diary.reformat = {
    ...DEFAULT_SETTINGS.diary.reformat,
    ...data?.diary?.reformat,
    formatRules: data?.diary?.reformat?.formatRules ?? makeDefaultTextReformatRules(),
  };
  if (!settings.diary.dateManagement.nationalHolidays.enabled && !settings.diary.dateManagement.companyHolidays.enabled) {
    settings.diary.dateManagement.holidaySetupReminder.enabled = false;
  }
  if (!settings.diary.dateManagement.holidaySetupReminder.daysBefore) {
    settings.diary.dateManagement.holidaySetupReminder.daysBefore = 7;
  }
  if (settings.diary.tipsHeading === "小贴士") {
    settings.diary.tipsHeading = "#### 小贴士";
  }
  if (settings.diary.dateManagement.reminderWriting.heading === "小贴士") {
    settings.diary.dateManagement.reminderWriting.heading = "#### 小贴士";
  }
  if (!data?.diary?.anniversaries?.length) {
    settings.diary.anniversaries = makeDefaultAnniversaries();
  }
  const existingAnniversaryNames = new Set(settings.diary.anniversaries.map((item) => item.name));
  for (const anniversary of makeDefaultAnniversaries()) {
    if (!existingAnniversaryNames.has(anniversary.name)) {
      settings.diary.anniversaries.push(anniversary);
    }
  }
  if (!settings.diary.holidaySchedules) settings.diary.holidaySchedules = [];
  if (data?.diary?.holidaySchedules === undefined) {
    settings.diary.holidaySchedules = defaultData.holidaySchedules.map((schedule): HolidaySchedule => ({
      ...schedule,
      version: 1,
      source: "national",
      importedAt: new Date().toISOString(),
      days: schedule.days.map((day) => ({ ...day, status: day.status as DayScheduleStatus })),
    }));
  }
  if (!settings.diary.reformat.formatRules?.length) settings.diary.reformat.formatRules = makeDefaultTextReformatRules();
  for (const rule of settings.diary.reformat.formatRules) {
    if (!rule.id) rule.id = nextId();
    if (rule.enabled === undefined) rule.enabled = true;
    if (!rule.flags) rule.flags = "g";
    if (rule.replaceWith === undefined) rule.replaceWith = "";
  }
  const defaultAnniversaryByName = new Map(makeDefaultAnniversaries().map((anniversary) => [anniversary.name, anniversary]));
  const tagMap = new Map([
    ["传统节日", "传统"],
    ["现代节日", "常用"],
    ["中国现代节日", "常用"],
    ["现代", "常用"],
    ["家庭/关系", "常用"],
    ["家庭", "常用"],
    ["国际节日", "纪念"],
    ["国际", "纪念"],
    ["趣味节日", "纪念"],
    ["职业", "纪念"],
    ["趣味", "纪念"],
    ["公益", "纪念"],
    ["健康", "纪念"],
    ["节气", "纪念"],
  ]);
  for (const anniversary of settings.diary.anniversaries) {
    if (!anniversary.id) anniversary.id = nextId();
    if (!anniversary.tags) anniversary.tags = [];
    anniversary.tags = Array.from(new Set(anniversary.tags.map((tag) => tagMap.get(tag) ?? tag)));
    const defaultAnniversary = defaultAnniversaryByName.get(anniversary.name);
    if (defaultAnniversary) {
      anniversary.tags = defaultAnniversary.tags;
      anniversary.showInCalendar = defaultAnniversary.showInCalendar;
      anniversary.reminderEnabled = defaultAnniversary.reminderEnabled;
      anniversary.sameDayReminderEnabled = defaultAnniversary.sameDayReminderEnabled;
      anniversary.advanceReminderEnabled = defaultAnniversary.advanceReminderEnabled;
      anniversary.reminderDaysBefore = defaultAnniversary.reminderDaysBefore;
      if (anniversary.dateType !== defaultAnniversary.dateType) anniversary.dateType = defaultAnniversary.dateType;
      anniversary.month = defaultAnniversary.month;
      anniversary.day = defaultAnniversary.day;
      anniversary.lunarMonth = defaultAnniversary.lunarMonth;
      anniversary.lunarDay = defaultAnniversary.lunarDay;
      anniversary.weekdayRule = defaultAnniversary.weekdayRule ? { ...defaultAnniversary.weekdayRule } : undefined;
    }
    if (anniversary.showInCalendar === undefined) anniversary.showInCalendar = anniversary.enabled;
    anniversary.outputFormat = "task";
    if (anniversary.reminderEnabled === undefined) anniversary.reminderEnabled = false;
    if (anniversary.sameDayReminderEnabled === undefined) anniversary.sameDayReminderEnabled = anniversary.reminderEnabled;
    if (anniversary.advanceReminderEnabled === undefined) anniversary.advanceReminderEnabled = anniversary.reminderEnabled && (anniversary.reminderDaysBefore ?? 0) > 0;
    anniversary.reminderEnabled = Boolean(anniversary.sameDayReminderEnabled || anniversary.advanceReminderEnabled);
    if (anniversary.advanceReminderEnabled && !anniversary.reminderDaysBefore) anniversary.reminderDaysBefore = 7;
    if (anniversary.reminderDaysBefore === undefined) anniversary.reminderDaysBefore = 0;
    anniversary.reminderText = "";
  }
  for (const rule of settings.diary.recurringRules) {
    if (!rule.id) rule.id = nextId();
    rule.outputFormat = "task";
    rule.advanceContinuous = false;
    if (!rule.advanceEnabled && (!rule.advanceDays || rule.advanceDays === 7)) rule.advanceDays = 3;
    if (rule.advanceEnabled && !rule.advanceDays) rule.advanceDays = 3;
    rule.advanceText = "";
  }
  for (const schedule of settings.diary.holidaySchedules) {
    if (!schedule.id) schedule.id = nextId();
    if (schedule.enabled === undefined) schedule.enabled = true;
    if (!schedule.importedAt) schedule.importedAt = new Date().toISOString();
    if (!schedule.days) schedule.days = [];
  }
}

function normalizeTemplateCategories(settings: SimplePluginSettings, data: LoadedSettings | null): void {
  if (!data?.templateCategories) {
    const oldRules = data?.templateRules;
    if (oldRules && oldRules.length) {
      settings.templateCategories = oldRules.map((rule) => ({
        id: rule.id || nextId(),
        name: rule.name || "",
        outputFolder: rule.outputFolder || "",
        filenameField: rule.filenameField || "",
        siteRules: [{ id: nextId(), urlPattern: rule.urlPattern || "", fields: [] }],
      }));
    } else {
      settings.templateCategories = defaultTemplateCategories();
    }
  }
  for (const cat of settings.templateCategories) {
    if (!cat.id) cat.id = nextId();
    if (!cat.icon) cat.icon = defaultCategoryIcon(cat.name);
    if (!cat.noteFormat) cat.noteFormat = defaultCategoryNoteFormat(cat.name);
    if (!cat.siteRules) cat.siteRules = [];
    if (!cat.filenameField) {
      const firstField = cat.siteRules?.find(sr => sr.fields?.length > 0)?.fields[0];
      cat.filenameField = firstField?.fieldName || "";
    }
    for (const sr of cat.siteRules) {
      if (!sr.id) sr.id = nextId();
      if (!sr.name) sr.name = defaultSiteName(sr.urlPattern);
      if (!sr.shortName) sr.shortName = defaultSiteShortName(sr.urlPattern);
      if (!sr.handler) sr.handler = defaultSiteHandler(sr);
      applyDefaultSitePipeline(sr);
      if (!sr.fields) sr.fields = [];
      for (const f of sr.fields) {
        if (!f.id) f.id = nextId();
        if (!f.page) f.page = defaultFieldPage(sr.urlPattern);
      }
    }
  }
}

function defaultCategoryIcon(name: string): string {
  if (name === "Agent Skills") return "bot";
  if (name === "网文书评") return "book-open";
  return "";
}

function defaultCategoryNoteFormat(name: string): string {
  if (name === "Agent Skills") {
    return "---\n网址: {{网址}}\n仓库来源: {{仓库来源}}\n简介: {{简介}}\n---\n\n# {{技能名称}}\n\n{{正文}}\n";
  }
  return "";
}

function defaultSiteName(urlPattern: string): string {
  if (/skills/i.test(urlPattern)) return "Agent Skills 网站";
  if (/jjwxc/i.test(urlPattern)) return "晋江";
  if (/52shuku/i.test(urlPattern)) return "52书库";
  return "";
}

function defaultSiteShortName(urlPattern: string): string {
  if (/skills/i.test(urlPattern)) return "Skills";
  if (/jjwxc/i.test(urlPattern)) return "晋江";
  if (/52shuku/i.test(urlPattern)) return "52书库";
  return "";
}

function defaultSiteHandler(siteRule: { urlPattern: string; search?: { type?: string } }): string {
  if (/qidian/i.test(siteRule.urlPattern)) return "qidianBook";
  if (/fanqienovel/i.test(siteRule.urlPattern) || siteRule.search?.type === "fanqieApi") return "fanqieNovel";
  return "";
}

function applyDefaultSitePipeline(siteRule: {
  urlPattern: string;
  input?: unknown;
  pages?: unknown[];
}): void {
  if (/qidian/i.test(siteRule.urlPattern)) {
    if (!siteRule.input) {
      siteRule.input = {
        baseUrl: {
          type: "urlReplace",
          regex: "^https?://(?:www\\.qidian\\.com/book/|book\\.qidian\\.com/info/|m\\.qidian\\.com/book/)(\\d+)/?.*$",
          replaceWith: "https://www.qidian.com/book/$1/",
        },
      };
    }
    if (!siteRule.pages?.length) siteRule.pages = [{ id: "main", url: "{{baseUrl}}" }];
    if (!siteRule.pages.some((page) => (page as { id?: string }).id === "mobile")) {
      siteRule.pages.push({
        id: "mobile",
        urlFrom: {
          type: "urlReplace",
          page: "base",
          regex: "^https?://www\\.qidian\\.com/book/(\\d+)/?.*$",
          replaceWith: "https://m.qidian.com/book/$1/",
        },
      });
    }
    return;
  }

  if (!/52shuku/i.test(siteRule.urlPattern)) return;
  if (!siteRule.input) {
    siteRule.input = {
      baseUrl: {
        type: "urlReplace",
        regex: "_\\d+\\.html$",
        replaceWith: ".html",
      },
    };
  }
  if (!siteRule.pages?.length) {
    siteRule.pages = [
      { id: "main", url: "{{baseUrl}}" },
      {
        id: "read",
        urlFrom: {
          type: "urlReplace",
          page: "main",
          regex: "\\.html$",
          replaceWith: "_2.html",
        },
      },
    ];
  }
}

function defaultFieldPage(urlPattern: string): string {
  if (/52shuku/i.test(urlPattern)) return "read";
  return "";
}
