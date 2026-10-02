import {
  App,
  ItemView,
  Modal,
  Notice,
  Setting,
  TFile,
  moment,
  normalizePath,
  setIcon,
  WorkspaceLeaf,
} from "obsidian";
import { Lunar, Solar } from "lunar-javascript";
import type SimplePlugin from "../main";
import {
  makeRecurringRule,
  type Anniversary,
  type DayScheduleItem,
  type DayScheduleStatus,
  type DiarySettings,
  type HolidaySource,
  type RecurringRule,
} from "../types";

export const DIARY_VIEW_TYPE = "simple-diary";

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type CarriedTask = {
  line: string;
  h3: string | null;
  h4: string | null;
  callout: string | null;
  indent: string;
  text: string;
  extraLines: string[];
};

type DiaryAutomationResult = {
  content: string;
  dateRemindersAdded: number;
  recurringAdded: number;
  carriedAdded: number;
  carriedRemoved: number;
};

type NotebookNavigatorCalendarSettings = {
  calendarLocale: string;
  calendarWeekendDays: "none" | "sat-sun" | "fri-sat" | "thu-fri";
  calendarMonthHeadingFormat: "full" | "short";
  calendarHighlightToday: boolean;
  calendarShowWeekNumber: boolean;
  calendarShowQuarter: boolean;
  calendarShowYearCalendar: boolean;
};

export type NotebookNavigatorPlugin = {
  settings: NotebookNavigatorCalendarSettings;
  saveSettingsAndUpdate(): Promise<void>;
  registerSettingsUpdateListener(id: string, listener: () => void): void;
  unregisterSettingsUpdateListener(id: string): void;
};

type CalendarAppearance = NotebookNavigatorCalendarSettings & {
  locale: string;
  firstDay: number;
  weekdayNames: string[];
  weekendDays: Set<number>;
};

const makeMoment = moment as unknown as (date: Date) => {
  locale(value: string): { week(): number; format(pattern: string): string };
};

export function getNotebookNavigatorPlugin(app: App): NotebookNavigatorPlugin | null {
  const plugins = (app as App & {
    plugins?: { getPlugin(id: string): unknown };
  }).plugins;
  const plugin = plugins?.getPlugin("notebook-navigator") as Partial<NotebookNavigatorPlugin> | null;
  return plugin?.settings
    && plugin.saveSettingsAndUpdate
    && plugin.registerSettingsUpdateListener
    && plugin.unregisterSettingsUpdateListener
    ? plugin as NotebookNavigatorPlugin
    : null;
}

export class DiaryView extends ItemView {
  plugin: SimplePlugin;
  private visibleDate = startOfMonth(new Date());
  private selectedDate = startOfDay(new Date());
  private showRecurringPanel = false;
  private showCalendarAnnotations = true;
  private showSettingsPanel = false;
  private readonly navigatorSettingsListenerId = `simple-diary-${crypto.randomUUID()}`;

  constructor(leaf: WorkspaceLeaf, plugin: SimplePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return DIARY_VIEW_TYPE; }
  getDisplayText(): string { return "日记"; }
  getIcon(): string { return "calendar-days"; }

  async onOpen(): Promise<void> {
    this.containerEl.children[1].empty();
    this.containerEl.children[1].addClass("simple-diary-view");
    const navigator = getNotebookNavigatorPlugin(this.app);
    if (navigator && navigator.settings.calendarWeekendDays !== "none" && navigator.settings.calendarWeekendDays !== "sat-sun") {
      navigator.settings.calendarWeekendDays = "sat-sun";
      await navigator.saveSettingsAndUpdate();
    }
    navigator?.registerSettingsUpdateListener(
      this.navigatorSettingsListenerId,
      () => this.refresh()
    );
    this.render();
  }

  async onClose(): Promise<void> {
    getNotebookNavigatorPlugin(this.app)?.unregisterSettingsUpdateListener(this.navigatorSettingsListenerId);
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    const appearance = this.getCalendarAppearance();

    const header = container.createDiv({ cls: "simple-diary-header" });
    header.createDiv({
      cls: "simple-diary-title",
      text: monthName(this.visibleDate, appearance),
    });
    const navigator = header.createDiv({ cls: "simple-diary-month-nav" });
    const previousMonth = navigator.createEl("button", {
      cls: "simple-diary-month-nav-button",
      attr: { title: "上个月", "aria-label": "上个月" },
    });
    setIcon(previousMonth, "chevron-left");
    previousMonth.addEventListener("click", () => this.changeVisibleMonth(-1));
    const todayButton = navigator.createEl("button", {
      cls: "simple-diary-today-button",
      text: "今天",
      attr: { title: "回到今天", "aria-label": "回到今天" },
    });
    todayButton.addEventListener("click", async () => {
      const today = startOfDay(new Date());
      this.selectedDate = today;
      this.visibleDate = startOfMonth(today);
      await openOrCreateDiaryNote(this.plugin, today);
      this.render();
    });
    const nextMonth = navigator.createEl("button", {
      cls: "simple-diary-month-nav-button",
      attr: { title: "下个月", "aria-label": "下个月" },
    });
    setIcon(nextMonth, "chevron-right");
    nextMonth.addEventListener("click", () => this.changeVisibleMonth(1));
    this.renderMonthCalendar(container, this.visibleDate, appearance);
    this.renderHolidayImportReminder(container);

    if (appearance.calendarShowYearCalendar) {
      this.renderYearCalendar(container, appearance);
    }

    this.renderToolbar(container);
    if (this.showSettingsPanel) {
      this.renderSettingsPanel(container);
    }
    if (this.showRecurringPanel) {
      this.renderRecurringPanel(container);
    }
  }

  private renderMonthCalendar(container: HTMLElement, date: Date, appearance: CalendarAppearance): void {
    const section = container.createDiv({ cls: "simple-diary-month" });
    let swipeStart: { x: number; y: number } | null = null;
    section.addEventListener("touchstart", (event) => {
      const touch = event.touches[0];
      if (touch) swipeStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });
    section.addEventListener("touchend", (event) => {
      const touch = event.changedTouches[0];
      if (!swipeStart || !touch) return;
      const deltaX = touch.clientX - swipeStart.x;
      const deltaY = touch.clientY - swipeStart.y;
      swipeStart = null;
      if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
      this.changeVisibleMonth(deltaX > 0 ? -1 : 1);
    }, { passive: true });
    const weekdays = section.createDiv({
      cls: appearance.calendarShowWeekNumber
        ? "simple-diary-weekdays has-week-number"
        : "simple-diary-weekdays",
    });
    if (appearance.calendarShowWeekNumber) {
      weekdays.createDiv({ cls: "simple-diary-week-number-spacer" });
      weekdays.createDiv({ cls: "simple-diary-week-number-divider" });
    }
    for (const name of appearance.weekdayNames) {
      weekdays.createDiv({ cls: "simple-diary-weekday", text: name });
    }

    const monthWeeks = buildMonthWeeks(date, appearance.firstDay);
    const weeks = section.createDiv({
      cls: appearance.calendarShowWeekNumber
        ? "simple-diary-weeks has-week-number"
        : "simple-diary-weeks",
    });
    for (let weekIndex = 0; weekIndex < monthWeeks.length; weekIndex++) {
      const week = monthWeeks[weekIndex];
      const weekRow = weeks.createDiv({
        cls: weekIndex < monthWeeks.length - 1
          ? "simple-diary-week has-next-week"
          : "simple-diary-week",
      });
      if (appearance.calendarShowWeekNumber) {
        weekRow.createDiv({ cls: "simple-diary-week-number", text: String(makeMoment(week[0]).locale(appearance.locale).week()) });
        weekRow.createDiv({ cls: "simple-diary-week-number-divider" });
      }
      for (let dayIndex = 0; dayIndex < week.length; dayIndex++) {
        const day = week[dayIndex];
        const cell = weekRow.createDiv({ cls: "simple-diary-day-cell" });
        if (appearance.weekendDays.has(day.getDay())) {
          cell.addClass("is-weekend");
          const hasBefore = dayIndex > 0 && appearance.weekendDays.has(week[dayIndex - 1].getDay());
          const hasAfter = dayIndex < week.length - 1 && appearance.weekendDays.has(week[dayIndex + 1].getDay());
          const hasAbove = weekIndex > 0;
          const hasBelow = weekIndex < monthWeeks.length - 1;
          if (hasBefore) cell.addClass("has-weekend-before");
          if (hasAfter) cell.addClass("has-weekend-after");
          if (hasAbove) cell.addClass("has-weekend-above");
          if (hasBelow) cell.addClass("has-weekend-below");
          if (!hasBefore && !hasAbove) cell.addClass("round-weekend-top-left");
          if (!hasAfter && !hasAbove) cell.addClass("round-weekend-top-right");
          if (!hasBefore && !hasBelow) cell.addClass("round-weekend-bottom-left");
          if (!hasAfter && !hasBelow) cell.addClass("round-weekend-bottom-right");
        }
        const button = cell.createEl("button", {
          cls: "simple-diary-day",
        });
        button.createSpan({ cls: "simple-diary-day-number", text: String(day.getDate()) });
        if (this.showCalendarAnnotations) {
          renderDateMarkers(button, this.plugin.settings.diary, day);
        }
        if (day.getMonth() !== date.getMonth()) button.addClass("is-outside-month");
        if (isSameDate(day, new Date()) && appearance.calendarHighlightToday) button.addClass("is-today");
        if (isSameDate(day, this.selectedDate)) button.addClass("is-selected");
        if (appearance.weekendDays.has(day.getDay())) button.addClass("is-weekend");
        if (this.showRecurringPanel && hasActiveRecurringRuleOnDate(this.plugin.settings.diary.recurringRules, day)) {
          button.addClass("has-recurring-plan");
        }
        button.addEventListener("click", async () => {
          this.selectedDate = startOfDay(day);
          this.visibleDate = startOfMonth(day);
          await openOrCreateDiaryNote(this.plugin, day);
          this.render();
        });
      }
    }
    if (this.showCalendarAnnotations) {
      const legend = section.createDiv({ cls: "simple-diary-calendar-legend" });
      for (const item of [
        { kind: "is-reminder", label: "节日" },
        { kind: "is-day-off", label: "假期" },
        { kind: "is-workday", label: "调休" },
      ]) {
        const legendItem = legend.createDiv({ cls: "simple-diary-calendar-legend-item" });
        legendItem.createSpan({ cls: `simple-diary-calendar-legend-swatch ${item.kind}` });
        legendItem.createSpan({ text: item.label });
      }
    }
  }

