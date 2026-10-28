export type ColorSpace = "RGB" | "HSL" | "HEX";
const hex = (rgb: number[]): string => "#" + rgb.map(n => Math.round(n).toString(16).padStart(2, "0")).join("");

export function colorRgb(value: string): number[] {
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
}

export function colorHsl(value: string): number[] {
  const [r, g, b] = colorRgb(value).map(n => n / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, light = (max + min) / 2;
  const hue = !delta ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [Math.round(hue * 60) % 360, Math.round(delta ? delta / (1 - Math.abs(2 * light - 1)) * 100 : 0), Math.round(light * 100)];
}

export function hsvHex(h: number, s: number, v: number): string {
  const sector = h / 60, chroma = v * s, x = chroma * (1 - Math.abs(sector % 2 - 1)), m = v - chroma;
  const rgb = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return hex(rgb.map(n => (n + m) * 255));
}

export function parseColorValue(space: ColorSpace, value: string): string | null {
  if (space === "HEX") {
    const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim());
    if (!match) return null;
    return "#" + (match[1].length === 3 ? [...match[1]].map(c => c + c).join("") : match[1]).toLowerCase();
  }
  const parts = value.trim().split(/[,，\s]+/);
  if (parts.length !== 3 || parts.some(part => !/^\d+(?:\.\d+)?%?$/.test(part))) return null;
  if (space === "RGB" && parts.some(part => part.endsWith("%"))) return null;
  const numbers = parts.map(part => Number(part.replace(/%$/, "")));
  const limits = space === "RGB" ? [255, 255, 255] : [360, 100, 100];
  if (numbers.some((n, i) => n > limits[i])) return null;
  if (space === "RGB") return hex(numbers);
  const [h, s, l] = numbers;
  const light = l / 100, v = light + s / 100 * Math.min(light, 1 - light);
  return hsvHex(h % 360, v ? 2 * (1 - light / v) : 0, v);
}
