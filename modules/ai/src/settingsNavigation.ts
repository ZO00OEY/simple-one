import { Setting, setIcon } from "obsidian";

export function settingsNavigation(setting: Setting, open: () => void): void {
  const row = setting.settingEl;
  row.addClass("simple-ai-settings-navigation");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  const arrow = setting.controlEl.createEl("button", { cls: "simple-ai-settings-arrow", attr: { type: "button", "aria-label": `进入${setting.nameEl.textContent ?? "设置"}` } });
  row.removeAttribute("role");
  row.removeAttribute("tabindex");
  setIcon(arrow, "settings");
  row.addEventListener("click", open);

}
