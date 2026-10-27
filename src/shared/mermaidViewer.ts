type Mode = "fit" | "canvas";

/** Browser-only viewing controls; the host supplies icons and visual styling. */
export function enhanceMermaid(node: HTMLElement, icon?: (button: HTMLButtonElement, name: string) => void): (() => void) | null {
  if (!node.querySelector("svg") || node.closest(".simple-mermaid-frame")) return null;
  const doc = node.ownerDocument;
  const frame = doc.createElement("section");
  frame.className = "simple-mermaid-frame";
  const toolbar = doc.createElement("div");
  toolbar.className = "simple-mermaid-toolbar";
  const viewport = doc.createElement("div");
  viewport.className = "simple-mermaid-viewport";
  const canvas = doc.createElement("div");
  canvas.className = "simple-mermaid-canvas";
  viewport.append(canvas);
  frame.append(toolbar, viewport);
  node.before(frame);
  canvas.append(node);
  let scale = 1, x = 0, y = 0;
  let drag: { id: number; x: number; y: number; offsetX: number; offsetY: number } | null = null;
  let previousFocus: HTMLElement | null = null;
  let placeholder: Comment | null = null;
  const transform = () => { canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const endDrag = () => {
    const pointer = drag?.id;
    drag = null;
    if (pointer !== undefined && viewport.hasPointerCapture?.(pointer)) viewport.releasePointerCapture(pointer);
    viewport.classList.remove("is-dragging");
  };
  const mode = (value: Mode) => {
    endDrag();
    frame.dataset.mode = value;
    if (value === "fit") { scale = 1; x = y = 0; transform(); }
    toolbar.querySelectorAll<HTMLButtonElement>("[data-mermaid-mode]").forEach(button => {
      const active = button.dataset.mermaidMode === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };
  const button = (label: string, name: string, action: () => void, value?: Mode) => {
    const control = doc.createElement("button");
    control.type = "button";
    control.className = "clickable-icon simple-mermaid-icon-button";
    control.title = label;
    control.setAttribute("aria-label", label);
    if (value) control.dataset.mermaidMode = value;
    if (icon) icon(control, name); else control.textContent = label;
    control.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); action(); });
    toolbar.append(control);
    return control;
  };
  button("适应宽度", "move-horizontal", () => mode("fit"), "fit");
  button("画布模式", "hand", () => mode("canvas"), "canvas");
  const zoom = (next: number, pointerX: number, pointerY: number) => {
    const bounded = Math.max(.35, Math.min(4, next));
    const ratio = bounded / scale;
    x = pointerX - (pointerX - x) * ratio;
    y = pointerY - (pointerY - y) * ratio;
    scale = bounded;
    transform();
  };
  const zoomBy = (factor: number) => {
    mode("canvas");
    zoom(scale * factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  };
  button("缩小", "minus", () => zoomBy(.8));
  button("放大", "plus", () => zoomBy(1.25));
  const setFullscreen = (open: boolean) => {
    endDrag();
    if (open && !placeholder) {
      placeholder = doc.createComment("mermaid-viewer");
      frame.before(placeholder);
      doc.body.append(frame);
    } else if (!open && placeholder) {
      placeholder.replaceWith(frame);
      placeholder = null;
    }
    frame.classList.toggle("is-fullscreen", open);
    fullscreen.setAttribute("aria-expanded", String(open));
    const label = open ? "退出全屏" : "全屏";
    fullscreen.title = label;
    fullscreen.setAttribute("aria-label", label);
    if (!icon) fullscreen.textContent = label;
    if (open) {
      previousFocus = doc.activeElement as HTMLElement | null;
      fullscreen.focus();
    } else previousFocus?.focus();
  };
  const fullscreen = button("全屏", "maximize", () => setFullscreen(!frame.classList.contains("is-fullscreen")));
  fullscreen.setAttribute("aria-expanded", "false");
  frame.addEventListener("keydown", event => {
    if (event.key === "Escape" && frame.classList.contains("is-fullscreen")) { event.stopPropagation(); setFullscreen(false); }
  });
  viewport.addEventListener("wheel", event => {
    if (frame.dataset.mode !== "canvas") return;
    event.preventDefault(); event.stopPropagation();
    const rect = viewport.getBoundingClientRect();
    zoom(scale * Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener("pointerdown", event => {
    if (frame.dataset.mode !== "canvas" || event.button !== 0 || drag) return;
    const target = event.target as Element | null;
    if (target?.closest(".node, .edgePaths path, .edgeLabels, .cluster, text, foreignObject, a")) return;
    event.preventDefault();
    viewport.setPointerCapture?.(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, offsetX: x, offsetY: y };
    viewport.classList.add("is-dragging");
  });
  viewport.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    x = drag.offsetX + event.clientX - drag.x;
    y = drag.offsetY + event.clientY - drag.y;
    transform();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    viewport.addEventListener(name, event => { if (drag?.id === (event as PointerEvent).pointerId) endDrag(); });
  }
  mode("fit");
  return () => {
    endDrag();
    if (placeholder) { placeholder.replaceWith(frame); placeholder = null; }
    frame.before(node);
    frame.remove();
  };
}
