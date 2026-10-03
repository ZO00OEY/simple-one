import { App, Modal, Setting } from "obsidian";

export function confirmAction(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    class ConfirmModal extends Modal {
      private accepted = false;

      onOpen(): void {
        this.titleEl.setText("确认操作");
        this.contentEl.createEl("p", { text: message });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
          .addButton((button) => button.setButtonText("确认").setCta().onClick(() => {
            this.accepted = true;
            this.close();
          }));
      }

      onClose(): void {
        this.contentEl.empty();
        resolve(this.accepted);
      }
    }
    new ConfirmModal(app).open();
  });
}
