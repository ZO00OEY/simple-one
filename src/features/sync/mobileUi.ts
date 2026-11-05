import { isReviewImage } from "./reviewImage";
import { legacyScopeRules, organizedLocalIgnore, readRootIgnore, writeRootIgnore } from "./localIgnore";
import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { settingsSection, compactSettingsSection } from "../../shared/settingsLayout";
import { styleActionFooter, styleSettingIconAction, styleActionButton } from "../../shared/actionButton";
import { MobileOptions, sameContent } from "./linkDiff";
import { ConflictChoice, MobileConflict, MobileGithub, MobilePlan } from "./mobileGithub";
import { LiveReview, PreviewFile, ZoeySyncConflictPreviewModal } from "./conflictPreview";
import { mirrorPlan, strategyChoices, type SyncStrategy } from "./syncPlan";

export interface MobileSyncFlow {
  strategy(plan: MobilePlan): Promise<SyncStrategy | null>;
  confirm(plan: MobilePlan): Promise<boolean>;
  transfer(): Promise<void>;
  ready?(plan: MobilePlan): Promise<void>;
}

export interface MobileHost {
  active(): boolean;
  app: App;
  options: MobileOptions;
  engine(): MobileGithub;
  save(): Promise<void>;
  restart(): void;
  sync(): Promise<void>;
  calibrate(): Promise<void>;
  reimport(): Promise<void>;
}

export function mobileConflictFile(c: MobileConflict): PreviewFile {
  const single = c.kind === "unpaired" || c.kind === "delete";
  const duplicate = c.kind === "duplicate";
  const localPaths = c.localFiles?.map(s => s.path) ?? (c.local ? [c.local.path] : undefined);
  const remotePaths = c.remoteFiles?.map(s => s.path) ?? (c.remote ? [c.remote.path] : undefined);
  const differentPaths = !!localPaths && !!remotePaths && JSON.stringify(localPaths) !== JSON.stringify(remotePaths);
  const description = single ? (c.local ? "文件仅存在于本机" : "文件仅存在于云端")
    : duplicate ? "文件内容相同，路径不同"
    : differentPaths ? (sameContent(c.local, c.remote) ? "文件路径不同" : "文件内容及路径不同")
    : "文件内容不同";
  return { path: c.id, label: c.label, description, localPaths, remotePaths,
    localMissingLabel: localPaths?.length ? undefined : c.kind === "delete" ? "本地已删除" : "本地无此文件",
    remoteMissingLabel: remotePaths?.length ? undefined : c.kind === "delete" ? "云端已删除" : "云端无此文件" };
}

export class MobileSyncModal {
  private choices: Record<string, ConflictChoice> = {};
  constructor(private app: App, private engine: MobileGithub, private plan: MobilePlan,
    private review?: (live: LiveReview) => Promise<Record<string, ConflictChoice> | null>,
    private flow?: MobileSyncFlow) {}

  async wait(): Promise<boolean> {
    // Only a first alignment with real differences needs a user-selected policy.
    const firstAlignment = !this.engine.state.baseCommitSha && !this.engine.needsLocalRecheck;
    const hasDifferences = this.plan.conflicts.length || this.plan.uploads.length || this.plan.downloads.length
      || this.plan.localDeletes.length || this.plan.remoteDeletes.length;
    let requiresConfirmation = false;
    if (this.flow && firstAlignment && hasDifferences) {
      const strategy = await this.flow.strategy(this.plan);
      if (!strategy) return false;
      requiresConfirmation = strategy === "local" || strategy === "remote";
      if (strategy === "local" || strategy === "remote") this.plan = mirrorPlan(this.plan, strategy);
      else {
        const next = await this.engine.recalculate(this.plan, strategyChoices(this.plan, strategy));
        this.plan = next;
      }
    }
    if (this.plan.conflicts.length && !await this.reviewDifferences()) return false;
    // Explicit version choices finish review; rebuilding one side retains its deletion summary.
    if (this.flow && requiresConfirmation && !await this.flow.confirm(this.plan)) return false;
    await this.flow?.ready?.(this.plan);
    await this.engine.execute(this.plan);
    if (this.engine.downloadTask) { await this.flow?.transfer(); return false; }
    if (this.engine.requiresPluginReload(this.plan)) new Notice("同步与分享 程序文件已更新，请重新加载插件或重启 Obsidian 使新代码生效。", 12000);
    return true;
  }

