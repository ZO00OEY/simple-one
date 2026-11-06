import { tooltipText, setNativeTooltip } from "./shared/tooltipText";
import { CHINESE_FONTS, LATIN_FONTS, updateFontDownload } from "./shared/fontOptions";
import { nativeCheckbox } from "./shared/nativeCheckbox";
import { createActionButton, setDeleteIcon, setActionIcon, styleActionFooter, styleActionButton } from "./shared/actionButton";
import { checkboxRow, checkboxRowIcon } from "./shared/checkboxRow";
import { settingsFieldset, settingsGroup, settingsHeading } from "./shared/settingsLayout";
import { DiaryPathSuggest } from "./features/diaryPathSuggest";
import { SyncSettingsTab } from "./features/sync";
import { runAsync } from "./shared/async";
import { confirmAction } from "./shared/confirm";
import { TranslationSettingsModal } from "./features/selectionTranslation";
import { ThemeColorPicker } from "./shared/themeColorPicker";
// ============================================================
// Settings tab UI
// ============================================================
import { App, Menu, Modal, Notice, PluginSettingTab, Setting, TFolder, requireApiVersion, setIcon, type SettingDefinitionItem } from "obsidian";
import type SimplePlugin from "./main";
import { TYPOGRAPHY_DEFAULTS, TYPOGRAPHY_RANGES } from "./shared/typography";
import {
  checkUnusedAttachments,
  DEFAULT_ATTACHMENT_FOLDER,
  describeAttachmentLocation,
  planAttachmentImageRename,
  planAttachmentOrganization,
  planInlineImageExtraction,
  readObsidianAttachmentLocation,
} from "./features/attachmentOrganizer";
import { REFORMAT_ICON, REFORMAT_NAME } from "./features/currentNoteLinkConverter";
import { ReformatRuleModal } from "./features/reformatRuleModal";
import { makeRuleRegex } from "./features/htmlPreview";
import { modeIcon as quickCopyModeIcon } from "./features/quickCopyLink";
import { TEMPLATE_FILL_ICON } from "./features/templateFillAction";
import { templateRuleCreationPrompt } from "./features/templateRuleGuide";
import { TemplateCreateModal, templatePropertyNames } from "./features/templateCreateModal";
import { checkTemplateSiteRule } from "./features/templateRuleCheck";
import { testTemplateSiteRule } from "./features/templateFill";
import { importTemplateGroup, mergeSiteImports, mergeTemplateImports, type ImportCounts } from "./features/templateImportMerge";
import { getNotebookNavigatorPlugin } from "./features/diary";
import { applyQuickFormatStyles, repairHeadingFontSizes, quickFormatIconColor, QUICK_FORMAT_ICON, QUICK_FORMAT_NAME } from "./features/quickFormat";
import { setFormatIcon } from "./shared/formatIcon";
import { openSearchFolderPicker } from "./features/searchFolderFilter";
import { POPUP_SCALE_MAX } from "./shared/popupSizing";
import { displayParameterEnabled } from "./shared/displayProfile";
import { readCalloutColorHex } from "./shared/calloutColor";
import { columnsHotkeyConflicts, commandHotkeyLabel, currentColumnsHotkey, parseCommandHotkey, saveColumnsHotkey } from "./shared/commandHotkey";
import {
  BUILT_IN_TEXT_REFORMAT_RULE_IDS,
  makeHtmlPreviewRule,
  makeFilterRule,
  makeRecurringRule,
  makeTextReformatRule,
  nextId,
  QUICK_FORMAT_CALLOUTS,
  type Anniversary,
  type DayScheduleItem,
  type DayScheduleStatus,
  type HolidaySchedule,
  type HolidaySource,
  type HtmlPreviewRule,
  type DisplayParameter,
  type QuickFormatCustomCallout,
  type QuickFormatHeadingLevel,
  type QuickFormatMode,
  type RecurringRule,
  type SiteRule,
  type TemplateCategory,
} from "./types";

type AttachmentOrganizerDisabledReasons = {
  unused: string | null;
  imageRename: string | null;
  organization: string | null;
  inlineExtraction: string | null;
};

function attachmentOrganizerDisabledReasons(
  mode: ReturnType<typeof readObsidianAttachmentLocation>["mode"]
): AttachmentOrganizerDisabledReasons {
  const enabled: AttachmentOrganizerDisabledReasons = {
    unused: null,
    imageRename: null,
    organization: null,
    inlineExtraction: null,
  };

  if (mode === "fixed-folder") return enabled;
  if (mode === "same-folder") {
    return {
      unused: "插件无法区分附件与用户存放在同一目录内的图片、PDF、JSON 等普通文件，强行扫描可能造成误删。",
      imageRename: null,
      organization: "附件已经与笔记存放在同一目录；继续按笔记归位会破坏当前附件模式的存放规则。",
      inlineExtraction: null,
    };
  }
  if (mode === "current-subfolder") {
    return {
      unused: "附件目录会随笔记位置变化，插件无法可靠覆盖已删除或移动笔记遗留的所有子目录；为避免漏检或误删，暂不提供清理。",
      imageRename: null,
      organization: null,
      inlineExtraction: null,
    };
  }

  const rootReason = "当前附件位置为 Vault 根目录，扫描或整理可能影响普通笔记和资源文件，已禁用。";
  const unknownReason = "无法识别当前附件存放模式，为避免误处理文件，已禁用。";
  const reason = mode === "vault-root" ? rootReason : unknownReason;
  return {
    unused: reason,
    imageRename: reason,
    organization: reason,
    inlineExtraction: reason,
  };
}

type SettingsPage = { type:
  | "overview"
  | "html-preview"
  | "link-rules"
  | "template-rules"
  | "automatic-reformat"
  | "calendar-diary"
  | "date-management"
  | "holiday-national"
  | "holiday-company"
};

type HolidayScheduleGroup = {
  title: string;
  days: DayScheduleItem[];
};

type HolidayComparison = {
  nationalDays: Map<string, DayScheduleItem>;
  differenceDates: Set<string>;
};

const QUICK_FORMAT_HEADING_LABELS: Record<QuickFormatHeadingLevel, string> = {
  h1: "一级标题",
  h2: "二级标题",
  h3: "三级标题",
  h4: "四级标题",
  h5: "五级标题",
  h6: "六级标题",
};

