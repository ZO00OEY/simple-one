export const FORMAT_TOOLS = ["textColor", "bold", "italic", "underline", "strike", "highlight", "heading", "quote"] as const;
export type FormatTool = typeof FORMAT_TOOLS[number];

export function orderedFormatTools(order: string[]): FormatTool[] {
  const migrated = order.map(id => id === "color" ? "textColor" : id);
  const result = [...new Set([...migrated, ...FORMAT_TOOLS])].filter((id): id is FormatTool => FORMAT_TOOLS.some(tool => tool === id));
  if (!order.includes("highlight")) { result.splice(result.indexOf("highlight"), 1); result.splice(result.indexOf("underline") + 1, 0, "highlight"); }
  if (!order.includes("textColor")) { result.splice(result.indexOf("textColor"), 1); result.splice(result.indexOf("bold"), 0, "textColor"); }
  if (order.includes("link")) {
    result.splice(result.indexOf("heading"), 1); result.splice(result.indexOf("quote"), 1);
    result.push("heading", "quote");
  }
  return result;
}

export function toggleInlineFormat(text: string, marker: string): string {
  if (text.startsWith(marker) && text.endsWith(marker) && text.length > marker.length * 2) return text.slice(marker.length, -marker.length);
  return marker + text + marker;
}

function inlineHtmlText(text: string): string {
  // Inline HTML must not absorb paragraph boundaries or Markdown links/formatting.
  if (/\n|[<>`]|\*\*|__|~~|==|\[[^\]]*\]\(|\[\[/.test(text)) throw new Error("彩色格式请用于单段纯文字，避免影响已有链接或格式。");
  return text.replace(/&/g, "&amp;");
}

export function colorSelection(text: string, property: "color" | "background-color", color: string): string {
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) throw new Error("无效的颜色值");
  const escaped = inlineHtmlText(text);
  return property === "background-color"
    ? `<mark style="background: ${color};">${escaped}</mark>`
    : `<span style="color: ${color};">${escaped}</span>`;
}

export function colorInlineFormat(text: string, tool: "bold" | "italic" | "strike" | "underline", color: string): string {
  const span = colorSelection(text, "color", color);
  const tag = { bold: "strong", italic: "em", strike: "del", underline: "u" }[tool];
  const html = span.replace(/^<span /, `<${tag} `).replace(/<\/span>$/, `</${tag}>`);
  return tool === "italic" ? html.replace(';">', '; font-style: italic;">') : html;
}

export type InlineFormatTool = "bold" | "italic" | "strike" | "underline" | "highlight";

/** Leave fenced blocks and exact-length inline code delimiters untouched. */
function outsideCode(text: string, transform: (plain: string) => string): string {
  const ranges: [number, number][] = [];
  const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let open: { start: number; marker: string } | undefined;
  for (const match of text.matchAll(fences)) {
    if (open) {
      if (match[1][0] === open.marker[0] && match[1].length >= open.marker.length && !match[2].trim()) {
        ranges.push([open.start, match.index + match[0].length]); open = undefined;
      }
    } else if (match[1][0] !== "`" || !match[2].includes("`")) open = { start: match.index, marker: match[1] };
  }
  if (open) ranges.push([open.start, text.length]);
  const inline = (plain: string): string => {
    const runs = [...plain.matchAll(/`+/g)];
    let cursor = 0, result = "";
    for (let index = 0; index < runs.length; index++) {
      const start = runs[index];
      const endIndex = runs.findIndex((candidate, at) => at > index && candidate[0].length === start[0].length);
      if (endIndex < 0) continue;
      const end = runs[endIndex], finish = end.index + end[0].length;
      result += transform(plain.slice(cursor, start.index)) + plain.slice(start.index, finish);
      cursor = finish; index = endIndex;
    }
    return result + transform(plain.slice(cursor));
  };
  let cursor = 0, result = "";
  for (const [start, end] of ranges) { result += inline(text.slice(cursor, start)) + text.slice(start, end); cursor = end; }
  return result + inline(text.slice(cursor));
}

