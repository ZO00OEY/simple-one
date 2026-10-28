import { Modal, Notice, setIcon } from "obsidian";
import type SimplePlugin from "../main";
import { colorRgb, hsvHex, parseColorValue } from "./colorValues";

export const FAVORITE_COLORS = ["#f6f7f9", "#824ce6", "#e60f61", "#ed393b", "#168c54", "#2f80ed"];

export function readThemePalette(context: HTMLElement, plugin: SimplePlugin): string[] {
  const doc = context.ownerDocument;
  const frame = doc.win.createEl("iframe");
  frame.hidden = true;
  frame.setAttribute("sandbox", "allow-same-origin");
  doc.body.append(frame);
  try {
    const isolated = frame.contentDocument!;
    // The sandboxed iframe document has no Obsidian DOM helpers.
    const style = isolated.createElement("style");
    const base = [...doc.styleSheets].find(sheet => sheet.href?.endsWith("/app.css"));
    const theme = (plugin.app as typeof plugin.app & { customCss?: { styleEl?: HTMLStyleElement } }).customCss?.styleEl;
    // Resolve only stock Obsidian + the theme stylesheet, never live overrides/snippets.
    style.textContent = (base ? [...base.cssRules].map(rule => rule.cssText).join("\n") : "") + "\n" + (theme?.textContent || "");
    isolated.head.append(style);
    isolated.body.className = `${doc.body.classList.contains("theme-dark") ? "theme-dark" : "theme-light"} is-desktop mod-windows`;
    return readComputedPalette(isolated.body);
  } finally { frame.remove(); }
}

function readComputedPalette(context: HTMLElement): string[] {
  // This also runs in the sandboxed iframe, outside Obsidian's augmented window.
  const sample = context.ownerDocument.createElement("span");
  context.append(sample);
  sample.hidden = true;
  const colors = ["--interactive-accent", "--color-purple", "--color-pink", "--color-red", "--color-orange", "--color-yellow", "--color-green", "--color-cyan", "--color-blue", "--text-normal", "--background-primary"].flatMap(variable => {
    sample.style.color = `var(${variable})`;
    const channels = sample.ownerDocument.defaultView!.getComputedStyle(sample).color.match(/[\d.]+/g)?.slice(0, 3);
    const color = channels ? parseColorValue("RGB", channels.join(",")) : null;
    return color ? [color] : [];
  });
  sample.remove();
  return [...new Set(colors)];
}

export function installPaletteScroll(row: HTMLElement): void {
  let pointer: number | undefined, start = 0, scroll = 0, dragged = false;
  row.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    pointer = event.pointerId; start = event.clientX; scroll = row.scrollLeft; dragged = false;
  });
  row.addEventListener("pointermove", event => {
    if (event.pointerId !== pointer) return;
    if (!dragged && Math.abs(event.clientX - start) <= 5) return;
    dragged = true; row.setPointerCapture(event.pointerId); event.preventDefault();
    row.scrollLeft = scroll + start - event.clientX;
  });
  row.addEventListener("pointerup", () => { pointer = undefined; });
  row.addEventListener("pointercancel", () => { pointer = undefined; dragged = false; });
  row.addEventListener("pointerleave", () => { if (!dragged) pointer = undefined; });
  row.addEventListener("click", event => { if (dragged) { event.preventDefault(); event.stopImmediatePropagation(); dragged = false; } }, true);
  row.addEventListener("wheel", event => {
    const delta = event.deltaX || event.deltaY, before = row.scrollLeft;
    row.scrollLeft += delta;
    if (row.scrollLeft !== before) event.preventDefault();
  }, { passive: false });
}

