import type SimplePlugin from "../../main";
import { displayParameterEnabled } from "../../shared/displayProfile";
import { QUICK_FORMAT_CALLOUTS } from "../../types";

/** Export explicit settings only; unspecified Callouts follow the reader accent, never the Obsidian theme. */
export function shareAppearance(host: SimplePlugin): string {
  const styles = getComputedStyle(document.body);
  const height = styles.getPropertyValue("--simple-image-max-height").trim();
  const imageHeight = /^\d+(?:\.\d+)?px$/.test(height) && parseFloat(height) > 0 && parseFloat(height) <= 10000 ? height : "none";
  const rules = [`:root{--share-image-max-height:${imageHeight}}`];
  const format = host.settings?.themeFormatting;
  const variables = { textColor: "--share-text", boldColor: "--share-bold", italicColor: "--share-italic", underlineColor: "--share-underline", strikethroughColor: "--share-strike", highlightBackground: "--share-highlight-bg", highlightColor: "--share-highlight-text" } as const;
  for (const [key, variable] of Object.entries(variables)) {
    const color = format?.[key as keyof typeof variables];
    if (color && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) {
      rules.push(`:root{${variable}:${color}}`);
      if (key === "boldColor" || key === "italicColor") rules.push(`:root{${variable}-default:${color}}`);
    }
  }
  if (format?.boldWeight && /^[1-9]00$/.test(format.boldWeight)) rules.push(`:root{--share-bold-weight:${format.boldWeight}}`);
  const quickFormat = host.settings?.enhancements?.quickFormat;
  for (let level = 1; level <= 6; level++) {
    const key = `h${level}` as keyof NonNullable<typeof quickFormat>["headingColors"];
    const color = quickFormat?.headingColors?.[key];
    if (color && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) rules.push(`:root{--share-h${level}-color:${/^#(?:222222|242832|29242a)$/i.test(color) ? `var(--share-heading-neutral,${color})` : color}}`);
    const size = Number(quickFormat?.headingSizes?.[key]);
    if (Number.isFinite(size) && size >= 10 && size <= 96) rules.push(`:root{--share-h${level}-size:${size}px}`);
  }
  const typography = host.settings?.desktopTypography;
  if (typography) {
    for (const [key, variable, unit, min, max] of [
      ["fontSize", "size", "px", 12, 36], ["lineHeight", "line-height", "", 1.2, 2.4],
      ["letterSpacing", "spacing", "em", -0.05, 0.2], ["paragraphSpacing", "paragraph", "em", 0, 2],
    ] as const) {
      const value = typography[key];
      if (displayParameterEnabled(host.settings, false, key) && Number.isFinite(value) && value >= min && value <= max) rules.push(`:root{--share-default-${variable}:${value}${unit}}`);
    }
  }
  const types = new Set(QUICK_FORMAT_CALLOUTS.flatMap(item => [item.type, ...item.aliases]));
  for (const item of host.settings?.enhancements?.quickFormat?.customCallouts || []) {
    if (/^[\p{L}\p{N}_-]+$/u.test(item.type)) types.add(item.type.toLowerCase());
  }
  for (const type of types) {
    const definition = QUICK_FORMAT_CALLOUTS.find(item => item.type === type || item.aliases.includes(type));
    const configured = definition ? quickFormat?.calloutColors?.[definition.type] : quickFormat?.customCallouts.find(item => item.type.toLowerCase() === type)?.color;
    if (configured && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(configured)) rules.push(`.callout[data-callout="${type}"]{--callout-color:${configured}}`);
  }
  return rules.join("\n");
}
