import type { DataAdapter } from "obsidian";
import { newState, type ImageInput, type PrivateState, type Session } from "./types";
import { decodeIndex, decodeMemory, decodePrivateState, decodeSession } from "./storageSchema";

// Only plugin-private storage uses these paths; note tools cannot access them.
export class SessionStore {
  private saved = new Map<string, string>();
  private recovered = new Set<string>();
  private missingSessions = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private cleanupKey = "";
  private indexFields: Record<string, unknown> = {};
  constructor(private adapter: DataAdapter, private root: string, private cleanupFailed?: (error: unknown) => void) {}
  get unavailableSessions(): string[] { return [...this.missingSessions]; }
  private async json<T>(path: string, decode: (value: unknown) => T): Promise<T> {
    for (const candidate of [path, path + ".previous"]) {
      if (!await this.adapter.exists(candidate)) continue;
      try { const text = await this.adapter.read(candidate); const value = decode(JSON.parse(text) as unknown); if (candidate !== path) this.recovered.add(path); else this.saved.set(path, text); return value; } catch { /* Try the previous copy; preserve both files and report failure if neither validates. */ }
    }
    throw new Error(`存储损坏，原文件已保留：${path}`);
  }
  async load(): Promise<PrivateState | undefined> {
    this.missingSessions.clear();
    const indexPath = `${this.root}/index.json`;
    if (!await this.adapter.exists(indexPath) && !await this.adapter.exists(indexPath + ".previous")) return;
    const index = await this.json(indexPath, decodeIndex);
    this.indexFields = index;
    const sessions: Session[] = [];
    for (const id of index.sessions) {
      if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new Error("会话索引格式错误。");
      const path = `${this.root}/sessions/${id}.json`;
      if (!await this.adapter.exists(path) && !await this.adapter.exists(path + ".previous")) {
        // A sync may delete the file without updating the index. Keep its ID so
        // a later restore can bring the conversation back without losing it.
        this.missingSessions.add(id);
        continue;
      }
      sessions.push(await this.json(path, value => decodeSession(value, id)));
    }
    const memory = await this.json(`${this.root}/memory.json`, decodeMemory);
    return { ...newState(), sessions, memory, active: sessions.some(s => s.id === index.active) ? index.active : sessions[0]?.id ?? "" };
  }
  async image(image: ImageInput): Promise<ImageInput> {
    if (image.data) return image;
    if (!image.id || !/^[\w-]+$/.test(image.id)) throw new Error("图片引用无效。");
    return { ...image, data: await this.adapter.read(`${this.root}/images/${image.id}.txt`) };
  }
  save(state: PrivateState): Promise<void> {
    for (const s of state.sessions) {
      for (const item of [...s.images, ...s.files ?? []]) item.addedAt ??= Date.now();
      for (const m of s.messages) for (const item of [...m.images ?? [], ...m.files ?? []]) item.addedAt ??= m.timestamp ?? s.updated;
    }
    // Assign IDs synchronously so subsequent queued snapshots reference the same image.
    for (const s of state.sessions) for (const i of [...s.images, ...s.messages.flatMap(m => m.images ?? [])]) i.id ??= crypto.randomUUID();
    const snapshots = state.sessions.map(s => ({ session: s, json: JSON.stringify(s, (key, value) => key === "data" ? undefined : value), images: [...s.images, ...s.messages.flatMap(m => m.images ?? [])].filter(i => i.data).map(i => ({ ...i })) }));
    const sessionIds = new Set([...state.sessions.map(s => s.id), ...this.missingSessions]);
    const imageIds = new Set(state.sessions.flatMap(s => [...s.images, ...s.messages.flatMap(m => m.images ?? [])].flatMap(i => i.id ? [i.id] : [])));
    const cleanupKey = JSON.stringify([[...sessionIds].sort(), [...imageIds].sort()]);
    const memory = JSON.stringify(state.memory);
    const index = JSON.stringify({ ...this.indexFields, version: 2, active: state.active, sessions: [...state.sessions.map(s => s.id), ...this.missingSessions].filter((id, i, ids) => ids.indexOf(id) === i) });
    const op = this.writes.then(async () => {
      for (const dir of [this.root, `${this.root}/sessions`, `${this.root}/images`]) if (!await this.adapter.exists(dir)) await this.adapter.mkdir(dir);
      const write = async (path: string, text: string) => {
        if (this.saved.get(path) === text) return;
        if (!this.recovered.has(path) && await this.adapter.exists(path)) await this.adapter.write(path + ".previous", await this.adapter.read(path));
        await this.adapter.write(path, text); this.saved.set(path, text); this.recovered.delete(path);
      };
      for (const snapshot of snapshots) {
        for (const image of snapshot.images) {
          const path = `${this.root}/images/${image.id}.txt`;
          if (!await this.adapter.exists(path)) await this.adapter.write(path, image.data);
        }
        await write(`${this.root}/sessions/${snapshot.session.id}.json`, snapshot.json);
        // Release base64 only after the file is durable; UI and requests load it on demand.
        for (const i of [...snapshot.session.images, ...snapshot.session.messages.flatMap(m => m.images ?? [])]) if (snapshot.images.some(saved => saved.id === i.id)) i.data = "";
      }
      await write(`${this.root}/memory.json`, memory);
      await write(`${this.root}/index.json`, index);
      if (cleanupKey !== this.cleanupKey) {
        try {
          await this.cleanup(sessionIds, imageIds, index);
          this.cleanupKey = cleanupKey;
        } catch (error) {
          // The new index is already committed: cleanup failure must not restore
          // deleted conversations or erase their remaining files. Retry next save.
          this.cleanupFailed?.(error);
        }
      }
    });
    this.writes = op.catch(() => {}); return op;
  }
  async cleanAttachments(state: PrivateState, cutoff: number | ((session: Session) => number) = Infinity): Promise<number> {
    // Validate recovery payloads before save can rotate/overwrite them or remove
    // image files. A malformed backup must remain available for manual repair.
    await this.writes;
    for (const s of state.sessions) {
      const path = `${this.root}/sessions/${s.id}.json.previous`;
      if (await this.adapter.exists(path)) decodeSession(JSON.parse(await this.adapter.read(path)) as unknown, s.id);
    }
    for (const name of ["state.json", "state.previous.json"]) {
      const path = `${this.root}/${name}`;
      if (await this.adapter.exists(path)) decodePrivateState(JSON.parse(await this.adapter.read(path)) as unknown, true);
    }
    let removed = 0;
    const strip = (s: Session): number => {
      let count = 0;
      const expiry = typeof cutoff === "function" ? cutoff(s) : cutoff;
      for (const holder of [s, ...s.messages]) {
        const fallback = "timestamp" in holder ? holder.timestamp ?? s.updated : s.updated;
        for (const key of ["images", "files"] as const) {
          const items = holder[key];
          if (!items) continue;
          const retained = items.filter(item => (item.addedAt ?? fallback) > expiry);
          if (retained.length === items.length) continue;
          count += items.length - retained.length;
          // Both attachment arrays share the same lifetime, but have distinct element types.
          if (key === "images") holder.images = retained as ImageInput[];
          else holder.files = retained as NonNullable<Session["files"]>;
        }
      }
      return count;
    };
    for (const s of state.sessions) removed += strip(s);
    await this.save(state);
    const op = this.writes.then(async () => {
      // Scrub recovery snapshots on every pass, including retries after a write failure.
      for (const s of state.sessions) {
        const path = `${this.root}/sessions/${s.id}.json.previous`;
        if (!await this.adapter.exists(path)) continue;
        const backup = decodeSession(JSON.parse(await this.adapter.read(path)) as unknown, s.id);
        if (strip(backup)) await this.adapter.write(path, JSON.stringify(backup));
      }
      // Older installations may still have the pre-migration storage snapshots.
      for (const name of ["state.json", "state.previous.json"]) {
        const path = `${this.root}/${name}`;
        if (!await this.adapter.exists(path)) continue;
        const legacy = decodePrivateState(JSON.parse(await this.adapter.read(path)) as unknown, true);
        let count = 0;
        for (const s of legacy.sessions) count += strip(s);
        if (count) await this.adapter.write(path, JSON.stringify(legacy));
      }
      const index = await this.adapter.read(`${this.root}/index.json`);
      const sessionIds = new Set([...state.sessions.map(s => s.id), ...this.missingSessions]);
      const imageIds = new Set(state.sessions.flatMap(s => [...s.images, ...s.messages.flatMap(m => m.images ?? [])].flatMap(i => i.id ? [i.id] : [])));
      await this.cleanup(sessionIds, imageIds, index);
    });
    this.writes = op.catch(() => {}); await op;
    return removed;
  }
  private async cleanup(sessionIds: Set<string>, imageIds: Set<string>, index: string): Promise<void> {
    for (const [directory, live, pattern] of [
      ["sessions", sessionIds, /^([\w-]+)\.json(?:\.previous)?$/],
      ["images", imageIds, /^([\w-]+)\.txt$/],
    ] as const) {
      const folder = `${this.root}/${directory}`;
      const files = (await this.adapter.list(folder)).files;
      const unused = files.filter(path => {
        if (!path.startsWith(folder + "/")) return false;
        const name = path.slice(folder.length + 1), match = name.match(pattern);
        return !!match && !live.has(match[1]);
      });
      // A recovery index must not resurrect conversations deliberately deleted.
      if (directory === "sessions" && unused.length) await this.adapter.write(`${this.root}/index.json.previous`, index);
      for (const path of unused) {
        await this.adapter.remove(path);
        this.saved.delete(path); this.recovered.delete(path);
      }
    }
  }
}
