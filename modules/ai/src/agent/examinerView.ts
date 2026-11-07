import { ButtonComponent, Setting } from "../ui";
import { Component, MarkdownRenderer, Modal, Notice } from "obsidian";
import type SimpleAIPlugin from "../main";
import { roleNames, type Assessment, type Recommendation, type WorkRecord } from "./cooperation";
import { usageText } from "./usage";

export function auxiliaryAssessmentPage(el: HTMLElement, plugin: SimpleAIPlugin): () => void {
  const page = new ExaminerModal(plugin, "records", el); page.onOpen();
  return () => page.onClose();
}
export class ExaminerModal extends Modal {
  private tab: "overview" | "models" | "records" | "discussion" = "overview";
  private loading = false;
  private draft = "";
  private owner?: Component;
  private closed = false;
  private fullscreen = false;
  constructor(private plugin: SimpleAIPlugin, tab: "overview" | "models" | "records" | "discussion" = "overview", private embedded?: HTMLElement) { super(plugin.app); this.tab = tab; }
  private get target(): HTMLElement { return this.embedded ?? this.contentEl; }
  onOpen(): void {
    this.closed = false;
    if (this.embedded) { this.render(); return; }
    this.modalEl.addClass("simple-ai-config-modal", "simple-ai-examiner");
    this.containerEl.addClass("simple-ai-examiner-container");
    this.titleEl.empty();
    this.titleEl.createSpan({ text: "考官工作台" });
    const expand = new ButtonComponent(this.titleEl).setIcon("maximize").setTooltip("放大到全屏").onClick(() => {
      this.fullscreen = !this.fullscreen;
      this.modalEl.toggleClass("is-fullscreen", this.fullscreen);
      expand.setIcon(this.fullscreen ? "minimize" : "maximize").setTooltip(this.fullscreen ? "还原窗口" : "放大到全屏");
      expand.buttonEl.setAttribute("aria-pressed", String(this.fullscreen));
    });
    expand.buttonEl.addClass("simple-ai-examiner-expand");
    expand.buttonEl.setAttribute("aria-pressed", "false");
    this.render();
  }
  onClose(): void { this.closed = true; this.containerEl.removeClass("simple-ai-examiner-container"); this.owner?.unload(); if (this.loading) this.plugin.cooperation.stop(); }
  private async perform(action: () => Promise<unknown>): Promise<void> {
    if (this.loading) return; this.loading = true; this.render();
    try { await action(); } catch (error) { new Notice(error instanceof Error ? error.message : "考官操作失败"); }
    finally { this.loading = false; if (!this.closed) this.render(); }
  }
  private markdown(el: HTMLElement, text: string): void { void MarkdownRenderer.render(this.app, text, el, "", this.owner!).catch(() => el.setText(text)); }
  private render(): void {
    this.owner?.unload(); this.owner = new Component(); this.owner.load(); this.target.empty();
    const tabs = this.embedded ? createDiv() : this.target.createDiv("simple-ai-examiner-tabs");
    for (const [tab, label] of [["overview", "总览"], ["models", "模型档案"], ["records", "验收记录"], ["discussion", "与考官讨论"]] as const) new ButtonComponent(tabs).setButtonText(label).onClick(() => { this.tab = tab; this.render(); }).buttonEl.setAttribute("aria-pressed", String(this.tab === tab));
    const service = this.plugin.cooperation, state = service.state;
    if (this.loading) new Setting(this.target).setName("考官正在处理…").addButton(b => b.setButtonText("暂停").onClick(() => service.stop()));
    if (!service.config.examiner.enabled) this.target.createEl("p", { text: "请在模型管理中启用考官模型。已有记录仍可查看。", cls: "simple-ai-hint" });
    if (this.tab === "overview") {
      this.target.createEl("p", { text: `${state.records.filter(r => r.role !== "examiner").length} 条请求记录 · ${state.assessments.length} 份验收 · ${state.assessments.filter(a => a.questions.length && !a.feedback).length} 份待反馈` });
      this.target.createEl("p", { text: "保留最近200条模型请求和200份验收。原始资料按大小限额保留，截断会注明；旧会话未记录模型时不反推归属。评价是建议，不能代替用户判断。", cls: "simple-ai-hint" });
      if (state.lastError) this.target.createEl("p", { text: state.lastError, cls: "simple-ai-hint" });
      for (const a of state.assessments.slice(-8).reverse()) this.assessment(a, false);
      if (!state.assessments.length) this.target.createEl("p", { text: "先在验收记录中选择已完成任务，或与考官讨论模型分工。" });
      new ButtonComponent(this.target).setButtonText("讨论整体分工建议").setDisabled(this.loading).onClick(() => { this.tab = "discussion"; this.draft = "请根据已有验收及用户反馈，总结各模型适合的任务、问题和分工建议；明确样本不足。"; this.render(); });
    } else if (this.tab === "models") {
      const groups = new Map<string, { actor: Pick<WorkRecord, "sourceId" | "sourceName" | "modelId" | "role">; records: WorkRecord[] }>();
      for (const r of state.records.filter(r => r.role !== "examiner")) { const key = JSON.stringify([r.sourceId, r.modelId, r.role]); const group = groups.get(key) ?? { actor: r, records: [] }; group.records.push(r); groups.set(key, group); }
      for (const a of state.assessments) for (const f of a.findings) if (f.actor) { const key = JSON.stringify([f.actor.sourceId, f.actor.modelId, f.actor.role]); if (!groups.has(key)) groups.set(key, { actor: f.actor, records: [] }); }
      for (const { actor: first, records } of groups.values()) {
        const details = this.target.createEl("details", { cls: "simple-ai-examiner-card" });
        details.createEl("summary", { text: `[${first.sourceName}] ${first.modelId} · ${(roleNames[first.role] ?? "历史角色（已停用）")}` });
        const finished = records.filter(r => r.ended), elapsed = finished.reduce((sum, r) => sum + r.ended! - r.started, 0);
        details.createEl("p", { text: `${records.length} 次请求 · ${records.filter(r => r.state === "done").length} 次接口返回成功 · 平均 ${finished.length ? Math.round(elapsed / finished.length / 1000) : 0} 秒（含失败；接口成功不代表任务完成）` });
        for (const a of state.assessments) for (const f of a.findings.filter(f => f.actor ? f.actor.sourceId === first.sourceId && f.actor.modelId === first.modelId && f.actor.role === first.role : records.some(r => r.id === f.recordId))) {
          this.markdown(details.createDiv(), `**${a.taskType ?? "任务"} · ${f.assessment}**\n\n${f.reason}\n\n判断把握：${f.confidence}`);
          if (a.feedback) details.createEl("p", { text: "用户反馈：" + a.feedback.satisfaction + " · " + a.feedback.reason });
        }
      }
      if (!groups.size) this.target.createEl("p", { text: "暂无可归属的模型记录。新任务完成后会出现档案。" });
    } else if (this.tab === "records") {
      const tasks = service.taskIds();
      for (const taskId of tasks) {
        const records = service.taskRecords(taskId), first = records[0];
        if (!first) continue;
        if (this.embedded && !records.some(r => r.role === "auxiliary")) continue;
        const session = this.plugin.runtime.state.sessions.find(s => s.id === first.sessionId);
        const matches = state.assessments.filter(a => a.taskId === taskId), a = matches[matches.length - 1];
        new Setting(this.target).setName((session?.archived ? "[归档] " : "") + (session?.title ?? first.stage)).setDesc(`${new Date(first.started).toLocaleString()} · ${records.length} 次模型请求${a ? " · 已验收" : ""}`)
          .addButton(b => b.setButtonText("资料").onClick(() => this.evidence(records)))
          .addButton(b => b.setButtonText(a ? "重新验收" : "验收").setDisabled(this.loading || records.some(r => r.state === "running")).onClick(() => { void this.perform(() => service.evaluate(taskId)); }))
          .addButton(b => b.setButtonText("考核辅助成果").setDisabled(this.loading || !records.some(r => r.role === "auxiliary") || records.some(r => r.state === "running")).onClick(() => { void this.perform(() => service.evaluate(taskId)); }));
      }
      for (const a of state.assessments.slice().reverse()) if (!this.embedded || service.taskRecords(a.taskId).some(r => r.role === "auxiliary") || a.findings.some(f => f.actor?.role === "auxiliary")) this.assessment(a, true);
      const legacy = this.plugin.runtime.state.sessions.filter(s => s.messages.length && !s.messages.some(m => m.execution) && !state.records.some(r => r.sessionId === s.id));
      if (this.embedded && !tasks.some(taskId => service.taskRecords(taskId).some(r => r.role === "auxiliary"))) this.target.createEl("p", { text: "暂无辅助工作记录。完成一次辅助任务后，可在这里考核成果。", cls: "simple-ai-hint" });
      if (legacy.length && !this.embedded) {
        this.target.createEl("h4", { text: "未记录模型的旧会话" });
        for (const s of legacy) new Setting(this.target).setName((s.archived ? "[归档] " : "") + s.title).setDesc("归属未知，可阅读和讨论，不计入某模型的实测评价。")
          .addButton(b => b.setButtonText("阅读").onClick(() => { const modal = new Modal(this.app); modal.titleEl.setText(s.title); const pre = modal.contentEl.createEl("pre", { cls: "simple-ai-examiner-evidence" }); pre.setText(s.messages.map(m => `${m.role}：${m.text}`).join("\n\n")); modal.open(); }));
      }
    } else {
      const log = this.target.createDiv("simple-ai-examiner-log");
      for (const m of state.discussion.filter(m => m.role !== "tool" && m.text.trim())) { const card = log.createDiv("simple-ai-examiner-card"); card.createDiv({ text: m.role === "user" ? "你" : "考官", cls: "simple-ai-hint" }); this.markdown(card.createDiv(), m.text); }
      const input = this.target.createEl("textarea", { cls: "simple-ai-config-text", attr: { placeholder: "询问模型分工、验收结论或记忆模型建议…", "aria-label": "与考官讨论" } }); input.value = this.draft; input.oninput = () => { this.draft = input.value; };
      new ButtonComponent(this.target).setButtonText("发送给考官").setCta().setDisabled(this.loading || !service.config.examiner.enabled).onClick(() => { const text = this.draft; if (!text.trim()) return; void this.perform(async () => { await service.discuss(text); this.draft = ""; }); });
    }
  }
  private evidence(records: WorkRecord[]): void {
    const modal = new Modal(this.app); modal.modalEl.addClass("simple-ai-config-modal"); modal.titleEl.setText("验收依据");
    const data = this.plugin.cooperation.evaluationEvidence(records[0].taskId);
    modal.contentEl.createEl("p", { text: `${data.records.length} 次请求 · 已自动过滤文件原文和重复信息`, cls: "simple-ai-hint" });
    for (const record of data.records) {
      const actor = data.actors[record.actor];
      const state = { done: "请求成功", running: "执行中", failed: "请求失败", interrupted: "请求已中断" }[record.state];
      const item = modal.contentEl.createEl("details");
      item.createEl("summary", { text: `${record.stage} · ${state} · ${roleNames[actor.role] ?? "历史角色（已停用）"} · [${actor.sourceName}] ${actor.modelId}` });
      item.createEl("p", { text: `${record.elapsedMs === undefined ? "耗时未记录" : (record.elapsedMs / 1000).toFixed(1) + " 秒"} · ${usageText(record.usage)}`, cls: "simple-ai-hint" });
      if (record.error) item.createEl("p", { text: record.error, cls: "simple-ai-memory-result is-error" });
      if (record.delegation?.text) item.createEl("pre", { text: "委派要求：" + record.delegation.text });
      if (record.reply) item.createEl("pre", { text: (record.reply as { text?: string }).text ?? "" });
    }
    for (const message of data.transcript) {
      const item = modal.contentEl.createEl("details");
      item.createEl("summary", { text: message.role === "user" ? "用户要求" : message.process ? "辅助工作" : message.role === "assistant" ? "主 Agent回复" : "工具反馈" });
      if (message.text) item.createEl("pre", { text: message.text });
      if (message.calls?.length) item.createEl("pre", { text: message.calls.map(c => c.name === "delegate_task" ? "委派要求：" + c.arguments.task : c.name + " " + JSON.stringify(c.arguments)).join("\n") });
    }
    const wire = modal.contentEl.createEl("details"); wire.createEl("summary", { text: "查看发送给考官的数据" });
    wire.createEl("pre", { text: JSON.stringify(data, null, 2), cls: "simple-ai-examiner-evidence" });
    modal.open();
  }
  private assessment(a: Assessment, full: boolean): void {
    const details = this.target.createEl("details", { cls: "simple-ai-examiner-card" }); details.createEl("summary", { text: new Date(a.created).toLocaleString() + " · " + a.summary.slice(0, 70) });
    this.markdown(details.createDiv(), a.summary);
    if (!full) return;
    for (const f of a.findings) {
      const record = this.plugin.cooperation.state.records.find(r => r.id === f.recordId);
      const actor = record ?? f.actor;
      details.createEl("p", { text: (actor ? `[${actor.sourceName}] ${actor.modelId} · ${(roleNames[actor.role] ?? "历史角色（已停用）")}` : "原始记录已超过保留上限") + ` · ${f.assessment}（${f.confidence}）` }); this.markdown(details.createDiv(), f.reason);
    }
    if (a.sessionId) new ButtonComponent(details).setButtonText("阅读原会话").onClick(() => {
      const session = this.plugin.runtime.state.sessions.find(s => s.id === a.sessionId); if (!session) { new Notice("原会话已从列表移除。"); return; }
      const modal = new Modal(this.app); modal.titleEl.setText(session.title); modal.contentEl.createEl("pre", { text: session.messages.map(m => `${m.role}：${m.text}`).join("\n\n"), cls: "simple-ai-examiner-evidence" }); modal.open();
    });
    for (const q of a.questions) details.createEl("p", { text: "考官询问：" + q });
    if (a.feedback) details.createEl("p", { text: "用户反馈：" + a.feedback.satisfaction + " · " + a.feedback.reason });
    let satisfaction = a.feedback?.satisfaction ?? "暂不评价", reason = a.feedback?.reason ?? "";
    new Setting(details).setName("完成程度").addDropdown(d => d.addOptions({ 已完成: "已完成", 部分完成: "部分完成", 未完成: "未完成", 暂不评价: "暂不评价" }).setValue(satisfaction).onChange(v => { satisfaction = v; }));
    new Setting(details).setName("原因或纠正考官结论").addTextArea(t => t.setValue(reason).onChange(v => { reason = v; }));
    new ButtonComponent(details).setButtonText("保存反馈").onClick(() => { void this.perform(() => this.plugin.cooperation.feedback(a, satisfaction, reason)); });
    for (const recommendation of a.recommendations) this.recommendation(details, recommendation);
  }
  private recommendation(el: HTMLElement, r: Recommendation): void {
    const name = (selected: Recommendation["baseline"]) => selected ? `[${this.plugin.settings.sources.find(s => s.id === selected.sourceId)?.name ?? selected.sourceId}] ${selected.modelId}` : "跟随主 Agent";
    new Setting(el).setName(r.role === "auxiliary" ? `子 Agent 候选：加入 ${name(r)}` : `${(roleNames[r.role] ?? "历史角色（已停用）")}：${name(r.baseline)} → ${name(r)}`).setDesc(r.reason + (r.role === "main" ? "。更改全局默认，当前会话选择不变。" : ""))
      .addButton(b => b.setButtonText(r.applied ? "恢复旧配置" : r.role === "auxiliary" ? "加入候选" : "应用建议").setDisabled(this.loading || !Object.prototype.hasOwnProperty.call(roleNames, r.role)).onClick(() => { void this.perform(() => this.plugin.cooperation.applyRecommendation(r, !!r.applied)); }));
  }
}
