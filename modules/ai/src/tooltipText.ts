/** Merge an action name and its extra help into one native Obsidian tooltip. */
export function tooltipText(label: string, detail: string): string {
  if (!label || label === detail || detail.startsWith(label)) return detail || label;
  return detail ? label + "\n" + detail : label;
}

let tooltipLabelId = 0;
const initializedTooltips = new WeakSet<HTMLElement>();
/** Native Obsidian hover text, retaining an input's explicit accessible name. */
export function setNativeTooltip(element: HTMLElement, text: string): void {
  const label = element.getAttribute("aria-label");
  if (!initializedTooltips.has(element) && /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName) && label && label !== text && !element.hasAttribute("aria-labelledby")) {
    const description = element.createSpan();
    description.hidden = true;
    description.id = "simple-ai-tooltip-label-" + ++tooltipLabelId;
    description.textContent = label;
    element.after(description);
    element.setAttribute("aria-labelledby", description.id);
    element.setAttribute("data-simple-tooltip-label", label);
  }
  initializedTooltips.add(element);
  element.removeAttribute("title");
  element.setAttribute("aria-label", text);
}