  private async reviewDifferences(): Promise<boolean> {
    const conflicts = new Map(this.plan.conflicts.map(c => [c.id, c]));
    const live: LiveReview = {
      files: this.plan.conflicts.map(mobileConflictFile),
      read: async file => {
        const c = conflicts.get(file.path)!;
        const [local, remote] = await Promise.all([
          c.local ? isReviewImage(c.local.path) ? null : this.engine.reviewText(c.local) : "", c.remote ? isReviewImage(c.remote.path) ? null : this.engine.reviewText(c.remote) : ""
        ]);
        return { local, remote };
      },
      readImage: (file, side) => { const c = conflicts.get(file.path)!, entry = side === "local" ? c.local : c.remote; return entry ? this.engine.reviewImage(entry) : Promise.resolve(null); }
    };
    const selected = this.review ? await this.review(live) : await new ZoeySyncConflictPreviewModal(this.app, live).wait();
    if (!selected) return false;
    this.choices = { ...this.plan.pendingChoices, ...selected };
    const next = await this.engine.recalculate(this.plan, this.choices);
    if (next.conflicts.length) throw new Error("仍有未处理的差异，请重新同步并完成选择。");
    this.plan = next; return true;
  }

}

export function mobileCheckbox(root: HTMLElement, name: string, description: string, checked: boolean,
  change: (value: boolean) => Promise<void> | void, leading = false): Setting {
  const setting = new Setting(root).setName(name).setDesc(description);
  const input = setting.controlEl.createEl("input", { cls: "simple-one-sync-mobile-checkbox", attr: { type: "checkbox", "aria-label": name } });
  input.checked = checked;
  setting.settingEl.addClass("simple-one-sync-checkbox-row");
  setting.settingEl.insertBefore(setting.controlEl, setting.infoEl);
  input.id = `simple-one-sync-plugin-${crypto.randomUUID()}`;
  setting.nameEl.empty();
  setting.nameEl.createEl("label", { text: name, attr: { for: input.id } });
  if (leading) {
    setting.settingEl.addClass("simple-one-sync-cloud-plugin-row");
  }
  setting.settingEl.addEventListener("click", event => {
    if (input.disabled || (event.target as Element).closest("input,label,button,a,select,textarea")) return;
    input.click();
  });
  input.addEventListener("change", () => {
    input.disabled = true;
    void Promise.resolve().then(() => change(input.checked)).catch((error) => {
      input.checked = !input.checked;
      new Notice(error instanceof Error ? error.message : String(error));
    }).finally(() => { input.disabled = false; });
  });
  return setting;
}

