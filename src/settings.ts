import { SyncSettingsTab } from "./features/sync";
import { runAsync } from "./shared/async";
import { confirmAction } from "./shared/confirm";
// ============================================================
// Settings tab UI
// ============================================================
import { App, Menu, Modal, Notice, PluginSettingTab, Setting, TFile, TFolder, normalizePath, requireApiVersion, setIcon, type SettingDefinitionItem, type SettingDefinitionAction } from "obsidian";
import type SimplePlugin from "./main";
import {
  checkUnusedAttachments,
  describeAttachmentLocation,
  planAttachmentOrganization,
  planInlineImageExtraction,
  planAttachmentImageRename,
  readObsidianAttachmentLocation,
} from "./features/attachmentOrganizer";
import { REFORMAT_ICON, REFORMAT_NAME } from "./features/currentNoteLinkConverter";
import { getNotebookNavigatorPlugin } from "./features/diary";
import { applyQuickFormatStyles, QUICK_FORMAT_ICON, QUICK_FORMAT_NAME } from "./features/quickFormat";
import { openSearchFolderPicker, searchFolderSummary } from "./features/searchFolderFilter";
import { POPUP_SCALE_MAX } from "./shared/popupSizing";
import { readCalloutColorHex } from "./shared/calloutColor";
import { columnsHotkeyConflicts, commandHotkeyLabel, currentColumnsHotkey, parseCommandHotkey, saveColumnsHotkey } from "./shared/commandHotkey";
import {
  BUILT_IN_TEXT_REFORMAT_RULE_IDS,
  makeHtmlPreviewRule,
  makeFilterRule,
  makeNewNoteDatabaseRule,
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
  type NewNoteDatabaseRule,
  type QuickFormatCustomCallout,
  type QuickFormatHeadingLevel,
  type QuickFormatMode,
  type RecurringRule,
  type SiteRule,
  type TemplateCategory,
  type TextReformatRule,
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

type SettingsPage =
  | { type: "overview" }
  | { type: "sync-sharing" }
  | { type: "html-preview" }
  | { type: "link-rules" }
  | { type: "template-rules" }
  | { type: "attachment-organizer" }
  | { type: "new-note-defaults" }
  | { type: "search-folders" }
  | { type: "calendar-diary" }
  | { type: "diary" }
  | { type: "reformat" }
  | { type: "reformat-rules" }
  | { type: "quick-format" }
  | { type: "quick-format-headings" }
  | { type: "quick-format-callouts" }
  | { type: "display-enhancements" }
  | { type: "notion-columns" }
  | { type: "event-reminders" }
  | { type: "date-management" }
  | { type: "holiday-management" }
  | { type: "category-manager" }
  | { type: "category-sites"; categoryId: string };

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

export class SimpleSettingTab extends PluginSettingTab {
  plugin: SimplePlugin;
  private syncTab: SyncSettingsTab;
  private page: SettingsPage = { type: "overview" };
  private parameterPlatform: "desktop" | "mobile";
  private expandedQuickFormatCalloutSections = new Set(["native", "custom"]);
  private expandedReformatRuleSections = new Set(["builtin", "custom"]);
  private editingCustomCalloutIds = new Set<string>();
  private anniversaryTagFilter = "常用";
  private expandedHolidaySchedules = new Set<string>();
  private deleteMode:
    | { type: "categories"; selectedIds: Set<string> }
    | { type: "site-rules"; categoryId: string; selectedIds: Set<string> }
    | null = null;

  constructor(app: App, plugin: SimplePlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.syncTab = new SyncSettingsTab(app, plugin.sync);
    plugin.sync.openSettings = () => this.openPage({ type: "sync-sharing" });
    this.parameterPlatform = plugin.isMobile ? "mobile" : "desktop";
  }

  hide(): void {
    this.syncTab.hide();
    this.parameterPlatform = this.plugin.isMobile ? "mobile" : "desktop";
  }

  display(): void { this.renderSettings(); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Custom rule editors keep their existing layout; native entries expose
    // each feature and its keywords to Obsidian 1.13's settings search.
    const entry = (name: string, type: Exclude<SettingsPage["type"], "category-sites">, aliases: string[], desc = ""): SettingDefinitionAction => {
      const description = createFragment();
      description.append(document.createTextNode(desc));
      const arrow = description.createSpan({ cls: "simple-native-entry-arrow" });
      arrow.setAttr("aria-hidden", "true");
      setIcon(arrow, "chevron-right");
      return { name, aliases, desc: description, action: () => this.openPage({ type }) };
    };
    return [
      { type: "group", heading: "功能拓展", cls: "simple-settings simple-native-overview", items: [
        entry("同步", "sync-sharing", ["GitHub", "Git Ignore", "同步", "仓库", "手机", "服务器", "Token"], "绑定仓库、配置电脑与轻量同步，管理需要共享和自动屏蔽的文件。"),
      ] },
      { type: "group", heading: "显示与排版", cls: "simple-settings simple-native-overview", items: [
        entry("显示增强", "display-enhancements", ["正文宽度", "图片高度", "窗口缩放", "窗口定位", "双列", "HTML 预览", "Mermaid", "颜色代码", "手机按钮"], "调整正文宽度、图片显示与内容预览。"),
        entry(QUICK_FORMAT_NAME, "quick-format", ["标题", "引用", "Callout", "标题颜色", "标题字号"], "把当前行或选中文本快速转换为标题、引用或 Callout。"),
        entry(REFORMAT_NAME, "reformat", ["粘贴", "链接", "排版规则", "换行", "网址标题"], "处理粘贴内容（链接）、对整篇笔记进行重排版。"),
      ] },
      { type: "group", heading: "快捷操作", cls: "simple-settings simple-native-overview", items: [
        { name: "快速复制当前笔记链接", aliases: ["Obsidian URL", "绝对路径", "剪贴板"],
          desc: this.plugin.isMobile ? "检测到当前为移动端，已自动禁用。" : "在当前笔记标题栏增加复制按钮。左键复制链接，右键切换复制格式。",
          control: { type: "toggle", key: "quickCopyLink", disabled: this.plugin.isMobile } },
        entry("新建快速笔记", "template-rules", ["网页采集", "网站搜索", "分类", "网站规则"], "使用剪贴板链接或已配置的网站搜索快速生成笔记。"),
      ] },
      { type: "group", heading: "内容管理", cls: "simple-settings simple-native-overview", items: [
        entry("日历与日记", "calendar-diary", ["日记模板", "结转", "周期提醒", "纪念日", "节假日", "季度", "周数"], "管理日历、每日笔记、周期事件提醒、纪念日和节假日。"),
        entry("附件优化", "attachment-organizer", ["未引用附件", "重命名", "归位", "内嵌图片", "回收站"], "清理未引用附件，并按引用笔记重命名、归位附件。"),
      ] },
      { type: "group", heading: "功能增强", cls: "simple-settings simple-native-overview", items: [
        entry("搜索时默认屏蔽", "search-folders", ["文件夹", "排除", "包含"], searchFolderSummary(this.plugin.settings.searchFolders)),
        entry("新建笔记时自动补全属性", "new-note-defaults", ["Notebook Navigator", "Base", "数据库", "属性"], "Notebook Navigator 新建空白笔记后，按目录参考 .base 数据库补齐属性。"),
      ] },
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
    const { containerEl } = this;
    if (this.page.type !== "sync-sharing") this.syncTab.hide();
    containerEl.empty();
    containerEl.addClass("simple-settings");
    this.renderPlatformHint(containerEl);

    if (this.page.type === "sync-sharing") {
      const titleEl = this.renderPageHeader(containerEl, "同步", () => {
        if (!this.syncTab.backToOverview()) this.openPage({ type: "overview" });
      });
      this.syncTab.renderInto(containerEl.createDiv({ cls: "simple-one-sync-feature" }), title => titleEl.setText(title));
    } else if (this.page.type === "overview") {
      this.renderOverview(containerEl);
    } else if (this.page.type === "html-preview") {
      this.renderHtmlPreviewSettings(containerEl);
    } else if (this.page.type === "link-rules") {
      this.renderLinkRules(containerEl);
    } else if (this.page.type === "template-rules") {
      this.renderTemplateRules(containerEl);
    } else if (this.page.type === "attachment-organizer") {
      this.renderAttachmentOrganizerSettings(containerEl);
    } else if (this.page.type === "new-note-defaults") {
      this.renderNewNoteDefaults(containerEl);
    } else if (this.page.type === "search-folders") {
      this.renderSearchFolderSettings(containerEl);
    } else if (this.page.type === "calendar-diary") {
      this.renderCalendarDiarySettings(containerEl);
    } else if (this.page.type === "diary") {
      this.renderDiarySettings(containerEl);
    } else if (this.page.type === "reformat") {
      this.renderReformatSettings(containerEl);
    } else if (this.page.type === "reformat-rules") {
      this.renderReformatRules(containerEl);
    } else if (this.page.type === "quick-format") {
      this.renderQuickFormatSettings(containerEl);
    } else if (this.page.type === "quick-format-headings") {
      this.renderQuickFormatHeadingSettings(containerEl);
    } else if (this.page.type === "quick-format-callouts") {
      this.renderQuickFormatCalloutSettings(containerEl);
    } else if (this.page.type === "display-enhancements") {
      this.renderDisplayEnhancementSettings(containerEl);
    } else if (this.page.type === "notion-columns") {
      this.renderNotionColumnsSettings(containerEl);
    } else if (this.page.type === "event-reminders") {
      this.renderEventReminderSettings(containerEl);
    } else if (this.page.type === "date-management") {
      this.renderDateManagementSettings(containerEl);
    } else if (this.page.type === "holiday-management") {
      this.renderHolidayManagementSettings(containerEl);
    } else if (this.page.type === "category-manager") {
      this.renderCategoryManager(containerEl);
    } else {
      this.renderCategorySites(containerEl, this.page.categoryId);
    }
  }

  private renderPlatformHint(container: HTMLElement): HTMLDivElement {
    return container.createDiv({
      cls: "simple-platform-hint",
      text: this.plugin.isMobile
        ? "已使用手机平台，已切换为手机端专属配置"
        : `检测到当前平台为 ${this.plugin.platformName}，当前使用桌面显示设置。`,
    });
  }

  private renderOverview(container: HTMLElement): void {
    for (const group of this.getSettingDefinitions()) {
      if (!("type" in group) || group.type !== "group") continue;
      this.renderGroup(container, group.heading ?? "", (card) => {
        for (const [index, item] of (group.items ?? []).entries()) {
          if ("action" in item && item.action) {
            const action = item.action;
            const icon = item.name === QUICK_FORMAT_NAME ? QUICK_FORMAT_ICON : item.name === REFORMAT_NAME ? REFORMAT_ICON : "chevron-right";
            this.renderNavigationItem(card, item.name, typeof item.desc === "string" ? item.desc : item.desc?.textContent ?? "", () => action(card, index), icon);
          } else if ("control" in item && item.control?.type === "toggle") {
            const key = item.control.key;
            new Setting(card).setName(item.name).setDesc(item.desc ?? "").addToggle((toggle) =>
              toggle.setValue(Boolean(this.getControlValue(key))).setDisabled(this.plugin.isMobile)
                .onChange((value) => this.setControlValue(key, value)));
          }
        }
      });
    }
  }

  private renderDisplayEnhancementSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "显示增强");

    this.renderSectionHeading(container, "参数优化")
      .setClass("simple-parameter-heading")
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", "查看和编辑的平台参数");
        dropdown
          .addOptions({ desktop: "电脑", mobile: "手机" })
          .setValue(this.parameterPlatform)
          .onChange((value) => {
            this.parameterPlatform = value === "mobile" ? "mobile" : "desktop";
            renderParameters();
          });
      });
    const card = container.createDiv({ cls: "simple-card" });
    const renderParameters = (): void => {
      card.empty();
      const mobile = this.parameterPlatform === "mobile";
      const profile = {
        suffix: mobile ? "（手机）" : "",
        mobile,
        settings: mobile ? this.plugin.settings.mobileDisplay : this.plugin.settings,
      };
      new Setting(card)
        .setName(`弹出窗口缩放比例${profile.suffix}`)
        .setDesc(`${profile.mobile ? "手机端自动" : "电脑端"}使用此比例显示设置窗口和附件清单；填写 40–95，0 或留空则不调整。`)
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.inputEl.max = String(POPUP_SCALE_MAX);
          text.inputEl.step = "5";
          text
            .setPlaceholder(profile.mobile ? "默认 0；不调整" : "默认 70；留空不调整")
            .setValue(profile.settings.popupWindowScale)
            .onChange(async (value) => {
              profile.settings.popupWindowScale = value.trim();
              await this.plugin.saveSettings();
              this.plugin.refreshPopupWindowSizing();
            });
        });
      new Setting(card)
        .setName(`笔记正文宽度${profile.suffix}`)
        .setDesc(profile.mobile
          ? "手机端的最大可读行宽，单位为 px；建议留空。大于屏幕可用宽度时通常无明显效果，小于可用宽度时才会收窄正文。需开启 Obsidian 的“可读行长”。"
          : "电脑端的最大可读行宽，单位为 px；需要开启 Obsidian 的“可读行长”。留空则跟随主题默认值。")
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = profile.mobile ? "1" : "400";
          text.inputEl.max = "2000";
          text.inputEl.step = "20";
          text
            .setPlaceholder(profile.mobile ? "建议留空，跟随主题" : "例如 900；留空跟随主题")
            .setValue(profile.settings.readableLineWidth)
            .onChange(async (value) => {
              profile.settings.readableLineWidth = value.trim();
              this.plugin.applyReadableLineWidth();
              await this.plugin.saveSettings();
            });
        });
      new Setting(card)
        .setName(`图片高度${profile.suffix}`)
        .setDesc(`${profile.mobile ? "手机端" : "电脑端"}笔记图片的最大显示高度，按原比例自动缩放；留空表示不限制。`)
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "1";
          text
            .setPlaceholder("留空关闭")
            .setValue(profile.settings.imageMaxHeight)
            .onChange(async (value) => {
              profile.settings.imageMaxHeight = value.trim();
              this.plugin.applyImageHeightLimit();
              await this.plugin.saveSettings();
            });
        });
      if (mobile) {
        const settings = this.plugin.settings.mobileDisplay;
        const sizeSetting = new Setting(card).setName("顶部按钮大小（手机）");
        const updateSizeDescription = (): void => {
          const button = this.plugin.isMobile ? document.querySelector<HTMLElement>(".workspace-leaf.mod-active .view-header .view-action, .view-header .view-action") : null;
          const measured = button ? Math.round(button.getBoundingClientRect().width) : 0;
          sizeSetting.setDesc(`${measured ? `当前实际大小：${measured}px。` : `手机配置：${settings.headerButtonSize || "跟随主题"}${settings.headerButtonSize ? "px" : ""}。`}调整顶部操作按钮和侧边栏按钮的大小，范围 20–64px；默认 29px，留空跟随主题。`);
        };
        sizeSetting.addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "20";
          text.inputEl.max = "64";
          text.inputEl.step = "1";
          text.setPlaceholder("默认 29；留空跟随主题").setValue(settings.headerButtonSize).onChange(async (value) => {
            settings.headerButtonSize = value.trim();
            this.plugin.applyMobileHeaderButtons();
            await this.plugin.saveSettings();
            updateSizeDescription();
          });
        });
        updateSizeDescription();
        new Setting(card)
          .setName("禁用当前主题自带的手机端按钮样式")
          .setDesc("默认开启，关闭当前 Things 主题的圆形悬浮按钮外观，使用原生风格；按钮大小仍由上方设置控制。")
          .addToggle((toggle) => toggle.setValue(settings.disableThemeHeaderButtons).onChange(async (value) => {
            settings.disableThemeHeaderButtons = value;
            this.plugin.applyMobileHeaderButtons();
            await this.plugin.saveSettings();
            updateSizeDescription();
          }));
      }
    };
    renderParameters();

    this.renderGroup(container, "功能增强", (card) => {
      card.createDiv({
        cls: "simple-muted-subtitle",
        text: "本组功能开关为电脑、手机两端共用。",
      });
      new Setting(card)
        .setName("窗口定位优化")
        .setDesc("电脑端自动将超出屏幕的弹出窗口移回可见范围，避免插件市场等窗口顶部被遮住。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableWindowPositionOptimization).onChange(async (value) => {
            this.plugin.settings.enableWindowPositionOptimization = value;
            await this.plugin.saveSettings();
          })
        );
      this.renderNavigationItem(card, "双列显示内容", "在正文中创建和编辑双列视图。", () => this.openPage({ type: "notion-columns" }));
      this.renderNavigationItem(
        card,
        "HTML 预览",
        "管理 HTML 预览开关和预览前正则替换规则。",
        () => this.openPage({ type: "html-preview" })
      );
      new Setting(card)
        .setName("图片点击可放大")
        .setDesc("点击笔记中的图片打开大图；在大图上滚轮缩放，点空白处或按 Esc 关闭。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableImageZoom).onChange(async (value) => {
            this.plugin.settings.enableImageZoom = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(card)
        .setName("Mermaid 流程图交互")
        .setDesc("为流程图提供适应面板宽度、滚轮缩放与拖动画布，以及全屏查看。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableMermaidEnhancer).onChange(async (value) => {
            this.plugin.settings.enableMermaidEnhancer = value;
            await this.plugin.saveSettings();
            this.plugin.refreshMermaidEnhancements();
          })
        );

      new Setting(card)
        .setName("颜色代码预览")
        .setDesc("在编辑器中的 HEX、RGB、RGBA、HSL 和 HSLA 颜色代码前显示对应的颜色方块。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableColorPreview).onChange(async (value) => {
            this.plugin.settings.enableColorPreview = value;
            await this.plugin.saveSettings();
            this.plugin.refreshColorPreviews();
          })
        );

      new Setting(card)
        .setName("自定义标签阅读排版")
        .setDesc("阅读模式下让 thinking/content/todo 等自定义标签按块显示，并保留换行。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableReadableCustomTags).onChange(async (value) => {
            this.plugin.settings.enableReadableCustomTags = value;
            await this.plugin.saveSettings();
            this.plugin.applyReadableCustomTagStyles();
          })
        );
    });
  }

  private renderNotionColumnsSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "双列显示内容", () => this.openPage({ type: "display-enhancements" }));
    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用双列视图")
        .setDesc("在笔记中创建、编辑和调整双列内容。")
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.enableNotionColumns).onChange(async (value) => {
          this.plugin.settings.enableNotionColumns = value;
          await this.plugin.saveSettings();
          this.app.workspace.updateOptions();
        }));

      const shortcut = new Setting(card)
        .setName("双列快捷键")
        .setDesc("在空白行按快捷键，可插入空白双列。\n选中正文后按快捷键，会在选区原位生成双列。\n也可选中内容后同时按下左右鼠标键，拖动预览到其他位置。")
        .setClass("simple-columns-hotkey-setting");
      const status = shortcut.descEl.createDiv({ cls: "simple-hotkey-status" });
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
    });
  }

  private renderSearchFolderSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "搜索增强");
    const config = this.plugin.settings.searchFolders;

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用搜索增强")
        .setDesc("在 Obsidian 原生搜索中显示搜索增强，并自动应用这里保存的条件。")
        .addToggle((toggle) =>
          toggle.setValue(config.enabled).onChange(async (value) => {
            config.enabled = value;
            await this.plugin.saveSettings();
            this.plugin.refreshSearchFolderControls();
            this.renderSettings();
          })
        );

      const dependent = card.createDiv({ cls: "simple-search-folder-dependent" });
      dependent.toggleClass("is-disabled", !config.enabled);
      dependent.setAttr("aria-disabled", String(!config.enabled));

      new Setting(dependent)
        .setName("仅搜索所选文件夹")
        .setDesc(config.includeFolders.length ? config.includeFolders.join("、") : "尚未选择文件夹")
        .addButton((button) =>
          button.setButtonText("选择文件夹").setDisabled(!config.enabled).onClick(() => {
            openSearchFolderPicker(this.plugin, config.includeFolders, async (folders) => {
              config.includeFolders = folders;
              await this.plugin.saveSettings();
              this.plugin.refreshSearchFolderControls();
              this.renderSettings();
            }, "选择限定搜索的文件夹");
          })
        );

      new Setting(dependent)
        .setName("屏蔽所选文件夹")
        .setDesc(config.excludeFolders.length ? config.excludeFolders.join("、") : "尚未选择文件夹")
        .addButton((button) =>
          button.setButtonText("选择文件夹").setDisabled(!config.enabled).onClick(() => {
            openSearchFolderPicker(this.plugin, config.excludeFolders, async (folders) => {
              config.excludeFolders = folders;
              await this.plugin.saveSettings();
              this.plugin.refreshSearchFolderControls();
              this.renderSettings();
            }, "选择需要屏蔽的文件夹");
          })
        );
    });
  }

  private renderAttachmentOrganizerSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "附件优化");
    const location = readObsidianAttachmentLocation(this.plugin);
    const disabledReasons = attachmentOrganizerDisabledReasons(location.mode);

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("当前附件存放模式")
        .setDesc("沿用 Obsidian「文件与链接」里的附件设置；不同模式会自动限制高风险功能。")
        .addText((text) =>
          text
            .setValue(describeAttachmentLocation(location))
            .setDisabled(true)
        );
      if (location.mode === "vault-root") {
        card.createDiv({
          cls: "simple-attachment-mode-warning",
          text: "当前附件默认存放在 Vault 根目录。附件优化可能扫描并误处理普通笔记和资源文件，为避免误删，所有功能已禁用。",
        });
        const quickConfig = card.createDiv({ cls: "simple-attachment-quick-config" });
        quickConfig.createSpan({ text: "将所有附件放入指定文件夹（默认 Attachment；仅影响新附件）" });
        const button = quickConfig.createEl("button", { text: "快速配置", attr: { type: "button" } });
        button.addEventListener("click", () => void this.quickConfigureAttachmentFolder(button));
      } else if (location.mode === "unknown") {
        card.createDiv({
          cls: "simple-attachment-mode-warning",
          text: "无法识别当前附件存放设置。插件将按高风险状态处理，所有附件优化功能已禁用。",
        });
      }
    });

    this.renderSettingCard(container, (card) => {
      this.renderAttachmentOrganizerAction(
        card,
        "清理未引用附件",
        "扫描附件目录，列出未被 Markdown 引用的文件；确认后移入 Obsidian 回收站。",
        "开始检查",
        disabledReasons.unused,
        () => void checkUnusedAttachments(this.plugin)
      );

      this.renderAttachmentOrganizerAction(
        card,
        location.mode === "same-folder" || location.mode === "current-subfolder" ? "图片重命名" : "图片重命名并按笔记归位",
        location.mode === "same-folder" || location.mode === "current-subfolder"
          ? "检查已被 Markdown 引用且名称明显无意义的图片；保留所在目录，只修改文件名。"
          : "检查文件名明显无意义的图片，根据引用笔记完成重命名和目录归位。",
        "开始检查",
        disabledReasons.imageRename,
        () => void planAttachmentImageRename(this.plugin)
      );

      this.renderAttachmentOrganizerAction(
        card,
        "非图片附件按笔记归位",
        "检查 JSON、txt、PDF 等非图片附件，根据引用笔记归位至相应附件目录。",
        "开始检查",
        disabledReasons.organization,
        () => void planAttachmentOrganization(this.plugin)
      );

      this.renderAttachmentOrganizerAction(
        card,
        "内嵌图片转为附件",
        "扫描 Markdown 中直接嵌入的 base64 图片，将其保存为独立附件，并替换为 Obsidian 图片链接。",
        "生成清单",
        disabledReasons.inlineExtraction,
        () => void planInlineImageExtraction(this.plugin)
      );
    });
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
      setting?.openTabById?.("files");
    };
    if (!vault.setConfig) {
      openFileSettings();
      new Notice("请在“文件与链接”中将新附件的默认位置设为指定文件夹：Attachment");
      return;
    }

    button.disabled = true;
    try {
      const folder = vault.getAbstractFileByPath("Attachment");
      if (folder && !(folder instanceof TFolder)) {
        new Notice("Attachment 已被文件占用，请在“文件与链接”中手动选择其他文件夹");
        openFileSettings();
        return;
      }
      if (!folder) await vault.createFolder("Attachment");
      await vault.setConfig("attachmentFolderPath", "Attachment");
      const updated = readObsidianAttachmentLocation(this.plugin);
      if (updated.mode !== "fixed-folder" || updated.folder !== "Attachment") {
        throw new Error("Obsidian 未应用附件目录设置");
      }
      this.renderSettings();
      openFileSettings();
      new Notice("以后新增的附件将存放在 Attachment；现有附件不会自动移动");
    } catch (error) {
      openFileSettings();
      new Notice(`快速配置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  private renderAttachmentOrganizerAction(
    container: HTMLElement,
    name: string,
    description: string,
    buttonText: string,
    disabledReason: string | null,
    onClick: () => void
  ): void {
    const setting = new Setting(container)
      .setName(name)
      .setDesc(description)
      .addButton((button) => {
        button.setButtonText(buttonText).setDisabled(Boolean(disabledReason));
        if (!disabledReason) button.onClick(onClick);
      });
    if (disabledReason) {
      setting.descEl.createDiv({ cls: "simple-attachment-disabled-reason", text: disabledReason });
    }
  }

  private renderHtmlPreviewSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "HTML 预览", () => this.openPage({ type: "display-enhancements" }));

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用 HTML 预览")
        .setDesc("把 HTML 代码块渲染成预览；支持预览内的样式，忽略脚本。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableHtmlPreview).onChange(async (value) => {
            this.plugin.settings.enableHtmlPreview = value;
            await this.plugin.saveSettings();
            this.plugin.refreshHtmlPreviews();
          })
        );
    });

    const card = container.createDiv({ cls: "simple-card" });
    const header = card.createDiv({ cls: "simple-card-header" });
    const copy = header.createDiv();
    copy.createDiv({ cls: "simple-card-title", text: "预览规则" });
    copy.createDiv({
      cls: "setting-item-description",
      text: "按顺序执行正则替换；只影响预览显示，不修改原始笔记内容。",
    });
    const headerActions = header.createDiv({ cls: "simple-card-actions" });
    const add = headerActions.createEl("button", { cls: "mod-cta simple-add-button" });
    add.setText("添加规则");
    add.addEventListener("click", runAsync(async () => {
      this.plugin.settings.htmlPreviewRules.push(makeHtmlPreviewRule());
      await this.plugin.saveSettings();
      this.renderSettings();
    }));
    const importButton = headerActions.createEl("button", { cls: "simple-soft-button" });
    importButton.setText("导入规则");
    importButton.addEventListener("click", runAsync(async () => {
      const value = await importJsonFile();
      if (!value) return;
      const rule = importHtmlPreviewRule(value);
      if (!rule) {
        new Notice("导入失败：未识别导入规则的匹配或替换字段");
        return;
      }
      const rules = this.plugin.settings.htmlPreviewRules;
      const existing = rules.findIndex((item) => item.importId === rule.importId);
      if (existing >= 0) rules[existing] = { ...rules[existing], ...rule, id: rules[existing].id };
      else rules.push(rule);
      await this.plugin.saveSettings();
      this.plugin.refreshHtmlPreviews();
      this.renderSettings();
    }));

    const head = card.createDiv({ cls: "simple-reformat-rule-row simple-rule-head" });
    head.createDiv({ text: "启用" });
    head.createDiv({ text: "名称" });
    head.createDiv({ text: "匹配正则" });
    head.createDiv({ text: "标记" });
    head.createDiv({ text: "替换为" });
    head.createDiv();
    head.createDiv();

    for (let i = 0; i < this.plugin.settings.htmlPreviewRules.length; i++) {
      this.renderHtmlPreviewRule(card, this.plugin.settings.htmlPreviewRules[i], i);
    }
  }

  private renderHtmlPreviewRule(card: HTMLElement, rule: HtmlPreviewRule, index: number): void {
    const row = card.createDiv({ cls: "simple-reformat-rule-row" });
    const toggleWrap = row.createDiv({ cls: "simple-rule-toggle" });
    new Setting(toggleWrap).addToggle((toggle) =>
      toggle.setValue(rule.enabled).onChange(async (value) => {
        rule.enabled = value;
        await this.plugin.saveSettings();
        this.plugin.refreshHtmlPreviews();
      })
    );
    this.textInput(row, rule.name, "例如：剧本块转 HTML", async (value) => {
      rule.name = value;
      await this.plugin.saveSettings();
    });
    this.textInput(row, rule.pattern, "正则表达式", async (value) => {
      rule.pattern = value;
      await this.plugin.saveSettings();
      this.plugin.refreshHtmlPreviews();
    });
    this.textInput(row, rule.flags || "g", "gm", async (value) => {
      rule.flags = value || "g";
      await this.plugin.saveSettings();
      this.plugin.refreshHtmlPreviews();
    });
    this.textInput(row, rule.replaceWith, "替换后的 HTML", async (value) => {
      rule.replaceWith = value;
      await this.plugin.saveSettings();
      this.plugin.refreshHtmlPreviews();
    });
    const exportButton = row.createEl("button", { cls: "simple-rule-del", attr: { title: "导出规则", "aria-label": "导出规则" } });
    setIcon(exportButton, "download");
    exportButton.addEventListener("click", () => {
      downloadJsonFile(`${slugify(rule.name || "html-preview-rule")}.json`, exportHtmlPreviewRule(rule));
    });
    const del = row.createEl("button", { cls: "simple-rule-del", attr: { title: "删除规则", "aria-label": "删除规则" } });
    setIcon(del, "trash-2");
    del.addEventListener("click", runAsync(async () => {
      this.plugin.settings.htmlPreviewRules.splice(index, 1);
      await this.plugin.saveSettings();
      this.plugin.refreshHtmlPreviews();
      this.renderSettings();
    }));
  }

  private renderLinkRules(container: HTMLElement): void {
    this.renderPageHeader(container, "超链接标题提取", () => this.openPage({ type: "reformat" }));
    this.renderFilterRules(container);
  }

  private renderPasteLinkSettings(container: HTMLElement): void {
    this.renderIconGroup(container, "link", "URL 粘贴设置", (card) => {
      this.renderPasteLinkModeSetting(
        card,
        "单个 URL 自动处理为超链接",
        "粘贴单个 URL 时，将普通 URL 处理为 Markdown 超链接，将 obsidian:// 处理为 Obsidian 双链。",
        this.plugin.settings.autoProcessPaste && this.plugin.settings.autoProcessObsidian,
        async (value) => {
          this.plugin.settings.autoProcessPaste = value;
          this.plugin.settings.autoProcessObsidian = value;
          await this.plugin.saveSettings();
        },
        this.plugin.settings.plainTextPasteSkipsSingleLinkProcessing,
        async (value) => {
          this.plugin.settings.plainTextPasteSkipsSingleLinkProcessing = value;
          await this.plugin.saveSettings();
        }
      );
      this.renderPasteLinkModeSetting(
        card,
        "文本中的 URL 自动处理为超链接",
        "粘贴文本时，识别其中的裸 URL，并处理为 Markdown 超链接。",
        this.plugin.settings.autoProcessPastedTextLinks,
        async (value) => {
          this.plugin.settings.autoProcessPastedTextLinks = value;
          await this.plugin.saveSettings();
        },
        this.plugin.settings.plainTextPasteSkipsContentLinkScan,
        async (value) => {
          this.plugin.settings.plainTextPasteSkipsContentLinkScan = value;
          await this.plugin.saveSettings();
        }
      );
      this.renderNavigationItem(
        card,
        "超链接标题提取",
        "使用正则清理网页标题中的赘余文字，精简标题。",
        () => this.openPage({ type: "link-rules" }),
        "text-search"
      );
    });
  }

  private renderPasteLinkModeSetting(
    container: HTMLElement,
    name: string,
    description: string,
    enabled: boolean,
    onEnabledChange: (value: boolean) => Promise<void>,
    bypassOnPlainTextPaste: boolean,
    onBypassChange: (value: boolean) => Promise<void>
  ): void {
    new Setting(container)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) => toggle.setValue(enabled).onChange(onEnabledChange));
    const label = container.createEl("label", {
      cls: "simple-paste-mode-bypass simple-quiet-checkbox setting-item-description",
    });
    const input = label.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": `${name}：Ctrl+Shift+V 仅粘贴原始文本` },
    });
    input.checked = bypassOnPlainTextPaste;
    const box = label.createSpan({ cls: "simple-quiet-checkbox-box" });
    setIcon(box, "check");
    label.createSpan({ text: "使用 Ctrl+Shift+V 粘贴时，仅粘贴原始文本，不处理任何 URL" });
    input.addEventListener("change", () => void onBypassChange(input.checked));
  }

  private renderReformatQuickRuleCheckbox(
    container: HTMLElement,
    name: string,
    checked: boolean,
    onChange: (value: boolean) => Promise<void>
  ): void {
    const label = container.createEl("label", {
      cls: "simple-reformat-quick-rule simple-quiet-checkbox setting-item-description",
    });
    const input = label.createEl("input", { type: "checkbox", attr: { "aria-label": name } });
    input.checked = checked;
    const box = label.createSpan({ cls: "simple-quiet-checkbox-box" });
    setIcon(box, "check");
    label.createSpan({ text: name });
    input.addEventListener("change", () => void onChange(input.checked));
  }

  private renderFilterRules(container: HTMLElement): void {
    const card = container.createDiv({ cls: "simple-card" });
    const header = card.createDiv({ cls: "simple-card-header" });
    const copy = header.createDiv();
    copy.createDiv({ cls: "simple-card-title", text: "过滤规则" });
    copy.createDiv({
      cls: "setting-item-description",
      text: "按顺序匹配，命中即停止。URL 留空 = 全部，提取正则为空 = 不过滤。替换为留空 = 全部捕获组拼接。",
    });
    const add = header.createEl("button", { cls: "mod-cta simple-add-button" });
    add.setText("添加规则");
    add.addEventListener("click", runAsync(async () => {
      this.plugin.settings.filterRules.push(makeFilterRule());
      await this.plugin.saveSettings();
      this.renderSettings();
    }));

    const head = card.createDiv({ cls: "simple-rule-row simple-rule-head" });
    head.createDiv({ text: "启用" });
    head.createDiv({ text: "URL 匹配正则" });
    head.createDiv({ text: "标题提取正则" });
    head.createDiv({ text: "替换为" });
    head.createDiv();

    for (let i = 0; i < this.plugin.settings.filterRules.length; i++) {
      const rule = this.plugin.settings.filterRules[i];
      const row = card.createDiv({ cls: "simple-rule-row" });
      const toggleWrap = row.createDiv({ cls: "simple-rule-toggle" });
      new Setting(toggleWrap).addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
        })
      );

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

      const del = row.createEl("button", {
        cls: "simple-rule-del",
        attr: { title: "删除规则", "aria-label": "删除规则" },
      });
      setIcon(del, "x");
      del.addEventListener("click", runAsync(async () => {
        this.plugin.settings.filterRules.splice(i, 1);
        await this.plugin.saveSettings();
        this.renderSettings();
      }));
    }
  }

  private renderNewNoteDefaults(container: HTMLElement): void {
    this.renderPageHeader(container, "新建笔记时自动补全属性");

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用属性补齐")
        .setDesc("Notebook Navigator 新建空白笔记时，参考每条规则选中的 .base 当前视图列补齐属性。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.newNoteDefaults.enabled).onChange(async (value) => {
            this.plugin.settings.newNoteDefaults.enabled = value;
            await this.plugin.saveSettings();
          })
        );
    });

    const heading = container.createDiv({ cls: "simple-heading-row" });
    this.renderSectionHeading(heading, "参考数据库规则");
    const addButton = heading.createEl("button", { cls: "mod-cta simple-soft-button" });
    addButton.setText("新增");
    addButton.addEventListener("click", runAsync(async () => {
      this.plugin.settings.newNoteDefaults.rules.push(makeNewNoteDatabaseRule());
      await this.plugin.saveSettings();
      this.renderSettings();
    }));

    if (this.plugin.settings.newNoteDefaults.rules.length === 0) {
      const empty = container.createDiv({ cls: "simple-card" });
      empty.createEl("p", { text: "还没有规则。首次在含 .base 的目录中新建空白笔记时会自动记录；也可以点“新增”手动配置。" });
      return;
    }

    for (let index = 0; index < this.plugin.settings.newNoteDefaults.rules.length; index++) {
      this.renderNewNoteDefaultRule(container, this.plugin.settings.newNoteDefaults.rules[index], index);
    }
  }

  private renderNewNoteDefaultRule(container: HTMLElement, rule: NewNoteDatabaseRule, index: number): void {
    this.renderSettingCard(container, (card) => {
      if (!rule.folder) {
        new Setting(card)
          .setName("目录")
          .addText((text) => text
            .setPlaceholder("Notes/Examples")
            .setValue(rule.folder)
            .onChange(async (value) => {
              rule.folder = normalizePath(value.trim());
              await this.plugin.saveSettings();
            }));
      }

      const options = this.baseOptionsForFolder(rule.folder);
      const listId = `simple-new-note-base-${rule.id}`;
      if (options.length > 0) {
        const list = card.createEl("datalist");
        list.id = listId;
        for (const option of options) {
          list.createEl("option", { attr: { value: option } });
        }
      }

      new Setting(card)
        .setName(rule.folder || "未设置目录")
        .setDesc("参考 Base 当前视图列。输入 / 可从当前目录下的 .base 中选择。")
        .addText((text) => {
          text
            .setPlaceholder("/目录.base")
            .setValue(this.relativeDatabasePath(rule))
            .onChange(async (value) => {
              rule.databasePath = this.composeDatabasePath(rule.folder, value);
              await this.plugin.saveSettings();
            });
          if (options.length > 0) text.inputEl.setAttr("list", listId);
        })
        .addButton((button) => button
          .setButtonText("选择")
          .onClick(() => this.openDatabasePicker(rule)))
        .addExtraButton((button) => button
          .setIcon("trash-2")
          .setTooltip("删除规则")
          .onClick(async () => {
            this.plugin.settings.newNoteDefaults.rules.splice(index, 1);
            await this.plugin.saveSettings();
            this.renderSettings();
          }));
    });
  }

  private openDatabasePicker(rule: NewNoteDatabaseRule): void {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(rule.folder));
    if (!(folder instanceof TFolder)) {
      new Notice("请先填写有效目录");
      return;
    }
    const bases = this.baseFilesForFolder(folder);
    if (bases.length === 0) {
      new Notice("这个目录下没有 .base 数据库文件");
      return;
    }
    new DatabasePickerModal(this.app, bases, async (base) => {
      rule.databasePath = base.path;
      await this.plugin.saveSettings();
      this.renderSettings();
    }).open();
  }

  private relativeDatabasePath(rule: NewNoteDatabaseRule): string {
    const folder = normalizePath(rule.folder);
    const databasePath = normalizePath(rule.databasePath);
    if (!folder || !databasePath) return databasePath;
    return databasePath === folder ? "" : databasePath.startsWith(`${folder}/`) ? `/${databasePath.slice(folder.length + 1)}` : databasePath;
  }

  private composeDatabasePath(folder: string, input: string): string {
    const value = input.trim();
    if (!value) return "";
    const normalized = normalizePath(value.replace(/^\/+/, ""));
    if (!folder || value.includes(":")) return normalizePath(value);
    const currentFolder = normalizePath(folder);
    if (normalized === currentFolder || normalized.startsWith(`${currentFolder}/`)) return normalized;
    return normalizePath(`${currentFolder}/${normalized}`);
  }

  private baseOptionsForFolder(folderPath: string): string[] {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!(folder instanceof TFolder)) return [];
    const prefixLength = folder.path ? folder.path.length + 1 : 0;
    return this.baseFilesForFolder(folder)
      .map((file) => `/${file.path.slice(prefixLength)}`)
      .sort((a, b) => a.localeCompare(b));
  }

  private baseFilesForFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    const walk = (current: TFolder) => {
      for (const child of current.children) {
        if (child instanceof TFile && child.extension === "base") {
          files.push(child);
        } else if (child instanceof TFolder) {
          walk(child);
        }
      }
    };
    walk(folder);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private renderTemplateRules(container: HTMLElement): void {
    this.renderPageHeader(container, "新建快速笔记");

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用新建快速笔记")
        .setDesc("支持剪贴板链接直接转笔记，也可在右侧面板已配置好的网站内进行搜索并快速生成笔记。关闭后需重启生效。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableTemplateFill).onChange(async (value) => {
            this.plugin.settings.enableTemplateFill = value;
            await this.plugin.saveSettings();
          })
        );
      new Setting(card)
        .setName("笔记标题栏快捷按钮")
        .setDesc("在笔记标题栏显示快捷按钮；点击后读取剪贴板内容，自动处理链接或搜索词，并打开右侧操作面板。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enableTemplateFillAction).onChange(async (value) => {
            this.plugin.settings.enableTemplateFillAction = value;
            await this.plugin.saveSettings();
            this.plugin.refreshTemplateFillActions();
          })
        );
      new Setting(card)
        .setName("显示空搜索结果")
        .setDesc("书名自动搜索时，网站没有候选或被拦截也显示 0 个结果的站点盒子。")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.showEmptySearchGroups).onChange(async (value) => {
            this.plugin.settings.showEmptySearchGroups = value;
            await this.plugin.saveSettings();
          })
        );
    });

    const heading = container.createDiv({ cls: "simple-heading-row" });
    this.renderSectionHeading(heading, "网站管理");
    const manage = heading.createEl("button", { cls: "simple-add-button" });
    manage.setText("管理分类");
    manage.addEventListener("click", () => this.openPage({ type: "category-manager" }));

    const CAT_ICONS: Record<string, string> = { "网文书评": "📚", "Agent Skills": "🤖" };
    const cats = this.plugin.settings.templateCategories;

    for (const cat of cats) {
      const card = container.createDiv({ cls: "simple-template-card" });

      const left = card.createDiv({ cls: "simple-template-label" });
      left.createDiv({ cls: "simple-template-icon", text: CAT_ICONS[cat.name] || cat.icon || "📄" });
      left.createDiv({ cls: "simple-template-name", text: cat.name || "新建分类" });

      const right = card.createDiv({ cls: "simple-template-main" });
      const output = right.createDiv({ cls: "simple-template-line" });
      output.createSpan({ cls: "simple-template-line-label", text: "输出" });
      output.createSpan({ cls: "simple-template-summary", text: cat.outputFolder || "当前库根目录" });

      const sites = right.createDiv({ cls: "simple-template-line" });
      sites.createSpan({ cls: "simple-template-line-label", text: "网站" });
      const badgeWrap = sites.createDiv({ cls: "simple-site-badges" });
      const labels = cat.siteRules.map((siteRule) => siteSummary(siteRule)).filter(Boolean);
      if (labels.length === 0) {
        badgeWrap.createSpan({ cls: "simple-empty-text", text: "(未配置)" });
      }
      for (const label of labels) {
        badgeWrap.createSpan({ cls: "simple-site-badge", text: label });
      }

      const next = card.createEl("button", {
        cls: "simple-next-button",
        attr: { title: "管理网站规则", "aria-label": "管理网站规则" },
      });
      setIcon(next, "chevron-right");
      next.addEventListener("click", () => this.openPage({ type: "category-sites", categoryId: cat.id }));
    }
  }

  private renderCategoryManager(container: HTMLElement): void {
    this.renderPageHeader(container, "管理分类", () => this.openPage({ type: "template-rules" }));

    const heading = container.createDiv({ cls: "simple-heading-row" });
    this.renderSectionHeading(heading, "当前分类");
    const headingActions = heading.createDiv({ cls: "simple-heading-actions" });
    const addButton = headingActions.createEl("button", { cls: "mod-cta simple-soft-button" });
    addButton.setText("新增");
    addButton.addEventListener("click", () => {
      const draft = makeBlankCategory();
      this.openJsonModal("新增分类 JSON", formatJson(draft), async (value) => {
        const category = normalizeCategory(value);
        upsertById(this.plugin.settings.templateCategories, category);
        await this.plugin.saveSettings();
        this.renderSettings();
      });
    });

    this.renderMoreButton(headingActions, [
      {
        title: "导入",
        icon: "upload",
        onClick: async () => {
          const value = await importJsonFile();
          if (!value) return;
          const categories = normalizeCategoryImport(value);
          for (const category of categories) {
            upsertById(this.plugin.settings.templateCategories, category);
          }
          await this.plugin.saveSettings();
          new Notice(`已导入 ${categories.length} 个分类`);
          this.renderSettings();
        },
      },
      {
        title: "导出",
        icon: "download",
        onClick: () => {
          downloadJsonFile("simple-template-categories.json", {
            type: "simple-plugin.template-categories",
            version: 1,
            categories: this.plugin.settings.templateCategories,
          });
          new Notice("分类 JSON 已导出为文件");
        },
      },
      {
        title: "删除模式",
        icon: "trash-2",
        onClick: () => {
          this.deleteMode = { type: "categories", selectedIds: new Set() };
          this.renderSettings();
        },
      },
    ]);

    const card = container.createDiv({ cls: "simple-card simple-json-list" });
    const deleteMode = this.deleteMode?.type === "categories" ? this.deleteMode : null;
    for (let index = 0; index < this.plugin.settings.templateCategories.length; index++) {
      const category = this.plugin.settings.templateCategories[index];
      const row = card.createDiv({ cls: "simple-json-row" });
      if (deleteMode) {
        row.addClass("is-delete-selectable");
        if (deleteMode.selectedIds.has(category.id)) row.addClass("is-selected-for-delete");
        row.addEventListener("click", () => {
          this.toggleDeleteSelection(deleteMode, category.id);
          row.classList.toggle("is-selected-for-delete", deleteMode.selectedIds.has(category.id));
          const state = row.querySelector<HTMLElement>(".simple-delete-check");
          if (state) state.setText(deleteMode.selectedIds.has(category.id) ? "已选" : "选择");
        });
      }
      row.createDiv({ cls: "simple-json-name", text: category.name || "(未命名分类)" });
      if (deleteMode) {
        row.createDiv({
          cls: "simple-delete-check",
          text: deleteMode.selectedIds.has(category.id) ? "已选" : "选择",
        });
      } else {
        this.renderJsonActions(row, {
          editLabel: "编辑",
          editTitle: `编辑分类 JSON：${category.name || "未命名分类"}`,
          editValue: category,
          onSave: async (value) => {
            this.plugin.settings.templateCategories[index] = normalizeCategory(value);
            await this.plugin.saveSettings();
            this.renderSettings();
          },
        });
      }
    }
    if (deleteMode) {
      this.renderDeleteBar(container, deleteMode.selectedIds.size, async () => {
        if (deleteMode.selectedIds.size === 0) {
          new Notice("还没有选择要删除的分类");
          return;
        }
        if (!await confirmAction(this.app, `删除选中的 ${deleteMode.selectedIds.size} 个分类？`)) return;
        this.plugin.settings.templateCategories = this.plugin.settings.templateCategories.filter(
          (category) => !deleteMode.selectedIds.has(category.id)
        );
        await this.plugin.saveSettings();
        this.deleteMode = null;
        this.renderSettings();
      });
    }
  }

  private renderCategorySites(container: HTMLElement, categoryId: string): void {
    const category = this.plugin.settings.templateCategories.find((cat) => cat.id === categoryId);
    if (!category) {
      this.openPage({ type: "template-rules" });
      return;
    }

    this.renderPageHeader(container, category.name || "网站填写与搜索规则", () => this.openPage({ type: "template-rules" }));

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("笔记输出目录")
        .setDesc("当前分类通过网址转笔记或书名搜索生成笔记时使用的输出位置。")
        .addText((text) =>
          text
            .setPlaceholder("Reviews")
            .setValue(category.outputFolder)
            .onChange(async (value) => {
              category.outputFolder = value;
              await this.plugin.saveSettings();
            })
        );
    });

    const heading = container.createDiv({ cls: "simple-heading-row" });
    this.renderSectionHeading(heading, "网站填写与搜索规则");
    const headingActions = heading.createDiv({ cls: "simple-heading-actions" });
    const addButton = headingActions.createEl("button", { cls: "mod-cta simple-soft-button" });
    addButton.setText("新增");
    addButton.addEventListener("click", () => {
      const draft = makeBlankSiteRule();
      this.openJsonModal("新增网站填写与搜索规则 JSON", formatJson(draft), async (value) => {
        const siteRule = normalizeSiteRule(value);
        upsertById(category.siteRules, siteRule);
        await this.plugin.saveSettings();
        this.renderSettings();
      });
    });

    this.renderMoreButton(headingActions, [
      {
        title: "导入",
        icon: "upload",
        onClick: async () => {
          const value = await importJsonFile();
          if (!value) return;
          const siteRules = normalizeSiteRuleImport(value);
          for (const siteRule of siteRules) {
            upsertById(category.siteRules, siteRule);
          }
          await this.plugin.saveSettings();
          new Notice(`已导入 ${siteRules.length} 个网站规则`);
          this.renderSettings();
        },
      },
      {
        title: "导出",
        icon: "download",
        onClick: () => {
          downloadJsonFile(`simple-site-rules-${slugify(category.name || category.id)}.json`, {
            type: "simple-plugin.site-rules",
            version: 1,
            categoryId: category.id,
            categoryName: category.name,
            siteRules: category.siteRules,
          });
          new Notice("网站规则 JSON 已导出为文件");
        },
      },
      {
        title: "删除模式",
        icon: "trash-2",
        onClick: () => {
          this.deleteMode = { type: "site-rules", categoryId: category.id, selectedIds: new Set() };
          this.renderSettings();
        },
      },
    ]);

    const card = container.createDiv({ cls: "simple-card simple-json-list" });
    const deleteMode =
      this.deleteMode?.type === "site-rules" && this.deleteMode.categoryId === category.id
        ? this.deleteMode
        : null;
    for (let index = 0; index < category.siteRules.length; index++) {
      const siteRule = category.siteRules[index];
      const row = card.createDiv({ cls: "simple-json-row" });
      if (deleteMode) {
        row.addClass("is-delete-selectable");
        if (deleteMode.selectedIds.has(siteRule.id)) row.addClass("is-selected-for-delete");
        row.addEventListener("click", () => {
          this.toggleDeleteSelection(deleteMode, siteRule.id);
          row.classList.toggle("is-selected-for-delete", deleteMode.selectedIds.has(siteRule.id));
          const state = row.querySelector<HTMLElement>(".simple-delete-check");
          if (state) state.setText(deleteMode.selectedIds.has(siteRule.id) ? "已选" : "选择");
        });
      }
      row.createDiv({ cls: "simple-json-name", text: siteSummary(siteRule) || "(未命名网站规则)" });
      if (deleteMode) {
        row.createDiv({
          cls: "simple-delete-check",
          text: deleteMode.selectedIds.has(siteRule.id) ? "已选" : "选择",
        });
      } else {
        this.renderJsonActions(row, {
          editLabel: "编辑",
          editTitle: `编辑网站填写与搜索规则 JSON：${siteLabel(siteRule) || "未命名网站规则"}`,
          editValue: siteRule,
          onSave: async (value) => {
            category.siteRules[index] = normalizeSiteRule(value);
            await this.plugin.saveSettings();
            this.renderSettings();
          },
          exportFilename: `simple-site-rule-${slugify(siteLabel(siteRule) || siteRule.id)}.json`,
          exportValue: {
            type: "simple-plugin.site-rule",
            version: 1,
            siteRule,
          },
        });
      }
    }
    if (deleteMode) {
      this.renderDeleteBar(container, deleteMode.selectedIds.size, async () => {
        if (deleteMode.selectedIds.size === 0) {
          new Notice("还没有选择要删除的网站规则");
          return;
        }
        if (!await confirmAction(this.app, `删除选中的 ${deleteMode.selectedIds.size} 个网站规则？`)) return;
        category.siteRules = category.siteRules.filter((siteRule) => !deleteMode.selectedIds.has(siteRule.id));
        await this.plugin.saveSettings();
        this.deleteMode = null;
        this.renderSettings();
      });
    }
  }

  private renderGroup(container: HTMLElement, title: string, render: (card: HTMLElement) => void): void {
    this.renderSectionHeading(container, title);
    this.renderSettingCard(container, render);
  }

  private renderIconGroup(container: HTMLElement, icon: string, title: string, render: (card: HTMLElement) => void): void {
    const label = createFragment();
    const iconEl = createSpan();
    iconEl.className = "simple-section-title-icon";
    setIcon(iconEl, icon);
    label.append(iconEl, document.createTextNode(title));
    this.renderSectionHeading(container, label, "simple-icon-section-title");
    this.renderSettingCard(container, render);
  }

  private renderSectionHeading(container: HTMLElement, title: string | DocumentFragment, extraClass?: string): Setting {
    const heading = new Setting(container).setName(title).setHeading().setClass("simple-section-title");
    if (extraClass) heading.setClass(extraClass);
    return heading;
  }

  private renderSettingCard(container: HTMLElement, render: (card: HTMLElement) => void): void {
    const card = container.createDiv({ cls: "simple-card" });
    render(card);
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
    const back = header.createEl("button", {
      cls: "simple-back-button",
      attr: { title: "返回", "aria-label": "返回" },
    });
    setIcon(back, "arrow-left");
    back.addEventListener("click", onBack);
    return new Setting(header).setName(title).setHeading().setClass("simple-page-title").nameEl;
  }

  private openPage(page: SettingsPage): void {
    if (page.type === "sync-sharing") this.syncTab.resetNavigation();
    this.page = page;
    this.deleteMode = null;
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

  private renderLockedTextSetting(
    container: HTMLElement,
    options: {
      name: string;
      desc: string;
      value: string;
      placeholder: string;
      onSave: (value: string) => Promise<void>;
    }
  ): void {
    let editing = false;
    let savedValue = options.value;
    let input!: HTMLInputElement;
    let editButton!: HTMLButtonElement;

    const setEditing = (value: boolean): void => {
      editing = value;
      input.disabled = !value;
      editButton.setText(value ? "保存" : "修改");
      editButton.toggleClass("mod-cta", value);
      if (value) {
        input.focus();
        input.select();
      }
    };

    const save = async (): Promise<void> => {
      const value = input.value.trim();
      editButton.disabled = true;
      try {
        await options.onSave(value);
        savedValue = value;
        input.value = value;
        setEditing(false);
      } finally {
        editButton.disabled = false;
      }
    };

    new Setting(container)
      .setClass("simple-locked-field-setting")
      .setName(options.name)
      .setDesc(options.desc)
      .addText((text) => {
        input = text.inputEl;
        text.setPlaceholder(options.placeholder).setValue(options.value).setDisabled(true);
        input.addEventListener("keydown", (event) => {
          if (!editing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            input.value = savedValue;
            setEditing(false);
          }
        });
      })
      .addButton((button) => {
        editButton = button.buttonEl;
        button.setButtonText("修改").onClick(async () => {
          if (!editing) {
            setEditing(true);
            return;
          }
          await save();
        });
      });
  }

  private renderJsonActions(
    row: HTMLElement,
    options: {
      editLabel: string;
      editTitle: string;
      editValue: unknown;
      onSave: (value: unknown) => Promise<void>;
      exportFilename?: string;
      exportValue?: unknown;
    }
  ): void {
    const actions = row.createDiv({ cls: "simple-json-actions" });
    const editButton = actions.createEl("button", { cls: "simple-soft-button" });
    editButton.setText(options.editLabel);
    editButton.addEventListener("click", () => {
      this.openJsonModal(options.editTitle, formatJson(options.editValue), options.onSave);
    });
    if (options.exportFilename && options.exportValue !== undefined) {
      const exportButton = actions.createEl("button", { cls: "simple-soft-button" });
      exportButton.setText("导出");
      exportButton.addEventListener("click", () => {
        downloadJsonFile(options.exportFilename!, options.exportValue);
      });
    }
  }

  private renderDiarySettings(container: HTMLElement): void {
    this.renderPageHeader(container, "日记位置", () => this.openPage({ type: "calendar-diary" }));
    const diary = this.plugin.settings.diary;
    const navigator = this.plugin.isMobile ? null : getNotebookNavigatorPlugin(this.app);

    this.renderGroup(container, "日历外观", (card) => {
      const save = async (): Promise<void> => {
        if (navigator) await navigator.saveSettingsAndUpdate();
        else {
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
        }
      };
      new Setting(card)
        .setName("显示月份导航")
        .setDesc("在月历下方以两行显示全年月份，点击月份可切换月历。")
        .addToggle((toggle) =>
          toggle.setValue(navigator?.settings.calendarShowYearCalendar ?? diary.showYearCalendar).onChange(async (value) => {
            if (navigator) navigator.settings.calendarShowYearCalendar = value;
            else diary.showYearCalendar = value;
            await save();
          })
        );
      new Setting(card)
        .setName("显示周号")
        .setDesc("在月历左侧显示周号。")
        .addToggle((toggle) =>
          toggle.setValue(navigator?.settings.calendarShowWeekNumber ?? diary.showWeekNumber).onChange(async (value) => {
            if (navigator) navigator.settings.calendarShowWeekNumber = value;
            else diary.showWeekNumber = value;
            await save();
          })
        );
      new Setting(card)
        .setName("高亮今天")
        .setDesc("在日历中标记今天。")
        .addToggle((toggle) =>
          toggle.setValue(navigator?.settings.calendarHighlightToday ?? diary.highlightToday).onChange(async (value) => {
            if (navigator) navigator.settings.calendarHighlightToday = value;
            else diary.highlightToday = value;
            await save();
          })
        );
      new Setting(card)
        .setName("阴影显示周末")
        .setDesc("用不同背景色显示周六和周日。")
        .addToggle((toggle) =>
          toggle.setValue(navigator ? navigator.settings.calendarWeekendDays !== "none" : diary.showWeekends).onChange(async (value) => {
            if (navigator) navigator.settings.calendarWeekendDays = value ? "sat-sun" : "none";
            else diary.showWeekends = value;
            await save();
          })
        );
    });

    this.renderGroup(container, "文件保存", (card) => {
      this.renderLockedTextSetting(card, {
        name: "日记文件夹",
        desc: "日记文件保存的根目录。",
        value: diary.folder,
        placeholder: "Daily Notes",
        onSave: async (value) => {
          diary.folder = value;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
        },
      });
      this.renderLockedTextSetting(card, {
        name: "日记路径命名规则",
        desc: "支持 YYYY、MM、M、DD、D、WEEKDAY。",
        value: diary.pathPattern,
        placeholder: "YYYY/MM/DD WEEKDAY.md",
        onSave: async (value) => {
          diary.pathPattern = value;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
        },
      });
      this.renderLockedTextSetting(card, {
        name: "日记模板",
        desc: "新建日记时使用的模板。",
        value: diary.templatePath,
        placeholder: "Templates/Daily Note.md",
        onSave: async (value) => {
          diary.templatePath = value;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
        },
      });
    });

  }

  private renderReformatSettings(container: HTMLElement): void {
    this.renderPageHeader(container, REFORMAT_NAME);
    const reformat = this.plugin.settings.diary.reformat;
    const enabled = this.plugin.settings.enhancements.currentNoteLinkConverter.enabled;

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用本插件")
        .setDesc("启用后在正文标题栏显示快速排版按钮，并开放下方排版设置。")
        .addToggle((toggle) =>
          toggle.setValue(enabled).onChange(async (value) => {
            this.plugin.settings.enhancements.currentNoteLinkConverter.enabled = value;
            await this.plugin.saveSettings();
            this.plugin.refreshReformatActions();
            this.renderSettings();
          })
        );
    });

    const dependent = container.createDiv({ cls: "simple-reformat-dependent" });
    dependent.toggleClass("is-disabled", !enabled);
    dependent.toggleAttribute("inert", !enabled);

    this.renderPasteLinkSettings(dependent);

    this.renderIconGroup(dependent, REFORMAT_ICON, "重排版设置", (card) => {
      new Setting(card)
        .setName("在快捷菜单中显示“重排版当前笔记”按钮")
        .setDesc("启用后，在正文标题栏“快速排版”按钮的子菜单内出现该选项。")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enhancements.currentNoteLinkConverter.showReformatCurrentNoteMenuItem)
            .onChange(async (value) => {
              this.plugin.settings.enhancements.currentNoteLinkConverter.showReformatCurrentNoteMenuItem = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(card)
        .setClass("simple-reformat-url-setting")
        .setName("重排版时链接格式化")
        .setDesc("执行重排版时，将文本中的 URL 处理为超链接；手动操作和粘贴自动触发的重排版都遵循此项。")
        .addToggle((toggle) =>
          toggle
            .setValue(reformat.runLinkConversion)
            .onChange(async (value) => {
              reformat.runLinkConversion = value;
              await this.plugin.saveSettings();
            })
        );
      new Setting(card)
        .setName("粘贴文本时自动触发重排版")
        .setDesc("粘贴文本时自动运行重排版，按已启用的文本排版和链接格式化选项处理后再写入笔记。")
        .addToggle((toggle) =>
          toggle
            .setValue(reformat.autoReformatAfterPaste)
            .onChange(async (value) => {
              reformat.autoReformatAfterPaste = value;
              await this.plugin.saveSettings();
            })
        );

      this.renderNavigationItem(
        card,
        "文本排版规则",
        "清理多余空格、修复异常换行并整理段落结构；点击可查看和编辑全部规则。",
        () => this.openPage({ type: "reformat-rules" }),
        "list-filter"
      );

      const builtInRules = reformat.formatRules.filter((item) => BUILT_IN_TEXT_REFORMAT_RULE_IDS.has(item.id));
      const customRules = reformat.formatRules.filter((item) => !BUILT_IN_TEXT_REFORMAT_RULE_IDS.has(item.id));
      const builtInQuickRules = card.createDiv({
        cls: "simple-reformat-quick-rules simple-reformat-built-in-rules",
      });
      builtInQuickRules.createDiv({
        cls: "simple-reformat-quick-rules-label",
        text: "基础排版规则",
      });
      for (const rule of builtInRules) {
        this.renderReformatQuickRuleCheckbox(builtInQuickRules, rule.name, rule.enabled, async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
        });
      }
      builtInQuickRules.createDiv({
        cls: "simple-reformat-quick-rules-label",
        text: "自定义排版规则",
      });
      for (const rule of customRules) {
        this.renderReformatQuickRuleCheckbox(builtInQuickRules, rule.name, rule.enabled, async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
        });
      }
      if (customRules.length === 0) {
        builtInQuickRules.createDiv({
          cls: "simple-reformat-quick-rule simple-reformat-empty-rule setting-item-description",
          text: "（空）",
        });
      }
    });
  }

  private renderReformatRules(container: HTMLElement): void {
    this.renderPageHeader(container, "文本排版规则", () => this.openPage({ type: "reformat" }));
    const reformat = this.plugin.settings.diary.reformat;
    const builtInRules = reformat.formatRules.filter((rule) => BUILT_IN_TEXT_REFORMAT_RULE_IDS.has(rule.id));
    const customRules = reformat.formatRules.filter((rule) => !BUILT_IN_TEXT_REFORMAT_RULE_IDS.has(rule.id));

    this.renderReformatRuleSection(
      container,
      "builtin",
      "内置排版规则",
      `${builtInRules.length} 条基础正则，可调整内容与启用状态。`,
      (content) => {
        this.renderReformatRuleTableHead(content);
        for (const rule of builtInRules) {
          this.renderTextReformatRule(content, rule, reformat.formatRules.indexOf(rule), false);
        }
      }
    );

    this.renderReformatRuleSection(
      container,
      "custom",
      "自定义排版规则",
      `${customRules.length} 条自定义正则，可新增、编辑和删除。`,
      (content) => {
        this.renderReformatRuleTableHead(content);
        for (const rule of customRules) {
          this.renderTextReformatRule(content, rule, reformat.formatRules.indexOf(rule), true);
        }
      },
      (summary) => {
        const add = summary.createEl("button", {
          cls: "mod-cta simple-add-button simple-reformat-rule-summary-add",
        });
        add.setText("添加规则");
        add.addEventListener("click", runAsync(async (event) => {
          event.preventDefault();
          event.stopPropagation();
          reformat.formatRules.push(makeTextReformatRule());
          await this.plugin.saveSettings();
          this.expandedReformatRuleSections.add("custom");
          this.renderSettings();
        }));
      }
    );
  }

  private renderReformatRuleSection(
    container: HTMLElement,
    key: "builtin" | "custom",
    title: string,
    description: string,
    render: (content: HTMLElement) => void,
    renderSummaryAction?: (summary: HTMLElement) => void
  ): void {
    const section = container.createEl("details", { cls: "simple-callout-section simple-reformat-rule-section" });
    section.open = this.expandedReformatRuleSections.has(key);
    const summary = section.createEl("summary", { cls: "simple-callout-section-summary" });
    const chevron = summary.createSpan({ cls: "simple-callout-section-chevron" });
    setIcon(chevron, section.open ? "chevron-down" : "chevron-right");
    const copy = summary.createDiv({ cls: "simple-callout-section-copy" });
    copy.createDiv({ cls: "simple-card-title", text: title });
    copy.createDiv({ cls: "setting-item-description", text: description });
    renderSummaryAction?.(summary);
    section.addEventListener("toggle", () => {
      if (section.open) this.expandedReformatRuleSections.add(key);
      else this.expandedReformatRuleSections.delete(key);
      setIcon(chevron, section.open ? "chevron-down" : "chevron-right");
    });
    const content = section.createDiv({ cls: "simple-callout-section-content" });
    render(content);
  }

  private renderReformatRuleTableHead(card: HTMLElement): void {
    const head = card.createDiv({ cls: "simple-reformat-rule-row simple-rule-head" });
    head.createDiv({ text: "启用" });
    head.createDiv({ text: "名称" });
    head.createDiv({ text: "匹配正则" });
    head.createDiv({ text: "标记" });
    head.createDiv({ text: "替换为" });
    head.createDiv();
  }

  private renderTextReformatRule(
    card: HTMLElement,
    rule: TextReformatRule,
    index: number,
    deletable = true
  ): void {
    const row = card.createDiv({ cls: "simple-reformat-rule-row" });
    const toggleWrap = row.createDiv({ cls: "simple-rule-toggle" });
    new Setting(toggleWrap).addToggle((toggle) =>
      toggle.setValue(rule.enabled).onChange(async (value) => {
        rule.enabled = value;
        await this.plugin.saveSettings();
      })
    );
    this.textInput(row, rule.name, "例如：中文句中硬换行接回", async (value) => {
      rule.name = value;
      await this.plugin.saveSettings();
    });
    this.textInput(row, rule.pattern, "([^。！？])\\n(?=\\S)", async (value) => {
      rule.pattern = value;
      await this.plugin.saveSettings();
    });
    this.textInput(row, rule.flags || "g", "gm", async (value) => {
      rule.flags = value || "g";
      await this.plugin.saveSettings();
    });
    this.textInput(row, rule.replaceWith, "$1", async (value) => {
      rule.replaceWith = value;
      await this.plugin.saveSettings();
    });
    if (deletable) {
      const del = row.createEl("button", { cls: "simple-rule-del", attr: { title: "删除规则", "aria-label": "删除规则" } });
      setIcon(del, "trash-2");
      del.addEventListener("click", runAsync(async () => {
        this.plugin.settings.diary.reformat.formatRules.splice(index, 1);
        await this.plugin.saveSettings();
        this.renderSettings();
      }));
    } else {
      row.createDiv();
    }
  }

  private renderQuickFormatSettings(container: HTMLElement): void {
    const quickFormat = this.plugin.settings.enhancements.quickFormat;
    this.renderPageHeader(container, QUICK_FORMAT_NAME);

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用本插件")
        .setDesc("启用快速排版功能，并开放下方菜单与样式设置；快捷入口按对应平台的显示开关控制。")
        .addToggle((toggle) =>
          toggle
            .setValue(quickFormat.enabled)
            .onChange(async (value) => {
              quickFormat.enabled = value;
              await this.plugin.saveSettings();
              this.plugin.refreshQuickFormatActions();
              this.renderSettings();
            })
        );

      new Setting(card)
        .setName("在电脑端界面显示本插件的快捷入口")
        .setDesc("在电脑端笔记标题栏显示快速排版入口。")
        .addToggle((toggle) => toggle
          .setValue(quickFormat.showDesktopEntry)
          .onChange(async (value) => {
            quickFormat.showDesktopEntry = value;
            await this.plugin.saveSettings();
            this.plugin.refreshQuickFormatActions();
          }));
      new Setting(card)
        .setName("在手机端界面显示本插件的快捷入口")
        .setDesc("在手机端笔记标题栏显示快速排版入口。")
        .addToggle((toggle) => toggle
          .setValue(quickFormat.showMobileEntry)
          .onChange(async (value) => {
            quickFormat.showMobileEntry = value;
            await this.plugin.saveSettings();
            this.plugin.refreshQuickFormatActions();
          }));
    });

    const dependent = container.createDiv({ cls: "simple-quick-format-dependent" });
    dependent.toggleClass("is-disabled", !quickFormat.enabled);
    dependent.toggleAttribute("inert", !quickFormat.enabled);
    this.renderSectionHeading(dependent, "自定义快捷菜单");
    this.renderSettingCard(dependent, (card) => {
      card.createDiv({
        cls: "setting-item-description",
        text: "管理标题与 Callout 在快捷菜单中的显示方式和样式。引用始终显示。",
      });
      const enabledHeadingCount = (Object.keys(QUICK_FORMAT_HEADING_LABELS) as QuickFormatHeadingLevel[])
        .filter((level) => quickFormat.visibleModes.includes(level)).length;
      this.renderNavigationItem(
        card,
        "标题",
        "功能开关、颜色与字号设定。",
        () => this.openPage({ type: "quick-format-headings" }),
        "heading",
        enabledHeadingCount ? `已启用 ${enabledHeadingCount}/6` : "未启用"
      );
      this.renderNavigationItem(
        card,
        "Callout 块",
        "管理 Callout 类型、显示开关和颜色。",
        () => this.openPage({ type: "quick-format-callouts" }),
        "message-square"
      );
    });
  }

  private renderQuickFormatHeadingSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "标题", () => this.openPage({ type: "quick-format" }));
    const bodyFontSize = readRenderedFontSize();
    this.renderSettingCard(container, (card) => {
      const header = card.createDiv({ cls: "simple-card-header" });
      const copy = header.createDiv();
      copy.createDiv({ cls: "simple-card-title", text: "标题功能与样式" });
      copy.createDiv({
        cls: "setting-item-description",
        text: "开关控制是否显示在快捷菜单；颜色和字号留空时跟随当前主题。",
      });
      header.createDiv({ cls: "simple-font-reference", text: `当前正文 ${bodyFontSize}` });
      for (const level of Object.keys(QUICK_FORMAT_HEADING_LABELS) as QuickFormatHeadingLevel[]) {
        this.renderQuickFormatHeadingSetting(card, level, bodyFontSize);
      }
    });
  }

  private renderQuickFormatHeadingSetting(card: HTMLElement, level: QuickFormatHeadingLevel, bodyFontSize: string): void {
    const quickFormat = this.plugin.settings.enhancements.quickFormat;
    const color = quickFormat.headingColors[level];
    const size = quickFormat.headingSizes[level];
    const fallback = readThemeColor(QUICK_FORMAT_HEADING_LABELS[level]);
    const currentSize = readRenderedFontSize(level);
    const relation = compareFontSizes(currentSize, bodyFontSize);
    new Setting(card)
      .setName(QUICK_FORMAT_HEADING_LABELS[level])
      .setDesc(`当前字号：${currentSize}${relation}；主题颜色：${fallback}；自定义颜色：${color || "未设置"}`)
      .addToggle((toggle) =>
        toggle
          .setValue(quickFormat.visibleModes.includes(level))
          .onChange(async (visible) => {
            this.setQuickFormatModeVisible(level, visible);
            await this.plugin.saveSettings();
          })
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "10";
        text.inputEl.max = "96";
        text.inputEl.step = "0.5";
        text.inputEl.addClass("simple-heading-size-input");
        text
          .setPlaceholder(`当前 ${stripPx(currentSize)}px`)
          .setValue(size)
          .onChange(async (value) => {
            quickFormat.headingSizes[level] = value.trim();
            await this.plugin.saveSettings();
            applyQuickFormatStyles(this.plugin);
          });
      })
      .addColorPicker((picker) =>
        picker
          .setValue(color || fallback)
          .onChange(async (value) => {
            quickFormat.headingColors[level] = value;
            await this.plugin.saveSettings();
            applyQuickFormatStyles(this.plugin);
            this.renderSettings();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("跟随主题")
          .onClick(async () => {
            quickFormat.headingColors[level] = "";
            quickFormat.headingSizes[level] = "";
            await this.plugin.saveSettings();
            applyQuickFormatStyles(this.plugin);
            this.renderSettings();
          })
      );
  }

  private renderQuickFormatCalloutSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "Callout 块", () => this.openPage({ type: "quick-format" }));
    const quickFormat = this.plugin.settings.enhancements.quickFormat;
    this.renderQuickFormatCalloutSection(
      container,
      "native",
      "编辑 Obsidian 的 Callout 块颜色",
      "调整内置 Callout 类型的显示开关与颜色。",
      (card) => {
      for (const definition of QUICK_FORMAT_CALLOUTS) {
        const mode: QuickFormatMode = `callout-${definition.type}`;
        this.renderQuickFormatColorSetting(
          card,
          definition.label,
          mode,
          readCalloutColorHex(definition.type, container),
          quickFormat.calloutColors[definition.type],
          (value) => quickFormat.calloutColors[definition.type] = value,
          definition.icon,
          definition.aliases
        );
      }
      }
    );

    this.renderQuickFormatCalloutSection(
      container,
      "custom",
      "自定义 Callout 块颜色",
      `${quickFormat.customCallouts.length} 个自定义类型，可编辑名称、颜色与显示状态。`,
      (card) => {
      for (const callout of quickFormat.customCallouts) {
        this.renderCustomCalloutSetting(card, callout);
      }
      new Setting(card)
        .setName("新增自定义 Callout")
        .setDesc("字段名就是 [!字段名] 中的字段，例如 code、quarter。")
        .addButton((button) =>
          button
            .setButtonText("＋")
            .onClick(async () => {
              const id = nextId();
              const mode: QuickFormatMode = `custom-callout:${id}`;
              quickFormat.customCallouts.push({ id, type: "custom", label: "Custom", color: "" });
              quickFormat.visibleModes = [...new Set([...quickFormat.visibleModes, mode])];
              await this.plugin.saveSettings();
              this.renderSettings();
            })
        );
      }
    );
  }

  private renderQuickFormatCalloutSection(
    container: HTMLElement,
    key: "native" | "custom",
    title: string,
    description: string,
    render: (content: HTMLElement) => void
  ): void {
    const section = container.createEl("details", { cls: "simple-callout-section" });
    section.open = this.expandedQuickFormatCalloutSections.has(key);
    const summary = section.createEl("summary", { cls: "simple-callout-section-summary" });
    const chevron = summary.createSpan({ cls: "simple-callout-section-chevron" });
    setIcon(chevron, section.open ? "chevron-down" : "chevron-right");
    const copy = summary.createDiv({ cls: "simple-callout-section-copy" });
    copy.createDiv({ cls: "simple-card-title", text: title });
    copy.createDiv({ cls: "setting-item-description", text: description });
    section.addEventListener("toggle", () => {
      if (section.open) this.expandedQuickFormatCalloutSections.add(key);
      else this.expandedQuickFormatCalloutSections.delete(key);
      setIcon(chevron, section.open ? "chevron-down" : "chevron-right");
    });
    const content = section.createDiv({ cls: "simple-callout-section-content" });
    render(content);
  }

  private renderQuickFormatColorSetting(
    card: HTMLElement,
    name: string,
    mode: QuickFormatMode,
    fallback: string,
    value: string,
    setValue: (value: string) => void,
    icon?: string,
    aliases: string[] = []
  ): void {
    const setting = new Setting(card)
      .setName(name)
      .setDesc(`${aliases.length ? `别名：${aliases.join("、")}；` : ""}当前显示颜色：${fallback}；自定义颜色：${value || "未设置"}`)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enhancements.quickFormat.visibleModes.includes(mode))
          .onChange(async (visible) => {
            this.setQuickFormatModeVisible(mode, visible);
            await this.plugin.saveSettings();
          })
      )
      .addColorPicker((picker) => {
        picker
          .setValue(value || fallback)
          .onChange(async (next) => {
            setValue(next);
            await this.plugin.saveSettings();
            applyQuickFormatStyles(this.plugin);
            this.renderSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("跟随主题")
          .onClick(async () => {
            setValue("");
            await this.plugin.saveSettings();
            applyQuickFormatStyles(this.plugin);
            this.renderSettings();
          });
      });
    this.decorateCalloutSetting(setting, icon, value || fallback);
  }

  private renderCustomCalloutSetting(card: HTMLElement, callout: QuickFormatCustomCallout): void {
    const mode: QuickFormatMode = `custom-callout:${callout.id}`;
    const fallback = readCalloutColorHex(callout.type || "note", card);
    const isEditing = this.editingCustomCalloutIds.has(callout.id);
    const setting = new Setting(card)
      .setClass("simple-custom-callout-setting")
      .setDesc(`语法：[!${callout.type || "custom"}]；兜底颜色：${fallback}；自定义颜色：${callout.color || "未设置"}`)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enhancements.quickFormat.visibleModes.includes(mode))
          .onChange(async (visible) => {
            this.setQuickFormatModeVisible(mode, visible);
            await this.plugin.saveSettings();
          })
      )
      .addColorPicker((picker) =>
        picker
          .setValue(callout.color || fallback)
          .onChange(async (value) => {
            callout.color = value;
            await this.plugin.saveSettings();
            applyQuickFormatStyles(this.plugin);
            this.renderSettings();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("跟随主题")
          .onClick(async () => {
            callout.color = "";
            await this.plugin.saveSettings();
            applyQuickFormatStyles(this.plugin);
            this.renderSettings();
          })
      );

    setting.settingEl.classList.toggle("is-editing", isEditing);
    setting.nameEl.empty();
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
      setting.nameEl.createSpan({
        cls: "simple-custom-callout-name",
        text: callout.label || callout.type || "未命名",
      });
    }

    const finishEditing = async (): Promise<void> => {
      if (!nameInput) return;
      const value = nameInput.value.trim().toLowerCase();
      if (!value) {
        nameInput.value = callout.type;
        new Notice("Callout 名称不能为空");
        return;
      }
      callout.type = value;
      callout.label = value;
      this.editingCustomCalloutIds.delete(callout.id);
      await this.plugin.saveSettings();
      applyQuickFormatStyles(this.plugin);
      this.renderSettings();
    };

    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finishEditing();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.editingCustomCalloutIds.delete(callout.id);
        this.renderSettings();
      }
    });

    const editButton = setting.nameEl.createEl("button", {
      cls: "clickable-icon simple-custom-callout-edit",
      attr: {
        type: "button",
        title: isEditing ? "完成编辑" : "编辑名称",
        "aria-label": isEditing ? "完成编辑" : "编辑名称",
      },
    });
    setIcon(editButton, isEditing ? "check" : "pencil");
    editButton.addEventListener("click", () => {
      if (isEditing) {
        void finishEditing();
        return;
      }
      this.editingCustomCalloutIds.add(callout.id);
      this.renderSettings();
    });

    const deleteButton = setting.nameEl.createEl("button", {
      cls: "clickable-icon simple-danger-icon-button simple-custom-callout-delete",
      attr: { type: "button", title: "删除自定义 Callout", "aria-label": "删除自定义 Callout" },
    });
    setIcon(deleteButton, "x");
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
          this.renderSettings();
        }
      ).open();
    });
  }

  private decorateCalloutSetting(setting: Setting, icon: string | undefined, color: string): void {
    if (!icon) return;
    const iconEl = setting.nameEl.createSpan({ cls: "simple-callout-setting-icon" });
    iconEl.style.color = color;
    setIcon(iconEl, icon);
    setting.nameEl.prepend(iconEl);
  }

  private setQuickFormatModeVisible(mode: QuickFormatMode, visible: boolean): void {
    const quickFormat = this.plugin.settings.enhancements.quickFormat;
    quickFormat.visibleModes = visible
      ? [...new Set([...quickFormat.visibleModes, mode])]
      : quickFormat.visibleModes.filter((item) => item !== mode);
  }

  private renderEventReminderSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "自动提醒管理", () => this.openPage({ type: "calendar-diary" }));
    const diary = this.plugin.settings.diary;
    this.renderRecurringRules(container);
    this.renderGroup(container, "提醒方式", (card) => {
      new Setting(card)
        .setName("提醒模式")
        .setDesc("将提醒写入自定义级别的标题下，或写入 Callout 块。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("heading", "插入标题")
            .addOption("callout", "Callout")
            .setValue(diary.reminderTargetMode || "callout")
            .onChange(async (value) => {
              diary.reminderTargetMode = value as typeof diary.reminderTargetMode;
              await this.plugin.saveSettings();
              this.renderSettings();
            })
        );
      if ((diary.reminderTargetMode || "callout") === "heading") {
        new Setting(card)
          .setName("标题名称与级别")
          .setDesc("输入 Markdown 标题，如 ### 小贴士；# 的数量可设为 1–6 级。提醒默认放在其他待办前。")
          .addText((text) =>
            text
              .setPlaceholder("#### 小贴士")
              .setValue(diary.tipsHeading)
              .onChange(async (value) => {
                diary.tipsHeading = value || "#### 小贴士";
                diary.dateManagement.reminderWriting.heading = diary.dateManagement.reminderWriting.heading || diary.tipsHeading;
                await this.plugin.saveSettings();
              })
          );
      } else {
        new Setting(card)
          .setName("Callout 名称")
          .setDesc("例如小贴士会写入 > [!小贴士] 块。")
          .addText((text) =>
            text
              .setPlaceholder("小贴士")
              .setValue(diary.tipsCallout || "小贴士")
              .onChange(async (value) => {
                diary.tipsCallout = value || "小贴士";
                await this.plugin.saveSettings();
              })
          );
      }
    });
  }

  private renderDateManagementSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "管理纪念日", () => this.openPage({ type: "calendar-diary" }));
    const diary = this.plugin.settings.diary;
    const config = diary.dateManagement;

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("日历中显示纪念日")
        .setDesc("关闭后仍保留纪念日数据，只隐藏右侧日历中的纪念日；日记提醒由下方开关单独控制。")
        .addToggle((toggle) =>
          toggle.setValue(config.anniversaries.enabled && config.anniversaries.showInCalendar).onChange(async (value) => {
            config.anniversaries.enabled = value;
            config.anniversaries.showInCalendar = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDiaryViews();
            this.renderSettings();
          })
        );
      new Setting(card)
        .setName("在日记中自动提醒纪念日")
        .setDesc("创建日记时，按下方每条纪念日的“提醒”设置写入当日或提前提醒；与日历显示独立。")
        .addToggle((toggle) =>
          toggle.setValue(config.reminderWriting.enabled).onChange(async (value) => {
            config.reminderWriting.enabled = value;
            await this.plugin.saveSettings();
          })
        );
    });

    this.renderAnniversaryList(container, diary.anniversaries);
  }

  private renderHolidayManagementSettings(container: HTMLElement): void {
    this.renderPageHeader(container, "假期安排管理", () => this.openPage({ type: "calendar-diary" }));
    const diary = this.plugin.settings.diary;
    const config = diary.dateManagement;

    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("国家法定假期安排")
        .setDesc("开启后在日历显示国家法定放假和调休安排。")
        .addToggle((toggle) =>
          toggle.setValue(config.nationalHolidays.enabled).onChange(async (value) => {
            config.nationalHolidays.enabled = value;
            config.nationalHolidays.showInCalendar = value;
            if (!config.nationalHolidays.enabled && !config.companyHolidays.enabled) {
              config.holidaySetupReminder.enabled = false;
            }
            await this.plugin.saveSettings();
            this.plugin.refreshDiaryViews();
            this.renderSettings();
          })
        );
      new Setting(card)
        .setName("公司假期安排")
        .setDesc("开启后在日历显示公司额外假、公司调休等安排，并参与假期设置提醒检查。")
        .addToggle((toggle) =>
          toggle.setValue(config.companyHolidays.enabled).onChange(async (value) => {
            config.companyHolidays.enabled = value;
            config.companyHolidays.showInCalendar = value;
            if (!config.nationalHolidays.enabled && !config.companyHolidays.enabled) {
              config.holidaySetupReminder.enabled = false;
            }
            await this.plugin.saveSettings();
            this.plugin.refreshDiaryViews();
            this.renderSettings();
          })
        );
      const hasHolidaySource = config.nationalHolidays.enabled || config.companyHolidays.enabled;
      new Setting(card)
        .setName("假期导入提醒")
        .setDesc("缺少当年安排时，在日记侧栏提示导入；每年 12 月起额外检查次年安排。国家法定假期安排和公司假期安排都关闭时，本项会自动关闭。")
        .addToggle((toggle) =>
          toggle.setValue(hasHolidaySource && config.holidaySetupReminder.enabled).onChange(async (value) => {
            config.holidaySetupReminder.enabled = value && (config.nationalHolidays.enabled || config.companyHolidays.enabled);
            config.holidaySetupReminder.month = 12;
            config.holidaySetupReminder.daysBefore = config.holidaySetupReminder.daysBefore || 7;
            await this.plugin.saveSettings();
            this.renderSettings();
          })
        );
      new Setting(card)
        .setName("写入日记小贴士")
        .setDesc("创建日记时，将缺失假期安排的导入提醒写入默认小贴士；提醒样式由“自动提醒管理”统一设置。")
        .addToggle((toggle) =>
          toggle
            .setValue(config.holidaySetupReminder.writeToTips)
            .onChange(async (value) => {
              config.holidaySetupReminder.writeToTips = value;
              await this.plugin.saveSettings();
            })
        );
      new Setting(card)
        .setName("提前工作日")
        .setDesc("默认提前 7 个工作日写入待办。")
        .addText((text) =>
          text
            .setPlaceholder("7")
            .setValue(String(config.holidaySetupReminder.daysBefore || 7))
            .onChange(async (value) => {
              const parsed = Number(value.trim());
              config.holidaySetupReminder.daysBefore = Number.isInteger(parsed) && parsed > 0 ? Math.min(365, parsed) : 7;
              await this.plugin.saveSettings();
            })
        );
    });

    this.renderHolidayImportGuide(container);
    this.renderHolidayScheduleList(
      container,
      diary.holidaySchedules,
      "national",
      "国家法定假期安排",
      "还没有导入国家法定假期安排。可在本页导入年度放假和调休安排。"
    );
    this.renderHolidayScheduleList(
      container,
      diary.holidaySchedules,
      "company",
      "公司假期安排",
      "还没有导入公司假期安排。可在本页导入或维护公司特殊假期。"
    );
  }

  private renderAnniversaryList(container: HTMLElement, anniversaries: Anniversary[]): void {
    const heading = container.createDiv({ cls: "simple-heading-row" });
    this.renderSectionHeading(heading, "纪念日");

    if (!anniversaries.length) {
      const card = container.createDiv({ cls: "simple-card simple-date-list-card" });
      card.createDiv({ cls: "simple-empty-text", text: "还没有纪念日。" });
      return;
    }
    const visibleAnniversaries = sortAnniversariesForDisplay(
      this.anniversaryTagFilter === "全部"
        ? anniversaries
        : anniversaries.filter((anniversary) => anniversary.tags?.includes(this.anniversaryTagFilter)),
      this.anniversaryTagFilter
    );

    const card = container.createDiv({ cls: "simple-card simple-date-list-card" });
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
    const tableHead = card.createDiv({ cls: "simple-anniversary-table-head" });
    tableHead.createDiv({ text: "节日名称" });
    tableHead.createDiv({ text: "日期" });
    const calendarHead = tableHead.createDiv({ cls: "simple-anniversary-head-control" });
    const calendarBatchButton = calendarHead.createEl("button", {
      cls: allCalendarVisible ? "simple-state-button is-active" : "simple-state-button",
      attr: { title: "批量切换日历显示", "aria-label": "批量切换日历显示" },
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
      attr: { title: "批量切换提醒", "aria-label": "批量切换提醒" },
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
      const row = card.createDiv({ cls: "simple-date-row" });
      const main = row.createDiv({ cls: "simple-date-main" });
      const title = main.createDiv({ cls: "simple-date-title simple-anniversary-inline-title" });
      title.createSpan({ cls: "simple-anniversary-name", text: anniversary.name || "未命名纪念日" });
      const dateCell = row.createDiv({ cls: "simple-anniversary-date-cell" });
      dateCell.createSpan({ text: anniversaryDateSummary(anniversary) });
      const actions = row.createDiv({ cls: "simple-anniversary-actions" });
      const isCalendarVisible = anniversary.enabled && anniversary.showInCalendar !== false;
      const calendarButton = actions.createEl("button", {
        cls: isCalendarVisible ? "simple-state-button is-active" : "simple-state-button",
        attr: { title: isCalendarVisible ? "显示在日历" : "不显示在日历", "aria-label": isCalendarVisible ? "显示在日历" : "不显示在日历" },
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
        attr: { title: "提醒详情", "aria-label": "提醒详情" },
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
          attr: { title: "编辑纪念日", "aria-label": "编辑纪念日" },
        });
        setIcon(editButton, "pencil");
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
    const addButton = card.createEl("button", {
      cls: "simple-anniversary-add-row",
      attr: { title: "新增自定义纪念日", "aria-label": "新增自定义纪念日" },
    });
    setIcon(addButton, "plus");
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
    this.renderSectionHeading(heading, title);
    const headerActions = heading.createDiv({ cls: "simple-json-actions" });
    const importButton = headerActions.createEl("button", { cls: "mod-cta simple-soft-button" });
    importButton.setText("导入");
    importButton.addEventListener("click", () => {
      new HolidayScheduleImportModal(this.app, title, source, async (schedule) => {
        upsertHolidaySchedule(this.plugin.settings.diary.holidaySchedules, schedule);
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
        new Notice(summarizeHolidaySchedule(schedule));
        this.renderSettings();
      }).open();
    });

    const card = container.createDiv({ cls: "simple-card simple-holiday-schedule-list" });
    const filteredSchedules = schedules.filter((schedule) => schedule.source === source);
    if (!filteredSchedules.length) {
      card.createDiv({ cls: "simple-empty-text", text: emptyText });
      return;
    }
    for (const schedule of filteredSchedules) {
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
    const copy = actions.createEl("button", { cls: "simple-soft-button" });
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
        toggle.setValue(schedule.enabled).onChange(async (value) => {
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
    const expand = actions.createEl("button", {
      attr: { title: expanded ? "收起" : "展开", "aria-label": expanded ? "收起" : "展开" },
    });
    setIcon(expand, expanded ? "chevron-up" : "chevron-down");
    expand.addEventListener("click", () => {
      if (expanded) this.expandedHolidaySchedules.delete(schedule.id);
      else this.expandedHolidaySchedules.add(schedule.id);
      this.renderSettings();
    });
    const del = actions.createEl("button", {
      cls: "simple-danger-button",
      attr: { title: "删除", "aria-label": "删除" },
    });
    setIcon(del, "trash-2");
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
          attr: { title: "与国家法定安排不同" },
        });
      }
      if (item) {
        cell.createDiv({ cls: "simple-holiday-day-label", text: compactHolidayStatusLabel(item.status) });
        if (item.label) cell.createDiv({ cls: "simple-holiday-day-note", text: item.label });
      }
    }
  }

  private renderRecurringRules(container: HTMLElement): void {
    const heading = container.createDiv({ cls: "simple-heading-row" });
    this.renderSectionHeading(heading, "提醒管理");
    const addButton = heading.createEl("button", { cls: "mod-cta simple-soft-button" });
    addButton.setText("新增");
    addButton.addEventListener("click", () => {
      new RecurringRuleModal(this.app, "提醒编辑", makeRecurringRule(), async (rule) => {
        upsertById(this.plugin.settings.diary.recurringRules, rule);
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
        this.renderSettings();
      }).open();
    });

    const card = container.createDiv({ cls: "simple-card simple-recurring-card" });
    const rules = this.plugin.settings.diary.recurringRules;
    if (rules.length === 0) {
      card.createDiv({
        cls: "simple-empty-text simple-recurring-empty",
        text: "还没有提醒。新增后，新建日记或点击右侧周期按钮时会自动补充到小贴士。",
      });
      return;
    }

    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      const row = card.createDiv({ cls: "simple-recurring-row" });
      const enabledCell = row.createDiv({ cls: "simple-recurring-enable" });
      new Setting(enabledCell).addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
          this.renderSettings();
        })
      );
      const main = row.createDiv({ cls: "simple-recurring-main" });
      const title = main.createDiv({ cls: "simple-recurring-title" });
      title.createSpan({ text: rule.text || "未命名提醒" });
      main.createDiv({ cls: "setting-item-description", text: recurringRuleSummary(rule) });

      const actions = row.createDiv({ cls: "simple-json-actions" });
      const edit = actions.createEl("button", { attr: { title: "编辑", "aria-label": "编辑" } });
      setIcon(edit, "pencil");
      edit.addEventListener("click", () => {
        new RecurringRuleModal(this.app, "提醒编辑", rule, async (updatedRule) => {
          rules[index] = updatedRule;
          await this.plugin.saveSettings();
          this.plugin.refreshDiaryViews();
          this.renderSettings();
        }).open();
      });
      const del = actions.createEl("button", {
        cls: "simple-danger-button",
        attr: { title: "删除", "aria-label": "删除" },
      });
      setIcon(del, "trash-2");
      del.addEventListener("click", runAsync(async () => {
        rules.splice(index, 1);
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
        this.renderSettings();
      }));
    }
  }

  private renderMoreButton(
    parent: HTMLElement,
    items: Array<{ title: string; icon: string; onClick: () => void | Promise<void> }>
  ): void {
    const button = parent.createEl("button", {
      cls: "simple-more-button",
      attr: { title: "更多操作", "aria-label": "更多操作" },
    });
    setIcon(button, "more-horizontal");
    button.addEventListener("click", (event) => {
      const menu = new Menu();
      for (const menuItem of items) {
        menu.addItem((item) => {
          item
            .setTitle(menuItem.title)
            .setIcon(menuItem.icon)
            .onClick(() => {
              void menuItem.onClick();
            });
        });
      }
      menu.showAtMouseEvent(event);
    });
  }

  private toggleDeleteSelection(mode: { selectedIds: Set<string> }, id: string): void {
    if (mode.selectedIds.has(id)) {
      mode.selectedIds.delete(id);
    } else {
      mode.selectedIds.add(id);
    }
  }

  private renderDeleteBar(
    container: HTMLElement,
    selectedCount: number,
    onConfirm: () => Promise<void>
  ): void {
    const bar = container.createDiv({ cls: "simple-delete-bar" });
    bar.createDiv({
      cls: "simple-delete-count",
      text: selectedCount > 0 ? `已选择 ${selectedCount} 项` : "点击列表项选择要删除的内容",
    });
    const actions = bar.createDiv({ cls: "simple-delete-actions" });
    const cancel = actions.createEl("button", { cls: "simple-soft-button" });
    cancel.setText("取消");
    cancel.addEventListener("click", () => {
      this.deleteMode = null;
      this.renderSettings();
    });
    const confirmDelete = actions.createEl("button", { cls: "mod-warning simple-soft-button" });
    confirmDelete.setText("删除选中");
    confirmDelete.addEventListener("click", () => {
      void onConfirm();
    });
  }

  private openJsonModal(
    title: string,
    initialValue: string,
    onSave: (value: unknown) => Promise<void>
  ): void {
    new JsonEditModal(this.app, title, initialValue, onSave).open();
  }

  private renderCalendarDiarySettings(container: HTMLElement): void {
    this.renderPageHeader(container, "日历与日记");

    const diary = this.plugin.settings.diary;
    this.renderSettingCard(container, (card) => {
      new Setting(card)
        .setName("启用本插件")
        .setDesc("启用后显示日记入口，并开放下方日记、提醒和日期管理模块。关闭后需重启生效。")
        .addToggle((toggle) =>
          toggle.setValue(diary.enabled).onChange(async (value) => {
            diary.enabled = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDiaryViews();
            this.renderSettings();
          })
        );
    });

    const dependent = container.createDiv({ cls: "simple-calendar-diary-dependent" });
    dependent.toggleClass("is-disabled", !diary.enabled);
    dependent.toggleAttribute("inert", !diary.enabled);

    this.renderGroup(dependent, "功能分类", (card) => {
      new Setting(card)
        .setName("自动追踪")
        .setDesc("新建笔记时，自动追踪近一日的未完成工作，并写入新笔记。")
        .addToggle((toggle) =>
          toggle.setValue(diary.carryUnfinishedTasks).onChange(async (value) => {
            diary.carryUnfinishedTasks = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDiaryViews();
          })
        );
      this.renderNavigationItem(
        card,
        "自动提醒管理",
        "创建时间，按设定规则自动在日记中提醒。",
        () => this.openPage({ type: "event-reminders" })
      );
    });

    this.renderGroup(dependent, "设置", (card) => {
      this.renderNavigationItem(
        card,
        "日记位置",
        "设置日记保存路径、模板和日历外观。",
        () => this.openPage({ type: "diary" })
      );
      this.renderNavigationItem(
        card,
        "管理纪念日",
        "管理纪念日、节日提醒和自定义特殊日期。",
        () => this.openPage({ type: "date-management" })
      );
      this.renderNavigationItem(
        card,
        "假期安排管理",
        "管理国家法定假期安排和公司假期安排，并在日历中显示放假与调休状态。",
        () => this.openPage({ type: "holiday-management" })
      );
    });
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
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createDiv({ cls: "setting-item-description", text: this.message });
    const actions = this.contentEl.createDiv({ cls: "simple-confirm-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirmButton = actions.createEl("button", { cls: "mod-warning", text: "确认删除" });
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
    private readonly onSave: (value: unknown) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-json-modal");
    contentEl.createEl("h2", { text: this.title });

    const toolbar = contentEl.createDiv({ cls: "simple-json-modal-toolbar" });
    const paste = toolbar.createEl("button");
    paste.setText("粘贴");
    paste.addEventListener("click", runAsync(async () => {
      this.textarea.value = await navigator.clipboard.readText();
    }));

    const copy = toolbar.createEl("button");
    copy.setText("复制");
    copy.addEventListener("click", runAsync(async () => {
      await navigator.clipboard.writeText(this.textarea.value);
      new Notice("JSON 已复制到剪贴板");
    }));

    this.textarea = contentEl.createEl("textarea", { cls: "simple-json-textarea" });
    this.textarea.value = this.initialValue;

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const cancel = footer.createEl("button");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = footer.createEl("button", { cls: "mod-cta" });
    save.setText("保存");
    save.addEventListener("click", runAsync(async () => {
      try {
        const parsed: unknown = JSON.parse(this.textarea.value);
        await this.onSave(parsed);
        this.close();
      } catch (error) {
        new Notice(`JSON 无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }));
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
    contentEl.createEl("h2", { text: `${this.title}导入` });
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

    this.textarea = contentEl.createEl("textarea", {
      cls: "simple-json-textarea",
      attr: { placeholder: "粘贴 AI 返回的 JSON" },
    });

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const cancel = footer.createEl("button");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = footer.createEl("button", { cls: "mod-cta" });
    save.setText("校验并导入");
    save.addEventListener("click", runAsync(async () => {
      try {
        const parsed: unknown = JSON.parse(this.textarea.value);
        const schedule = normalizeHolidayImport(parsed, this.source);
        await this.onImport(schedule);
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
    contentEl.createEl("h2", { text: this.draft.name || "提醒详情" });
    contentEl.createDiv({ cls: "setting-item-description", text: anniversarySummary(this.draft) });

    new Setting(contentEl)
      .setName("当日提醒")
      .setDesc("开启后，创建当天日记时写入这条纪念日提醒。")
      .addToggle((toggle) =>
        toggle.setValue(this.draft.sameDayReminderEnabled ?? this.draft.reminderEnabled).onChange((value) => {
          this.draft.sameDayReminderEnabled = value;
          this.syncReminderEnabled();
        })
      );

    new Setting(contentEl)
      .setName("提前提醒")
      .setDesc("开启后，按提前工作日写入预告；留空时使用 7 个工作日。")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.draft.advanceReminderEnabled)).onChange((value) => {
          this.draft.advanceReminderEnabled = value;
          if (value && !this.draft.reminderDaysBefore) this.draft.reminderDaysBefore = 7;
          this.syncReminderEnabled();
          this.renderAdvanceControls();
        })
      );

    this.advanceEl = contentEl.createDiv({ cls: "simple-anniversary-detail-controls" });
    this.renderAdvanceControls();

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const cancel = footer.createEl("button");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = footer.createEl("button", { cls: "mod-cta" });
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
    contentEl.createEl("h2", { text: isEditing ? "编辑自定义纪念日" : "新增自定义纪念日" });

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
      const del = footer.createEl("button", { cls: "mod-warning" });
      del.setText("删除");
      del.addEventListener("click", runAsync(async () => {
        if (!await confirmAction(this.app, "确定删除这个自定义纪念日吗？")) return;
        await this.onDelete?.();
        this.close();
      }));
    }

    const cancel = footer.createEl("button");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = footer.createEl("button", { cls: "mod-cta" });
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
    private readonly onSave: (rule: RecurringRule) => Promise<void>
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
    contentEl.createEl("h2", { text: this.title });

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
        toggle.setValue(Boolean(this.draft.advanceEnabled)).onChange((value) => {
          this.draft.advanceEnabled = value;
          if (value && !this.draft.advanceDays) this.draft.advanceDays = 3;
          this.renderAdvanceControls();
        })
      );
    this.advanceEl = contentEl.createDiv({ cls: "simple-recurring-advance" });
    this.renderAdvanceControls();

    const footer = contentEl.createDiv({ cls: "simple-json-modal-footer" });
    const cancel = footer.createEl("button");
    cancel.setText("取消");
    cancel.addEventListener("click", () => this.close());

    const save = footer.createEl("button", { cls: "mod-cta" });
    save.setText("保存");
    save.addEventListener("click", runAsync(async () => {
      if (!this.draft.text.trim()) {
        new Notice("请先填写周期计划内容");
        return;
      }
      await this.onSave(cleanRecurringRule(this.draft));
      this.close();
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
  const preferred = ["全部", "常用", "传统", "纪念", "自定义"];
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

class DatabasePickerModal extends Modal {
  constructor(
    app: App,
    private readonly bases: TFile[],
    private readonly onChoose: (base: TFile) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("选择参考数据库");
    for (const base of this.bases) {
      new Setting(this.contentEl)
        .setName(base.basename)
        .setDesc(base.path)
        .addButton((button) => button
          .setButtonText("使用")
          .setCta()
          .onClick(async () => {
            this.close();
            await this.onChoose(base);
          }));
    }
  }
}

function normalizeCategory(value: unknown): TemplateCategory {
  if (!isRecord(value)) throw new Error("分类 JSON 必须是对象");
  return {
    id: stringValue(value.id) || nextId(),
    name: stringValue(value.name),
    icon: stringValue(value.icon),
    outputFolder: stringValue(value.outputFolder),
    filenameField: stringValue(value.filenameField),
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

function makeBlankCategory(): TemplateCategory {
  return {
    id: nextId(),
    name: "",
    icon: "",
    outputFolder: "",
    filenameField: "",
    noteFormat: "",
    siteRules: [],
  };
}

function normalizeSiteRule(value: unknown): SiteRule {
  if (!isRecord(value)) throw new Error("网站规则 JSON 必须是对象");
  const handler = stringValue(value.handler) || inferSiteHandler(value);
  const siteRule: SiteRule = {
    id: stringValue(value.id) || nextId(),
    name: stringValue(value.name),
    shortName: stringValue(value.shortName),
    handler,
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

function makeBlankSiteRule(): SiteRule {
  return {
    id: nextId(),
    name: "",
    shortName: "",
    handler: "",
    urlPattern: "",
    search: {
      enabled: true,
      searchUrl: "",
      resultLimit: 10,
      resultList: "",
      resultTitle: "",
      resultUrl: "",
      resultAuthor: "",
      resultIntro: "",
      nextPage: undefined,
    },
    fields: [],
  };
}

function importJsonFile(): Promise<unknown> {
  return new Promise((resolve) => {
    const input = createEl("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", runAsync(async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const text = await file.text();
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        const looseRule = parseLooseHtmlPreviewRuleJson(text);
        if (looseRule) {
          resolve(looseRule);
          return;
        }
        new Notice(`JSON 导入失败：${error instanceof Error ? error.message : String(error)}`);
        resolve(null);
      }
    }));
    input.click();
  });
}

function downloadJsonFile(filename: string, value: unknown): void {
  const blob = new Blob([formatJson(value)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = createEl("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
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
    siteRule.handler ? "内置" : "",
  ].filter(Boolean);
  return parts.length ? `${label}（${parts.join("+")}）` : label;
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
  const variable = map[name] ?? `--callout-${name.toLowerCase()}`;
  const value = getComputedStyle(document.body).getPropertyValue(variable).trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^\d+,\s*\d+,\s*\d+$/.test(value)) return rgbTripletToHex(value);
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
  const probe = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered simple-font-size-probe" });
  const element = probe.createEl(level ?? "p", { text: level ? "标题" : "正文" });
  const size = getComputedStyle(element).fontSize;
  probe.remove();
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
