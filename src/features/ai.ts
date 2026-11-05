import { Component, requireApiVersion } from "obsidian";
import type SimplePlugin from "../main";
import SimpleAIPlugin from "../../modules/ai/src/main";
import { ApiSettingsTab } from "../../modules/ai/src/api/settings";
import { CHAT_VIEW } from "../../modules/ai/src/agent/view";
import type { ApiSource } from "../../modules/ai/src/api/types";

/** Optional AI runtime; it owns its events, commands, private files and background work. */
export default class AiFeature extends Component {
  core?: SimpleAIPlugin;
  private settingsTab?: ApiSettingsTab;
  private changing = false;
  constructor(private host: SimplePlugin) { super(); }

  async initialize(): Promise<void> { if (this.host.settings.enableAI) await this.start(); }
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.changing) return;
    this.changing = true;
    const previous = this.host.settings.enableAI;
    try {
      if (enabled) await this.start(); else this.stop();
      this.host.settings.enableAI = enabled;
      await this.host.saveSettings();
    } catch (error) {
      this.host.settings.enableAI = previous;
      if (!previous) this.stop();
      else if (!this.core) await this.start();
      throw error;
    } finally { this.changing = false; }
  }
  private async start(): Promise<void> {
    if (this.core) return;
    if (!requireApiVersion("1.11.4")) throw new Error("AI 功能需要 Obsidian 1.11.4 或更高版本。");
    try {
      const root = `${this.host.manifest.dir}/private/ai`;
      const adapter = this.host.app.vault.adapter;
      if (!await adapter.exists(`${this.host.manifest.dir}/private`)) await adapter.mkdir(`${this.host.manifest.dir}/private`);
      if (!await adapter.exists(root)) await adapter.mkdir(root);
      const core = this.addChild(new SimpleAIPlugin(this.host.app, { ...this.host.manifest, id: "simple-one-ai", name: "Simple One AI", dir: root }));
      this.core = core;
      core.loadData = async () => ({ sources: this.host.settings.aiSources });
      core.saveData = async (data: { sources: ApiSource[] }) => {
        const previous = this.host.settings.aiSources;
        this.host.settings.aiSources = data.sources;
        try { await this.host.saveSettings(); }
        catch (error) { this.host.settings.aiSources = previous; throw error; }
      };
      core.openSettings = () => {
        this.host.settings.lastSettingsTab = "ai";
        const settings = (this.host.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
        settings.open(); settings.openTabById(this.host.manifest.id);
      };
      await core.start();
      if (this.core !== core) return;
      this.settingsTab = new ApiSettingsTab(core);
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  renderInto(container: HTMLElement): void {
    this.hideSettings();
    if (!this.settingsTab) { container.createEl("p", { text: "AI 尚未启动，请在拓展中重新启用。" }); return; }
    this.settingsTab.renderInto(container);
  }
  hideSettings(): void { this.settingsTab?.hide(); }
  stop(detachViews = true): void {
    this.hideSettings(); this.settingsTab = undefined;
    if (detachViews) for (const leaf of this.host.app.workspace.getLeavesOfType(CHAT_VIEW)) leaf.detach();
    if (this.core) { const core = this.core; this.core = undefined; this.removeChild(core); }
  }
  onunload(): void { this.stop(false); }
}
