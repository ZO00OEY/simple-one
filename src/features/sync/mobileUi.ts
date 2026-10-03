import { App, Notice, Platform, Setting } from "obsidian";
import { MobileOptions, sameContent } from "./linkDiff";
import { ConflictChoice, MobileConflict, MobileGithub, MobilePlan } from "./mobileGithub";
import { LiveReview, PreviewFile, ZoeySyncConflictPreviewModal } from "./conflictPreview";

export interface MobileHost {
  active(): boolean;
  app: App;
  options: MobileOptions;
  engine(): MobileGithub;
  save(): Promise<void>;
  restart(): void;
  sync(): Promise<void>;
  calibrate(): Promise<void>;
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
    localChoiceLabel: single ? (c.local ? "上传文件" : "删除文件") : duplicate ? "采用本机路径" : "采用本机",
    remoteChoiceLabel: single ? (c.remote ? "下载文件" : "删除文件") : duplicate ? "采用云端路径" : "采用云端",
    reviewStage: single || duplicate || differentPaths && sameContent(c.local, c.remote) ? "file" : "content",
    keepSide: single ? (c.local ? "local" : "remote") : undefined,
    showPaths: differentPaths, missingLabel: single ? "文件不存在" : undefined,
    allowBoth: duplicate, mergeable: c.kind === "content" || c.kind === "initial",
    totalLines: 0, localUpdatedAt: "", remoteUpdatedAt: "", blocks: [] };
}

export class MobileSyncModal {
  private choices: Record<string, ConflictChoice> = {};
  constructor(private app: App, private engine: MobileGithub, private plan: MobilePlan,
    private auto = false,
    private review?: (live: LiveReview) => Promise<Record<string, ConflictChoice> | null>) {}

  async wait(): Promise<boolean> {
    if (this.plan.conflicts.length && !await this.reviewDifferences()) return false;
    // The difference dialog's confirm button is the execution confirmation.
    // execute still validates the head, scope, revision and live files.
    await this.engine.execute(this.plan);
    if (this.engine.requiresPluginReload(this.plan)) new Notice("同步与分享 程序文件已更新，请重新加载插件或重启 Obsidian 使新代码生效。", 12000);
    return true;
  }

  private async reviewDifferences(): Promise<boolean> {
    const conflicts = new Map(this.plan.conflicts.map(c => [c.id, c]));
    const live: LiveReview = {
      files: this.plan.conflicts.map(mobileConflictFile),
      read: async file => {
        const c = conflicts.get(file.path)!;
        if (c.kind === "duplicate") return { local: "", remote: "" };
        const [local, remote] = await Promise.all([
          c.local ? this.engine.reviewText(c.local) : "", c.remote ? this.engine.reviewText(c.remote) : ""
        ]);
        return { local, remote };
      }
    };
    const selected = this.review ? await this.review(live) : await new ZoeySyncConflictPreviewModal(this.app, live).wait();
    if (!selected) return false;
    this.choices = { ...this.plan.pendingChoices, ...selected };
    const next = await this.engine.preview(this.choices);
    if (next.remote.commit !== this.plan.remote.commit || next.revision !== this.plan.revision ||
        JSON.stringify(next.local) !== JSON.stringify(this.plan.local)) {
      throw new Error("选择期间两端状态发生变化，请重新同步并选择。");
    }
    if (next.conflicts.length) throw new Error("仍有未处理的差异，请重新同步并完成选择。");
    this.plan = next; return true;
  }

}

