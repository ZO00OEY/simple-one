import type SimplePlugin from "../main";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

export function registerImageZoom(plugin: SimplePlugin): void {
  let overlay: HTMLElement | null = null;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null;

  const close = () => {
    overlay?.remove();
    overlay = null;
    document.removeEventListener("keydown", onKeyDown);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };

  const updateScale = (image: HTMLImageElement) => {
    image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };

  const open = (source: string, alt: string) => {
    close();
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    dragStart = null;
    overlay = document.body.createDiv({ cls: "simple-image-zoom-overlay" });
    const image = overlay.createEl("img", {
      cls: "simple-image-zoom-image",
      attr: { src: source, alt },
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("wheel", (event) => {
      event.preventDefault();
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + (event.deltaY < 0 ? 0.12 : -0.12)));
      updateScale(image);
    }, { passive: false });
    image.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      image.setPointerCapture(event.pointerId);
      image.addClass("is-dragging");
      dragStart = { x: event.clientX, y: event.clientY, offsetX, offsetY };
    });
    image.addEventListener("pointermove", (event) => {
      if (!dragStart) return;
      offsetX = dragStart.offsetX + event.clientX - dragStart.x;
      offsetY = dragStart.offsetY + event.clientY - dragStart.y;
      updateScale(image);
    });
    image.addEventListener("pointerup", (event) => {
      dragStart = null;
      image.removeClass("is-dragging");
      if (image.hasPointerCapture(event.pointerId)) image.releasePointerCapture(event.pointerId);
    });
    image.addEventListener("dblclick", () => {
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      updateScale(image);
    });
    document.addEventListener("keydown", onKeyDown);
  };

  plugin.registerDomEvent(document, "click", (event: MouseEvent) => {
    if (!plugin.settings.enableImageZoom || event.button !== 0 || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const control = target?.closest(".simple-columns-image-zoom");
    const image = (control?.closest(".simple-columns-edit-block")?.querySelector("img") || target?.closest("img")) as HTMLImageElement | null;
    if (!image || image.closest(".simple-image-zoom-overlay")) return;
    if (!image.closest(".markdown-reading-view, .markdown-source-view, .markdown-preview-view, .markdown-rendered")) return;

    const source = image.currentSrc || image.src;
    if (!source) return;
    event.preventDefault();
    event.stopPropagation();
    open(source, image.alt || "");
  }, { capture: true });

  plugin.register(close);
}
