import { gunzipSync, strFromU8 } from "fflate";
import { base64Bytes } from "../../shared/desktopNode";
import { readerPayload } from "./readerPayload";

export function bundledReaderFiles(): { template: string; licenses: string } {
  return JSON.parse(strFromU8(gunzipSync(base64Bytes(readerPayload)))) as { template: string; licenses: string };
}

export const DEFAULT_TEMPLATE_FILE = "default.html";
export const TEMPLATE_SELECTION_FILE = "share-template-selection.json";

export function templateAppearance(source: string, css: string): string {
  // User templates own their HTML, CSS and script; only the appearance slot is filled.
  return source.replace(/<style data-simple-appearance>[\s\S]*?<\/style>/,
    () => `<style data-simple-appearance>${css.replace(/<\/style/gi, "<\\/style")}</style>`);
}

export function readerAssets(source: string): Record<string, string> {
  const script = /<script data-simple-reader>([\s\S]*?)<\/script>/.exec(source)?.[1];
  const style = /<style data-simple-reader-style>([\s\S]*?)<\/style>/.exec(source)?.[1];
  if (!script || !style) throw new Error("default.html 缺少完整的阅读器脚本或样式，请重新安装默认模板文件。");
  return { "reader/app.js": script.replace(/<\\\/script/gi, "</script"), "reader/app.css": style.replace(/<\\\/style/gi, "</style") };
}

export function validateShareTemplate(source: string): void {
  if (!source.trim() || new TextEncoder().encode(source).byteLength > 16 * 1024 * 1024) throw new Error("请选择非空且小于 16 MB 的 HTML 模板。");
  if (!/<html(?:\s|>)/i.test(source) || !/<body(?:\s|>)/i.test(source)) throw new Error("模板需要完整的 HTML 和 body 元素。");
  const document = new DOMParser().parseFromString(source, "text/html");
  for (const id of ["content", "note-title", "note-list", "search"]) {
    if (document.querySelectorAll(`[id="${id}"]`).length !== 1) throw new Error(`模板必须保留一个 id="${id}" 的元素。`);
  }
  if (document.getElementById("search")?.tagName !== "INPUT") throw new Error("模板中的 search 必须是 input 元素。");
  const relative = (value: string | null) => value?.replace(/^\.\//, "");
  const standalone = document.querySelector("script[data-simple-reader]:not([src])");
  if (!standalone?.textContent?.trim() && !Array.from(document.querySelectorAll('script[type="module"]')).some(script => relative(script.getAttribute("src")) === "reader/app.js")) throw new Error("模板必须保留内嵌阅读脚本或 reader/app.js 的 module 阅读脚本。");
  for (const href of standalone ? [] : ["reader/app.css", "reader/appearance.css"]) {
    if (!Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some(link => relative(link.getAttribute("href")) === href)) throw new Error(`模板必须保留 ${href} 样式引用。`);
  }
  if (document.querySelector("base")) throw new Error("模板不能使用 base 元素，以免破坏笔记和阅读器的相对链接。");
}
