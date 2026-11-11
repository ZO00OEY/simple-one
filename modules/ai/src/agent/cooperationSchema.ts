import type { ModelObservation, CapabilityNote } from "./capabilities";
import type { Assessment, ExaminerState, Finding, Recommendation, WorkRecord } from "./cooperation";
import { array, boolean, choice, decodeMessage, fields, number, object, optional, selection, string, strings } from "./storageSchema";
import type { AuxiliaryCandidate, RecordedModelRole } from "./types";

const role = (value: unknown): RecordedModelRole => choice(value, ["main", "auxiliary", "memory", "examiner", "review"]);
function candidate(value: unknown): AuxiliaryCandidate {
  const o = object(value);
  optional(o, "description", string);
  return { ...o, sourceId: string(o.sourceId), modelId: string(o.modelId), description: string(o.description ?? "") };
}
function recommendation(value: unknown): Recommendation {
  const o = object(value);
  fields(o, ["baseline", "previous"], selection);
  fields(o, ["baselineFollow", "previousFollow"], v => choice(v, ["main", "auxiliary"]));
  fields(o, ["baselineCandidates", "previousCandidates", "appliedCandidates"], v => array(v, candidate));
  optional(o, "applied", boolean);
  return { ...o, role: role(o.role), sourceId: string(o.sourceId), modelId: string(o.modelId), reason: string(o.reason) };
}
function finding(value: unknown): Finding {
  const o = object(value);
  optional(o, "actor", value => {
    const actor = object(value); actor.role = role(actor.role);
    for (const key of ["sourceId", "sourceName", "modelId"]) actor[key] = string(actor[key]);
    return actor;
  });
  return { ...o, recordId: string(o.recordId), assessment: string(o.assessment), reason: string(o.reason), confidence: choice(o.confidence, ["low", "medium", "high"]) };
}
function observation(value: unknown): ModelObservation {
  const o = object(value);
  return { ...o, sourceId: string(o.sourceId), modelId: string(o.modelId), role: role(o.role), taskType: string(o.taskType),
    verdict: choice(o.verdict, ["positive", "negative", "unknown"]), reliable: boolean(o.reliable), problems: strings(o.problems),
    records: array(o.records, value => { const r = object(value); optional(r, "elapsedMs", number); return { ...r, id: string(r.id), state: choice(r.state, ["running", "done", "failed", "interrupted"]), elapsedMs: r.elapsedMs === undefined ? undefined : number(r.elapsedMs) }; }) };
}
function capability(value: unknown): CapabilityNote {
  const o = object(value); optional(o, "averageMs", number);
  return { ...o, sourceId: string(o.sourceId), modelId: string(o.modelId), role: role(o.role), taskType: string(o.taskType),
    n: number(o.n), done: number(o.done), failed: number(o.failed), interrupted: number(o.interrupted), updated: number(o.updated), averageMs: o.averageMs === undefined ? undefined : number(o.averageMs),
    confidence: choice(o.confidence, ["low", "medium", "high"]), verdict: choice(o.verdict, ["positive", "negative", "unknown"]), evidenceIds: strings(o.evidenceIds), problems: strings(o.problems),
    feedback: array(o.feedback, value => { const f = object(value); return { ...f, assessmentId: string(f.assessmentId), satisfaction: string(f.satisfaction), reason: string(f.reason), updated: number(f.updated) }; }) };
}
function assessment(value: unknown): Assessment {
  const o = object(value);
  fields(o, ["sessionId", "taskType"], string); optional(o, "revision", number); optional(o, "obsolete", boolean);
  optional(o, "observations", value => array(value, observation));
  optional(o, "modelDescriptions", value => array(value, candidate));
  optional(o, "feedback", value => {
    const feedback = object(value); feedback.satisfaction = string(feedback.satisfaction); feedback.reason = string(feedback.reason); feedback.updated = number(feedback.updated); return feedback;
  });
  return { ...o, id: string(o.id), taskId: string(o.taskId), created: number(o.created), summary: string(o.summary),
    findings: array(o.findings, finding), questions: strings(o.questions), recommendations: array(o.recommendations, recommendation), recordIds: strings(o.recordIds) };
}
function record(value: unknown): WorkRecord {
  const o = object(value);
  fields(o, ["sessionId", "error", "evidence", "sourceName", "rules", "stage"], string); optional(o, "ended", number); optional(o, "truncated", boolean);
  optional(o, "usage", value => { const usage = object(value); fields(usage, ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"], number); return usage; });
  optional(o, "requestContext", value => {
    const context = object(value);
    fields(context, ["messageCount", "inputChars", "rulesChars"], number); fields(context, ["auxiliaryMode", "delegateCallId"], string);
    optional(context, "auxiliaryEnabled", boolean); optional(context, "tools", strings); return context;
  });
  return { ...o, id: string(o.id), taskId: string(o.taskId), role: role(o.role), sourceId: string(o.sourceId), sourceName: string(o.sourceName ?? o.sourceId),
    modelId: string(o.modelId), started: number(o.started), state: choice(o.state, ["running", "done", "failed", "interrupted"]),
    input: string(o.input), output: string(o.output), rules: string(o.rules ?? ""), stage: string(o.stage ?? ""), truncated: boolean(o.truncated ?? false) };
}
export function decodeCooperation(value: unknown): ExaminerState {
  const o = object(value);
  optional(o, "capabilities", value => array(value, capability));
  optional(o, "traffic", value => array(value, record));
  fields(o, ["day", "lastError"], string); fields(o, ["requests", "lastRequest"], number);
  return { ...o, records: array(o.records, record), assessments: array(o.assessments, assessment), discussion: array(o.discussion, decodeMessage),
    day: string(o.day ?? ""), requests: number(o.requests ?? 0), lastError: string(o.lastError ?? ""), lastRequest: number(o.lastRequest ?? 0) };
}