function renderedColorHex(color: string): string {
  const canvas = createEl("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return "#808080";
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  return rgbTripletToHex(channels.join(","));
}

function readRenderedFormatColor(
  tag: "strong" | "em" | "mark" | "del" | "span" | "u",
  property: "color" | "backgroundColor"
): string {
  const sample = document.body.createDiv({
    cls: "markdown-rendered markdown-preview-view simple-format-color-sample",
  });
  const element = sample.createEl(tag, { text: "格式预览" });
  const color = getComputedStyle(element)[property];
  sample.remove();

  return renderedColorHex(color);
}

export class SimpleSettingTab extends PluginSettingTab {
  private refreshingThemeColor = false;

  private setThemeColor(picker: ThemeColorPicker, value: string): void {
    this.refreshingThemeColor = true;
    try { picker.setValue(value); } finally { this.refreshingThemeColor = false; }
  }
  private themeControlRefreshers: { element: HTMLElement; refresh: () => void }[] = [];

  private watchThemeControl(element: HTMLElement, refresh: () => void): void {
    this.themeControlRefreshers = this.themeControlRefreshers.filter(control => control.element.isConnected);
    this.themeControlRefreshers.push({ element, refresh });
    refresh();
  }

  private updateThemeReset(reset: HTMLButtonElement, customized: boolean): void {
    reset.disabled = !customized;
    reset.setAttribute("aria-label", customized ? "已自定义，点击恢复当前主题" : "跟随当前主题");
  }
  plugin: SimplePlugin;
  private syncTab: SyncSettingsTab;
  private page: SettingsPage = { type: "overview" };
  private holidayYearFilter: Partial<Record<HolidaySource, number | "all">> = {};
  private displayPreviewTab: string;
  private syncNavigationTab?: string;
  private editingCustomCalloutIds = new Set<string>();
  private anniversaryTagFilter = "常用";
  private expandedHolidaySchedules = new Set<string>();

  constructor(app: App, plugin: SimplePlugin) {
    super(app, plugin);
    this.plugin = plugin;
    plugin.registerEvent(app.workspace.on("css-change", () => {
      this.themeControlRefreshers = this.themeControlRefreshers.filter(control => control.element.isConnected);
      for (const control of this.themeControlRefreshers) control.refresh();
    }));
    this.displayPreviewTab = plugin.settings.lastSettingsTab ?? "";
    this.syncTab = new SyncSettingsTab(app, plugin.sync);
    plugin.openReformatSettings = () => {
      const appWithSettings = app as App & {
        setting: { open(): void; openTabById(id: string): void };
      };
      appWithSettings.setting.open();
      appWithSettings.setting.openTabById(plugin.manifest.id);
      this.openPage({ type: "automatic-reformat" });
    };
    plugin.openAISettings = () => {
      this.displayPreviewTab = "ai";
      const settings = (app as App & { setting: { open(): void; openTabById(id: string): void } }).setting;
      settings.open(); settings.openTabById(plugin.manifest.id);
      this.openPage({ type: "overview" });
    };
    plugin.sync.openSettings = (share = false) => {
      this.displayPreviewTab = share ? "sharing" : "sync-sharing";
      this.syncNavigationTab = this.displayPreviewTab;
      this.syncTab.resetNavigation(share);
      this.openPage({ type: "overview" });
    };
  }

  private diaryPathSuggestions: DiaryPathSuggest[] = [];

  hide(): void {
    this.plugin.ai?.hideSettings();
    this.diaryPathSuggestions.forEach(suggest => suggest.close());
    this.diaryPathSuggestions = [];
    this.syncTab.hide();
  }

  display(): void { this.renderSettings(); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { type: "group", cls: "simple-settings simple-inline-display-group", items: [{
        name: "显示与主题", render: (setting: Setting) => {
          // Native settings reuse groups by position when conditional entries disappear.
          const group = setting.settingEl.closest(".setting-group");
          group?.classList.remove("simple-native-overview");
          group?.classList.add("simple-settings", "simple-inline-display-group");
          setting.settingEl.empty();
          setting.settingEl.removeClass("setting-item");
          const content = setting.settingEl.createDiv({ cls: "simple-settings" });
          this.renderDisplayPreviewSettings(content, false);
        },
      }] },
    ];
  }

  getControlValue(key: string): unknown {
    return key === "quickCopyLink" && !this.plugin.isMobile && this.plugin.settings.enhancements.quickCopyLink.enabled;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key !== "quickCopyLink" || typeof value !== "boolean" || this.plugin.isMobile) return;
    this.plugin.settings.enhancements.quickCopyLink.enabled = value;
    await this.plugin.saveSettings();
  }

  private renderSettings(): void {
    this.diaryPathSuggestions.forEach(suggest => suggest.close());
    this.diaryPathSuggestions = [];
    if (requireApiVersion("1.13.0") && this.page.type === "overview") {
      this.openPage({ type: "overview" });
      return;
    }
    const { containerEl } = this;
    this.syncTab.hide();
    containerEl.empty();
    this.plugin.ai?.hideSettings();
    containerEl.addClass("simple-settings");

    if (this.page.type === "overview") {
      this.renderOverview(containerEl);
    } else if (this.page.type === "html-preview") {
      this.renderHtmlPreviewSettings(containerEl);
    } else if (this.page.type === "link-rules") {
      this.renderLinkRules(containerEl);
    } else if (this.page.type === "template-rules") {
      this.renderTemplateRules(containerEl);
    } else if (this.page.type === "automatic-reformat") {
      this.renderPageHeader(containerEl, "自动排版设置", () => {
        this.displayPreviewTab = "shortcuts";
        this.openPage({ type: "overview" });
      });
      this.renderInlineReformatSettings(containerEl, true);
    } else if (this.page.type === "date-management") {
      this.renderDateManagementSettings(containerEl);
    } else if (this.page.type === "holiday-national" || this.page.type === "holiday-company") {
      this.renderHolidaySourceSettings(containerEl, this.page.type === "holiday-national" ? "national" : "company");
    }
  }

  private renderOverview(container: HTMLElement): void {
    for (const group of this.getSettingDefinitions()) {
      if (!("type" in group) || group.type !== "group") continue;
      settingsGroup(container, group.heading ?? "", (card) => {
        for (const [index, item] of (group.items ?? []).entries()) {
          if (item.name === "显示与预览") continue;
          if ("render" in item && item.render) {
            (item.render as (setting: Setting) => void)(new Setting(card));
          } else if ("action" in item && item.action) {
            const action = item.action;
            const icon = item.name === QUICK_FORMAT_NAME ? QUICK_FORMAT_ICON : item.name === REFORMAT_NAME ? REFORMAT_ICON : "chevron-right";
            this.renderNavigationItem(card, item.name, typeof item.desc === "string" ? item.desc : item.desc?.textContent ?? "", () => action(card, index), icon);
          } else if ("control" in item && item.control?.type === "toggle") {
            const key = item.control.key;
            new Setting(card).setName(item.name).setDesc(item.desc ?? "").addToggle((toggle) =>
          nativeCheckbox(toggle).setValue(Boolean(this.getControlValue(key))).setDisabled(this.plugin.isMobile)
                .onChange((value) => this.setControlValue(key, value)));
          }
        }
      });
    }
  }

  private renderOverviewInlineSettings(
    container: HTMLElement,
  ): void {
    const shortcuts = settingsFieldset(container, "快捷功能");
    const formatRow = this.renderDisplayCheckbox(shortcuts, "浮动工具栏", "启用快捷功能，并在编辑区顶部显示 H 入口。",
      this.plugin.settings.enhancements.quickFormat.enabled && (this.plugin.isMobile ? this.plugin.settings.enhancements.quickFormat.showMobileEntry : this.plugin.settings.enhancements.quickFormat.showDesktopEntry), async value => {
        this.plugin.settings.enhancements.quickFormat.enabled = value;
        this.plugin.settings.enhancements.quickFormat.selectionToolbar = value;
        this.plugin.settings.enhancements.quickFormat.showDesktopEntry = value;
        this.plugin.settings.enhancements.quickFormat.showMobileEntry = value;
        await this.plugin.saveSettings();
        this.plugin.refreshQuickFormatActions();
      });
    formatRow.addClass("simple-shortcut-option");
    checkboxRowIcon(formatRow, QUICK_FORMAT_ICON);
    const formatIcon = formatRow.querySelector<HTMLElement>(".simple-checkbox-icon");
    if (formatIcon) formatIcon.style.color = quickFormatIconColor(this.plugin);
    const automaticRow = this.renderDisplayCheckbox(shortcuts, "自动排版", "启用自动排版及其快捷操作。",
      this.plugin.settings.enhancements.currentNoteLinkConverter.enabled, async value => {
        this.plugin.settings.enhancements.currentNoteLinkConverter.enabled = value;
        await this.plugin.saveSettings();
        this.plugin.refreshReformatActions();
      });
    automaticRow.addClass("simple-reformat-option");
    const automaticManage = automaticRow.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": "自动排版设置" } });
    setActionIcon(automaticManage, "settings", "bordered");
    automaticManage.addEventListener("click", () => this.openPage({ type: "automatic-reformat" }));
    checkboxRowIcon(automaticRow, REFORMAT_ICON);
    const templateRow = this.renderDisplayCheckbox(shortcuts, "快速新建笔记", "启用快速新建笔记及其快捷按钮。",
      this.plugin.settings.enableTemplateFill, async value => {
        this.plugin.settings.enableTemplateFill = value;
        await this.plugin.saveSettings();
        this.plugin.refreshTemplateFillActions();
      });
    templateRow.addClass("simple-shortcut-option");
    templateRow.addClass("simple-reformat-option");
    const templateManage = templateRow.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": "快速新建笔记设置" } });
    setActionIcon(templateManage, "settings", "bordered");
    templateManage.addEventListener("click", () => this.openPage({ type: "template-rules" }));
    checkboxRowIcon(templateRow, TEMPLATE_FILL_ICON);
    const copyRow = this.renderDisplayCheckbox(shortcuts, "复制当前笔记链接", "点击复制；电脑右键或手机长按选择复制类型。",
      this.plugin.settings.enhancements.quickCopyLink.enabled, async value => {
        this.plugin.settings.enhancements.quickCopyLink.enabled = value;
        await this.plugin.saveSettings();
        this.plugin.refreshQuickCopyLinkActions();
      });
    copyRow.addClass("simple-shortcut-option");
    checkboxRowIcon(copyRow, quickCopyModeIcon(this.plugin.settings.enhancements.quickCopyLink.lastMode));
  }

  private renderInlineReformatSettings(container: HTMLElement, framed = false): void {
    const reformat = this.plugin.settings.diary.reformat;
    const group = framed
      ? settingsFieldset(container, "自动排版设置")
      : container.createDiv({ cls: "simple-reformat-expanded-settings" });
    group.addClass("simple-reformat-settings-group");
    this.renderDisplayCheckbox(group, "将 URL 处理为超链接", "自动排版时处理文本中的 URL。",
      reformat.runLinkConversion, async value => {
        reformat.runLinkConversion = value;
        await this.plugin.saveSettings();
      });
    this.renderDisplayCheckbox(group, "粘贴时自动排版", "按启用的规则处理粘贴文本，不重排原有正文。",
      reformat.autoReformatAfterPaste, async value => {
        reformat.autoReformatAfterPaste = value;
        await this.plugin.saveSettings();
      });
    this.renderDisplayCheckbox(group, "文本排版", "按顺序执行已勾选的排版规则。",
      reformat.runFormatReflow, async value => {
        reformat.runFormatReflow = value;
        await this.plugin.saveSettings();
      });
    for (const rule of reformat.formatRules) {
      const row = this.renderDisplayCheckbox(group, rule.name, `/${rule.pattern}/${rule.flags}`,
        rule.enabled, async value => {
          rule.enabled = value;
          await this.plugin.saveSettings();
        });
      row.addClass("simple-reformat-option");
      const edit = createActionButton(row, "pencil", `编辑${rule.name}`);
      edit.addEventListener("click", () => new ReformatRuleModal(this.app, rule, async updated => {
        Object.assign(rule, updated);
        await this.plugin.saveSettings();
        container.empty();
        this.renderInlineReformatSettings(container, framed);
      }).open());
      if (!BUILT_IN_TEXT_REFORMAT_RULE_IDS.has(rule.id)) {
        const remove = createActionButton(row, "trash-2", `删除${rule.name}`);
        remove.addEventListener("click", runAsync(async () => {
          reformat.formatRules = reformat.formatRules.filter(item => item.id !== rule.id);
          await this.plugin.saveSettings();
          container.empty();
          this.renderInlineReformatSettings(container, framed);
        }));
      }
    }
    const footer = group.createDiv({ cls: "simple-reformat-rule-footer" });
    const add = createActionButton(footer, "plus", "增加排版规则", "bordered");
    add.addClass("simple-template-source-add");
    add.addEventListener("click", () => new ReformatRuleModal(this.app, makeTextReformatRule(), async rule => {
      reformat.formatRules.push(rule);
      await this.plugin.saveSettings();
      container.empty();
      this.renderInlineReformatSettings(container, framed);
    }).open());
    const disabled = !this.plugin.settings.enhancements.currentNoteLinkConverter.enabled;
    group.toggleClass("simple-dependent-disabled", disabled);
    group.setAttribute("aria-disabled", String(disabled));
    group.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => {
      control.disabled = disabled;
    });
  }

  private renderEditingOptimizationSettings(container: HTMLElement): void {
    const basic = settingsFieldset(container, "编辑优化");
    const translationRow = this.renderDisplayCheckbox(basic, "在浮动工具栏中启用 AI 翻译",
      "控制浮动工具栏中的翻译入口；右侧设置模型、语言和提示词。",
      this.plugin.settings.enhancements.quickFormat.selectionTranslation !== false, async value => {
        this.plugin.settings.enhancements.quickFormat.selectionTranslation = value;
        await this.plugin.saveSettings();
        this.plugin.refreshQuickFormatActions();
      });
    translationRow.addClass("simple-reformat-option");
    const translationSettings = translationRow.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": "AI 翻译设置" } });
    setActionIcon(translationSettings, "settings", "bordered");
    translationSettings.addEventListener("click", () => new TranslationSettingsModal(this.plugin).open());
    this.renderDisplayCheckbox(basic, "新建笔记自动补全属性", "沿用现有规则，按当前目录关联的 Obsidian 数据库视图自动补全属性。",
      this.plugin.settings.newNoteDefaults.enabled, async value => {
        this.plugin.settings.newNoteDefaults.enabled = value;
        await this.plugin.saveSettings();
      });
    const replacementRow = this.renderDisplayCheckbox(basic, "文本显示替换", "仅改变显示效果，不修改笔记原文。",
      this.plugin.settings.enableTextDisplayReplacement, async value => {
        this.plugin.settings.enableTextDisplayReplacement = value;
        await this.plugin.saveSettings();
        this.plugin.refreshHtmlPreviews();
      });
    replacementRow.addClass("simple-reformat-option");
    const replacementManage = replacementRow.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": "文本显示替换设置" } });
    setActionIcon(replacementManage, "settings", "bordered");
    replacementManage.addEventListener("click", () => this.openPage({ type: "html-preview" }));
    this.renderDisplayCheckbox(basic, "全库标签批量重命名",
      "在笔记属性的 tags 标签栏中，右键点击某个标签，选择“在全库中重命名此标签…”。同时更新属性、正文及子标签；目标标签已存在时需确认合并。",
      this.plugin.settings.enableVaultTagRename, async value => {
        this.plugin.settings.enableVaultTagRename = value;
        await this.plugin.saveSettings();
      });
  }

  private renderBasicOptimizationSettings(container: HTMLElement): void {
    const extensions = settingsFieldset(container, "功能拓展");
    for (const [key, name] of [["showSyncSharingEntry", "同步"], ["showSharingEntry", "分享"], ["showCalendarDiaryEntry", "日程"]] as const) {
      const row = this.renderDisplayCheckbox(extensions, name, key === "showCalendarDiaryEntry" ? "在设置首页显示日程标签页。" : "在设置首页显示此入口。", this.plugin.settings[key], async value => {
        this.plugin.settings[key] = value;
        await this.plugin.saveSettings();
        this.renderSettings();
      });
      checkboxRowIcon(row, key === "showSyncSharingEntry" ? "refresh-cw" : key === "showSharingEntry" ? "share-2" : "calendar-days");
    }
    const aiRow = this.renderDisplayCheckbox(extensions, "AI", "显示 AI 标签页并启用聊天和后台任务；关闭后仍可使用选区翻译。", this.plugin.settings.enableAI, async value => {
      await this.plugin.ai.setEnabled(value);
      this.renderSettings();
    });
    checkboxRowIcon(aiRow, "bot");

    const search = settingsFieldset(container, "搜索增强");
    const config = this.plugin.settings.searchFolders;
    for (const [key, foldersKey, name] of [
      ["includeEnabled", "includeFolders", "仅搜索所选文件夹"],
      ["excludeEnabled", "excludeFolders", "屏蔽所选文件夹"],
    ] as const) {
      const row = this.renderDisplayCheckbox(search, name, "", config[key] !== false, async value => {
        config[key] = value;
        await this.plugin.saveSettings();
        this.plugin.refreshSearchFolderControls();
      });
      row.addClass("simple-search-filter-option");
      const choose = styleActionButton(row.createEl("button", {
        cls: "clickable-icon simple-attachment-action",
        attr: { type: "button", "aria-label": name + "：选择文件夹" },
      }), "bordered");
      setIcon(choose, "settings-2");
      choose.setAttribute("aria-label", "选择文件夹");
      choose.addEventListener("click", () => {
        openSearchFolderPicker(this.plugin, config[foldersKey], async folders => {
          config[foldersKey] = folders;
          await this.plugin.saveSettings();
          this.plugin.refreshSearchFolderControls();
        }, name);
      });
    }
    this.renderAttachmentOrganizerSettings(container);
  }

  private renderDisplayCheckbox(
    parent: HTMLElement, name: string, desc: string, checked: boolean,
    onChange: (value: boolean) => Promise<void>
  ): HTMLElement {
    const { row, input: checkbox } = checkboxRow(parent, name, desc, checked);
    checkbox.addEventListener("change", runAsync(async () => onChange(checkbox.checked)));
    return row;
  }

  private renderDisplayParameter(
    parent: HTMLElement, mobile: boolean, key: DisplayParameter, name: string, desc: string,
    value: string, fallback: string, min: number, max: number, step: number, unit: string,
    setValue: (value: string) => void
  ): void {
    if (!mobile && key === "letterSpacing") {
      this.renderLetterSpacing(parent);
      this.renderLetterSpacing(parent, true);
      return;
    }
    const enabled = displayParameterEnabled(this.plugin.settings, mobile, key);
    const save = async (): Promise<void> => {
      await this.plugin.saveSettings();
      this.plugin.applyReadableLineWidth();
      this.plugin.applyImageHeightLimit();
      this.plugin.applyMobileHeaderButtons();
      this.plugin.refreshTypography();
      if (key === "fontSize") parent.dispatchEvent(new Event("simple-font-size-change"));
    };
    const row = this.renderDisplayCheckbox(parent, name, desc, enabled, async checked => {
      this.plugin.settings.displayParameterSwitches[mobile ? "mobile" : "desktop"][key] = checked;
      if (checked && (!input.value || !Number.isFinite(Number(input.value)) || Number(input.value) < min || Number(input.value) > max)) {
        input.value = fallback;
        setValue(fallback);
        input.setCustomValidity("");
      }
      input.disabled = !checked;
      await save();
    });
    row.addClass("simple-display-parameter-row");
    const input = row.createEl("input", { type: "number", cls: "simple-display-parameter-input", attr: {
      "aria-label": `${mobile ? "手机端" : "电脑端"}${name}`, min: String(min), max: String(max), step: String(step),
    } });
    input.value = value;
    input.placeholder = fallback;
    input.disabled = !enabled;
    row.createSpan({ text: unit, cls: "simple-display-parameter-unit" });
    input.addEventListener("change", runAsync(async () => {
      const number = Number(input.value);
      const valid = input.value.trim() !== "" && Number.isFinite(number) && number >= min && number <= max;
      input.setCustomValidity(valid ? "" : `请输入 ${min}–${max} 范围内的数值`);
      if (!valid) { input.reportValidity(); return; }
      setValue(String(number));
      await save();
    }));
  }

  private renderLetterSpacing(parent: HTMLElement, latin = false): void {
    const settings = this.plugin.settings;
    const spacingKey = latin ? "latinLetterSpacing" : "letterSpacing";
    const name = latin ? "英文字间距" : "中文字间距";
    let unit: "px" | "em" = "em";
    const fontSize = (): number => {
      if (displayParameterEnabled(settings, false, "fontSize")) return settings.desktopTypography.fontSize;
      const editor = parent.ownerDocument.querySelector<HTMLElement>('.workspace-leaf.mod-active .cm-scroller, .workspace-leaf.mod-active .markdown-preview-view, .cm-scroller, .markdown-preview-view');
      const size = editor ? parseFloat(getComputedStyle(editor).fontSize) : parseFloat(getComputedStyle(parent.ownerDocument.body).getPropertyValue("--font-text-size"));
      return Number.isFinite(size) && size > 0 ? size : settings.desktopTypography.fontSize;
    };
    const enabled = (): boolean => latin ? settings.desktopTypography.latinLetterSpacingEnabled !== false : displayParameterEnabled(settings, false, "letterSpacing");
    const save = async (): Promise<void> => {
      settings.desktopTypography.letterSpacingUnit = "em";
      await this.plugin.saveSettings();
      this.plugin.refreshTypography();
    };
    const row = this.renderDisplayCheckbox(parent, name, latin
      ? "用于英文、数字和半角标点（如 , . ! ?）；中文及中文标点使用中文字间距。点击单位切换 em/px，实际间距不变。"
      : "用于中文及中文标点（如 ，。！？）；英文、数字和半角标点使用英文字间距。点击单位切换 em/px，实际间距不变。", enabled(), async checked => {
      if (latin) settings.desktopTypography.latinLetterSpacingEnabled = checked;
      else settings.displayParameterSwitches.desktop.letterSpacing = checked;
      input.disabled = !checked;
      await save();
    });
    row.addClass("simple-display-parameter-row", "simple-letter-spacing-row");
    const input = row.createEl("input", { type: "number", cls: "simple-display-parameter-input", attr: { "aria-label": name } });
    const label = row.createEl("button", { cls: "simple-display-parameter-unit", attr: { type: "button", "aria-label": tooltipText("切换字间距 em/px", "点击切换 em / px，保持实际字间距") } });
    const refresh = (): void => {
      const scale = unit === "px" ? fontSize() : 1;
      input.value = String(Number(((settings.desktopTypography[spacingKey] ?? 0) * scale).toFixed(6)));
      input.min = String(-0.05 * scale);
      input.max = String(0.2 * scale);
      input.step = "any";
      input.disabled = !enabled();
      input.setCustomValidity("");
      label.setText(unit);
    };
    label.addEventListener("click", () => { unit = unit === "px" ? "em" : "px"; refresh(); });
    parent.addEventListener("simple-font-size-change", refresh);
    parent.addEventListener("simple-font-change", refresh);
    input.addEventListener("change", runAsync(async () => {
      const ratio = Number(input.value) / (unit === "px" ? fontSize() : 1);
      const valid = input.value.trim() !== "" && Number.isFinite(ratio) && ratio >= -0.05 && ratio <= 0.2;
      input.setCustomValidity(valid ? "" : `请输入 ${input.min}–${input.max} 范围内的数值`);
      if (!valid) { input.reportValidity(); return; }
      settings.desktopTypography[spacingKey] = Number(ratio.toFixed(10));
      await save();
      refresh();
    }));
    refresh();
  }

  private renderPlatformDisplayGroup(container: HTMLElement, mobile: boolean): void {
    const group = settingsFieldset(container, mobile ? "移动端显示" : "桌面端显示");
    const settings = this.plugin.settings;
    const profile = mobile ? settings.mobileDisplay : settings;
    if (!mobile) {
      for (const [key, name, enabledKey] of [["interfaceFont", "界面字体", "interfaceFontEnabled"], ["textFont", "正文字体", "textFontEnabled"]] as const) {
        const save = async (): Promise<void> => {
          await this.plugin.saveSettings();
          this.plugin.refreshTypography();
        };
        const row = this.renderDisplayCheckbox(group, name, "关闭后跟随 Obsidian 字体设置。",
          settings.desktopTypography[enabledKey], async checked => {
            settings.desktopTypography[enabledKey] = checked;
            select.disabled = !checked;
            await save();
          });
        row.addClass("simple-font-option-row");
        const download = row.createEl("a", { cls: "simple-font-download", attr: {
          target: "_blank", rel: "noopener noreferrer",
        } });
        setIcon(download, "download");
        const select = row.createEl("select", { attr: { "aria-label": name } });
        for (const { value, label } of CHINESE_FONTS) {
          select.createEl("option", { value, text: label });
        }
        select.value = settings.desktopTypography[key];
        select.disabled = !settings.desktopTypography[enabledKey];
        updateFontDownload(download, CHINESE_FONTS.find(font => font.value === select.value));
        select.addEventListener("change", runAsync(async () => {
          settings.desktopTypography[key] = select.value as typeof settings.desktopTypography[typeof key];
          updateFontDownload(download, CHINESE_FONTS.find(font => font.value === select.value));
          await save();
          group.dispatchEvent(new Event("simple-font-change"));
        }));
      }
      const latinRow = this.renderDisplayCheckbox(group, "英文字体", "用于正文中的英文、数字和半角标点（如 , . ! ?）；中文及中文标点（如 ，。！？）使用正文字体。选择“跟随正文”后统一使用正文字体；未安装的字体会回退。",
        settings.desktopTypography.latinFontEnabled, async checked => {
          settings.desktopTypography.latinFontEnabled = checked;
          latinSelect.disabled = !checked;
          await this.plugin.saveSettings();
          this.plugin.refreshTypography();
        });
      latinRow.addClass("simple-font-option-row");
      const latinDownload = latinRow.createEl("a", { cls: "simple-font-download", href: "https://raw.githubusercontent.com/adobe-fonts/source-sans/release/TTF/SourceSans3-Regular.ttf", attr: { target: "_blank", rel: "noopener noreferrer", "aria-label": tooltipText("下载英文字体", "安装字体后，完全退出并重新打开 Obsidian。未安装时使用系统后备字体。") } });
      setIcon(latinDownload, "download");
      const latinSelect = latinRow.createEl("select", { attr: { "aria-label": "英文字体" } });
      for (const { value } of LATIN_FONTS) latinSelect.createEl("option", { value, text: value === "default" ? "跟随正文" : value });
      latinSelect.value = settings.desktopTypography.latinFont;
      latinSelect.disabled = !settings.desktopTypography.latinFontEnabled;
      updateFontDownload(latinDownload, LATIN_FONTS.find(font => font.value === latinSelect.value));
      latinSelect.addEventListener("change", runAsync(async () => {
        settings.desktopTypography.latinFont = latinSelect.value as typeof settings.desktopTypography.latinFont;
        updateFontDownload(latinDownload, LATIN_FONTS.find(font => font.value === latinSelect.value));
        await this.plugin.saveSettings();
        this.plugin.refreshTypography();
      }));
      this.renderDisplayCheckbox(group, "中文阅读版式", "正文首行缩进两字；整行加粗及标题行不缩进。",
        settings.desktopTypography.paragraphStyle === "indent", async value => {
          settings.desktopTypography.paragraphStyle = value ? "indent" : "spaced";
          await this.plugin.saveSettings();
          this.plugin.refreshTypography();
        });
      this.renderDisplayCheckbox(group, "窗口定位优化", "将超出屏幕的弹出窗口移回可见范围。",
        settings.enableWindowPositionOptimization, async value => {
          settings.enableWindowPositionOptimization = value;
          await this.plugin.saveSettings();
        });
    }
    this.renderDisplayParameter(group, mobile, "readableLineWidth", "笔记正文宽度",
      "最大可读行宽；需要开启 Obsidian 的“可读行长”。关闭后跟随主题；手机端设置大于可用宽度时无明显效果。",
      profile.readableLineWidth, mobile ? "600" : "900", mobile ? 1 : 400, 2000, 20, "px",
      value => { profile.readableLineWidth = value; });
    this.renderDisplayParameter(group, mobile, "imageMaxHeight", "图片最大高度", "图片按原比例缩放；关闭后不限制高度。",
      profile.imageMaxHeight, "450", 1, 10000, 1, "px", value => { profile.imageMaxHeight = value; });
    this.renderDisplayParameter(group, mobile, "popupWindowScale", "弹出窗口缩放比例", "设置窗口在下次打开时应用尺寸；打开后可自由移动和调整。附件清单在打开时适配，关闭此项则不调整。",
      profile.popupWindowScale, "70", 40, POPUP_SCALE_MAX, 5, "%", value => { profile.popupWindowScale = value; });
    if (!mobile) {
      const labels = { fontSize: ["正文字号", "px"], lineHeight: ["行高", "倍"],
        letterSpacing: ["字间距", "em"], paragraphSpacing: ["段间距", "em"] };
      for (const key of Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]) {
        const [min, max, step] = TYPOGRAPHY_RANGES[key];
        this.renderDisplayParameter(group, false, key, labels[key][0], "关闭后跟随 Obsidian 或主题设置。",
          String(settings.desktopTypography[key]), String(TYPOGRAPHY_DEFAULTS[key]), min, max, step, labels[key][1],
          value => { settings.desktopTypography[key] = Number(value); });
      }
    }
    if (mobile) {
      this.renderDisplayParameter(group, true, "headerButtonSize", "顶部按钮大小", "调整顶部操作按钮和侧边栏按钮的大小；关闭后跟随主题。",
        settings.mobileDisplay.headerButtonSize, "29", 20, 64, 1, "px", value => { settings.mobileDisplay.headerButtonSize = value; });
      this.renderDisplayCheckbox(group, "紧凑底栏", "缩小手机底部页签与文件信息的字号和留白。",
        settings.mobileDisplay.compactBottomBar, async value => {
          settings.mobileDisplay.compactBottomBar = value;
          await this.plugin.saveSettings();
          this.plugin.applyMobileHeaderButtons();
        });
      this.renderDisplayCheckbox(group, "禁用主题手机端按钮样式", "关闭 Things 主题的圆形悬浮按钮外观，使用原生风格；按钮大小独立设置。",
        settings.mobileDisplay.disableThemeHeaderButtons, async value => {
          settings.mobileDisplay.disableThemeHeaderButtons = value;
          await this.plugin.saveSettings();
          this.plugin.applyMobileHeaderButtons();
        });
    }
  }

  private renderDisplayPreviewSettings(container: HTMLElement, standalone = true): void {
    if (standalone) this.renderPageHeader(container, "显示与预览");
    const tabs = [
      ...(this.plugin.settings.showSyncSharingEntry ? [{ id: "sync-sharing", name: "同步", icon: "refresh-cw" } as const] : []),
      ...(this.plugin.settings.showSharingEntry ? [{ id: "sharing", name: "分享", icon: "share-2" } as const] : []),
      ...(this.plugin.settings.showCalendarDiaryEntry ? [{ id: "calendar-diary", name: "日程", icon: "calendar-days" } as const] : []),
      ...(this.plugin.settings.enableAI ? [{ id: "ai", name: "AI", icon: "bot" } as const] : []),
      { id: "basic", name: "拓展", icon: "settings-2" },
      { id: "shortcuts", name: "编辑", icon: "keyboard" },
      { id: "display", name: "显示", icon: "monitor" },
      { id: "theme", name: "主题", icon: "palette" },
    ] as const;
    const tabList = container.createDiv({ cls: "simple-display-tabs simple-display-tabs-responsive", attr: { role: "tablist", "aria-label": "显示与预览分类" } });
    const panels = tabs.map(tab => container.createDiv({
      cls: "simple-display-tab-panel",
      attr: { role: "tabpanel", id: `simple-display-panel-${tab.id}`, "aria-labelledby": `simple-display-tab-${tab.id}` },
    }));
    const buttons = tabs.map((tab, index) => {
      const button = tabList.createEl("button", { cls: "simple-display-tab", attr: { type: "button", role: "tab", id: `simple-display-tab-${tab.id}`, "aria-controls": `simple-display-panel-${tab.id}`, "aria-label": tab.name } });
      setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), tab.icon);
      button.createSpan({ text: tab.name });
      button.addEventListener("click", () => select(index));
      button.addEventListener("keydown", event => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        select(next);
        buttons[next].focus({ preventScroll: true });
      });
      return button;
    });
    const scrollSpace = container.createDiv({
      cls: "simple-display-tab-scroll-space",
      attr: { "aria-hidden": "true" },
    });
    let reservedHeight = 0;
    let scrollHost: HTMLElement | null = null;
    let previousScrollTop = 0;
    const setReservedHeight = (height: number): void => {
      reservedHeight = Math.max(0, height);
      scrollSpace.style.height = `${reservedHeight}px`;
    };
    const resolveScrollHost = (): void => {
      let host: HTMLElement | null = container;
      while (host && !/(auto|scroll)/.test(getComputedStyle(host).overflowY)) {
        host = host.parentElement;
      }
      if (!host || host === scrollHost) return;
      scrollHost = host;
      previousScrollTop = host.scrollTop;
      const currentHost = host;
      this.plugin.registerDomEvent(currentHost, "scroll", () => {
        if (!container.isConnected || scrollHost !== currentHost) return;
        if (currentHost.scrollTop < previousScrollTop && reservedHeight > 0) {
          const naturalMax = Math.max(0, currentHost.scrollHeight - reservedHeight - currentHost.clientHeight);
          setReservedHeight(Math.max(0, currentHost.scrollTop - naturalMax));
        }
        previousScrollTop = currentHost.scrollTop;
      });
    };
    const preserveLayout = (update: () => void): void => {
      resolveScrollHost();
      const scrollTop = scrollHost?.scrollTop ?? 0;
      // Protect the scroll range before removing settings or hiding a taller panel.
      if (scrollHost) setReservedHeight(reservedHeight + scrollHost.scrollHeight);
      update();
      if (scrollHost) {
        const naturalMax = Math.max(0, scrollHost.scrollHeight - reservedHeight - scrollHost.clientHeight);
        setReservedHeight(Math.max(0, scrollTop - naturalMax));
        scrollHost.scrollTop = scrollTop;
        previousScrollTop = scrollHost.scrollTop;
      }
    };
    const loaded = new Set<number>();
    const select = (index: number): void => preserveLayout(() => {
      this.plugin.ai?.hideSettings();
      const sharing = tabs[index].id === "sharing";
      if (tabs[index].id === "sync-sharing" || sharing) {
        const panel = panels[index];
        panel.empty();
        if (this.syncNavigationTab !== tabs[index].id) this.syncTab.resetNavigation(sharing);
        this.syncNavigationTab = tabs[index].id;
        const title = this.renderPageHeader(panel, sharing ? "分享" : "同步", () => {
          if (!this.syncTab.backToOverview()) select(tabs.findIndex(tab => tab.id === "display"));
        });
        this.syncTab.renderInto(panel.createDiv({ cls: "simple-one-sync-feature" }), text => {
          title.setText(text);
          const isRoot = text === "同步" || text === "分享";
          title.closest<HTMLElement>(".simple-page-header")!.style.display = isRoot ? "none" : "";
          tabList.style.display = isRoot ? "" : "none";
          setReservedHeight(0);
        });
      } else if (this.displayPreviewTab === "sync-sharing" || this.displayPreviewTab === "sharing") {
        this.syncTab.hide();
        tabList.style.removeProperty("display");
      }
      if (tabs[index].id === "ai") {
        const panel = panels[index]; panel.empty(); this.plugin.ai.renderInto(panel);
      }
      if (tabs[index].id !== "sync-sharing" && tabs[index].id !== "ai" && !sharing && !loaded.has(index)) {
        loaded.add(index);
        const panel = panels[index];
        if (tabs[index].id === "display") this.renderDisplayPanel(panel);
        else if (tabs[index].id === "theme") this.renderThemePanel(panel);
        else if (tabs[index].id === "shortcuts") {
          this.renderOverviewInlineSettings(panel);
          this.renderEditingOptimizationSettings(panel);
          this.renderPasteLinkSettings(panel);
          this.renderNotionColumnsSettings(panel);
        } else if (tabs[index].id === "calendar-diary") this.renderCalendarDiarySettings(panel, false);
        else this.renderBasicOptimizationSettings(panel);
      }
      this.displayPreviewTab = tabs[index].id;
      if (this.plugin.settings.lastSettingsTab !== this.displayPreviewTab) {
        this.plugin.settings.lastSettingsTab = this.displayPreviewTab;
        void this.plugin.saveSettings();
      }
      buttons.forEach((button, i) => {
        button.setAttribute("aria-selected", String(i === index));
        button.tabIndex = i === index ? 0 : -1;
        panels[i].hidden = i !== index;
      });
    });
    select(Math.max(0, tabs.findIndex(tab => tab.id === this.displayPreviewTab)));
  }

  private renderThemePanel(container: HTMLElement): void {
    this.renderThemeAppearanceSettings(container);
    this.renderThemeFormattingSettings(container, false);
    const headingGroup = settingsFieldset(container, "标题格式");
    for (const level of Object.keys(QUICK_FORMAT_HEADING_LABELS) as QuickFormatHeadingLevel[]) {
      this.renderQuickFormatHeadingSetting(headingGroup, level, readRenderedFontSize());
    }
    const calloutGroup = settingsFieldset(container, "Callout 格式");
    this.renderQuickFormatCalloutSettings(calloutGroup, false);
  }

  private renderDisplayPanel(container: HTMLElement): void {
    this.renderPlatformDisplayGroup(container, false);
    this.renderPlatformDisplayGroup(container, true);
    const group = settingsFieldset(container, "渲染预览");
    const options = [
      { key: "enableHtmlPreview", name: "HTML 代码渲染",
        desc: "将 HTML 代码块渲染为网页效果，不执行内嵌脚本；与文本仅显示替换独立。",
        refresh: () => this.plugin.refreshHtmlPreviews() },
      { key: "enableImageZoom", name: "图片交互优化",
        desc: "点击笔记中的图片打开大图；在大图上滚轮缩放，点空白处或按 Esc 关闭。",
        refresh: () => {} },
      { key: "enableMermaidEnhancer", name: "流程图交互优化",
        desc: "为流程图提供适应面板宽度、滚轮缩放与拖动画布，以及全屏查看。",
        refresh: () => this.plugin.refreshMermaidEnhancements() },
      { key: "enableColorPreview", name: "颜色代码预览",
        desc: "在编辑器中的 HEX、RGB、RGBA、HSL 和 HSLA 颜色代码前显示对应的颜色方块。",
        refresh: () => this.plugin.refreshColorPreviews() },
      { key: "enableReadableCustomTags", name: "自定义标签内保留换行",
        desc: "阅读模式下让 thinking/content/todo 等自定义标签按块显示，并保留换行。",
        refresh: () => this.plugin.applyReadableCustomTagStyles() },
    ] as const;
    for (const option of options) {
      const label = group.createEl("label", {
        cls: "simple-preview-checkbox-row",
        attr: { "aria-label": option.desc },
      });
      const checkbox = label.createEl("input", {
        type: "checkbox",
        attr: { "aria-description": option.desc },
      });
      checkbox.checked = this.plugin.settings[option.key];
      label.createSpan({ text: option.name });
      checkbox.addEventListener("change", runAsync(async () => {
        this.plugin.settings[option.key] = checkbox.checked;
        await this.plugin.saveSettings();
        option.refresh();
      }));
    }
  }

  private renderNotionColumnsSettings(container: HTMLElement): void {
    const card = settingsFieldset(container, "双列显示");
    {
      this.renderDisplayCheckbox(card, "启用双列视图", "", this.plugin.settings.enableNotionColumns, async value => {
          this.plugin.settings.enableNotionColumns = value;
          updateDisabled();
          await this.plugin.saveSettings();
          this.app.workspace.updateOptions();
        });

      const selectContextPosition = async (position: "main" | "insert"): Promise<void> => {
          this.plugin.settings.enableNotionColumnsContextMenu = true;
          this.plugin.settings.notionColumnsContextMenuPosition = position;
          updateContextRadios();
          await this.plugin.saveSettings();
      };
      const contextRow = this.renderDisplayCheckbox(card, "在右键菜单中增加“创建双列”", "", false,
        async () => selectContextPosition("main"));
      const insertContextRow = this.renderDisplayCheckbox(card, "在右键菜单的“插入”中增加“创建双列”", "", false,
        async () => selectContextPosition("insert"));
      const contextRadio = contextRow.querySelector<HTMLInputElement>("input")!;
      const insertContextRadio = insertContextRow.querySelector<HTMLInputElement>("input")!;
      const updateContextRadios = (): void => {
        contextRadio.checked = this.plugin.settings.notionColumnsContextMenuPosition !== "insert";
        insertContextRadio.checked = !contextRadio.checked;
      };
      updateContextRadios();

      const gestureRow = this.renderDisplayCheckbox(card, "通过鼠标手势创建双列（选中内容，同时按下鼠标左键和右键）", "", this.plugin.settings.enableNotionColumnsMouseGesture, async value => {
          this.plugin.settings.enableNotionColumnsMouseGesture = value;
          await this.plugin.saveSettings();
          this.app.workspace.updateOptions();
        });

      const keyboardRow = this.renderDisplayCheckbox(card, "通过键盘快捷键创建双列", "", this.plugin.settings.enableNotionColumnsKeyboard, async value => {
        this.plugin.settings.enableNotionColumnsKeyboard = value;
        updateDisabled();
        await this.plugin.saveSettings();
      });

      keyboardRow.addClass("simple-columns-keyboard-row");
      const shortcut = new Setting(keyboardRow)
        .setClass("simple-columns-hotkey-setting");
      shortcut.settingEl.removeClass("setting-item");
      shortcut.infoEl.hidden = true;
      const status = card.createDiv({ cls: "simple-hotkey-status" });
      status.hidden = true;
      let input: HTMLInputElement;
      let saving = false;
      const savedLabel = () => {
        const hotkey = currentColumnsHotkey(this.app);
        return hotkey ? commandHotkeyLabel(hotkey) : "未设置";
      };
      const showStatus = (message: string, isError: boolean) => {
        status.hidden = false;
        status.classList.toggle("is-error", isError);
        status.setText(message);
      };
      const validate = () => {
        const hotkey = parseCommandHotkey(input.value);
        if (hotkey && commandHotkeyLabel(hotkey) === savedLabel()) {
          status.hidden = true;
          return hotkey;
        }
        const conflicts = hotkey && columnsHotkeyConflicts(this.app, hotkey);
        showStatus(!hotkey ? "请输入如 Alt + C 的组合键（需含修饰键）。"
          : conflicts === null ? "无法读取当前快捷键占用情况。"
          : conflicts.length ? `已被占用：${conflicts.join("、")}` : "当前 Obsidian 中未被其他命令占用。",
          !hotkey || conflicts === null || !!conflicts?.length);
        return hotkey && conflicts?.length === 0 ? hotkey : null;
      };
      const save = async () => {
        if (saving || !input.value.trim()) return;
        const entered = parseCommandHotkey(input.value);
        if (entered && commandHotkeyLabel(entered) === savedLabel()) {
          input.value = savedLabel();
          status.hidden = true;
          return;
        }
        const hotkey = validate();
        if (!hotkey) return;
        saving = true;
        try {
          if (!await saveColumnsHotkey(this.app, hotkey)) throw new Error("当前 Obsidian 版本不支持在此修改快捷键");
          input.value = commandHotkeyLabel(hotkey);
          showStatus("已保存，立即生效。", false);
        } catch (error) {
          showStatus(`保存失败：${String(error)}`, true);
        } finally {
          saving = false;
        }
      };
      shortcut.addText((text) => {
        input = text.inputEl;
        text.setPlaceholder("请按下组合键").setValue(savedLabel());
        input.addEventListener("focus", () => {
          input.value = "";
          status.hidden = true;
        });
        input.addEventListener("input", () => {
          if (input.value.trim()) validate();
          else status.hidden = true;
        });
        input.addEventListener("blur", () => {
          if (!input.value.trim()) {
            input.value = savedLabel();
            status.hidden = true;
          } else void save();
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            input.value = savedLabel();
            status.hidden = true;
            input.blur();
            return;
          }
          if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
          if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            event.preventDefault();
            void save();
            return;
          }
          if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return;
          event.preventDefault();
          event.stopPropagation();
          const modifiers = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"].filter(Boolean);
          const key = event.key === " " ? "Space" : /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : event.key;
          input.value = [...modifiers, key].join(" + ");
          void save();
        });
      });
      const updateDisabled = (): void => {
        const disabled = !this.plugin.settings.enableNotionColumns;
        for (const row of [contextRow, insertContextRow, gestureRow, keyboardRow]) {
          row.toggleClass("simple-dependent-disabled", disabled);
          row.setAttribute("aria-disabled", String(disabled));
          row.querySelectorAll<HTMLInputElement>("input").forEach(control => {
            control.disabled = disabled;
          });
        }
        input.disabled = disabled || !this.plugin.settings.enableNotionColumnsKeyboard;
        if (input.disabled) status.hidden = true;
      };
      updateDisabled();
    }
  }

  private renderAttachmentOrganizerSettings(container: HTMLElement): void {
    const location = readObsidianAttachmentLocation(this.plugin);
    const disabledReasons = attachmentOrganizerDisabledReasons(location.mode);
    const card = settingsFieldset(container, "附件优化", "simple-attachment-settings");
    const mode = card.createDiv({ cls: "simple-preview-checkbox-row simple-attachment-action-row" });
    mode.createSpan({ text: "当前附件存放模式" });
    const modeControls = mode.createDiv({ cls: "simple-attachment-mode-controls" });
    modeControls.createSpan({ cls: "simple-attachment-mode-value", text: describeAttachmentLocation(location) });
    const configure = styleActionButton(modeControls.createEl("button", {
      cls: "clickable-icon simple-attachment-action",
      attr: { type: "button", "aria-label": "打开 Obsidian 附件存放设置" },
    }), "bordered");
    setIcon(configure, "settings-2");
    configure.addEventListener("click", () => {
      this.openNativeAttachmentSettings();
    });
    const referenceJump = card.createEl("label", { cls: "simple-preview-checkbox-row" });
    const referenceCheckbox = referenceJump.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": "从附件快速跳转到引用笔记" },
    });
    referenceCheckbox.checked = this.plugin.settings.enableAttachmentReferenceJump !== false;
    referenceJump.createSpan({ text: "从附件快速跳转到引用笔记" });
    referenceJump.setAttribute("aria-label", "附件右键菜单与预览顶部右侧显示搜索图标，在新标签页打开引用笔记；多篇引用时可选择笔记或全部打开。");
    referenceCheckbox.addEventListener("change", runAsync(async () => {
      this.plugin.settings.enableAttachmentReferenceJump = referenceCheckbox.checked;
      await this.plugin.saveSettings();
      this.plugin.refreshAttachmentReferenceActions();
    }));
      if (location.mode === "vault-root") {
        card.createDiv({
          cls: "simple-attachment-mode-warning",
          text: "当前附件默认存放在 Vault 根目录。请先指定附件文件夹，再检查根目录遗留附件的重命名和归位清单。",
        });
        const quickConfig = card.createDiv({ cls: "simple-attachment-quick-config" });
        quickConfig.createSpan({ text: `将所有附件放入指定文件夹（默认 ${DEFAULT_ATTACHMENT_FOLDER}；仅影响新附件）` });
        const button = styleActionButton(quickConfig.createEl("button", { text: "快速配置", attr: { type: "button" } }), "text");
        button.addEventListener("click", () => void this.quickConfigureAttachmentFolder(button));
      } else if (location.mode === "unknown") {
        card.createDiv({
          cls: "simple-attachment-mode-warning",
          text: "无法识别当前附件存放设置。插件将按高风险状态处理，所有附件优化功能已禁用。",
        });
      }
      this.renderAttachmentOrganizerAction(
        card,
        "清理未引用附件与空文件夹",
        "扫描附件目录中的未引用附件、空文件夹（含整条为空的子目录链）及根目录遗留图片；保留附件根目录，根目录图片与非图片附件默认不勾选，确认后移入 Obsidian 回收站。",
        "开始检查",
        disabledReasons.unused,
        () => void checkUnusedAttachments(this.plugin),
        "autoCleanAttachments"
      );

      const imageRow = this.renderAttachmentOrganizerAction(
        card,
        "分类图片至附件专区（并重命名）",
        "根据引用笔记重命名图片并分类。笔记所在目录：附件专区/笔记完整所在目录；笔记名目录：在此前提下再创建笔记同名目录。先预览，确认后执行。",
        "开始检查",
        disabledReasons.imageRename,
        () => void planAttachmentImageRename(this.plugin),
        "autoOrganizeImages"
      );
      this.renderAttachmentTargetSelect(imageRow, "imageAttachmentFolderMode", "图片分类目录", location.mode !== "fixed-folder" || Boolean(disabledReasons.imageRename));

      const attachmentRow = this.renderAttachmentOrganizerAction(
        card,
        "分类附件至附件专区",
        "JSON、txt、PDF 等非图片附件保留原名，按所选目录规则分类，重名时添加数字避让。先预览，确认后执行。",
        "开始检查",
        disabledReasons.organization,
        () => void planAttachmentOrganization(this.plugin),
        "autoOrganizeAttachments"
      );

      this.renderAttachmentTargetSelect(attachmentRow, "attachmentFolderMode", "附件分类目录", location.mode !== "fixed-folder" || Boolean(disabledReasons.organization));
      this.renderAttachmentOrganizerAction(
        card,
        "内嵌 Base64 图片转为常规图片",
        "将 Markdown 中的 Base64 图片保存为图片文件，并替换为图片链接；保存位置跟随 Obsidian 附件设置。",
        "转换",
        disabledReasons.inlineExtraction,
        () => void planInlineImageExtraction(this.plugin),
        "autoExtractInlineImages"
      );
  }

  private renderThemeAppearanceSettings(container: HTMLElement): void {
    const group = settingsFieldset(container, "主题");
    const app = this.app as App & { getAccentColor(): string; setAccentColor(color: string): void };
    const vault = this.app.vault as App["vault"] & { getConfig(key: string): unknown; setConfig(key: string, value: string): void | Promise<void> };
    const colorRow = (name: string, description: string, value: string, customized: boolean,
      save: (color: string) => Promise<void>, read: () => string, isCustomized: () => boolean): void => {
      const row = group.createDiv({ cls: "simple-preview-checkbox-row simple-display-option-row simple-theme-format-row", attr: { "aria-label": description } });
      row.createSpan({ text: name });
      const controls = row.createDiv({ cls: "simple-theme-format-controls" });
      const picker = new ThemeColorPicker(controls, this.plugin).setValue(value).onChange(async color => {
        if (this.refreshingThemeColor) return;
        await save(color); this.updateThemeReset(reset, true);
      });
      picker.buttonEl.setAttribute("aria-label", name);
      const reset = controls.createEl("button", { cls: "clickable-icon simple-format-reset", attr: { type: "button", "aria-label": tooltipText(`${name}：恢复当前主题`, "恢复当前主题") } });
      setActionIcon(reset, "rotate-ccw"); this.updateThemeReset(reset, customized);
      reset.addEventListener("click", runAsync(async () => {
        await save(""); this.setThemeColor(picker, read()); this.updateThemeReset(reset, false);
      }));
      this.watchThemeControl(row, () => {
        this.updateThemeReset(reset, isCustomized());
        this.setThemeColor(picker, read());
      });
    };
    colorRow("强调色", "与 Obsidian 外观设置联动；恢复后跟随当前主题。", app.getAccentColor(), !!vault.getConfig("accentColor"), async color => {
      await vault.setConfig("accentColor", color); app.setAccentColor(color);
    }, () => app.getAccentColor(), () => !!vault.getConfig("accentColor"));
    const background = (): string => getComputedStyle(container.ownerDocument.body).getPropertyValue("--background-secondary").trim();
    colorRow("侧边栏背景色", "调整浅色模式的侧边栏和使用侧栏底色的工具面板，推荐柔和灰 #f6f7f9；正文背景和深色模式跟随主题。", this.plugin.settings.themeBackgroundColor || background(), !!this.plugin.settings.themeBackgroundColor, async color => {
      this.plugin.settings.themeBackgroundColor = color;
      await this.plugin.saveSettings(); this.plugin.refreshThemeAppearance();
    }, () => this.plugin.settings.themeBackgroundColor || background(), () => !!this.plugin.settings.themeBackgroundColor);
    this.renderDisplayCheckbox(group, "标签跟随强调色", "让顶部属性中的 tags 标签和正文 #标签使用当前强调色及浅色底；关闭后跟随主题。",
      this.plugin.settings.themeTagsFollowAccent, async checked => {
        this.plugin.settings.themeTagsFollowAccent = checked;
        await this.plugin.saveSettings(); this.plugin.refreshThemeAppearance();
      });
    this.renderDisplayCheckbox(group, "优化正文短代码样式", "为反引号包住的文字统一使用界面字体、正文 87.5% 的字号、细边框、圆角和浅底色。关闭后恢复主题样式，不影响代码块和属性标签。",
      this.plugin.settings.themeInlineCodeFollowsBody, async checked => {
        this.plugin.settings.themeInlineCodeFollowsBody = checked;
        await this.plugin.saveSettings(); this.plugin.refreshThemeAppearance();
      });

  }

  private renderThemeFormattingSettings(container: HTMLElement, standalone = true): void {
    if (standalone) this.renderPageHeader(container, "正文默认格式", () => this.openPage({ type: "overview" }));
    const formatting = this.plugin.settings.themeFormatting;
    const group = settingsFieldset(container, "正文默认格式");
    const save = async (): Promise<void> => {
      await this.plugin.saveSettings();
      this.plugin.applyThemeFormattingStyles();
    };
    {
      const colorSetting = (
        name: string,
        description: string,
        key: keyof typeof formatting,
        tag: "strong" | "em" | "mark" | "del" | "span" | "u",
        property: "color" | "backgroundColor"
      ): void => {
        const value = formatting[key];
        const row = group.createDiv({ cls: "simple-preview-checkbox-row simple-display-option-row simple-theme-format-row", attr: { "aria-label": description } });
        const label = row.createDiv({ cls: "simple-theme-format-label" });
        const symbol = label.createSpan({ cls: "simple-theme-format-symbol", attr: { "aria-hidden": "true" } });
        setFormatIcon(symbol, { strong: "bold", em: "italic", del: "strikethrough", u: "underline", span: "baseline", mark: property === "backgroundColor" ? "highlighter" : "baseline" }[tag]);
        label.createSpan({ text: name });
        const refreshIcon = () => {
          const color = formatting[key] || readRenderedFormatColor(tag, property);
          symbol.style.color = property === "color" ? color : readRenderedFormatColor(tag, "color");
          symbol.style.backgroundColor = property === "backgroundColor" ? color : "";
        };
        const controls = row.createDiv({ cls: "simple-theme-format-controls" });
        const preview = controls.createSpan({
          cls: "markdown-rendered simple-theme-format-preview",
        });
        preview.createEl(tag, {
          text: { strong: "加粗", em: "斜体", mark: "高亮", del: "删除线", span: "正文", u: "下划线" }[tag],
        });
        const picker = new ThemeColorPicker(controls, this.plugin)
            .setValue(value || readRenderedFormatColor(tag, property))
            .onChange(async (color) => {
              if (this.refreshingThemeColor) return;
              formatting[key] = color;
              this.updateThemeReset(reset, true);
              await save();
              refreshIcon();
            });
        picker.buttonEl.setAttribute("aria-label", name);
        const reset = controls.createEl("button", { cls: "clickable-icon simple-format-reset", attr: { type: "button", "aria-label": tooltipText(`${name}：恢复当前主题`, "恢复当前主题") } });
        setActionIcon(reset, "rotate-ccw");
        this.updateThemeReset(reset, !!value);
        reset.addEventListener("click", runAsync(async () => {
          formatting[key] = "";
          await save();
          this.setThemeColor(picker, readRenderedFormatColor(tag, property));
          this.updateThemeReset(reset, false);
          refreshIcon();
        }));
        this.watchThemeControl(row, () => {
          this.updateThemeReset(reset, !!formatting[key]);
          this.setThemeColor(picker, formatting[key] || readRenderedFormatColor(tag, property));
          refreshIcon();
        });
      };

      colorSetting("正文文字颜色", "设置正文默认颜色。", "textColor", "span", "color");
      colorSetting("加粗文字颜色", "设置 Markdown 加粗文字颜色。", "boldColor", "strong", "color");
      colorSetting("斜体文字颜色", "设置 Markdown 斜体文字颜色。", "italicColor", "em", "color");
      colorSetting("下划线颜色", "设置下划线文字颜色。", "underlineColor", "u", "color");
      colorSetting("删除线颜色", "设置 Markdown 删除线文字颜色。", "strikethroughColor", "del", "color");
      colorSetting("高亮背景颜色", "设置 ==高亮== 文本的背景颜色。", "highlightBackground", "mark", "backgroundColor");
      colorSetting("高亮文字颜色", "设置高亮文本的前景颜色。", "highlightColor", "mark", "color");
    }
  }

  private openNativeAttachmentSettings(): void {
    const setting = (this.app as App & {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (!setting?.openTabById) {
      new Notice("请在 Obsidian 的“文件与链接”中调整附件默认存放路径");
      return;
    }
    setting.open?.();
    setting.openTabById("file");
  }

  private async quickConfigureAttachmentFolder(button: HTMLButtonElement): Promise<void> {
    const vault = this.plugin.app.vault as typeof this.plugin.app.vault & {
      setConfig?: (key: string, value: string) => void | Promise<void>;
    };
    const setting = (this.app as App & {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    const openFileSettings = () => {
      setting?.open?.();
      setting?.openTabById?.("file");
    };
    if (!vault.setConfig) {
      openFileSettings();
      new Notice(`请在“文件与链接”中将新附件的默认位置设为指定文件夹：${DEFAULT_ATTACHMENT_FOLDER}`);
      return;
    }

    button.disabled = true;
    try {
      const folder = vault.getAbstractFileByPath(DEFAULT_ATTACHMENT_FOLDER);
      if (folder && !(folder instanceof TFolder)) {
        new Notice(`${DEFAULT_ATTACHMENT_FOLDER} 已被文件占用，请在“文件与链接”中手动选择其他文件夹`);
        openFileSettings();
        return;
      }
      if (!folder) await vault.createFolder(DEFAULT_ATTACHMENT_FOLDER);
      await vault.setConfig("attachmentFolderPath", DEFAULT_ATTACHMENT_FOLDER);
      const updated = readObsidianAttachmentLocation(this.plugin);
      if (updated.mode !== "fixed-folder" || updated.folder !== DEFAULT_ATTACHMENT_FOLDER) {
        throw new Error("Obsidian 未应用附件目录设置");
      }
      this.renderSettings();
      openFileSettings();
      new Notice(`以后新增的附件将存放在 ${DEFAULT_ATTACHMENT_FOLDER}；现有附件不会自动移动`);
    } catch (error) {
      openFileSettings();
      new Notice(`快速配置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  private renderAttachmentTargetSelect(row: HTMLElement, key: "imageAttachmentFolderMode" | "attachmentFolderMode", label: string, disabled: boolean): void {
    const button = row.querySelector<HTMLButtonElement>(".simple-attachment-action")!;
    const controls = row.createDiv({ cls: "simple-attachment-mode-controls" });
    const select = controls.createEl("select", {
      cls: "simple-attachment-target",
      attr: { "aria-label": label },
    });
    select.createEl("option", { value: "category", text: "笔记所在目录" });
    select.createEl("option", { value: "note", text: "笔记名目录" });
    select.value = this.plugin.settings[key] === "note" ? "note" : "category";
    select.disabled = disabled;
    if (disabled) select.setAttribute("aria-label", "目录选择仅适用于指定附件文件夹模式。");
    select.addEventListener("change", runAsync(async () => {
      this.plugin.settings[key] = select.value === "note" ? "note" : "category";
      await this.plugin.saveSettings();
      this.plugin.refreshAttachmentAutomation();
    }));
    controls.appendChild(button);
  }

  private renderAttachmentOrganizerAction(
    container: HTMLElement,
    name: string,
    description: string,
    buttonText: string,
    disabledReason: string | null,
    onClick: () => void,
    automaticKey?: "autoCleanAttachments" | "autoOrganizeImages" | "autoOrganizeAttachments" | "autoExtractInlineImages"
  ): HTMLElement {
    const row = container.createDiv({
      cls: "simple-preview-checkbox-row simple-attachment-action-row",
      attr: { "aria-label": description },
    });
    if (automaticKey) {
      const checkbox = row.createEl("input", {
        type: "checkbox",
        attr: { "aria-label": tooltipText(`自动静默处理：${name}`, "勾选后自动静默处理；右侧按钮可手动预览并执行") },
      });
      checkbox.checked = Boolean(this.plugin.settings[automaticKey]);
      checkbox.disabled = Boolean(disabledReason);
      checkbox.addEventListener("change", runAsync(async () => {
        this.plugin.settings[automaticKey] = checkbox.checked;
        await this.plugin.saveSettings();
        this.plugin.refreshAttachmentAutomation();
      }));
    }
    const copy = row.createDiv({ cls: "simple-attachment-action-copy" });
    copy.createSpan({ text: name });
    const button = styleActionButton(row.createEl("button", {
      cls: "clickable-icon simple-attachment-action",
      attr: { type: "button", "aria-label": tooltipText(`${buttonText}：${name}`, disabledReason || `${buttonText}：${name}`) },
    }), "bordered");
    setIcon(button, "play");
    button.disabled = Boolean(disabledReason);
    if (!disabledReason) button.addEventListener("click", onClick);
    if (disabledReason) {
      copy.createDiv({ cls: "simple-attachment-disabled-reason", text: disabledReason });
    }
    return row;
  }

  private renderHtmlPreviewSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "文本显示替换设置", () => {
      this.displayPreviewTab = "shortcuts";
      this.openPage({ type: "overview" });
    });

    const card = settingsFieldset(container, "文本显示替换设置", "simple-html-preview-rules");
    const header = card.createDiv({ cls: "simple-card-header" });
    const copy = header.createDiv();
    copy.createDiv({
      cls: "setting-item-description",
      text: "通过正则匹配内容，并在显示时替换为文本或 HTML，不修改原文。",
    });
    const headerActions = header.createDiv({ cls: "simple-template-manager-actions" });
    const add = createActionButton(headerActions, "plus", "添加规则");
    add.addEventListener("click", () => this.openDisplayReplacementRule(makeHtmlPreviewRule(), true));
    const importButton = createActionButton(headerActions, "download", "导入规则");
    importButton.addEventListener("click", runAsync(async () => {
      const value = await importJsonFile(headerActions.ownerDocument);
      if (!value) return;
      const incoming = importHtmlPreviewRules(value);
      const rules = this.plugin.settings.htmlPreviewRules;
      for (const rule of incoming) {
        const existing = rules.findIndex((item) => (item.importId || item.id) === rule.importId);
        if (existing >= 0) rules[existing] = { ...rules[existing], ...rule, id: rules[existing].id };
        else rules.push(rule);
      }
      await this.plugin.saveSettings();
      this.plugin.refreshHtmlPreviews();
      this.renderSettings();
    }));
    importButton.setAttribute("aria-label", "导入整组或单条替换规则");
    const exportAll = createActionButton(headerActions, "upload", "导出整组替换规则");
    exportAll.addEventListener("click", () => downloadJsonFile("simple-display-replacement-rules.json", {
      type: "simple-one.display-replacement-rules", version: 1, rules: this.plugin.settings.htmlPreviewRules.map(exportHtmlPreviewRule)
    }, headerActions.ownerDocument));

    const table = card.createDiv({ cls: "simple-display-replacement-rules" });
    if (!this.plugin.settings.htmlPreviewRules.length) {
      table.createDiv({ cls: "setting-item-description", text: "暂无替换规则" });
    }

    for (let i = 0; i < this.plugin.settings.htmlPreviewRules.length; i++) {
      this.renderHtmlPreviewRule(table, this.plugin.settings.htmlPreviewRules[i]);
    }
  }

  private renderHtmlPreviewRule(card: HTMLElement, rule: HtmlPreviewRule): void {
    const row = this.renderDisplayCheckbox(card, rule.name || "未命名规则", "", rule.enabled,
      async value => {
        rule.enabled = value;
        await this.plugin.saveSettings();
        this.plugin.refreshHtmlPreviews();
      });
    row.addClass("simple-display-replacement-rule");
    const actions = row.createDiv({ cls: "simple-display-replacement-actions" });
    const inspect = createActionButton(actions, "search", `查看和编辑${rule.name || "规则"}`);
    inspect.addEventListener("click", () => this.openDisplayReplacementRule(rule));

  }

  private openDisplayReplacementRule(rule: HtmlPreviewRule, isNew = false): void {
    new ReformatRuleModal(this.app, rule, async (updated, source) => {
      Object.assign(rule, updated, { sampleText: source });
      if (isNew) this.plugin.settings.htmlPreviewRules.push(rule);
      await this.plugin.saveSettings();
      this.plugin.refreshHtmlPreviews();
      this.renderSettings();
    }, {
      title: "文本显示替换 · 编辑规则",
      source: rule.sampleText,
      onImport: async ownerDocument => {
        const value = await importJsonFile(ownerDocument);
        if (!value) return null;
        const incoming = importHtmlPreviewRules(value);
        if (incoming.length !== 1) throw new Error("此处仅支持单条规则，整组请在外层导入");
        return { rule: incoming[0], source: incoming[0].sampleText };
      },
      onExport: (draft, source, ownerDocument) => downloadJsonFile(`${slugify(draft.name || "html-preview-rule")}.json`,
        exportHtmlPreviewRule({ ...rule, ...draft, sampleText: source }), ownerDocument),
      preview: (source, draft) => source.replace(makeRuleRegex(draft), draft.replaceWith),
      onDelete: isNew ? undefined : async () => {
        this.plugin.settings.htmlPreviewRules = this.plugin.settings.htmlPreviewRules.filter(item => item.id !== rule.id);
        await this.plugin.saveSettings();
        this.plugin.refreshHtmlPreviews();
        this.renderSettings();
      },
    }).open();
  }

  private renderLinkRules(container: HTMLElement): void {
    this.renderPageHeader(container, "超链接标题提取", () => {
      this.displayPreviewTab = "shortcuts";
      this.openPage({ type: "overview" });
    });
    this.renderFilterRules(container);
  }

  private renderPasteLinkSettings(container: HTMLElement): void {
    const card = settingsFieldset(container, "粘贴处理");
    {
      this.renderDisplayCheckbox(
        card,
        "粘贴时：单个URL自动处理为超链接",
        "粘贴单个 URL 时，将普通 URL 处理为 Markdown 超链接，将 obsidian:// 处理为 Obsidian 双链。",
        this.plugin.settings.autoProcessPaste && this.plugin.settings.autoProcessObsidian,
        async (value) => {
          this.plugin.settings.autoProcessPaste = value;
          this.plugin.settings.autoProcessObsidian = value;
          await this.plugin.saveSettings();
        }
      );
      this.renderDisplayCheckbox(
        card,
        "粘贴时：文本内URL自动处理为超链接",
        "粘贴文本时，识别其中的裸 URL，并处理为 Markdown 超链接。",
        this.plugin.settings.autoProcessPastedTextLinks,
        async (value) => {
          this.plugin.settings.autoProcessPastedTextLinks = value;
          await this.plugin.saveSettings();
        }
      );
      const row = this.renderDisplayCheckbox(card, "超链接标题提取", "提取网页标题并应用标题过滤规则。",
        this.plugin.settings.extractLinkTitle, async value => {
          this.plugin.settings.extractLinkTitle = value;
          await this.plugin.saveSettings();
        });
      row.addClass("simple-reformat-option");
      const manage = row.createEl("button", { cls: "simple-reformat-rule-link", attr: { "aria-label": "编辑提取规则" } });
      row.addClass("simple-reformat-title-option");
      setActionIcon(manage.createSpan(), "settings", "bordered");
      manage.addEventListener("click", () => this.openPage({ type: "link-rules" }));
    }
  }

  private renderFilterRules(container: HTMLElement): void {
    const card = settingsFieldset(container, "提取规则", "simple-card");
    const refresh = (): void => {
      const scrollTop = container.scrollTop;
      card.remove();
      this.renderFilterRules(container);
      container.scrollTop = scrollTop;
    };
    const header = card.createDiv({ cls: "simple-card-header" });
    const copy = header.createDiv();
    copy.createDiv({
      cls: "setting-item-description",
      text: "按顺序匹配，命中即停止。URL 留空 = 全部，提取正则为空 = 不过滤。替换为留空 = 全部捕获组拼接。",
    });
    const actions = header.createDiv({ cls: "simple-template-manager-actions" });
    const add = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "添加规则" } });
    setActionIcon(add, "plus", "plain");
    add.addEventListener("click", runAsync(async () => {
      this.plugin.settings.filterRules.push(makeFilterRule());
      await this.plugin.saveSettings();
      refresh();
    }));

    const table = this.createScrollableTable(card, "超链接标题过滤规则", "simple-settings-filter-table");
    const head = table.createDiv({ cls: "simple-rule-row simple-rule-head" });
    head.createDiv({ text: "启用" });
    head.createDiv({ text: "URL 匹配正则" });
    head.createDiv({ text: "标题提取正则" });
    head.createDiv({ text: "替换为" });
    head.createDiv();

    for (let i = 0; i < this.plugin.settings.filterRules.length; i++) {
      const rule = this.plugin.settings.filterRules[i];
      const row = table.createDiv({ cls: "simple-rule-row" });
      const toggleWrap = row.createDiv({ cls: "simple-rule-toggle" });
      const checkbox = toggleWrap.createEl("input", {
        type: "checkbox",
        attr: { "aria-label": `启用第 ${i + 1} 条过滤规则` },
      });
      checkbox.checked = rule.enabled;
      checkbox.addEventListener("change", runAsync(async () => {
        rule.enabled = checkbox.checked;
        await this.plugin.saveSettings();
      }));

      this.textInput(row, rule.urlPattern, "留空 = 全部", async (value) => {
        rule.urlPattern = value;
        await this.plugin.saveSettings();
      });
      this.textInput(row, rule.titleRegex, "正则表达式", async (value) => {
        rule.titleRegex = value;
        await this.plugin.saveSettings();
      });
      this.textInput(row, rule.replaceWith, "留空 = 拼接全部捕获组", async (value) => {
        rule.replaceWith = value;
        await this.plugin.saveSettings();
      });

      const del = styleActionButton(row.createEl("button", {
        cls: "simple-rule-del",
        attr: { "aria-label": "删除规则" },
      }), "bordered");
      setIcon(del, "x");
      del.addEventListener("click", runAsync(async () => {
        this.plugin.settings.filterRules.splice(i, 1);
        await this.plugin.saveSettings();
        refresh();
      }));
    }
  }

  private renderTemplateRules(container: HTMLElement, inline = false): void {
    if (!inline) this.renderPageHeader(container, "快速新建笔记", () => {
      this.displayPreviewTab = "shortcuts";
      this.openPage({ type: "overview" });
    });
    container = container.createDiv({ cls: "simple-template-rules-body" });

    const heading = container.createDiv({ cls: "simple-template-manager-heading" });
    new Setting(heading).setName(inline ? "快速新建笔记设置" : "笔记模板与生成规则").setHeading();
    const actions = heading.createDiv({ cls: "simple-template-manager-actions" });
    const iconButton = (icon: string, label: string): HTMLButtonElement => createActionButton(actions, icon, label);
    iconButton("bot", "用 AI 创建网站规则").addEventListener("click", () => this.openTemplateRuleHelp());
    iconButton("plus", "新增模板").addEventListener("click", () => this.openTemplateCreator());
    const importButton = iconButton("download", "导入模板或网站规则 JSON");
    iconButton("upload", "导出全部模板与网站规则").addEventListener("click", () => {
      downloadJsonFile("simple-template-categories.json", { type: "simple-plugin.template-categories", version: 1, categories: this.plugin.settings.templateCategories }, actions.ownerDocument);
    });
    importButton.addEventListener("click", runAsync(async (event: MouseEvent) => {
      const value = await importJsonFile(actions.ownerDocument);
      if (!value) return;
      const sample: unknown = Array.isArray(value) ? value[0] : value;
      const isSite = isRecord(sample) && ("urlPattern" in sample || "siteRule" in sample || sample.type === "simple-plugin.site-rules" || ("siteRules" in sample && !("outputFolder" in sample) && !("filenameField" in sample) && !("name" in sample)));
      if (isSite) {
        const rules = normalizeSiteRuleImport(value);
        if (!this.plugin.settings.templateCategories.length) { new Notice("请先新增模板，再导入网站规则"); return; }
        const menu = new Menu();
        menu.addItem(item => item.setTitle("选择网站规则使用的模板").setDisabled(true));
        for (const cat of this.plugin.settings.templateCategories) {
          menu.addItem(item => item.setTitle(cat.name || "未命名分类").setIcon("folder").onClick(runAsync(async () => {
            const counts = mergeSiteImports(cat.siteRules, rules);
            await this.plugin.saveSettings();
            this.renderSettings();
            this.showTemplateImportResult(counts);
          })));
        }
        menu.showAtMouseEvent(event);
      } else {
        const categories = normalizeCategoryImport(value);
        const counts = mergeTemplateImports(this.plugin.settings.templateCategories, categories);
        await this.plugin.saveSettings();
        this.renderSettings();
        this.showTemplateImportResult(counts);
      }
    }));
    const cats = this.plugin.settings.templateCategories;
    if (!cats.length) container.createEl("p", { cls: "simple-empty-text", text: "还没有模板，点击“新增模板”或导入已有 JSON 开始配置。" });
    for (const cat of cats) {
      const card = container.createEl("fieldset", { cls: "simple-preview-checkbox-group simple-template-source-card" });
      const legend = card.createEl("legend");
      legend.createSpan({ text: `模板 · ${cat.name || "未命名模板"}` });
      const editTemplate = createActionButton(legend, "pencil", `编辑模板：${cat.name}`);
      editTemplate.addClass("simple-template-edit");
      editTemplate.setAttribute("aria-label", "模板设置");
      editTemplate.addEventListener("click", () => this.openTemplateCreator(cat));
      card.createDiv({ cls: "setting-item-description simple-template-source-output", text: `保存位置：${cat.outputFolder || "当前库根目录"}；基础属性：${templatePropertyNames(cat).join("、") || "未设置"}` });
      for (const site of cat.siteRules) {
        const row = card.createDiv({ cls: "simple-template-source-row" });
        const edit = row.createEl("button", { cls: "simple-template-source-edit" });
        edit.createSpan({ text: siteSummary(site) || "未命名网站规则" });
        edit.setAttribute("aria-label", `编辑网站规则：${siteLabel(site)}`);
        edit.addEventListener("click", () => {
          this.openJsonModal(`编辑网站规则：${siteLabel(site)}`, formatJson(site), async value => {
            const index = cat.siteRules.findIndex(item => item.id === site.id);
            if (index < 0) return;
            cat.siteRules[index] = { ...normalizeSiteRule(value), id: site.id };
            await this.plugin.saveSettings();
            this.renderSettings();
          }, false, async () => {
            if (!await confirmAction(this.app, `删除网站规则“${siteLabel(site)}”？`)) return false;
            cat.siteRules = cat.siteRules.filter(item => item.id !== site.id);
            await this.plugin.saveSettings();
            this.renderSettings();
            return true;
          }, `simple-site-rule-${slugify(site.name || site.id)}.json`);
        });
      }
      if (!cat.siteRules.length) card.createEl("p", { cls: "simple-empty-text", text: "还没有网站来源，点击下方“添加网站”开始配置。" });
      const addSite = createActionButton(card, "plus", "添加网站", "bordered");
      addSite.addClass("simple-template-source-add");
      addSite.addEventListener("click", () => {
        this.openJsonModal(`添加网站：${cat.name}`, "", async value => {
          const counts = mergeSiteImports(cat.siteRules, normalizeSiteRuleImport(value));
          await this.plugin.saveSettings();
          this.renderSettings();
          this.showTemplateImportResult(counts);
        }, true);
      });
    }
  }

  private showTemplateImportResult(counts: ImportCounts): void {
    new Notice(`导入完成：新增 ${counts.added}，更新 ${counts.updated}，跳过重复 ${counts.skipped}`);
  }

  private openTemplateRuleHelp(): void {
    const modal = new Modal(this.app);
    modal.onOpen = () => {
      modal.contentEl.addClass("simple-settings");
      this.renderTemplateRuleHelp(modal.contentEl);
    };
    modal.onClose = () => modal.contentEl.empty();
    modal.open();
  }

  private renderTemplateRuleHelp(container: HTMLElement): void {
    const cats = this.plugin.settings.templateCategories;
    settingsGroup(container, "用 AI 创建网站规则", (card) => {
      card.createEl("p", { cls: "setting-item-description", text: "选择要添加网站的笔记模板，复制完整提示词发给 AI，并提供具体内容页链接及希望获取的信息。需要搜索时，再提供搜索页链接和关键词。" });
      const controls = card.createDiv({ cls: "simple-template-ai-controls" });
      const select = controls.createEl("select", { attr: { "aria-label": "选择要添加网站的模板" } });
      select.createEl("option", { text: "选择要添加网站的模板", value: "" });
      for (const template of cats) select.createEl("option", { text: template.name || "未命名模板", value: template.id });
      const copy = styleActionButton(controls.createEl("button", { cls: "simple-soft-button", text: "复制完整提示词" }), "text");
      copy.disabled = true;
      select.addEventListener("change", () => { copy.disabled = !cats.some(template => template.id === select.value); });
      copy.addEventListener("click", runAsync(async () => {
        const template = cats.find(item => item.id === select.value);
        if (!template) return;
        await navigator.clipboard.writeText(templateRuleCreationPrompt({ name: template.name, filenameField: template.filenameField, propertyFields: templatePropertyNames(template) }));
        new Notice("完整提示词已复制，包含所选模板的属性与规则说明");
      }));
      const steps = card.createEl("ol", { cls: "simple-template-rule-guide-steps" });
      steps.createEl("li", { text: "如果 AI 无法读取网页，可将网页另存为 HTML 文件后发给 AI。也可复制已有网站规则的 JSON 作为参考；番茄、起点含有内嵌处理机制，不适合作为普通网站规则的参考。" });
      steps.createEl("li", { text: "将 AI 生成的 JSON 添加到所选模板：点击“添加网站”，粘贴 JSON 或从文件导入，再用实际链接和搜索词检查结果。" });
      card.createEl("p", { cls: "setting-item-description", text: "适用于可从普通网页直接提取内容的网站。提示词已包含支持范围；需要专用接口或脚本时，会要求 AI 说明限制。" });
    });
  }

  private openTemplateCreator(existing?: TemplateCategory): void {
    new TemplateCreateModal(this.app, async template => {
      upsertById(this.plugin.settings.templateCategories, template);
      await this.plugin.saveSettings();
      this.renderSettings();
    }, existing, existing ? async () => {
      if (!await confirmAction(this.app, `删除模板“${existing.name}”及其中的网站规则？已生成的笔记会保留。`)) return false;
      this.plugin.settings.templateCategories = this.plugin.settings.templateCategories.filter(item => item.id !== existing.id);
      await this.plugin.saveSettings();
      this.renderSettings();
      return true;
    } : undefined, existing ? () => downloadJsonFile(`simple-template-${slugify(existing.name || existing.id)}.json`, { type: "simple-plugin.template-categories", version: 1, categories: [existing] }) : undefined, async (current, ownerDocument) => {
      const value = await importJsonFile(ownerDocument);
      if (!value) return null;
      const sample: unknown = Array.isArray(value) ? value[0] : value;
      const isSite = isRecord(sample) && ("urlPattern" in sample || "siteRule" in sample || sample.type === "simple-plugin.site-rules");
      const siteRules = [...current.siteRules];
      if (isSite) {
        mergeSiteImports(siteRules, normalizeSiteRuleImport(value));
        return { ...current, siteRules };
      }
      return importTemplateGroup(current, normalizeCategoryImport(value));
    }).open();
  }

  private createScrollableTable(container: HTMLElement, label: string, tableClass: string): HTMLElement {
    const scroll = container.createDiv({
      cls: "simple-settings-table-scroll",
      attr: { role: "region", "aria-label": label, tabindex: "0" },
    });
    return scroll.createDiv({ cls: tableClass });
  }

  private renderNavigationItem(
    container: HTMLElement,
    name: string,
    desc: string,
    onClick: () => void,
    icon?: string,
    status?: string
  ): void {
    const button = container.createEl("button", {
      cls: "setting-item simple-nav-setting",
      attr: { type: "button" },
    });
    const info = button.createSpan({ cls: "setting-item-info" });
    const nameEl = info.createSpan({ cls: "setting-item-name", text: name });
    info.createSpan({ cls: "setting-item-description", text: desc });
    const control = button.createSpan({ cls: "setting-item-control" });
    const arrow = control.createSpan({ cls: "simple-nav-setting-arrow" });
    arrow.setAttr("aria-hidden", "true");
    setIcon(arrow, "chevron-right");
    button.addEventListener("click", onClick);
    if (icon) {
      const iconEl = nameEl.createSpan({ cls: "simple-nav-setting-icon" });
      setIcon(iconEl, icon);
      nameEl.prepend(iconEl);
    }
    if (status) nameEl.createSpan({ cls: "simple-nav-status", text: status });
  }

  private renderPageHeader(
    container: HTMLElement,
    title: string,
    onBack = () => this.openPage({ type: "overview" })
  ): HTMLElement {
    const header = container.createDiv({ cls: "simple-page-header" });
    const back = styleActionButton(header.createEl("button", {
      cls: "simple-back-button",
      attr: { "aria-label": "返回" },
    }), "bordered");
    setIcon(back, "arrow-left");
    back.addEventListener("click", onBack);
    return new Setting(header).setName(title).setHeading().setClass("simple-page-title").nameEl;
  }

  private openPage(page: SettingsPage): void {
    if (page.type === "calendar-diary") {
      this.displayPreviewTab = this.plugin.settings.showCalendarDiaryEntry ? "calendar-diary" : "basic";
      page = { type: "overview" };
    }
    this.page = page;
    if (requireApiVersion("1.13.0") && page.type === "overview") {
      this.syncTab.hide();
      this.containerEl.empty();
      this.containerEl.removeClass("simple-settings");
      this.update();
    } else {
      this.renderSettings();
    }
  }

  private textInput(
    parent: HTMLElement,
    value: string,
    placeholder: string,
    onChange: (value: string) => Promise<void>
  ): HTMLInputElement {
    const input = parent.createEl("input", {
      type: "text",
      attr: { placeholder },
    });
    input.value = value;
    input.addEventListener("change", runAsync(async () => {
      await onChange(input.value);
    }));
    return input;
  }

  private renderDiarySettings(container: HTMLElement, inline = false, section: "all" | "appearance" | "files" = "all"): void {
    if (!inline) this.renderPageHeader(container, "日记位置", () => this.openPage({ type: "calendar-diary" }));
    const diary = this.plugin.settings.diary;
    const navigator = this.plugin.isMobile ? null : getNotebookNavigatorPlugin(this.app);
    const group = (title: string, render: (card: HTMLElement) => void): void => {
      const card = settingsFieldset(container, title);
      render(card);
    };
    if (section !== "files") group("日历外观", card => {
      const appearance = [
        ["显示月份导航", navigator?.settings.calendarShowYearCalendar ?? diary.showYearCalendar, async (value: boolean) => { if (navigator) navigator.settings.calendarShowYearCalendar = value; else diary.showYearCalendar = value; }],
        ["显示周号", navigator?.settings.calendarShowWeekNumber ?? diary.showWeekNumber, async (value: boolean) => { if (navigator) navigator.settings.calendarShowWeekNumber = value; else diary.showWeekNumber = value; }],
        ["高亮今天", navigator?.settings.calendarHighlightToday ?? diary.highlightToday, async (value: boolean) => { if (navigator) navigator.settings.calendarHighlightToday = value; else diary.highlightToday = value; }],
        ["阴影显示周末", navigator ? navigator.settings.calendarWeekendDays !== "none" : diary.showWeekends, async (value: boolean) => { if (navigator) navigator.settings.calendarWeekendDays = value ? "sat-sun" : "none"; else diary.showWeekends = value; }],
      ] as const;
      for (const [name, checked, change] of appearance) this.renderDisplayCheckbox(card, name, "", checked, async value => {
        await change(value);
        if (navigator) await navigator.saveSettingsAndUpdate();
        else { await this.plugin.saveSettings(); this.plugin.refreshDiaryViews(); }
      });

      const config = diary.dateManagement.anniversaries;
      const row = this.renderDisplayCheckbox(card, "显示常见纪念日", "在日历中显示已选择的纪念日。", config.enabled && config.showInCalendar, async value => {
        config.enabled = config.showInCalendar = value;
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
      });
      row.addClass("simple-reformat-option");
      const manage = row.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": "纪念日设置" } });
      setActionIcon(manage, "settings", "bordered");
      manage.addEventListener("click", () => this.openPage({ type: "date-management" }));
    });
    if (section !== "appearance") group("文件保存", card => this.renderDiaryFileSettings(card));
  }

  private renderDiaryFileSettings(card: HTMLElement): void {
    const diary = this.plugin.settings.diary;
    const field = (name: string, key: "folder" | "pathPattern" | "templatePath", hint: string): void => {
      new Setting(card).setName(name).setClass("simple-diary-file-row").addText(text => {
        text.setValue(diary[key]).setPlaceholder(hint);
        const save = async (value: string): Promise<void> => {
          diary[key] = value;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
        };
        text.onChange(save);
        if (key !== "pathPattern") this.diaryPathSuggestions.push(new DiaryPathSuggest(this.app, text.inputEl, key === "folder", path => {
          text.setValue(path);
          void runAsync(() => save(path))();
        }));
      });
    };
    field("日记文件夹", "folder", "输入或选择日记文件夹");
    field("日记路径命名规则", "pathPattern", "YYYY/MM/DD.md");
    field("日记模板", "templatePath", "留空不使用模板，输入以搜索笔记");
  }

  private renderQuickFormatHeadingSetting(card: HTMLElement, level: QuickFormatHeadingLevel, bodyFontSize: string): void {
    const quickFormat = this.plugin.settings.enhancements.quickFormat;
    const color = quickFormat.headingColors[level];
    const size = quickFormat.headingSizes[level];
    const fallback = readThemeColor(QUICK_FORMAT_HEADING_LABELS[level]);
    const currentSize = readRenderedFontSize(level);
    const row = this.renderDisplayCheckbox(card, `${level.toUpperCase()} 标题`,
      "勾选后显示在快捷菜单中",
      quickFormat.visibleModes.includes(level), async visible => {
        this.setQuickFormatModeVisible(level, visible);
        await this.plugin.saveSettings();
      });
    row.addClass("simple-theme-format-row");
    const controls = row.createDiv({ cls: "simple-theme-format-controls" });
    const input = controls.createEl("input", { type: "number", cls: "simple-display-parameter-input",
      attr: { min: "10", max: "96", step: "0.5", placeholder: stripPx(currentSize), "aria-label": `${level} 字号` } });
    input.value = size;
    setNativeTooltip(input, `当前字号 ${currentSize}${compareFontSizes(currentSize, bodyFontSize)}`);
    controls.createSpan({ text: "px", cls: "simple-display-parameter-unit" });
    input.addEventListener("change", runAsync(async () => {
      if (input.value && (!Number.isFinite(Number(input.value)) || Number(input.value) < 10 || Number(input.value) > 96)) return;
      quickFormat.headingSizes[level] = input.value ? String(Math.max(Number(input.value), Number.parseFloat(readRenderedFontSize()) || 0)) : "";
      this.updateThemeReset(reset, !!(input.value || quickFormat.headingColors[level]));
      await this.plugin.saveSettings();
      applyQuickFormatStyles(this.plugin);
      await repairHeadingFontSizes(this.plugin, true);
      input.value = quickFormat.headingSizes[level];
    }));
    const picker = new ThemeColorPicker(controls, this.plugin).setValue(color === "var(--text-normal)" ? fallback : color || fallback).onChange(async value => {
      if (this.refreshingThemeColor) return;
      quickFormat.headingColors[level] = value;
      this.updateThemeReset(reset, true);
      await this.plugin.saveSettings();
      applyQuickFormatStyles(this.plugin);
    });
    picker.buttonEl.setAttribute("aria-label", `${level} 颜色`);
    const reset = controls.createEl("button", { cls: "clickable-icon simple-format-reset", attr: { type: "button", "aria-label": tooltipText(`${level}：恢复当前主题字号和颜色`, "恢复当前主题") } });
    setActionIcon(reset, "rotate-ccw");
    const refresh = (): void => {
      if (input.ownerDocument.activeElement !== input) input.value = quickFormat.headingSizes[level];
      this.updateThemeReset(reset, !!(quickFormat.headingSizes[level] || quickFormat.headingColors[level]));
      const current = readRenderedFontSize(level);
      input.placeholder = stripPx(current);
      setNativeTooltip(input, `当前字号 ${current}${compareFontSizes(current, readRenderedFontSize())}`);
      this.setThemeColor(picker, quickFormat.headingColors[level] === "var(--text-normal)" ? readThemeColor(QUICK_FORMAT_HEADING_LABELS[level]) : quickFormat.headingColors[level] || readThemeColor(QUICK_FORMAT_HEADING_LABELS[level]));
    };
    this.watchThemeControl(row, refresh);
    reset.addEventListener("click", runAsync(async () => {
      quickFormat.headingSizes[level] = "";
      quickFormat.headingColors[level] = "";
      await this.plugin.saveSettings();
      applyQuickFormatStyles(this.plugin);
      await repairHeadingFontSizes(this.plugin, true);
      input.value = quickFormat.headingSizes[level];
      const restoredSize = readRenderedFontSize(level);
      input.placeholder = stripPx(restoredSize);
      setNativeTooltip(input, `当前字号 ${restoredSize}${compareFontSizes(restoredSize, readRenderedFontSize())}`);
      this.setThemeColor(picker, readThemeColor(QUICK_FORMAT_HEADING_LABELS[level]));
      refresh();
    }));
  }

  private renderQuickFormatCalloutSettings(container: HTMLElement, standalone = true): void {
    if (standalone) this.renderPageHeader(container, "引用与 Callout", () => this.openPage({ type: "overview" }));
    const quickFormat = this.plugin.settings.enhancements.quickFormat;
    const card = container.createDiv({ cls: "simple-callout-settings-list" });
    const refresh = (): void => {
      const scroller = card.closest<HTMLElement>(".vertical-tab-content, .modal-content");
      const scrollTop = scroller?.scrollTop;
      card.empty();
      render();
      if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
    };
    const render = (): void => {
      for (const definition of QUICK_FORMAT_CALLOUTS) {
        const mode: QuickFormatMode = `callout-${definition.type}`;
        this.renderQuickFormatColorSetting(
          card,
          definition.label,
          mode,
          readCalloutColorHex(definition.type, container),
          definition.icon
        );
      }
      for (const callout of quickFormat.customCallouts) {
        this.renderCustomCalloutSetting(card, callout, refresh);
      }
      const addButton = card.createEl("button", {
        cls: "simple-custom-callout-add",
        attr: { type: "button", "aria-label": "增加自定义 Callout" },
      });
      setActionIcon(addButton.createSpan(), "plus", "text");
      addButton.createSpan({ text: "增加" });
      addButton.addEventListener("click", runAsync(async () => {
        const id = nextId();
        const mode: QuickFormatMode = `custom-callout:${id}`;
        quickFormat.customCallouts.push({ id, type: "custom", label: "Custom", color: "" });
        quickFormat.visibleModes = [...new Set([...quickFormat.visibleModes, mode])];
        await this.plugin.saveSettings();
        refresh();
      }));
    };
    render();
  }

  private renderQuickFormatColorSetting(
    card: HTMLElement,
    name: string,
    mode: QuickFormatMode,
    fallback: string,
    icon?: string
  ): void {
    const row = this.renderDisplayCheckbox(card, name,
      "勾选后显示在快捷菜单中",
      this.plugin.settings.enhancements.quickFormat.visibleModes.includes(mode), async visible => {
        this.setQuickFormatModeVisible(mode, visible);
        await this.plugin.saveSettings();
      });
    row.addClass("simple-theme-format-row");
    if (icon) {
      const label = row.querySelector("label");
      const iconEl = label?.createSpan({ cls: "simple-callout-setting-icon", attr: { "aria-hidden": "true" } });
      if (iconEl && label) {
        iconEl.style.color = fallback;
        setIcon(iconEl, icon);
        label.insertBefore(iconEl, label.children[1]);
      }
    }
  }

  private renderCustomCalloutSetting(card: HTMLElement, callout: QuickFormatCustomCallout, refresh: () => void): void {
    const mode: QuickFormatMode = `custom-callout:${callout.id}`;
    const fallback = readCalloutColorHex(callout.type || "note", card);
    const isEditing = this.editingCustomCalloutIds.has(callout.id);
    const setting = new Setting(card)
      .setClass("simple-custom-callout-setting");
    new ThemeColorPicker(setting.controlEl, this.plugin).setValue(callout.color || fallback).onChange(async value => {
      callout.color = value;
      await this.plugin.saveSettings();
      applyQuickFormatStyles(this.plugin);
      refresh();
    }).buttonEl.setAttribute("aria-label", "自定义 Callout 颜色");

    setting.settingEl.removeClass("setting-item");
    setting.settingEl.classList.toggle("is-editing", isEditing);
    setting.nameEl.empty();
    const checkbox = setting.nameEl.createEl("input", { type: "checkbox", attr: { "aria-label": tooltipText(callout.label || callout.type, "勾选后显示在快捷菜单中") } });
    checkbox.checked = this.plugin.settings.enhancements.quickFormat.visibleModes.includes(mode);
    checkbox.addEventListener("change", runAsync(async () => {
      this.setQuickFormatModeVisible(mode, checkbox.checked);
      await this.plugin.saveSettings();
    }));
    const iconEl = setting.nameEl.createSpan({ cls: "simple-callout-setting-icon" });
    iconEl.style.color = callout.color || fallback;
    setIcon(iconEl, "message-square");

    let nameInput: HTMLInputElement | null = null;
    if (isEditing) {
      nameInput = setting.nameEl.createEl("input", {
        cls: "simple-custom-callout-name-input",
        type: "text",
        attr: { placeholder: "自定义 Callout 名称", "aria-label": "自定义 Callout 名称" },
      });
      nameInput.value = callout.type;
      window.setTimeout(() => {
        nameInput?.focus();
        nameInput?.select();
      }, 0);
    } else {
      const name = setting.nameEl.createSpan({
        cls: "simple-custom-callout-name",
        text: callout.label || callout.type || "未命名",
        attr: { role: "button", tabindex: "0", "aria-label": "点击重命名" },
      });
      const startEditing = (): void => {
        this.editingCustomCalloutIds.add(callout.id);
        refresh();
      };
      name.addEventListener("click", startEditing);
      name.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          startEditing();
        }
      });
    }

    let editingFinished = false;
    const finishEditing = async (): Promise<void> => {
      if (!nameInput || editingFinished) return;
      const value = nameInput.value.trim().toLowerCase();
      if (!value) {
        nameInput.value = callout.type;
        new Notice("Callout 名称不能为空");
        return;
      }
      callout.type = value;
      callout.label = value;
      editingFinished = true;
      this.editingCustomCalloutIds.delete(callout.id);
      await this.plugin.saveSettings();
      applyQuickFormatStyles(this.plugin);
      refresh();
    };

    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finishEditing();
      } else if (event.key === "Escape") {
        event.preventDefault();
        editingFinished = true;
        this.editingCustomCalloutIds.delete(callout.id);
        refresh();
      }
    });

    nameInput?.addEventListener("blur", runAsync(finishEditing));

    const deleteButton = setting.controlEl.createEl("button", {
      cls: "clickable-icon simple-danger-icon-button simple-custom-callout-delete",
      attr: { type: "button", "aria-label": "删除自定义 Callout" },
    });
    setDeleteIcon(deleteButton, "plain");
    deleteButton.addEventListener("click", () => {
      new ConfirmDeleteModal(
        this.app,
        "删除自定义 Callout",
        `确定删除“${callout.label || callout.type || "未命名"}”吗？`,
        async () => {
          this.editingCustomCalloutIds.delete(callout.id);
          const quickFormat = this.plugin.settings.enhancements.quickFormat;
          quickFormat.customCallouts = quickFormat.customCallouts.filter((item) => item.id !== callout.id);
          quickFormat.visibleModes = quickFormat.visibleModes.filter((item) => item !== mode);
          if (quickFormat.lastMode === mode) quickFormat.lastMode = "h3";
          await this.plugin.saveSettings();
          applyQuickFormatStyles(this.plugin);
          refresh();
        }
      ).open();
    });
  }

  private setQuickFormatModeVisible(mode: QuickFormatMode, visible: boolean): void {
    const quickFormat = this.plugin.settings.enhancements.quickFormat;
    quickFormat.visibleModes = visible
      ? [...new Set([...quickFormat.visibleModes, mode])]
      : quickFormat.visibleModes.filter((item) => item !== mode);
  }

  private renderDateManagementSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "纪念日设置", () => {
      this.openPage({ type: "calendar-diary" });
    });
    const diary = this.plugin.settings.diary;
    this.renderAnniversaryList(container, diary.anniversaries);
  }

  private renderHolidayManagementSettings(container: HTMLElement, inline = false): void {
    if (!inline) this.renderPageHeader(container, "假期安排设置", () => this.openPage({ type: "calendar-diary" }));
    const diary = this.plugin.settings.diary;
    const config = diary.dateManagement;

    const card = settingsFieldset(container, "假期安排导入");
    const source = (name: string, target: typeof config.nationalHolidays | typeof config.companyHolidays): void => {
      const row = this.renderDisplayCheckbox(card, name, "", target.enabled, async value => {
        target.enabled = target.showInCalendar = value;
        if (!config.nationalHolidays.enabled && !config.companyHolidays.enabled) config.holidaySetupReminder.enabled = false;
        await this.plugin.saveSettings(); this.plugin.refreshDiaryViews(); this.renderSettings();
      });
      row.addClass("simple-reformat-option");
      const manage = row.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": name + "设置" } });
      setActionIcon(manage, "settings", "bordered");
      manage.addEventListener("click", () => this.openPage({ type: target === config.nationalHolidays ? "holiday-national" : "holiday-company" }));
    };
    const tips = this.renderDisplayCheckbox(card, "在小贴士内提示导入缺少的假期安排", "创建日记时写入缺失年度假期安排的导入提示。", config.holidaySetupReminder.writeToTips, async value => {
      config.holidaySetupReminder.writeToTips = value; await this.plugin.saveSettings();
    });
    tips.addClass("simple-diary-tip-row");
    const advance = tips.createDiv({ cls: "simple-diary-advance" });
    advance.createSpan({ text: "提前天数" });
    const days = advance.createEl("input", { type: "number", attr: { min: "1", max: "365", "aria-label": tooltipText("下一年度假期安排导入提示的提前天数（自然日）", "按自然日提前检查下一年度假期安排") } });
    days.value = String(config.holidaySetupReminder.daysBefore || 7);
    days.addEventListener("change", runAsync(async () => {
      const value = Number(days.value);
      config.holidaySetupReminder.daysBefore = Number.isInteger(value) && value > 0 ? Math.min(365, value) : 7;
      days.value = String(config.holidaySetupReminder.daysBefore);
      await this.plugin.saveSettings();
    }));

    const importReminder = this.renderDisplayCheckbox(card, "缺少假期安排时提示导入", "缺少年度安排时在日记视图提示导入。", config.holidaySetupReminder.enabled, async value => {
      config.holidaySetupReminder.enabled = value && (config.nationalHolidays.enabled || config.companyHolidays.enabled);
      config.holidaySetupReminder.month = 12;
      await this.plugin.saveSettings(); this.renderSettings();
    });
    importReminder.addClass("simple-reformat-option");
    card.insertBefore(importReminder, tips);
    const help = importReminder.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": "AI 导入假期安排" } });
    setActionIcon(help, "bot", "bordered");
    help.addEventListener("click", () => {
      const modal = new Modal(this.app);
      modal.onOpen = () => {
        modal.contentEl.addClass("simple-settings");
        modal.titleEl.setText("用 AI 整理假期安排");
        this.renderHolidayImportGuide(modal.contentEl);
      };
      modal.onClose = () => modal.contentEl.empty();
      modal.open();
    });
    source("启用国家法定假期安排", config.nationalHolidays);
    source("启用公司假期安排", config.companyHolidays);

  }

  private renderHolidaySourceSettings(container: HTMLElement, source: HolidaySource): void {
    const title = source === "national" ? "国家法定假期安排" : "公司假期安排";
    this.renderPageHeader(container, title, () => {
      this.openPage({ type: "calendar-diary" });
    });
    const body = container.createDiv({ cls: "simple-calendar-settings" });
    this.renderHolidayScheduleList(body, this.plugin.settings.diary.holidaySchedules, source, title, `还没有导入${title}，点击导入添加。`);
  }

  private renderAnniversaryList(container: HTMLElement, anniversaries: Anniversary[]): void {

    if (!anniversaries.length) {
      const card = settingsFieldset(container, "纪念日", "simple-date-list-card");
      card.createDiv({ cls: "simple-empty-text", text: "还没有纪念日。" });
      return;
    }
    const visibleAnniversaries = sortAnniversariesForDisplay(
      this.anniversaryTagFilter === "全部"
        ? anniversaries
        : anniversaries.filter((anniversary) => anniversary.tags?.includes(this.anniversaryTagFilter)),
      this.anniversaryTagFilter
    );

    const card = settingsFieldset(container, "纪念日", "simple-date-list-card");
    const tags = anniversaryTags(anniversaries);
    const tagWrap = card.createDiv({ cls: "simple-anniversary-tags" });
    for (const tag of tags) {
      const button = tagWrap.createEl("button", {
        cls: this.anniversaryTagFilter === tag ? "simple-anniversary-tag is-selected" : "simple-anniversary-tag",
        text: tag,
      });
      button.addEventListener("click", () => {
        this.anniversaryTagFilter = tag;
        this.renderSettings();
      });
    }

    if (visibleAnniversaries.length === 0) {
      card.createDiv({ cls: "simple-empty-text", text: "这个标签下还没有纪念日。" });
      if (this.anniversaryTagFilter === "自定义") {
        this.renderAddCustomAnniversaryRow(card, anniversaries);
      }
      return;
    }

    const allCalendarVisible = visibleAnniversaries.every((anniversary) => anniversary.enabled && anniversary.showInCalendar !== false);
    const allReminderEnabled = visibleAnniversaries.every((anniversary) => anniversary.reminderEnabled);
    const table = this.createScrollableTable(card, "纪念日列表", "simple-settings-anniversary-table");
    const tableHead = table.createDiv({ cls: "simple-anniversary-table-head" });
    tableHead.createDiv({ text: "节日名称" });
    tableHead.createDiv({ text: "日期" });
    const calendarHead = tableHead.createDiv({ cls: "simple-anniversary-head-control" });
    const calendarBatchButton = calendarHead.createEl("button", {
      cls: allCalendarVisible ? "simple-state-button is-active" : "simple-state-button",
      attr: { "aria-label": "批量切换日历显示" },
    });
    setIcon(calendarBatchButton, allCalendarVisible ? "eye" : "eye-off");
    calendarHead.createSpan({ text: "显示" });
    calendarBatchButton.addEventListener("click", runAsync(async () => {
      for (const anniversary of visibleAnniversaries) {
        anniversary.enabled = true;
        anniversary.showInCalendar = !allCalendarVisible;
      }
      await this.plugin.saveSettings();
      this.plugin.refreshDiaryViews();
      this.renderSettings();
    }));
    const reminderHead = tableHead.createDiv({ cls: "simple-anniversary-head-control" });
    const reminderBatchButton = reminderHead.createEl("button", {
      cls: allReminderEnabled ? "simple-state-button is-active" : "simple-state-button",
      attr: { "aria-label": "批量切换提醒" },
    });
    setIcon(reminderBatchButton, allReminderEnabled ? "bell" : "bell-off");
    reminderHead.createSpan({ text: "提醒" });
    reminderBatchButton.addEventListener("click", runAsync(async () => {
      for (const anniversary of visibleAnniversaries) {
        anniversary.reminderEnabled = !allReminderEnabled;
        anniversary.sameDayReminderEnabled = !allReminderEnabled;
        if (allReminderEnabled) anniversary.advanceReminderEnabled = false;
        if (anniversary.reminderDaysBefore === undefined) anniversary.reminderDaysBefore = 0;
      }
      await this.plugin.saveSettings();
      this.renderSettings();
    }));
    tableHead.createDiv({ text: "编辑" });

    for (const anniversary of visibleAnniversaries) {
      const row = table.createDiv({ cls: "simple-date-row" });
      const main = row.createDiv({ cls: "simple-date-main" });
      const title = main.createDiv({ cls: "simple-date-title simple-anniversary-inline-title" });
      title.createSpan({ cls: "simple-anniversary-name", text: anniversary.name || "未命名纪念日" });
      const dateCell = row.createDiv({ cls: "simple-anniversary-date-cell" });
      dateCell.createSpan({ text: anniversaryDateSummary(anniversary) });
      const actions = row.createDiv({ cls: "simple-anniversary-actions" });
      const isCalendarVisible = anniversary.enabled && anniversary.showInCalendar !== false;
      const calendarButton = actions.createEl("button", {
        cls: isCalendarVisible ? "simple-state-button is-active" : "simple-state-button",
        attr: { "aria-label": isCalendarVisible ? "显示在日历" : "不显示在日历" },
      });
      setIcon(calendarButton, isCalendarVisible ? "eye" : "eye-off");
      calendarButton.addEventListener("click", runAsync(async () => {
        anniversary.enabled = true;
        anniversary.showInCalendar = !isCalendarVisible;
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
        this.renderSettings();
      }));
      const reminderCell = row.createDiv({ cls: "simple-anniversary-detail-cell" });
      const reminderButton = reminderCell.createEl("button", {
        cls: anniversary.reminderEnabled ? "simple-state-button is-active" : "simple-state-button",
        attr: { "aria-label": "提醒详情" },
      });
      setIcon(reminderButton, anniversary.reminderEnabled ? "bell" : "bell-off");
      reminderButton.addEventListener("click", () => {
        new AnniversaryDetailModal(this.app, anniversary, async (updated) => {
          Object.assign(anniversary, updated);
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
          this.renderSettings();
        }).open();
      });
      const editCell = row.createDiv({ cls: "simple-anniversary-detail-cell" });
      if (anniversary.tags?.includes("自定义")) {
        const editButton = editCell.createEl("button", {
          cls: "simple-state-button",
          attr: { "aria-label": "编辑纪念日" },
        });
        setActionIcon(editButton, "pencil", "plain");
        editButton.addEventListener("click", () => {
          new AnniversaryCreateModal(this.app, async (updated) => {
            Object.assign(anniversary, updated);
            await this.plugin.saveSettings();
            this.plugin.refreshDiaryViews();
            this.renderSettings();
          }, anniversary, async () => {
            const index = anniversaries.indexOf(anniversary);
            if (index >= 0) anniversaries.splice(index, 1);
            await this.plugin.saveSettings();
            this.plugin.refreshDiaryViews();
            this.renderSettings();
          }).open();
        });
      }
    }
    if (this.anniversaryTagFilter === "自定义") {
      this.renderAddCustomAnniversaryRow(card, anniversaries);
    }
  }

  private renderAddCustomAnniversaryRow(card: HTMLElement, anniversaries: Anniversary[]): void {
    card.addClass("simple-reformat-settings-group");
    const addButton = card.createEl("button", {
      cls: "clickable-icon simple-template-source-add",
      attr: { "aria-label": "新增自定义纪念日" },
    });
    setActionIcon(addButton, "plus", "bordered");
    addButton.addEventListener("click", () => {
      new AnniversaryCreateModal(this.app, async (anniversary) => {
        anniversaries.push(anniversary);
        this.anniversaryTagFilter = "自定义";
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
        this.renderSettings();
      }).open();
    });
  }

  private renderHolidayScheduleList(
    container: HTMLElement,
    schedules: HolidaySchedule[],
    source: HolidaySchedule["source"],
    title: string,
    emptyText: string
  ): void {
    const heading = container.createDiv({ cls: "simple-heading-row" });
    settingsHeading(heading, title);
    const headerActions = heading.createDiv({ cls: "simple-json-actions" });
    const importButton = styleActionButton(headerActions.createEl("button", { cls: "mod-cta simple-soft-button" }), "text");
    importButton.setText("导入");
    importButton.addEventListener("click", () => {
      new HolidayScheduleImportModal(this.app, title, source, async (schedule) => {
        upsertHolidaySchedule(this.plugin.settings.diary.holidaySchedules, schedule);
        this.holidayYearFilter[source] = schedule.year;
        const imported = this.plugin.settings.diary.holidaySchedules.find(item => item.source === source && item.year === schedule.year && item.name === schedule.name);
        if (imported) this.expandedHolidaySchedules.add(imported.id);
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
        new Notice(summarizeHolidaySchedule(schedule));
        this.renderSettings();
      }).open();
    });

    const exportButton = styleActionButton(headerActions.createEl("button", {
      cls: "simple-soft-button",
      text: "导出",
      attr: { "aria-label": tooltipText(`导出${title}`, "导出当前年份筛选下的假期安排") },
    }), "text");
    exportButton.addEventListener("click", () => {
      if (!filteredSchedules.length) {
        new Notice("当前没有可导出的假期安排");
        return;
      }
      downloadJsonFile(`simple-${source}-holidays-${selected === "all" ? "all" : selected}.json`, filteredSchedules, headerActions.ownerDocument);
    });

    const sourceSchedules = schedules.filter(schedule => schedule.source === source);
    const years = [...new Set(sourceSchedules.map(schedule => schedule.year))].sort((a, b) => b - a);
    const year = new Date().getFullYear();
    let selected = this.holidayYearFilter[source];
    if (selected !== "all" && (selected === undefined || !years.includes(selected))) selected = years.includes(year) ? year : years[0];
    if (years.length) {
      const select = headerActions.createEl("select", { attr: { "aria-label": "查看假期年份" } });
      select.createEl("option", { value: "all", text: "全部年份" });
      for (const year of years) select.createEl("option", { value: String(year), text: `${year} 年` });
      select.value = String(selected);
      select.addEventListener("change", () => {
        this.holidayYearFilter[source] = select.value === "all" ? "all" : Number(select.value);
        this.renderSettings();
      });
    }
    const card = container.createDiv({ cls: "simple-card simple-holiday-schedule-list" });
    const filteredSchedules = sourceSchedules.filter(schedule => selected === "all" || schedule.year === selected).sort((a, b) => b.year - a.year || a.name.localeCompare(b.name, "zh-CN"));
    if (!filteredSchedules.length) {
      card.createDiv({ cls: "simple-empty-text", text: emptyText });
      return;
    }
    let previousYear: number | undefined;
    for (const schedule of filteredSchedules) {
      if (selected === "all" && schedule.year !== previousYear) {
        new Setting(card).setName(`${schedule.year} 年`).setHeading().setClass("simple-holiday-year-heading");
        previousYear = schedule.year;
      }
      this.renderHolidayScheduleCard(card, schedules, schedule);
    }
  }

  private renderHolidayImportGuide(container: HTMLElement): void {
    const guide = container.createDiv({ cls: "simple-holiday-import-guide" });
    const text = guide.createDiv({ cls: "simple-holiday-import-guide-text" });
    text.createDiv({ cls: "simple-holiday-import-guide-title", text: "导入方式" });
    text.createDiv({
      cls: "setting-item-description",
      text: "先复制提示词，再复制网页或公司通知中的假期安排，一起发给 AI；将 AI 返回的 JSON 粘贴到对应模块的导入窗口。",
    });
    const actions = guide.createDiv({ cls: "simple-holiday-import-guide-actions" });
    const copy = styleActionButton(actions.createEl("button", { cls: "simple-soft-button" }), "text");
    copy.setText("复制提示词");
    copy.addEventListener("click", runAsync(async () => {
      await navigator.clipboard.writeText(holidayImportPrompt());
      new Notice("假期安排提示词已复制");
    }));
  }

  private renderHolidayScheduleCard(card: HTMLElement, schedules: HolidaySchedule[], schedule: HolidaySchedule): void {
    const comparison = schedule.source === "company" ? buildHolidayComparison(schedule, schedules) : null;
    const wrapper = card.createDiv({ cls: "simple-holiday-schedule-card" });
    const header = wrapper.createDiv({ cls: "simple-holiday-schedule-header" });
    const toggleWrap = header.createDiv({ cls: "simple-holiday-schedule-toggle" });
      new Setting(toggleWrap).addToggle((toggle) =>
          nativeCheckbox(toggle).setValue(schedule.enabled).onChange(async (value) => {
          schedule.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
          this.renderSettings();
        })
      );
    const main = header.createDiv({ cls: "simple-holiday-schedule-main" });
    main.createDiv({ cls: "simple-date-title", text: schedule.name || `${schedule.year} 年假期安排` });
    main.createDiv({ cls: "setting-item-description", text: holidayScheduleSummary(schedule) });
    const side = header.createDiv({ cls: "simple-holiday-schedule-side" });
    if (comparison && comparison.differenceDates.size > 0) {
      const diff = side.createDiv({ cls: "simple-holiday-diff-summary" });
      diff.createSpan({ cls: "simple-holiday-diff-badge", text: "异" });
      diff.createSpan({ text: `与国家法定安排不同 ${comparison.differenceDates.size} 天` });
    }

    const actions = header.createDiv({ cls: "simple-json-actions" });
    const expanded = this.expandedHolidaySchedules.has(schedule.id);
    const expand = styleActionButton(actions.createEl("button", {
      attr: { "aria-label": expanded ? "收起" : "展开" },
    }), "bordered");
    setIcon(expand, expanded ? "chevron-up" : "chevron-down");
    expand.addEventListener("click", () => {
      if (expanded) this.expandedHolidaySchedules.delete(schedule.id);
      else this.expandedHolidaySchedules.add(schedule.id);
      this.renderSettings();
    });
    const del = actions.createEl("button", {
      cls: "simple-danger-button",
      attr: { "aria-label": "删除" },
    });
    setDeleteIcon(del, "plain");
    del.addEventListener("click", runAsync(async () => {
      const index = schedules.findIndex((item) => item.id === schedule.id);
      if (index >= 0) schedules.splice(index, 1);
      await this.plugin.saveSettings();
      this.plugin.refreshDiaryViews();
      this.renderSettings();
    }));

    if (!expanded) return;
    const groups = groupHolidayScheduleDays(schedule);
    const timeline = wrapper.createDiv({ cls: "simple-holiday-timeline" });
    for (const group of groups) {
      this.renderHolidayScheduleGroup(timeline, group, comparison);
    }
  }

  private renderHolidayScheduleGroup(container: HTMLElement, group: HolidayScheduleGroup, comparison: HolidayComparison | null): void {
    const section = container.createDiv({ cls: "simple-holiday-group" });
    const header = section.createDiv({ cls: "simple-holiday-group-header" });
    header.createDiv({ cls: "simple-holiday-group-title", text: group.title });
    header.createDiv({ cls: "simple-holiday-group-meta", text: holidayGroupSummary(group) });

    const grid = section.createDiv({ cls: "simple-holiday-week-grid" });
    for (const label of ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]) {
      grid.createDiv({ cls: "simple-holiday-weekday", text: label });
    }
    const dayMap = new Map(group.days.map((day) => [day.date, day]));
    for (const date of buildHolidayGroupGridDates(group)) {
      const key = formatIsoDate(date);
      const item = dayMap.get(key);
      const isDifferent = Boolean(item && comparison?.differenceDates.has(item.date));
      const cell = grid.createDiv({
        cls: item
          ? `simple-holiday-day is-${holidayStatusClass(item.status)}${isDifferent ? " has-difference" : ""}`
          : "simple-holiday-day is-empty",
      });
      const numberLine = cell.createDiv({ cls: "simple-holiday-day-topline" });
      numberLine.createDiv({ cls: "simple-holiday-day-number", text: String(date.getDate()) });
      if (isDifferent) {
        numberLine.createDiv({
          cls: "simple-holiday-diff-badge",
          text: "异",
          attr: { "aria-label": "与国家法定安排不同" },
        });
      }
      if (item) {
        cell.createDiv({ cls: "simple-holiday-day-label", text: compactHolidayStatusLabel(item.status) });
        if (item.label) cell.createDiv({ cls: "simple-holiday-day-note", text: item.label });
      }
    }
  }

  private renderRecurringRules(container: HTMLElement): void {
    const card = settingsFieldset(container, "待提醒事件", "simple-recurring-card simple-reformat-settings-group");
    const addButton = card.createEl("button", { cls: "clickable-icon simple-template-source-add", attr: { type: "button", "aria-label": "新增待提醒事件" } });
    setActionIcon(addButton, "plus", "bordered");
    addButton.addEventListener("click", () => {
      new RecurringRuleModal(this.app, "提醒编辑", makeRecurringRule(), async (rule) => {
        upsertById(this.plugin.settings.diary.recurringRules, rule);
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
        this.renderSettings();
      }).open();
    });

    const rules = this.plugin.settings.diary.recurringRules;
    if (rules.length === 0) {
      card.createDiv({
        cls: "simple-empty-text simple-recurring-empty",
        text: "还没有提醒。新增后，新建日记或点击右侧周期按钮时会自动补充到小贴士。",
      });
      return;
    }

    for (const rule of rules) {
      const row = this.renderDisplayCheckbox(card, rule.text || "未命名事件", "", rule.enabled, async value => {
        rule.enabled = value;
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
      });
      row.addClass("simple-reformat-option", "simple-recurring-event-row");
      row.createSpan({ cls: "simple-recurring-event-time", text: recurringRuleSummary(rule) });
      const edit = row.createEl("button", { cls: "simple-reformat-rule-link", attr: { type: "button", "aria-label": tooltipText(`编辑事件：${rule.text}`, "编辑事件") } });
      setActionIcon(edit, "pencil", "bordered");
      edit.addEventListener("click", () => {
        new RecurringRuleModal(this.app, "提醒编辑", rule, async updated => {
          const index = rules.findIndex(item => item.id === rule.id);
          if (index < 0) return;
          rules[index] = updated;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
          this.renderSettings();
        }, async () => {
          if (!await confirmAction(this.app, `删除事件“${rule.text}”？`)) return false;
          this.plugin.settings.diary.recurringRules = rules.filter(item => item.id !== rule.id);
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
          this.renderSettings();
          return true;
        }).open();
      });
    }
  }

  private openJsonModal(
    title: string,
    initialValue: string,
    onSave: (value: unknown) => Promise<void>,
    allowFileImport = false,
    onDelete?: () => Promise<boolean>,
    exportFilename?: string
  ): void {
    new JsonEditModal(this.app, title, initialValue, onSave, allowFileImport, onDelete, exportFilename).open();
  }

  private renderCalendarDiarySettings(container: HTMLElement, standalone = true): void {
    if (standalone) this.renderPageHeader(container, "日程");
    const diary = this.plugin.settings.diary;
    const body = container.createDiv({ cls: "simple-calendar-settings" });
    const main = settingsFieldset(body, "基础日记");
    this.renderDisplayCheckbox(main, "点击日期新建日记", "点击日历日期时创建日记；已有日记则直接打开。关闭后只打开已有日记。", diary.createDiaryOnDateClick !== false, async value => {
      diary.createDiaryOnDateClick = value; await this.plugin.saveSettings(); this.plugin.refreshDiaryViews();
    });
    this.renderDisplayCheckbox(main, "新建日记时结转未完成工作", "自动追踪近一日的未完成工作，并写入新日记。", diary.carryUnfinishedTasks, async value => {
      diary.carryUnfinishedTasks = value; await this.plugin.saveSettings(); this.plugin.refreshDiaryViews();
    });
    this.renderDisplayCheckbox(main, "在日记小贴士中写入事件、纪念日和假期提醒", "新建日记时按各项提醒规则写入小贴士。", diary.autoRemindersEnabled !== false, async value => {
      diary.autoRemindersEnabled = value;
      if (value) { diary.reminderTargetMode = "callout"; diary.tipsCallout = diary.tipsCallout || "小贴士"; }
      await this.plugin.saveSettings(); this.plugin.refreshDiaryViews();
    });
    this.renderDiaryFileSettings(main);
    this.renderRecurringRules(body);
    this.renderDiarySettings(body, true, "appearance");
    this.renderHolidayManagementSettings(body, true);
  }

}

class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-confirm-modal");
    this.contentEl.empty();
    this.titleEl.setText(this.title);
    this.contentEl.createDiv({ cls: "setting-item-description", text: this.message });
    const actions = this.contentEl.createDiv({ cls: "simple-confirm-actions" });
    styleActionButton(actions.createEl("button", { text: "取消" }), "text").addEventListener("click", () => this.close());
    const confirmButton = styleActionButton(actions.createEl("button", { cls: "mod-warning", text: "确认删除" }), "text");
    confirmButton.addEventListener("click", runAsync(async () => {
      confirmButton.disabled = true;
      await this.onConfirm();
      this.close();
    }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class JsonEditModal extends Modal {
  private textarea!: HTMLTextAreaElement;

  constructor(
    app: App,
    private readonly title: string,
    private readonly initialValue: string,
    private readonly onSave: (value: unknown) => Promise<void>,
    private readonly allowFileImport = false,
    private readonly onDelete?: () => Promise<boolean>,
    private readonly exportFilename?: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-json-modal");
    contentEl.toggleClass("simple-template-site-editor", !!this.onDelete);
    this.titleEl.setText(this.title);

    if (!this.onDelete) {
      const toolbar = contentEl.createDiv({ cls: "simple-json-modal-toolbar" });
      const iconButton = (icon: string, label: string): HTMLButtonElement => {
        const button = toolbar.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": label } });
        setActionIcon(button, icon);
        return button;
      };
      if (!this.allowFileImport) {
        const paste = iconButton("clipboard-paste", "粘贴");
        paste.addEventListener("click", runAsync(async () => {
          this.textarea.value = await navigator.clipboard.readText();
        }));
      }

      const copy = iconButton("copy", "复制");
      copy.addEventListener("click", runAsync(async () => {
        await navigator.clipboard.writeText(this.textarea.value);
        new Notice("JSON 已复制到剪贴板");
      }));

      if (this.allowFileImport) {
        iconButton("download", "从 JSON 文件导入").addEventListener("click", runAsync(async () => {
          const value = await importJsonFile(contentEl.ownerDocument);
          if (value) this.textarea.value = formatJson(value);
        }));
        iconButton("upload", "导出当前 JSON").addEventListener("click", () => {
          if (!this.textarea.value.trim()) {
            new Notice("请先填写或导入 JSON");
            return;
          }
          try {
            downloadJsonFile(this.exportFilename ?? "simple-one-site-rule.json", JSON.parse(this.textarea.value));
          } catch {
            new Notice("JSON 无效，请修正后导出");
          }
        });
      }

    }
    this.textarea = contentEl.createEl("textarea", { cls: "simple-json-textarea" });
    this.textarea.value = this.initialValue;
    if (this.allowFileImport) {
      this.textarea.placeholder = "粘贴 JSON，或将 JSON 文件拖入此窗口";
      this.modalEl.addEventListener("dragover", event => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      });
      this.modalEl.addEventListener("drop", event => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        const files = Array.from(event.dataTransfer.files);
        if (files.length !== 1 || !/\.json$/i.test(files[0].name)) {
          new Notice("请每次拖入一个 JSON 文件");
          return;
        }
        void files[0].text().then(text => {
          const value: unknown = JSON.parse(text);
          this.textarea.value = formatJson(value);
        }).catch(error => new Notice(`导入失败：${error instanceof Error ? error.message : String(error)}`));
      });
    }

    if (this.onDelete) {
      const heading = contentEl.createDiv({ cls: "simple-site-editor-heading" });
      const title = contentEl.querySelector("h2")!;
      contentEl.insertBefore(heading, title);
      heading.appendChild(title);
      const toggle = heading.createEl("button", { text: "测试", cls: "simple-site-test-toggle", attr: { type: "button", "aria-expanded": "false" } });
      const panel = contentEl.createEl("fieldset", { cls: "simple-site-test-panel" });
      panel.createEl("legend", { text: "规则测试" });
      panel.hidden = true;
      const inputs = panel.createDiv({ cls: "simple-site-test-inputs" });
      const urlLabel = inputs.createEl("label", { text: "详情页 URL" });
      const url = urlLabel.createEl("input", { type: "url", attr: { placeholder: "HTTPS://…", "aria-label": "测试详情页 URL" } });
      const queryLabel = inputs.createEl("label", { text: "搜索关键词" });
      const query = queryLabel.createEl("input", { type: "text", attr: { "aria-label": "测试搜索关键词" } });
      query.value = "我的";
      const actions = panel.createDiv({ cls: "simple-site-test-actions" });
      const run = styleActionButton(actions.createEl("button", { text: "测试", cls: "mod-cta simple-site-test-run", attr: { type: "button" } }), "text");
      const results = panel.createDiv({ cls: "simple-site-test-results", attr: { "aria-live": "polite" } });
      panel.insertBefore(results, inputs);
      contentEl.insertBefore(panel, this.textarea);
      let revision = 0;
      const report = (message: string, state: "passed" | "failed" | "info"): void => {
        results.createDiv({ text: message, cls: `is-${state}` });
      };
      const inspect = (): void => {
        results.empty();
        try {
          const rule = normalizeSiteRule(JSON.parse(this.textarea.value));
          const hasUrl = !!rule.urlPattern && rule.fields.some(field => !!field.source);
          const hasSearch = !!rule.search && rule.search.enabled !== false && !!rule.search.searchUrl && !!rule.search.resultList;
          urlLabel.hidden = !hasUrl;
          queryLabel.hidden = !hasSearch;
          run.hidden = !hasUrl && !hasSearch;
          report(`URL 转笔记：${hasUrl ? "存在规则，未测试" : "不存在规则，无需测试"}。`, "info");
          url.required = hasUrl;
          report(`搜索：${hasSearch ? "存在规则，未测试" : "不存在规则，无需测试"}。`, "info");
          const intro = hasSearch && (!!rule.search?.resultIntro || rule.handler === "fanqieNovel" || rule.search?.type === "fanqieApi");
          report(`搜索简介：${intro ? "存在规则，未测试" : "不存在规则，无需测试"}。`, "info");
        } catch (error) {
          urlLabel.hidden = queryLabel.hidden = run.hidden = true;
          report(`规则检查失败：${error instanceof Error ? error.message : String(error)}`, "failed");
        }
      };
      const invalidate = (): void => { revision++; inspect(); };
      this.textarea.addEventListener("input", () => { revision++; if (!panel.hidden) inspect(); });
      url.addEventListener("input", invalidate);
      query.addEventListener("input", invalidate);
      toggle.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute("aria-expanded", String(!panel.hidden));
        if (!panel.hidden) inspect();
      });
      run.addEventListener("click", runAsync(async () => {
        const current = ++revision;
        results.empty();
        run.disabled = true;
        run.setText("测试中…");
        try {
          const rule = normalizeSiteRule(JSON.parse(this.textarea.value));
          const checks = checkTemplateSiteRule(rule, contentEl.ownerDocument);
          const urlCheck = checks[0];
          const searchCheck = checks[1];
          const hasUrl = !!rule.urlPattern && rule.fields.some(field => !!field.source);
          const hasSearch = !!rule.search && rule.search.enabled !== false && !!rule.search.searchUrl && !!rule.search.resultList;
          if (hasUrl && !url.value.trim()) {
            inspect();
            report("请填写详情页 URL 后再测试。", "failed");
            url.focus();
            return;
          }
          if (!hasUrl) report("URL 转笔记：不存在规则，无需测试。", "info");
          else if (!urlCheck.passed) report(`URL 转笔记：未通过，${urlCheck.message}`, "failed");
          if (!hasSearch) report("搜索：不存在规则，无需测试。", "info");
          else if (!searchCheck.passed) report(`搜索：未通过，${searchCheck.message}`, "failed");
          else if (!query.value.trim()) report("搜索：存在规则，未测试（未填写关键词）。", "info");
          const intro = hasSearch && (!!rule.search?.resultIntro || rule.handler === "fanqieNovel" || rule.search?.type === "fanqieApi");
          if (!intro) report("搜索简介：不存在规则，无需测试。", "info");
          else if (!query.value.trim() || !searchCheck.passed) report("搜索简介：存在规则，未测试。", "info");
          const testUrl = hasUrl && urlCheck.passed ? url.value.trim() : "";
          const testQuery = hasSearch && searchCheck.passed ? query.value.trim() : "";
          if (testUrl || testQuery) {
            const messages = await testTemplateSiteRule(rule, testUrl, testQuery);
            if (current === revision) for (const message of messages) report(message, message.includes("未通过") ? "failed" : "passed");
          }
        } catch (error) { if (current === revision) report(`测试失败：${error instanceof Error ? error.message : String(error)}`, "failed"); }
        finally { run.disabled = false; run.setText("测试"); }
      }));
    }

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const setBusy = (busy: boolean): void => {
      this.textarea.disabled = busy;
      footer.querySelectorAll("button").forEach(button => { button.disabled = busy; });
    };
    if (this.onDelete) {
      const remove = footer.createEl("button", { cls: "simple-template-delete", attr: { type: "button", "aria-label": "删除网站规则" } });
      setDeleteIcon(remove, "danger");
      remove.addEventListener("click", runAsync(async () => {
        setBusy(true);
        try { if (await this.onDelete?.()) this.close(); }
        finally { setBusy(false); }
      }));
    }
    if (this.exportFilename) {
      footer.addClass("simple-template-export-footer");
      const download = footer.createEl("button", { cls: "clickable-icon simple-template-export", attr: { "aria-label": "导出此网站规则" } });
      setActionIcon(download, "upload", "bordered");
      download.addEventListener("click", () => {
        try { downloadJsonFile(this.exportFilename!, JSON.parse(this.textarea.value), contentEl.ownerDocument); }
        catch { new Notice("JSON 无效，请修正后导出"); }
      });
      if (this.onDelete) {
        footer.addClass("simple-template-import-footer");
        const importButton = footer.createEl("button", { cls: "clickable-icon simple-template-import", attr: { type: "button", "aria-label": "导入此网站规则" } });
        setActionIcon(importButton, "download", "bordered");
        importButton.addEventListener("click", runAsync(async () => {
          const value = await importJsonFile(contentEl.ownerDocument);
          if (!value) return;
          if (isRecord(value) && ("categories" in value || "category" in value)) throw new Error("此处仅导入单条网站规则，模板组请在分组设置中导入");
          const rules = normalizeSiteRuleImport(value);
          if (rules.length !== 1) throw new Error("此处仅支持单条网站规则，多条规则请在分组中导入");
          const original = normalizeSiteRule(JSON.parse(this.initialValue));
          this.textarea.value = formatJson({ ...rules[0], id: original.id });
          this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
          new Notice("已导入此网站规则，点击保存后生效");
        }));
      }
    }
    const cancel = styleActionButton(footer.createEl("button"), "text");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = styleActionButton(footer.createEl("button", { cls: "mod-cta" }), "text");
    save.setText("保存");
    save.addEventListener("click", runAsync(async () => {
      setBusy(true);
      try {
        const parsed: unknown = JSON.parse(this.textarea.value);
        await this.onSave(parsed);
        this.close();
      } catch (error) {
        new Notice(`JSON 无效：${error instanceof Error ? error.message : String(error)}`);
      } finally { setBusy(false); }
    }));
    styleActionFooter(footer);
  }

}

class HolidayScheduleImportModal extends Modal {
  private textarea!: HTMLTextAreaElement;

  constructor(
    app: App,
    private readonly title: string,
    private readonly source: HolidaySource,
    private readonly onImport: (schedule: HolidaySchedule) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-json-modal");
    this.titleEl.setText(`${this.title}导入`);
    contentEl.createDiv({
      cls: "setting-item-description",
      text: "将 AI 整理后的 JSON 粘贴到这里。连续假期需要逐日展开，每个涉及放假、调休或公司安排的日期都单独一条。",
    });

    const toolbar = contentEl.createDiv({ cls: "simple-json-modal-toolbar" });
    const paste = toolbar.createEl("button");
    paste.setText("粘贴");
    paste.addEventListener("click", runAsync(async () => {
      this.textarea.value = await navigator.clipboard.readText();
    }));

    const fileImport = styleActionButton(toolbar.createEl("button", { text: "从文件导入" }), "text");
    fileImport.addEventListener("click", runAsync(async () => {
      const value = await importJsonFile(contentEl.ownerDocument);
      if (value !== null && value !== undefined) this.textarea.value = JSON.stringify(value, null, 2);
    }));

    this.textarea = contentEl.createEl("textarea", {
      cls: "simple-json-textarea",
      attr: { placeholder: "粘贴 AI 返回的 JSON" },
    });

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const cancel = styleActionButton(footer.createEl("button"), "text");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = styleActionButton(footer.createEl("button", { cls: "mod-cta" }), "text");
    save.setText("校验并导入");
    save.addEventListener("click", runAsync(async () => {
      try {
        const parsed: unknown = JSON.parse(this.textarea.value);
        const schedules = normalizeHolidayImports(parsed, this.source);
        for (const schedule of schedules) await this.onImport(schedule);
        this.close();
      } catch (error) {
        new Notice(`JSON 无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
}

class AnniversaryDetailModal extends Modal {
  private draft: Anniversary;
  private advanceEl!: HTMLElement;

  constructor(
    app: App,
    anniversary: Anniversary,
    private readonly onSave: (anniversary: Anniversary) => Promise<void>
  ) {
    super(app);
    this.draft = {
      ...anniversary,
      tags: anniversary.tags ? [...anniversary.tags] : [],
      weekdayRule: anniversary.weekdayRule ? { ...anniversary.weekdayRule } : undefined,
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-anniversary-modal");
    this.titleEl.setText(this.draft.name || "提醒详情");
    contentEl.createDiv({ cls: "setting-item-description", text: anniversarySummary(this.draft) });

    new Setting(contentEl)
      .setName("当日提醒")
      .setDesc("开启后，创建当天日记时写入这条纪念日提醒。")
      .addToggle((toggle) =>
          nativeCheckbox(toggle).setValue(this.draft.sameDayReminderEnabled ?? this.draft.reminderEnabled).onChange((value) => {
          this.draft.sameDayReminderEnabled = value;
          this.syncReminderEnabled();
        })
      );

    new Setting(contentEl)
      .setName("提前提醒")
      .setDesc("开启后，按提前工作日写入预告；留空时使用 7 个工作日。")
      .addToggle((toggle) =>
          nativeCheckbox(toggle).setValue(Boolean(this.draft.advanceReminderEnabled)).onChange((value) => {
          this.draft.advanceReminderEnabled = value;
          if (value && !this.draft.reminderDaysBefore) this.draft.reminderDaysBefore = 7;
          this.syncReminderEnabled();
          this.renderAdvanceControls();
        })
      );

    this.advanceEl = contentEl.createDiv({ cls: "simple-anniversary-detail-controls" });
    this.renderAdvanceControls();

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const cancel = styleActionButton(footer.createEl("button"), "text");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = styleActionButton(footer.createEl("button", { cls: "mod-cta" }), "text");
    save.setText("保存");
    save.addEventListener("click", runAsync(async () => {
      await this.onSave({ ...this.draft, reminderText: "", outputFormat: "task" });
      this.close();
    }));
  }

  private renderAdvanceControls(): void {
    this.advanceEl.empty();
    if (!this.draft.advanceReminderEnabled) {
      this.advanceEl.createDiv({
        cls: "setting-item-description",
        text: "未开启提前提醒时，只会按当日提醒设置写入。",
      });
      return;
    }

    new Setting(this.advanceEl)
      .setName("提前工作日")
      .setDesc("默认提前 7 个工作日写入待办。")
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.draft.reminderDaysBefore || 7))
          .onChange((value) => {
            const trimmed = value.trim();
            const parsed = Number(trimmed);
            this.draft.reminderDaysBefore = trimmed && Number.isInteger(parsed) && parsed > 0 ? Math.min(365, parsed) : 7;
            this.syncReminderEnabled();
          })
      );
  }

  private syncReminderEnabled(): void {
    this.draft.reminderEnabled = Boolean(this.draft.sameDayReminderEnabled || this.draft.advanceReminderEnabled);
  }
}

class AnniversaryCreateModal extends Modal {
  private draft: Anniversary = {
    id: nextId(),
    name: "",
    enabled: true,
    showInCalendar: true,
    tags: ["自定义"],
    dateType: "gregorian",
    month: 1,
    day: 1,
    reminderEnabled: true,
    sameDayReminderEnabled: true,
    advanceReminderEnabled: false,
    reminderDaysBefore: 0,
    outputFormat: "task",
  };
  private dateControlsEl!: HTMLElement;

  constructor(
    app: App,
    private readonly onSave: (anniversary: Anniversary) => Promise<void>,
    anniversary?: Anniversary,
    private readonly onDelete?: () => Promise<void>
  ) {
    super(app);
    if (anniversary) {
      this.draft = {
        ...anniversary,
        tags: anniversary.tags ? [...anniversary.tags] : ["自定义"],
        weekdayRule: anniversary.weekdayRule ? { ...anniversary.weekdayRule } : undefined,
      };
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-anniversary-modal");
    const isEditing = Boolean(this.draft.name);
    this.titleEl.setText(isEditing ? "编辑自定义纪念日" : "新增自定义纪念日");

    new Setting(contentEl)
      .setName("节日名称")
      .addText((text) =>
        text
          .setPlaceholder("例如：相识纪念日")
          .setValue(this.draft.name)
          .onChange((value) => {
            this.draft.name = value;
          })
      );

    new Setting(contentEl)
      .setName("日期规则")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gregorian", "阳历固定日期")
          .addOption("lunar", "农历固定日期")
          .addOption("weekday-rule", "第几周的星期几")
          .setValue(this.draft.dateType)
          .onChange((value) => {
            this.draft.dateType = value as Anniversary["dateType"];
            this.normalizeDateDraft();
            this.renderDateControls();
          })
      );

    this.dateControlsEl = contentEl.createDiv({ cls: "simple-anniversary-date-controls" });
    this.renderDateControls();

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    if (isEditing && this.onDelete) {
      const del = styleActionButton(footer.createEl("button", { cls: "mod-warning" }), "text");
      del.setText("删除");
      del.addEventListener("click", runAsync(async () => {
        if (!await confirmAction(this.app, "确定删除这个自定义纪念日吗？")) return;
        await this.onDelete?.();
        this.close();
      }));
    }

    const cancel = styleActionButton(footer.createEl("button"), "text");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = styleActionButton(footer.createEl("button", { cls: "mod-cta" }), "text");
    save.setText(isEditing ? "保存" : "新增");
    save.addEventListener("click", runAsync(async () => {
      const cleaned = cleanCustomAnniversary(this.draft);
      if (!cleaned.name.trim()) {
        new Notice("请先填写节日名称");
        return;
      }
      await this.onSave(cleaned);
      this.close();
    }));
  }

  private renderDateControls(): void {
    this.dateControlsEl.empty();
    this.dateControlsEl.addClass("is-child");
    if (this.draft.dateType === "weekday-rule") {
      const rule = this.draft.weekdayRule ?? { month: 1, nth: 1, weekday: 1 };
      new Setting(this.dateControlsEl)
        .setName("月份")
        .addDropdown((dropdown) => {
          for (let month = 1; month <= 12; month++) dropdown.addOption(String(month), `${month} 月`);
          dropdown.setValue(String(rule.month)).onChange((value) => {
            this.draft.weekdayRule = { ...rule, month: Number(value) };
          });
        });
      new Setting(this.dateControlsEl)
        .setName("第几个")
        .addDropdown((dropdown) => {
          for (let nth = 1; nth <= 5; nth++) dropdown.addOption(String(nth), `第 ${nth} 个`);
          dropdown.setValue(String(rule.nth)).onChange((value) => {
            this.draft.weekdayRule = { ...(this.draft.weekdayRule ?? rule), nth: Number(value) };
          });
        });
      new Setting(this.dateControlsEl)
        .setName("星期几")
        .addDropdown((dropdown) => {
          for (let weekday = 1; weekday <= 7; weekday++) dropdown.addOption(String(weekday), weekdayLabel(weekday));
          dropdown.setValue(String(rule.weekday)).onChange((value) => {
            this.draft.weekdayRule = { ...(this.draft.weekdayRule ?? rule), weekday: Number(value) };
          });
        });
      return;
    }

    new Setting(this.dateControlsEl)
      .setName(this.draft.dateType === "lunar" ? "农历月份" : "阳历月份")
      .addDropdown((dropdown) => {
        for (let month = 1; month <= 12; month++) dropdown.addOption(String(month), `${month} 月`);
        dropdown.setValue(String(this.draft.dateType === "lunar" ? this.draft.lunarMonth ?? 1 : this.draft.month ?? 1)).onChange((value) => {
          if (this.draft.dateType === "lunar") this.draft.lunarMonth = Number(value);
          else this.draft.month = Number(value);
        });
      });
    new Setting(this.dateControlsEl)
      .setName(this.draft.dateType === "lunar" ? "农历日期" : "阳历日期")
      .addDropdown((dropdown) => {
        for (let day = 1; day <= 31; day++) dropdown.addOption(String(day), `${day} 日`);
        dropdown.setValue(String(this.draft.dateType === "lunar" ? this.draft.lunarDay ?? 1 : this.draft.day ?? 1)).onChange((value) => {
          if (this.draft.dateType === "lunar") this.draft.lunarDay = Number(value);
          else this.draft.day = Number(value);
        });
      });
  }

  private normalizeDateDraft(): void {
    if (this.draft.dateType === "gregorian") {
      this.draft.month = this.draft.month ?? this.draft.lunarMonth ?? 1;
      this.draft.day = this.draft.day ?? this.draft.lunarDay ?? 1;
      this.draft.lunarMonth = undefined;
      this.draft.lunarDay = undefined;
      this.draft.weekdayRule = undefined;
      return;
    }
    if (this.draft.dateType === "lunar") {
      this.draft.lunarMonth = this.draft.lunarMonth ?? this.draft.month ?? 1;
      this.draft.lunarDay = this.draft.lunarDay ?? this.draft.day ?? 1;
      this.draft.month = undefined;
      this.draft.day = undefined;
      this.draft.weekdayRule = undefined;
      return;
    }
    this.draft.month = undefined;
    this.draft.day = undefined;
    this.draft.lunarMonth = undefined;
    this.draft.lunarDay = undefined;
    this.draft.weekdayRule = this.draft.weekdayRule ?? { month: 1, nth: 1, weekday: 1 };
  }
}

class RecurringRuleModal extends Modal {
  private draft: RecurringRule;
  private scheduleEl!: HTMLElement;
  private advanceEl!: HTMLElement;

  constructor(
    app: App,
    private readonly title: string,
    rule: RecurringRule,
    private readonly onSave: (rule: RecurringRule) => Promise<void>,
    private readonly onDelete?: () => Promise<boolean>
  ) {
    super(app);
    this.draft = {
      ...rule,
      weekdays: rule.weekdays ? [...rule.weekdays] : undefined,
      days: rule.days ? [...rule.days] : undefined,
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-recurring-modal");
    this.titleEl.setText(this.title);

    new Setting(contentEl)
      .setName("周期计划内容")
      .setDesc("写入日记小贴士里的内容。")
      .addText((text) =>
        text
          .setPlaceholder("例如：整理本周工作记录")
          .setValue(this.draft.text)
          .onChange((value) => {
            this.draft.text = value;
          })
      );

    new Setting(contentEl)
      .setName("循环方式")
      .setDesc("选择这条提醒如何定位到具体日期。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("weekly", "每周")
          .addOption("monthly-date", "每月几号")
          .addOption("monthly-weekday", "每月第几个星期几")
          .setValue(this.draft.type)
          .onChange((value) => {
            this.draft.type = value as RecurringRule["type"];
            this.renderScheduleControls();
          })
      );

    this.scheduleEl = contentEl.createDiv({ cls: "simple-recurring-schedule" });
    this.renderScheduleControls();

    new Setting(contentEl)
      .setClass("simple-recurring-advance-toggle")
      .setName("提前提醒")
      .setDesc("在事件发生前若干天，提前写入一条预告。")
      .addToggle((toggle) =>
          nativeCheckbox(toggle).setValue(Boolean(this.draft.advanceEnabled)).onChange((value) => {
          this.draft.advanceEnabled = value;
          if (value && !this.draft.advanceDays) this.draft.advanceDays = 3;
          this.renderAdvanceControls();
        })
      );
    this.advanceEl = contentEl.createDiv({ cls: "simple-recurring-advance" });
    this.renderAdvanceControls();

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const setBusy = (busy: boolean): void => {
      footer.querySelectorAll("button").forEach(button => { button.disabled = busy; });
    };
    if (this.onDelete) {
      const remove = footer.createEl("button", { cls: "simple-event-delete", attr: { type: "button", "aria-label": "删除事件" } });
      setDeleteIcon(remove, "plain");
      remove.addEventListener("click", runAsync(async () => {
        setBusy(true);
        try { if (await this.onDelete?.()) this.close(); }
        finally { setBusy(false); }
      }));
    }
    const cancel = styleActionButton(footer.createEl("button"), "bordered");
    cancel.setAttribute("aria-label", "取消");
    cancel.setAttribute("aria-label", "取消");
    setIcon(cancel, "undo-2");
    cancel.addEventListener("click", () => this.close());

    const save = styleActionButton(footer.createEl("button", { cls: "mod-cta" }), "text");
    save.setText("保存");
    save.addEventListener("click", runAsync(async () => {
      if (!this.draft.text.trim()) {
        new Notice("请先填写周期计划内容");
        return;
      }
      setBusy(true);
      try { await this.onSave(cleanRecurringRule(this.draft)); this.close(); }
      finally { setBusy(false); }
    }));
  }

  private renderScheduleControls(): void {
    this.scheduleEl.empty();
    this.scheduleEl.addClass("is-child");
    if (this.draft.type === "weekly") {
      this.renderWeekdayChips(this.scheduleEl, this.draft.weekdays ?? [1], (days) => {
        this.draft.weekdays = days;
      });
      return;
    }

    if (this.draft.type === "monthly-date") {
      new Setting(this.scheduleEl)
        .setName("每月日期")
        .setDesc("可以写多个日期，用逗号分隔。")
        .addText((text) =>
          text
            .setPlaceholder("例如：1, 15, 28")
            .setValue((this.draft.days ?? []).join(", "))
            .onChange((value) => {
              this.draft.days = parseNumberList(value, 1, 31);
            })
        );
      return;
    }

    new Setting(this.scheduleEl)
      .setName("第几个")
      .setDesc("定位到每月第几个星期几。")
      .addDropdown((dropdown) => {
        for (let value = 1; value <= 5; value++) {
          dropdown.addOption(String(value), `第 ${value} 个`);
        }
        dropdown.setValue(String(this.draft.nth ?? 1)).onChange((value) => {
          this.draft.nth = Number(value);
        });
      });
    new Setting(this.scheduleEl)
      .setName("星期几")
      .addDropdown((dropdown) => {
        for (let value = 1; value <= 7; value++) {
          dropdown.addOption(String(value), weekdayLabel(value));
        }
        dropdown.setValue(String(this.draft.weekday ?? 1)).onChange((value) => {
          this.draft.weekday = Number(value);
        });
      });
  }

  private renderAdvanceControls(): void {
    this.advanceEl.empty();
    if (!this.draft.advanceEnabled) return;

    new Setting(this.advanceEl)
      .setName("提前工作日")
      .setDesc("例如填 3，就是在事件前 3 个工作日写入待办。")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.draft.advanceDays ?? 3))
          .onChange((value) => {
            const parsed = Number(value);
            this.draft.advanceDays = Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
          })
      );
  }

  private renderWeekdayChips(parent: HTMLElement, initialDays: number[], onChange: (days: number[]) => void): void {
    const wrap = parent.createDiv({ cls: "simple-recurring-chip-wrap" });
    const chips = wrap.createDiv({ cls: "simple-recurring-chips" });
    let selected = new Set(initialDays);
    for (let value = 1; value <= 7; value++) {
      const chip = chips.createEl("button", {
        cls: selected.has(value) ? "simple-recurring-chip is-selected" : "simple-recurring-chip",
        text: weekdayLabel(value),
      });
      chip.addEventListener("click", () => {
        if (selected.has(value)) selected.delete(value);
        else selected.add(value);
        if (selected.size === 0) selected = new Set([value]);
        chip.parentElement?.querySelectorAll(".simple-recurring-chip").forEach((button, index) => {
          button.classList.toggle("is-selected", selected.has(index + 1));
        });
        onChange(Array.from(selected).sort((a, b) => a - b));
      });
    }
    onChange(Array.from(selected).sort((a, b) => a - b));
  }

}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function importHtmlPreviewRules(value: unknown): HtmlPreviewRule[] {
  const values = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.rules) ? value.rules : [value];
  const rules = values.map(importHtmlPreviewRule);
  if (rules.some(rule => !rule)) throw new Error("导入失败：存在未识别的匹配或替换字段");
  return rules as HtmlPreviewRule[];
}

function importHtmlPreviewRule(value: unknown): HtmlPreviewRule | null {
  if (!isRecord(value)) return null;
  const findRegex = typeof value.findRegex === "string" ? value.findRegex : "";
  const replaceString = typeof value.replaceString === "string" ? value.replaceString : "";
  if (!findRegex && !replaceString) return null;
  const parsed = parseRegexLiteral(findRegex);
  return {
    id: nextId(),
    importId: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID?.() ?? nextId(),
    enabled: !value.disabled,
    name: typeof value.scriptName === "string" ? value.scriptName.trim() : "",
    pattern: parsed.pattern,
    flags: parsed.flags || "g",
    replaceWith: replaceString,
    sampleText: typeof value.sampleText === "string" ? value.sampleText : undefined,
  };
}

function exportHtmlPreviewRule(rule: HtmlPreviewRule): Record<string, unknown> {
  return {
    disabled: !rule.enabled,
    findRegex: `/${escapeRegexLiteral(rule.pattern)}/${rule.flags || "g"}`,
    id: rule.importId || rule.id,
    markdownOnly: true,
    maxDepth: null,
    minDepth: null,
    placement: [2],
    promptOnly: false,
    replaceString: rule.replaceWith,
    runOnEdit: true,
    scriptName: rule.name,
    sampleText: rule.sampleText,
    substituteRegex: 0,
    trimStrings: [],
  };
}

function parseRegexLiteral(value: string): { pattern: string; flags: string } {
  if (!value.startsWith("/")) return { pattern: value, flags: "g" };
  const lastSlash = value.lastIndexOf("/");
  if (lastSlash <= 0) return { pattern: value, flags: "g" };
  return {
    pattern: value.slice(1, lastSlash),
    flags: value.slice(lastSlash + 1) || "g",
  };
}

function escapeRegexLiteral(pattern: string): string {
  return pattern.replace(/(^|[^\\])\//g, "$1\\/");
}

function parseLooseHtmlPreviewRuleJson(text: string): Record<string, unknown> | null {
  const findRegex = readLooseJsonString(text, "findRegex");
  const replaceString = readLooseJsonString(text, "replaceString");
  if (!findRegex && !replaceString) return null;
  return {
    disabled: /"disabled"\s*:\s*true/i.test(text),
    findRegex: findRegex ?? "",
    id: readLooseJsonString(text, "id") ?? crypto.randomUUID?.() ?? nextId(),
    replaceString: replaceString ?? "",
    scriptName: readLooseJsonString(text, "scriptName") ?? readLooseJsonLineValue(text, "scriptName") ?? "",
  };
}

function readLooseJsonString(text: string, field: string): string | null {
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(`"${match[1]}"`);
    return typeof value === "string" ? value : null;
  } catch {
    return match[1];
  }
}

function readLooseJsonLineValue(text: string, field: string): string | null {
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*"?([^,\\r\\n}]*)`, "i"));
  return match?.[1]?.trim().replace(/^"|"$/g, "") || null;
}

function cleanRecurringRule(rule: RecurringRule): RecurringRule {
  const base = {
    id: rule.id || nextId(),
    enabled: rule.enabled,
    text: rule.text.trim(),
    outputFormat: "task" as const,
    advanceEnabled: Boolean(rule.advanceEnabled),
    advanceDays: normalizeOptionalNumber(rule.advanceDays, 1, 365) ?? 3,
    advanceContinuous: false,
    advanceText: "",
    type: rule.type,
  };
  if (rule.type === "weekly") {
    return { ...base, type: "weekly", weekdays: normalizeNumberArray(rule.weekdays, 1, 7) ?? [1] };
  }
  if (rule.type === "monthly-date") {
    return { ...base, type: "monthly-date", days: normalizeNumberArray(rule.days, 1, 31) ?? [1] };
  }
  return {
    ...base,
    type: "monthly-weekday",
    nth: normalizeOptionalNumber(rule.nth, 1, 5) ?? 1,
    weekday: normalizeOptionalNumber(rule.weekday, 1, 7) ?? 1,
  };
}

function recurringRuleSummary(rule: RecurringRule): string {
  const suffix = [
    "待办",
    rule.advanceEnabled ? `提前 ${rule.advanceDays ?? 3} 个工作日提醒` : "",
  ].filter(Boolean).join(" · ");
  if (rule.type === "weekly") {
    return appendSummarySuffix(`每周：${formatWeekdays(rule.weekdays ?? [])}`, suffix);
  }
  if (rule.type === "monthly-date") {
    return appendSummarySuffix(`每月日期：${(rule.days ?? []).join("、") || "未设置"}`, suffix);
  }
  return appendSummarySuffix(`每月：第 ${rule.nth ?? "?"} 个 ${formatWeekdays(rule.weekday ? [rule.weekday] : [])}`, suffix);
}

function anniversarySummary(anniversary: Anniversary): string {
  const reminderParts = [
    anniversary.sameDayReminderEnabled ?? anniversary.reminderEnabled ? "当日提醒" : "",
    anniversary.advanceReminderEnabled && anniversary.reminderDaysBefore > 0 ? `提前 ${anniversary.reminderDaysBefore} 个工作日` : "",
  ].filter(Boolean);
  const reminder = reminderParts.length ? ` · ${reminderParts.join("、")}` : "";
  return `${anniversaryDateSummary(anniversary)}${reminder}`;
}

function anniversaryDateSummary(anniversary: Anniversary): string {
  if (anniversary.dateType === "gregorian") {
    return `公历 ${anniversary.month ?? "?"}月${anniversary.day ?? "?"}日`;
  }
  if (anniversary.dateType === "weekday-rule" && anniversary.weekdayRule) {
    const rule = anniversary.weekdayRule;
    return `${rule.month}月第 ${rule.nth} 个${weekdayLabel(rule.weekday)}`;
  }
  if (anniversary.dateType === "lunar") {
    return `农历 ${anniversary.lunarMonth ?? "?"}月${anniversary.lunarDay ?? "?"}日`;
  }
  if (anniversary.dateType === "lunar-eve") {
    return "农历除夕";
  }
  return "节气";
}

function anniversaryTags(anniversaries: Anniversary[]): string[] {
  const tags = new Set<string>(["全部", "自定义"]);
  for (const anniversary of anniversaries) {
    for (const tag of anniversary.tags ?? []) {
      if (tag.trim()) tags.add(tag.trim());
    }
  }
  const preferred = ["全部", "自定义", "常用", "传统", "纪念"];
  const ordered = preferred.filter((tag) => tags.has(tag));
  const rest = Array.from(tags)
    .filter((tag) => !preferred.includes(tag))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  return [...ordered, ...rest];
}

function sortAnniversariesForDisplay(anniversaries: Anniversary[], tag: string): Anniversary[] {
  return [...anniversaries].sort((a, b) => {
    const groupDiff = anniversaryGroupRank(a, tag) - anniversaryGroupRank(b, tag);
    if (groupDiff !== 0) return groupDiff;
    const orderDiff = explicitAnniversaryOrder(a, tag) - explicitAnniversaryOrder(b, tag);
    if (orderDiff !== 0) return orderDiff;
    const dateDiff = anniversarySortDateValue(a) - anniversarySortDateValue(b);
    if (dateDiff !== 0) return dateDiff;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

function anniversaryGroupRank(anniversary: Anniversary, tag: string): number {
  if (tag === "全部") {
    if (anniversary.tags?.includes("常用")) return 0;
    if (anniversary.tags?.includes("传统")) return 1;
    if (anniversary.tags?.includes("纪念")) return 2;
    return 9;
  }
  if (tag === "纪念") {
    const publicMemory = new Set(["建党节", "建军节", "国家公祭日"]);
    const culture = new Set(["植树节", "青年节", "世界读书日", "光棍节", "程序员节"]);
    const profession = new Set(["护士节", "医师节", "记者节"]);
    const publicHealth = new Set(["消费者权益日", "世界地球日", "世界环境日", "世界无烟日", "全国爱眼日", "世界精神卫生日"]);
    if (publicMemory.has(anniversary.name)) return 0;
    if (culture.has(anniversary.name)) return 1;
    if (profession.has(anniversary.name)) return 2;
    if (publicHealth.has(anniversary.name)) return 3;
    return 9;
  }
  return 0;
}

function explicitAnniversaryOrder(anniversary: Anniversary, tag: string): number {
  const orders: Record<string, string[]> = {
    "常用": ["元旦", "情人节", "妇女节", "劳动节", "520", "母亲节", "父亲节", "儿童节", "教师节", "国庆节", "万圣夜", "感恩节", "圣诞节", "愚人节"],
    "传统": ["春节", "元宵节", "清明", "端午节", "七夕", "中元节", "中秋节", "重阳节", "冬至", "腊八节", "小年北", "小年南", "除夕"],
  };
  const order = orders[tag] ?? [];
  const index = order.indexOf(anniversary.name);
  return index >= 0 ? index : 999;
}

function anniversarySortDateValue(anniversary: Anniversary): number {
  if (anniversary.dateType === "gregorian") {
    return (anniversary.month ?? 99) * 100 + (anniversary.day ?? 99);
  }
  if (anniversary.dateType === "weekday-rule" && anniversary.weekdayRule) {
    return anniversary.weekdayRule.month * 100 + anniversary.weekdayRule.nth * 7 + anniversary.weekdayRule.weekday;
  }
  if (anniversary.dateType === "lunar") {
    return (anniversary.lunarMonth ?? 99) * 100 + (anniversary.lunarDay ?? 99);
  }
  if (anniversary.dateType === "lunar-eve") return 1299;
  if (anniversary.name === "清明") return 404;
  if (anniversary.name === "冬至") return 1221;
  return 9999;
}

function cleanCustomAnniversary(anniversary: Anniversary): Anniversary {
  const sameDayReminderEnabled = anniversary.sameDayReminderEnabled ?? anniversary.reminderEnabled ?? true;
  const advanceReminderEnabled = anniversary.advanceReminderEnabled ?? false;
  const base: Anniversary = {
    id: anniversary.id || nextId(),
    name: anniversary.name.trim(),
    enabled: true,
    showInCalendar: anniversary.showInCalendar !== false,
    tags: ["自定义"],
    dateType: anniversary.dateType,
    reminderEnabled: Boolean(sameDayReminderEnabled || advanceReminderEnabled),
    sameDayReminderEnabled,
    advanceReminderEnabled,
    reminderDaysBefore: advanceReminderEnabled ? anniversary.reminderDaysBefore || 7 : 0,
    outputFormat: "task",
  };

  if (anniversary.dateType === "lunar") {
    return {
      ...base,
      dateType: "lunar",
      lunarMonth: normalizeOptionalNumber(anniversary.lunarMonth, 1, 12) ?? 1,
      lunarDay: normalizeOptionalNumber(anniversary.lunarDay, 1, 31) ?? 1,
    };
  }

  if (anniversary.dateType === "weekday-rule") {
    return {
      ...base,
      dateType: "weekday-rule",
      weekdayRule: {
        month: normalizeOptionalNumber(anniversary.weekdayRule?.month, 1, 12) ?? 1,
        nth: normalizeOptionalNumber(anniversary.weekdayRule?.nth, 1, 5) ?? 1,
        weekday: normalizeOptionalNumber(anniversary.weekdayRule?.weekday, 1, 7) ?? 1,
      },
    };
  }

  return {
    ...base,
    dateType: "gregorian",
    month: normalizeOptionalNumber(anniversary.month, 1, 12) ?? 1,
    day: normalizeOptionalNumber(anniversary.day, 1, 31) ?? 1,
  };
}

function holidayScheduleSummary(schedule: HolidaySchedule): string {
  const source = schedule.source === "national" ? "国家法定假期" : schedule.source === "company" ? "公司假期" : "手动覆盖";
  return `${source} · ${schedule.year} 年 · ${schedule.days.length} 条`;
}

function groupHolidayScheduleDays(schedule: HolidaySchedule): HolidayScheduleGroup[] {
  const groups = new Map<string, DayScheduleItem[]>();
  for (const day of [...schedule.days].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = holidayGroupKey(day);
    const group = groups.get(key) ?? [];
    group.push(day);
    groups.set(key, group);
  }
  return Array.from(groups.entries())
    .map(([title, days]) => ({ title, days }))
    .sort((a, b) => a.days[0].date.localeCompare(b.days[0].date));
}

function buildHolidayComparison(companySchedule: HolidaySchedule, schedules: HolidaySchedule[]): HolidayComparison | null {
  const nationalSchedule = schedules.find((schedule) =>
    schedule.source === "national"
    && schedule.enabled
    && schedule.year === companySchedule.year
  );
  if (!nationalSchedule) return null;
  const nationalDays = new Map(nationalSchedule.days.map((day) => [day.date, day]));
  const differenceDates = new Set<string>();
  for (const companyDay of companySchedule.days) {
    const nationalDay = nationalDays.get(companyDay.date);
    if (holidayComparisonKind(companyDay.status) !== (nationalDay ? holidayComparisonKind(nationalDay.status) : "none")) {
      differenceDates.add(companyDay.date);
    }
  }
  return { nationalDays, differenceDates };
}

function holidayComparisonKind(status: DayScheduleStatus): "off" | "work" | "half" | "remote" {
  if (status === "day-off" || status === "company-day-off") return "off";
  if (status === "workday" || status === "adjusted-workday") return "work";
  if (status === "half-day") return "half";
  return "remote";
}

function holidayGroupKey(day: DayScheduleItem): string {
  const label = day.label.trim();
  const match = label.match(/(元旦|春节|清明|劳动|端午|中秋|国庆|公司|年假|调休|远程)/);
  if (match) {
    if (match[1] === "劳动") return "劳动节";
    if (match[1] === "公司") return "公司特殊安排";
    return match[1].endsWith("节") || match[1] === "国庆" || match[1] === "春节" || match[1] === "元旦" ? `${match[1]}安排` : match[1];
  }
  return `${Number(day.date.slice(5, 7))} 月安排`;
}

function holidayGroupSummary(group: HolidayScheduleGroup): string {
  const dates = group.days.map((day) => parseIsoDate(day.date)).sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0];
  const last = dates[dates.length - 1];
  const off = group.days.filter((day) => day.status === "day-off" || day.status === "company-day-off" || day.status === "half-day").length;
  const work = group.days.filter((day) => day.status === "workday" || day.status === "adjusted-workday").length;
  const range = first && last
    ? `${first.getMonth() + 1}月${first.getDate()}日${first.getTime() === last.getTime() ? "" : ` - ${last.getMonth() + 1}月${last.getDate()}日`}`
    : "";
  return [range, off ? `休 ${off}` : "", work ? `调 ${work}` : ""].filter(Boolean).join(" · ");
}

function buildHolidayGroupGridDates(group: HolidayScheduleGroup): Date[] {
  const dates = group.days.map((day) => parseIsoDate(day.date)).sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0] ?? new Date();
  const last = dates[dates.length - 1] ?? first;
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const end = addDays(last, 6 - ((last.getDay() + 6) % 7));
  const result: Date[] = [];
  for (let date = new Date(start); date <= end; date = addDays(date, 1)) {
    result.push(new Date(date));
  }
  return result;
}

function holidayStatusClass(status: DayScheduleStatus): string {
  if (status === "day-off" || status === "company-day-off") return "off";
  if (status === "adjusted-workday" || status === "workday") return "work";
  if (status === "half-day") return "half";
  if (status === "remote") return "remote";
  return "normal";
}

function compactHolidayStatusLabel(status: DayScheduleStatus): string {
  if (status === "day-off") return "假";
  if (status === "company-day-off") return "司假";
  if (status === "adjusted-workday") return "调";
  if (status === "workday") return "班";
  if (status === "half-day") return "半";
  if (status === "remote") return "远";
  return "";
}

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function holidayImportPrompt(): string {
  return `请把下面的节假日安排整理成 Simple One 可导入 JSON。

要求：
1. 只输出 JSON，不要解释，不要使用 Markdown 代码块。
2. 日期统一使用 YYYY-MM-DD。
3. 根据原文来源判断 source：
   - 国家法定节假日、国务院通知、政府公告等，source 使用 "national"。
   - 公司通知、HR 安排、团队安排等，source 使用 "company"。
4. 连续假期必须逐日展开。只要某一天涉及放假、调休、半天假、远程办公或公司特殊安排，就必须在 days 中单独列出一条。
5. 不要用日期区间代替逐日记录，例如不要写 "2026-02-15 至 2026-02-21"，而要列出 2026-02-15、2026-02-16……每一天。
6. status 只能使用以下值：day-off、workday、adjusted-workday、company-day-off、half-day、remote。
   - "day-off" 表示放假休息或普通休息日。
   - "workday" 表示正常上班。
   - "adjusted-workday" 表示调休上班。
   - "company-day-off" 表示公司额外假。
   - "half-day" 表示半天假。
   - "remote" 表示远程办公。
7. label 使用简短中文说明原因，例如“春节假期”“春节前补班”“公司额外假”。
8. 如果原文没有年份，请根据上下文推断；无法确定时不要编造，把问题写入 warnings。
9. 输出结构必须符合：
{
  "version": 1,
  "source": "national",
  "name": "",
  "year": 2026,
  "days": [
    {
      "date": "2026-01-01",
      "status": "day-off",
      "label": "元旦假期"
    }
  ],
  "warnings": []
}

原文如下：`;
}

function normalizeHolidayImports(value: unknown, source: HolidaySource): HolidaySchedule[] {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) throw new Error("假期安排不能为空");
  return items.map(item => normalizeHolidayImport(item, source));
}

function normalizeHolidayImport(value: unknown, expectedSource: HolidaySource): HolidaySchedule {
  if (!isRecord(value)) throw new Error("导入内容必须是对象");
  if (value.version !== 1) throw new Error("version 必须是 1");
  if (value.source !== expectedSource) throw new Error(`source 必须是 "${expectedSource}"`);
  if (typeof value.year !== "number" || !Number.isInteger(value.year)) throw new Error("year 必须是整数年份");
  if (!Array.isArray(value.days)) throw new Error("days 必须是数组");

  const allowedStatuses = new Set(["day-off", "workday", "adjusted-workday", "company-day-off", "half-day", "remote"]);
  const days: DayScheduleItem[] = [];
  const seenDates = new Set<string>();
  for (const [index, day] of value.days.entries()) {
    if (!isRecord(day)) throw new Error(`days[${index}] 必须是对象`);
    if (typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
      throw new Error(`days[${index}].date 必须是 YYYY-MM-DD`);
    }
    if (seenDates.has(day.date)) throw new Error(`days[${index}].date 重复：${day.date}`);
    seenDates.add(day.date);
    if (typeof day.status !== "string" || !allowedStatuses.has(day.status)) {
      throw new Error(`days[${index}].status 不在允许范围内`);
    }
    days.push({
      date: day.date,
      status: day.status as DayScheduleStatus,
      label: typeof day.label === "string" ? day.label : "",
    });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return {
    id: typeof value.id === "string" && value.id ? value.id : nextId(),
    version: 1,
    source: expectedSource,
    name: typeof value.name === "string" && value.name ? value.name : `${value.year} 年${expectedSource === "national" ? "国家法定节假日安排" : "公司假期安排"}`,
    year: value.year,
    enabled: true,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : undefined,
    publishedDate: typeof value.publishedDate === "string" ? value.publishedDate : undefined,
    importedAt: new Date().toISOString(),
    days,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [],
  };
}

function upsertHolidaySchedule(schedules: HolidaySchedule[], schedule: HolidaySchedule): void {
  const index = schedules.findIndex((item) => item.source === schedule.source && item.year === schedule.year && item.name === schedule.name);
  if (index >= 0) {
    schedules[index] = { ...schedule, id: schedules[index].id };
  } else {
    schedules.push(schedule);
  }
}

function summarizeHolidaySchedule(schedule: HolidaySchedule): string {
  const dayOffCount = schedule.days.filter((day) => day.status === "day-off" || day.status === "company-day-off" || day.status === "half-day").length;
  const workdayCount = schedule.days.filter((day) => day.status === "workday" || day.status === "adjusted-workday").length;
  const sourceLabel = schedule.source === "company" ? "公司假期安排" : "国家法定假期安排";
  return `已导入${sourceLabel}：${schedule.year} 年，共 ${schedule.days.length} 条，休息/半天 ${dayOffCount} 条，上班/调休 ${workdayCount} 条`;
}

function appendSummarySuffix(summary: string, suffix: string): string {
  return suffix ? `${summary} · ${suffix}` : summary;
}

function formatWeekdays(days: number[]): string {
  return days.length
    ? days.map(weekdayLabel).join("、")
    : "未设置";
}

function weekdayLabel(day: number): string {
  const names = ["一", "二", "三", "四", "五", "六", "日"];
  return `周${names[day - 1] ?? day}`;
}

function parseNumberList(value: string, min: number, max: number): number[] {
  return normalizeNumberArray(
    value.split(/[,\s，、]+/).filter(Boolean).map((item) => Number(item)),
    min,
    max
  ) ?? [];
}

function normalizeNumberArray(value: unknown, min: number, max: number): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= min && item <= max);
  return Array.from(new Set(numbers));
}

function normalizeOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

function normalizeCategory(value: unknown): TemplateCategory {
  if (!isRecord(value)) throw new Error("分类 JSON 必须是对象");
  return {
    id: stringValue(value.id) || nextId(),
    name: stringValue(value.name),
    icon: stringValue(value.icon),
    outputFolder: stringValue(value.outputFolder),
    filenameField: stringValue(value.filenameField),
    propertyFields: Array.isArray(value.propertyFields)
      ? [...new Set(value.propertyFields.map(stringValue).map(name => name.trim()).filter(Boolean))] : undefined,
    noteFormat: stringValue(value.noteFormat),
    siteRules: Array.isArray(value.siteRules)
      ? value.siteRules.map((siteRule) => normalizeSiteRule(siteRule))
      : [],
  };
}

function normalizeCategoryImport(value: unknown): TemplateCategory[] {
  if (Array.isArray(value)) return value.map((item) => normalizeCategory(item));
  if (isRecord(value) && Array.isArray(value.categories)) {
    return value.categories.map((item) => normalizeCategory(item));
  }
  if (isRecord(value) && isRecord(value.category)) {
    return [normalizeCategory(value.category)];
  }
  return [normalizeCategory(value)];
}

function normalizeSiteRule(value: unknown): SiteRule {
  if (!isRecord(value)) throw new Error("网站规则 JSON 必须是对象");
  const handler = stringValue(value.handler) || inferSiteHandler(value);
  const siteRule: SiteRule = {
    id: stringValue(value.id) || nextId(),
    name: stringValue(value.name),
    shortName: stringValue(value.shortName),
    handler,
    bodySuffix: stringValue(value.bodySuffix),
    urlPattern: stringValue(value.urlPattern),
    fields: Array.isArray(value.fields) ? value.fields.map((field) => ({
      id: isRecord(field) ? stringValue(field.id) || nextId() : nextId(),
      fieldName: isRecord(field) ? stringValue(field.fieldName) : "",
      source: isRecord(field) ? stringValue(field.source) : "",
      regex: isRecord(field) ? stringValue(field.regex) : "",
      replaceWith: isRecord(field) ? stringValue(field.replaceWith) : "",
    })) : [],
  };
  if (isRecord(value.input) && isRecord(value.input.baseUrl)) {
    const baseUrl = compactObject({
      type: "urlReplace",
      regex: stringValue(value.input.baseUrl.regex),
      replaceWith: stringValue(value.input.baseUrl.replaceWith),
      page: stringValue(value.input.baseUrl.page),
    }) as NonNullable<SiteRule["input"]>["baseUrl"];
    siteRule.input = { baseUrl };
  }
  if (Array.isArray(value.pages)) {
    siteRule.pages = value.pages
      .map((page) => normalizePageRequest(page))
      .filter((page) => page.id);
  }
  if (isRecord(value.search)) {
    siteRule.search = compactObject({
      enabled: typeof value.search.enabled === "boolean" ? value.search.enabled : undefined,
      type: stringValue(value.search.type),
      searchUrl: stringValue(value.search.searchUrl),
      queryEncoding: stringValue(value.search.queryEncoding),
      pageStart: typeof value.search.pageStart === "number" ? value.search.pageStart : undefined,
      resultLimit: typeof value.search.resultLimit === "number" ? value.search.resultLimit : undefined,
      resultList: stringValue(value.search.resultList),
      resultTitle: stringValue(value.search.resultTitle),
      resultUrl: stringValue(value.search.resultUrl),
      resultAuthor: stringValue(value.search.resultAuthor),
      resultIntro: stringValue(value.search.resultIntro),
      nextPage: isRecord(value.search.nextPage) ? normalizePageUrlFrom(value.search.nextPage) : undefined,
    }) as SiteRule["search"];
  }
  const rawFields: unknown[] = Array.isArray(value.fields) ? value.fields : [];
  for (let i = 0; i < siteRule.fields.length; i++) {
    const rawField = rawFields[i];
    if (isRecord(rawField)) {
      const page = stringValue(rawField.page);
      if (page) siteRule.fields[i].page = page;
    }
  }
  return siteRule;
}