  private renderYearCalendar(container: HTMLElement, appearance: CalendarAppearance): void {
    const year = this.visibleDate.getFullYear();
    const yearSection = container.createDiv({ cls: "simple-diary-year" });
    const yearNav = yearSection.createDiv({ cls: "simple-diary-year-nav" });
    const previousYear = yearNav.createEl("button", {
      cls: "simple-diary-year-nav-button",
      attr: { title: "上一年", "aria-label": "上一年" },
    });
    setIcon(previousYear, "chevron-left");
    previousYear.addEventListener("click", () => {
      this.visibleDate = new Date(year - 1, this.visibleDate.getMonth(), 1);
      this.render();
    });
    yearNav.createDiv({ cls: "simple-diary-year-label", text: String(year) });
    const nextYear = yearNav.createEl("button", {
      cls: "simple-diary-year-nav-button",
      attr: { title: "下一年", "aria-label": "下一年" },
    });
    setIcon(nextYear, "chevron-right");
    nextYear.addEventListener("click", () => {
      this.visibleDate = new Date(year + 1, this.visibleDate.getMonth(), 1);
      this.render();
    });
    const months = yearSection.createDiv({ cls: "simple-diary-year-grid" });
    for (let month = 0; month < 12; month++) {
      const monthDate = new Date(year, month, 1);
      const monthButton = months.createEl("button", {
        cls: "simple-diary-year-month",
        text: monthName(monthDate, appearance),
      });
      if (month === this.visibleDate.getMonth()) monthButton.addClass("is-current-month");
      monthButton.addEventListener("click", () => {
        this.visibleDate = monthDate;
        this.render();
      });
    }
  }

