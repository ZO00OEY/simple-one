import { DEFAULT_SETTINGS, type ThemeFormattingSettings, type QuickFormatSettings, type QuickFormatHeadingLevel, type TypographySettings } from "../types";
import { CHINESE_FONTS, LATIN_FONTS } from "./fontOptions";

export const TYPOGRAPHY_DEFAULTS = DEFAULT_SETTINGS.desktopTypography;

export function isStandaloneBoldLine(text: string): boolean {
  const match = /^(\*\*|__)(\S(?:.*\S)?)\1$/.exec(text.trim());
  return !!match && !match[2].includes(match[1]);
}

export const TYPOGRAPHY_RANGES = {
  lineHeight: [1.2, 2.4, 0.1], fontSize: [12, 36, 1],
  letterSpacing: [-0.05, 0.2, 0.01], paragraphSpacing: [0, 2, 0.1],
} as const;

export function normalizeTypography(value?: Partial<TypographySettings>): TypographySettings {
  const result = { ...TYPOGRAPHY_DEFAULTS };
  if (typeof value?.latinFontEnabled === "boolean") result.latinFontEnabled = value.latinFontEnabled;
  if (value?.latinFont && LATIN_FONTS.some(font => font.value === value.latinFont)) result.latinFont = value.latinFont;
  for (const key of ["interfaceFontEnabled", "textFontEnabled"] as const) {
    if (typeof value?.[key] === "boolean") result[key] = value[key]!;
  }
  result.latinLetterSpacing = typeof value?.latinLetterSpacing === "number" && Number.isFinite(value.latinLetterSpacing)
    ? Math.min(0.2, Math.max(-0.05, value.latinLetterSpacing)) : 0;
  result.latinLetterSpacingEnabled = value?.latinLetterSpacingEnabled !== false;
  for (const key of ["interfaceFont", "textFont"] as const) {
    const font = value?.[key];
    if (font && CHINESE_FONTS.some(option => option.value === font)) result[key] = font;
  }
  for (const key of Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]) {
    const number = key === "letterSpacing" && value?.letterSpacingUnit !== "em" ? TYPOGRAPHY_DEFAULTS.letterSpacing : value?.[key];
    const [min, max] = TYPOGRAPHY_RANGES[key];
    if (typeof number === "number" && Number.isFinite(number)) result[key] = Math.min(max, Math.max(min, number));
  }
  result.enabled = typeof value?.enabled === "boolean" ? value.enabled : result.enabled;
  result.paragraphStyle = value?.paragraphStyle === "indent" ? "indent" : "spaced";
  return result;
}

/** Persist only missing/smaller heading overrides; valid larger choices stay intact. */
export function headingFontFloorPatch(sizes: Record<QuickFormatHeadingLevel, string>, body: number,
  rendered: Record<QuickFormatHeadingLevel, number>): Partial<Record<QuickFormatHeadingLevel, string>> {
  const patch: Partial<Record<QuickFormatHeadingLevel, string>> = {};
  if (!Number.isFinite(body) || body < 10 || body > 96) return patch;
  const value = String(Math.ceil(body * 1000) / 1000);
  for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"] as QuickFormatHeadingLevel[]) {
    const explicit = Number(sizes[level]);
    const candidate = sizes[level].trim() && explicit >= 10 && explicit <= 96 ? explicit : rendered[level];
    if (Number.isFinite(candidate) && candidate > 0 && candidate < body) patch[level] = value;
  }
  return patch;
}

/** Initialize missing appearance choices once; an empty value after reset must stay empty. */
export function initializeHeadingDefaults(settings: QuickFormatSettings): boolean {
  if (settings.headingDefaultsVersion >= 3) return false;
  if (!settings.headingDefaultsVersion && Object.values(settings.headingColors).every(color => !color.trim())) {
    Object.assign(settings.headingColors, { h1: "#222222", h2: "#222222", h4: "#478f14", h6: "#222222" });
  } else if (settings.headingDefaultsVersion) {
    for (const level of ["h1", "h2", "h6"] as QuickFormatHeadingLevel[]) {
      if (settings.headingColors[level] === "var(--text-normal)") settings.headingColors[level] = "#222222";
    }
    if (settings.headingColors.h4.toLowerCase() === "#168c54") settings.headingColors.h4 = "#478f14";
  }
  settings.headingDefaultsVersion = 3;
  return true;
}

/** Empty after initialization means follow the current theme, including after restart. */
export function initializeFormattingDefaults(settings: { themeFormattingDefaultsVersion: number; themeFormatting: ThemeFormattingSettings }): boolean {
  if (settings.themeFormattingDefaultsVersion >= 1) return false;
  if (!settings.themeFormatting.highlightBackground) settings.themeFormatting.highlightBackground = "#ffd00066";
  settings.themeFormattingDefaultsVersion = 1;
  return true;
}
