import { requestUrl, type RequestUrlResponse } from "obsidian";

/** HTTP transport shared by lightweight private sync and the public share subrepository. */
export async function githubResponse(token: string, path: string, method = "GET", body?: unknown, raw = false, timeoutMs = 60000): Promise<RequestUrlResponse> {
  if (!token.trim()) throw new Error("请先填写 GitHub Token。");
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("GitHub API 路径不正确。");
  let timer: number | undefined;
  try {
    return await Promise.race([
      requestUrl({ url: `https://api.github.com${path}`, method,
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), throw: false }),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("GitHub 请求超时；下次操作会核对提交结果。")), timeoutMs); })
    ]);
  } finally { if (timer !== undefined) window.clearTimeout(timer); }
}
export async function githubJson<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await githubResponse(token, path, method, body);
  if (response.status < 200 || response.status >= 300) {
    const message = response.status === 401 ? "Token 无效或已过期" : response.status === 403 || response.status === 429 ? "请检查 Token 权限或请求限额" : "请求未完成，请重新检查远端状态";
    throw new Error(`GitHub HTTP ${response.status}：${message}。`);
  }
  return response.json as T;
}
