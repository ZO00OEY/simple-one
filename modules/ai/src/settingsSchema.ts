import { defaults, type ApiSource, type Settings } from "./api/types";
import { agentDefaults, cooperationDefaults, type AgentSettings, type CooperationSettings } from "./agent/types";
import { array, boolean, choice, fields, number, object, optional, selection, string, strings } from "./agent/storageSchema";

// Validate the fields callers use, keeping unknown/retired fields and accepting
// unfinished source drafts. Only missing historical fields receive defaults.
function scalars(o: Record<string, unknown>, base: object): void {
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") optional(o, key, string);
    else if (typeof value === "number") optional(o, key, number);
    else if (typeof value === "boolean") optional(o, key, boolean);
  }
}
function source(value: unknown): ApiSource {
  const o = object(value);
  fields(o, ["name", "url", "modelsUrl", "activeKeyId"], string); fields(o, ["keyIds", "discoveredModels"], strings); optional(o, "rotateKeys", boolean);
  fields(o, ["urlMode", "modelsUrlMode"], v => choice(v, ["base", "full"])); optional(o, "protocol", v => choice(v, ["openai", "anthropic"]));
  return { name: "", protocol: "openai", urlMode: "base", url: "", modelsUrl: "", discoveredModels: [], ...o,
    id: string(o.id), models: array(o.models, value => { const m = object(value); optional(m, "alias", string); return { ...m, id: string(m.id), alias: string(m.alias ?? "") }; }) };
}
function cooperation(value: unknown): CooperationSettings {
  const o = object(value), base = cooperationDefaults();
  const auxiliary = o.auxiliary === undefined ? {} : object(o.auxiliary), examiner = o.examiner === undefined ? {} : object(o.examiner);
  scalars(auxiliary, base.auxiliary); optional(auxiliary, "selected", selection); optional(auxiliary, "follow", v => choice(v, ["main"]));
  optional(auxiliary, "mode", v => choice(v, ["single", "multiple"]));
  const candidates = auxiliary.candidates === undefined ? [] : array(auxiliary.candidates, value => {
    const c = object(value); optional(c, "description", string); return { ...c, sourceId: string(c.sourceId), modelId: string(c.modelId), description: string(c.description ?? "") };
  });
  scalars(examiner, base.examiner); optional(examiner, "selected", selection); optional(examiner, "follow", v => choice(v, ["main", "auxiliary"]));
  // Legacy single-model settings had no mode. Preserve that migration trigger.
  return { ...o, auxiliary: { ...base.auxiliary, ...auxiliary, mode: auxiliary.mode === undefined && auxiliary.candidates === undefined && auxiliary.selected !== undefined ? "single" : choice(auxiliary.mode ?? "multiple", ["single", "multiple"]), candidates }, examiner: { ...base.examiner, ...examiner } };
}
function agent(value: unknown): AgentSettings {
  const o = object(value), base = agentDefaults(); scalars(o, base);
  optional(o, "instructionsEnabled", boolean);
  const memory = o.memory === undefined ? {} : object(o.memory); scalars(memory, base.memory);
  optional(memory, "selected", selection); optional(memory, "follow", v => choice(v, ["main", "auxiliary"]));
  fields(memory, ["intervalHours", "inputLimitChars"], number);
  const references = o.references === undefined ? base.references : strings(o.references), disabledSkills = o.disabledSkills === undefined ? base.disabledSkills : strings(o.disabledSkills);
  const referenceRules = o.referenceRules === undefined ? base.referenceRules : array(o.referenceRules, value => {
    const r = object(value); optional(r, "description", string); optional(r, "enabled", boolean);
    return { ...r, id: string(r.id), pattern: string(r.pattern), description: string(r.description ?? ""), enabled: boolean(r.enabled ?? true) };
  });
  const skills = o.skills === undefined ? base.skills : array(o.skills, value => {
    const s = object(value); fields(s, ["description", "path"], string); optional(s, "enabled", boolean);
    return { ...s, id: string(s.id), name: string(s.name), body: string(s.body), description: string(s.description ?? ""), enabled: boolean(s.enabled ?? true) };
  });
  return { ...base, ...o, references, disabledSkills, referenceRules, skills, memory: { ...base.memory, ...memory }, cooperation: o.cooperation === undefined ? base.cooperation : cooperation(o.cooperation) };
}
export function decodeSettings(value: unknown): Settings {
  const o = object(value), base = defaults(); scalars(o, base);
  optional(o, "selected", selection); optional(o, "sendShortcut", v => choice(v, ["off", "enter", "shift-enter"]));
  return { ...base, ...o, sources: o.sources === undefined ? [] : array(o.sources, source), agent: o.agent === undefined ? base.agent : agent(o.agent) };
}
