export const POPUP_SCALE_MIN = 40;
export const POPUP_SCALE_MAX = 95;

export type PopupBounds = {
  width: number;
  height: number;
  left: number;
  top: number;
};

export function parsePopupScalePercent(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const percent = Number(text);
  return Number.isFinite(percent) && percent >= POPUP_SCALE_MIN && percent <= POPUP_SCALE_MAX
    ? percent
    : null;
}

export function normalizePopupScalePercent(value: unknown, fallback: string): string {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : fallback;
  if (!text) return "";
  const percent = parsePopupScalePercent(text);
  return percent === null ? fallback : String(Math.round(percent));
}

export function getMainAppWindow(app: {
  workspace: { rootSplit: unknown };
}): Window | null {
  const rootSplit = app.workspace.rootSplit as { containerEl?: HTMLElement };
  return rootSplit.containerEl?.ownerDocument.defaultView ?? null;
}

export function calculatePopupBounds(referenceWindow: Window, value: unknown): PopupBounds | null {
  const percent = parsePopupScalePercent(value);
  if (percent === null) return null;

  const scale = percent / 100;
  const screen = referenceWindow.screen as Screen & { availLeft?: number; availTop?: number };
  const availableLeft = screen.availLeft ?? referenceWindow.screenX;
  const availableTop = screen.availTop ?? referenceWindow.screenY;
  const width = Math.min(Math.round(referenceWindow.outerWidth * scale), screen.availWidth);
  const height = Math.min(Math.round(referenceWindow.outerHeight * scale), screen.availHeight);
  const centeredLeft = Math.round(referenceWindow.screenX + (referenceWindow.outerWidth - width) / 2);
  const centeredTop = Math.round(referenceWindow.screenY + (referenceWindow.outerHeight - height) / 2);

  return {
    width,
    height,
    left: Math.max(availableLeft, Math.min(centeredLeft, availableLeft + screen.availWidth - width)),
    top: Math.max(availableTop, Math.min(centeredTop, availableTop + screen.availHeight - height)),
  };
}

export function applyModalScale(
  modalEl: HTMLElement,
  value: unknown,
  referenceWindow: Window | null = modalEl.ownerDocument.defaultView
): void {
  modalEl.removeClass("simple-scaled-modal");
  modalEl.style.removeProperty("--simple-popup-width");
  modalEl.style.removeProperty("--simple-popup-height");

  if (!referenceWindow) return;
  const bounds = calculatePopupBounds(referenceWindow, value);
  if (!bounds) return;

  modalEl.addClass("simple-scaled-modal");
  modalEl.style.setProperty("--simple-popup-width", `${bounds.width}px`);
  modalEl.style.setProperty("--simple-popup-height", `${bounds.height}px`);
}
