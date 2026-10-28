import { setIcon } from "obsidian";

/** A plain A has no baseline; all other format glyphs use the existing icon set. */
export function setFormatIcon(element: HTMLElement, icon: string): void {
  element.replaceChildren();
  if (icon === "baseline" || icon === "underline") {
    const doc = element.ownerDocument;
    const svg = doc.win.createSvg("svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    svg.classList.add("svg-icon");
    const path = doc.win.createSvg("path");
    path.setAttribute("d", icon === "underline" ? "M6 3v8a6 6 0 0 0 12 0V3M4 22h16" : "M5 20 12 4 19 20M8 13h8"); svg.append(path); element.append(svg);
  } else {
    setIcon(element, icon);
    const svg = element.querySelector<SVGElement>("svg");
    if (svg) svg.style.strokeWidth = icon === "bold" ? "2.6" : icon === "quote" ? "1.8" : "2";
  }
}
