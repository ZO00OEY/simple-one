// Recover tables swallowed by a paragraph (for example after a full-width blank line).
// Keep the rendered inline nodes so links, emphasis and code retain their behavior.
const originals = new WeakMap<HTMLElement, HTMLElement>();
const marker = "simple-quoted-tables";

function sliceContents(root: HTMLElement, from: number, to: number): DocumentFragment {
  const range = root.ownerDocument.createRange();
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  let offset = 0;
  let started = false;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const end = offset + (node.textContent?.length ?? 0);
    if (!started && from <= end) { range.setStart(node, from - offset); started = true; }
    if (started && to <= end) { range.setEnd(node, to - offset); return range.cloneContents(); }
    offset = end;
  }
  return root.ownerDocument.createRange().cloneContents();
}

function rowCells(root: HTMLElement, from: number, text: string): Array<[number, number]> {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const protectedPipes = new Set<number>();
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("code, a, .math")) {
      for (let i = 0; i < (node.textContent?.length ?? 0); i++) protectedPipes.add(offset + i);
    }
    offset += node.textContent?.length ?? 0;
  }
  const pipes = [...text.matchAll(/\|/g)].map(match => match.index).filter(index => !protectedPipes.has(from + index));
  if (!pipes.length) return [];
  const bounds = [-1, ...pipes, text.length];
  if (!text.slice(0, pipes[0]).trim()) bounds.shift();
  if (!text.slice(pipes[pipes.length - 1] + 1).trim()) bounds.pop();
  return bounds.slice(1).map((end, index) => [from + bounds[index] + 1, from + end]);
}

export function refreshQuotedTables(root: HTMLElement, enabled: boolean): void {
  const restored = root.matches(`.${marker}`) ? [root] : Array.from(root.querySelectorAll<HTMLElement>(`.${marker}`));
  if (!enabled) {
    for (const element of restored) {
      const original = originals.get(element);
      if (original) element.replaceWith(original);
    }
    return;
  }
  const paragraphs = root.matches("p") ? [root] : Array.from(root.querySelectorAll("p"));
  for (const paragraph of paragraphs) {
    if (!paragraph.closest("blockquote, .callout-content") || paragraph.closest(`.${marker}, pre, code, table`)) continue;
    if (!paragraph.textContent?.includes("|")) continue;
    // Cloning text ranges loses embedded views and their event handlers.
    if (paragraph.querySelector(".internal-embed, img, video, audio, iframe, input, button")) continue;
    const source = paragraph.cloneNode(true) as HTMLElement;
    for (const br of Array.from(source.querySelectorAll("br"))) {
      // Obsidian emits both <br> and a newline for one hard break.
      if (br.nextSibling?.nodeType !== 3 || !br.nextSibling.textContent?.startsWith("\n")) {
        br.after(source.ownerDocument.createTextNode("\n"));
      }
    }
    const text = source.textContent ?? "";
    const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
    const replacement = source.ownerDocument.win.createDiv();
    replacement.className = marker;
    let consumed = 0;
    let found = false;
    for (let i = 0; i + 1 < lines.length; i++) {
      const header = lines[i][0].trimEnd();
      const separator = lines[i + 1][0].trim();
      if (!/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(separator)) continue;
      const cells = rowCells(source, lines[i].index, header);
      const alignments = separator.replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
      if (cells.length !== alignments.length) continue;
      const appendParagraph = (from: number, to: number) => {
        if (to <= from) return;
        const p = source.ownerDocument.win.createEl("p");
        p.append(sliceContents(source, from, to));
        replacement.append(p);
      };
      appendParagraph(consumed, lines[i].index);
      const table = source.ownerDocument.win.createEl("table");
      const head = table.createTHead().insertRow();
      const appendCells = (row: HTMLTableRowElement, ranges: Array<[number, number]>, heading: boolean) => {
        ranges.forEach(([from, to], column) => {
          const cell = source.ownerDocument.win.createEl(heading ? "th" : "td");
          const alignment = alignments[column];
          if (alignment.endsWith(":")) cell.setAttribute("align", alignment.startsWith(":") ? "center" : "right");
          else if (alignment.startsWith(":")) cell.setAttribute("align", "left");
          cell.append(sliceContents(source, from, to));
          row.append(cell);
        });
      };
      appendCells(head, cells, true);
      const body = table.createTBody();
      let end = i + 2;
      while (end < lines.length) {
        const row = rowCells(source, lines[end].index, lines[end][0].trimEnd());
        if (row.length !== cells.length) break;
        appendCells(body.insertRow(), row, false);
        end++;
      }
      replacement.append(table);
      consumed = end < lines.length ? lines[end].index : text.length;
      i = end - 1;
      found = true;
    }
    if (!found) continue;
    if (consumed < text.length) {
      const rest = source.ownerDocument.win.createEl("p");
      rest.append(sliceContents(source, consumed, text.length));
      replacement.append(rest);
    }
    originals.set(replacement, paragraph);
    paragraph.replaceWith(replacement);
  }
}

export function observeQuotedTables(root: HTMLElement, enabled: () => boolean): MutationObserver {
  refreshQuotedTables(root, enabled());
  const observer = new MutationObserver(mutations => {
    if (!enabled()) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) refreshQuotedTables(node as HTMLElement, true);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}
