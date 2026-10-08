import type SimplePlugin from "../../main";
import { githubJson } from "../sync/githubApi";
import type { ShareManifest } from "./model";
import { ShareRepository } from "./repository";

export function canFallbackToApi(error: unknown, method = "GET"): boolean {
  const message = String(error);
  if (/(?:\bHTTP\s+(?:401|403)\b|\b(?:TLS|SSL)\s+handshake\b|handshake (?:failed|timeout)|握手失败|failed to connect|could not connect|连接失败|connection refused|network is unreachable|no such host|dial tcp)/i.test(message)) return true;
  return method === "GET" && /connection (?:reset|timed out)/i.test(message);
}

async function apiRequest(token: string, args: string[], input?: string): Promise<string> {
  const methodIndex = args.indexOf("--method");
  return JSON.stringify(await githubJson(token, "/" + args[0], methodIndex >= 0 ? args[methodIndex + 1] : "GET", input ? JSON.parse(input) : undefined));
}

/** CLI and HTTP publish the same generated tree; only the authorization transport differs. */
export class ApiShareRepository extends ShareRepository {
  constructor(host: SimplePlugin, site: ShareManifest["site"], private token: string) { super(host, site); }
  async api(args: string[], input?: string): Promise<string> { return apiRequest(this.token, args, input); }
}

/** Use CLI first, then switch this publish job to the local token on auth or transport failures. */
export class FallbackShareRepository extends ShareRepository {
  private useApi = false;
  constructor(host: SimplePlugin, site: ShareManifest["site"], private token: string, private onFallback: () => void) { super(host, site); }
  async api(args: string[], input?: string): Promise<string> {
    if (this.useApi) return apiRequest(this.token, args, input);
    try { return await super.api(args, input); }
    catch (error) {
      const methodIndex = args.indexOf("--method");
      if (!this.token || !canFallbackToApi(error, methodIndex >= 0 ? args[methodIndex + 1] : "GET")) throw error;
      const result = await apiRequest(this.token, args, input);
      this.useApi = true;
      this.onFallback();
      return result;
    }
  }
}
