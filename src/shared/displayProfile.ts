import type { DisplayParameter, SimplePluginSettings } from "../types";
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

export function displayParameterEnabled(settings: SimplePluginSettings, mobile: boolean, key: DisplayParameter): boolean {
  const saved = settings.displayParameterSwitches?.[mobile ? "mobile" : "desktop"]?.[key];
  if (typeof saved === "boolean") return saved;
  if (key === "fontSize" || key === "lineHeight" || key === "letterSpacing" || key === "paragraphSpacing") {
    return !mobile && settings.desktopTypography.enabled;
  }
  if (key === "headerButtonSize") return mobile && !!settings.mobileDisplay.headerButtonSize;
  const profile = mobile ? settings.mobileDisplay : settings;
  return !!profile[key] && Number(profile[key]) > 0;
}

export function activeDisplayProfile(settings: SimplePluginSettings, mobile: boolean): DisplayProfile {
  const profile = mobile ? settings.mobileDisplay : settings;
  return {
    readableLineWidth: displayParameterEnabled(settings, mobile, "readableLineWidth") ? profile.readableLineWidth : "",
    imageMaxHeight: displayParameterEnabled(settings, mobile, "imageMaxHeight") ? profile.imageMaxHeight : "",
    popupWindowScale: displayParameterEnabled(settings, mobile, "popupWindowScale") ? profile.popupWindowScale : "",
  };
}
