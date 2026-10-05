import {
  nextId,
  type FieldExtraction,
  type TemplateCategory,
} from "../types";

export function jjwxcFields(): FieldExtraction[] {
  return [
    { id: nextId(), fieldName: "书名", source: "title", regex: "《([^》]+)》", replaceWith: "$1" },
    { id: nextId(), fieldName: "作者", source: "title", regex: "》([^_]+)_", replaceWith: "$1" },
    { id: nextId(), fieldName: "特殊标签", source: "meta[name=description]", regex: "^[^,]*,[^,]*,\\s*([^,]+)", replaceWith: "$1" },
    { id: nextId(), fieldName: "文案", source: "#novelintro", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "我的评分", source: "", regex: "", replaceWith: "" },
  ];
}

export function skillsFields(): FieldExtraction[] {
  return [
    { id: nextId(), fieldName: "技能名称", source: "title", regex: "^(.*?)\\s*—", replaceWith: "$1" },
    { id: nextId(), fieldName: "仓库来源", source: "title", regex: "—\\s*(.+)$", replaceWith: "$1" },
    { id: nextId(), fieldName: "简介", source: "meta[name=description]", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "正文", source: "skillsContent", regex: "", replaceWith: "" },
  ];
}

export function fanqieFields(): FieldExtraction[] {
  return [
    { id: nextId(), fieldName: "书名", source: ".info-name h1", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "作者", source: ".author-name-text", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "特殊标签", source: ".info-label", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "文案", source: ".page-abstract-content", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "我的评分", source: "", regex: "", replaceWith: "" },
  ];
}

export function qidianFields(): FieldExtraction[] {
  return [
    { id: nextId(), fieldName: "书名", source: "meta[property=\"og:title\"]", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "作者", source: "meta[property=\"og:novel:author\"]", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "特殊标签", source: "meta[property=\"og:novel:category\"]", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "文案", source: "meta[property=\"og:description\"]", regex: "", replaceWith: "" },
    { id: nextId(), fieldName: "我的评分", source: "", regex: "", replaceWith: "" },
  ];
}

export function defaultTemplateCategories(): TemplateCategory[] {
  return [
    {
      id: nextId(),
      name: "网文书评",
      icon: "book-open",
      outputFolder: "",
      filenameField: "书名",
      noteFormat: "",
      siteRules: [
        { id: nextId(), name: "晋江", shortName: "晋江", urlPattern: "jjwxc\\.net", fields: jjwxcFields() },
        {
          id: nextId(),
          name: "番茄小说",
          shortName: "番茄",
          handler: "fanqieNovel",
          urlPattern: "fanqienovel\\.com/page/",
          search: {
            enabled: true,
            type: "fanqieApi",
            searchUrl: "https://fanqienovel.com/search/{{queryEncoded}}",
            pageStart: 0,
            resultLimit: 10,
            resultList: "api",
            resultTitle: "book_name",
            resultUrl: "book_id",
            resultAuthor: "author",
            resultIntro: "book_abstract",
          },
          fields: fanqieFields(),
        },
        {
          id: nextId(),
          name: "起点中文网",
          shortName: "起点",
          handler: "qidianBook",
          urlPattern: "(?:qidian\\.com/book/|book\\.qidian\\.com/info/)",
          input: {
            baseUrl: {
              type: "urlReplace",
              regex: "^https?://(?:www\\.qidian\\.com/book/|book\\.qidian\\.com/info/|m\\.qidian\\.com/book/)(\\d+)/?.*$",
              replaceWith: "https://www.qidian.com/book/$1/",
            },
          },
          pages: [
            { id: "main", url: "{{baseUrl}}" },
            {
              id: "mobile",
              urlFrom: {
                type: "urlReplace",
                page: "base",
                regex: "^https?://www\\.qidian\\.com/book/(\\d+)/?.*$",
                replaceWith: "https://m.qidian.com/book/$1/",
              },
            },
          ],
          search: {
            enabled: true,
            type: "webviewHtml",
            searchUrl: "https://www.qidian.com/so/{{queryEncoded}}.html",
            resultLimit: 10,
            resultList: "#result-list li, .book-img-text li, .all-book-list li, .res-book-item",
            resultTitle: ".book-mid-info h4 a, .book-mid-info h3 a, .book-mid-info h2 a, h4 a, h3 a, h2 a",
            resultUrl: ".book-mid-info h4 a, .book-mid-info h3 a, .book-mid-info h2 a, h4 a, h3 a, h2 a",
            resultAuthor: ".book-mid-info .author .name, .author .name, .author a",
            resultIntro: ".book-mid-info .intro, .intro, .desc",
            nextPage: {
              type: "queryParamIncrement",
              page: "main",
              param: "page",
              start: 1,
            },
          },
          fields: qidianFields(),
        },
      ],
    },
    {
      id: nextId(),
      name: "Agent Skills",
      icon: "bot",
      outputFolder: "",
      filenameField: "技能名称",
      noteFormat: "---\n网址: {{网址}}\n仓库来源: {{仓库来源}}\n简介: {{简介}}\n---\n\n# {{技能名称}}\n\n{{正文}}\n",
      siteRules: [
        { id: nextId(), name: "Agent Skills 网站", shortName: "Skills", urlPattern: "skills\\.sh", fields: skillsFields() },
      ],
    },
  ];
}