export function mobileCheckbox(root: HTMLElement, name: string, description: string, checked: boolean,
  change: (value: boolean) => Promise<void> | void, leading = false): Setting {
  const setting = new Setting(root).setName(name).setDesc(description);
  const input = setting.controlEl.createEl("input", { cls: "simple-one-sync-mobile-checkbox", attr: { type: "checkbox", "aria-label": name } });
  input.checked = checked;
  if (leading) {
    setting.settingEl.addClass("simple-one-sync-cloud-plugin-row");
    setting.settingEl.insertBefore(setting.controlEl, setting.infoEl);
    input.id = `simple-one-sync-plugin-${crypto.randomUUID()}`;
    setting.nameEl.empty();
    setting.nameEl.createEl("label", { text: name, attr: { for: input.id } });
  }
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
  loadPlugins: () => Promise<string[]>, currentPluginId = "simple-one"): void {
  root = root.createDiv({ cls: "simple-one-sync-sync-rules" });
  const image = mobileCheckbox(root, "同步图片", "慎关：关闭后所有图片均不参与同步，笔记可能出现缺图，其他设备的新图片也不会下载到本机。",
    options.syncImages, async (value) => { options.syncImages = value; await save(); });
  image.descEl.addClass("simple-one-sync-mobile-warning");
  const pluginRule = root.createDiv({ cls: "simple-one-sync-plugin-rule" });
  mobileCheckbox(pluginRule, "同步插件及配置", "勾选后读取云端插件列表，再逐个选择需要同步的插件；本机凭据与运行状态不参与同步。",
    options.syncPlugins, async (value) => {
      const previous = options.syncPlugins;
      options.syncPlugins = value;
      try { await save(); } catch (error) { options.syncPlugins = previous; throw error; }
      void showPlugins();
    }).settingEl.addClass("simple-one-sync-plugin-rule-toggle");
  const panel = pluginRule.createDiv({ cls: "simple-one-sync-cloud-plugins" });
  panel.hidden = !options.syncPlugins;
  panel.createEl("h4", { text: "云端插件" });
  panel.createEl("p", { text: "读取当前云端仓库与分支的插件清单，勾选需要同步的插件；本机尚未安装的插件也可选择。" });
  const status = panel.createEl("p", { cls: "simple-one-sync-setup-feedback", attr: { role: "status", "aria-live": "polite" } });
  const list = panel.createDiv();
  const refresh = panel.createEl("button", { text: "重新获取云端插件", cls: "simple-one-sync-cloud-plugins-refresh", attr: { type: "button" } });
  let loadedKey = "";
  let request = 0;
  const key = () => JSON.stringify([options.repoUrl, options.branch, options.token]);
  const showPlugins = async (force = false): Promise<void> => {
    panel.hidden = !options.syncPlugins;
    if (panel.hidden || (!force && loadedKey === key())) return;
    const current = ++request;
    const sourceKey = key();
    refresh.disabled = true;
    list.empty(); status.removeClass("simple-one-sync-setup-error"); status.setText("正在读取云端插件清单…");
    try {
      const plugins = [...new Set(await loadPlugins())].sort();
      if (!panel.isConnected || current !== request || sourceKey !== key()) return;
      loadedKey = sourceKey;
      status.setText(plugins.length ? `云端检测到 ${plugins.length} 个插件，请逐个勾选。` : "当前云端仓库没有可同步的插件。");
      for (const id of plugins) {
        mobileCheckbox(list, id, id === currentPluginId ? "可同步程序和共享设置；凭据、本机配置与状态自动屏蔽，程序更新后需重载插件。" : "", options.plugins.includes(id), async (checked) => {
          const previous = options.plugins;
          options.plugins = checked ? [...new Set([...options.plugins, id])] : options.plugins.filter((item) => item !== id);
          try { await save(); } catch (error) { options.plugins = previous; throw error; }
        }, true);
      }
    } catch (error) {
      if (current === request && panel.isConnected) {
        status.addClass("simple-one-sync-setup-error");
        status.setText(`读取云端插件失败：${error instanceof Error ? error.message : String(error)}。请重试。`);
      }
    } finally { if (current === request) refresh.disabled = false; }
  };
  refresh.addEventListener("click", () => void showPlugins(true));
  void showPlugins();
  mobileCheckbox(root, "开启哈希缓存", "仅在同步流程中校验并更新缓存；失败重试可复用，基准仅在同步完成后更新。关闭后每次同步重新计算。",
    options.cacheEnabled, async (value) => { options.cacheEnabled = value; await save(); });
  mobileCheckbox(root, "开启路径追踪", "记录文件改名和移动，关联移动后修改的内容。",
    options.trackPaths, async (value) => { options.trackPaths = value; await save(); });
}

