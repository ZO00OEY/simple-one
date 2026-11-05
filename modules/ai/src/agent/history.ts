import type { Session } from "./types";
export function noteHistory(sessions: Session[]): { path: string; updated: number }[] {
  const notes = new Map<string, number>();
  const changes = sessions.flatMap(s => s.changes.filter(c => c.state === "done").map(c => ({ c, updated: c.completedAt ?? s.updated }))).sort((a, b) => a.updated - b.updated);
  for (const { c, updated } of changes) {
    if (c.kind.startsWith("folder-")) {
      if (c.kind === "folder-delete" || c.kind === "folder-move") for (const [path, time] of [...notes]) {
        if (!path.startsWith(c.path + "/")) continue;
        notes.delete(path);
        if (c.kind === "folder-move" && c.target) notes.set(c.target + path.slice(c.path.length), Math.max(time, updated));
      }
      continue;
    }
    if (c.kind === "move" && c.target) notes.delete(c.path);
    notes.set(c.target ?? c.path, updated);
  }
  return [...notes].map(([path, updated]) => ({ path, updated })).sort((a, b) => b.updated - a.updated);
}
export function historyGroups(sessions: Session[], query = "", now = Date.now()): { title: string; sessions: Session[] }[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const titles = ["今天", "7 天内", "30 天内", "更早"];
  const groups = titles.map(title => ({ title, sessions: [] as Session[] }));
  const search = query.trim().toLowerCase();
  for (const s of [...sessions].sort((a,b) => b.updated - a.updated)) {
    if (!s.messages.length && !s.draft && !s.images.length && !s.files?.length && !s.changes.length) continue;
    if (!(s.title + " " + s.messages.filter(m => m.role !== "tool").map(m => m.text).join(" ")).toLowerCase().includes(search)) continue;
    const age = Math.max(0, start.getTime() - s.updated);
    const index = s.updated >= start.getTime() ? 0 : age < 7 * 86400000 ? 1 : age < 30 * 86400000 ? 2 : 3;
    groups[index].sessions.push(s);
  }
  return groups.filter(g => g.sessions.length);
}
