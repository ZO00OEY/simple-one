import { Notice } from "obsidian";

/** Edit only the label, keeping tree rows and the toolbar in place. */
export function editShareName(label: HTMLElement, name: string, save: (name: string) => Promise<unknown>, cancel?: () => void): HTMLInputElement {
  const original = label.textContent ?? "";
  label.empty(); label.classList.add("is-renaming");
  const input = label.createEl("input", { cls: "simple-share-inline-name", attr: { type: "text", "aria-label": "名称" } });
  input.value = name;
  let finished = false, saving = false;
  let failedValue: string | undefined;
  const commit = async (retry = false) => {
    if (finished || saving || !retry && failedValue === input.value) return;
    const value = input.value.trim();
    if (!value || /[\\/\r\n]/.test(value)) { failedValue = input.value; new Notice("请输入不含目录分隔符或换行的名称。"); return; }
    saving = true; input.disabled = true;
    try {
      await save(value); finished = true;
      if (input.isConnected) { label.classList.remove("is-renaming"); label.setText(value); }
    } catch (error) {
      failedValue = input.value; new Notice(String(error)); input.disabled = false;
      if (input.isConnected) { input.focus(); input.select(); }
    } finally { saving = false; }
  };
  input.addEventListener("pointerdown", event => event.stopPropagation());
  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("dblclick", event => event.stopPropagation());
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void commit(true); }
    if (event.key === "Escape" && !saving) {
      event.preventDefault(); finished = true; label.classList.remove("is-renaming"); label.setText(original); cancel?.();
    }
  });
  input.addEventListener("blur", () => { void commit(); });
  input.focus(); input.select();
  return input;
}