/** Programmatic updates never emit changes or create a custom override. */
export class ThemeColorPicker {
  readonly buttonEl: HTMLButtonElement;
  private value = "#808080";
  private changed: (color: string) => void | Promise<void> = () => {};
  private closed: () => void = () => {};
  constructor(parent: HTMLElement, private plugin: SimplePlugin, private confirmSelection: boolean | "manage" = false) {
    this.buttonEl = parent.createEl("button", { cls: "simple-theme-color-swatch", attr: { type: "button", "aria-label": "选择颜色" } });
    this.buttonEl.addEventListener("click", () => {
      const modal = new ThemeColorModal(this.plugin, this.value, color => {
        this.setValue(color);
        const recent = this.plugin.settings.themeRecentColors || [];
        this.plugin.settings.themeRecentColors = [color, ...recent.filter(value => value !== color)].slice(0, 12);
        void Promise.resolve(this.changed(color)).catch(error => new Notice(String(error)));
      }, this.confirmSelection, () => this.closed());
      modal.open();
    });
  }
  setValue(value: string): this {
    let color = parseColorValue("HEX", value);
    if (!color) {
      const sample = this.buttonEl.ownerDocument.body.createSpan();
      sample.style.color = value; sample.hidden = true;
      const channels = sample.style.color ? sample.ownerDocument.defaultView!.getComputedStyle(sample).color.match(/[\d.]+/g)?.slice(0, 3) : undefined;
      sample.remove();
      color = channels ? parseColorValue("RGB", channels.join(",")) : null;
    }
    this.value = color || "#808080";
    this.buttonEl.style.setProperty("--simple-color-swatch", this.value);
    this.buttonEl.title = this.value.toUpperCase();
    return this;
  }
  onChange(callback: (color: string) => void | Promise<void>): this { this.changed = callback; return this; }
  onClose(callback: () => void): this { this.closed = callback; return this; }
}

