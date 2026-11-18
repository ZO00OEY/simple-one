type Mode = "native" | "fit" | "height" | "manual";
type Interaction = "" | "zoom";

/** Browser-only viewing controls; the host supplies icons and visual styling. */
export function enhanceMermaid(node: HTMLElement, icon?: (button: HTMLButtonElement, name: string) => void, foldLong = false): (() => void) | null {
  const svg = node.querySelector<SVGSVGElement>("svg");
  if (!svg || node.closest(".simple-mermaid-frame")) return null;
  const originalWidth = svg.style.width;
  // The standalone reader uses its own responsive sizing; Obsidian keeps its native SVG width.
  if (!foldLong && svg.viewBox.baseVal.width > 0) svg.style.width = `min(100%, ${svg.viewBox.baseVal.width}px)`;
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
  let hold: { id: number; x: number; y: number; timer: number } | null = null;
  let previousFocus: HTMLElement | null = null;
  let placeholder: Comment | null = null;
  const win = doc.defaultView!;
  let expanded = false;
  const fold = doc.createElement("button");
  fold.type = "button";
  fold.className = "simple-mermaid-fold";
  fold.hidden = true;
  const updateFold = () => {
    const long = foldLong && canvas.offsetHeight > win.innerHeight / 2;
    const fullscreen = frame.classList.contains("is-fullscreen");
    frame.classList.toggle("is-collapsed", long && !expanded && !fullscreen);
    fold.hidden = !long || fullscreen;
    fold.textContent = expanded ? "收起流程图" : "展开完整流程图";
    fold.setAttribute("aria-expanded", String(expanded));
  };
  fold.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation();
    expanded = !expanded;
    mode("native");
    updateFold();
  });
  if (foldLong) frame.append(fold);
  const transform = () => { canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const cancelHold = () => {
    if (hold) win.clearTimeout(hold.timer);
    hold = null;
  };
  const endDrag = () => {
    cancelHold();
    const pointer = drag?.id;
    drag = null;
    if (pointer !== undefined && viewport.hasPointerCapture?.(pointer)) viewport.releasePointerCapture(pointer);
    viewport.classList.remove("is-dragging");
  };
  const mode = (value: Mode) => {
    endDrag();
    if (value !== "manual") interaction("");
    // Keep zoom controls from changing the space occupied by the diagram.
    if (value !== "native" && frame.dataset.mode === "native") viewport.style.height = `${viewport.clientHeight}px`;
    if (value === "native") viewport.style.removeProperty("height");
    frame.dataset.mode = value;
    if (value === "native") { scale = 1; x = y = 0; transform(); }
    if (value === "fit" || value === "height") {
      const rect = svg.getBoundingClientRect();
      const width = rect.width / scale || svg.viewBox.baseVal.width;
      const height = rect.height / scale || svg.viewBox.baseVal.height;
      if (value === "height") viewport.style.height = `${win.innerHeight * .7}px`;
      if (width > 0 && height > 0 && viewport.clientWidth > 0) {
        scale = value === "height"
          ? Math.min(win.innerHeight * .7 / height, viewport.clientWidth / width)
          : viewport.clientWidth / width;
        x = (viewport.clientWidth - canvas.clientWidth * scale) / 2;
        y = value === "height" ? Math.max(0, (viewport.clientHeight - height * scale) / 2) : 0;
      } else { scale = 1; x = y = 0; }
      transform();
    }
    toolbar.querySelectorAll<HTMLButtonElement>("[data-mermaid-mode]").forEach(button => {
      const active = button.dataset.mermaidMode === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };
  const interaction = (value: Interaction) => {
    endDrag();
    frame.dataset.interaction = value;
    toolbar.querySelectorAll<HTMLButtonElement>("[data-mermaid-interaction]").forEach(button => {
      const active = button.dataset.mermaidInteraction === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };
  const button = (label: string, name: string, action: () => void, value?: Mode) => {
    const control = doc.createElement("button");
    control.type = "button";
    control.className = "clickable-icon simple-mermaid-icon-button";
    if (!icon) control.title = label;
    control.setAttribute("aria-label", label);
    if (value) control.dataset.mermaidMode = value;
    if (icon) icon(control, name); else control.textContent = label;
    control.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); action(); });
    toolbar.append(control);
    return control;
  };
  button("恢复原始大小", "rotate-ccw", () => mode("native"));
  button("适应宽度", "move-horizontal", () => mode("fit"), "fit");
  button("适应高度（屏幕的 70%）", "move-vertical", () => mode("height"), "height");
  const magnifier = button("滚动缩放", "search", () => interaction(frame.dataset.interaction === "zoom" ? "" : "zoom"));
  magnifier.dataset.mermaidInteraction = "zoom";
  const zoom = (next: number, pointerX: number, pointerY: number) => {
    const bounded = Math.max(.01, Math.min(4, next));
    const ratio = bounded / scale;
    x = pointerX - (pointerX - x) * ratio;
    y = pointerY - (pointerY - y) * ratio;
    scale = bounded;
    transform();
  };
  const zoomBy = (factor: number) => {
    mode("manual");
    zoom(scale * factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  };
  button("缩小", "minus", () => zoomBy(1 / 1.1));
  button("放大", "plus", () => zoomBy(1.1));
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
    updateFold();
    const activeMode = (frame.dataset.mode as Mode) || "native";
    if (activeMode !== "manual") mode(activeMode);
    fullscreen.setAttribute("aria-expanded", String(open));
    const label = open ? "退出全屏" : "全屏";
    if (!icon) fullscreen.title = label;
    fullscreen.setAttribute("aria-label", label);
    if (icon) {
      fullscreen.replaceChildren();
      icon(fullscreen, open ? "x" : "maximize");
      if (open) fullscreen.append(label);
    } else fullscreen.textContent = label;
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
    cancelHold();
    if (frame.dataset.interaction !== "zoom") return;
    event.preventDefault(); event.stopPropagation();
    mode("manual");
    const rect = viewport.getBoundingClientRect();
    zoom(scale * Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener("pointerdown", event => {
    if (event.pointerType !== "mouse" || event.button !== 0 || drag || hold) return;
    const target = event.target as Element | null;
    if (target?.closest("text, foreignObject, a, button, input, textarea, select, [contenteditable]")) return;
    hold = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      timer: win.setTimeout(() => {
        const ready = hold;
        if (!ready) return;
        hold = null;
        mode("manual");
        try { viewport.setPointerCapture?.(ready.id); } catch { return; }
        drag = { id: ready.id, x: ready.x, y: ready.y, offsetX: x, offsetY: y };
        viewport.classList.add("is-dragging");
      }, 350),
    };
  });
  viewport.addEventListener("pointermove", event => {
    if (hold?.id === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 6) cancelHold();
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    x = drag.offsetX + event.clientX - drag.x;
    y = drag.offsetY + event.clientY - drag.y;
    transform();
  });
  viewport.addEventListener("pointerleave", cancelHold);
  const release = (event: PointerEvent) => {
    if (drag?.id === event.pointerId || hold?.id === event.pointerId) endDrag();
  };
  doc.addEventListener("pointerup", release, true);
  doc.addEventListener("pointercancel", release, true);
  viewport.addEventListener("lostpointercapture", release);
  win.addEventListener("blur", endDrag);
  mode("native");
  updateFold();
  const onResize = () => {
    updateFold();
    if (frame.dataset.mode === "fit" || frame.dataset.mode === "height") mode(frame.dataset.mode);
  };
  const resize = win.ResizeObserver ? new win.ResizeObserver(onResize) : null;
  resize?.observe(canvas);
  win.addEventListener("resize", onResize);
  return () => {
    endDrag();
    doc.removeEventListener("pointerup", release, true);
    doc.removeEventListener("pointercancel", release, true);
    win.removeEventListener("blur", endDrag);
    resize?.disconnect();
    win.removeEventListener("resize", onResize);
    svg.style.width = originalWidth;
    if (placeholder) { placeholder.replaceWith(frame); placeholder = null; }
    frame.before(node);
    frame.remove();
  };
}
