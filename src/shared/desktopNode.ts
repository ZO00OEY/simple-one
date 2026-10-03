// Describe only the Node APIs used by desktop features. The community scanner
// does not provide Node ambient types; these contracts also keep mobile imports safe.
export interface NodeEntry { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export interface NodeStat { size: number; mode: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export interface NodeFiles {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, value: string, encoding: "utf8"): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<NodeEntry[]>;
  stat(path: string): Promise<NodeStat>;
  lstat(path: string): Promise<NodeStat>;
  realpath(path: string): Promise<string>;
  access(path: string): Promise<void>;
}
export interface NodeFs { promises: NodeFiles; createReadStream(path: string): AsyncIterable<unknown> }
export interface NodePath { sep: string; join(...parts: string[]): string; resolve(...parts: string[]): string; relative(from: string, to: string): string; isAbsolute(path: string): boolean }
interface NodeHash { update(value: string | Uint8Array): NodeHash; digest(encoding: "hex"): string }
export interface NodeCrypto { createHash(algorithm: string): NodeHash }
interface OutputStream { on(event: "data", callback: (chunk: unknown) => void): void }
interface InputStream { on(event: "error", callback: () => void): void; end(value: string): void }
export interface NodeCommands {
  execFile(program: string, args: string[], options: { cwd: string; env: Record<string, string | undefined>; windowsHide: boolean; timeout: number; maxBuffer: number; signal?: AbortSignal }, callback: (error: Error | null, stdout: string, stderr: string) => void): { stdout?: OutputStream | null; stderr?: OutputStream | null; stdin?: InputStream | null };
}
export const desktopProcess = typeof process === "undefined" ? undefined : process as unknown as { versions?: { node?: string }; platform: string; env: Record<string, string | undefined> };
export function base64Bytes(value: string): Uint8Array { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
