import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Run the browser bundle without Node globals to cover mobile-compatible encoding.
const output = await build({
  stdin: {
    contents: 'export { applySearchUrlTemplate } from "./src/shared/searchUrl"; export { defaultTemplateCategories } from "./src/features/templateFillPresets";',
    resolveDir: process.cwd(),
  },
  bundle: true, format: "iife", globalName: "searchTest", platform: "browser",
  alias: { buffer: "buffer/" }, write: false,
});
const context = vm.createContext({ console, TextDecoder, TextEncoder, Uint8Array });
vm.runInContext(output.outputFiles[0].text, context);
const { applySearchUrlTemplate, defaultTemplateCategories } = context.searchTest;
const sites = defaultTemplateCategories()[0].siteRules;
const rule = sites.find(site => /jjwxc/.test(site.urlPattern)).search;
const query = "\u4ece\u4f17\u6240\u5468\u77e5\u7684\u66b4\u8e81\u5927\u81e3\u5230\u4eba\u4eba\u5492\u9a82\u7684\u5973\u5e1d";
const encoded = "%B4%D3%D6%DA%CB%F9%D6%DC%D6%AA%B5%C4%B1%A9%D4%EA%B4%F3%B3%BC%B5%BD%C8%CB%C8%CB%D6%E4%C2%EE%B5%C4%C5%AE%B5%DB";
assert.equal(applySearchUrlTemplate("{{queryEncoded}}", query, 1, 20, rule.queryEncoding), encoded);
assert.equal(applySearchUrlTemplate("{{queryEncoded}}", query, 1, 20), encodeURIComponent(query));
assert.equal(applySearchUrlTemplate("{{queryEncoded}}", "\u{20000}", 1, 20, "gb18030"), "%95%32%82%36");
assert.equal(applySearchUrlTemplate("{{query}}", "$&$'", 1, 20), "$&$'");
assert.equal(applySearchUrlTemplate("{{page}}/{{pageIndex}}/{{limit}}", "", 2, 20), "2/2/20");
assert.throws(() => applySearchUrlTemplate("{{queryEncoded}}", query, 1, 20, "invalid-encoding"));
for (const site of sites.filter(site => !/jjwxc/.test(site.urlPattern))) {
  assert.equal(
    applySearchUrlTemplate(site.search.searchUrl, query, 0, 10, site.search.queryEncoding),
    site.search.searchUrl.replace("{{queryEncoded}}", encodeURIComponent(query)),
  );
}

const html = `<div class="b module"><ul>
<li><a href="/book2/7564266"><span>\u4ece\u4f17\u6240\u5468\u77e5</span></a> - <a href="/wapauthor/1801630">\u8ba8\u538c\u590f\u5929</a></li>
<li><p class="pagination"><a href="/search/index/page/2?kw=${encoded}">\u4e0b\u4e00\u9875</a><strong>1</strong></p></li>
</ul></div>`;
const doc = new JSDOM(html).window.document;
const items = [...doc.querySelectorAll(rule.resultList)];
assert.equal(items.length, 1);
assert.equal(items[0].querySelector(rule.resultTitle).textContent, "\u4ece\u4f17\u6240\u5468\u77e5");
assert.equal(items[0].querySelector(rule.resultAuthor).textContent, "\u8ba8\u538c\u590f\u5929");
assert.equal(items[0].querySelector(rule.resultUrl).getAttribute("href"), "/book2/7564266");
assert.equal(new RegExp(rule.nextPage.regex).exec(html)[1], `/search/index/page/2?kw=${encoded}`);
assert.equal(new RegExp(rule.nextPage.regex).exec('<p class="pagination">\u4e0b\u4e00\u9875;<a href="/page/1">1</a><strong>2</strong><a href="/page/1">\u4e0a\u4e00\u9875</a></p>'), null);
console.log("Template search tests passed");
