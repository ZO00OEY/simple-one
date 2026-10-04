import type SimplePlugin from "../../main";
import { githubJson } from "../sync/githubApi";
import type { ShareManifest } from "./model";
import { ShareRepository } from "./repository";

/** CLI and HTTP publish the same generated tree; only the authorization transport differs. */
export class ApiShareRepository extends ShareRepository {
  constructor(host: SimplePlugin, site: ShareManifest["site"], private token: string) { super(host, site); }
  async api(args: string[], input?: string): Promise<string> {
    const methodIndex = args.indexOf("--method");
    return JSON.stringify(await githubJson(this.token, "/" + args[0], methodIndex >= 0 ? args[methodIndex + 1] : "GET", input ? JSON.parse(input) : undefined));
  }
}
