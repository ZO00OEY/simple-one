import type { Message, Tool } from "./types";
import type { Protocol } from "../api/types";

export function requestBody(protocol: Protocol, model: string, system: string, messages: Message[], tools: Tool[], maxOutputTokens: number | null = 8192): object {
  if (protocol === "anthropic") {
    const wire: { role: string; content: any[] }[] = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content: any[] = m.role === "tool" ? [{ type: "tool_result", tool_use_id: m.callId, content: m.text, is_error: !!m.error }]
        : [...(m.text ? [{ type: "text", text: m.text }] : []), ...(m.images ?? []).map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
          ...(m.calls ?? []).map(c => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments }))];
      if (!content.length) content.push({ type: "text", text: "（空消息）" });
      if (wire[wire.length - 1]?.role === role) wire[wire.length - 1].content.push(...content);
      else wire.push({ role, content });
    }
    return { model, system, messages: wire, max_tokens: maxOutputTokens ?? 8192, stream: false,
      ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}) };
  }
  return { model, stream: false, ...(maxOutputTokens === null ? {} : { max_completion_tokens: maxOutputTokens }),
    messages: [{ role: "system", content: system }, ...messages.map(m => m.role === "tool"
      ? { role: "tool", tool_call_id: m.callId, content: m.text }
      : { role: m.role, content: m.images?.length ? [{ type: "text", text: m.text || "请查看图片。" }, ...m.images.map(i => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] : m.text || null,
        ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) })],
    ...(tools.length ? { tools: tools.map(t => ({ type: "function", function: t })), tool_choice: "auto" } : {}) };
}
export function parseResponse(protocol: Protocol, data: any): Message {
  const calls: NonNullable<Message["calls"]> = [];
  let text = "";
  let reasoning = "";
  if (protocol === "anthropic") {
    if (data.stop_reason === "max_tokens") throw new Error("模型输出达到长度上限，本轮未执行工具。请缩小任务后重试。");
    if (!Array.isArray(data.content)) throw new Error("Anthropic 响应缺少 content。");
    for (const part of data.content) {
      if (part.type === "text" && typeof part.text === "string") text += part.text;
      if (part.type === "thinking" && typeof part.thinking === "string") reasoning += part.thinking;
      if (part.type === "tool_use") calls.push({ id: part.id, name: part.name, arguments: part.input });
    }
  } else {
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error("模型输出被截断，本轮未执行工具。请缩小任务后重试。");
    if (!choice?.message) throw new Error("OpenAI 响应缺少 message。");
    text = typeof choice.message.content === "string" ? choice.message.content : "";
    const thought = choice.message.reasoning_content ?? choice.message.reasoning;
    if (typeof thought === "string") reasoning = thought;
    for (const c of choice.message.tool_calls ?? []) {
      if (c.type !== "function") throw new Error("暂不支持此工具类型。");
      let args: unknown;
      try { args = JSON.parse(c.function.arguments); } catch { throw new Error("工具参数不是完整 JSON，本轮未执行工具。"); }
      calls.push({ id: c.id, name: c.function.name, arguments: args as Record<string, unknown> });
    }
  }
  if (calls.length > 32) throw new Error("单轮工具调用过多，未执行。");
  const ids = new Set<string>();
  for (const c of calls) {
    if (typeof c.id !== "string" || !c.id || ids.has(c.id) || typeof c.name !== "string" || !c.arguments || typeof c.arguments !== "object" || Array.isArray(c.arguments)) throw new Error("工具调用格式无效，未执行。");
    ids.add(c.id);
  }
  if (!text && !calls.length) throw new Error("模型没有返回文字或工具调用。");
  const rawUsage = data.usage;
  const usage: NonNullable<Message["usage"]> = {};
  for (const [key, value] of Object.entries({
    inputTokens: rawUsage?.input_tokens ?? rawUsage?.prompt_tokens,
    outputTokens: rawUsage?.output_tokens ?? rawUsage?.completion_tokens,
    totalTokens: rawUsage?.total_tokens,
    cacheReadTokens: rawUsage?.cache_read_input_tokens ?? rawUsage?.prompt_tokens_details?.cached_tokens ?? rawUsage?.input_tokens_details?.cached_tokens ?? rawUsage?.prompt_cache_hit_tokens,
    cacheWriteTokens: rawUsage?.cache_creation_input_tokens,
  })) if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key as keyof typeof usage] = value;
  return { role: "assistant", text, ...(reasoning ? { reasoning } : {}), ...(calls.length ? { calls } : {}), ...(Object.keys(usage).length ? { usage } : {}) };
}
