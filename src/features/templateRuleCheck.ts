import type { SiteRule } from "../types";
import { applySearchUrlTemplate } from "../shared/searchUrl";

export type RuleCheckResult = { feature: string; passed: boolean; message: string };
export function checkTemplateSiteRule(rule: SiteRule, doc: Document): RuleCheckResult[] {
  const check = (feature: string, run: () => void): RuleCheckResult => {
    try { run(); return { feature, passed: true, message: "规则检查通过（未联网）" }; }
    catch (error) { return { feature, passed: false, message: error instanceof Error ? error.message : String(error) }; }
  };
  const selector = (value: string): void => { doc.querySelector(value); };
  return [
    check("URL 转笔记", () => {
      if (!rule.urlPattern) throw new Error("缺少网址匹配规则");
      new RegExp(rule.urlPattern);
      if (!rule.fields.some(field => field.source)) throw new Error("没有可提取的属性");
      const pages = new Set(rule.pages?.length ? rule.pages.map(page => page.id) : ["main"]);
      for (const field of rule.fields) {
        if (field.regex) new RegExp(field.regex);
        if (field.page && !pages.has(field.page)) throw new Error(`属性“${field.fieldName}”引用了不存在的页面 ${field.page}`);
        if (field.source && !["title", "h1", "skillsContent", "inputUrl", "原始网址", "baseUrl", "网址"].includes(field.source)) selector(field.source);
      }
    }),
    check("搜索", () => {
      const search = rule.search;
      if (!search || search.enabled === false) throw new Error("未配置或未启用搜索");
      if (!search.searchUrl || !search.resultList) throw new Error("缺少搜索网址或结果列表规则，搜索不会执行");
      if (!/\{\{query(?:Encoded)?\}\}/.test(search.searchUrl)) throw new Error("搜索网址缺少关键词占位符");
      const url = new URL(applySearchUrlTemplate(search.searchUrl, "测试", 1, 10, search.queryEncoding));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("搜索网址必须使用 HTTP 或 HTTPS");
      if (search.type === "fanqieApi" || rule.handler === "fanqieNovel") return;
      if (!search.resultTitle || !(search.resultUrl || search.resultTitle)) throw new Error("缺少结果标题规则");
      for (const value of [search.resultList, search.resultTitle, search.resultUrl, search.resultAuthor, search.resultIntro]) if (value) selector(value);
    }),
  ];
}