function inferSiteHandler(value: Record<string, unknown>): string {
  const urlPattern = stringValue(value.urlPattern);
  const search = isRecord(value.search) ? value.search : {};
  if (/qidian/i.test(urlPattern)) return "qidianBook";
  if (/fanqienovel/i.test(urlPattern) || stringValue(search.type) === "fanqieApi") return "fanqieNovel";
  return "";
}

function normalizePageRequest(value: unknown): NonNullable<SiteRule["pages"]>[number] {
  if (!isRecord(value)) return { id: "", url: "" };
  const urlFrom = isRecord(value.urlFrom) ? normalizePageUrlFrom(value.urlFrom) : undefined;
  return compactObject({
    id: stringValue(value.id),
    url: stringValue(value.url),
    urlFrom,
  }) as NonNullable<SiteRule["pages"]>[number];
}

function normalizePageUrlFrom(value: Record<string, unknown>): NonNullable<NonNullable<SiteRule["pages"]>[number]["urlFrom"]> | undefined {
  const type = stringValue(value.type);
  if (type === "urlReplace") {
    return compactObject({
      type,
      page: stringValue(value.page),
      regex: stringValue(value.regex),
      replaceWith: stringValue(value.replaceWith),
    }) as NonNullable<NonNullable<SiteRule["pages"]>[number]["urlFrom"]>;
  }
  if (type === "selectorHref") {
    return {
      type,
      page: stringValue(value.page),
      selector: stringValue(value.selector),
    };
  }
  if (type === "regexFromHtml") {
    return {
      type,
      page: stringValue(value.page),
      regex: stringValue(value.regex),
      replaceWith: stringValue(value.replaceWith),
    };
  }
  if (type === "queryParamIncrement") {
    return compactObject({
      type,
      page: stringValue(value.page),
      param: stringValue(value.param),
      start: typeof value.start === "number" ? value.start : undefined,
    }) as NonNullable<NonNullable<SiteRule["pages"]>[number]["urlFrom"]>;
  }
  return undefined;
}

