import { App, Platform, type Hotkey, type Modifier } from "obsidian";

const COMMAND_ID = "simple-plugin:create-two-column-view";
export const DEFAULT_COLUMNS_HOTKEY: Hotkey = { modifiers: ["Alt"], key: "C" };

type HotkeyManager = {
  getHotkeys?: (id: string) => Hotkey[] | undefined;
  getDefaultHotkeys?: (id: string) => Hotkey[] | undefined;
  setHotkeys?: (id: string, hotkeys: Hotkey[]) => void;
  removeHotkeys?: (id: string) => void;
  save?: () => Promise<void>;
};
type CommandRegistry = { commands?: Record<string, { name: string; hotkeys?: Hotkey[] }> };

function manager(app: App): HotkeyManager | undefined {
  return (app as App & { hotkeyManager?: HotkeyManager }).hotkeyManager;
}

function signature(hotkey: Hotkey): string {
  const modifiers = hotkey.modifiers.map((modifier) => modifier === "Mod" ? (Platform.isMacOS ? "Meta" : "Ctrl") : modifier);
  return `${Array.from(new Set(modifiers)).sort().join("+")}+${hotkey.key.toUpperCase()}`;
}

export function parseCommandHotkey(value: string): Hotkey | null {
  const tokens = value.split("+").map((token) => token.trim()).filter(Boolean);
  if (tokens.length < 2) return null;
  const key = tokens.pop()!;
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|space|enter|tab|arrow(?:up|down|left|right))$/i.test(key)) return null;
  const aliases: Record<string, Modifier> = {
    alt: "Alt", option: "Alt", shift: "Shift", ctrl: "Ctrl", control: "Ctrl",
    mod: "Mod", cmd: "Meta", command: "Meta", meta: "Meta",
  };
  const modifiers = tokens.map((token) => aliases[token.toLowerCase()]);
  if (modifiers.some((modifier) => !modifier) || new Set(modifiers).size !== modifiers.length) return null;
  const normalizedKey = /^arrow/i.test(key) ? `Arrow${key.slice(5, 6).toUpperCase()}${key.slice(6).toLowerCase()}`
    : key.length === 1 || /^f\d+$/i.test(key) ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
  return { modifiers: modifiers as Modifier[], key: normalizedKey };
}

export function commandHotkeyLabel(hotkey: Hotkey): string {
  return [...hotkey.modifiers, hotkey.key].join(" + ");
}

export function currentColumnsHotkey(app: App): Hotkey {
  return effectiveHotkeys(app, COMMAND_ID)[0] ?? DEFAULT_COLUMNS_HOTKEY;
}

function effectiveHotkeys(app: App, id: string): Hotkey[] {
  const hotkeys = manager(app);
  const command = (app as App & { commands?: CommandRegistry }).commands?.commands?.[id];
  return hotkeys?.getHotkeys?.(id) ?? hotkeys?.getDefaultHotkeys?.(id) ?? command?.hotkeys ?? [];
}

export function columnsHotkeyConflicts(app: App, hotkey: Hotkey): string[] | null {
  const hotkeys = manager(app);
  const commands = (app as App & { commands?: CommandRegistry }).commands?.commands;
  if (!hotkeys?.getHotkeys || !commands) return null;
  const wanted = signature(hotkey);
  return Object.entries(commands)
    .filter(([id]) => id !== COMMAND_ID && effectiveHotkeys(app, id).some((item) => signature(item) === wanted))
    .map(([, command]) => command.name);
}

export async function saveColumnsHotkey(app: App, hotkey: Hotkey): Promise<boolean> {
  const hotkeys = manager(app);
  if (!hotkeys?.getHotkeys || !hotkeys.setHotkeys || !hotkeys.save) return false;
  const current = effectiveHotkeys(app, COMMAND_ID);
  if (current.length === 1 && signature(current[0]) === signature(hotkey)) return true;
  const previous = hotkeys.getHotkeys(COMMAND_ID);
  hotkeys.setHotkeys(COMMAND_ID, [hotkey]);
  try {
    await hotkeys.save();
    return true;
  } catch (error) {
    if (previous) hotkeys.setHotkeys(COMMAND_ID, previous);
    else hotkeys.removeHotkeys?.(COMMAND_ID);
    throw error;
  }
}
