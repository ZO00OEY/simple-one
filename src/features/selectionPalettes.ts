// Sampled from the supplied Feishu screenshot, rather than an official palette specification.
const FEISHU_TEXT = ["#1f2329", "#8f959e", "#e60f61", "#d83931", "#de7802", "#2ea121", "#168c54", "#2f80ed", "#6425d0"];
const PERSONAL = ["#824ce6", "#e60f61", "#ed393b", "#168c54", "#2f80ed"];

export function tintSelectionColor(color: string, amount: number): string {
  return "#" + [1, 3, 5].map(index => Math.round(255 + (parseInt(color.slice(index, index + 2), 16) - 255) * amount).toString(16).padStart(2, "0")).join("");
}

export function selectionPalette(name: "feishu" | "personal"): { text: string[]; background: string[] } {
  const text = name === "feishu" ? FEISHU_TEXT : ["#303338", "#8a8f98", ...PERSONAL, "#de7802", "#2ea121"];
  return { text, background: text.map(color => tintSelectionColor(color, 0.2)) };
}

export function selectionColors(favorites: string[] = []): string[] {
  // Coalesce the previous preset variants for display without changing saved favorites.
  const aliases: Record<string, string> = { "#ed393b": "#d83931", "#245bdb": "#2f80ed", "#824ce6": "#6425d0" };
  const colors = [...new Set([...FEISHU_TEXT, ...favorites].map(color => aliases[color.toLowerCase()] ?? color.toLowerCase()))].filter(color => /^#[\da-f]{6}$/i.test(color));
  const hue = (color: string): number => {
    const [r, g, b] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
    const max = Math.max(r, g, b), delta = max - Math.min(r, g, b);
    if (!delta || delta / max < 0.3) return -1000 + max;
    const value = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
    return value > 330 ? value - 360 : value;
  };
  return colors.sort((a, b) => hue(a) - hue(b));
}
