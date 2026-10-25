import { setIcon } from "obsidian";

/** Native mouse dragging plus a held-pointer fallback for embedded windows. */
export function installShareDrag(container: HTMLElement, selected: Set<string>, canMove: (id: string) => boolean,
  selectionChanged: () => void, drop: (ids: string[], directory: string) => void): () => void {
  const doc = container.ownerDocument, win = doc.defaultView!;
  let timer: number | undefined, preview: HTMLElement | undefined, target: HTMLElement | undefined, heldRow: HTMLElement | undefined;
  let pointer: number | undefined, startX = 0, startY = 0, active = false, ids: string[] = [], suppressClickUntil = 0;
  const rowAt = (event: Event): HTMLElement | null => (event.target as Element | null)?.closest?.<HTMLElement>("[data-share-drag-id]") ?? null;
  const interactive = (event: Event): boolean => !!(event.target as Element | null)?.closest?.("button, input, a, .setting-item-control");
  const choose = (row: HTMLElement): string[] => {
    const id = row.dataset.shareDragId!;
    if (!selected.has(id)) { selected.clear(); selected.add(id); }
    const result = [...selected];
    if (!result.length || result.some(value => !canMove(value))) return [];
    container.querySelectorAll<HTMLInputElement>(".simple-share-selection").forEach(input => {
      input.checked = selected.has(input.dataset.shareId!);
      const element = input.closest<HTMLElement>(".simple-share-note-row")!;
      element.classList.toggle("is-selected", input.checked);
      element.querySelector('[role="checkbox"]')?.setAttribute("aria-checked", String(input.checked));
    });
    selectionChanged(); return result;
  };
  const makePreview = (row: HTMLElement, count: number, native = false): HTMLElement => {
    const element = doc.body.createDiv({ cls: `simple-share-drag-preview${native ? " is-native" : ""}`, attr: { "aria-hidden": "true" } });
    setIcon(element.createSpan({ cls: "simple-share-drag-icon" }), "file-text");
    element.createSpan({ text: count > 1 ? `${count} 篇分享笔记` : row.querySelector(".setting-item-name")?.textContent || "分享笔记" });
    return element;
  };
  const markTarget = (x: number, y: number) => {
    const found = doc.elementFromPoint(x, y)?.closest<HTMLElement>("[data-share-directory]");
    const next = found && container.contains(found) ? found : undefined;
    if (next === target) return;
    target?.classList.remove("is-drop-target"); target = next; target?.classList.add("is-drop-target");
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    if (!active) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 6) finish();
      return;
    }
    event.preventDefault();
    if (preview) { preview.style.left = `${event.clientX + 14}px`; preview.style.top = `${event.clientY + 14}px`; }
    markTarget(event.clientX, event.clientY);
  };
  const finish = () => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined; preview?.remove(); preview = undefined;
    if (heldRow?.isConnected) heldRow.draggable = true;
    heldRow = undefined;
    target?.classList.remove("is-drop-target"); target = undefined;
    container.classList.remove("is-dragging-shares");
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", up, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("keydown", keydown, true);
    win.removeEventListener("blur", cancel);
    if (active) suppressClickUntil = Date.now() + 350;
    active = false; pointer = undefined;
  };
  const cancel = () => finish();
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const moving = active, movingIds = ids;
    if (moving) { event.preventDefault(); markTarget(event.clientX, event.clientY); }
    const directory = target?.dataset.shareDirectory;
    finish();
    if (moving && directory !== undefined && movingIds.every(canMove)) drop(movingIds, directory);
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); finish(); } };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || interactive(event)) return;
    const row = rowAt(event);
    if (!row || !canMove(row.dataset.shareDragId!)) return;
    event.stopPropagation();
    finish(); pointer = event.pointerId; startX = event.clientX; startY = event.clientY;
    doc.addEventListener("pointermove", move, { capture: true, passive: false });
    doc.addEventListener("pointerup", up, true); doc.addEventListener("pointercancel", cancel, true);
    doc.addEventListener("keydown", keydown, true); win.addEventListener("blur", cancel);
    timer = win.setTimeout(() => {
      timer = undefined;
      if (!row.isConnected) { finish(); return; }
      ids = choose(row);
      if (!ids.length) { finish(); return; }
      heldRow = row; row.draggable = false;
      active = true; container.classList.add("is-dragging-shares");
      preview = makePreview(row, ids.length); preview.style.left = `${startX + 14}px`; preview.style.top = `${startY + 14}px`;
    }, 450);
  };
  const nativeStart = (event: DragEvent) => {
    if (active) { event.preventDefault(); event.stopPropagation(); return; }
    const row = rowAt(event);
    if (!row || interactive(event) || !event.dataTransfer) { event.preventDefault(); return; }
    event.stopPropagation();
    finish(); ids = choose(row);
    if (!ids.length) { event.preventDefault(); return; }
    event.dataTransfer.setData("application/x-simple-share-notes", ids.join(","));
    event.dataTransfer.effectAllowed = "move";
    preview = makePreview(row, ids.length, true);
    const image = preview;
    image.style.left = `${event.clientX + 14}px`; image.style.top = `${event.clientY + 14}px`;
    event.dataTransfer.setDragImage?.(preview, 10, 10);
    win.setTimeout(() => { if (image.isConnected) image.classList.add("is-captured"); }, 0);
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const context = (event: MouseEvent) => {
    if (active || timer !== undefined || Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const nativeEnd = () => { suppressClickUntil = Date.now() + 350; finish(); };
  container.addEventListener("pointerdown", down);
  container.addEventListener("dragstart", nativeStart);
  container.addEventListener("dragend", nativeEnd);
  container.addEventListener("click", click, true);
  container.addEventListener("contextmenu", context, true);
  return () => {
    finish(); container.removeEventListener("pointerdown", down); container.removeEventListener("dragstart", nativeStart);
    container.removeEventListener("dragend", nativeEnd); container.removeEventListener("click", click, true);
    container.removeEventListener("contextmenu", context, true);
  };
}
