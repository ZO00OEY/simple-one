import { encode } from "iconv-lite";

export function applySearchUrlTemplate(
  template: string,
  query: string,
  page: number,
  limit: number,
  queryEncoding = "utf-8"
): string {
  const encoded = /^utf-?8$/i.test(queryEncoding)
    ? encodeURIComponent(query)
    : Array.from(encode(query, queryEncoding), byte => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("");
  return template
    .replace(/\{\{queryEncoded\}\}/g, () => encoded)
    .replace(/\{\{query\}\}/g, () => query)
    .replace(/\{\{pageIndex\}\}/g, String(page))
    .replace(/\{\{limit\}\}/g, String(limit))
    .replace(/\{\{page\}\}/g, String(page));
}
