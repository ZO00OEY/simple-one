import type { Protocol } from "../api/types";
import { parseResponse } from "./protocol";
import { isRecord, record } from "./json";
import type { Message } from "./types";

export type ReplyUpdate = (reply: { text: string; reasoning: string }) => void;
interface StreamCall { id: string; type: string; function: { name: string; arguments: string }; }
interface StreamBlock { type: string; id?: unknown; name?: unknown; input?: unknown; text: string; thinking: string; json: string; }

// Accumulate provider events; tool arguments are validated only after completion.
export class ReplyStream {
  private buffer = "";
  private openai: { choices: { message: { content: string; tool_calls: StreamCall[] }; finish_reason: string }[]; usage: Record<string, unknown> } = { choices: [{ message: { content: "", tool_calls: [] }, finish_reason: "" }], usage: {} };
  private anthropic: { content: StreamBlock[]; stop_reason: string; usage: Record<string, unknown> } = { content: [], stop_reason: "", usage: {} };
  private finished = false;
  private stopped = false;
  private reasoning = "";
  get complete(): boolean { return this.stopped; }
  constructor(private protocol: Protocol, private update: ReplyUpdate) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.event(event);
    }
  }
  private index(value: unknown, limit: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= limit) throw new Error("流式内容索引无效，本轮未执行工具。");
    return value;
  }
  private event(event: string): void {
    const payload = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!payload || this.stopped) return;
    if (payload === "[DONE]") { this.stopped = true; return; }
    let value: unknown;
    try { value = JSON.parse(payload); } catch { throw new Error("流式响应包含无效 JSON，本轮未执行工具。"); }
    if (!isRecord(value)) throw new Error("流式事件格式无效，本轮未执行工具。");
    if (value.error || value.type === "error") {
      const message = record(value.error).message;
      throw new Error(typeof message === "string" ? message : "流式接口返回错误，本轮未执行工具。");
    }
    if (this.protocol === "openai") {
      if (isRecord(value.usage)) this.openai.usage = value.usage;
      const choices: unknown[] = Array.isArray(value.choices) ? value.choices : [];
      const choice = choices.find(c => record(c).index === 0) ?? choices[0];
      if (isRecord(choice)) {
        const message = this.openai.choices[0].message, delta = record(choice.delta);
        if (typeof delta.content === "string") message.content += delta.content;
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (typeof thought === "string") this.reasoning += thought;
        if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw new Error("流式工具调用格式无效。");
        const toolCalls: unknown[] = delta.tool_calls ?? [];
        for (const call of toolCalls) {
          if (!isRecord(call)) throw new Error("流式工具调用格式无效。");
          const index = this.index(call.index, 32);
          const target = message.tool_calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (call.id != null) {
            if (typeof call.id !== "string") throw new Error("流式工具 ID 无效。");
            target.id = call.id;
          }
          if (call.type != null) {
            if (typeof call.type !== "string") throw new Error("流式工具类型无效。");
            target.type = call.type;
          }
          if (call.function != null && !isRecord(call.function)) throw new Error("流式工具参数无效。");
          const fn = record(call.function);
          if (fn.name != null) {
            if (typeof fn.name !== "string") throw new Error("流式工具名称无效。");
            target.function.name += fn.name;
          }
          if (fn.arguments != null) {
            if (typeof fn.arguments !== "string") throw new Error("流式工具参数无效。");
            target.function.arguments += fn.arguments;
          }
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) { this.openai.choices[0].finish_reason = choice.finish_reason; this.finished = true; }
      }
    } else {
      if (value.type === "message_start") this.anthropic.usage = record(record(value.message).usage);
      if (value.type === "content_block_start") {
        const index = this.index(value.index, 128);
        if (Object.prototype.hasOwnProperty.call(this.anthropic.content, index) || !isRecord(value.content_block)) throw new Error("流式内容块起始事件无效。");
        const block = value.content_block;
        if (typeof block.type !== "string") throw new Error("流式内容块类型无效。");
        this.anthropic.content[index] = { type: block.type, id: block.id, name: block.name, input: block.input,
          text: typeof block.text === "string" ? block.text : "", thinking: typeof block.thinking === "string" ? block.thinking : "", json: "" };
        if (block.type === "thinking" && typeof block.thinking === "string") this.reasoning += block.thinking;
      }
      if (value.type === "content_block_delta") {
        const index = this.index(value.index, 128);
        // Never resolve inherited array properties or deltas without a start event.
        const block = Object.prototype.hasOwnProperty.call(this.anthropic.content, index) ? this.anthropic.content[index] : undefined;
        if (!block || !isRecord(value.delta)) throw new Error("流式内容缺少起始事件，本轮未执行工具。");
        const delta = value.delta;
        if (delta.type === "text_delta") {
          if (block.type !== "text" || typeof delta.text !== "string") throw new Error("流式文本增量无效。");
          block.text += delta.text;
        }
        if (delta.type === "thinking_delta") {
          if (block.type !== "thinking" || typeof delta.thinking !== "string") throw new Error("流式思考增量无效。");
          this.reasoning += delta.thinking;
        }
        if (delta.type === "input_json_delta") {
          if (block.type !== "tool_use" || typeof delta.partial_json !== "string") throw new Error("流式工具增量无效。");
          block.json += delta.partial_json;
        }
      }
      if (value.type === "message_delta") {
        const reason = record(value.delta).stop_reason;
        if (typeof reason === "string") this.anthropic.stop_reason = reason;
        this.anthropic.usage = { ...this.anthropic.usage, ...record(value.usage) };
      }
      if (value.type === "message_stop") { this.finished = true; this.stopped = true; }
    }
    this.update({ text: this.protocol === "openai" ? this.openai.choices[0].message.content : this.anthropic.content.filter(b => b?.type === "text").map(b => b.text).join(""), reasoning: this.reasoning });
  }
  finish(): Message {
    if (this.buffer.trim()) this.event(this.buffer);
    if (!this.finished || this.protocol === "anthropic" && !this.anthropic.stop_reason) throw new Error("流式响应提前断开，本轮未执行工具。请重试。");
    if (this.protocol === "anthropic") {
      this.anthropic.content = this.anthropic.content.filter(Boolean);
      for (const block of this.anthropic.content) if (block.type === "tool_use" && block.json) {
        try { block.input = JSON.parse(block.json); } catch { throw new Error("工具参数不是完整 JSON，本轮未执行工具。"); }
      }
    } else if (Array.from(this.openai.choices[0].message.tool_calls).some(call => !call)) throw new Error("流式工具调用不完整，本轮未执行工具。");
    const message = parseResponse(this.protocol, this.protocol === "openai" ? this.openai : this.anthropic);
    if (this.reasoning) message.reasoning = this.reasoning;
    return message;
  }
}