  private changeVisibleMonth(offset: number): void {
    this.visibleDate = new Date(this.visibleDate.getFullYear(), this.visibleDate.getMonth() + offset, 1);
    this.render();
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "simple-diary-toolbar" });
    const refresh = toolbar.createEl("button", {
      cls: "simple-diary-icon-button",
      attr: { title: "待办追踪", "aria-label": "待办追踪" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", async () => {
      await carryUnfinishedToActiveDiary(this.plugin);
    });

    const recurring = toolbar.createEl("button", {
      cls: this.showRecurringPanel ? "simple-diary-icon-button is-active" : "simple-diary-icon-button",
      attr: { title: "周期计划", "aria-label": "周期计划" },
    });
    setIcon(recurring, "repeat");
    recurring.addEventListener("click", () => {
      this.showRecurringPanel = !this.showRecurringPanel;
      this.render();
    });

    const settings = toolbar.createEl("button", {
      cls: this.showSettingsPanel ? "simple-diary-icon-button is-active" : "simple-diary-icon-button",
      attr: {
        title: "日记",
        "aria-label": "日记",
        "aria-expanded": String(this.showSettingsPanel),
      },
    });
    setIcon(settings, "settings");
    settings.addEventListener("click", () => {
      this.showSettingsPanel = !this.showSettingsPanel;
      this.render();
      if (this.showSettingsPanel) {
        this.containerEl.ownerDocument.defaultView?.requestAnimationFrame(() => {
          this.containerEl.querySelector(".simple-diary-inline-settings")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      }
    });
  }

  private renderSettingsPanel(container: HTMLElement): void {
    const diary = this.plugin.settings.diary;
    const panel = container.createDiv({ cls: "simple-diary-inline-settings" });
    panel.createEl("h2", { cls: "simple-diary-inline-settings-title", text: "日记" });

    const appearanceSection = panel.createDiv({ cls: "simple-diary-inline-settings-section" });
    appearanceSection.createEl("h3", { cls: "simple-diary-inline-settings-heading", text: "日历外观" });
    const navigator = this.plugin.isMobile ? null : getNotebookNavigatorPlugin(this.app);
    const toggleSetting = (
      name: string,
      description: string,
      value: boolean,
      onChange: (value: boolean) => Promise<void>
    ): void => {
      new Setting(appearanceSection)
        .setName(name)
        .setDesc(description)
        .addToggle((toggle) =>
          toggle.setValue(value).onChange(async (nextValue) => {
            await onChange(nextValue);
          })
        );
    };
    const saveAppearance = async (): Promise<void> => {
      if (navigator) await navigator.saveSettingsAndUpdate();
      else {
        await this.plugin.saveSettings();
        this.plugin.refreshDiaryViews();
      }
    };
    toggleSetting("显示年历", "在月历下方显示 12 个月概览。", navigator?.settings.calendarShowYearCalendar ?? diary.showYearCalendar, async (value) => {
      if (navigator) navigator.settings.calendarShowYearCalendar = value;
      else diary.showYearCalendar = value;
      await saveAppearance();
    });
    toggleSetting("显示周号", "在月历左侧显示周号。", navigator?.settings.calendarShowWeekNumber ?? diary.showWeekNumber, async (value) => {
      if (navigator) navigator.settings.calendarShowWeekNumber = value;
      else diary.showWeekNumber = value;
      await saveAppearance();
    });
    toggleSetting("高亮今天", "在日历中标记今天。", navigator?.settings.calendarHighlightToday ?? diary.highlightToday, async (value) => {
      if (navigator) navigator.settings.calendarHighlightToday = value;
      else diary.highlightToday = value;
      await saveAppearance();
    });
    toggleSetting("阴影显示周末", "用不同背景色显示周六和周日。", navigator ? navigator.settings.calendarWeekendDays !== "none" : diary.showWeekends, async (value) => {
      if (navigator) navigator.settings.calendarWeekendDays = value ? "sat-sun" : "none";
      else diary.showWeekends = value;
      await saveAppearance();
    });
    toggleSetting("显示日历注记", "显示节日、假期和调休标记。", this.showCalendarAnnotations, async (value) => {
      this.showCalendarAnnotations = value;
      this.render();
    });
    const fileSection = panel.createDiv({ cls: "simple-diary-inline-settings-section" });
    fileSection.createEl("h3", { cls: "simple-diary-inline-settings-heading", text: "文件保存" });
    this.renderLockedDiarySetting(fileSection, "日记文件夹", diary.folder, "Daily Notes", async (value) => {
      diary.folder = value;
      await this.plugin.saveSettings();
    });
    this.renderLockedDiarySetting(
      fileSection,
      "日记路径命名规则",
      diary.pathPattern,
      "YYYY/MM/DD WEEKDAY.md",
      async (value) => {
        diary.pathPattern = value;
        await this.plugin.saveSettings();
      }
    );
    this.renderLockedDiarySetting(
      fileSection,
      "日记模板",
      diary.templatePath,
      "Templates/Daily Note.md",
      async (value) => {
        diary.templatePath = value;
        await this.plugin.saveSettings();
      }
    );
  }

  private getCalendarAppearance(): CalendarAppearance {
    const diary = this.plugin.settings.diary;
    const navigator = getNotebookNavigatorPlugin(this.app)?.settings;
    const calendarLocale = navigator?.calendarLocale ?? "system-default";
    const locale = calendarLocale === "system-default" ? moment.locale() : calendarLocale;
    const localeData = moment.localeData(locale);
    const firstDay = localeData.firstDayOfWeek();
    const names = localeData.weekdaysMin();
    const configuredWeekends = (this.plugin.isMobile ? undefined : navigator?.calendarWeekendDays)
      ?? (diary.showWeekends ? "sat-sun" : "none");
    const highlightedWeekends = configuredWeekends === "none" ? "none" : "sat-sun";
    return {
      calendarLocale,
      calendarWeekendDays: highlightedWeekends,
      calendarMonthHeadingFormat: navigator?.calendarMonthHeadingFormat ?? "full",
      calendarHighlightToday: this.plugin.isMobile ? diary.highlightToday : navigator?.calendarHighlightToday ?? diary.highlightToday,
      calendarShowWeekNumber: this.plugin.isMobile ? diary.showWeekNumber : navigator?.calendarShowWeekNumber ?? diary.showWeekNumber,
      calendarShowQuarter: this.plugin.isMobile ? diary.showQuarter : navigator?.calendarShowQuarter ?? diary.showQuarter,
      calendarShowYearCalendar: this.plugin.isMobile ? diary.showYearCalendar : navigator?.calendarShowYearCalendar ?? diary.showYearCalendar,
      locale,
      firstDay,
      weekdayNames: Array.from({ length: 7 }, (_, index) => compactWeekdayName(names[(firstDay + index) % 7])),
      weekendDays: weekendDays(highlightedWeekends),
    };
  }

  private renderLockedDiarySetting(
    container: HTMLElement,
    name: string,
    initialValue: string,
    placeholder: string,
    onSave: (value: string) => Promise<void>
  ): void {
    let editing = false;
    let savedValue = initialValue;
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
        await onSave(value);
        savedValue = value;
        input.value = value;
        setEditing(false);
      } finally {
        editButton.disabled = false;
      }
    };

    new Setting(container)
      .setClass("simple-diary-inline-locked-setting")
      .setName(name)
      .addText((text) => {
        input = text.inputEl;
        text.setValue(initialValue).setPlaceholder(placeholder).setDisabled(true);
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

  private renderHolidayImportReminder(container: HTMLElement): void {
    const today = new Date();
    const diary = this.plugin.settings.diary;
    const setup = diary.dateManagement?.holidaySetupReminder;
    if (!setup?.enabled) return;
    const missing = holidaySetupReminderLinesForDate(diary, today);
    if (!missing.length) return;

    const reminder = container.createDiv({ cls: "simple-diary-import-reminder" });
    reminder.createDiv({ text: missing[0].replace(/^- \[ \]\s*/, "") });
  }

  private renderRecurringPanel(container: HTMLElement): void {
    const panel = container.createDiv({ cls: "simple-diary-recurring-panel" });
    const add = panel.createEl("button", { cls: "mod-cta simple-diary-recurring-add" });
    add.setText("新增");
    add.addEventListener("click", () => {
      new DiaryRecurringRuleModal(this.app, "周期计划编辑", makeRecurringRule(), async (rule) => {
        this.plugin.settings.diary.recurringRules.push(rule);
        await this.plugin.saveSettings();
        this.render();
      }).open();
    });

    const list = panel.createDiv({ cls: "simple-diary-recurring-list" });
    const rules = this.plugin.settings.diary.recurringRules;
    if (rules.length === 0) {
      list.createDiv({ cls: "simple-diary-recurring-empty", text: "还没有周期计划" });
      return;
    }

    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      const row = list.createDiv({ cls: "simple-diary-recurring-row" });
      const toggleWrap = row.createDiv({ cls: "simple-diary-recurring-toggle" });
      new Setting(toggleWrap).addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
          this.render();
        })
      );
      const main = row.createDiv({ cls: "simple-diary-recurring-main" });
      main.createDiv({ cls: "simple-diary-recurring-name", text: rule.text || "未命名周期计划" });
      main.createDiv({ cls: "simple-diary-recurring-summary", text: recurringRuleSummary(rule) });

      const actions = row.createDiv({ cls: "simple-diary-recurring-actions" });
      const edit = actions.createEl("button", { attr: { title: "编辑", "aria-label": "编辑" } });
      setIcon(edit, "pencil");
      edit.addEventListener("click", () => {
        new DiaryRecurringRuleModal(this.app, "周期计划编辑", rule, async (updatedRule) => {
          rules[index] = updatedRule;
          await this.plugin.saveSettings();
          this.render();
        }).open();
      });
    }
  }
}

function renderDateMarkers(container: HTMLElement, settings: DiarySettings, date: Date): void {
  const festival = anniversaryLabelsForDate(settings, date)[0];
  const status = holidayMarkersForDate(settings, date)[0];
  if (!festival && !status) return;
  const labels: string[] = [];
  if (status) {
    const label = status.kind === "调" ? "调休" : "放假";
    container.addClass(status.kind === "调" ? "has-workday" : "has-day-off");
    labels.push(label);
  }
  if (festival) {
    container.addClass("has-reminder");
    container.createSpan({ cls: "simple-diary-reminder-label", text: festival });
    labels.push(festival);
  }
  container.setAttr("title", labels.join("、"));
}

function anniversaryLabelsForDate(settings: DiarySettings, date: Date): string[] {
  const config = settings.dateManagement?.anniversaries;
  if (!config?.enabled || !config.showInCalendar) return [];
  return (settings.anniversaries ?? [])
    .filter((anniversary) => anniversary.enabled && anniversary.showInCalendar !== false && anniversaryMatchesDate(anniversary, date))
    .map((anniversary) => anniversary.name);
}

function anniversaryMatchesDate(anniversary: Anniversary, date: Date): boolean {
  if (anniversary.dateType === "gregorian") {
    return anniversary.month === date.getMonth() + 1 && anniversary.day === date.getDate();
  }
  if (anniversary.dateType === "lunar") {
    const solarDate = lunarAnniversaryDate(anniversary, date.getFullYear());
    return solarDate ? isSameDate(solarDate, date) : false;
  }
  if (anniversary.dateType === "lunar-eve") {
    const solarDate = lunarEveAnniversaryDate(date.getFullYear());
    return solarDate ? isSameDate(solarDate, date) : false;
  }
  if (anniversary.dateType === "solar-term") {
    const solarDate = solarTermAnniversaryDate(anniversary.name, date.getFullYear());
    return solarDate ? isSameDate(solarDate, date) : false;
  }
  if (anniversary.dateType === "weekday-rule" && anniversary.weekdayRule) {
    const rule = anniversary.weekdayRule;
    return rule.month === date.getMonth() + 1
      && rule.weekday === getIsoWeekday(date)
      && rule.nth === getNthWeekdayInMonth(date);
  }
  return false;
}

function lunarAnniversaryDate(anniversary: Anniversary, year: number): Date | null {
  if (!anniversary.lunarMonth || !anniversary.lunarDay) return null;
  try {
    const solar = Lunar.fromYmd(year, anniversary.lunarMonth, anniversary.lunarDay).getSolar();
    return new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay());
  } catch {
    return null;
  }
}

function lunarEveAnniversaryDate(year: number): Date | null {
  try {
    const springFestival = Lunar.fromYmd(year, 1, 1).getSolar();
    return addDays(new Date(springFestival.getYear(), springFestival.getMonth() - 1, springFestival.getDay()), -1);
  } catch {
    return null;
  }
}

function solarTermAnniversaryDate(termName: string, year: number): Date | null {
  try {
    const table = Solar.fromYmd(year, 7, 1).getLunar().getJieQiTable();
    const solar = table[termName];
    return solar ? new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay()) : null;
  } catch {
    return null;
  }
}

