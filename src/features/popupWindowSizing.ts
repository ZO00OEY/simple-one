import type SimplePlugin from "../main";
import {
  applyModalScale,
  calculatePopupBounds,
  getMainAppWindow,
} from "../shared/popupSizing";

type SettingsPopoutOptions = {
  width?: number;
  height?: number;
  [key: string]: unknown;
};

type SettingsModal = {
  modalEl: HTMLElement;
  getPopoutOptions: () => SettingsPopoutOptions;
  onOpen: () => void;
};

export function registerPopupWindowSizing(plugin: SimplePlugin): () => void {
  const app = plugin.app as unknown as { setting?: SettingsModal };
  const settingsModal = app.setting;
  if (!settingsModal) return () => {};

  const clearModalScale = (modalEl: HTMLElement): void => {
    modalEl.removeClass("simple-scaled-modal");
    modalEl.style.removeProperty("--simple-popup-width");
    modalEl.style.removeProperty("--simple-popup-height");
  };

  const applyNativeWindowScale = (settingsWindow: Window, mainWindow: Window): void => {
    const bounds = calculatePopupBounds(mainWindow, plugin.settings.popupWindowScale);
    if (!bounds || settingsWindow.closed) return;

    try {
      settingsWindow.resizeTo(bounds.width, bounds.height);
      settingsWindow.moveTo(bounds.left, bounds.top);
    } catch (error) {
      console.warn("Simple One: failed to resize the settings window", error);
    }
  };

  const syncOpenSettingsWindow = (resizeNativeWindow: boolean): void => {
    const modalEl = settingsModal.modalEl;
    if (!modalEl.isConnected) return;

    const settingsWindow = modalEl.ownerDocument.defaultView;
    const mainWindow = getMainAppWindow(plugin.app);
    if (!settingsWindow || !mainWindow) return;

    if (settingsWindow === mainWindow) {
      applyModalScale(modalEl, plugin.settings.popupWindowScale, mainWindow);
      return;
    }

    clearModalScale(modalEl);
    if (resizeNativeWindow) applyNativeWindowScale(settingsWindow, mainWindow);
  };

  // Every settings entry point uses this singleton. Supplying the dimensions
  // before the popout is created avoids focus races and resize flicker.
  const originalGetPopoutOptions = settingsModal.getPopoutOptions;
  const wrappedGetPopoutOptions = function (this: SettingsModal): SettingsPopoutOptions {
    const options = originalGetPopoutOptions.call(this);
    const mainWindow = getMainAppWindow(plugin.app);
    const bounds = mainWindow
      ? calculatePopupBounds(mainWindow, plugin.settings.popupWindowScale)
      : null;
    return bounds ? { ...options, width: bounds.width, height: bounds.height } : options;
  };
  settingsModal.getPopoutOptions = wrappedGetPopoutOptions;

  // Desktop popouts are already born at the requested size. This hook only
  // applies the same policy when Obsidian renders settings as an in-app modal.
  const originalOnOpen = settingsModal.onOpen;
  const wrappedOnOpen = function (this: SettingsModal): void {
    originalOnOpen.call(this);
    // Recent Obsidian versions may create or migrate the settings popout after
    // onOpen returns, so apply the native window size both now and after that
    // migration has completed.
    syncOpenSettingsWindow(true);
    window.setTimeout(() => syncOpenSettingsWindow(true), 0);
    window.setTimeout(() => syncOpenSettingsWindow(true), 100);
  };
  settingsModal.onOpen = wrappedOnOpen;

  // Also correct a settings window that was already open when the plugin loads.
  syncOpenSettingsWindow(true);

  plugin.register(() => {
    if (settingsModal.getPopoutOptions === wrappedGetPopoutOptions) {
      settingsModal.getPopoutOptions = originalGetPopoutOptions;
    }
    if (settingsModal.onOpen === wrappedOnOpen) settingsModal.onOpen = originalOnOpen;
    clearModalScale(settingsModal.modalEl);
  });

  return () => syncOpenSettingsWindow(true);
}
