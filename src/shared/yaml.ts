export function toYamlValue(value: string): string {
  if (!value) return "";

  if (value.includes("\n")) {
    return "|\n" + value.split("\n").map((line) => "  " + line).join("\n");
  }

  if (/[:"'{}[\],&#!|>%@`]/.test(value) || value.includes("---")) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  if (value !== value.trim()) {
    return `"${value}"`;
  }

  return value;
}

