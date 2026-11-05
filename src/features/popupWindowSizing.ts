import type SimplePlugin from "../main";
import { applyModalScale, calculatePopupBounds, getMainAppWindow } from "../shared/popupSizing";

type SettingsPopoutOptions = { width?: number; height?: number; [key: string]: unknown };
type SettingsModal = {
  modalEl: HTMLElement;
  getPopoutWindow?: () => (Window & { electronWindow?: { isDestroyed(): boolean; isMaximized(): boolean; isFullScreen(): boolean; setSize(width: number, height: number): void } }) | null;
  getPopoutOptions?: () => SettingsPopoutOptions;
  onOpen: () => void;
  onClose?: () => void;
};

export function registerPopupWindowSizing(plugin: SimplePlugin): () => void {
  const settingsModal = (plugin.app as unknown as { setting?: SettingsModal }).setting;
  if (!settingsModal?.modalEl || typeof settingsModal.onOpen !== "function") return () => {};

  let sessionOpen = settingsModal.modalEl.isConnected, generation = 0, disposed = false;
  let initialized = new WeakSet<Document>();
  const timers: number[] = [];
  // Loading the plugin must not disturb a window the user already positioned.
  if (sessionOpen) initialized.add(settingsModal.modalEl.ownerDocument);
  const clearModalScale = (): void => {
    settingsModal.modalEl.removeClass("simple-scaled-modal");
    settingsModal.modalEl.style.removeProperty("--simple-popup-width");
    settingsModal.modalEl.style.removeProperty("--simple-popup-height");
  };
  const endSession = (): void => {
    sessionOpen = false; generation++;
    for (const timer of timers) window.clearTimeout(timer);
    timers.length = 0;
  };
  const applyOnce = (nativeReady = false): void => {
    const modal = settingsModal.modalEl, doc = modal.ownerDocument;
    if (disposed || !sessionOpen || !modal.isConnected || initialized.has(doc)) return;
    const owner = doc.defaultView, main = getMainAppWindow(plugin.app);
    if (!owner || owner.closed || !main) return;
    if (owner !== main && !nativeReady) return;
    initialized.add(doc);
    if (owner === main) { applyModalScale(modal, plugin.displaySettings.popupWindowScale, main); return; }
    clearModalScale();
    if (plugin.isMobile) return;
    const bounds = calculatePopupBounds(main, plugin.displaySettings.popupWindowScale);
    if (bounds) {
      // Obsidian can restore saved bounds after reading creation options. Verify the final size once.
      const native = settingsModal.getPopoutWindow?.()?.electronWindow;
      if (native && (native.isDestroyed() || native.isMaximized() || native.isFullScreen())) return;
      try {
        if (owner.outerWidth !== bounds.width || owner.outerHeight !== bounds.height) {
          if (native) native.setSize(bounds.width, bounds.height);
          else owner.resizeTo(bounds.width, bounds.height);
        }
      }
      catch (error) { console.warn("Simple One: failed to resize the settings window", error); }
    }
  };

  const originalGetPopoutOptions = settingsModal.getPopoutOptions;
  const wrappedGetPopoutOptions = function (this: SettingsModal): SettingsPopoutOptions {
    const options = originalGetPopoutOptions?.call(this) ?? {};
    if (sessionOpen && this.modalEl.isConnected) return options;
    const main = getMainAppWindow(plugin.app);
    const bounds = main ? calculatePopupBounds(main, plugin.displaySettings.popupWindowScale) : null;
    return bounds ? { ...options, width: bounds.width, height: bounds.height } : options;
  };
  if (!plugin.isMobile && originalGetPopoutOptions) settingsModal.getPopoutOptions = wrappedGetPopoutOptions;

  const originalOnOpen = settingsModal.onOpen;
  const wrappedOnOpen = function (this: SettingsModal): void {
    const alreadyOpen = sessionOpen && this.modalEl.isConnected && !this.modalEl.ownerDocument.defaultView?.closed;
    if (!alreadyOpen) { sessionOpen = true; generation++; initialized = new WeakSet<Document>(); }
    originalOnOpen.call(this);
    applyOnce();
    if (alreadyOpen) return;
    const opening = generation;
    // Obsidian may migrate an in-app modal into a popout after onOpen; each document is sized once.
    for (const delay of [0, 100]) timers.push(window.setTimeout(() => {
      if (opening === generation) applyOnce(delay === 100);
    }, delay));
  };
  const originalOnClose = settingsModal.onClose;
  const wrappedOnClose = function (this: SettingsModal): void { endSession(); originalOnClose?.call(this); };
  settingsModal.onOpen = wrappedOnOpen;
  if (originalOnClose) settingsModal.onClose = wrappedOnClose;
  plugin.register(() => {
    disposed = true; endSession();
    if (settingsModal.getPopoutOptions === wrappedGetPopoutOptions) settingsModal.getPopoutOptions = originalGetPopoutOptions;
    if (settingsModal.onOpen === wrappedOnOpen) settingsModal.onOpen = originalOnOpen;
    if (settingsModal.onClose === wrappedOnClose) settingsModal.onClose = originalOnClose;
    clearModalScale();
  });
  return applyOnce;
}