function normalizeSiteRuleImport(value: unknown): SiteRule[] {
  if (Array.isArray(value)) return value.map((item) => normalizeSiteRule(item));
  if (isRecord(value) && Array.isArray(value.siteRules)) {
    return value.siteRules.map((item) => normalizeSiteRule(item));
  }
  if (isRecord(value) && isRecord(value.siteRule)) {
    return [normalizeSiteRule(value.siteRule)];
  }
  return [normalizeSiteRule(value)];
}

function importJsonFile(ownerDocument: Document = document): Promise<unknown> {
  return new Promise((resolve) => {
    const input = ownerDocument.win.createEl("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.hidden = true;
    ownerDocument.body.appendChild(input);
    const finish = (value: unknown): void => {
      input.remove();
      resolve(value);
    };
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.addEventListener("change", runAsync(async () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      try {
        const text = await file.text();
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch (error) {
          const looseRule = parseLooseHtmlPreviewRuleJson(text);
          if (!looseRule) throw error;
          value = looseRule;
        }
        finish(value);
      } catch (error) {
        new Notice(`JSON 导入失败：${error instanceof Error ? error.message : String(error)}`);
        finish(null);
      }
    }));
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
    } catch {
      input.click();
    }
  });
}

function downloadJsonFile(filename: string, value: unknown, ownerDocument: Document = document): void {
  const blob = new Blob([formatJson(value)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = ownerDocument.win.createEl("a");
  link.href = url;
  link.download = filename;
  ownerDocument.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function slugify(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unnamed";
}

function siteLabel(siteRule: SiteRule): string {
  return siteRule.shortName || siteRule.name || siteRule.urlPattern;
}

function siteSummary(siteRule: SiteRule): string {
  const label = siteLabel(siteRule);
  const parts = [
    siteRule.fields.length > 0 ? "链接" : "",
    siteRule.search && siteRule.search.enabled !== false ? "搜索" : "",
  ].filter(Boolean);
  const summary = parts.length ? `${label}（${parts.join(" + ")}）` : label;
  const hasEmbeddedProcessing = siteRule.handler === "fanqieNovel"
    || siteRule.handler === "qidianBook"
    || siteRule.search?.type === "fanqieApi"
    || /qidian/i.test(siteRule.urlPattern);
  return hasEmbeddedProcessing ? `${summary} · 有内嵌处理机制` : summary;
}

function upsertById<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    items[index] = item;
  } else {
    items.push(item);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value) as Array<[keyof T, unknown]>) {
    if (entry === "" || entry === undefined || entry === null) continue;
    result[key] = entry as T[keyof T];
  }
  return result;
}

