import { Setting } from "obsidian";

/** Group settings in the same rounded panel at every page depth. */
export function settingsSection(parent: HTMLElement, title: string): HTMLElement {
  new Setting(parent).setName(title).setHeading().setClass("simple-section-title");
  return parent.createDiv({ cls: "simple-card" });
}
