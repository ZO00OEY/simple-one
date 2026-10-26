import { AbstractInputSuggest, App, TFile, TFolder } from "obsidian";

export class DiaryPathSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, input: HTMLInputElement, private readonly folders: boolean, select: (path: string) => void) {
    super(app, input);
    this.onSelect(path => { select(path); this.close(); });
  }
  protected getSuggestions(query: string): string[] {
    const text = query.toLocaleLowerCase().replace(/\\/g, "/");
    return this.app.vault.getAllLoadedFiles()
      .filter(item => this.folders ? item instanceof TFolder && item.path !== "/" : item instanceof TFile && item.extension === "md")
      .map(item => item.path).filter(path => path.toLocaleLowerCase().includes(text))
      .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  }
  renderSuggestion(path: string, el: HTMLElement): void { el.setText(path); }
}
