import type { Assessment, Finding, WorkRecord } from "./cooperation";
import type { RecordedModelRole } from "./types";

export interface ModelObservation {
  sourceId: string; modelId: string; role: RecordedModelRole; taskType: string;
  records: { id: string; state: WorkRecord["state"]; elapsedMs?: number }[];
  verdict: "positive" | "negative" | "unknown"; reliable: boolean; problems: string[];
}
export interface CapabilityNote {
  sourceId: string; modelId: string; role: RecordedModelRole; taskType: string; n: number;
  done: number; failed: number; interrupted: number; averageMs?: number;
  confidence: Finding["confidence"]; verdict: ModelObservation["verdict"]; updated: number; evidenceIds: string[];
  problems: string[]; feedback: { assessmentId: string; satisfaction: string; reason: string; updated: number }[];
}
const key = (v: Pick<ModelObservation, "sourceId" | "modelId" | "role" | "taskType">) => JSON.stringify([v.sourceId, v.modelId, v.role, v.taskType]);
function findingVerdict(text: string): ModelObservation["verdict"] {
  return /未完成|部分完成|失败|遗漏|不满足|incorrect|fail|incomplete/i.test(text) ? "negative" : /^(?:ok|pass|success)$/i.test(text.trim()) || /已完成|完成|满足/.test(text) ? "positive" : "unknown";
}
export function observeModels(records: WorkRecord[], assessment: Assessment): ModelObservation[] {
  const groups = new Map<string, WorkRecord[]>();
  for (const record of records) { const id = JSON.stringify([record.sourceId, record.modelId, record.role]); groups.set(id, [...(groups.get(id) ?? []), record]); }
  return [...groups.values()].map(group => {
    const first = group[0], findings = assessment.findings.filter(f => group.some(r => r.id === f.recordId));
    const verdicts = findings.map(f => findingVerdict(f.assessment));
    return { sourceId: first.sourceId, modelId: first.modelId, role: first.role, taskType: assessment.taskType ?? "未知任务", records: group.map(r => ({ id: r.id, state: r.state, elapsedMs: r.ended === undefined ? undefined : r.ended - r.started })),
      verdict: verdicts.includes("negative") ? "negative" : verdicts.length && verdicts.every(v => v === "positive") ? "positive" : "unknown",
      reliable: findings.length > 0 && findings.every(f => f.confidence !== "low") && group.every(r => !r.truncated && r.state === "done"),
      problems: findings.map(f => f.assessment + "：" + f.reason).slice(-5) };
  });
}
/** Re-assessing one task never creates another independent sample. User feedback wins. */
export function capabilityNotes(assessments: Assessment[]): CapabilityNote[] {
  const samples = new Map<string, { assessment: Assessment; observation: ModelObservation }>();
  for (const assessment of assessments) if (!assessment.obsolete) for (const observation of assessment.observations ?? []) samples.set(key(observation) + ":" + assessment.taskId, { assessment, observation });
  const groups = new Map<string, typeof samples extends Map<string, infer T> ? T[] : never>();
  for (const sample of samples.values()) { const id = key(sample.observation); groups.set(id, [...(groups.get(id) ?? []), sample]); }
  return [...groups.values()].map(group => {
    const first = group[0].observation, records = new Map(group.flatMap(sample => sample.observation.records.map(record => [record.id, record] as const)));
    const feedback = group.flatMap(({ assessment }) => assessment.feedback ? [{ ...assessment.feedback, assessmentId: assessment.id }] : []);
    const verdicts = group.map(({ assessment, observation }) => {
      const feedback = assessment.feedback;
      return feedback && (feedback.satisfaction !== "暂不评价" || feedback.reason.trim()) ? feedback.satisfaction === "已完成" ? "positive" : ["部分完成", "未完成"].includes(feedback.satisfaction) ? "negative" : "unknown" : observation.verdict;
    });
    const reliable = group.every(({ assessment, observation }) => assessment.feedback && assessment.feedback.satisfaction !== "暂不评价" || observation.reliable);
    const consistent = verdicts.length >= 3 && verdicts[0] !== "unknown" && verdicts.every(v => v === verdicts[0]);
    const timings = [...records.values()].flatMap(record => record.elapsedMs === undefined ? [] : [record.elapsedMs]);
    return { sourceId: first.sourceId, modelId: first.modelId, role: first.role, taskType: first.taskType, n: group.length,
      done: [...records.values()].filter(r => r.state === "done").length, failed: [...records.values()].filter(r => r.state === "failed").length, interrupted: [...records.values()].filter(r => r.state === "interrupted").length,
      averageMs: timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : undefined,
      confidence: consistent && reliable ? feedback.length === group.length ? "high" : "medium" : "low",
      verdict: consistent ? verdicts[0] : "unknown", updated: Math.max(...group.map(({ assessment }) => assessment.feedback?.updated ?? assessment.created)),
      evidenceIds: group.map(({ assessment }) => assessment.id), problems: [...new Set(group.flatMap(({ observation }) => observation.problems))].slice(-5), feedback };
  });
}
export function capabilityText(notes: CapabilityNote[]): string {
  if (!notes.length) return "样本不足：n=0，暂无实测附注；不能据此切换模型。";
  return notes.map(note => {
    const clip = (text: string) => text.length > 500 ? text.slice(0, 500) + "[截断]" : text;
    return ["模型：" + note.sourceId + "/" + note.modelId, "角色：" + note.role, "任务类型：" + note.taskType, "样本数 n=" + note.n,
      "接口成功/失败/中断：" + [note.done, note.failed, note.interrupted].join("/"), "平均耗时：" + (note.averageMs === undefined ? "未知" : Math.round(note.averageMs) + "ms"),
      "典型问题与实测：" + note.problems.map(clip).join("；"), "置信度：" + note.confidence, "日期：" + new Date(note.updated).toISOString(),
      "支撑验收：" + note.evidenceIds.slice(-10).join(",") + (note.evidenceIds.length > 10 ? "（仅展示最近10份）" : ""),
      "用户反馈（优先于考官推断）：" + note.feedback.slice(-5).map(f => f.satisfaction + "：" + clip(f.reason)).join("；") + (note.feedback.length > 5 ? "（仅展示最近5份）" : ""),
      note.n < 3 ? "样本不足，不建议切换" : note.confidence === "low" ? "结论不一致或证据不足，不建议切换" : "有实测依据；调整仍需用户点击"].join(" · ");
  }).join("\n");
}