export function renderMobileSyncRules(root: HTMLElement, options: MobileOptions, save: () => Promise<void> | void,
  _loadPlugins: () => Promise<string[]>, _currentPluginId = "simple-one", host?: MobileHost): void {
  root = root.createDiv({ cls: "simple-one-sync-sync-rules" });
  if (host) {
    new Setting(root).setName("本机自定义规则").setDesc("仅在需要自定义排除时编辑；已有规则会保留。")
      .addButton(button => { styleSettingIconAction(button.buttonEl); button.setIcon("settings").setTooltip("编辑本机 .gitignore").onClick(() => {
        const modal = new Modal(host.app);
        modal.onOpen = () => { void (async () => {
          modal.contentEl.addClass("simple-lightweight-plugin-modal");
          modal.contentEl.createEl("h2", { text: "本机 .gitignore" });
          modal.contentEl.createEl("p", { text: "仅影响本机同步规则。已排除文件不会作为删除；已有下载待办请先完成或重新检查接入。" });
          const original = await readRootIgnore(host.app.vault.adapter);
          const input = modal.contentEl.createEl("textarea", { attr: { "aria-label": "本机 .gitignore", rows: "12" } });
          const legacy = legacyScopeRules(options).map(line => line.split("{config}").join(host.app.vault.configDir));
          input.value = organizedLocalIgnore(original, host.app.vault.configDir, legacy);
          const footer = modal.contentEl.createDiv({ cls: "simple-json-modal-footer" });
          styleActionButton(footer.createEl("button", { text: "取消" }), "text").addEventListener("click", () => modal.close());
          const confirm = styleActionButton(footer.createEl("button", { text: "保存本机规则", cls: "mod-cta" }), "text");
          styleActionFooter(footer);
          confirm.addEventListener("click", () => { void (async () => {
            confirm.disabled = true;
            try {
              const next = organizedLocalIgnore(input.value, host.app.vault.configDir);
              await writeRootIgnore(host.app.vault.adapter, original, next, host.app.vault.configDir);
              modal.close(); new Notice("本机规则已保存；下次同步将重新预览，不会自动删除文件。");
            } catch (error) { new Notice(String(error)); confirm.disabled = false; }
          })(); });
        })().catch(error => new Notice(String(error))); };
        modal.open();
      }); });
  }
  mobileCheckbox(root, "缓存文件校验结果，加快同步", "复用已校验文件的哈希，减少重复计算；关闭后每次重新计算。", options.cacheEnabled, async value => { options.cacheEnabled = value; await save(); });
  mobileCheckbox(root, "追踪文件改名与移动", "识别文件改名和移动，关联移动前后的内容。", options.trackPaths, async value => { options.trackPaths = value; await save(); });
}

