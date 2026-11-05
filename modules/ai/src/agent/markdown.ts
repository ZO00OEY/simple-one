/** Obsidian tables need a block boundary; preserve fenced code and stored text. */
export function prepareChatMarkdown(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    }
    const separator = lines[i + 1]?.trim().replace(/^\|/, "").replace(/\|$/, "");
    if (!fence && line.includes("|") && separator?.includes("|") &&
        separator.split("|").every(cell => /^\s*:?-{3,}:?\s*$/.test(cell)) &&
        output.length && output[output.length - 1].trim()) output.push("");
    output.push(line);
  }
  return output.join("\n");
}
