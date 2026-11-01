/** A paragraph reference uses a persistent Obsidian block ID, not selected text. */
export function paragraphLinkTarget(text: string, selectedLine: number, id: string) {
  const lines = text.split("\n");
  if (!lines[selectedLine]?.trim()) throw new Error("请选中正文段落");
  let fence: string | undefined;
  for (let line = 0; line <= selectedLine; line++) {
    const marker = lines[line].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    }
    if (line === selectedLine && (fence || marker)) throw new Error("请选择代码块之外的正文段落");
  }
  const listItem = /^\s*(?:[-+*]|\d+[.)])\s+/;
  const boundary = (line: string) => !line.trim() || /^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,})/.test(line);
  let start = selectedLine, end = selectedLine;
  while (start > 0 && !boundary(lines[start - 1]) && !listItem.test(lines[start])) start--;
  while (end + 1 < lines.length && !boundary(lines[end + 1]) && !listItem.test(lines[end + 1])) end++;
  const existing = lines[end].match(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/)
    || lines[end + 2]?.match(/^\^([A-Za-z0-9-]+)\s*$/);
  if (existing) return { id: existing[1], endLine: end, suffix: "" };
  const standalone = /^\s*>/.test(lines[start]) || lines.slice(start, end + 1).some(line => line.includes("|"));
  return { id, endLine: end, suffix: standalone ? `\n\n^${id}\n` : ` ^${id}` };
}
