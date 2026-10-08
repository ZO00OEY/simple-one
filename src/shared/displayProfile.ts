import type { SimplePluginSettings } from "../types";
import { normalizePopupScalePercent } from "./popupSizing";

export type DisplayProfile = Pick<SimplePluginSettings, "readableLineWidth" | "imageMaxHeight" | "popupWindowScale">;

export function loadMobileDisplayProfile(value: Partial<SimplePluginSettings["mobileDisplay"]> | undefined): SimplePluginSettings["mobileDisplay"] {
  const positivePixels = (input: unknown): string => {
    const text = typeof input === "string" ? input.trim() : typeof input === "number" ? String(input) : "";
    const pixels = Math.round(Number(text));
    return text && Number.isFinite(pixels) && pixels > 0 ? String(pixels) : "";
  };
  const width = positivePixels(value?.readableLineWidth);
  return {
    readableLineWidth: Number(width) <= 2000 ? width : "",
    imageMaxHeight: positivePixels(value?.imageMaxHeight),
    popupWindowScale: normalizePopupScalePercent(value?.popupWindowScale, "0"),
    headerButtonSize: value?.headerButtonSize === "" ? "" : String(Math.min(64, Math.max(20, Number(positivePixels(value?.headerButtonSize)) || 29))),
    disableThemeHeaderButtons: value?.disableThemeHeaderButtons !== false,
    compactBottomBar: value?.compactBottomBar !== false,
  };
}

export function activeDisplayProfile(settings: SimplePluginSettings, mobile: boolean): DisplayProfile {
  return mobile ? settings.mobileDisplay : settings;
}