/** Remove only this tool's local color overrides, preserving other markup and code examples. */
export function restoreThemeStyles(text: string, tool: InlineFormatTool | "textColor"): { text: string; changed: boolean } {
  const tags = { bold: ["strong", "b"], italic: ["em", "i"], strike: ["del", "s"], underline: ["u"], highlight: ["mark"], textColor: ["span"] }[tool];
  const marker = { bold: "**", italic: "*", strike: "~~", underline: "", highlight: "==", textColor: "" }[tool];
  const stacks = new Map<string, { closing: string; decode: boolean }[]>();
  let decodeDepth = 0;
  let changed = false;
  const result = outsideCode(text, plain => plain.replace(/<\/?([a-z][\w-]*)\b[^>]*>|[^<]+|</gi, (full: string, rawTag: string | undefined) => {
    if (!rawTag) return decodeDepth ? full.replace(/&amp;/g, "&") : full;
    if (!tags.includes(rawTag.toLowerCase())) return full;
    const tag = rawTag.toLowerCase(), stack = stacks.get(tag) ?? [];
    stacks.set(tag, stack);
    if (full.startsWith("</")) {
      const entry = stack.pop(); if (entry?.decode) decodeDepth--;
      return entry?.closing ?? full;
    }
    let removed = false;
    const opening = full.replace(/\s+style\s*=\s*(["'])(.*?)\1/i, (_attribute: string, quote: string, css: string) => {
      const kept = css.split(";").filter(declaration => {
        const key = declaration.split(":")[0].trim().toLowerCase();
        if (key === "color" || tool === "highlight" && ["background", "background-color"].includes(key)) { removed = true; return false; }
        return !!declaration.trim();
      });
      return kept.length ? ` style=${quote}${kept.join(";")};${quote}` : "";
    });
    changed ||= removed;
    if (removed && new RegExp(`^<${tag}\\s*>$`, "i").test(opening) && tool !== "underline") {
      stack.push({ closing: marker, decode: true }); decodeDepth++; return marker;
    }
    stack.push({ closing: `</${tag}>`, decode: false }); return opening;
  }));
  return { text: result, changed };
}

export function useThemeStyle(text: string, tool: InlineFormatTool | "textColor"): string {
  const restored = restoreThemeStyles(text, tool);
  if (restored.changed || tool === "textColor") return restored.text;
  return applyInlineStyle(text, tool, "theme");
}

export function clearSpecialFormatting(text: string): string {
  const tags = new Set(["span", "strong", "b", "em", "i", "del", "s", "u", "mark"]);
  const stacks = new Map<string, boolean[]>();
  let decodeDepth = 0;
  return outsideCode(text, plain => plain.replace(/<\/?([a-z][\w-]*)\b[^>]*>|[^<]+|</gi, (full: string, rawTag: string | undefined) => {
    if (!rawTag) return decodeDepth ? full.replace(/&amp;/g, "&") : full;
    if (!tags.has(rawTag.toLowerCase())) return full;
    const tag = rawTag.toLowerCase(), stack = stacks.get(tag) ?? [];
    stacks.set(tag, stack);
    if (full.startsWith("</")) { if (stack.pop()) { decodeDepth--; return ""; } return full; }
    const removable = new RegExp(`^<${tag}(?:\\s+style\\s*=\\s*(["'])[^"']*\\1)?\\s*>$`, "i").test(full);
    stack.push(removable); if (removable) decodeDepth++; return removable ? "" : full;
  }));
}

export function highlightSelection(text: string, foreground: string, background: string): string {
  for (const color of [foreground, background]) if (color !== "theme" && !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) throw new Error("无效的颜色值");
  if (foreground === "theme" && background === "theme") return useThemeStyle(text, "highlight");
  text = restoreThemeStyles(text, "highlight").text;
  if (text.startsWith("==") && text.endsWith("==")) text = text.slice(2, -2);
  const css = [foreground === "theme" ? "" : `color: ${foreground};`, background === "theme" ? "" : `background: ${background};`].filter(Boolean).join(" ");
  return `<mark style="${css}">${inlineHtmlText(text)}</mark>`;
}

export function applyInlineStyle(text: string, tool: InlineFormatTool, color = "theme"): string {
  const tag = { bold: "strong", italic: "em", strike: "del", underline: "u", highlight: "mark" }[tool];
  const marker = { bold: "**", italic: "*", strike: "~~", underline: "", highlight: "==" }[tool];
  const html = new RegExp(`^<${tag}(?: style="[^"]*")?>([\\s\\S]*)<\\/${tag}>$`, "i").exec(text);
  if (html) text = html[1].replace(/&amp;/g, "&");
  const native = !!marker && text.startsWith(marker) && text.endsWith(marker) && text.length > marker.length * 2 && (marker !== "*" || !text.startsWith("**"));
  if (color === "theme") {
    if (tool === "underline") return html && !/^<u style=/i.test(html[0]) ? text : `<u>${inlineHtmlText(text)}</u>`;
    return toggleInlineFormat(text, marker);
  }
  if (native) text = text.slice(marker.length, -marker.length);
  return tool === "highlight" ? colorSelection(text, "background-color", color) : colorInlineFormat(text, tool, color);
}
