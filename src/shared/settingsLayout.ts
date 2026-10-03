import { Setting } from "obsidian";

/** Keep section headings on the page background, with their controls in a card. */
export function settingsSection(parent: HTMLElement, title: string): HTMLElement {
  new Setting(parent).setName(title).setHeading().setClass("simple-section-title");
  return parent.createDiv({ cls: "simple-card" });
}
