export interface Columns { widths: number[]; content: string[] }
export function parseColumns(source: string): Columns | null {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const match = /^widths: ([\d:]+)$/.exec(lines[0] || "");
  if (!match) return null;
  const sizes = match[1].split(":").map(Number);
  const raw = lines.slice(1).join("\n").split(/^---column---$/m);
  const content = raw.map((part, index) => part.slice(index && part.startsWith("\n") ? 1 : 0, index < raw.length - 1 && part.endsWith("\n") ? -1 : undefined));
  if (content.length < 2 || content.length > 4 || sizes.length !== content.length || sizes.some(n => !Number.isFinite(n) || n < 10) || sizes.reduce((a, b) => a + b, 0) !== 100) return null;
  return { widths: sizes, content };
}
