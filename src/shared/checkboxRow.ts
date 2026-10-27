import { setIcon } from "obsidian";

export function checkboxRowIcon(row: HTMLElement, icon: string): void {
  const label = row.querySelector(".simple-display-checkbox-label");
  if (!label) return;
  const element = label.createSpan({ cls: "simple-checkbox-icon", attr: { "aria-hidden": "true" } });
  setIcon(element, icon);
  label.insertBefore(element, label.children[1]);
}

/** Layout only: callers retain persistence, error handling and right-side actions. */
export function checkboxRow(parent: HTMLElement, name: string, description: string, checked: boolean): {
  row: HTMLElement; input: HTMLInputElement;
} {
  const row = parent.createDiv({ cls: "simple-preview-checkbox-row simple-display-option-row", attr: { title: description } });
  const label = row.createEl("label", { cls: "simple-display-checkbox-label" });
  const input = label.createEl("input", { type: "checkbox", attr: { "aria-description": description } });
  input.checked = checked;
  label.createSpan({ text: name });
  return { row, input };
}
