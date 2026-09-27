import { requestUrl } from "obsidian";

type WebviewElement = HTMLElement & {
  executeJavaScript(script: string): Promise<string>;
};

const HTML_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "text/html",
};

export async function fetchDecodedHtml(
  url: string,
  options: { fallbackToWebview?: boolean } = {}
): Promise<string | null> {
  const fallbackToWebview = options.fallbackToWebview !== false;
  try {
    const resp = await requestUrl({
      url,
      method: "GET",
      headers: HTML_HEADERS,
    });
    const html = decodeResponseText(resp.text, resp.arrayBuffer, resp.headers["content-type"]);
    return fallbackToWebview && isProbeShell(html)
      ? await tryWebview(url, "new Promise(r=>setTimeout(()=>r(document.documentElement.outerHTML),3000))", 20000)
      : html;
  } catch {
    return fallbackToWebview
      ? await tryWebview(url, "document.documentElement.outerHTML", 15000)
      : null;
  }
}

export async function fetchPageTitle(url: string): Promise<string | null> {
  const html = await fetchDecodedHtml(url);
  const title = html?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  if (title) return title;

  return await tryWebview(url, "document.title", 12000);
}

export async function runWebviewScript(
  url: string,
  script: string,
  timeoutMs = 15000
): Promise<string | null> {
  return await tryWebview(url, script, timeoutMs);
}

function decodeResponseText(
  text: string,
  arrayBuffer: ArrayBuffer,
  contentType: string | undefined
): string {
  const declared = getHeaderCharset(contentType);
  let html = decodeWithCharset(text, arrayBuffer, declared);

  if (!declared || isUtf8(declared)) {
    const metaCharset = getMetaCharset(html);
    if (metaCharset && !isUtf8(metaCharset)) {
      html = decodeWithCharset(html, arrayBuffer, metaCharset);
    }
  }

  return html;
}

function decodeWithCharset(
  fallbackText: string,
  arrayBuffer: ArrayBuffer,
  charset: string | null
): string {
  if (!charset || isUtf8(charset)) return fallbackText;

  try {
    return new TextDecoder(charset).decode(arrayBuffer);
  } catch {
    return fallbackText;
  }
}

function getHeaderCharset(contentType: string | undefined): string | null {
  const match = contentType?.match(/charset=([^\s;]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function getMetaCharset(html: string): string | null {
  const meta = html.match(/<meta[^>]+charset[^>]*>/i);
  const match = meta?.[0].match(/charset=["']?\s*([^\s"';]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function isUtf8(charset: string): boolean {
  return charset === "utf-8" || charset === "utf8";
}

function isProbeShell(html: string): boolean {
  return /probe\.js/.test(html) && !/<body[^>]*>[\s\S]*?\S[\s\S]*?<\/body>/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
}

function tryWebview(
  url: string,
  script: string,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const wv = document.createElement("webview") as WebviewElement;
      wv.classList.add("simple-hidden-webview");
      const cleanup = (value: string | null) => {
        clearTimeout(timer);
        wv.remove();
        resolve(value);
      };
      const timer = window.setTimeout(() => cleanup(null), timeoutMs);
      wv.addEventListener("did-finish-load", () => {
        wv.executeJavaScript(script)
          .then((value: string) => cleanup(value || null))
          .catch(() => cleanup(null));
      });
      document.body.appendChild(wv);
      wv.setAttribute("src", url);
    } catch {
      resolve(null);
    }
  });
}

