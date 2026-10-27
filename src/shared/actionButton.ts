import { setIcon } from "obsidian";

export type ActionButtonStyle = "plain" | "bordered" | "danger" | "text";
export const DELETE_ICON = "trash-2";

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
