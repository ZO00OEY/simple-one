import type { DataAdapter } from "obsidian";
import ignore from "ignore";
import { defaultSyncIgnorePatterns, shouldIgnore } from "./dirty";
import type { MobileOptions } from "./linkDiff";

const start = (name: string) => `# >>> simple-one:${name}`;
const end = (name: string) => `# <<< simple-one:${name}`;
export const LOCAL_IGNORE_VERSION = 1;

export function fixedIgnoreRules(configDir: string): string[] {
  const rules = ["/.gitignore", ".git", ".git/", "node_modules/", ".gitshare/", ".trash/",
    `${configDir}/cache/`, `${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`,
    `${configDir}/workspaces/`, `${configDir}/trash/`, ".codex/", ".claudian/sessions/"];
  for (const id of ["simple-one", "simple-link"]) {
    for (const name of ["sync-local.json", "sync-api-local.json", "sync-log.json", "share-local.json", "link-state.json", "mobile-ignore.json"]) {
      rules.push(`${configDir}/plugins/${id}/${name}*`);
    }
    if (id === "simple-link") rules.push(`${configDir}/plugins/${id}/data.json*`);
  }
  rules.push(`${configDir}/plugins/simple-one/data.json.*`, `${configDir}/plugins/simple-one/data.json~*`,
    `${configDir}/plugins/simple-one/data.json-*`, `${configDir}/plugins/simple-one/data.json_*`,
    `${configDir}/plugins/simple-one-sync/data.json*`, `${configDir}/plugins/zoey-sync-test/data.json*`);
  return rules;
}

export function isFixedIgnored(path: string, configDir: string): boolean {
  return shouldIgnore(path, fixedIgnoreRules(configDir), configDir);
}

export function rootIgnoreMatcher(text: string, configDir: string): (path: string) => boolean {
  const fixed = ignore().add(fixedIgnoreRules(configDir));
  const rules = ignore().add(text);
  return path => path.split("/").includes(".git") || fixed.ignores(path) || rules.ignores(path);
}

/** Root rules alone govern the private vault; child public-repository rules are not imported. */
export function legacyScopeRules(options?: MobileOptions): string[] {
  if (!options) return [];
  const rules = [...options.ignorePatterns];
  if (!options.syncImages) rules.push(...["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "avif", "heic", "heif", "apng"].map(ext => `*.${ext}`));
  // The config directory is supplied by the caller when replacing this placeholder.
  if (!options.syncPlugins) rules.push("{config}/plugins/");
  else if (options.plugins.includes("*")) rules.push(...options.plugins.filter(id => id.startsWith("!")).map(id => `{config}/plugins/${id.slice(1)}/`));
  else {
    rules.push("{config}/plugins/*");
    for (const id of options.plugins) rules.push(`!{config}/plugins/${id}/`);
  }
  return rules;
}

function block(name: string, content: string, eol: string): string {
  return [start(name), content.replace(/\r?\n/g, eol).replace(/[\r\n]+$/, ""), end(name)].join(eol);
}

function preserveUserLines(content: string, configDir: string): string {
  return content.split(/\r?\n/).map(line => {
    const rule = line.trim();
    const path = rule.slice(1).replace(/^\//, "");
    if (rule.startsWith("!") && !/[?*[\\]/.test(path) && path && isFixedIgnored(path, configDir)) {
      return `# 固定保护：此放开规则不生效，原文保留 ${line}`;
    }
    return line;
  }).join("\n");
}

/** Keep every user line in order; generated protection is last, so !** still works for ordinary files. */
export function organizedLocalIgnore(existing: string, configDir: string, legacy: readonly string[] = []): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const sections = new Map<string, string>();
  const outside: string[] = [];
  let current = "";
  for (const line of existing.split(/\r?\n/)) {
    const opening = /^# >>> simple-one:(recommended|original|custom|fixed)$/.exec(line);
    if (opening) { if (current || sections.has(opening[1])) throw new Error(".gitignore 分区标记不完整，请先修复后重试。"); current = opening[1]; sections.set(current, ""); continue; }
    if (line === end(current) && current) { current = ""; continue; }
    if (current) sections.set(current, sections.get(current)! + line + "\n");
    else if (!/^# Simple One 本机忽略规则 v\d+/.test(line) && !line.startsWith("# 固定保护在末尾覆盖放开规则")) outside.push(line);
  }
  if (current) throw new Error(".gitignore 分区标记不完整，请先修复后重试。");
  const managed = sections.size > 0;
  const original = managed ? sections.get("original") ?? "" : existing;
  const custom = managed ? [sections.get("custom") ?? "", outside.join("\n")].filter(text => text.trim()).join("\n") : legacy.join("\n");
  return [`# Simple One 本机忽略规则 v${LOCAL_IGNORE_VERSION}；仅本机使用，不从云端合并。`,
    block("recommended", sections.get("recommended") ?? defaultSyncIgnorePatterns(configDir).join("\n"), eol),
    block("original", preserveUserLines(original, configDir), eol), block("custom", preserveUserLines(custom, configDir), eol),
    "# 固定保护在末尾覆盖放开规则；!** 等宽泛规则仍对普通内容有效。",
    block("fixed", fixedIgnoreRules(configDir).join("\n"), eol), ""].join(eol);
}

export async function readRootIgnore(adapter: DataAdapter): Promise<string> {
  return await adapter.exists(".gitignore") ? await adapter.read(".gitignore") : "";
}

/** Preserve the old file and stop the operation if a verified write cannot complete. */
export async function writeRootIgnore(adapter: DataAdapter, expected: string, next: string, configDir: string): Promise<void> {
  if (await readRootIgnore(adapter) !== expected) throw new Error("本机 .gitignore 已变化，请重新预览规则。");
  if (expected === next) return;
  const recovery = `${configDir}/plugins/simple-one/sync-local.json.gitignore-recovery`;
  await adapter.write(recovery, expected);
  try {
    await adapter.write(".gitignore", next);
    if (await readRootIgnore(adapter) !== next) throw new Error("本机 .gitignore 写入校验失败。");
  } catch (error) {
    throw new Error(`.gitignore 写入未完成，已停止同步；原文保存在 ${recovery}。${String(error)}`);
  }
}
