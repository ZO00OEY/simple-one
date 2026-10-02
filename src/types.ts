// ============================================================
// Types & defaults — no dependency on other src files
// ============================================================

export interface FilterRule {
  id: string;
  enabled: boolean;
  urlPattern: string;
  titleRegex: string;
  replaceWith: string;
}

export interface FieldExtraction {
  id: string;
  fieldName: string;
  page?: string;
  source: string;
  regex: string;
  replaceWith: string;
}

export interface UrlReplaceRule {
  type: "urlReplace";
  regex: string;
  replaceWith: string;
  page?: string;
}

export interface SelectorHrefRule {
  type: "selectorHref";
  page: string;
  selector: string;
}

export interface RegexFromHtmlRule {
  type: "regexFromHtml";
  page: string;
  regex: string;
  replaceWith: string;
}

export interface QueryParamIncrementRule {
  type: "queryParamIncrement";
  page?: string;
  param: string;
  start?: number;
}

export type PageUrlFromRule =
  | UrlReplaceRule
  | SelectorHrefRule
  | RegexFromHtmlRule
  | QueryParamIncrementRule;

export interface InputUrlConfig {
  baseUrl?: UrlReplaceRule;
}

export interface PageRequest {
  id: string;
  url?: string;
  urlFrom?: PageUrlFromRule;
}

export interface SearchRule {
  enabled?: boolean;
  type?: "html" | "fanqieApi" | "webviewHtml";
  searchUrl: string;
  pageStart?: number;
  resultLimit?: number;
  resultList: string;
  resultTitle: string;
  resultUrl: string;
  resultAuthor?: string;
  resultIntro?: string;
  nextPage?: PageUrlFromRule;
}

export interface SiteRule {
  id: string;
  name?: string;
  shortName?: string;
  handler?: string;
  urlPattern: string;
  input?: InputUrlConfig;
  pages?: PageRequest[];
  search?: SearchRule;
  fields: FieldExtraction[];
}

export interface TemplateCategory {
  id: string;
  name: string;
  icon?: string;
  outputFolder: string;
  filenameField: string;
  noteFormat?: string;
  siteRules: SiteRule[];
}

export interface SimplePluginSettings {
  autoProcessPaste: boolean;
  autoProcessObsidian: boolean;
  autoProcessPastedTextLinks: boolean;
  plainTextPasteSkipsSingleLinkProcessing: boolean;
  plainTextPasteSkipsContentLinkScan: boolean;
  enableTemplateFill: boolean;
  enableTemplateFillAction: boolean;
  showEmptySearchGroups: boolean;
  enableColorPreview: boolean;
  readableLineWidth: string;
  popupWindowScale: string;
  mobileSwitches: Record<string, boolean | string[]>;
  mobileDisplay: {
    readableLineWidth: string;
    imageMaxHeight: string;
    popupWindowScale: string;
    headerButtonSize: string;
    disableThemeHeaderButtons: boolean;
  };
  enableMermaidEnhancer: boolean;
  imageMaxHeight: string;
  enableImageZoom: boolean;
  enableInlineCodeCopy: boolean;
  enableHtmlPreview: boolean;
  enableReadableCustomTags: boolean;
  enableNotionColumns: boolean;
  htmlPreviewRules: HtmlPreviewRule[];
  enhancements: EnhancementSettings;
  diary: DiarySettings;
  newNoteDefaults: NewNoteDefaultsSettings;
  searchFolders: SearchFolderSettings;
  filterRules: FilterRule[];
  templateCategories: TemplateCategory[];
}

export interface SearchFolderSettings {
  enabled: boolean;
  includeFolders: string[];
  excludeFolders: string[];
  /** Legacy fields kept only for settings migration. */
  mode?: "all" | "include" | "exclude";
  folders?: string[];
}

export interface NewNoteDefaultsSettings {
  enabled: boolean;
  rules: NewNoteDatabaseRule[];
}

export interface NewNoteDatabaseRule {
  id: string;
  enabled: boolean;
  folder: string;
  databasePath: string;
  includeSubfolders: boolean;
}

export interface HtmlPreviewRule {
  id: string;
  importId: string;
  enabled: boolean;
  name: string;
  pattern: string;
  flags: string;
  replaceWith: string;
}

