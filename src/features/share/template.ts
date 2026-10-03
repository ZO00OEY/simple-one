export const DEFAULT_SHARE_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>分享笔记</title>
  <link rel="stylesheet" href="reader/app.css">
  <link rel="stylesheet" href="reader/appearance.css">
  <!-- 可在这里添加内嵌 CSS；保留下方阅读器所需的 ID 和脚本。 -->
</head>
<body>
  <header><a href="#/">分享笔记 · 目录</a><span>阅读与留存</span></header>
  <div class="layout">
    <aside>
      <label for="search">笔记目录</label>
      <input id="search" type="search" placeholder="搜索标题或分类">
      <nav id="note-list"></nav>
    </aside>
    <main><h1 id="note-title">分享笔记</h1><article id="content"></article></main>
  </div>
  <script type="module" src="reader/app.js"></script>
</body>
</html>
`;

export function validateShareTemplate(source: string): void {
  if (!source.trim() || new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024) throw new Error("请选择非空且小于 2 MB 的 HTML 模板。");
  if (!/<html(?:\s|>)/i.test(source) || !/<body(?:\s|>)/i.test(source)) throw new Error("模板需要完整的 HTML 和 body 元素。");
  const document = new DOMParser().parseFromString(source, "text/html");
  for (const id of ["content", "note-title", "note-list", "search"]) {
    if (document.querySelectorAll(`[id="${id}"]`).length !== 1) throw new Error(`模板必须保留一个 id="${id}" 的元素。`);
  }
  if (document.getElementById("search")?.tagName !== "INPUT") throw new Error("模板中的 search 必须是 input 元素。");
  const relative = (value: string | null) => value?.replace(/^\.\//, "");
  if (!Array.from(document.querySelectorAll('script[type="module"]')).some(script => relative(script.getAttribute("src")) === "reader/app.js")) throw new Error("模板必须保留 reader/app.js 的 module 阅读脚本。");
  for (const href of ["reader/app.css", "reader/appearance.css"]) {
    if (!Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some(link => relative(link.getAttribute("href")) === href)) throw new Error(`模板必须保留 ${href} 样式引用。`);
  }
  if (document.querySelector("base")) throw new Error("模板不能使用 base 元素，以免破坏笔记和阅读器的相对链接。");
}