function readThemeColor(name: string): string {
  const map: Record<string, string> = {
    "一级标题": "--h1-color",
    "二级标题": "--h2-color",
    "三级标题": "--h3-color",
    "四级标题": "--h4-color",
    "五级标题": "--h5-color",
    "六级标题": "--h6-color",
  };
  if (map[name]) {
    const sample = document.body.createDiv({ cls: "workspace-leaf-content", attr: { "data-type": "markdown" } });
    const view = sample.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    try { return renderedColorHex(getComputedStyle(view.createEl(map[name].slice(2, 4) as "h1", { text: "标题" })).color); }
    finally { sample.remove(); }
  }
  const variable = map[name] ?? `--callout-${name.toLowerCase()}`;
  const value = getComputedStyle(document.body).getPropertyValue(variable).trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^\d+,\s*\d+,\s*\d+$/.test(value)) return rgbTripletToHex(value);
  const probe = document.body.createSpan();
  probe.style.color = `var(${variable})`;
  const channels = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3);
  probe.remove();
  if (channels?.length === 3) return rgbTripletToHex(channels.join(","));
  const fallback: Record<string, string> = {
    "一级标题": "#000000",
    "二级标题": "#000000",
    "六级标题": "#000000",
    Note: "#2e80f2",
    Tip: "#00bfbc",
    Summary: "#00bfbc",
    Warning: "#ec7500",
    Important: "#00bfbc",
    Caution: "#ec7500",
  };
  return fallback[name] ?? "#000000";
}

