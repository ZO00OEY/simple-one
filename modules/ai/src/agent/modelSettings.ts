import { settingsSection, settingsCheckbox } from "../settingsLayout";
import { Notice, Setting, setIcon } from "obsidian";
import { settingsNavigation } from "../settingsNavigation";
import type SimpleAIPlugin from "../main";
import { label } from "../api/types";
import { ExaminerModal } from "./examinerView";
import { roleNames } from "./cooperation";
import type { ModelSelection } from "./types";

export function modelSettings(el: HTMLElement, plugin: SimpleAIPlugin, enter: (page: "memory" | "examiner" | "auxiliary" | "auxiliaryAssessment") => void, page: "overview" | "memory" | "examiner" | "auxiliary" = "overview"): void {
  let saving = false;
  const save = async (update: (draft: typeof plugin.settings) => void, refresh = true) => {
    if (saving) return;
    saving = true;
    try {
      const draft = JSON.parse(JSON.stringify(plugin.settings)) as typeof plugin.settings;
      update(draft);
      plugin.runtime.stopMemory(); plugin.cooperation.stopAutomatic();
      await plugin.update(draft);
    } catch (error) { new Notice(error instanceof Error ? error.message : "保存失败"); }
    finally { saving = false; if (refresh && el.isConnected) { if (page === "memory") enter("memory"); else { el.empty(); modelSettings(el, plugin, enter, page); } } }
  };
  const descriptions = {
    main: "",
    auxiliary: "按需搜索、提炼和起草，笔记写入由主 Agent执行。",
    memory: "",
    examiner: "",
  };
  let modelParent = el;
  if (page === "examiner") {
    el.addClass("simple-ai-examiner-settings");
    modelParent = settingsSection(el, "考官设置", "simple-ai-examiner-section");
    new Setting(modelParent).setName("启用考官模型").setDesc("独立评估模型表现并提出分工建议。")
      .addToggle(t => settingsCheckbox(t).setValue(plugin.settings.agent.cooperation.examiner.enabled).onChange(value => { void save(draft => { draft.agent.cooperation.examiner.enabled = value; }); }));
  }
  const roles = page === "examiner" ? ["examiner"] as const : page === "memory" ? ["memory"] as const : page === "auxiliary" ? ["auxiliary"] as const : ["main"] as const;
  for (const role of roles) {
    const cfg = role === "main" ? { selected: plugin.settings.selected, follow: "main" as const, enabled: true }
      : role === "memory" ? plugin.settings.agent.memory : plugin.settings.agent.cooperation[role];
    const selectToEnable = role === "auxiliary";
    const source = plugin.settings.sources.find(s => s.id === cfg.selected?.sourceId), model = source?.models.find(m => m.id === cfg.selected?.modelId);
    const name = role === "main" ? "默认模型" : roleNames[role];
    const setting = new Setting(modelParent).setName(name);
    if (descriptions[role]) setting.setDesc(descriptions[role]);
    setting.settingEl.addClass("simple-ai-role-setting");
    const picker = setting.controlEl.createEl("details", { cls: "simple-ai-role-picker" });
    const summary = picker.createEl("summary");
    const title = selectToEnable && !cfg.enabled ? "不启用"
      : cfg.selected ? source && model ? label(source, model, plugin.settings.showSourceName) : "所选模型不可用"
      : role === "main" ? "选择模型" : cfg.follow === "auxiliary" ? role !== "memory" && plugin.settings.agent.cooperation.auxiliary.candidates.length !== 1 ? "请重新选择模型" : "跟随子 Agent" : "跟随主 Agent";
    if (role === "memory" && !cfg.selected && cfg.follow === "auxiliary") setting.setDesc("辅助未启用或未设置时使用主 Agent；多个子 Agent时使用第一个。");
    summary.createSpan({ text: title }); summary.setAttribute("aria-label", `${name}：${title}`);
    setIcon(summary.createSpan("simple-ai-role-chevron"), "chevron-down");
    const panel = picker.createDiv("simple-ai-role-options");
    const search = panel.createEl("input", { type: "search", attr: { placeholder: "搜索来源或模型", "aria-label": `搜索${roleNames[role]}` } });
    const list = panel.createDiv("simple-ai-role-list");
    const choose = (selected: ModelSelection, follow?: "main" | "auxiliary", disabled = false) => {
      if (plugin.runtime.busy || plugin.runtime.memoryBusy || plugin.cooperation.busy) { new Notice("请等待当前模型任务结束后切换。"); return; }
      picker.open = false;
      void save(draft => {
        if (role === "main") draft.selected = selected;
        else if (role === "auxiliary") { draft.agent.cooperation.auxiliary.selected = selected; draft.agent.cooperation.auxiliary.follow = "main"; draft.agent.cooperation.auxiliary.enabled = !disabled; }
        else { const target = role === "memory" ? draft.agent.memory : draft.agent.cooperation[role]; target.selected = selected; target.follow = follow; }
      });
    };
    const render = () => {
      list.empty(); const query = search.value.trim().toLowerCase(); let matches = 0;
      const option = (parent: HTMLElement, text: string, active: boolean, action: () => void) => {
        const button = parent.createEl("button", { text, cls: "simple-ai-role-option", attr: { type: "button", "aria-pressed": String(active) } });
        button.onclick = action;
      };
      if (selectToEnable && "不启用".includes(query)) {
        matches++; option(list, "不启用", !cfg.enabled, () => choose(null, undefined, true));
      }
      for (const follow of role === "main" ? [] : role === "auxiliary" ? ["main"] as const : ["main", "auxiliary"] as const) {
        if (role !== "memory" && follow === "auxiliary" && plugin.settings.agent.cooperation.auxiliary.mode === "multiple") continue;
        const name = follow === "main" ? "跟随主 Agent" : "跟随子 Agent";
        if (name.toLowerCase().includes(query)) { matches++; option(list, name, !cfg.selected && (cfg.follow ?? "main") === follow && (!selectToEnable || cfg.enabled), () => choose(null, follow)); }
      }
      for (const source of plugin.settings.sources) {
        const models = source.models.filter(m => `${source.name} ${m.id} ${m.alias}`.toLowerCase().includes(query));
        if (!models.length) continue;
        matches += models.length;
        const group = list.createEl("details", { cls: "simple-ai-role-source" }); group.open = true;
        group.createEl("summary", { text: source.name });
        for (const model of models) option(group, model.alias.trim() || model.id, cfg.selected?.sourceId === source.id && cfg.selected?.modelId === model.id && (!selectToEnable || cfg.enabled), () => choose({ sourceId: source.id, modelId: model.id }));
      }
      if (!matches) list.createEl("p", { text: "没有匹配的模型", cls: "simple-ai-hint" });
    };
    search.oninput = render; render();
    picker.addEventListener("keydown", event => { if (event.key === "Escape" && picker.open) { event.preventDefault(); event.stopPropagation(); picker.open = false; summary.focus(); } });
    picker.addEventListener("toggle", () => {
      if (!picker.open) return;
      for (const other of Array.from(el.querySelectorAll<HTMLDetailsElement>(".simple-ai-role-picker"))) if (other !== picker) other.open = false;
      search.focus();
    });
    if (role === "main") setting.addButton(b => {
      b.setIcon("zap").setTooltip("测试工具调用（会产生少量 API 用量）").setDisabled(!source || !model);
      b.buttonEl.addClass("simple-ai-model-test"); b.buttonEl.setAttribute("aria-label", "测试默认模型的工具调用");
      b.onClick(async () => {
        if (!source || !model) { new Notice("请先选择模型。"); return; }
        b.setDisabled(true);
        try { new Notice(await plugin.client.testTools(source, plugin.getRequestKey(source.id), model.id), 10000); }
        catch (error) { new Notice(error instanceof Error ? error.message : "测试失败。", 10000); }
        finally { b.setDisabled(false); }
      });
    });
  }
  if (page !== "examiner") return;
  const examiner = plugin.settings.agent.cooperation.examiner;
  new Setting(modelParent).setName("闲时自动验收").setDesc("仅在前台空闲时运行，恢复操作即暂停。")
    .addToggle(t => settingsCheckbox(t).setValue(examiner.automatic).onChange(v => { void save(d => { d.agent.cooperation.examiner.automatic = v; }, false); }));
  const management = settingsSection(el, "验收管理", "simple-ai-examiner-section");
  new Setting(management).setName("考官工作台").setDesc("查看评估结果与模型分工建议。")
    .addButton(b => b.setButtonText("打开工作台").onClick(() => new ExaminerModal(plugin).open()));
  settingsNavigation(new Setting(management).setName("考核子 Agent工作成果").setDesc("结合聊天记录和委派要求，分别评价辅助成果与主 Agent后续处理。"), () => enter("auxiliaryAssessment"));
  const options = settingsSection(el, "高级自定义", "simple-ai-examiner-section");
  options.createEl("p", { cls: "simple-ai-hint", text: "通常保留默认值即可。" });
  const number = (name: string, value: number, min: number, max: number, apply: (draft: typeof plugin.settings, n: number) => void) => new Setting(options).setName(name).addText(t => {
    t.setValue(String(value)); t.inputEl.addEventListener("change", () => {
      const n = Number(t.getValue()); if (Number.isInteger(n) && n >= min && n <= max) void save(d => apply(d, n), false);
      else { t.setValue(String(value)); new Notice(`请输入 ${min}–${max} 之间的整数。`); }
    });
  });
  for (const [key, name, min, max] of [["quietMinutes", "停止操作后延迟（分钟）", 1, 120], ["idleHours", "任务闲置小时数", 1, 168], ["dailyRequests", "每日最多考官请求（含手动）", 1, 100], ["gapSeconds", "自动请求间隔（秒）", 30, 3600]] as const) number(name, examiner[key], min, max, (d, n) => { d.agent.cooperation.examiner[key] = n; });
}
