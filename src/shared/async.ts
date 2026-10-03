import { Notice } from "obsidian";

export function reportError(error: unknown): void {
  console.error("Simple One:", error);
  new Notice(`操作失败：${error instanceof Error ? error.message : String(error)}`);
}

/** Adapt an async action to a synchronous DOM callback without losing errors. */
export function runAsync<T extends unknown[]>(action: (...args: T) => Promise<unknown>): (...args: T) => void {
  return (...args) => { void action(...args).catch(reportError); };
}