function holidayMarkersForDate(settings: DiarySettings, date: Date): Array<{ kind: "假" | "调"; company: boolean }> {
  const state = holidayStateForDate(settings, date);
  if (!state.national && !state.company) return [];
  const nationalKind = state.national ? scheduleStatusKind(state.national.status) : null;
  const companyKind = state.company ? scheduleStatusKind(state.company.status) : null;

  if (state.national && state.company && nationalKind && companyKind) {
    if (nationalKind === companyKind) {
      if (isRedundantWeekendDayOff(state.company, date) && isRedundantWeekendDayOff(state.national, date)) return [];
      return [{ kind: nationalKind, company: false }];
    }
    return [{ kind: companyKind, company: true }];
  }

  const markers: Array<{ kind: "假" | "调"; company: boolean }> = [];
  if (state.national && nationalKind && !isRedundantWeekendDayOff(state.national, date)) {
    markers.push({ kind: nationalKind, company: false });
  }
  if (state.company && companyKind && !isRedundantWeekendDayOff(state.company, date)) {
    markers.push({ kind: companyKind, company: false });
  }
  return markers;
}

function isRedundantWeekendDayOff(item: DayScheduleItem, date: Date): boolean {
  return isWeekend(date) && isDayOffStatus(item.status);
}

function holidayStateForDate(settings: DiarySettings, date: Date): {
  national?: DayScheduleItem;
  company?: DayScheduleItem;
} {
  const dateText = dateKey(date);
  const state: { national?: DayScheduleItem; company?: DayScheduleItem } = {};
  for (const schedule of settings.holidaySchedules ?? []) {
    if (!schedule.enabled) continue;
    if (schedule.source === "national" && (!settings.dateManagement?.nationalHolidays.enabled || !settings.dateManagement.nationalHolidays.showInCalendar)) continue;
    if (schedule.source === "company" && (!settings.dateManagement?.companyHolidays.enabled || !settings.dateManagement.companyHolidays.showInCalendar)) continue;
    const item = schedule.days.find((day) => day.date === dateText);
    if (!item) continue;
    if (schedule.source === "national") state.national = item;
    if (schedule.source === "company") state.company = item;
  }
  return state;
}

function scheduleStatusKind(status: DayScheduleStatus): "假" | "调" | null {
  if (isDayOffStatus(status)) return "假";
  if (isWorkdayStatus(status)) return "调";
  return null;
}

function compactStatusLabel(kind: "假" | "调"): string {
  return kind;
}

function calendarStatusLabel(kind: "假" | "调"): string {
  return kind === "假" ? "放假" : "调休";
}

function isDayOffStatus(status: DayScheduleStatus): boolean {
  return status === "day-off" || status === "company-day-off" || status === "half-day";
}

function isWorkdayStatus(status: DayScheduleStatus): boolean {
  return status === "workday" || status === "adjusted-workday";
}

function dateKey(date: Date): string {
  return formatDate(date, "YYYY-MM-DD");
}

class DiaryRecurringRuleModal extends Modal {
  private draft: RecurringRule;
  private scheduleEl!: HTMLElement;
  private advanceEl!: HTMLElement;

  constructor(
    app: SimplePlugin["app"],
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
    save.addEventListener("click", async () => {
      if (!this.draft.text.trim()) {
        new Notice("请先填写周期计划内容");
        return;
      }
      await this.onSave(cleanRecurringRule(this.draft));
      this.close();
    });
  }