export function renderMobileSettings(root: HTMLElement, host: MobileHost, guide = false, rerender?: () => void): void {
  const options = host.options;
  if (guide) root.createEl("h3", { text: "配置 GitHub 轻量同步" });
  if (guide && !Platform.isMobile) root.createEl("p", { text: "电脑可启用轻量同步运行相同流程；此模式会实际读写仓库，确认预览后才执行同步。" });
  if (guide) {
    const steps = root.createEl("ol");
    steps.createEl("li", { text: "在手机安装并启用 同步与分享，选择 GitHub API 模式。" });
    steps.createEl("li", { text: "填写仓库 HTTPS 地址及 token。token 需授予目标仓库 contents 读写权限。" });
    steps.createEl("li", { text: "核验仓库，然后确认图片、插件、缓存和路径追踪选项。" });
    steps.createEl("li", { text: "绑定后手动同步，检查首次预览和同名冲突。首次缺失文件不会被当成删除。" });
  }
  const persist = async (): Promise<void> => { await host.save(); host.restart(); };
  if (options.mode === "server") { root.createEl("p", { text: "服务器地址和密码在下方原服务器设置中填写。" }); return; }
  root.createEl("h3", { text: "账户设置" });
  const account = root.createDiv({ cls: "simple-one-sync-lightweight-account" });
  const engine = host.engine();
  const quota = new Setting(account).setName("GitHub API 剩余额度");
  const updateQuota = (remaining: number | null): void => {
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
  new Setting(account).setName("GitHub token").setDesc("只保存在本机插件数据中，不写入共享配置。")
    .addText((text) => { text.inputEl.type = "password"; text.setValue(options.token).onChange(async (value) => { options.token = value.trim(); engine.resetRemaining(); await host.save(); }); }).settingEl.addClass("simple-one-sync-lightweight-account-input");
  new Setting(account).setName("仓库地址").addText((text) => text.setPlaceholder("https://github.com/用户名/仓库.git")
    .setValue(options.repoUrl).onChange(async (value) => { options.repoUrl = value.trim(); options.bound = false; await host.save(); })).settingEl.addClass("simple-one-sync-lightweight-account-input");
  root.querySelector<HTMLInputElement>('input[placeholder="https://github.com/用户名/仓库.git"]')?.setAttribute("data-lightweight-repo", "");
  new Setting(account).setName("分支").setDesc("留空使用仓库默认分支；不自动创建或重置仓库。")
    .addText((text) => text.setValue(options.branch).onChange(async (value) => { options.branch = value.trim(); options.bound = false; await host.save(); }));
  new Setting(account).setName("完整哈希校验").setDesc("只重新核对同步范围内的文件，不推进共同基准、不上传。")
    .addButton((button) => button.setButtonText("重新校验全部同步文件").setDisabled(!host.active()).onClick(() => void host.calibrate()));
  const status = account.createEl("p", { cls: "simple-one-sync-setup-feedback", attr: { role: "status", "aria-live": "polite" } });
  status.hidden = true;
  const report = (message: string, error = false): void => {
    status.hidden = false; status.setText(message); status.toggleClass("simple-one-sync-setup-error", error);
  };
  new Setting(account).setName("核验仓库与 token").setDesc("只读取指定仓库信息和文件树，不列出账号全部仓库，不下载正文。")
    .addButton((button) => button.setButtonText("检查").setDisabled(!host.active()).onClick(async () => {
      button.setDisabled(true);
      report("正在检查 Token 与仓库…");
      try {
        const remote = await host.engine().verify();
        options.branch = remote.branch; await host.save();
        report(`已核验分支 ${remote.branch}，当前范围 ${Object.keys(remote.files).length} 个云端文件。`);
      } catch (error) { report(error instanceof Error ? error.message : String(error), true); }
      finally { button.setDisabled(false); }
    }));
  root.createEl("h3", { text: "同步设置" });
  new Setting(root).setName("自动同步间隔（分钟）").setDesc("默认 0，仅手动同步；自动同步发现冲突或删除时等待手动预览。")
    .addText((text) => text.setValue(String(options.autoSyncMinutes)).onChange(async (value) => {
      const minutes = Number(value); if (!Number.isFinite(minutes) || minutes < 0) return;
      options.autoSyncMinutes = minutes; await persist();
    }));
  root.createEl("h3", { text: "基础规则" });
  renderMobileSyncRules(root, options, persist, () => host.engine().listCloudPlugins());
  new Setting(root).setName("本机额外忽略规则").setDesc("每行一个目录或通配符，例如 私人目录/。不改云端 .gitignore，排除项不会被当成删除。")
    .addTextArea((text) => text.setValue(options.ignorePatterns.join("\n")).onChange(async (value) => {
      options.ignorePatterns = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); await persist();
    }));
  if (guide) root.createEl("h3", { text: "3 · link diff 缓存与路径" });
}
