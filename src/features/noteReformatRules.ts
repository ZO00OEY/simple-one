import type { TextReformatRule } from "../types";

export function applyTextReformatRules(text: string, rules: TextReformatRule[]): string {
  let output = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue;
    try {
      const regex = new RegExp(rule.pattern, normalizeRegexFlags(rule.flags));
      const replacement = decodeReplacement(rule.replaceWith);
      output = isBlankLineCompressionRule(rule)
        ? replaceOutsideProtectedBlocks(output, (part) => part.replace(regex, replacement))
        : replaceOutsideProtectedBlocks(output, (part) => replaceInsideParagraphs(part, regex, replacement));
    } catch {
      // Invalid user regex: skip this rule and continue with the rest.
    }
  }

  return output;
}

function replaceOutsideProtectedBlocks(text: string, transform: (part: string) => string): string {
  return splitProtectedBlocks(text)
    .map((part) => part.protected ? part.text : transform(part.text))
    .join("");
}

function splitProtectedBlocks(text: string): Array<{ text: string; protected: boolean }> {
  if (!text.startsWith("---\n")) return [{ text, protected: false }];

  const endMatch = /\n---(?:\n|$)/.exec(text.slice(4));
  if (!endMatch) return [{ text, protected: false }];

  const endIndex = 4 + endMatch.index + endMatch[0].length;
  return [
    { text: text.slice(0, endIndex), protected: true },
    { text: text.slice(endIndex), protected: false },
  ];
}

function replaceInsideParagraphs(text: string, regex: RegExp, replacement: string): string {
  return text
    .split(/(\n{2,})/)
    .map((part) => isProtectedSeparator(part) ? part : replaceInsideUrlProtectedText(part, regex, replacement))
    .join("");
}

function isProtectedSeparator(value: string): boolean {
  return /^\n{2,}$/.test(value);
}

function replaceInsideUrlProtectedText(text: string, regex: RegExp, replacement: string): string {
  const protectedLines: string[] = [];
  const protectedText = text.replace(/(^|\n)https?:\/\/[^\n]*(?:\n|$)/gi, (line) => {
    const token = `\u0000SIMPLE_URL_LINE_${protectedLines.length}\u0000`;
    protectedLines.push(line);
    return token;
  });
  const replaced = protectedText.replace(regex, replacement);
  return replaced.replace(/\u0000SIMPLE_URL_LINE_(\d+)\u0000/g, (_, index: string) => {
    return protectedLines[Number(index)] ?? "";
  });
}

function isBlankLineCompressionRule(rule: TextReformatRule): boolean {
  return rule.name.includes("压缩连续空行") || /\\n\{[23],?\}/.test(rule.pattern);
}

function normalizeRegexFlags(flags: string): string {
  const unique = new Set((flags || "g").replace(/[^dgimsuvy]/g, "").split(""));
  if (!unique.has("g")) unique.add("g");
  return Array.from(unique).join("");
}

function decodeReplacement(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}
