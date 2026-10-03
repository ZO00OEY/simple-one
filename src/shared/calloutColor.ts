// Resolve the rendered icon's color instead of assuming a theme defines
// --callout-TYPE on body. Callout CSS can be scoped to the rendered element.
export function readCalloutColor(type: string, context: HTMLElement = document.body): string {
  const doc = context.ownerDocument;
  const win = doc.defaultView;
  if (!win) return "";
  const probe = doc.win.createDiv();
  probe.className = "markdown-preview-view markdown-rendered";
  probe.setAttribute("aria-hidden", "true");
  probe.setCssStyles({
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    width: "0",
    height: "0",
    overflow: "hidden",
  });
  const callout = doc.win.createDiv();
  callout.className = "callout";
  callout.dataset.callout = type.trim().toLowerCase() || "note";
  callout.dataset.calloutFold = "";
  callout.dataset.calloutMetadata = "";
  const title = doc.win.createDiv();
  title.className = "callout-title";
  const icon = doc.win.createDiv();
  icon.className = "callout-icon";
  const svg = doc.win.createSvg("svg");
  svg.classList.add("svg-icon");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("fill", "none");
  icon.append(svg);
  const titleText = doc.win.createDiv();
  titleText.className = "callout-title-inner";
  titleText.textContent = type;
  title.append(icon, titleText);
  const content = doc.win.createDiv();
  content.className = "callout-content";
  content.append(doc.win.createEl("p"));
  callout.append(title, content);
  probe.append(callout);
  (context.querySelector<HTMLElement>(".markdown-preview-sizer, .cm-sizer") ?? context).append(probe);
  try {
    const stroke = win.getComputedStyle(svg).stroke;
    return stroke && stroke !== "none" && stroke !== "currentcolor"
      ? stroke
      : win.getComputedStyle(icon).color;
  } finally {
    probe.remove();
  }
}

export function readCalloutColorHex(type: string, context: HTMLElement = document.body): string {
  const color = readCalloutColor(type, context);
  const canvas = context.ownerDocument.win.createEl("canvas");
  canvas.width = canvas.height = 1;
  const paint = canvas.getContext("2d");
  if (!paint || !color) return "";
  paint.fillStyle = color;
  paint.fillRect(0, 0, 1, 1);
  return "#" + Array.from(paint.getImageData(0, 0, 1, 1).data.slice(0, 3))
    .map((channel) => channel.toString(16).padStart(2, "0")).join("");
}
