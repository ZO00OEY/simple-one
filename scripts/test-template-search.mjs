import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

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

// Exercise the production helper with out-of-order responses and one failed fetch.
const nodeRequire = createRequire(import.meta.url);
let hydrationActive = 0, hydrationPeak = 0, hydrationCalls = 0;
const completionOrder = [];
const hydrationObsidian = new Proxy({
  ItemView: class {}, Modal: class {}, AbstractInputSuggest: class {}, addIcon() {},
  requestUrl: async ({ url }) => {
    const index = Number(url.split('/').pop());
    hydrationCalls++; hydrationActive++; hydrationPeak = Math.max(hydrationPeak, hydrationActive);
    try {
      await new Promise(resolve => setTimeout(resolve, index === 0 ? 30 : 2));
      completionOrder.push(index);
      if (index === 5) throw Error('fixture fetch failure');
      return { text: '<title>hydrated-' + index + '</title>', arrayBuffer: new ArrayBuffer(0), headers: { 'content-type': 'text/html' } };
    } finally { hydrationActive--; }
  }
}, { get: (target, key) => key in target ? target[key] : class {} });
const hydrationBundle = await build({ entryPoints: ['src/features/templateFill.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'],
  plugins: [{ name: 'expose-real-hydration', setup(builder) {
    builder.onLoad({ filter: /features[\\/]templateFill\.ts$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')) + '\nexport { hydrateSearchCandidates };', loader: 'ts'
    }));
  } }]
});
const hydrationContext = vm.createContext({ module: { exports: {} }, require: name => name === 'obsidian' ? hydrationObsidian : nodeRequire(name),
  TextEncoder, TextDecoder, console, setTimeout, clearTimeout, window: {} });
vm.runInContext(hydrationBundle.outputFiles[0].text, hydrationContext);
const hydrate = hydrationContext.module.exports.hydrateSearchCandidates;
assert.equal((await hydrate([])).length, 0); assert.equal(hydrationCalls, 0);
const hydrationCandidates = Array.from({ length: 20 }, (_, index) => ({ url: 'https://fixture.invalid/' + index, title: 'original-' + index,
  hydrated: false, siteRule: { fields: [{ id: 'title', fieldName: '书名', source: 'title', regex: '', replaceWith: '' }] } }));
const hydrated = await hydrate(hydrationCandidates);
assert.equal(hydrationCalls, 20); assert.equal(hydrationPeak, 3, 'one search page must not start one request per candidate');
assert.notEqual(completionOrder[0], 0, 'fixture completes requests out of order');
assert.deepEqual(Array.from(hydrated, item => item.url), hydrationCandidates.map(item => item.url), 'visible search order stays stable');
assert.equal(hydrated[5], hydrationCandidates[5], 'failed fetch preserves the original candidate');
assert.equal(hydrated[5].title, 'original-5');
for (const [index, item] of hydrated.entries()) if (index !== 5) {
  assert.equal(item.title, 'hydrated-' + index); assert.equal(item.hydrated, true);
}
console.log('Search hydration: 20 candidates, maximum three requests, stable order, partial failure and empty input passed.');
