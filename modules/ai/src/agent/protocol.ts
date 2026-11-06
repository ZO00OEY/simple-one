import { isRecord, record } from "./json";
import type { Message, Tool } from "./types";
import type { Protocol } from "../api/types";

export function requestBody(protocol: Protocol, model: string, system: string, messages: Message[], tools: Tool[], maxOutputTokens: number | null = 8192): object {
  if (protocol === "anthropic") {
    const wire: { role: string; content: Record<string, unknown>[] }[] = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content: Record<string, unknown>[] = m.role === "tool" ? [{ type: "tool_result", tool_use_id: m.callId, content: m.text, is_error: !!m.error }]
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
export function parseResponse(protocol: Protocol, data: unknown): Message {
  if (!isRecord(data)) throw new Error("接口返回了无效数据。");
  const calls: NonNullable<Message["calls"]> = [];
  let text = "", reasoning = "";
  const addCall = (id: unknown, name: unknown, args: unknown) => {
    if (typeof id !== "string" || !id || typeof name !== "string" || !name || !isRecord(args)) throw new Error("工具调用格式无效，未执行。");
    calls.push({ id, name, arguments: args });
  };
  if (protocol === "anthropic") {
    if (data.stop_reason === "max_tokens") throw new Error("模型输出达到长度上限，本轮未执行工具。请缩小任务后重试。");
    if (!Array.isArray(data.content)) throw new Error("Anthropic 响应缺少 content。");
    const parts: unknown[] = data.content;
    for (const part of parts) {
      if (!isRecord(part)) throw new Error("Anthropic 内容块格式无效。");
      if (part.type === "text" && typeof part.text === "string") text += part.text;
      if (part.type === "thinking" && typeof part.thinking === "string") reasoning += part.thinking;
      if (part.type === "tool_use") addCall(part.id, part.name, part.input);
    }
  } else {
    const choice = Array.isArray(data.choices) ? record(data.choices[0]) : {};
    if (choice.finish_reason === "length") throw new Error("模型输出被截断，本轮未执行工具。请缩小任务后重试。");
    if (!isRecord(choice.message)) throw new Error("OpenAI 响应缺少 message。");
    const message = choice.message;
    text = typeof message.content === "string" ? message.content : "";
    const thought = message.reasoning_content ?? message.reasoning;
    if (typeof thought === "string") reasoning = thought;
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) throw new Error("工具调用格式无效，未执行。");
    const toolCalls: unknown[] = message.tool_calls ?? [];
    for (const call of toolCalls) {
      if (!isRecord(call) || call.type !== "function" || !isRecord(call.function)) throw new Error("暂不支持此工具类型。");
      let args: unknown;
      try {
        if (typeof call.function.arguments !== "string") throw new Error("Invalid arguments");
        args = JSON.parse(call.function.arguments);
      } catch { throw new Error("工具参数不是完整 JSON，本轮未执行工具。"); }
      addCall(call.id, call.function.name, args);
    }
  }
  if (calls.length > 32) throw new Error("单轮工具调用过多，未执行。");
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new Error("工具调用格式无效，未执行。");
    ids.add(call.id);
  }
  if (!text && !calls.length) throw new Error("模型没有返回文字或工具调用。");
  const rawUsage = record(data.usage);
  const usage: NonNullable<Message["usage"]> = {};
  for (const [key, value] of Object.entries({
    inputTokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens,
    outputTokens: rawUsage.output_tokens ?? rawUsage.completion_tokens,
    totalTokens: rawUsage.total_tokens,
    cacheReadTokens: rawUsage.cache_read_input_tokens ?? record(rawUsage.prompt_tokens_details).cached_tokens ?? record(rawUsage.input_tokens_details).cached_tokens ?? rawUsage.prompt_cache_hit_tokens,
    cacheWriteTokens: rawUsage.cache_creation_input_tokens,
  })) if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key as keyof typeof usage] = value;
  return { role: "assistant", text, ...(reasoning ? { reasoning } : {}), ...(calls.length ? { calls } : {}), ...(Object.keys(usage).length ? { usage } : {}) };
}
