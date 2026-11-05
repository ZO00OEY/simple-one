import { Setting as NativeSetting, ButtonComponent as NativeButton } from "obsidian";
import { styleActionButton, styleSettingIconAction } from "./actionButton";
import { setNativeTooltip, tooltipText } from "./tooltipText";

/** AI settings use the host controls and one native tooltip per setting row. */
export class Setting extends NativeSetting {
  constructor(parent: HTMLElement) { super(parent); this.settingEl.classList.add("simple-shared-setting"); }
  private details = "";
  setName(name: string | DocumentFragment): this {
    super.setName(name);
    if (this.details) setNativeTooltip(this.settingEl, tooltipText(this.nameEl.textContent ?? "", this.details));
    return this;
  }
  setDesc(description: string | DocumentFragment): this {
    this.details = typeof description === "string" ? description : description.textContent ?? "";
    super.setDesc("");
    if (this.details) setNativeTooltip(this.settingEl, tooltipText(this.nameEl.textContent ?? "", this.details));
    else this.settingEl.removeAttribute("aria-label");
    return this;
  }
  addButton(callback: Parameters<NativeSetting["addButton"]>[0]): this {
    return super.addButton(button => {
      callback(button);
      if (button.buttonEl.textContent?.trim()) styleActionButton(button.buttonEl, "text");
      else styleSettingIconAction(button.buttonEl);
    });
  }
  addExtraButton(callback: Parameters<NativeSetting["addExtraButton"]>[0]): this {
    return super.addExtraButton(button => { callback(button); if (button.extraSettingsEl) styleSettingIconAction(button.extraSettingsEl); });
  }
}

export class ButtonComponent extends NativeButton {
  constructor(parent: HTMLElement) { super(parent); styleActionButton(this.buttonEl, parent.closest(".setting-item") ? "bordered" : "plain"); }
  setIcon(icon: string): this {
    super.setIcon(icon);
    styleActionButton(this.buttonEl, this.buttonEl.textContent?.trim() ? "text" : this.buttonEl.closest(".setting-item") ? "bordered" : "plain");
    return this;
  }
  setButtonText(text: string): this { super.setButtonText(text); styleActionButton(this.buttonEl, "text"); return this; }
}
