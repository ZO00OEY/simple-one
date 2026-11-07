import { Component, requireApiVersion } from "obsidian";
import type SimplePlugin from "../main";
import SimpleAIPlugin from "../../modules/ai/src/main";
import { ApiSettingsTab, type AiSettingsPage } from "../../modules/ai/src/api/settings";
import { CHAT_VIEW } from "../../modules/ai/src/agent/view";
import { translationModels, type ApiSource } from "../../modules/ai/src/api/types";

/** Optional AI runtime; it owns its events, commands, private files and background work. */
export default class AiFeature extends Component {
  core?: SimpleAIPlugin;
  private settingsTab?: ApiSettingsTab;
  private changing = false;
  private service?: SimpleAIPlugin;
  private serviceReady?: Promise<SimpleAIPlugin>;
  private alive = true;
  private translations = new Set<AbortController>();
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
  getTranslationModels() { return translationModels(this.host.settings.aiSources); }
  async translateSelection(input: Parameters<SimpleAIPlugin["translateSelection"]>[0], signal?: AbortSignal, update?: (text: string) => void): Promise<string> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    this.translations.add(controller);
    try {
      if (!this.alive || controller.signal.aborted) throw new DOMException("翻译已取消", "AbortError");
      const core = await this.prepareService();
      if (!this.alive || controller.signal.aborted) throw new DOMException("翻译已取消", "AbortError");
      core.settings.sources = this.host.settings.aiSources;
      return await core.translateSelection(input, controller.signal, update);
    } finally { signal?.removeEventListener("abort", cancel); this.translations.delete(controller); }
  }
  private prepareService(): Promise<SimpleAIPlugin> {
    return this.serviceReady ??= (async () => {
      if (!requireApiVersion("1.11.4")) throw new Error("AI 功能需要 Obsidian 1.11.4 或更高版本。");
      const root = `${this.host.manifest.dir}/private/ai`;
      const adapter = this.host.app.vault.adapter;
      if (!await adapter.exists(`${this.host.manifest.dir}/private`)) await adapter.mkdir(`${this.host.manifest.dir}/private`);
      if (!await adapter.exists(root)) await adapter.mkdir(root);
      if (!this.alive) throw new DOMException("AI 已卸载", "AbortError");
      const core = this.addChild(new SimpleAIPlugin(this.host.app, { ...this.host.manifest, id: "simple-one-ai", name: "Simple One AI", dir: root }));
      this.service = core;
      core.loadData = async () => ({ sources: this.host.settings.aiSources });
      core.saveData = async (data: { sources: ApiSource[] }) => {
        const previous = this.host.settings.aiSources;
        this.host.settings.aiSources = data.sources;
        try { await this.host.saveSettings(); }
        catch (error) { this.host.settings.aiSources = previous; throw error; }
      };
      core.openSettings = () => {
        this.host.settings.lastSettingsTab = "ai";
        this.host.openAISettings();
      };
      await core.prepareRequests();
      if (!this.alive) throw new DOMException("AI 已卸载", "AbortError");
      return core;
    })().catch(error => {
      if (this.service) { this.removeChild(this.service); this.service = undefined; }
      this.serviceReady = undefined; throw error;
    });
  }
  private async start(): Promise<void> {
    if (this.core) return;
    try {
      const core = await this.prepareService();
      if (!this.alive) return;
      this.core = core;
      await core.start();
      if (this.core !== core) return;
      this.settingsTab = new ApiSettingsTab(core);
    } catch (error) { this.stop(); throw error; }
  }
  renderInto(container: HTMLElement, page?: AiSettingsPage): void {
    this.hideSettings();
    if (!this.settingsTab) { container.createEl("p", { text: "AI 尚未启动，请在拓展中重新启用。" }); return; }
    this.settingsTab.renderInto(container, page);
  }
  hideSettings(): void { this.settingsTab?.hide(); }
  stop(detachViews = true): void {
    this.hideSettings(); this.settingsTab = undefined;
    if (detachViews) for (const leaf of this.host.app.workspace.getLeavesOfType(CHAT_VIEW)) leaf.detach();
    this.service?.stopUI(); this.core = undefined;
  }
  onunload(): void {
    this.alive = false;
    for (const controller of this.translations) controller.abort();
    this.stop(false);
    if (this.service) { this.removeChild(this.service); this.service = undefined; }
    this.serviceReady = undefined;
  }
}
