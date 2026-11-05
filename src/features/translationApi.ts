import { requestUrl } from "obsidian";
import type { TranslationApiSettings } from "../types";

export function translationEndpoint(api: TranslationApiSettings, purpose: "chat" | "models"): string {
  const value = purpose === "models" && api.modelsUrl.trim() ? api.modelsUrl : api.url;
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("请填写完整的 HTTP/HTTPS 请求地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("地址只支持 HTTP/HTTPS，不能包含用户名、密码或片段。");
  let path = url.pathname.replace(/\/+$/, "");
  if (purpose === "models" && api.modelsUrlMode === "full" && !api.modelsUrl.trim()) throw new Error("不自动补全，需填写完整模型列表地址。");
  if (purpose === "models" && api.modelsUrl.trim() && api.modelsUrlMode !== "base") return url.href;
  if (purpose === "chat" && api.urlMode === "full") return value.trim();
  path = path.replace(/\/(chat\/completions|messages|models)$/, "");
  if (!/\/v\d+(?:beta\d*)?$/.test(path)) path += "/v1";
  url.pathname = path + (purpose === "models" ? "/models" : api.protocol === "anthropic" ? "/messages" : "/chat/completions");
  return url.href;
}

/** Save completed explicit addresses; an empty automatic model URL continues following the request URL. */
export function completeTranslationAddresses(api: TranslationApiSettings): TranslationApiSettings {
  return { ...api, url: translationEndpoint(api, "chat"),
    modelsUrl: api.modelsUrl.trim() || api.modelsUrlMode === "full" ? translationEndpoint(api, "models") : "" };
}

function aborted(): Error { const error = new Error("已取消翻译"); error.name = "AbortError"; return error; }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
async function apiRequest(api: TranslationApiSettings, key: string, purpose: "chat" | "models", body?: object, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw aborted();
  const url = translationEndpoint(api, purpose);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (api.protocol === "anthropic") { headers["anthropic-version"] = "2023-06-01"; if (key) headers["x-api-key"] = key; }
  else if (key) headers.Authorization = `Bearer ${key}`;
  let timer: number | undefined;
  let cancel: (() => void) | undefined;
  try {
    // Obsidian's transport bypasses browser CORS; cancellation discards its result without changing the note.
    const response = await Promise.race([
      requestUrl({ url, method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), throw: false }),
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(aborted()); signal?.addEventListener("abort", cancel, { once: true });
        timer = window.setTimeout(() => reject(new Error("请求超时，请检查地址或稍后重试。")), 120000);
      }),
    ]);
    if (signal?.aborted) throw aborted();
    let data: unknown;
    try { data = JSON.parse(response.text) as unknown; } catch { /* Preserve HTTP errors even when the body is not JSON. */ }
    const result = record(data), failure = record(result.error);
    if (response.status < 200 || response.status >= 300 || result.error) {
      const hint = response.status === 401 ? "认证失败，请检查 API 密钥。" : response.status === 403 ? "访问被拒绝，请检查密钥权限或服务商限制。" : response.status === 404 ? "接口地址不存在，请检查地址和路径。" : response.status === 429 ? "请求受限或额度不足，请稍后重试或检查账户。" : response.status >= 500 ? "服务端错误，请稍后重试。" : "接口返回错误，请检查配置。";
      const detail = typeof failure.message === "string" ? failure.message : typeof result.message === "string" ? result.message : typeof result.error === "string" ? result.error : !data ? response.text.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim() : "";
      throw new Error(`HTTP ${response.status}：${hint}${detail ? "\n接口返回：" + detail : ""}`);
    }
    if (!response.text.trim()) throw new Error("接口返回为空，请检查列表地址或服务状态。");
    if (!data || typeof data !== "object") throw new Error("接口没有返回有效的 JSON 数据，请检查请求地址。");
    return data;
  } catch (error) {
    if (signal?.aborted) throw aborted();
    const message = error instanceof Error ? error.message : "API 请求失败";
    throw new Error((key ? message.split(key).join("[已隐藏密钥]") : message).replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]").slice(0, 400));
  } finally { if (timer) window.clearTimeout(timer); if (cancel) signal?.removeEventListener("abort", cancel); }
}
export function normalizeTranslationModels(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(value => value && value.length <= 200 && ![...value].some(character => character.charCodeAt(0) < 32)))].slice(0, 1000);
}
export async function fetchTranslationModels(api: TranslationApiSettings, key: string, signal?: AbortSignal): Promise<string[]> {
  const data = await apiRequest(api, key, "models", undefined, signal);
  const result = record(data);
  const rows: unknown = Array.isArray(data) ? data : result.data ?? result.models;
  if (!Array.isArray(rows)) throw new Error("返回数据中没有模型列表；请检查列表地址，也可手动添加模型 ID。");
  const models = normalizeTranslationModels(rows.map((row: unknown) => { const item = record(row); return typeof row === "string" ? row : typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : ""; }));
  if (!models.length) throw new Error("模型列表为空，接口没有返回可用模型；可手动添加模型 ID。");
  return models;
}
export async function customTranslate(api: TranslationApiSettings, key: string, input: { modelId: string; text: string; prompt: string }, signal?: AbortSignal): Promise<string> {
  if (!input.modelId.trim()) throw new Error("请先选择翻译模型。");
  const body = api.protocol === "anthropic"
    ? { model: input.modelId, system: input.prompt, messages: [{ role: "user", content: input.text }], max_tokens: 8192, stream: false }
    : { model: input.modelId, messages: [{ role: "system", content: input.prompt }, { role: "user", content: input.text }], stream: false };
  const data = record(await apiRequest(api, key, "chat", body, signal));
  const choice = Array.isArray(data.choices) ? record(data.choices[0]) : {};
  const content = api.protocol === "anthropic" ? data.content : record(choice.message).content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((value: unknown) => { const item = record(value); return item.type === "text" && typeof item.text === "string" ? item.text : ""; }).join("") : "";
  if (!text.trim()) throw new Error("模型没有返回文本，请确认该模型支持文字对话。");
  return text;
}