class ThemeColorModal extends Modal {
  private hue = 0;
  private saturation = 0;
  private brightness = 0;
  private refresh: () => void = () => {};
  constructor(private plugin: SimplePlugin, private value: string, private changed: (color: string) => void, private confirmSelection: boolean | "manage" = false, private closed: () => void = () => {}) {
    super(plugin.app);
    this.readColor();
  }
  private readColor(): void {
    const rgb = colorRgb(this.value).map(n => n / 255), max = Math.max(...rgb), min = Math.min(...rgb);
    // Keep hue precision so RGB/HEX edits retain their exact color.
    const delta = max - min, [r, g, b] = rgb;
    this.hue = !delta ? this.hue : 60 * (max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4);
    this.brightness = max; this.saturation = max ? (max - min) / max : 0;
  }
  onOpen(): void {
    this.titleEl.setText("选择颜色");
    this.modalEl.addClass("simple-theme-color-modal");
    const square = this.contentEl.createDiv({ cls: "simple-theme-color-plane", attr: { "aria-hidden": "true" } });
    const dot = square.createSpan({ cls: "simple-theme-color-dot" });
    const hue = this.contentEl.createEl("input", { cls: "simple-theme-color-hue", type: "range", attr: { min: "0", max: "359", step: "1", "aria-label": "色相" } });
    const tools = this.contentEl.createDiv({ cls: "simple-theme-color-tools" });
    const preview = tools.createEl("button", { cls: "simple-theme-color-preview", attr: { type: "button", "aria-label": "收藏当前颜色", "aria-pressed": "false" } });
    setIcon(preview, "heart");
    let refreshRecent = (): void => {};
    const emit = (value: string): void => { if (!this.confirmSelection) this.changed(value); };
    const commit = (): void => { emit(this.value); refreshRecent(); };
    const pick = (value: string, commit = true): void => {
      this.value = value; this.readColor(); this.refresh();
      if (commit) { emit(value); refreshRecent(); }
    };
    const updateSquare = (event: PointerEvent): void => {
      const rect = square.getBoundingClientRect();
      this.saturation = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      this.brightness = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
      this.value = hsvHex(this.hue, this.saturation, this.brightness); this.refresh();
    };
    let pointer: number | undefined, original = this.value;
    square.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); original = this.value; pointer = event.pointerId;
      square.setPointerCapture(event.pointerId); updateSquare(event);
    });
    square.addEventListener("pointermove", event => { if (event.pointerId === pointer) updateSquare(event); });
    square.addEventListener("pointerup", event => {
      if (event.pointerId !== pointer) return;
      updateSquare(event); pointer = undefined; commit();
    });
    square.addEventListener("pointercancel", () => { pointer = undefined; pick(original, false); });
    hue.addEventListener("input", () => {
      this.hue = Number(hue.value); this.value = hsvHex(this.hue, this.saturation, this.brightness); this.refresh();
    });
    hue.addEventListener("change", commit);
    const initial = this.value;
    const tabs = tools.createDiv({ cls: "simple-theme-color-tabs", attr: { role: "tablist", "aria-label": "颜色分类" } });
    tools.prepend(tabs);
    const swatches = this.contentEl.createDiv({ cls: "simple-theme-color-options" });
    let active = "收藏";
    const themeColors = readThemePalette(this.contentEl, this.plugin);
    const tabButtons: HTMLButtonElement[] = [];
    const renderPalette = (): void => {
      swatches.replaceChildren();
      const colors = active === "最近" ? this.plugin.settings.themeRecentColors || [] : active === "收藏" ? this.plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS : themeColors;
      for (const color of [...new Set([initial, ...colors])].filter(color => /^#[0-9a-f]{6}$/i.test(color))) {
        const control = swatches.createEl("button", { cls: "simple-theme-color-swatch", attr: { type: "button", title: color.toUpperCase(), "aria-pressed": String(color === this.value) } });
        control.style.setProperty("--simple-color-swatch", color);
        control.addEventListener("click", () => pick(color));
      }
      tabButtons.forEach(button => button.setAttribute("aria-selected", String(button.textContent === active)));
      restore.hidden = active !== "收藏";
      const favorites = this.plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS;
      restore.disabled = favorites.length === FAVORITE_COLORS.length && FAVORITE_COLORS.every(color => favorites.includes(color));
      swatches.append(restore);
    };
    for (const name of ["收藏", "最近", "主题"]) {
      const button = tabs.createEl("button", { text: name, attr: { type: "button", role: "tab" } });
      tabButtons.push(button);
      button.addEventListener("click", () => { active = name; renderPalette(); });
    }
    refreshRecent = renderPalette;
    const restore = this.contentEl.createEl("button", { cls: "simple-theme-color-restore", attr: { type: "button", title: "恢复预设" } });
    setIcon(restore, "rotate-ccw");
    restore.addEventListener("click", () => {
      const colors = this.plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS;
      this.plugin.settings.themeFavoriteColors = [...new Set([...colors, ...FAVORITE_COLORS])];
      this.refresh();
      void this.plugin.saveSettings().catch(error => new Notice(String(error)));
    });
    preview.addEventListener("click", () => {
      const colors = this.plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS;
      this.plugin.settings.themeFavoriteColors = colors.includes(this.value) ? colors.filter(color => color !== this.value) : [...colors, this.value];
      this.refresh();
      void this.plugin.saveSettings().catch(error => new Notice(String(error)));
    });
    const formats = tools.createDiv({ cls: "simple-theme-color-inline" });
    const displays: (() => void)[] = [];
    const space = "HEX";
    const row = formats.createDiv({ cls: "simple-theme-color-value-row" });
    row.createSpan({ text: "HEX" });
    const button = row.createEl("button", { cls: "simple-theme-color-value", attr: { type: "button", "aria-label": "编辑颜色数值" } });
    const text = (): string => this.value.toUpperCase();
    displays.push(() => button.setText(text()));
      button.addEventListener("click", () => {
        if (row.querySelector("input")) return;
        button.hidden = true;
        const input = row.createEl("input", { type: "text", value: text(), attr: { "aria-label": `${space} 数值`, spellcheck: "false" } });
        const finish = (commit: boolean): void => {
          if (!input.isConnected) return;
          if (commit) {
            const color = parseColorValue(space, input.value);
            if (!color) { input.setAttribute("aria-invalid", "true"); new Notice("请输入 HEX 颜色，例如 #824ce6。"); input.focus(); return; }
            pick(color);
          }
          input.remove(); button.hidden = false; button.focus();
        };
        input.addEventListener("keydown", event => {
          if (event.key === "Enter") { event.preventDefault(); finish(true); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true)); input.focus(); input.select();
      });
    this.refresh = () => {
      square.style.setProperty("--simple-color-hue", `hsl(${this.hue} 100% 50%)`);
      dot.style.left = `${this.saturation * 100}%`; dot.style.top = `${(1 - this.brightness) * 100}%`;
      hue.value = String(Math.round(this.hue)); displays.forEach(update => update()); renderPalette();
      preview.style.setProperty("--simple-color-swatch", this.value);
      const favorite = (this.plugin.settings.themeFavoriteColors ?? FAVORITE_COLORS).includes(this.value);
      preview.setAttribute("aria-pressed", String(favorite));
      preview.removeAttribute("aria-label");
      preview.title = favorite ? "点击取消收藏" : "点击收藏";
    };
    this.refresh();
    // Native titles provide one tooltip; Obsidian also renders aria-label tooltips.
    this.contentEl.querySelectorAll<HTMLElement>("[aria-label]").forEach(element => {
      if (!element.title) element.title = element.getAttribute("aria-label")!;
      element.removeAttribute("aria-label");
    });
    if (this.confirmSelection) {
      const apply = this.contentEl.createEl("button", { text: this.confirmSelection === "manage" ? "添加" : "应用到选中文字", cls: "mod-cta simple-theme-color-confirm", attr: { type: "button" } });
      apply.addEventListener("click", () => { this.changed(this.value); this.close(); });
    }
  }
  onClose(): void { this.closed(); }
}