export type QuickCopyLinkMode = "obsidian-url" | "absolute-path" | "navigator-folder-absolute-path";
export type QuickFormatCalloutType =
  | "note"
  | "abstract"
  | "info"
  | "todo"
  | "important"
  | "tip"
  | "success"
  | "question"
  | "warning"
  | "failure"
  | "danger"
  | "bug"
  | "example"
  | "quote";
export type QuickFormatMode =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "quote"
  | `callout-${QuickFormatCalloutType}`
  | `custom-callout:${string}`;
export type QuickFormatHeadingLevel = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export interface QuickFormatCalloutDefinition {
  type: QuickFormatCalloutType;
  label: string;
  icon: string;
  aliases: string[];
}

// Keep aliases in the definition for compatibility/documentation, but expose one menu item per icon.
export const QUICK_FORMAT_CALLOUTS: QuickFormatCalloutDefinition[] = [
  { type: "note", label: "Note", icon: "pencil", aliases: [] },
  { type: "abstract", label: "Abstract", icon: "clipboard-list", aliases: ["summary", "tldr"] },
  { type: "info", label: "Info", icon: "info", aliases: [] },
  { type: "todo", label: "Todo", icon: "list-checks", aliases: [] },
  { type: "important", label: "Important", icon: "badge-alert", aliases: [] },
  { type: "tip", label: "Tip", icon: "flame", aliases: ["hint"] },
  { type: "success", label: "Success", icon: "circle-check", aliases: ["check", "done"] },
  { type: "question", label: "Question", icon: "circle-help", aliases: ["help", "faq"] },
  { type: "warning", label: "Warning", icon: "triangle-alert", aliases: ["caution", "attention"] },
  { type: "failure", label: "Failure", icon: "circle-x", aliases: ["fail", "missing"] },
  { type: "danger", label: "Danger", icon: "zap", aliases: ["error"] },
  { type: "bug", label: "Bug", icon: "bug", aliases: [] },
  { type: "example", label: "Example", icon: "list", aliases: [] },
  { type: "quote", label: "Quote", icon: "quote", aliases: ["cite"] },
];

export interface QuickFormatCustomCallout {
  id: string;
  type: string;
  label: string;
  color: string;
}

export interface EnhancementSettings {
  quickCopyLink: QuickCopyLinkSettings;
  quickFormat: QuickFormatSettings;
  currentNoteLinkConverter: CurrentNoteLinkConverterSettings;
}

export interface QuickCopyLinkSettings {
  enabled: boolean;
  lastMode: QuickCopyLinkMode;
}

export interface QuickFormatSettings {
  enabled: boolean;
  showDesktopEntry: boolean;
  showMobileEntry: boolean;
  lastMode: QuickFormatMode;
  visibleModes: QuickFormatMode[];
  headingColors: Record<QuickFormatHeadingLevel, string>;
  headingSizes: Record<QuickFormatHeadingLevel, string>;
  calloutColors: Record<QuickFormatCalloutType, string>;
  customCallouts: QuickFormatCustomCallout[];
}

export interface CurrentNoteLinkConverterSettings {
  enabled: boolean;
  showReformatCurrentNoteMenuItem: boolean;
}

export interface DiarySettings {
  enabled: boolean;
  folder: string;
  pathPattern: string;
  templatePath: string;
  locale: "system";
  showWeekends: boolean;
  highlightToday: boolean;
  showWeekNumber: boolean;
  showQuarter: boolean;
  showYearCalendar: boolean;
  carryUnfinishedTasks: boolean;
  carryFromPreviousDays: number;
  reminderTargetMode: "heading" | "callout";
  tipsHeading: string;
  tipsCallout: string;
  recurringRules: RecurringRule[];
  dateManagement: DateManagementSettings;
  anniversaries: Anniversary[];
  holidaySchedules: HolidaySchedule[];
  reformat: NoteReformatSettings;
}

export interface NoteReformatSettings {
  runFormatReflow: boolean;
  runLinkConversion: boolean;
  autoReformatAfterPaste: boolean;
  formatRules: TextReformatRule[];
}

