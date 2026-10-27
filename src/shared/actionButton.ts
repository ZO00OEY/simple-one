import { setIcon } from "obsidian";

export type ActionButtonStyle = "plain" | "bordered" | "danger" | "text";
export const DELETE_ICON = "trash-2";

export function createActionButton(parent: HTMLElement, icon: string, label: string, style: ActionButtonStyle = "plain"): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: label, "aria-label": label } });
  setActionIcon(button, icon, style);
  return button;
}

export function setDeleteIcon(element: HTMLElement, style: ActionButtonStyle = "danger"): void {
  setActionIcon(element, DELETE_ICON, style);
}

/** Size and appearance only; callers retain labels, events and disabled state. */
export function styleActionButton(element: HTMLElement, style: ActionButtonStyle = "plain"): void {
  element.classList.add("simple-action-button");
  element.classList.remove("simple-action-button--plain", "simple-action-button--bordered", "simple-action-button--danger", "simple-action-button--text");
  element.classList.add(`simple-action-button--${style}`);
}

export function setActionIcon(element: HTMLElement, icon: string, style: ActionButtonStyle = "plain"): void {
  const button = element.closest<HTMLElement>("button, [role='button']") ?? element;
  styleActionButton(button, style);
  setIcon(element, icon);
}

export function styleActionFooter(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
    if (!button.classList.contains("simple-action-button")) styleActionButton(button, "text");
  });
}
