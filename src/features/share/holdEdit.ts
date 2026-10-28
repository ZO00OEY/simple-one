/** Keep the held pointer alive when entering edit mode replaces the list. */
export function installShareHoldEdit(container: HTMLElement, enabled: (row: HTMLElement) => boolean,
  enter: (id?: string, directory?: string) => void,
  drop: (id: string | undefined, directory: string | undefined, target: string) => void,
  trash?: (id: string | undefined, directory: string | undefined) => void): () => void {
  const doc = container.ownerDocument, win = doc.defaultView!;
  let timer: number | undefined, pointer: number | undefined, x = 0, y = 0;
  let active = false, id: string | undefined, directory: string | undefined, target: HTMLElement | undefined;
  let suppressUntil = 0;
  let preview: HTMLElement | undefined;
  const finish = () => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined; pointer = undefined;
    target?.classList.remove("is-drop-target"); target = undefined;
    if (active) suppressUntil = Date.now() + 350;
    active = false;
    preview?.remove(); preview = undefined;
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", up, true);
    doc.removeEventListener("pointercancel", finish, true);
    doc.removeEventListener("keydown", key, true);
    win.removeEventListener("blur", finish);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    if (!active) { if (Math.hypot(event.clientX - x, event.clientY - y) > 6) finish(); return; }
    event.preventDefault();
    if (preview) { preview.style.left = `${event.clientX + 14}px`; preview.style.top = `${event.clientY + 14}px`; }
    target?.classList.remove("is-drop-target");
    const found = doc.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-share-directory], [data-share-trash]");
    target = found && container.contains(found) ? found : undefined;
    target?.classList.add("is-drop-target");
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const destination = target?.dataset.shareDirectory, held = active;
    const deleting = target?.hasAttribute("data-share-trash");
    if (held) event.preventDefault();
    finish();
    if (held && deleting) trash?.(id, directory);
    else if (held && destination !== undefined) drop(id, directory, destination);
  };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") finish(); };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const element = event.target as Element;
    if (element.closest("button, input, a, .setting-item-control")) return;
    const row = element.closest<HTMLElement>(".simple-share-note-row, [data-share-directory]");
    if (!row || !container.contains(row) || !enabled(row)) return;
    finish();
    id = row.dataset.shareNoteId; directory = id ? undefined : row.dataset.shareDirectory;
    if (!id && directory === undefined) return;
    pointer = event.pointerId; x = event.clientX; y = event.clientY;
    doc.addEventListener("pointermove", move, { capture: true, passive: false });
    doc.addEventListener("pointerup", up, true); doc.addEventListener("pointercancel", finish, true);
    doc.addEventListener("keydown", key, true); win.addEventListener("blur", finish);
    timer = win.setTimeout(() => {
      timer = undefined;
      if (!row.isConnected || !enabled(row)) { finish(); return; }
      const label = row.querySelector(".setting-item-name, .simple-share-folder-name")?.textContent || directory || "分享笔记";
      active = true; enter(id, directory);
      preview = doc.body.createDiv({ cls: "simple-share-drag-preview" });
      preview.textContent = label; preview.setAttribute("aria-hidden", "true");
      preview.style.left = `${x + 14}px`; preview.style.top = `${y + 14}px`; doc.body.append(preview);
    }, 600);
  };
  const suppress = (event: Event) => {
    if (active || Date.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  container.addEventListener("pointerdown", down);
  container.addEventListener("click", suppress, true); container.addEventListener("contextmenu", suppress, true);
  container.addEventListener("dragstart", suppress, true);
  return () => {
    finish(); container.removeEventListener("pointerdown", down);
    container.removeEventListener("click", suppress, true); container.removeEventListener("contextmenu", suppress, true);
    container.removeEventListener("dragstart", suppress, true);
  };
}
