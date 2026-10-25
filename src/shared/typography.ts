import { DEFAULT_SETTINGS, type TypographySettings } from "../types";

export const TYPOGRAPHY_DEFAULTS = DEFAULT_SETTINGS.desktopTypography;

export function isStandaloneBoldLine(text: string): boolean {
  const match = /^(\*\*|__)(\S(?:.*\S)?)\1$/.exec(text.trim());
  return !!match && !match[2].includes(match[1]);
}

export const TYPOGRAPHY_RANGES = {
  fontSize: [12, 36, 1], lineHeight: [1.2, 2.4, 0.1],
  letterSpacing: [-0.5, 3, 0.1], paragraphSpacing: [0, 2, 0.1],
} as const;

export function normalizeTypography(value?: Partial<TypographySettings>): TypographySettings {
  const result = { ...TYPOGRAPHY_DEFAULTS };
  for (const key of Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]) {
    const number = value?.[key];
    const [min, max] = TYPOGRAPHY_RANGES[key];
    if (typeof number === "number" && Number.isFinite(number)) result[key] = Math.min(max, Math.max(min, number));
  }
  result.enabled = typeof value?.enabled === "boolean" ? value.enabled : result.enabled;
  result.paragraphStyle = value?.paragraphStyle === "indent" ? "indent" : "spaced";
  return result;
}
