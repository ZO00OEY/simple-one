import type { ToggleComponent } from "obsidian";
import { settingsFieldset } from "../../../src/shared/settingsLayout";
import { nativeCheckbox } from "../../../src/shared/nativeCheckbox";

export function settingsSection(parent: HTMLElement, title: string, extraClass = ""): HTMLElement {
  return settingsFieldset(parent, title, `simple-ai-model-settings-module simple-ai-settings-section ${extraClass}`.trim());
}
export function settingsCheckbox(toggle: ToggleComponent): ToggleComponent {
  const row = toggle.toggleEl.closest<HTMLElement>(".setting-item");
  nativeCheckbox(toggle);
  row?.addClass("simple-ai-checkbox-setting");
  return toggle;
}
