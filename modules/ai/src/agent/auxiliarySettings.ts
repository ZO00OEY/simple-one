import { Setting } from "../ui";
import { Modal, Notice, setIcon } from "obsidian";
import { childPolicy } from "./workPolicies";
import { setNativeTooltip } from "../tooltipText";
import type SimpleAIPlugin from "../main";
import { type CooperationSettings } from "./types";

export function auxiliarySettings(el: HTMLElement, plugin: SimpleAIPlugin, refresh: () => void): void {
  let pending = Promise.resolve();
  const save = (update: (draft: CooperationSettings["auxiliary"]) => void, redraw = false) => {
    pending = pending.then(async () => {
      if (plugin.runtime.busy || plugin.runtime.memoryBusy || plugin.cooperation.busy) throw new Error("请等待当前模型任务结束后调整子 Agent 配置。");
      const draft = JSON.parse(JSON.stringify(plugin.settings)) as typeof plugin.settings;
      update(draft.agent.cooperation.auxiliary);
      await plugin.update(draft);
      if (redraw && el.isConnected) refresh();
    }).catch(error => { new Notice(error instanceof Error ? error.message : "保存失败"); if (el.isConnected) refresh(); });
    return pending;
  };
  new Setting(el).setName("通用提示词").setDesc("所有子 Agent 共用的行为要求。编辑时可查看内置规则并补充指令；模型各自擅长的任务由用途说明提供。")
    .addButton(button => button.setButtonText("编辑").onClick(() => {
      const modal = new Modal(plugin.app);
      modal.modalEl.addClass("simple-ai-candidate-editor");
      modal.titleEl.setText("子 Agent 通用提示词");
      const rules = modal.contentEl.createEl("details", { cls: "simple-ai-child-rules" });
      rules.createEl("summary", { text: "内置规则（只读）" });
      rules.createEl("p", { text: childPolicy });
      const input = modal.contentEl.createEl("textarea", { attr: { placeholder: "补充指令，例如：输出简洁，引用资料路径，明确标注不确定信息。留空使用内置规则。", "aria-label": "通用提示词补充指令" } });
      input.value = plugin.settings.agent.cooperation.auxiliary.supplementalInstructions ?? "";
      new Setting(modal.contentEl)
        .addButton(button => button.setButtonText("取消").onClick(() => modal.close()))
        .addButton(button => button.setButtonText("保存").setCta().onClick(async () => {
          button.setDisabled(true);
          const value = input.value.trim();
          await save(draft => { draft.supplementalInstructions = value; });
          if (plugin.settings.agent.cooperation.auxiliary.supplementalInstructions === value) { modal.close(); if (el.isConnected) refresh(); }
          else button.setDisabled(false);
        }));
      modal.open(); input.focus();
    }));
  {
    const selection = new Setting(el).setName("子 Agent 可用模型").setDesc("勾选可委派任务的模型，可与主 Agent 相同。悬停模型名查看用途说明；用途说明由你编辑；考官实测附注单独显示，带样本数与日期，不改手写说明。")
      .setClass("simple-ai-auxiliary-selection");
    const picker = selection.controlEl.createEl("details", { cls: "simple-ai-role-picker" });
    const summary = picker.createEl("summary");
    const count = summary.createSpan();
    setIcon(summary.createSpan("simple-ai-role-chevron"), "chevron-down");
    const panel = picker.createDiv("simple-ai-role-options");
    const search = panel.createEl("input", { type: "search", attr: { placeholder: "搜索来源或模型", "aria-label": "搜索子 agent 候选模型" } });
    const list = panel.createDiv("simple-ai-role-list");
    const cards = el.createDiv("simple-ai-auxiliary-candidates");
    const renderCards = () => {
      const candidates = plugin.settings.agent.cooperation.auxiliary.candidates ?? [];
      count.setText(`已选择 ${candidates.length} 个模型`);
      cards.empty();
      for (const candidate of candidates) {
        const source = plugin.settings.sources.find(s => s.id === candidate.sourceId);
        const model = source?.models.find(m => m.id === candidate.modelId);
        const name = `[${source?.name ?? "来源已删除"}] ${model?.alias.trim() || candidate.modelId}${model ? "" : "（不可用）"}`;
        const row = new Setting(cards).setName(name);
        row.settingEl.addClass("simple-ai-auxiliary-row");
        const change = (update: (item: typeof candidate) => void) => save(draft => {
          const item = draft.candidates.find(c => c.sourceId === candidate.sourceId && c.modelId === candidate.modelId);
          if (item) update(item);
        });
        setNativeTooltip(row.nameEl, name + "\n用途：" + (candidate.description || "暂无手写用途说明。"));
        row.setDesc("考官实测附注：" + (plugin.cooperation.observedNote?.(candidate.sourceId, candidate.modelId) ?? "样本不足：n=0"));
        row.addExtraButton(button => button.setIcon("pencil").setTooltip("编辑模型用途说明").onClick(() => {
          const modal = new Modal(plugin.app);
          modal.modalEl.addClass("simple-ai-candidate-editor");
          modal.titleEl.setText("编辑模型用途说明");
          modal.contentEl.createEl("p", { cls: "simple-ai-hint", text: name });
          const input = modal.contentEl.createEl("textarea", { attr: { placeholder: "说明适合的任务、能力特点和限制…", "aria-label": "模型用途说明" } });
          input.value = candidate.description;
          new Setting(modal.contentEl)
            .addButton(button => button.setButtonText("取消").onClick(() => modal.close()))
            .addButton(button => button.setButtonText("保存").setCta().onClick(async () => {
              button.setDisabled(true);
              const value = input.value.trim();
              await change(item => { item.description = value; });
              const current = plugin.settings.agent.cooperation.auxiliary.candidates.find(c => c.sourceId === candidate.sourceId && c.modelId === candidate.modelId);
              if (current?.description === value) { modal.close(); if (el.isConnected) { renderCards(); renderList(); } }
              else button.setDisabled(false);
            }));
          modal.open();
          input.focus();
        }));
      }
    };
    const renderList = () => {
      list.empty();
      const query = search.value.trim().toLowerCase();
      for (const source of plugin.settings.sources) {
        const models = source.models.filter(m => `${source.name} ${m.id} ${m.alias}`.toLowerCase().includes(query));
        if (!models.length) continue;
        const group = list.createEl("details", { cls: "simple-ai-role-source" }); group.open = true;
        group.createEl("summary", { text: source.name });
        for (const model of models) {
          const row = group.createEl("label", { cls: "simple-ai-auxiliary-option" });
          const checkbox = row.createEl("input", { type: "checkbox" });
          checkbox.checked = (plugin.settings.agent.cooperation.auxiliary.candidates ?? []).some(c => c.sourceId === source.id && c.modelId === model.id);
          const name = row.createSpan({ text: model.alias.trim() || model.id });
          const candidate = plugin.settings.agent.cooperation.auxiliary.candidates.find(c => c.sourceId === source.id && c.modelId === model.id);
          setNativeTooltip(name, (model.alias.trim() || model.id) + "\n" + (candidate?.description || "暂无用途说明；选择后可编辑；考官附注独立保存。"));
          checkbox.onchange = async () => {
            const checked = checkbox.checked; checkbox.disabled = true;
            await save(draft => {
              draft.candidates ??= [];
              draft.candidates = draft.candidates.filter(c => c.sourceId !== source.id || c.modelId !== model.id);
              if (checked) draft.candidates.push({ sourceId: source.id, modelId: model.id, description: "" });
            });
            checkbox.disabled = false; renderCards();
          };
        }
      }
      if (!list.children.length) list.createEl("p", { cls: "simple-ai-hint", text: "没有匹配的模型" });
    };
    search.oninput = renderList;
    picker.addEventListener("toggle", () => { if (picker.open) search.focus(); });
    picker.addEventListener("keydown", event => { if (event.key === "Escape") { picker.open = false; summary.focus(); } });
    renderList(); renderCards();
  }
}
