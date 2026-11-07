import { Setting } from "obsidian";
import type { RecurringRule } from "../types";
import { nativeCheckbox } from "./nativeCheckbox";

/** Both reminder entry points edit the same fields; each modal owns its actions. */
export function renderRecurringRuleForm(contentEl: HTMLElement, draft: RecurringRule): void {
  new Setting(contentEl)
    .setName("周期计划内容")
    .setDesc("写入日记小贴士里的内容。")
    .addText((text) =>
      text
        .setPlaceholder("例如：整理本周工作记录")
        .setValue(draft.text)
        .onChange((value) => {
          draft.text = value;
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
        .setValue(draft.type)
        .onChange((value) => {
          draft.type = value as RecurringRule["type"];
          renderScheduleControls();
        })
    );

  const scheduleEl = contentEl.createDiv({ cls: "simple-recurring-schedule" });
  renderScheduleControls();

  new Setting(contentEl)
    .setClass("simple-recurring-advance-toggle")
    .setName("提前提醒")
    .setDesc("在事件发生前若干天，提前写入一条预告。")
    .addToggle((toggle) =>
      nativeCheckbox(toggle).setValue(Boolean(draft.advanceEnabled)).onChange((value) => {
        draft.advanceEnabled = value;
        if (value && !draft.advanceDays) draft.advanceDays = 3;
        renderAdvanceControls();
      })
    );
  const advanceEl = contentEl.createDiv({ cls: "simple-recurring-advance" });
  renderAdvanceControls();

  function renderScheduleControls(): void {
    scheduleEl.empty();
    scheduleEl.addClass("is-child");
    if (draft.type === "weekly") {
      renderWeekdayChips(scheduleEl, draft.weekdays ?? [1], (days) => {
        draft.weekdays = days;
      });
      return;
    }

    if (draft.type === "monthly-date") {
      new Setting(scheduleEl)
        .setName("每月日期")
        .setDesc("可以写多个日期，用逗号分隔。")
        .addText((text) =>
          text
            .setPlaceholder("例如：1, 15, 28")
            .setValue((draft.days ?? []).join(", "))
            .onChange((value) => {
              draft.days = parseNumberList(value, 1, 31);
            })
        );
      return;
    }

    new Setting(scheduleEl)
      .setName("第几个")
      .setDesc("定位到每月第几个星期几。")
      .addDropdown((dropdown) => {
        for (let value = 1; value <= 5; value++) {
          dropdown.addOption(String(value), `第 ${value} 个`);
        }
        dropdown.setValue(String(draft.nth ?? 1)).onChange((value) => {
          draft.nth = Number(value);
        });
      });
    new Setting(scheduleEl)
      .setName("星期几")
      .addDropdown((dropdown) => {
        for (let value = 1; value <= 7; value++) {
          dropdown.addOption(String(value), weekdayLabel(value));
        }
        dropdown.setValue(String(draft.weekday ?? 1)).onChange((value) => {
          draft.weekday = Number(value);
        });
      });
  }

  function renderAdvanceControls(): void {
    advanceEl.empty();
    if (!draft.advanceEnabled) return;

    new Setting(advanceEl)
      .setName("提前工作日")
      .setDesc("例如填 3，就是在事件前 3 个工作日写入待办。")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(draft.advanceDays ?? 3))
          .onChange((value) => {
            const parsed = Number(value);
            draft.advanceDays = Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
          })
      );
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

