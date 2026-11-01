import { blobSha } from "./linkDiff";

/** A plugin-owned snapshot, never a configured remote or branch upstream. */
export async function remoteSnapshotRef(url: string, branch: string): Promise<string> {
  return "refs/simple-one/remotes/" + await blobSha(new TextEncoder().encode(JSON.stringify([url.trim(), branch])));
}
