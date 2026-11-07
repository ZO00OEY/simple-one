import { isRecord, record } from "../agent/json";
import type { ApiSource } from "./types";
import type { Message, Tool } from "../agent/types";
import { requestBody, parseResponse } from "../agent/protocol";
import { ReplyStream, type ReplyUpdate } from "../agent/stream";

export interface HttpRequest { url: string; method: string; headers: Record<string, string>; body?: string; }
export interface HttpResponse { status: number; text: string; }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

function validUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("请填写完整的 http:// 或 https:// 地址。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("地址只支持 HTTP/HTTPS，不能包含用户名、密码或 # 片段。");
  }
  return url;
}

export function endpoint(source: ApiSource, purpose: "chat" | "models"): string {
  if (purpose === "models" && source.modelsUrl.trim()) {
    if (source.modelsUrlMode === "base") return endpoint({ ...source, url: source.modelsUrl, urlMode: "base", modelsUrl: "" }, "models");
    validUrl(source.modelsUrl);
    return source.modelsUrl.trim();
  }
  if (purpose === "models" && source.modelsUrlMode === "full") throw new Error("请填写完整的模型列表地址，或选择自动补全列表路径。");
  const url = validUrl(source.url);
  if (purpose === "chat" && source.urlMode === "full") return source.url.trim();
  let path = url.pathname.replace(/\/+$/, "");
  // Accept base URLs, version roots and already completed endpoints without doubling paths.
  path = path.replace(/\/(chat\/completions|messages|models|chat)$/, "");
  if (!/\/v\d+(?:beta\d*)?$/.test(path)) path += "/v1";
  url.pathname = `${path}/${purpose === "models" ? "models" : source.protocol === "anthropic" ? "messages" : "chat/completions"}`;
  return url.href;
}

/** Keep derived model URLs automatic while persisting the completed request address. */
export function completeSourceAddresses(source: ApiSource): ApiSource {
  return { ...source, url: endpoint(source, "chat"),
    modelsUrl: source.modelsUrl.trim() || source.modelsUrlMode === "full" ? endpoint(source, "models") : "" };
}

export function safeError(error: unknown, key: string): string {
  let message = error instanceof Error ? error.message : "请求失败，请检查网络与来源配置。";
  if (key) message = message.split(key).join("[已隐藏密钥]");
  return message.replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]").slice(0, 600);
}

