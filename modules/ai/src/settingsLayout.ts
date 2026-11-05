import { setNativeTooltip } from "./tooltipText";
import { type ToggleComponent } from "obsidian";

export function settingsSection(parent: HTMLElement, title: string, extraClass = ""): HTMLElement {
  const group = parent.createEl("fieldset", { cls: "simple-ai-model-settings-module simple-ai-settings-section" });
  if (extraClass) group.addClass(...extraClass.split(" ").filter(Boolean));
  group.createEl("legend", { text: title });
  return group;
}

/** Use a native input, like Simple One; preserve the existing settings callbacks. */
export function settingsCheckbox(toggle: ToggleComponent): ToggleComponent {
  const row = toggle.toggleEl.closest<HTMLElement>(".setting-item");
  const input = (row?.ownerDocument ?? document).createElement("input");
  input.type = "checkbox";
  input.className = "simple-ai-native-checkbox";
  input.checked = toggle.getValue();
  input.setAttribute("aria-label", row?.querySelector(".setting-item-name")?.textContent ?? "启用");
  toggle.toggleEl.remove();
  row?.addClass("simple-ai-checkbox-setting");
  row?.prepend(input);
  let changed: (value: boolean) => unknown = () => {};
  input.addEventListener("change", () => { void changed(input.checked); });
  toggle.getValue = () => input.checked;
  toggle.setValue = value => { input.checked = value; return toggle; };
  toggle.setDisabled = value => { input.disabled = value; return toggle; };
  toggle.onChange = callback => { changed = callback; return toggle; };
  toggle.setTooltip = value => { setNativeTooltip(input, value); return toggle; };
  return toggle;
}
