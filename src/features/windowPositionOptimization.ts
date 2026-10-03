import type SimplePlugin from "../main";

type Bounds = { x: number; y: number; width: number; height: number };
type NativeWindow = {
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
};
type PopoutModal = {
  open: (this: PopoutModal) => void;
  getPopoutWindow(): (Window & { electronWindow?: NativeWindow }) | null;
};
type DesktopWindow = Window & {
  electron?: { remote?: { screen?: { getDisplayMatching(bounds: Bounds): { workArea: Bounds } } } };
};

export function constrainWindowBounds(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  };
}

export function registerWindowPositionOptimization(plugin: SimplePlugin): void {
  if (plugin.isMobile) return;
  const settings = (plugin.app as unknown as { setting?: PopoutModal }).setting;
  if (!settings) return;
  // Obsidian's shared popout modal creates settings, plugin and theme windows.
  // Use a guarded hook because this desktop-only API is not publicly typed.
  let prototype = Object.getPrototypeOf(settings) as PopoutModal | null;
  while (prototype && !Object.prototype.hasOwnProperty.call(prototype, "getPopoutWindow")) {
    prototype = Object.getPrototypeOf(prototype) as PopoutModal | null;
  }
  if (!prototype || typeof prototype.open !== "function") return;
  const screen = (window as DesktopWindow).electron?.remote?.screen;
  if (!screen) return;
  const originalOpen = prototype.open;
  const wrappedOpen = function (this: PopoutModal): void {
    originalOpen.call(this);
    if (!plugin.settings.enableWindowPositionOptimization) return;
    const nativeWindow = this.getPopoutWindow()?.electronWindow;
    if (!nativeWindow || nativeWindow.isDestroyed() || nativeWindow.isMaximized() || nativeWindow.isFullScreen()) return;
    try {
      const bounds = nativeWindow.getBounds();
      const corrected = constrainWindowBounds(bounds, screen.getDisplayMatching(bounds).workArea);
      if (bounds.x !== corrected.x || bounds.y !== corrected.y || bounds.width !== corrected.width || bounds.height !== corrected.height) {
        nativeWindow.setBounds(corrected);
      }
    } catch (error) {
      console.warn("Simple One: failed to keep the popout window on screen", error);
    }
  };
  prototype.open = wrappedOpen;
  const hookedPrototype = prototype;
  plugin.register(() => {
    if (hookedPrototype.open === wrappedOpen) hookedPrototype.open = originalOpen;
  });
}
