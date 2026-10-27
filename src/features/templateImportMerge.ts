import type { SiteRule, TemplateCategory } from "../types";

export type ImportCounts = { added: number; updated: number; skipped: number };

export function importTemplateGroup(current: TemplateCategory, incoming: TemplateCategory[]): TemplateCategory {
  if (incoming.length !== 1) throw new Error("此处仅支持单个模板组；多个模板请在外层导入");
  const siteRules = [...current.siteRules];
  mergeSiteImports(siteRules, incoming[0].siteRules);
  return { ...incoming[0], id: current.id, siteRules };
}
const siteContent = (site: SiteRule): unknown => ({ ...site, id: undefined, fields: site.fields.map(field => ({ ...field, id: undefined })) });
const signature = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
});

export function mergeSiteImports(target: SiteRule[], incoming: SiteRule[]): ImportCounts {
  const counts = { added: 0, updated: 0, skipped: 0 };
  for (const site of incoming) {
    const content = signature(siteContent(site));
    if (target.some(item => signature(siteContent(item)) === content)) { counts.skipped++; continue; }
    const index = target.findIndex(item => item.id === site.id || (!!site.urlPattern && item.urlPattern === site.urlPattern && item.name === site.name));
    if (index < 0) { target.push(site); counts.added++; }
    else { target[index] = { ...site, id: target[index].id }; counts.updated++; }
  }
  return counts;
}

export function mergeTemplateImports(target: TemplateCategory[], incoming: TemplateCategory[]): ImportCounts {
  const counts = { added: 0, updated: 0, skipped: 0 };
  const content = (item: TemplateCategory): string => signature({ ...item, id: undefined, siteRules: item.siteRules.map(siteContent) });
  for (const template of incoming) {
    const index = target.findIndex(item => item.id === template.id || item.name.trim() === template.name.trim());
    const sites: SiteRule[] = index < 0 ? [] : [...target[index].siteRules];
    mergeSiteImports(sites, template.siteRules);
    const merged = { ...template, id: index < 0 ? template.id : target[index].id, siteRules: sites };
    if (index < 0) { target.push(merged); counts.added++; }
    else if (content(target[index]) === content(merged)) counts.skipped++;
    else { target[index] = merged; counts.updated++; }
  }
  return counts;
}
