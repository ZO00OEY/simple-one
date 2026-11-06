export { Setting, ButtonComponent } from "../../../src/shared/settingControls";
import type { ButtonComponent } from "obsidian";
import { requireApiVersion } from "obsidian";

/** Keep destructive buttons available on the AI module's supported pre-1.13 hosts. */
export function destructiveButton<T extends ButtonComponent>(button: T): T {
  if (requireApiVersion("1.13.0")) button.setDestructive();
  else button.buttonEl.addClass("mod-warning");
  return button;
}
