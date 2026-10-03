// Obsidian installs its DOM helpers in each window, including popout windows.
interface Window {
  CSSStyleSheet: typeof CSSStyleSheet;
  createEl: typeof createEl;
  createDiv: typeof createDiv;
  createSpan: typeof createSpan;
  createSvg: typeof createSvg;
}

interface HTMLElementTagNameMap {
  webview: HTMLElement & { executeJavaScript(script: string): Promise<string> };
}