export interface TextReformatRule {
  id: string;
  enabled: boolean;
  name: string;
  pattern: string;
  flags: string;
  replaceWith: string;
}

export interface RecurringRule {
  id: string;
  enabled: boolean;
  text: string;
  outputFormat?: "task" | "text";
  advanceEnabled?: boolean;
  advanceDays?: number;
  advanceContinuous?: boolean;
  advanceText?: string;
  type: "weekly" | "monthly-date" | "monthly-weekday";
  weekdays?: number[];
  days?: number[];
  nth?: number;
  weekday?: number;
}

export type AnniversaryDateType = "gregorian" | "lunar" | "lunar-eve" | "weekday-rule" | "solar-term";

export interface Anniversary {
  id: string;
  name: string;
  enabled: boolean;
  showInCalendar?: boolean;
  tags: string[];
  dateType: AnniversaryDateType;
  month?: number;
  day?: number;
  lunarMonth?: number;
  lunarDay?: number;
  leapMonth?: boolean;
  weekdayRule?: {
    month: number;
    nth: number;
    weekday: number;
  };
  reminderEnabled: boolean;
  sameDayReminderEnabled?: boolean;
  advanceReminderEnabled?: boolean;
  reminderDaysBefore: number;
  reminderText?: string;
  outputFormat: "task" | "text";
}

export type HolidaySource = "national" | "company" | "manual";

export type DayScheduleStatus =
  | "day-off"
  | "workday"
  | "adjusted-workday"
  | "company-day-off"
  | "half-day"
  | "remote";

export interface HolidaySchedule {
  id: string;
  version: 1;
  source: HolidaySource;
  name: string;
  year: number;
  enabled: boolean;
  sourceUrl?: string;
  publishedDate?: string;
  importedAt: string;
  days: DayScheduleItem[];
  warnings?: string[];
}

export interface DayScheduleItem {
  date: string;
  status: DayScheduleStatus;
  label: string;
}

export interface DateManagementSettings {
  anniversaries: {
    enabled: boolean;
    showInCalendar: boolean;
  };
  nationalHolidays: {
    enabled: boolean;
    showInCalendar: boolean;
    remindNextYearImportFromMonth: number;
  };
  companyHolidays: {
    enabled: boolean;
    showInCalendar: boolean;
  };
  reminderWriting: {
    enabled: boolean;
    heading: string;
  };
  holidaySetupReminder: {
    enabled: boolean;
    writeToTips: boolean;
    month: number;
    daysBefore: number;
  };
}

let rid = Date.now();
export function nextId(): string { return `r${++rid}`; }

export function makeFilterRule(): FilterRule {
  return { id: nextId(), enabled: true, urlPattern: "", titleRegex: "", replaceWith: "" };
}

export function makeTextReformatRule(): TextReformatRule {
  return { id: nextId(), enabled: true, name: "", pattern: "", flags: "g", replaceWith: "" };
}

export function makeHtmlPreviewRule(): HtmlPreviewRule {
  return { id: nextId(), importId: makeExternalId(), enabled: true, name: "", pattern: "", flags: "g", replaceWith: "" };
}

export function makeNewNoteDatabaseRule(): NewNoteDatabaseRule {
  return { id: nextId(), enabled: true, folder: "", databasePath: "", includeSubfolders: false };
}

function makeExternalId(): string {
  return crypto.randomUUID?.() ?? nextId();
}

export function makeRecurringRule(): RecurringRule {
  return {
    id: nextId(),
    enabled: true,
    text: "",
    outputFormat: "task",
    advanceEnabled: false,
    advanceDays: 3,
    advanceContinuous: false,
    advanceText: "",
    type: "weekly",
    weekdays: [1],
  };
}

