import { ButtonComponent } from "../ui";

import type SimpleAIPlugin from "../main";
import type { WorkRecord } from "./cooperation";
import { modelUsage, usageRecords } from "./usage";

export function trafficSettingsPage(el: HTMLElement, plugin: SimpleAIPlugin): void {
  el.addClass("simple-ai-traffic-settings");
  el.createEl("p", { cls: "simple-ai-hint", text: "按对话累计各模型的实际请求用量，包括工具调用及重试。归档不影响统计，分支继承的历史不重复计费。缺失用量不会算作 0；旧记录仅能汇总仍保留的数据。" });
  const toolbar = el.createDiv("simple-ai-traffic-toolbar");
  const search = toolbar.createEl("input", { type: "search", placeholder: "搜索对话、来源或模型", cls: "simple-ai-search", attr: { "aria-label": "搜索 Token 使用记录" } });
  const list = el.createDiv("simple-ai-traffic-list");
  const totals = (parent: HTMLElement, records: WorkRecord[]) => {
    const value = (sum: number, missing: number, requests: number) => missing === requests ? "未提供" : `${sum.toLocaleString("zh-CN")}${missing ? `（另有 ${missing} 次未提供）` : ""}`;
    for (const model of modelUsage(records)) {
      const row = parent.createDiv("simple-ai-traffic-model");
      row.createEl("div", { cls: "simple-ai-traffic-model-name", text: model.modelId });
      row.createEl("div", { cls: "simple-ai-traffic-meta", text: model.sourceName });
      const metrics = row.createDiv("simple-ai-traffic-metrics");
      for (const [label, amount] of [["请求次数", String(model.requests)], ["输入 Token", value(model.input, model.missingInput, model.requests)], ["输出 Token", value(model.output, model.missingOutput, model.requests)]]) {
        const metric = metrics.createDiv("simple-ai-traffic-metric");
        metric.createSpan({ cls: "simple-ai-traffic-meta", text: label });
        metric.createSpan({ cls: "simple-ai-traffic-value", text: amount });
      }
    }
    if (!records.length) parent.createEl("p", { cls: "simple-ai-hint", text: "暂无请求记录。" });
  };
  const render = () => {
    list.empty();
    const sessions = plugin.runtime.state.sessions;
    const records = usageRecords([...(plugin.cooperation.state.traffic ?? []), ...plugin.cooperation.state.records], sessions);
    const query = search.value.trim().toLowerCase();
    let count = 0;
    for (const session of [...sessions].sort((a, b) => b.updated - a.updated)) {
      const own = records.filter(record => record.sessionId === session.id);
      if (query && !`${session.title} ${own.map(record => `${record.sourceName} ${record.modelId}`).join(" ")}`.toLowerCase().includes(query)) continue;
      count++;
      const details = list.createEl("details", { cls: "simple-ai-traffic-session" });
      const summary = details.createEl("summary");
      summary.createSpan({ cls: "simple-ai-traffic-title", text: session.title });
      summary.createSpan({ cls: "simple-ai-traffic-meta", text: `${session.archived ? "已归档" : "未归档"} · ${new Date(session.updated).toLocaleString("zh-CN", { hour12: false })}` });
      totals(details.createDiv("simple-ai-traffic-models"), own);
    }
    const background = records.filter(record => !record.sessionId);
    if (background.length && (!query || `独立后台任务 ${background.map(record => `${record.sourceName} ${record.modelId}`).join(" ")}`.toLowerCase().includes(query))) {
      count++;
      const details = list.createEl("details", { cls: "simple-ai-traffic-session" });
      details.createEl("summary", { text: "独立后台任务（记忆合并、考官讨论等）" });
      totals(details.createDiv("simple-ai-traffic-models"), background);
    }
    if (!count) list.createEl("p", { cls: "simple-ai-hint", text: query ? "没有匹配记录。" : "暂无对话。" });
  };
  search.oninput = render;
  new ButtonComponent(toolbar).setButtonText("刷新").onClick(render);
  render();
}
