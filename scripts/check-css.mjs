import fs from "node:fs";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

const tags = new Set("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption circle cite code col colgroup data datalist dd defs del details dfn dialog div dl dt ellipse em embed fieldset figcaption figure footer form g h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li line link main map mark menu meta meter nav noscript object ol optgroup option output p path picture polygon polyline pre progress q rect rp rt ruby s samp script search section select slot small source span strong style sub summary sup svg symbol table tbody td template text textarea tfoot th thead time title tr track u ul use var video wbr".split(" "));
const css = postcss.parse(fs.readFileSync("styles.css", "utf8"));
const issues = [];
css.walkDecls((decl) => { if (decl.important) issues.push(`Line ${decl.source.start.line}: avoid !important`); });
css.walkRules((rule) => {
  if (rule.parent.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
  selectorParser((selectors) => {
  selectors.walkPseudos((pseudo) => { if (pseudo.value === ":has") issues.push(`Line ${rule.source.start.line}: avoid :has()`); });
  selectors.walkTags((tag) => {
    // Selector parsers represent nth-child arithmetic (e.g. 7n) as tags.
    if (!tags.has(tag.value.toLowerCase()) && !/^[\d+-]/.test(tag.value)) issues.push(`Line ${rule.source.start.line}: unknown tag ${tag.value}`);
  });
}).processSync(rule.selector);
});
if (issues.length) throw new Error(issues.join("\n"));
console.log("CSS checks passed.");