function readRenderedFontSize(level?: QuickFormatHeadingLevel): string {
  const host = document.body.createDiv({ cls: "workspace-leaf-content simple-font-size-probe", attr: { "data-type": "markdown" } });
  const probe = host.createDiv({ cls: "markdown-preview-view markdown-rendered" });
  const element = probe.createEl(level ?? "p", { text: level ? "标题" : "正文" });
  const size = getComputedStyle(element).fontSize;
  host.remove();
  return size || getComputedStyle(document.body).fontSize || "16px";
}

function stripPx(value: string): string {
  return value.replace(/px$/i, "");
}

function compareFontSizes(heading: string, body: string): string {
  const headingSize = Number.parseFloat(heading);
  const bodySize = Number.parseFloat(body);
  if (!Number.isFinite(headingSize) || !Number.isFinite(bodySize)) return "";
  if (headingSize < bodySize) return `，比正文小 ${formatSizeDifference(bodySize - headingSize)}px`;
  if (headingSize === bodySize) return "，与正文相同";
  return `，比正文大 ${formatSizeDifference(headingSize - bodySize)}px`;
}

function formatSizeDifference(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function rgbTripletToHex(value: string): string {
  return "#" + value
    .split(",")
    .map((part) => Math.max(0, Math.min(255, Number(part.trim()))).toString(16).padStart(2, "0"))
    .join("");
}
