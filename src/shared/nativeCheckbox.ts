import { setNativeTooltip } from "./tooltipText";
import { type ToggleComponent } from "obsidian";

/** Use a native input, like Simple One; preserve the existing settings callbacks. */
export function nativeCheckbox(toggle: ToggleComponent): ToggleComponent {
  const row = toggle.toggleEl.closest<HTMLElement>(".setting-item");
  const input = toggle.toggleEl.createEl("input");
  input.type = "checkbox";
  input.className = "simple-native-checkbox";
  input.checked = toggle.getValue();
  input.setAttribute("aria-label", row?.querySelector(".setting-item-name")?.textContent ?? "启用");
  toggle.toggleEl.remove();
  row?.addClass("simple-native-checkbox-row");
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
