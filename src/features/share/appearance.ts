import type SimplePlugin from "../../main";
import { QUICK_FORMAT_CALLOUTS } from "../../types";

/** Export only content appearance, never the vault's heading or UI styles. */
export function shareAppearance(host: SimplePlugin): string {
  const styles = getComputedStyle(document.body);
  const height = styles.getPropertyValue("--simple-image-max-height").trim();
  const imageHeight = /^\d+(?:\.\d+)?px$/.test(height) && parseFloat(height) > 0 && parseFloat(height) <= 10000 ? height : "none";
  const rules = [`:root{--share-image-max-height:${imageHeight}}`];
  const types = new Set(QUICK_FORMAT_CALLOUTS.flatMap(item => [item.type, ...item.aliases]));
  for (const item of host.settings?.enhancements?.quickFormat?.customCallouts || []) {
    if (/^[\w-]+$/.test(item.type)) types.add(item.type.toLowerCase());
  }
  for (const type of types) {
    const probe = document.body.createDiv({ cls:"markdown-preview-view markdown-rendered" });
    probe.hidden = true;
    const block = probe.createDiv({ cls:"callout" }); block.dataset.callout = type;
    const title = block.createDiv({ cls:"callout-title" });
    const icon = title.createDiv({ cls:"callout-icon" });
    try {
      const quickFormat = host.settings?.enhancements?.quickFormat;
      const definition = QUICK_FORMAT_CALLOUTS.find(item => item.type === type || item.aliases.includes(type));
      const configured = definition ? quickFormat?.calloutColors[definition.type] : quickFormat?.customCallouts.find(item => item.type.toLowerCase() === type)?.color;
      const color = configured && /^#[0-9a-f]{6}$/i.test(configured) ? configured : getComputedStyle(icon).color;
      if (/^#[0-9a-f]{6}$|^rgba?\([\d.,%\s]+\)$/i.test(color)) rules.push(`.callout[data-callout="${type}"]{--callout-color:${color}}`);
    } finally { probe.remove(); }
  }
  return rules.join("\n");
}
