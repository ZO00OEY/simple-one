import type { SimplePluginSettings } from "../types";

export type SwitchStates = SimplePluginSettings["mobileSwitches"];

const SHARED_DISPLAY_FEATURES = new Set([
  "enableNotionColumns",
  "enableImageZoom",
  "enableMermaidEnhancer",
  "enableColorPreview",
  "enableHtmlPreview",
  "enableReadableCustomTags",
  "htmlPreviewRules",
]);

export function isSharedSwitchPath(path: string): boolean {
  return SHARED_DISPLAY_FEATURES.has(path.split("/")[1])
    || path === "/enhancements/quickFormat/showDesktopEntry"
    || path === "/enhancements/quickFormat/showMobileEntry";
}

// Rule IDs keep switch states attached to the same rule after sorting or deletion.
function visitSwitches(
  value: unknown,
  visit: (parent: Record<string, unknown>, key: string, path: string) => void,
  path = ""
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
      const segment = typeof id === "string" ? `id:${id}` : `index:${index}`;
      visitSwitches(item, visit, `${path}/${encodeURIComponent(segment)}`);
    });
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "mobileSwitches" || key === "mobileDisplay" || key === "leapMonth") continue;
    const childPath = `${path}/${encodeURIComponent(key)}`;
    if (isSharedSwitchPath(childPath)) continue;
    if (typeof child === "boolean" || childPath === "/enhancements/quickFormat/visibleModes") {
      visit(record, key, childPath);
    } else {
      visitSwitches(child, visit, childPath);
    }
  }
}

export function collectSwitchStates(settings: SimplePluginSettings): SwitchStates {
  const states: SwitchStates = {};
  visitSwitches(settings, (parent, key, path) => {
    const value = parent[key];
    states[path] = Array.isArray(value) ? [...value] as string[] : value as boolean;
  });
  return states;
}

export function applySwitchStates(settings: SimplePluginSettings, states: SwitchStates): void {
  visitSwitches(settings, (parent, key, path) => {
    const value = states[path];
    if (typeof parent[key] === "boolean" && typeof value === "boolean") parent[key] = value;
    else if (Array.isArray(parent[key]) && Array.isArray(value) && value.every((item) => typeof item === "string")) {
      parent[key] = [...value];
    }
  });
}

export function mobileSettingsForSave(settings: SimplePluginSettings, desktopStates: SwitchStates): SimplePluginSettings {
  const saved = JSON.parse(JSON.stringify(settings)) as SimplePluginSettings;
  saved.mobileSwitches = collectSwitchStates(settings);
  applySwitchStates(saved, desktopStates);
  return saved;
}