  private renderScheduleControls(): void {
    this.scheduleEl.empty();
    this.scheduleEl.addClass("is-child");
    if (this.draft.type === "weekly") {
      renderWeekdayChips(this.scheduleEl, this.draft.weekdays ?? [1], (days) => {
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
        for (let value = 1; value <= 5; value++) dropdown.addOption(String(value), `第 ${value} 个`);
        dropdown.setValue(String(this.draft.nth ?? 1)).onChange((value) => {
          this.draft.nth = Number(value);
        });
      });
    new Setting(this.scheduleEl)
      .setName("星期几")
      .addDropdown((dropdown) => {
        for (let value = 1; value <= 7; value++) dropdown.addOption(String(value), weekdayLabel(value));
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
}

function renderWeekdayChips(parent: HTMLElement, initialDays: number[], onChange: (days: number[]) => void): void {
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

export async function openDiaryView(plugin: SimplePlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(DIARY_VIEW_TYPE)[0] ?? null;
  if (!leaf) {
    leaf = workspace.getRightLeaf(false);
    if (leaf) await leaf.setViewState({ type: DIARY_VIEW_TYPE, active: true });
  }
  if (leaf) workspace.revealLeaf(leaf);
}

async function openOrCreateDiaryNote(plugin: SimplePlugin, date: Date): Promise<TFile | null> {
  const path = diaryPathForDate(plugin.settings.diary, date);
  const existing = diaryFileForDate(plugin, date);
  if (existing) {
    await plugin.app.workspace.getLeaf().openFile(existing);
    return existing;
  }

  await ensureFolder(plugin, parentPath(path));
  const content = await buildNewDiaryContent(plugin, date);
  const automated = await applyDiaryAutomation(plugin, date, content);
  const file = await plugin.app.vault.create(path, automated.content);
  await plugin.app.workspace.getLeaf().openFile(file);
  const notice = document.createDocumentFragment();
  notice.append(document.createTextNode(`已创建日记：${path}`));
  new Notice(notice);
  return file;
}

async function applyDiaryAutomation(
  plugin: SimplePlugin,
  date: Date,
  content: string
): Promise<DiaryAutomationResult> {
  const dateReminders = insertDateRemindersIntoContent(plugin, date, content);
  const recurring = insertRecurringPlansIntoContent(plugin, date, dateReminders.content);
  const carried = plugin.settings.diary.carryUnfinishedTasks
    ? await carryUnfinishedIntoContent(plugin, date, recurring.content)
    : { content: recurring.content, added: 0, removed: 0 };

  return {
    content: carried.content,
    dateRemindersAdded: dateReminders.added,
    recurringAdded: recurring.added,
    carriedAdded: carried.added,
    carriedRemoved: carried.removed,
  };
}

function hasDiaryAutomationChanges(result: DiaryAutomationResult): boolean {
  return result.dateRemindersAdded > 0
    || result.recurringAdded > 0
    || result.carriedAdded > 0
    || result.carriedRemoved > 0;
}

function diaryAutomationNotice(result: DiaryAutomationResult): string {
  if (!hasDiaryAutomationChanges(result)) return "没有需要同步的内容";
  return `已同步：日期提醒 ${result.dateRemindersAdded} 条，周期计划 ${result.recurringAdded} 条，待办补充 ${result.carriedAdded} 条，清理 ${result.carriedRemoved} 条`;
}

async function buildNewDiaryContent(plugin: SimplePlugin, date: Date): Promise<string> {
  const template = await readTemplate(plugin, plugin.settings.diary.templatePath);
  return applyDiaryTemplate(template || defaultDiaryTemplate(), date);
}

async function readTemplate(plugin: SimplePlugin, path: string): Promise<string> {
  const file = plugin.app.vault.getFileByPath(normalizePath(path));
  if (!file) return "";
  return await plugin.app.vault.read(file);
}

function applyDiaryTemplate(template: string, date: Date): string {
  return template
    .replace(/\{\{date\}\}/g, formatDate(date, "YYYY-MM-DD"))
    .replace(/\{\{title\}\}/g, formatDate(date, "YYYY-MM-DD"));
}

function insertRecurringPlansIntoContent(
  plugin: SimplePlugin,
  date: Date,
  content: string
): { content: string; added: number } {
  const lines = plugin.settings.diary.recurringRules
    .filter((rule) => rule.enabled)
    .flatMap((rule) => recurringLinesForDate(rule, date));
  if (lines.length === 0) return { content, added: 0 };

  const existing = new Set(extractReminderTexts(content));
  const toAdd = lines.filter((line) => !existing.has(normalizeReminderText(line)));
  if (toAdd.length === 0) return { content, added: 0 };

  return {
    content: insertReminderTasksIntoContent(plugin, content, plugin.settings.diary.tipsHeading || "#### 小贴士", toAdd),
    added: toAdd.length,
  };
}

function recurringLinesForDate(rule: RecurringRule, date: Date): string[] {
  const lines: string[] = [];
  if (rule.text.trim() && isRecurringRuleDue(rule, date)) {
    lines.push(formatRecurringLine(rule.text));
  }
  const advanceDays = rule.advanceEnabled ? Math.max(1, rule.advanceDays || 1) : 0;
  const targetDate = advanceDays > 0 ? addWorkdays(date, advanceDays) : null;
  if (targetDate && isRecurringRuleDue(rule, targetDate)) {
    const text = formatAdvanceReminderText(targetDate, rule.text);
    if (text.trim()) lines.push(formatRecurringLine(text));
  }
  return lines;
}

function formatRecurringLine(text: string): string {
  return `- [ ] ${text.trim()}`;
}

function insertDateRemindersIntoContent(
  plugin: SimplePlugin,
  date: Date,
  content: string
): { content: string; added: number } {
  const diary = plugin.settings.diary;
  const lines = [
    ...anniversaryReminderLinesForDate(diary, date),
    ...(diary.dateManagement.holidaySetupReminder.writeToTips ? holidaySetupReminderLinesForDate(diary, date) : []),
  ];
  if (lines.length === 0) return { content, added: 0 };

  const existing = new Set(extractReminderTexts(content));
  const toAdd = lines.filter((line) => !existing.has(normalizeReminderText(line)));
  if (toAdd.length === 0) return { content, added: 0 };

  return {
    content: insertReminderTasksIntoContent(plugin, content, diary.tipsHeading || "#### 小贴士", toAdd),
    added: toAdd.length,
  };
}

function anniversaryReminderLinesForDate(settings: DiarySettings, date: Date): string[] {
  if (!settings.dateManagement?.reminderWriting.enabled) return [];
  const lines: string[] = [];
  for (const anniversary of settings.anniversaries ?? []) {
    if (!anniversary.enabled || !anniversary.reminderEnabled) continue;
    if (anniversaryMatchesDate(anniversary, date)) {
      if (anniversary.sameDayReminderEnabled ?? anniversary.reminderEnabled) {
        lines.push(formatAnniversaryReminderLine(anniversary, sameDayAnniversaryReminderText(anniversary)));
      }
      continue;
    }
    const advanceDays = Math.max(0, anniversary.reminderDaysBefore || 0);
    const targetDate = advanceDays > 0 ? addWorkdays(date, advanceDays, settings) : null;
    if ((anniversary.advanceReminderEnabled ?? false) && targetDate && anniversaryMatchesDate(anniversary, targetDate)) {
      const text = formatAdvanceReminderText(targetDate, anniversary.name);
      lines.push(formatAnniversaryReminderLine(anniversary, text));
    }
  }
  return lines;
}

function formatAnniversaryReminderLine(_anniversary: Anniversary, text: string): string {
  return `- [ ] ${text.trim()}`;
}

function sameDayAnniversaryReminderText(anniversary: Anniversary): string {
  return anniversary.tags?.includes("自定义") ? anniversary.name : `今天是${anniversary.name}`;
}

function formatAdvanceReminderText(targetDate: Date, name: string): string {
  return `**提醒**：${formatMonthDay(targetDate)} ${name.trim()}`;
}

function formatMonthDay(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function holidaySetupReminderLinesForDate(settings: DiarySettings, date: Date): string[] {
  const config = settings.dateManagement;
  const setup = config?.holidaySetupReminder;
  if (!setup?.enabled) return [];
  const hasNationalSource = Boolean(config.nationalHolidays.enabled);
  const hasCompanySource = Boolean(config.companyHolidays.enabled);
  if (!hasNationalSource && !hasCompanySource) return [];

  const lines: string[] = [];
  const currentYear = date.getFullYear();
  const setupMonth = Math.min(12, Math.max(1, setup.month || 12));
  const setupStartDate = new Date(currentYear, setupMonth - 1, 1);
  const daysBefore = Math.max(1, setup.daysBefore || 7);
  const shouldCheckNextYear = addWorkdays(date, daysBefore, settings) >= startOfDay(setupStartDate);
  const years = shouldCheckNextYear ? [currentYear, currentYear + 1] : [currentYear];
  if (hasNationalSource) {
    for (const year of years) {
      if (!hasHolidaySchedule(settings, "national", year)) {
        lines.push(`- [ ] **导入 ${year} 年国家法定节假日安排**`);
      }
    }
  }
  if (hasCompanySource) {
    for (const year of years) {
      if (!hasHolidaySchedule(settings, "company", year)) {
        lines.push(`- [ ] **导入 ${year} 年公司假期安排**`);
      }
    }
  }
  return lines;
}

function hasHolidaySchedule(settings: DiarySettings, source: HolidaySource, year: number): boolean {
  return (settings.holidaySchedules ?? []).some((schedule) =>
    schedule.enabled && schedule.source === source && schedule.year === year && schedule.days.length > 0
  );
}

function hasActiveRecurringRuleOnDate(rules: RecurringRule[], date: Date): boolean {
  return rules.some((rule) => rule.enabled && isRecurringRuleDue(rule, date));
}

function isRecurringRuleDue(rule: RecurringRule, date: Date): boolean {
  if (rule.type === "weekly") {
    return (rule.weekdays ?? []).includes(getIsoWeekday(date));
  }
  if (rule.type === "monthly-date") {
    return (rule.days ?? []).includes(date.getDate());
  }
  if (rule.type === "monthly-weekday") {
    return rule.weekday === getIsoWeekday(date) && rule.nth === getNthWeekdayInMonth(date);
  }
  return false;
}

function extractReminderTexts(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(normalizeReminderText)
    .filter(Boolean);
}

function normalizeReminderText(line: string): string {
  return normalizeTaskText(line).replace(/\*\*/g, "").trim();
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

function appendSummarySuffix(summary: string, suffix: string): string {
  return suffix ? `${summary} · ${suffix}` : summary;
}

function formatWeekdays(days: number[]): string {
  return days.length ? days.map(weekdayLabel).join("、") : "未设置";
}

function weekdayLabel(day: number): string {
  const names = ["一", "二", "三", "四", "五", "六", "日"];
  return `周${names[day - 1] ?? day}`;
}

function cleanRecurringRule(rule: RecurringRule): RecurringRule {
  const base = {
    id: rule.id,
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

function parseNumberList(value: string, min: number, max: number): number[] {
  return normalizeNumberArray(
    value.split(/[,\s，、]+/).filter(Boolean).map((item) => Number(item)),
    min,
    max
  ) ?? [];
}

function insertReminderTasksIntoContent(plugin: SimplePlugin, content: string, headingText: string, tasks: string[]): string {
  if (plugin.settings.diary.reminderTargetMode === "callout") {
    return insertTasksIntoTipsCallout(content, plugin.settings.diary.tipsCallout || "小贴士", tasks);
  }
  return insertTasksIntoTipsSection(content, headingText, tasks);
}

function insertTasksIntoTipsSection(content: string, headingText: string, tasks: string[]): string {
  const lines = content.split(/\r?\n/);
  const headingIndex = ensureTipsHeading(lines, headingText);
  const insertIndex = findSectionAppendIndex(lines, headingIndex);
  lines.splice(insertIndex, 0, ...tasks);
  ensureBlankLineAfterInsertedBlock(lines, insertIndex + tasks.length);
  return lines.join("\n");
}

function insertTasksIntoTipsCallout(content: string, calloutText: string, tasks: string[]): string {
  const lines = content.split(/\r?\n/);
  const calloutIndex = ensureTipsCallout(lines, calloutText);
  const insertIndex = findCalloutAppendIndex(lines, calloutIndex);
  lines.splice(insertIndex, 0, ...tasks.map((task) => `> ${task}`));
  ensureBlankLineAfterInsertedBlock(lines, insertIndex + tasks.length);
  return lines.join("\n");
}

function ensureTipsCallout(lines: string[], calloutText: string): number {
  const type = normalizeCalloutType(calloutText);
  const existingIndex = lines.findIndex((line) => calloutTypeOf(line) === type);
  if (existingIndex >= 0) return existingIndex;

  const beforeIndex = lines.findIndex((line) => {
    const heading = parseHeading(line);
    return heading?.level === 3 && /^(今日工作|今日任务)$/.test(heading.text);
  });
  const insertIndex = beforeIndex >= 0
    ? beforeIndex
    : lines.findIndex((line) => parseHeading(line)?.level === 3);
  const targetIndex = insertIndex >= 0 ? insertIndex : lines.length;
  const additions = [
    ...(targetIndex > 0 && lines[targetIndex - 1]?.trim() !== "" ? [""] : []),
    `> [!${type}]`,
  ];
  lines.splice(targetIndex, 0, ...additions);
  return targetIndex + additions.length - 1;
}

function findCalloutAppendIndex(lines: string[], calloutIndex: number): number {
  let index = calloutIndex + 1;
  while (index < lines.length && (lines[index].trim() === "" || lines[index].startsWith(">"))) index++;
  while (index > calloutIndex + 1 && lines[index - 1]?.trim() === "") {
    lines.splice(index - 1, 1);
    index--;
  }
  return index;
}

function calloutTypeOf(line: string): string | null {
  const match = /^>\s*\[!([^\]\s]+)\]/.exec(line.trim());
  return match ? normalizeCalloutType(match[1]) : null;
}

function normalizeCalloutType(value: string): string {
  return value.trim().replace(/^>\s*/, "").replace(/^\[!/, "").replace(/\].*$/, "").trim() || "小贴士";
}

function ensureTipsHeading(lines: string[], headingText: string): number {
  const targetHeading = parseConfiguredHeading(headingText);
  const existingIndex = findHeadingIndex(lines, targetHeading.level, targetHeading.text, 0, lines.length);
  if (existingIndex >= 0) return existingIndex;

  const beforeIndex = lines.findIndex((line) => {
    const heading = parseHeading(line);
    return heading?.level === 3 && /^(今日工作|今日任务)$/.test(heading.text);
  });
  const insertIndex = beforeIndex >= 0
    ? beforeIndex
    : lines.findIndex((line) => parseHeading(line)?.level === 3);
  const targetIndex = insertIndex >= 0 ? insertIndex : lines.length;
  const headingLine = `${"#".repeat(targetHeading.level)} ${targetHeading.text}`;
  const additions = [
    ...(targetIndex > 0 && lines[targetIndex - 1]?.trim() !== "" ? [""] : []),
    headingLine,
    "",
  ];
  lines.splice(targetIndex, 0, ...additions);
  return targetIndex + additions.indexOf(headingLine);
}

function parseConfiguredHeading(value: string): { level: number; text: string } {
  const heading = parseHeading(value);
  if (heading) return heading;
  return { level: 4, text: value.trim() || "小贴士" };
}

async function ensureFolder(plugin: SimplePlugin, path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (!normalized || plugin.app.vault.getAbstractFileByPath(normalized)) return;
  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

async function carryUnfinishedToActiveDiary(plugin: SimplePlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) {
    new Notice("请先打开一篇日记");
    return;
  }
  const date = dateFromDiaryPath(file.path);
  if (!date) {
    new Notice("当前文件路径不像日记，无法判断日期");
    return;
  }
  const content = await plugin.app.vault.read(file);
  const result = await applyDiaryAutomation(plugin, date, content);
  if (hasDiaryAutomationChanges(result)) await plugin.app.vault.modify(file, result.content);
  new Notice(diaryAutomationNotice(result));
}

async function carryUnfinishedIntoContent(
  plugin: SimplePlugin,
  date: Date,
  content: string
): Promise<{ content: string; added: number; removed: number }> {
  const carryDays = Math.max(1, plugin.settings.diary.carryFromPreviousDays || 1);
  const previousDate = addDays(date, -carryDays);
  const previous = findPreviousDiarySource(plugin, previousDate);
  if (!previous) return { content, added: 0, removed: 0 };

  const previousContent = await plugin.app.vault.read(previous.file);
  const cleaned = removeCompletedCarriedTasks(content, extractCompletedTasks(previousContent));
  const tasks = extractUnfinishedTasks(previousContent);
  if (tasks.length === 0) return { content: cleaned.content, added: 0, removed: cleaned.removed };

  const existing = new Set(extractTaskTexts(cleaned.content));
  const added = tasks.filter((task) => !existing.has(normalizeTaskText(task.line))).length;
  if (added === 0) return { content: cleaned.content, added: 0, removed: cleaned.removed };

  const carriedContent = insertCarriedTasks(cleaned.content, tasks);
  return {
    content: previous.date.getTime() === previousDate.getTime()
      ? carriedContent
      : insertCarryTraceTip(plugin, carriedContent, previous.date),
    added,
    removed: cleaned.removed,
  };
}

function findPreviousDiarySource(plugin: SimplePlugin, date: Date): { file: TFile; date: Date } | null {
  let cursor = startOfDay(date);
  // ponytail: decade scan is enough for this vault; add a setting if older diary backfill matters.
  for (let checked = 0; checked < 3650; checked++) {
    const file = diaryFileForDate(plugin, cursor);
    if (file) return { file, date: cursor };
    cursor = addDays(cursor, -1);
  }
  return null;
}

function insertCarryTraceTip(plugin: SimplePlugin, content: string, sourceDate: Date): string {
  const tip = `- \u5F53\u524D\u7B14\u8BB0\u4EFB\u52A1\u8FFD\u6EAF\u81F3 ${formatDate(sourceDate, "M\u6708D\u65E5")}`;
  if (extractReminderTexts(content).includes(normalizeReminderText(tip))) return content;
  return insertReminderTasksIntoContent(plugin, content, plugin.settings.diary.tipsHeading || "#### \u5C0F\u8D34\u58EB", [tip]);
}

function extractCompletedTasks(content: string): CarriedTask[] {
  const tasks: CarriedTask[] = [];
  let currentH3: string | null = null;
  let currentH4: string | null = null;
  let currentCallout: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    const callout = calloutTypeOf(line);
    if (callout) {
      currentH3 = null;
      currentH4 = null;
      currentCallout = callout;
      continue;
    }
    const heading = parseHeading(line);
    if (heading?.level === 3) {
      currentH3 = heading.text;
      currentH4 = null;
      currentCallout = null;
      continue;
    }
    if (heading?.level === 4) {
      currentH4 = heading.text;
      currentCallout = null;
      continue;
    }
    if (currentH3 && isDiaryNarrativeSection(currentH3)) continue;
    if (line.trim() && !line.trim().startsWith(">")) currentCallout = null;
    const task = parseTaskLine(line, currentH3, currentH4, currentCallout);
    if (task && isCompletedTaskLine(line)) tasks.push(task);
  }

  return tasks;
}

function extractUnfinishedTasks(content: string): CarriedTask[] {
  const tasks: CarriedTask[] = [];
  let currentH3: string | null = null;
  let currentH4: string | null = null;
  let currentCallout: string | null = null;
  let taskStack: CarriedTask[] = [];
  const included = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    const callout = calloutTypeOf(line);
    if (callout) {
      currentH3 = null;
      currentH4 = null;
      currentCallout = callout;
      taskStack = [];
      continue;
    }
    const heading = parseHeading(line);
    if (heading?.level === 3) {
      currentH3 = heading.text;
      currentH4 = null;
      currentCallout = null;
      taskStack = [];
      continue;
    }
    if (heading?.level === 4) {
      currentH4 = heading.text;
      currentCallout = null;
      taskStack = [];
      continue;
    }
    if (currentH3 && isDiaryNarrativeSection(currentH3)) continue;
    if (line.trim() && !line.trim().startsWith(">")) currentCallout = null;
    const task = parseTaskLine(line, currentH3, currentH4, currentCallout);
    if (!task) {
      appendLineToNearestTask(taskStack, line);
      continue;
    }

    while (taskStack.length && taskStack[taskStack.length - 1].indent.length >= task.indent.length) {
      taskStack.pop();
    }
    const parents = [...taskStack];
    taskStack.push(task);

    if (isCompletedTaskLine(line)) continue;
    for (const parent of parents) {
      addCarriedTask(tasks, included, parent);
    }
    addCarriedTask(tasks, included, task);
  }

  return tasks;
}

function isDiaryNarrativeSection(heading: string): boolean {
  return /^(日记小结|日记|小结|复盘)$/.test(heading.trim());
}

const TASK_QUOTE_PREFIX = /^\s*>\s?/;
const ANY_TASK_LINE = /^\s*(?:>\s*)?(?:[-*]|\d+\.)\s+\[[ xX]\]\s+/;
const COMPLETED_TASK_LINE = /^\s*(?:>\s*)?(?:[-*]|\d+\.)\s+\[[xX]\]\s+/;
const UNCHECKED_TASK_LINE = /^\s*(?:>\s*)?(?:[-*]|\d+\.)\s+\[\s\]\s+/;
const TASK_LINE = /^(\s*)(?:>\s*)?(?:[-*]|\d+\.)\s+\[[ xX]\]\s+(.+)$/;
const TASK_PREFIX = /^\s*(?:>\s*)?(?:[-*]|\d+\.)\s+\[[ xX]\]\s+/;

function parseTaskLine(line: string, h3: string | null, h4: string | null, callout: string | null): CarriedTask | null {
  const match = line.match(TASK_LINE);
  if (!match) return null;
  const trimmedLine = line.replace(TASK_QUOTE_PREFIX, "").replace(/\s+$/g, "");
  return {
    line: trimmedLine,
    h3,
    h4,
    callout,
    indent: match[1] ?? "",
    text: match[2].trim(),
    extraLines: [],
  };
}

function isCompletedTaskLine(line: string): boolean {
  return COMPLETED_TASK_LINE.test(line);
}

function addCarriedTask(tasks: CarriedTask[], included: Set<string>, task: CarriedTask): void {
  const key = `${task.callout ?? ""}\n${task.h3 ?? ""}\n${task.h4 ?? ""}\n${normalizeTaskText(task.line)}`;
  if (included.has(key)) return;
  included.add(key);
  tasks.push(task);
}

function removeCompletedCarriedTasks(
  content: string,
  completedTasks: CarriedTask[]
): { content: string; removed: number } {
  if (completedTasks.length === 0) return { content, removed: 0 };
  const lines = content.split(/\r?\n/);
  let removed = 0;

  for (const group of groupCarriedTasks(completedTasks)) {
    const targetIndex = findCarriedTaskTargetIndex(lines, group);
    if (targetIndex < 0) continue;

    for (const task of group.tasks) {
      const taskIndex = findUncheckedTaskLineIndex(lines, task, targetIndex);
      if (taskIndex < 0) continue;
      const end = findTaskSubtreeEnd(lines, taskIndex);
      lines.splice(taskIndex, end - taskIndex);
      removed++;
    }
  }

  return { content: lines.join("\n"), removed };
}

function appendLineToNearestTask(taskStack: CarriedTask[], line: string): void {
  const owner = findOwnerTaskForContinuation(taskStack, line);
  if (!owner || isCompletedTaskLine(owner.line)) return;
  if (line.trim() === "" && owner.extraLines.length === 0) return;
  owner.extraLines.push(line.replace(/\s+$/g, ""));
}

function findOwnerTaskForContinuation(taskStack: CarriedTask[], line: string): CarriedTask | null {
  if (line.trim() === "") {
    for (let index = taskStack.length - 1; index >= 0; index--) {
      if (!isCompletedTaskLine(taskStack[index].line)) return taskStack[index];
    }
    return null;
  }
  const indent = lineIndentLength(line);
  for (let index = taskStack.length - 1; index >= 0; index--) {
    const task = taskStack[index];
    if (isCompletedTaskLine(task.line)) return null;
    if (task.indent.length < indent) return task;
  }
  return null;
}

function extractTaskTexts(content: string): string[] {
  return content
    .split(/\r?\n/)
    .filter((line) => ANY_TASK_LINE.test(line))
    .map(normalizeTaskText);
}

function normalizeTaskText(line: string): string {
  return line
    .replace(TASK_PREFIX, "")
    .trim();
}

function insertCarriedTasks(content: string, tasks: CarriedTask[]): string {
  const lines = content.split(/\r?\n/);

  for (const group of groupCarriedTasks(tasks)) {
    const targetIndex = ensureCarriedTaskTarget(lines, group);
    const isCalloutGroup = Boolean(group.callout);
    let insertIndex = isCalloutGroup ? findCalloutAppendIndex(lines, targetIndex) : findSectionAppendIndex(lines, targetIndex);
    for (const block of groupCarriedTaskBlocks(group.tasks)) {
      const root = block[0];
      if (!root) continue;
      const rootIndex = findTaskLineIndex(lines, root, targetIndex);
      if (rootIndex < 0) {
        const missingLines = block
          .filter((task) => findTaskLineIndex(lines, task, targetIndex) < 0)
          .flatMap((task) => carriedTaskLines(task, isCalloutGroup));
        if (missingLines.length === 0) continue;
        lines.splice(insertIndex, 0, ...missingLines);
        insertIndex += missingLines.length;
        continue;
      }

      for (const task of block.slice(1)) {
        if (findTaskLineIndex(lines, task, targetIndex) >= 0) continue;
        const parent = task.indent.length > 0 ? findNearestCarriedParent(block, task) : null;
        const parentIndex = parent ? findTaskLineIndex(lines, parent, targetIndex) : -1;
        const childInsertIndex = parentIndex >= 0 ? findTaskSubtreeEnd(lines, parentIndex) : findTaskSubtreeEnd(lines, rootIndex);
        lines.splice(childInsertIndex, 0, ...carriedTaskLines(task, isCalloutGroup));
      }
    }
    ensureBlankLineAfterInsertedBlock(lines, insertIndex);
  }

  return lines.join("\n");
}

function groupCarriedTaskBlocks(tasks: CarriedTask[]): CarriedTask[][] {
  const blocks: CarriedTask[][] = [];
  let current: CarriedTask[] | null = null;
  for (const task of tasks) {
    if (!current || task.indent.length === 0) {
      current = [task];
      blocks.push(current);
    } else {
      current.push(task);
    }
  }
  return blocks;
}

function findNearestCarriedParent(tasks: CarriedTask[], task: CarriedTask): CarriedTask | null {
  const index = tasks.indexOf(task);
  for (let i = index - 1; i >= 0; i--) {
    if (tasks[i].indent.length < task.indent.length) return tasks[i];
  }
  return null;
}

function findTaskLineIndex(lines: string[], task: CarriedTask, headingIndex: number): number {
  const heading = parseHeading(lines[headingIndex]);
  const end = findSectionEnd(lines, headingIndex, heading?.level === 4 ? 4 : 3);
  const text = normalizeTaskText(task.line);
  for (let index = headingIndex + 1; index < end; index++) {
    if (!ANY_TASK_LINE.test(lines[index])) continue;
    if (normalizeTaskText(lines[index]) === text) return index;
  }
  return -1;
}

function findTaskSubtreeEnd(lines: string[], taskIndex: number): number {
  const parentIndent = taskIndentLength(lines[taskIndex]);
  for (let index = taskIndex + 1; index < lines.length; index++) {
    const heading = parseHeading(lines[index]);
    if (heading) return index;
    if (ANY_TASK_LINE.test(lines[index]) && taskIndentLength(lines[index]) <= parentIndent) {
      return index;
    }
  }
  return lines.length;
}

function taskIndentLength(line: string): number {
  return lineIndentLength(line);
}

function lineIndentLength(line: string): number {
  return line.match(/^(\s*)/)?.[1].length ?? 0;
}

function groupCarriedTasks(tasks: CarriedTask[]): Array<{ callout: string | null; h3: string | null; h4: string | null; tasks: CarriedTask[] }> {
  const groups: Array<{ callout: string | null; h3: string | null; h4: string | null; tasks: CarriedTask[] }> = [];
  const indexByPath = new Map<string, number>();
  for (const task of tasks) {
    const h3 = task.h3;
    const key = `${task.callout ?? ""}\n${h3}\n${task.h4 ?? ""}`;
    const existingIndex = indexByPath.get(key);
    if (existingIndex !== undefined) {
      groups[existingIndex].tasks.push(task);
      continue;
    }
    indexByPath.set(key, groups.length);
    groups.push({ callout: task.callout, h3, h4: task.h4, tasks: [task] });
  }
  return groups;
}

function ensureCarriedTaskTarget(lines: string[], group: { callout: string | null; h3: string | null; h4: string | null }): number {
  const { callout, h3, h4 } = group;
  if (callout) return ensureTipsCallout(lines, callout);
  if (!h3 && h4) return ensurePreambleHeading(lines, 4, h4);
  const h3Index = ensureHeading(lines, 3, h3 || "今日工作");
  return h4 ? ensureHeading(lines, 4, h4, h3Index) : h3Index;
}

function findCarriedTaskTargetIndex(lines: string[], group: { callout: string | null; h3: string | null; h4: string | null }): number {
  const { callout, h3, h4 } = group;
  if (callout) return lines.findIndex((line) => calloutTypeOf(line) === callout);
  if (!h3 && h4) {
    const firstH3Index = lines.findIndex((line) => parseHeading(line)?.level === 3);
    return findHeadingIndex(lines, 4, h4, 0, firstH3Index >= 0 ? firstH3Index : lines.length);
  }
  const h3Index = findHeadingIndex(lines, 3, h3 || "今日工作", 0, lines.length);
  if (h3Index < 0) return -1;
  return h4
    ? findHeadingIndex(lines, 4, h4, h3Index + 1, findSectionEnd(lines, h3Index, 3))
    : h3Index;
}

function ensurePreambleHeading(lines: string[], level: 4, text: string): number {
  const firstH3Index = lines.findIndex((line) => parseHeading(line)?.level === 3);
  const end = firstH3Index >= 0 ? firstH3Index : lines.length;
  const existingIndex = findHeadingIndex(lines, level, text, 0, end);
  if (existingIndex >= 0) return existingIndex;

  const beforeIndex = lines.findIndex((line) => {
    const heading = parseHeading(line);
    return heading?.level === 3 && /^(今日工作|今日任务)$/.test(heading.text);
  });
  const insertIndex = beforeIndex >= 0 ? beforeIndex : end;
  const additions = [
    ...(insertIndex > 0 && lines[insertIndex - 1]?.trim() !== "" ? [""] : []),
    `${"#".repeat(level)} ${text}`,
  ];
  lines.splice(insertIndex, 0, ...additions);
  return insertIndex + additions.length - 1;
}

function ensureHeading(lines: string[], level: 3 | 4, text: string, parentH3Index?: number): number {
  const start = parentH3Index === undefined ? 0 : parentH3Index + 1;
  const end = parentH3Index === undefined ? lines.length : findSectionEnd(lines, parentH3Index, 3);
  const existingIndex = findHeadingIndex(lines, level, text, start, end);
  if (existingIndex >= 0) return existingIndex;

  if (level === 3) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`### ${text}`);
    return lines.length - 1;
  }

  const insertIndex = end;
  const additions = [
    ...(insertIndex > 0 && lines[insertIndex - 1]?.trim() !== "" ? [""] : []),
    `#### ${text}`,
  ];
  lines.splice(insertIndex, 0, ...additions);
  return insertIndex + additions.length - 1;
}

function findHeadingIndex(lines: string[], level: number, text: string, start: number, end: number): number {
  for (let index = start; index < end; index++) {
    const heading = parseHeading(lines[index]);
    if (heading?.level === level && heading.text === text) return index;
  }
  return -1;
}

function findSectionEnd(lines: string[], headingIndex: number, level: number): number {
  for (let index = headingIndex + 1; index < lines.length; index++) {
    const heading = parseHeading(lines[index]);
    if (heading && heading.level <= level) return index;
  }
  return lines.length;
}

function parseHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

function findSectionAppendIndex(lines: string[], headingIndex: number): number {
  const heading = parseHeading(lines[headingIndex]);
  const level = heading?.level ?? 3;
  let start = headingIndex + 1;
  while (start < lines.length && lines[start].trim() === "") {
    lines.splice(start, 1);
  }
  if (/^\s*[-*]\s+\[\s\]\s*$/.test(lines[start] ?? "")) {
    lines.splice(start, 1);
  }

  let end = findSectionEnd(lines, headingIndex, level);
  // A reminder under an H1/H2 belongs before its nested diary sections.
  if (level < 3) {
    const firstNestedHeading = lines.findIndex((line, index) => index > headingIndex && parseHeading(line) !== null);
    if (firstNestedHeading >= 0) end = Math.min(end, firstNestedHeading);
  }
  while (end > headingIndex + 1 && lines[end - 1]?.trim() === "") {
    lines.splice(end - 1, 1);
    end--;
  }
  return end;
}

function ensureBlankLineAfterInsertedBlock(lines: string[], index: number): void {
  if (index >= lines.length) return;
  if (lines[index]?.trim() === "") return;
  if (parseHeading(lines[index])) {
    lines.splice(index, 0, "");
  }
}

function diaryPathForDate(settings: DiarySettings, date: Date): string {
  const relative = formatDate(date, settings.pathPattern || "YYYY/MM/DD.md");
  return normalizePath(`${settings.folder}/${relative}`);
}

function legacyDiaryPathForDate(settings: DiarySettings, date: Date): string {
  return normalizePath(`${settings.folder}/${formatDate(date, "YYYY/MM/DD.md")}`);
}

function diaryFileForDate(plugin: SimplePlugin, date: Date): TFile | null {
  for (const path of new Set([
    diaryPathForDate(plugin.settings.diary, date),
    legacyDiaryPathForDate(plugin.settings.diary, date),
  ])) {
    const file = plugin.app.vault.getFileByPath(path);
    if (file) return file;
  }
  return null;
}

function formatDate(date: Date, pattern: string): string {
  const parts = getDateParts(date);
  return pattern
    .replace(/WEEKDAY/g, chineseWeekday(date))
    .replace(/YYYY/g, String(parts.year))
    .replace(/MM/g, pad2(parts.month))
    .replace(/M/g, String(parts.month))
    .replace(/DD/g, pad2(parts.day))
    .replace(/D/g, String(parts.day));
}

function chineseWeekday(date: Date): string {
  const names = [
    "\u661F\u671F\u65E5",
    "\u661F\u671F\u4E00",
    "\u661F\u671F\u4E8C",
    "\u661F\u671F\u4E09",
    "\u661F\u671F\u56DB",
    "\u661F\u671F\u4E94",
    "\u661F\u671F\u516D",
  ];
  return names[date.getDay()] ?? "";
}

function defaultDiaryTemplate(): string {
  return "\n### 今日工作\n- [ ] \n\n\n### 跟踪日志\n- [ ] \n\n\n### 长期工作\n- [ ] \n\n\n### 日记小结\n";
}

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function getDateParts(date: Date): DateParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function findUncheckedTaskLineIndex(lines: string[], task: CarriedTask, headingIndex: number): number {
  const heading = parseHeading(lines[headingIndex]);
  const end = findSectionEnd(lines, headingIndex, heading?.level === 4 ? 4 : 3);
  const text = normalizeTaskText(task.line);
  for (let index = headingIndex + 1; index < end; index++) {
    if (!UNCHECKED_TASK_LINE.test(lines[index])) continue;
    if (normalizeTaskText(lines[index]) === text) return index;
  }
  return -1;
}

function carriedTaskLines(task: CarriedTask, quoted = false): string[] {
  const lines = [task.line || "- [ ] ", ...task.extraLines];
  return quoted ? lines.map((line) => `> ${line}`) : lines;
}

function addWorkdays(date: Date, workdays: number, settings?: DiarySettings): Date {
  let remaining = Math.max(0, workdays);
  let current = startOfDay(date);
  while (remaining > 0) {
    current = addDays(current, 1);
    if (isBusinessDay(current, settings)) remaining--;
  }
  return current;
}

function isBusinessDay(date: Date, settings?: DiarySettings): boolean {
  if (!settings || !hasEnabledHolidaySchedules(settings)) {
    return !isWeekend(date);
  }
  const state = holidayStateForDate(settings, date);
  if (state.company) return isWorkdayStatus(state.company.status) || (!isDayOffStatus(state.company.status) && !isWeekend(date));
  if (state.national) return isWorkdayStatus(state.national.status) || (!isDayOffStatus(state.national.status) && !isWeekend(date));
  return !isWeekend(date);
}

function hasEnabledHolidaySchedules(settings: DiarySettings): boolean {
  return (settings.holidaySchedules ?? []).some((schedule) => {
    if (!schedule.enabled || schedule.days.length === 0) return false;
    if (schedule.source === "national") return Boolean(settings.dateManagement?.nationalHolidays.enabled);
    if (schedule.source === "company") return Boolean(settings.dateManagement?.companyHolidays.enabled);
    return true;
  });
}

function isSameDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function buildMonthWeeks(date: Date, firstDay: number): Date[][] {
  const first = startOfMonth(date);
  const startOffset = (first.getDay() - firstDay + 7) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  const weeks: Date[][] = [];
  for (let week = 0; week < 6; week++) {
    const days: Date[] = [];
    for (let day = 0; day < 7; day++) {
      const current = new Date(start);
      current.setDate(start.getDate() + week * 7 + day);
      days.push(current);
    }
    weeks.push(days);
  }
  return weeks;
}

function weekendDays(value: NotebookNavigatorCalendarSettings["calendarWeekendDays"]): Set<number> {
  if (value === "fri-sat") return new Set([5, 6]);
  if (value === "thu-fri") return new Set([4, 5]);
  if (value === "sat-sun") return new Set([6, 0]);
  return new Set();
}

function compactWeekdayName(value: string): string {
  return value.replace(/^周|^星期/, "").replace(/\.$/, "");
}

function getIsoWeekday(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay();
}

function getNthWeekdayInMonth(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

function getQuarter(date: Date): number {
  return Math.floor(date.getMonth() / 3) + 1;
}

function monthName(date: Date, appearance: CalendarAppearance): string {
  return makeMoment(date)
    .locale(appearance.locale)
    .format(appearance.calendarMonthHeadingFormat === "short" ? "MMM" : "MMMM");
}

function dateFromDiaryPath(path: string): Date | null {
  const match = path.match(/(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})(?: [^\/]+)?\.md$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