export function renderMobileSettings(root: HTMLElement, host: MobileHost, guide = false): HTMLElement | void {
  const options = host.options;
  if (!guide) root.addClass("simple-lightweight-sync-settings");
  const section = (title: string): HTMLElement => guide ? settingsSection(root, title) : compactSettingsSection(root, title);
  if (guide) root.createEl("h3", { text: "配置 GitHub 轻量同步" });
  if (guide && !Platform.isMobile) root.createEl("p", { text: "电脑可启用轻量同步运行相同流程；此模式会实际读写仓库，确认预览后才执行同步。" });
  if (guide) {
    const steps = root.createEl("ol");
    steps.createEl("li", { text: "在手机安装并启用 同步与分享，选择 GitHub API 模式。" });
    steps.createEl("li", { text: "填写仓库 HTTPS 地址及 token。token 需授予目标仓库 contents 读写权限。" });
    steps.createEl("li", { text: "核验账号与仓库权限，准备本机配置即可完成接入。" });
    steps.createEl("li", { text: "绑定后手动同步，检查首次预览和同名冲突。首次缺失文件不会被当成删除。" });
  }
  const persist = async (): Promise<void> => { await host.save(); host.restart(); };
  if (options.mode === "server") { root.createEl("p", { text: "服务器地址和密码在下方原服务器设置中填写。" }); return; }
  const account = section( "账户设置");
  account.addClass("simple-one-sync-lightweight-account");
  const engine = host.engine();
  const quota = new Setting(account).setName("GitHub API 剩余额度");
  const updateQuota = (remaining: number | null): void => {
    if (!guide) quota.setName(remaining === null ? "GitHub API 额度：尚未获取" : `GitHub API 剩余额度：${remaining.toLocaleString()} 次`);
    quota.setDesc(remaining === null
      ? "尚未获取；与 GitHub 交互后自动更新。"
      : `剩余 ${remaining.toLocaleString()} 次请求（最近一次 GitHub 响应）。`);
  };
  updateQuota(engine.remaining);
  const unsubscribe = engine.onRemainingChange(updateQuota);
  const quotaObserver = new MutationObserver(() => {
    if (!quota.settingEl.isConnected) { unsubscribe(); quotaObserver.disconnect(); }
  });
  quotaObserver.observe(root.ownerDocument.body, { childList: true, subtree: true });
  new Setting(account).setName("GitHub token").setDesc("Obsidian 1.11.4+ 保存到本机密钥存储；旧版保存在本机 JSON。不会写入共享配置。")
    .addText((text) => { text.inputEl.type = "password"; text.setValue(options.token).onChange(async (value) => { options.token = value.trim(); engine.resetRemaining(); await host.save(); }); }).settingEl.addClass("simple-one-sync-lightweight-account-input");
  new Setting(account).setName("仓库地址").addText((text) => text.setPlaceholder("https://github.com/用户名/仓库.git")
    .setValue(options.repoUrl).onChange(async (value) => { options.repoUrl = value.trim(); options.bound = false; await host.save(); })).settingEl.addClass("simple-one-sync-lightweight-account-input");
  root.querySelector<HTMLInputElement>('input[placeholder="https://github.com/用户名/仓库.git"]')?.setAttribute("data-lightweight-repo", "");
  new Setting(account).setName("分支").setDesc("留空使用仓库默认分支；不自动创建或重置仓库。")
    .addText((text) => text.setValue(options.branch).onChange(async (value) => { options.branch = value.trim(); options.bound = false; await host.save(); })).setClass("simple-one-sync-short-input");
  new Setting(account).setName("完整哈希校验").setDesc("只重新核对同步范围内的文件，不推进共同基准、不上传。")
    .addButton((button) => { styleSettingIconAction(button.buttonEl); button.setIcon("play").setTooltip("重新校验全部同步文件").setDisabled(!host.active()).onClick(() => void host.calibrate()); });
  const status = account.createEl("p", { cls: "simple-one-sync-setup-feedback", attr: { role: "status", "aria-live": "polite" } });
  status.hidden = true;
  const report = (message: string, error = false): void => {
    status.hidden = false; status.setText(message); status.toggleClass("simple-one-sync-setup-error", error);
  };
  new Setting(account).setName("核验仓库与 token").setDesc("只读取指定仓库信息和文件树，不列出账号全部仓库，不下载正文。")
    .addButton((button) => { styleSettingIconAction(button.buttonEl); button.setIcon("play").setTooltip("核验仓库与 token").setDisabled(!host.active()).onClick(async () => {
      button.setDisabled(true);
      report("正在检查 Token 与仓库…");
      try {
        const remote = await host.engine().verify();
        options.branch = remote.branch; await host.save();
        report(`已核验分支 ${remote.branch}，当前范围 ${Object.keys(remote.files).length} 个云端文件。`);
      } catch (error) { report(error instanceof Error ? error.message : String(error), true); }
      finally { button.setDisabled(false); }
    }); });
  const timing = section( "同步设置");
  new Setting(timing).setName("自动同步间隔（分钟）").setDesc("默认 0，仅手动同步；自动同步发现冲突或删除时等待手动预览。")
    .addText((text) => text.setValue(String(options.autoSyncMinutes)).onChange(async (value) => {
      const minutes = Number(value); if (!Number.isFinite(minutes) || minutes < 0) return;
      options.autoSyncMinutes = minutes; await persist();
    })).setClass("simple-one-sync-short-input");
  const rules = section("高级设置");
  rules.addClass("simple-one-sync-advanced");
  renderMobileSyncRules(rules, options, persist, () => host.engine().listCloudPlugins(), "simple-one", guide ? undefined : host);
  if (guide) root.createEl("h3", { text: "3 · link diff 缓存与路径" });
  if (!guide) {
    for (const row of Array.from(root.querySelectorAll<HTMLElement>(".setting-item"))) {
      const desc = row.querySelector<HTMLElement>(".setting-item-description");
      if (desc?.textContent) row.setAttribute("aria-label", desc.textContent);
    }
  }
  return rules;
}