export function makeDefaultAnniversaries(): Anniversary[] {
  return [
    makeLunarAnniversary("春节", 1, 1, ["传统"], true, false),
    makeLunarAnniversary("元宵节", 1, 15, ["传统"], true, false),
    makeSolarTermAnniversary("清明", ["传统"], true, false),
    makeLunarAnniversary("端午节", 5, 5, ["传统"], true, false),
    makeLunarAnniversary("七夕", 7, 7, ["传统"], true, false),
    makeLunarAnniversary("中元节", 7, 15, ["传统"], true, false),
    makeLunarAnniversary("中秋节", 8, 15, ["传统"], true, false),
    makeLunarAnniversary("重阳节", 9, 9, ["传统"], true, false),
    makeSolarTermAnniversary("冬至", ["传统"], true, false),
    makeLunarAnniversary("腊八节", 12, 8, ["传统"], true, false),
    makeLunarAnniversary("小年北", 12, 23, ["传统"], true, false),
    makeLunarAnniversary("小年南", 12, 24, ["传统"], true, false),
    makeLunarEveAnniversary("除夕", ["传统"], true, false),
    makeGregorianAnniversary("元旦", 1, 1, ["常用"], true, false),
    makeGregorianAnniversary("妇女节", 3, 8, ["常用"], true, false),
    makeGregorianAnniversary("劳动节", 5, 1, ["常用"], true, false),
    makeGregorianAnniversary("儿童节", 6, 1, ["常用"], true, false),
    makeGregorianAnniversary("教师节", 9, 10, ["常用"], true, false),
    makeGregorianAnniversary("国庆节", 10, 1, ["常用"], true, false),
    makeGregorianAnniversary("情人节", 2, 14, ["常用"], true, false),
    makeGregorianAnniversary("520", 5, 20, ["常用"], true, false),
    makeWeekdayAnniversary("母亲节", 5, 2, 7, ["常用"], true, true, 7),
    makeWeekdayAnniversary("父亲节", 6, 3, 7, ["常用"], true, true, 7),
    makeWeekdayAnniversary("感恩节", 11, 4, 4, ["常用"], true, false),
    makeGregorianAnniversary("圣诞节", 12, 25, ["常用"], true, false),
    makeGregorianAnniversary("愚人节", 4, 1, ["常用"], true, false),
    makeGregorianAnniversary("万圣夜", 10, 31, ["常用"], true, false),
    makeGregorianAnniversary("植树节", 3, 12, ["纪念"], false, false),
    makeGregorianAnniversary("青年节", 5, 4, ["纪念"], false, false),
    makeGregorianAnniversary("建党节", 7, 1, ["纪念"], false, false),
    makeGregorianAnniversary("建军节", 8, 1, ["纪念"], false, false),
    makeGregorianAnniversary("世界读书日", 4, 23, ["纪念"], false, false),
    makeGregorianAnniversary("世界地球日", 4, 22, ["纪念"], false, false),
    makeGregorianAnniversary("世界环境日", 6, 5, ["纪念"], false, false),
    makeGregorianAnniversary("世界无烟日", 5, 31, ["纪念"], false, false),
    makeGregorianAnniversary("世界精神卫生日", 10, 10, ["纪念"], false, false),
    makeGregorianAnniversary("护士节", 5, 12, ["纪念"], false, false),
    makeGregorianAnniversary("医师节", 8, 19, ["纪念"], false, false),
    makeGregorianAnniversary("记者节", 11, 8, ["纪念"], false, false),
    makeGregorianAnniversary("程序员节", 10, 24, ["纪念"], false, false),
    makeGregorianAnniversary("消费者权益日", 3, 15, ["纪念"], false, false),
    makeGregorianAnniversary("全国爱眼日", 6, 6, ["纪念"], false, false),
    makeGregorianAnniversary("国家公祭日", 12, 13, ["纪念"], false, false),
    makeGregorianAnniversary("光棍节", 11, 11, ["纪念"], false, false),
  ];
}

