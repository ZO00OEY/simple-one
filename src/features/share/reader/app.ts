import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import DOMPurify from "dompurify";
import katex from "katex";
import mermaid from "mermaid";
import { parseColumns } from "../../../shared/columns";
import "katex/dist/katex.min.css";
import "./style.css";

interface CatalogNote { id: string; title: string; category: string }
let catalog: CatalogNote[] = [];
let request = 0;
const content = document.getElementById("content")!;
const title = document.getElementById("note-title")!;
const list = document.getElementById("note-list")!;
const search = document.getElementById("search") as HTMLInputElement;
const md = new MarkdownIt({ html: true, linkify: true, breaks: false }).use(footnote).use(mark);
const escape = md.utils.escapeHtml;
const normalFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token.info.trim() === "simple-columns") {
    const columns = parseColumns(token.content.replace(/\n$/, ""));
    if (columns) return `<div class="simple-columns" style="--columns:${columns.widths.map(value => `minmax(0,${value}fr)`).join(" ")}">${columns.content.map(source => `<div class="simple-column">${md.render(source, env)}</div>`).join("")}</div>`;
  }
  if (token.info.trim() === "mermaid") return `<pre class="mermaid">${escape(token.content)}</pre>`;
  if (token.info.trim().toLowerCase() === "html") return `<pre class="share-html-source"><code>${escape(token.content)}</code></pre>`;
  return normalFence(tokens, index, options, env, self);
};
md.inline.ruler.before("escape", "math", (state, silent) => {
  if (state.src[state.pos] !== "$" || state.src[state.pos + 1] === "$" ) return false;
  const end = state.src.indexOf("$", state.pos + 1);
  if (end < 0 || state.src.slice(state.pos + 1, end).includes("\n")) return false;
  if (!silent) { const token = state.push("math", "", 0); token.content = state.src.slice(state.pos + 1, end); }
  state.pos = end + 1;
  return true;
});
md.renderer.rules.math = (tokens, index) => katex.renderToString(tokens[index].content, { throwOnError: false, trust: false });
md.block.ruler.before("fence", "math-block", (state, start, end, silent) => {
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  if (line.trim() !== "$$") return false;
  let next = start + 1;
  while (next < end && state.src.slice(state.bMarks[next], state.eMarks[next]).trim() !== "$$") next++;
  if (next === end) return false;
  if (!silent) { const token = state.push("math_block", "", 0); token.content = state.getLines(start + 1, next, 0, false); token.block = true; }
  state.line = next + 1;
  return true;
});
md.renderer.rules.math_block = (tokens, index) => katex.renderToString(tokens[index].content, { displayMode: true, throwOnError: false, trust: false });
md.core.ruler.push("heading-ids", state => {
  const used = new Map<string, number>();
  state.tokens.forEach((token, index) => {
    if (token.type !== "heading_open") return;
    const text = state.tokens[index + 1]?.content || "";
    const base = text.trim().toLowerCase().replace(/\s+/g, "-");
    const count = used.get(base) || 0; used.set(base, count + 1);
    token.attrSet("id", count ? `${base}-${count}` : base);
  });
  state.tokens.forEach((token, index) => {
    if (token.type !== "inline" || state.tokens[index - 1]?.type !== "paragraph_open") return;
    const tail = token.children?.[token.children.length - 1];
    const match = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(tail?.content || "");
    if (!match || tail?.type !== "text") return;
    state.tokens[index - 1].attrSet("id", `^${match[1]}`);
    tail.content = tail.content.slice(0, match.index);
  });
});
function revealTarget(target: Element | null): void {
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.classList.contains("heading-body") && parent.hidden) {
      parent.hidden = false;
      const button = parent.previousElementSibling?.querySelector<HTMLButtonElement>(".heading-toggle");
      if (button) { button.setAttribute("aria-expanded", "true"); button.setAttribute("aria-label", `折叠 ${button.dataset.heading}`); button.textContent = "▾"; }
    }
    if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
  }
  target.scrollIntoView();
}
function foldHeadings(root: HTMLElement): void {
  const parents = new Set(Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"), heading => heading.parentElement!));
  for (const parent of parents) {
    const stack: { level: number; body: HTMLElement }[] = [];
    for (const node of Array.from(parent.childNodes)) {
      const tag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName : "";
      const level = /^H[1-6]$/.test(tag) ? Number(tag[1]) : 0;
      if (!level) { stack.at(-1)?.body.append(node); continue; }
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const heading = node as HTMLElement;
      const section = document.createElement("section"); section.className = "heading-section";
      if (stack.length) stack.at(-1)!.body.append(section); else parent.insertBefore(section, heading);
      const body = document.createElement("div"); body.className = "heading-body";
      const button = document.createElement("button"); button.type = "button"; button.className = "heading-toggle";
      button.dataset.heading = heading.textContent || "标题"; button.textContent = "▾";
      button.setAttribute("aria-expanded", "true"); button.setAttribute("aria-label", `折叠 ${button.dataset.heading}`);
      button.addEventListener("click", () => {
        body.hidden = !body.hidden;
        button.setAttribute("aria-expanded", String(!body.hidden));
        button.setAttribute("aria-label", `${body.hidden ? "展开" : "折叠"} ${button.dataset.heading}`);
        button.textContent = body.hidden ? "▸" : "▾";
      });
      heading.prepend(button); section.append(heading, body);
      stack.push({ level, body });
    }
  }
}
function decorate(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>("img[width][height]").forEach(image => {
    const width = Number(image.getAttribute("width")), height = Number(image.getAttribute("height"));
    if (width > 0 && height > 0 && width <= 4096 && height <= 4096) image.style.aspectRatio = `${width} / ${height}`;
  });
  root.querySelectorAll<HTMLElement>("pre.share-html-source").forEach(source => {
    const raw = source.textContent || "";
    const frame = document.createElement("iframe"); frame.className = "share-html-preview";
    frame.title = "HTML 静态预览"; frame.setAttribute("sandbox", ""); frame.referrerPolicy = "no-referrer";
    const safe = DOMPurify.sanitize(raw, { WHOLE_DOCUMENT: true, ADD_TAGS: ["style"], FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta", "base"], FORBID_ATTR: ["srcdoc"] });
    const preview = new DOMParser().parseFromString(safe, "text/html");
    const policy = preview.createElement("meta"); policy.httpEquiv = "Content-Security-Policy";
    policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; font-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";
    preview.head.prepend(policy);
    const style = preview.createElement("style");
    style.textContent = 'body{font-family:"Microsoft YaHei",sans-serif;font-size:16px;line-height:1.8;margin:16px}img{max-width:100%;height:auto}';
    preview.head.prepend(style); frame.srcdoc = "<!doctype html>" + preview.documentElement.outerHTML;
    const details = document.createElement("details"), summary = document.createElement("summary");
    summary.textContent = "查看 HTML 源码"; source.before(frame, details); details.append(summary, source);
  });
  root.querySelectorAll("think,thinking,think_nya\\~,snapshot,abstract,todo,seeds,events").forEach(node => {
    const details = document.createElement("details"); details.className = "share-special-block";
    const summary = document.createElement("summary");
    const labels: Record<string, string> = { think: "思考过程", thinking: "思考过程", "think_nya~": "思考过程", snapshot: "Snapshot", abstract: "摘要", todo: "待办", seeds: "Seeds", events: "事件" };
    summary.textContent = labels[node.tagName.toLowerCase()] || node.tagName;
    const body = document.createElement("div"); body.append(...Array.from(node.childNodes));
    details.append(summary, body); node.replaceWith(details);
  });
  root.querySelectorAll("blockquote").forEach(block => {
    const first = block.querySelector("p");
    const match = /^\[!([\w-]+)\]([+-]?)([^\n]*)\n?/.exec(first?.textContent || "");
    if (!first || !match) return;
    block.classList.add("callout");
    block.dataset.callout = match[1].toLowerCase();
    const heading = document.createElement("strong"); heading.textContent = match[3].trim() || match[1];
    // Remove only the marker text so inline formatting and links remain intact.
    let remaining = match[0].length;
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    while (remaining > 0) { const node = walker.nextNode(); if (!node) break; const value = node.textContent || ""; node.textContent = value.slice(remaining); remaining -= value.length; }
    if (match[2]) {
      const details = document.createElement("details"); details.open = match[2] !== "-";
      const summary = document.createElement("summary"); summary.append(heading); details.append(summary);
      while (block.firstChild) details.append(block.firstChild);
      block.append(details);
    } else block.prepend(heading);
  });
  root.querySelectorAll("li > p, li").forEach(item => {
    const node = item.firstChild;
    const match = /^\[([ xX])\]\s/.exec(node?.textContent || "");
    if (!node || node.nodeType !== Node.TEXT_NODE || !match) return;
    node.textContent = (node.textContent || "").slice(match[0].length);
    const check = document.createElement("input"); check.type = "checkbox"; check.disabled = true; check.checked = match[1] !== " "; item.prepend(check);
  });
  root.querySelectorAll<HTMLAnchorElement>("a").forEach(link => {
    if (/^https?:/.test(link.getAttribute("href") || "")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    else if (link.getAttribute("href")?.startsWith("#") && !link.getAttribute("href")?.startsWith("#/")) {
      link.addEventListener("click", event => { event.preventDefault(); revealTarget(root.querySelector(`[id="${CSS.escape(decodeURIComponent(link.hash.slice(1)))}"]`)); });
    }
  });
}
function renderList(): void {
  list.replaceChildren();
  const query = search.value.toLowerCase();
  const groups = new Map<string, CatalogNote[]>();
  catalog.filter(note => `${note.title} ${note.category}`.toLowerCase().includes(query)).forEach(note => {
    const key = note.category || "未分类"; groups.set(key, [...(groups.get(key) || []), note]);
  });
  for (const [category, notes] of groups) {
    const details = document.createElement("details"); details.open = true;
    const summary = document.createElement("summary"); summary.textContent = category; details.append(summary);
    for (const note of notes) { const link = document.createElement("a"); link.href = `#/notes/${note.id}`; link.textContent = note.title; details.append(link); }
    list.append(details);
  }
}
async function route(): Promise<void> {
  const current = ++request;
  const match = /^#\/notes\/([a-z0-9]{12})(?:\/(.*))?$/.exec(location.hash);
  content.replaceChildren();
  if (!match) { title.textContent = "分享笔记"; content.textContent = `共 ${catalog.length} 篇笔记，请从目录选择。`; return; }
  const note = catalog.find(item => item.id === match[1]);
  title.textContent = note?.title || "笔记不存在或已撤下";
  if (!note) return;
  content.textContent = "正在读取…";
  try {
    const response = await fetch(`notes/${note.id}.md`, { cache: "no-cache" });
    if (!response.ok) throw new Error("笔记文件尚未部署或已撤下");
    const source = await response.text();
    if (current !== request) return;
    // DOMPurify is the final filter after Markdown, HTML, columns and math expansion.
    content.replaceChildren(DOMPurify.sanitize(md.render(source), { RETURN_DOM_FRAGMENT: true, ADD_TAGS: ["math", "annotation", "think", "thinking", "think_nya~", "snapshot", "abstract", "todo", "seeds", "events"], FORBID_TAGS: ["iframe", "object", "embed", "form", "style", "link", "meta"], FORBID_ATTR: ["srcdoc"] }));
    decorate(content);
    foldHeadings(content);
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
    for (const node of Array.from(content.querySelectorAll<HTMLElement>(".mermaid"))) {
      try { await mermaid.run({ nodes: [node], suppressErrors: true }); } catch { node.classList.remove("mermaid"); }
    }
    if (current === request && match[2]) revealTarget(content.querySelector(`[id="${CSS.escape(decodeURIComponent(match[2]))}"]`));
  } catch (error) { if (current === request) content.textContent = error instanceof Error ? error.message : "读取失败"; }
}
search.addEventListener("input", renderList);
window.addEventListener("hashchange", () => { void route(); });
void fetch("catalog.json", { cache: "no-cache" }).then(response => { if (!response.ok) throw new Error("目录尚未部署"); return response.json(); }).then((value: { notes: CatalogNote[] }) => {
  catalog = value.notes.filter(note => /^[a-z0-9]{12}$/.test(note.id)); renderList(); return route();
}).catch(() => { title.textContent = "目录读取失败"; content.textContent = "请稍后刷新，或检查网站部署状态。"; });