export class ApiClient {
  async testTools(source: ApiSource, key: string, model: string, enabled: () => boolean = () => true): Promise<string> {
    const response = await this.chat(source, key, model,
      "This is a tool-call compatibility test. Call connection_probe with message set to Hi. Do not answer in plain text.",
      [{ role: "user", text: "Run the connection probe now." }],
      [{ name: "connection_probe", description: "Connectivity probe; no external effects.", parameters: { type: "object", properties: { message: { type: "string", enum: ["Hi"] } }, required: ["message"], additionalProperties: false } }]);
    if (response.calls?.length !== 1 || response.calls[0].name !== "connection_probe" || response.calls[0].arguments.message !== "Hi") throw new Error("普通通信可能可用，但本次未返回预期工具调用。请确认来源和模型支持工具调用。");
    if (!enabled()) throw new Error("AI 助手已关闭，未继续发送结果回传请求。");
    const final = await this.chat(source, key, model, "The connection probe finished. Briefly confirm the result.",
      [{ role: "user", text: "Run the connection probe now." }, response, { role: "tool", callId: response.calls[0].id, text: "Probe succeeded." }], []);
    if (final.calls?.length) throw new Error("工具结果回传后仍出现未知调用。");
    return "工具调用与结果回传测试通过：" + final.text.slice(0, 300);
  }
  async chat(source: ApiSource, key: string, model: string, system: string, messages: Message[], tools: Tool[], signal?: AbortSignal, update?: ReplyUpdate, maxOutputTokens: number | null = 8192): Promise<Message> {
    if (signal?.aborted) throw new Error("已停止。");
    if (update && this.streamFetch) return this.streamChat(source, key, model, system, messages, tools, signal, update, maxOutputTokens);
    let abort: (() => void) | undefined;
    try {
      const pending = this.request(source, key, endpoint(source, "chat"), requestBody(source.protocol, model, system, messages, tools, maxOutputTokens), 120000);
      const data = signal ? await Promise.race([pending, new Promise<never>((_, reject) => {
        abort = () => reject(new Error("已停止。服务端请求可能仍在处理，但返回结果不会执行。"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]) : await pending;
      if (signal?.aborted) throw new Error("已停止。");
      return parseResponse(source.protocol, data);
    } finally { if (signal && abort) signal.removeEventListener("abort", abort); }
  }
  constructor(private transport: Transport, private timeoutMs = 30000, private streamFetch?: (url: string, init: RequestInit) => Promise<Response>) {}
  private async streamChat(source: ApiSource, key: string, model: string, system: string, messages: Message[], tools: Tool[], signal: AbortSignal | undefined, update: ReplyUpdate, maxOutputTokens: number | null): Promise<Message> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
      if (source.protocol === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
        headers["anthropic-dangerous-direct-browser-access"] = "true";
        if (key) headers["x-api-key"] = key;
      } else if (key) headers.Authorization = `Bearer ${key}`;
      const body = { ...requestBody(source.protocol, model, system, messages, tools, maxOutputTokens), stream: true };
      const response = await this.streamFetch!(endpoint(source, "chat"), { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
        // Some compatible endpoints ignore stream:true and return ordinary JSON.
        const message = parseResponse(source.protocol, this.decode({ status: response.status, text: await response.text() }));
        if (controller.signal.aborted) throw new Error("已停止。");
        update({ text: message.text, reasoning: message.reasoning ?? "" }); return message;
      }
      if (!response.body) throw new Error("当前环境无法读取流式回复，请检查来源响应与当前网络环境；本次不会自动重试。");
      const stream = new ReplyStream(source.protocol, partial => { if (!controller.signal.aborted) update(partial); });
      const decoder = new TextDecoder(); reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new Error("已停止。");
        if (chunk.done) break;
        stream.push(decoder.decode(chunk.value, { stream: true }));
        if (stream.complete) break;
      }
      stream.push(decoder.decode()); return stream.finish();
    } catch (error) {
      const message = timedOut ? "等待流式回复超时，请稍后重试。" : signal?.aborted ? "已停止，流式回复未执行工具。" : error instanceof TypeError ? "流式连接失败，可能是网络或来源的 CORS 限制。请检查来源跨域配置，也可先用来源的非流式连接测试核对地址和密钥；本次不会自动重试。" : safeError(error, key);
      throw new Error(safeError(new Error(message), key));
    } finally {
      window.clearTimeout(timer); signal?.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }
  private async request(source: ApiSource, key: string, url: string, body?: unknown, timeout = this.timeoutMs): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (source.protocol === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
      if (key) headers["x-api-key"] = key;
    } else if (key) headers.Authorization = `Bearer ${key}`;
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        this.transport({ url, headers, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) }),
        new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("等待响应超时。请求可能仍在服务端处理，请稍后再试。")), timeout); }),
      ]);
      return this.decode(response);
    } catch (error) { throw new Error(safeError(error, key)); }
    finally { if (timer) window.clearTimeout(timer); }
  }
  private decode(response: HttpResponse): Record<string, unknown> {
      let data: unknown;
      if (response.status >= 200 && response.status < 300 && !response.text.trim()) throw new Error("接口返回为空，请检查地址或服务状态。");
      try { data = JSON.parse(response.text); } catch {
        if (response.status >= 200 && response.status < 300) throw new Error(`HTTP ${response.status}：响应不是 JSON，请检查请求地址。`);
      }
      const value = record(data), error = record(value.error);
      if (response.status < 200 || response.status >= 300 || value.error) {
        const detail = typeof error.message === "string" ? error.message : typeof value.message === "string" ? value.message : typeof value.error === "string" ? value.error : !data ? response.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "请检查地址、密钥及模型权限。";
        const hint = response.status === 503 ? /(?:error(?:\s+code)?\s*[:：]?\s*1102\b|Worker exceeded resource limits)/i.test(detail)
          ? "上游网关返回 Cloudflare 1102（Worker 资源超限）。请稍后重试或切换来源；持续出现时需要服务提供方排查。"
          : "上游服务暂时不可用，请稍后重试或切换来源。" : response.status === 401 ? "认证失败，请检查 API 密钥。" : response.status === 403 ? "访问被拒绝，请检查密钥权限或服务商限制。" : response.status === 404 ? "接口地址不存在，请检查地址和路径。" : response.status === 429 ? "请求受限或额度不足，请稍后重试或检查账户。" : "";
        throw new Error(`HTTP ${response.status}：${hint}${hint && detail ? "\n原始错误：" : ""}${detail}`);
      }
      if (!isRecord(data)) throw new Error("接口返回了无效数据。");
      return data;
  }
  async listModels(source: ApiSource, key: string): Promise<string[]> {
    const base = endpoint(source, "models");
    let url = base;
    const ids = new Set<string>();
    const cursors = new Set<string>();
    for (let page = 0; page < 50; page++) {
      const data = await this.request(source, key, url);
      if (!Array.isArray(data.data)) throw new Error("模型列表格式不兼容；可以手动填写模型名称。");
      const models: unknown[] = data.data;
      for (const model of models) { const id = record(model).id; if (typeof id === "string" && id.trim()) ids.add(id.trim()); }
      if (!data.has_more) {
        if (!ids.size) throw new Error("模型列表为空，接口没有返回可用模型；可手动添加模型。");
        return [...ids].sort((a, b) => a.localeCompare(b));
      }
      const cursor = data.last_id ?? record(data.data[data.data.length - 1]).id;
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error("模型分页未正确推进，请检查服务商接口或手动添加。");
      cursors.add(cursor);
      const next = new URL(base);
      next.searchParams.set("after_id", cursor);
      url = next.href;
    }
    throw new Error("模型列表超过 50 页，请使用更具体的模型列表地址或手动添加。");
  }
  async test(source: ApiSource, key: string, model: string): Promise<{ reply: string; ms: number }> {
    if (!model.trim()) throw new Error("请先选择或填写模型名称。");
    const start = Date.now();
    const data = await this.request(source, key, endpoint(source, "chat"), {
      model: model.trim(), messages: [{ role: "user", content: "Hello" }], stream: false,
      ...(source.protocol === "anthropic" ? { max_tokens: 128 } : { max_completion_tokens: 128 }),
    });
    let reply: string;
    if (source.protocol === "anthropic") {
      if (!Array.isArray(data.content)) throw new Error("返回格式不是 Anthropic Messages 响应。");
      reply = data.content.map(part => record(part)).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
    } else {
      const message = record(Array.isArray(data.choices) ? data.choices[0] : undefined).message;
      if (!isRecord(message)) throw new Error("返回格式不是 OpenAI Chat Completions 响应。");
      reply = typeof message.content === "string" ? message.content : "";
    }
    return { reply: reply.slice(0, 1200) || "接口已返回有效响应，但没有文本内容（可能达到输出上限）。", ms: Date.now() - start };
  }
}