export function makeDefaultTextReformatRules(): TextReformatRule[] {
  return [
    {
      id: "reformat-trim-trailing-space",
      enabled: true,
      name: "清理行尾空格",
      pattern: "[ \\t]+$",
      flags: "gm",
      replaceWith: "",
    },
    {
      id: "reformat-join-after-colon",
      enabled: true,
      name: "冒号后断行接回",
      pattern: "([:：])\\n(?=\\S)",
      flags: "g",
      replaceWith: "$1",
    },
    {
      id: "reformat-english-hard-wrap",
      enabled: true,
      name: "英文单词断行补空格",
      pattern: "([A-Za-z0-9])\\n(?=[A-Za-z0-9])",
      flags: "g",
      replaceWith: "$1 ",
    },
    {
      id: "reformat-chinese-hard-wrap",
      enabled: true,
      name: "中文句中硬换行接回",
      pattern: "([^。！？!?；;…」』”’）》）\\]】\"'])\\n(?!(?:\\d{1,2}[.．、]|https?:\\/\\/))(?=[^\\n,，.。;；:：!?！？、])",
      flags: "g",
      replaceWith: "$1",
    },
    {
      id: "reformat-numbered-items",
      enabled: true,
      name: "连续数字序号换行",
      pattern: "([^\\n])(?=(?:[2-9]|[1-9]\\d)[.．、](?!\\d)\\s*\\S)",
      flags: "g",
      replaceWith: "$1\\n",
    },
    {
      id: "reformat-collapse-blank-lines",
      enabled: false,
      name: "压缩连续空行",
      pattern: "\\n{3,}",
      flags: "g",
      replaceWith: "\\n\\n",
    },
  ];
}

export const BUILT_IN_TEXT_REFORMAT_RULE_IDS = new Set(
  makeDefaultTextReformatRules().map((rule) => rule.id)
);

function makeGregorianAnniversary(
  name: string,
  month: number,
  day: number,
  tags: string[],
  showInCalendar: boolean,
  reminderEnabled: boolean,
  reminderDaysBefore = 0
): Anniversary {
  return {
    id: nextId(),
    name,
    enabled: true,
    showInCalendar,
    tags,
    dateType: "gregorian",
    month,
    day,
    reminderEnabled,
    sameDayReminderEnabled: reminderEnabled,
    advanceReminderEnabled: reminderEnabled && reminderDaysBefore > 0,
    reminderDaysBefore,
    outputFormat: "task",
  };
}

function makeWeekdayAnniversary(
  name: string,
  month: number,
  nth: number,
  weekday: number,
  tags: string[],
  showInCalendar: boolean,
  reminderEnabled: boolean,
  reminderDaysBefore = 0
): Anniversary {
  return {
    id: nextId(),
    name,
    enabled: true,
    showInCalendar,
    tags,
    dateType: "weekday-rule",
    weekdayRule: { month, nth, weekday },
    reminderEnabled,
    sameDayReminderEnabled: reminderEnabled,
    advanceReminderEnabled: reminderEnabled && reminderDaysBefore > 0,
    reminderDaysBefore,
    outputFormat: "task",
  };
}

function makeLunarAnniversary(
  name: string,
  lunarMonth: number,
  lunarDay: number,
  tags: string[],
  showInCalendar: boolean,
  reminderEnabled: boolean,
  reminderDaysBefore = 0
): Anniversary {
  return {
    id: nextId(),
    name,
    enabled: true,
    showInCalendar,
    tags,
    dateType: "lunar",
    lunarMonth,
    lunarDay,
    reminderEnabled,
    sameDayReminderEnabled: reminderEnabled,
    advanceReminderEnabled: reminderEnabled && reminderDaysBefore > 0,
    reminderDaysBefore,
    outputFormat: "task",
  };
}

function makeLunarEveAnniversary(
  name: string,
  tags: string[],
  showInCalendar: boolean,
  reminderEnabled: boolean,
  reminderDaysBefore = 0
): Anniversary {
  return {
    id: nextId(),
    name,
    enabled: true,
    showInCalendar,
    tags,
    dateType: "lunar-eve",
    reminderEnabled,
    sameDayReminderEnabled: reminderEnabled,
    advanceReminderEnabled: reminderEnabled && reminderDaysBefore > 0,
    reminderDaysBefore,
    outputFormat: "task",
  };
}

function makeSolarTermAnniversary(
  name: string,
  tags: string[],
  showInCalendar: boolean,
  reminderEnabled: boolean,
  reminderDaysBefore = 0
): Anniversary {
  return {
    id: nextId(),
    name,
    enabled: true,
    showInCalendar,
    tags,
    dateType: "solar-term",
    reminderEnabled,
    sameDayReminderEnabled: reminderEnabled,
    advanceReminderEnabled: reminderEnabled && reminderDaysBefore > 0,
    reminderDaysBefore,
    outputFormat: "task",
  };
}

