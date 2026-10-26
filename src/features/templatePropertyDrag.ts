// Keep the draft array and visible rows in the same order without rebuilding a held button.
export function registerTemplatePropertyDrag(list: HTMLElement, properties: string[]): () => void {
  const doc = list.ownerDocument;
  const ownerWindow = doc.defaultView ?? window;
  let stop = (): void => {};
  let suppressClick = false;
  const syncRows = (): void => {
    for (const property of properties) {
      const row = Array.from(list.children).find(child => (child as HTMLElement).dataset.property === property);
      if (row) list.appendChild(row);
    }
  };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".simple-template-property-tag > button:first-child");
    if (!button || button.disabled || button.closest("fieldset:disabled")) return;
    stop();
    suppressClick = false;
    const row = button.parentElement!;
    const property = row.dataset.property!;
    const original = [...properties];
    let dragging = false;
    let ghost: HTMLElement | undefined;
    const bounds = row.getBoundingClientRect();
    const activate = (): void => {
      if (dragging) return;
      dragging = suppressClick = true;
      ghost = row.cloneNode(true) as HTMLElement;
      ghost.classList.add("simple-template-property-drag-ghost");
      ghost.setAttribute("aria-hidden", "true");
      ghost.querySelectorAll("button").forEach(control => { control.tabIndex = -1; });
      Object.assign(ghost.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      doc.body.appendChild(ghost);
      row.classList.add("is-dragging");
    };
    const timer = ownerWindow.setTimeout(activate, 200);
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      if (!dragging) {
        if (Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) <= 5) return;
        if (event.pointerType === "touch") { stop(); return; }
        activate();
      }
      next.preventDefault();
      if (ghost) ghost.style.transform = `translate(${next.clientX - event.clientX}px, ${next.clientY - event.clientY}px)`;
      const others = Array.from(list.children).filter(child => child !== row);
      const target = others.findIndex(child => {
        const bounds = child.getBoundingClientRect();
        return next.clientY < bounds.top + bounds.height / 2;
      });
      const index = target < 0 ? others.length : target;
      const from = properties.indexOf(property);
      if (from !== index) {
        const positions = others.map(child => ({ child, top: child.getBoundingClientRect().top }));
        properties.splice(from, 1);
        properties.splice(index, 0, property);
        syncRows();
        if (!doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
          for (const { child, top } of positions) {
            const delta = top - child.getBoundingClientRect().top;
            if (delta) child.animate?.([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 160, easing: "ease-out" });
          }
        }
      }
    };
    const end = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      if (next.type === "pointercancel" && dragging) {
        properties.splice(0, properties.length, ...original);
        syncRows();
      }
      stop();
    };
    stop = () => {
      ownerWindow.clearTimeout(timer);
      ghost?.remove();
      row.classList.remove("is-dragging");
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", end);
      doc.removeEventListener("pointercancel", end);
      stop = () => {};
    };
    doc.addEventListener("pointermove", move, { passive: false });
    doc.addEventListener("pointerup", end);
    doc.addEventListener("pointercancel", end);
  };
  const click = (event: MouseEvent): void => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  list.addEventListener("pointerdown", down);
  list.addEventListener("click", click, true);
  return () => {
    stop();
    list.removeEventListener("pointerdown", down);
    list.removeEventListener("click", click, true);
  };
}
