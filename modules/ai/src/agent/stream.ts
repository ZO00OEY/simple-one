import type { Protocol } from "../api/types";
import { parseResponse } from "./protocol";
import type { Message } from "./types";

export type ReplyUpdate = (reply: { text: string; reasoning: string }) => void;

// Accumulate provider events; tool arguments are validated only after completion.
export class ReplyStream {
  private buffer = "";
  private data: any;
  private finished = false;
  private stopped = false;
  private reasoning = "";
  get complete(): boolean { return this.stopped; }
  constructor(private protocol: Protocol, private update: ReplyUpdate) {
    this.data = protocol === "openai" ? { choices: [{ message: { content: "", tool_calls: [] }, finish_reason: null }] } : { content: [], stop_reason: null };
  }
  push(chunk: string): void {
    this.buffer += chunk;
    // Normalize CRLF only after a complete event, including split CR/LF chunks.
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.event(event);
    }
  }
  private event(event: string): void {
    const payload = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!payload || this.stopped) return;
    if (payload === "[DONE]") { this.stopped = true; return; }
    let value: any;
    try { value = JSON.parse(payload); } catch { throw new Error("流式响应包含无效 JSON，本轮未执行工具。"); }
    if (value.error || value.type === "error") throw new Error(typeof value.error?.message === "string" ? value.error.message : "流式接口返回错误，本轮未执行工具。");
    if (this.protocol === "openai") {
      if (value.usage) this.data.usage = value.usage;
      const choice = value.choices?.find((c: any) => c.index === 0) ?? value.choices?.[0];
      if (choice) {
        const message = this.data.choices[0].message, delta = choice.delta ?? {};
        if (typeof delta.content === "string") message.content += delta.content;
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (typeof thought === "string") this.reasoning += thought;
        for (const call of delta.tool_calls ?? []) {
          if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 32) throw new Error("流式工具序号无效，本轮未执行工具。");
          const target = message.tool_calls[call.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (call.id) target.id = call.id;
          if (call.type) target.type = call.type;
          if (typeof call.function?.name === "string") target.function.name += call.function.name;
          if (typeof call.function?.arguments === "string") target.function.arguments += call.function.arguments;
        }
        if (choice.finish_reason) { this.data.choices[0].finish_reason = choice.finish_reason; this.finished = true; }
      }
    } else {
      const index = value.index;
      if (value.type === "message_start") this.data.usage = value.message?.usage;
      if (value.type === "content_block_start") {
        if (!Number.isInteger(index) || index < 0 || index >= 128) throw new Error("流式内容序号无效。");
        this.data.content[index] = { ...value.content_block, json: "" };
        if (value.content_block?.type === "thinking") this.reasoning += value.content_block.thinking ?? "";
      }
      if (value.type === "content_block_delta") {
        const block = this.data.content[index];
        if (!block) throw new Error("流式内容缺少起始事件，本轮未执行工具。");
        if (value.delta?.type === "text_delta") block.text = (block.text ?? "") + value.delta.text;
        if (value.delta?.type === "thinking_delta") this.reasoning += value.delta.thinking;
        if (value.delta?.type === "input_json_delta") block.json += value.delta.partial_json;
      }
      if (value.type === "message_delta") {
        this.data.stop_reason = value.delta?.stop_reason;
        this.data.usage = { ...this.data.usage, ...value.usage };
      }
      if (value.type === "message_stop") { this.finished = true; this.stopped = true; }
    }
    this.update({ text: this.protocol === "openai" ? this.data.choices[0].message.content : this.data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join(""), reasoning: this.reasoning });
  }
  finish(): Message {
    if (this.buffer.trim()) this.event(this.buffer);
    if (!this.finished || this.protocol === "anthropic" && !this.data.stop_reason) throw new Error("流式响应提前断开，本轮未执行工具。请重试。");
    if (this.protocol === "anthropic") {
      this.data.content = this.data.content.filter(Boolean);
      for (const block of this.data.content) if (block.type === "tool_use" && block.json) {
        try { block.input = JSON.parse(block.json); } catch { throw new Error("工具参数不是完整 JSON，本轮未执行工具。"); }
      }
    } else {
      const calls = this.data.choices[0].message.tool_calls;
      if (Array.from(calls).some(call => !call)) throw new Error("流式工具调用不完整，本轮未执行工具。");
    }
    const message = parseResponse(this.protocol, this.data);
    if (this.reasoning) message.reasoning = this.reasoning;
    return message;
  }
}