export const DEFAULT_SETTINGS: SimplePluginSettings = {
  autoProcessPaste: true,
  autoProcessObsidian: true,
  autoProcessPastedTextLinks: false,
  plainTextPasteSkipsSingleLinkProcessing: true,
  plainTextPasteSkipsContentLinkScan: false,
  enableTemplateFill: true,
  enableTemplateFillAction: true,
  showEmptySearchGroups: false,
  enableColorPreview: true,
  readableLineWidth: "900",
  popupWindowScale: "70",
  mobileSwitches: {},
  mobileDisplay: { readableLineWidth: "", imageMaxHeight: "", popupWindowScale: "0", headerButtonSize: "29", disableThemeHeaderButtons: true },
  enableMermaidEnhancer: true,
  imageMaxHeight: "450",
  enableImageZoom: true,
  enableInlineCodeCopy: true,
  enableHtmlPreview: true,
  enableReadableCustomTags: true,
  enableNotionColumns: true,
  htmlPreviewRules: [],
  enhancements: {
    quickCopyLink: {
      enabled: true,
      lastMode: "absolute-path",
    },
    quickFormat: {
      enabled: true,
      showDesktopEntry: true,
      showMobileEntry: true,
      lastMode: "h3",
      visibleModes: ["h3", "h4", "h5", "quote", "callout-note", "callout-important", "callout-tip", "callout-question", "callout-warning", "callout-example", "custom-callout:simple-default-tips"],
      headingColors: {
        h1: "",
        h2: "",
        h3: "",
        h4: "",
        h5: "",
        h6: "",
      },
      headingSizes: {
        h1: "",
        h2: "",
        h3: "",
        h4: "",
        h5: "",
        h6: "",
      },
      calloutColors: {
        note: "",
        abstract: "",
        info: "",
        todo: "",
        important: "",
        tip: "",
        success: "",
        question: "",
        warning: "",
        failure: "",
        danger: "",
        bug: "",
        example: "",
        quote: "",
      },
      customCallouts: [{ id: "simple-default-tips", type: "小贴士", label: "小贴士", color: "#a20b0b" }],
    },
    currentNoteLinkConverter: {
      enabled: true,
      showReformatCurrentNoteMenuItem: true,
    },
  },
  diary: {
    enabled: true,
    folder: "Daily Notes",
    pathPattern: "YYYY/MM/DD WEEKDAY.md",
    templatePath: "",
    locale: "system",
    showWeekends: true,
    highlightToday: false,
    showWeekNumber: true,
    showQuarter: true,
    showYearCalendar: true,
    carryUnfinishedTasks: true,
    carryFromPreviousDays: 1,
    reminderTargetMode: "callout",
    tipsHeading: "#### 小贴士",
    tipsCallout: "小贴士",
    recurringRules: [],
    dateManagement: {
      anniversaries: {
        enabled: true,
        showInCalendar: true,
      },
      nationalHolidays: {
        enabled: true,
        showInCalendar: true,
        remindNextYearImportFromMonth: 12,
      },
      companyHolidays: {
        enabled: true,
        showInCalendar: true,
      },
      reminderWriting: {
        enabled: true,
        heading: "#### 小贴士",
      },
      holidaySetupReminder: {
        enabled: true,
        writeToTips: true,
        month: 12,
        daysBefore: 7,
      },
    },
    anniversaries: makeDefaultAnniversaries(),
    holidaySchedules: [],
    reformat: {
      runFormatReflow: true,
      runLinkConversion: true,
      autoReformatAfterPaste: false,
      formatRules: makeDefaultTextReformatRules(),
    },
  },
  newNoteDefaults: {
    enabled: true,
    rules: [],
  },
  searchFolders: {
    enabled: true,
    includeFolders: [],
    excludeFolders: [],
  },
  filterRules: [
    { id: nextId(), enabled: true, urlPattern: "jjwxc\\.net", titleRegex: "《([^》]+)》", replaceWith: "" },
    { id: nextId(), enabled: true, urlPattern: "52shuku\\.net", titleRegex: "^(.*?)_.*", replaceWith: "$1" },
  ],
  templateCategories: [],
};
