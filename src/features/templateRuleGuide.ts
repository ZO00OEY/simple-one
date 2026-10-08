const example = {
  name: "示例网站",
  shortName: "示例",
  urlPattern: "example\\.com/book/",
  fields: [
    { fieldName: "书名", source: "h1", regex: "", replaceWith: "" },
    { fieldName: "作者", source: ".author", regex: "", replaceWith: "" },
    { fieldName: "文案", source: "meta[name=description]", regex: "", replaceWith: "" },
  ],
  search: {
    enabled: true,
    type: "html",
    searchUrl: "https://example.com/search?q={{queryEncoded}}&page={{page}}",
    pageStart: 1,
    resultLimit: 10,
    resultList: ".search-result",
    resultTitle: ".title",
    resultUrl: ".title a",
    resultAuthor: ".author",
    resultIntro: ".intro",
    nextPage: { type: "selectorHref", page: "main", selector: "a.next" },
  },
};

export function templateRuleCreationPrompt(template: { name: string; filenameField: string; propertyFields: string[] }): string {
  return `请帮我生成 Simple One“快速新建笔记”可导入的网站规则 JSON。

目标笔记模板（已由用户选择，请沿用属性名称，不要另建模板）：
${JSON.stringify(template, null, 2)}

模板属性按 propertyFields 顺序排列，filenameField 是文件名来源。只为网页可获取的属性设置提取规则，其余属性留给用户手动填写。

我会提供：具体内容页链接、需要提取的信息；如果需要搜索，还会提供搜索结果页链接和对应关键词。请先确认这些信息，缺少必要信息时向我询问。若我提供已有模板或规则 JSON，沿用其中的字段名称。

适用范围：普通 HTML 中可以直接提取内容的网站。请实际查看网页源码，确认详情页与搜索页的结构。若无法访问，请让我提供 HTML 源码或保存的网页文件；若依赖登录验证、专用接口、页面脚本或动态数据，明确说明不适用于这份简单规则，不要编造选择器或声称已经验证。

现有导入格式与执行约定：
1. 输出单个网站规则对象，不是模板对象。只使用下述现有字段，不添加 schemaVersion、link、steps、script、headers、JSONPath 等扩展结构，也不要设置 handler。id 可省略，由插件生成。
2. name、shortName 是网站名称与简称；urlPattern 是匹配内容页 URL 的 JavaScript 正则字符串，插件使用 i 标志匹配。不要写成 /正则/i；注意 JSON 中反斜杠需要转义。
3. fields 是字段数组。每项包含 fieldName、source、regex、replaceWith，可省略 id。fieldName 必须与模板的命名字段及笔记模板对应。source 可用 title、h1、.类选择器、#单一元素ID、其他 CSS 选择器、meta[name=description] 或 meta[property="og:title"]；普通元素提取文本，meta 提取 content。复杂 CSS 选择器不要以 # 开头，改用 [id="..."]，因为 # 开头按完整元素 ID 处理。source 还支持 inputUrl 和 baseUrl，分别表示原始链接与规范化链接。空 source 表示预留空字段，不支持 selector@属性 语法。
4. regex、replaceWith 不需要时填空字符串。正则仅匹配一次，无额外 flags；replaceWith 用 $1、$2 引用捕获组。没有 replaceWith 时返回捕获组拼接结果，无捕获组则返回完整匹配；不匹配则返回空值。跨行匹配使用 [\\s\\S] 并正确转义。
5. 默认只读取输入链接。不需要链接归一化或多页提取时，省略 input、pages、field.page。需要时，可用 input.baseUrl={"type":"urlReplace","regex":"...","replaceWith":"..."} 归一化链接。pages 按顺序加载，例如 [{"id":"main","url":"{{baseUrl}}"}]，也支持 {{inputUrl}}。字段通过 page 指定读取的页面 id。
6. 多页内容可使用 pages[].urlFrom，从已加载页面生成下一地址。支持 {"type":"selectorHref","page":"main","selector":"a.detail"}，或 {"type":"urlReplace","page":"main","regex":"...","replaceWith":"..."}。相对 href 会按来源页面补全。仅在有实际页面证据时添加。
7. 不需要搜索时省略 search。需要搜索时，search.type 固定为 html；searchUrl 是返回 HTML 的 GET 地址，不能使用 POST 或专用 API。占位符：{{queryEncoded}} 为 URL 编码关键词，{{query}} 为原始关键词，{{page}} / {{pageIndex}} 为页码，{{limit}} 为结果数量。pageStart 默认 1，resultLimit 默认 10。
8. resultList 选中每条搜索结果；resultTitle、resultUrl、resultAuthor、resultIntro 都是在每条结果内部查找的 CSS 选择器。resultUrl 应选中含 href 的链接；:scope 表示当前结果元素。标题和链接必须存在，作者与简介可省略。详情字段 regex 不适用于搜索结果字段。
9. 搜索翻页优先使用 nextPage={"type":"selectorHref","page":"main","selector":"a.next"}。确实使用 URL 页码参数时也支持 {"type":"queryParamIncrement","page":"main","param":"page","start":1}，但它本身不会判断末页。有末页条件时优先使用下一页链接。无法确认翻页就省略 nextPage。
10. 保存目录、笔记命名字段与输出模板由已有模板控制，不放进这份网站规则。

下面仅为结构示例，域名和选择器都是占位内容，不代表经过验证的网站规则：
${JSON.stringify(example, null, 2)}

交付要求：先简要说明已核实的页面、提取字段及未验证的部分；信息足够后，再单独提供一个严格有效的 JSON 代码块，便于复制保存为 .json 或粘贴到“新增”窗口。不要把说明写进 JSON，不要生成虚构的可用规则。缺少证据时先问我，不要直接套用示例选择器。最后说明如何用一个详情链接和一个搜索词检查结果。

我的网站资料：
内容页链接：
希望提取的字段：

是否需要搜索：
搜索结果页链接及关键词：
已有模板／规则 JSON（可选）：`;
}
