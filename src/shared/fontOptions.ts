// Download links and family names belong together so each selection opens its own source.
export const CHINESE_FONTS = [
  { value: "jinkai", label: "仓耳今楷01", url: "https://tsanger.cn/product/4" },
  { value: "yahei", label: "微软雅黑", url: "https://learn.microsoft.com/en-us/typography/font-list/microsoft-yahei", system: true },
  { value: "wenkai", label: "霞鹜文楷", url: "https://github.com/lxgw/LxgwWenKai/releases/latest" },
  { value: "notoSerif", label: "思源宋体 / Noto Serif SC", url: "https://fonts.google.com/noto/specimen/Noto+Serif+SC" },
  { value: "notoSans", label: "思源黑体 / Noto Sans SC", url: "https://fonts.google.com/noto/specimen/Noto+Sans+SC" },
  { value: "default", label: "跟随 Obsidian", url: "" },
] as const;

export const LATIN_FONTS = [
  { value: "Source Sans 3", url: "https://raw.githubusercontent.com/adobe-fonts/source-sans/release/TTF/SourceSans3-Regular.ttf" },
  { value: "Source Serif 4", url: "https://github.com/adobe-fonts/source-serif/releases/latest" },
  { value: "Segoe UI", url: "", system: true },
  { value: "Times New Roman", url: "https://learn.microsoft.com/en-us/typography/font-list/times-new-roman", system: true },
  { value: "Georgia", url: "https://learn.microsoft.com/en-us/typography/font-list/georgia", system: true },
  { value: "default", url: "" },
] as const;

export function updateFontDownload(link: HTMLAnchorElement, font?: { value: string; url: string; system?: boolean }): void {
  link.hidden = !font?.url || !!font.system;
  if (link.hidden) link.removeAttribute("href");
  else link.href = font!.url;
  const name = font?.value || "";
  link.title = "下载并安装字体后，完全退出并重新打开 Obsidian。";
  link.setAttribute("aria-label", `下载 ${name}`);
}
