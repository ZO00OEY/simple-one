export interface TextPart { common?: string; local?: string; remote?: string }

/** Keep original line endings and every unchanged byte when resolving blocks. */
export function textParts(local: string, remote: string): TextPart[] {
  const a = local.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const b = remote.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const parts: TextPart[] = [];
  if (start) parts.push({ common: a.slice(0, start).join("") });
  const x = a.slice(start, endA), y = b.slice(start, endB);
  // Bound memory on mobile; very large unmatched regions stay one editable block.
  if ((x.length + 1) * (y.length + 1) > 1_000_000) {
    parts.push({ local: x.join(""), remote: y.join("") });
  } else if (x.length || y.length) {
    const width = y.length + 1;
    const table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      table[i * width + j] = x[i] === y[j] ? 1 + table[(i + 1) * width + j + 1]
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    let i = 0, j = 0, common = "", left = "", right = "";
    const flushDiff = () => { if (left || right) parts.push({ local: left, remote: right }); left = right = ""; };
    const flushCommon = () => { if (common) parts.push({ common }); common = ""; };
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { flushDiff(); common += x[i++]; j++; }
      else {
        flushCommon();
        if (j >= y.length || i < x.length && table[(i + 1) * width + j] >= table[i * width + j + 1]) left += x[i++];
        else right += y[j++];
      }
    }
    flushDiff(); flushCommon();
  }
  if (endA < a.length) parts.push({ common: a.slice(endA).join("") });
  return parts;
}

export function resolveTextParts(parts: TextPart[], selections: string[]): string {
  let index = 0;
  const result = parts.map(part => part.common !== undefined ? part.common : selections[index++]);
  if (index !== selections.length || result.some(part => part === undefined)) throw new Error("仍有差异区块未选择。");
  return result.join("");
}
