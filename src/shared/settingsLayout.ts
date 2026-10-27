import { Setting } from "obsidian";

/** Compact settings share the same frame, row spacing and controls. */
export function compactSettingsSection(parent: HTMLElement, title: string): HTMLElement {
  return settingsFieldset(parent, title, "simple-compact-settings-section");
}

export function settingsFieldset(parent: HTMLElement, title: string, extraClass = ""): HTMLElement {
  const section = parent.createEl("fieldset", { cls: "simple-preview-checkbox-group" });
  if (extraClass) section.addClass(...extraClass.split(" ").filter(Boolean));
  section.createEl("legend", { text: title });
  return section;
}

export function settingsHeading(parent: HTMLElement, title: string | DocumentFragment, extraClass?: string): Setting {
  const heading = new Setting(parent).setName(title).setHeading().setClass("simple-section-title");
  if (extraClass) heading.setClass(extraClass);
  return heading;
}

export function settingsCard(parent: HTMLElement, render: (card: HTMLElement) => void): void {
  render(parent.createDiv({ cls: "simple-card" }));
}

export function settingsGroup(parent: HTMLElement, title: string, render: (card: HTMLElement) => void): void {
  render(settingsSection(parent, title));
}

/** Group settings in the same rounded panel at every page depth. */
export function settingsSection(parent: HTMLElement, title: string): HTMLElement {
  settingsHeading(parent, title);
  return parent.createDiv({ cls: "simple-card" });
}
