import { App, Modal, Notice, Platform, Setting, setIcon } from "obsidian";
import { settingsSection, compactSettingsSection } from "../../shared/settingsLayout";
import { MobileOptions, sameContent, pluginSelected, selectPlugin } from "./linkDiff";
import { ConflictChoice, MobileConflict, MobileGithub, MobilePlan } from "./mobileGithub";
import { LiveReview, PreviewFile, ZoeySyncConflictPreviewModal } from "./conflictPreview";
import { mirrorPlan, strategyChoices, type SyncStrategy } from "./syncPlan";

export interface MobileSyncFlow {
  strategy(plan: MobilePlan): Promise<SyncStrategy | null>;
  confirm(plan: MobilePlan): Promise<boolean>;
  transfer(): Promise<void>;
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
    private review?: (live: LiveReview) => Promise<Record<string, ConflictChoice> | null>,
    private flow?: MobileSyncFlow) {}

  async wait(): Promise<boolean> {
    if (this.flow && (!this.engine.state.baseCommitSha || this.plan.conflicts.length)) {
      const strategy = await this.flow.strategy(this.plan);
      if (!strategy) return false;
      if (strategy === "local" || strategy === "remote") this.plan = mirrorPlan(this.plan, strategy);
      else if (strategy === "merge") {
        const next = await this.engine.preview(strategyChoices(this.plan, strategy));
        this.assertUnchanged(next);
        this.plan = next;
      }
    }
    if (this.plan.conflicts.length && !await this.reviewDifferences()) return false;
    if (this.flow && !await this.flow.confirm(this.plan)) return false;
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
    this.assertUnchanged(next);
    if (next.conflicts.length) throw new Error("仍有未处理的差异，请重新同步并完成选择。");
    this.plan = next; return true;
  }

  private assertUnchanged(next: MobilePlan): void {
    if (next.remote.commit !== this.plan.remote.commit || next.revision !== this.plan.revision || next.scope !== this.plan.scope ||
        JSON.stringify(next.local) !== JSON.stringify(this.plan.local)) throw new Error("选择期间两端状态发生变化，请重新同步并选择。");
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
  loadPlugins: () => Promise<string[]>, currentPluginId = "simple-one", compactHost?: MobileHost): void {
  if (compactHost) { renderCompactSyncRules(root, options, save, loadPlugins, compactHost); return; }
  root = root.createDiv({ cls: "simple-one-sync-sync-rules" });
  const image = mobileCheckbox(root, "同步图片", "慎关：关闭后所有图片均不参与同步，笔记可能出现缺图，其他设备的新图片也不会下载到本机。",
    options.syncImages, async (value) => { options.syncImages = value; await save(); });
  image.descEl.addClass("simple-one-sync-mobile-warning");
  const pluginRule = root.createDiv({ cls: "simple-one-sync-plugin-rule" });
  mobileCheckbox(pluginRule, "同步插件及配置", "默认同步全部插件，新增插件自动参与；可取消勾选个别插件，本机凭据与运行状态不参与同步。",
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
      status.setText(plugins.length ? `云端检测到 ${plugins.length} 个插件；默认全选，可取消不需要的插件。` : "当前云端仓库没有可同步的插件。");
      for (const id of plugins) {
        mobileCheckbox(list, id, id === currentPluginId ? "可同步程序和共享设置；凭据、本机配置与状态自动屏蔽，程序更新后需重载插件。" : "", pluginSelected(options.plugins, id), async (checked) => {
          const previous = options.plugins;
          options.plugins = selectPlugin(options.plugins, id, checked);
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

function renderCompactSyncRules(root: HTMLElement, options: MobileOptions, save: () => Promise<void> | void, loadPlugins: () => Promise<string[]>, host: MobileHost): void {
  root = root.createDiv({ cls: "simple-one-sync-sync-rules" });
  const image = mobileCheckbox(root, "同步图片", "关闭后，所有图片都不参与同步。", options.syncImages, async value => { options.syncImages = value; await save(); });
  image.nameEl.createSpan({ text: "（慎关：关闭后所有图片不参与同步）", cls: "simple-lightweight-image-warning" });
  const plugins = mobileCheckbox(root, "同步插件及配置", "默认同步全部插件及新增插件；本机凭据和运行状态不参与同步。", options.syncPlugins, async value => { options.syncPlugins = value; await save(); });
  const manage = plugins.settingEl.createEl("button", { cls: "clickable-icon simple-lightweight-action", attr: { type: "button", title: "选择同步插件", "aria-label": "选择同步插件" } });
  setIcon(manage, "settings");
  manage.addEventListener("click", () => {
    const modal = new Modal(host.app);
    let selected = [...options.plugins];
    const source = JSON.stringify([options.repoUrl, options.branch, options.token]);
    let closed = false;
    let loading = false;
    modal.onOpen = () => {
      const content = modal.contentEl;
      content.addClass("simple-lightweight-plugin-modal");
      content.createEl("h2", { text: "选择同步插件" });
      const refresh = content.createEl("button", { text: "重新获取插件", attr: { type: "button" } });
      const status = content.createDiv({ cls: "setting-item-description", attr: { role: "status" } });
      const list = content.createDiv();
      const footer = content.createDiv({ cls: "simple-json-modal-footer" });
      footer.createEl("button", { text: "取消" }).addEventListener("click", () => modal.close());
      const confirm = footer.createEl("button", { text: "确认", cls: "mod-cta" });
      const load = async (): Promise<void> => {
        if (loading) return;
        loading = true; refresh.disabled = confirm.disabled = true;
        status.setText("正在获取云端插件…");
        try {
          const remote = await loadPlugins();
          if (closed) return;
          list.empty();
          for (const id of [...new Set([...remote, ...selected.filter(id => id !== "*").map(id => id.replace(/^!/, ""))])].sort()) {
            mobileCheckbox(list, id, remote.includes(id) ? "" : "已选插件，当前云端列表中未找到。", pluginSelected(selected, id), value => { selected = selectPlugin(selected, id, value); });
          }
          status.setText(`云端 ${remote.length} 个插件；默认全选，新增插件自动参与，可取消个别插件。`);
        } catch (error) { if (!closed) status.setText(`获取失败：${error instanceof Error ? error.message : String(error)}`); }
        finally { loading = false; refresh.disabled = confirm.disabled = false; }
      };
      refresh.addEventListener("click", () => void load());
      confirm.addEventListener("click", () => void (async () => {
        if (source !== JSON.stringify([options.repoUrl, options.branch, options.token])) { new Notice("仓库配置已变化，请关闭后重新打开插件选择。"); return; }
        const previous = options.plugins;
        refresh.disabled = confirm.disabled = true;
        options.plugins = [...selected];
        try { await save(); modal.close(); }
        catch (error) { options.plugins = previous; new Notice(error instanceof Error ? error.message : String(error)); }
        finally { refresh.disabled = confirm.disabled = false; }
      })());
      void load();
    };
    modal.onClose = () => { closed = true; modal.contentEl.empty(); };
    modal.open();
  });
  mobileCheckbox(root, "缓存文件校验结果，加快同步", "复用已校验文件的哈希，减少重复计算；关闭后每次重新计算。", options.cacheEnabled, async value => { options.cacheEnabled = value; await save(); });
  mobileCheckbox(root, "追踪文件改名与移动", "识别文件改名和移动，关联移动前后的内容。", options.trackPaths, async value => { options.trackPaths = value; await save(); });
}

export function renderMobileSettings(root: HTMLElement, host: MobileHost, guide = false): void {
  const options = host.options;
  if (!guide) root.addClass("simple-lightweight-sync-settings");
  const section = (title: string): HTMLElement => guide ? settingsSection(root, title) : compactSettingsSection(root, title);
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
    .addText((text) => text.setValue(options.branch).onChange(async (value) => { options.branch = value.trim(); options.bound = false; await host.save(); }));
  new Setting(account).setName("完整哈希校验").setDesc("只重新核对同步范围内的文件，不推进共同基准、不上传。")
    .addButton((button) => button.setIcon("play").setTooltip("重新校验全部同步文件").setDisabled(!host.active()).onClick(() => void host.calibrate()));
  const status = account.createEl("p", { cls: "simple-one-sync-setup-feedback", attr: { role: "status", "aria-live": "polite" } });
  status.hidden = true;
  const report = (message: string, error = false): void => {
    status.hidden = false; status.setText(message); status.toggleClass("simple-one-sync-setup-error", error);
  };
  new Setting(account).setName("核验仓库与 token").setDesc("只读取指定仓库信息和文件树，不列出账号全部仓库，不下载正文。")
    .addButton((button) => button.setIcon("play").setTooltip("核验仓库与 token").setDisabled(!host.active()).onClick(async () => {
      button.setDisabled(true);
      report("正在检查 Token 与仓库…");
      try {
        const remote = await host.engine().verify();
        options.branch = remote.branch; await host.save();
        report(`已核验分支 ${remote.branch}，当前范围 ${Object.keys(remote.files).length} 个云端文件。`);
      } catch (error) { report(error instanceof Error ? error.message : String(error), true); }
      finally { button.setDisabled(false); }
    }));
  const timing = section( "同步设置");
  new Setting(timing).setName("自动同步间隔（分钟）").setDesc("默认 0，仅手动同步；自动同步发现冲突或删除时等待手动预览。")
    .addText((text) => text.setValue(String(options.autoSyncMinutes)).onChange(async (value) => {
      const minutes = Number(value); if (!Number.isFinite(minutes) || minutes < 0) return;
      options.autoSyncMinutes = minutes; await persist();
    }));
  const rules = section( "基础规则");
  renderMobileSyncRules(rules, options, persist, () => host.engine().listCloudPlugins(), "simple-one", guide ? undefined : host);
  if (guide) {
    new Setting(rules).setName("本机额外忽略规则").setDesc("每行一个目录或通配符，仅影响本机。")
      .addTextArea(text => text.setValue(options.ignorePatterns.join("\n")).onChange(async value => { options.ignorePatterns = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); await persist(); }));
  } else {
    const row = new Setting(rules).setName("本机额外排除").setDesc("仅影响这台设备，不改云端 .gitignore，排除项不作为删除。");
    const count = row.controlEl.createSpan({ text: `${options.ignorePatterns.length} 条` });
    row.addButton(button => button.setIcon("settings").setTooltip("编辑本机额外排除规则").onClick(() => {
      const modal = new Modal(host.app);
      modal.onOpen = () => {
        modal.contentEl.addClass("simple-lightweight-plugin-modal");
        modal.contentEl.createEl("h2", { text: "本机额外排除" });
        modal.contentEl.createEl("p", { text: "每行一个目录或通配符，例如 私人目录/。只影响本机，不改云端规则，也不会删除文件。" });
        const input = modal.contentEl.createEl("textarea", { attr: { "aria-label": "本机额外排除规则", rows: "8" } });
        input.value = options.ignorePatterns.join("\n");
        const footer = modal.contentEl.createDiv({ cls: "simple-json-modal-footer" });
        footer.createEl("button", { text: "取消" }).addEventListener("click", () => modal.close());
        const confirm = footer.createEl("button", { text: "确认", cls: "mod-cta" });
        confirm.addEventListener("click", () => void (async () => {
          const previous = options.ignorePatterns;
          confirm.disabled = true;
          options.ignorePatterns = [...new Set(input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
          try { await persist(); count.setText(`${options.ignorePatterns.length} 条`); modal.close(); }
          catch (error) { options.ignorePatterns = previous; new Notice(error instanceof Error ? error.message : String(error)); }
          finally { confirm.disabled = false; }
        })());
      };
      modal.onClose = () => modal.contentEl.empty();
      modal.open();
    }));
  }
  if (guide) root.createEl("h3", { text: "3 · link diff 缓存与路径" });
  if (!guide) {
    for (const row of Array.from(root.querySelectorAll<HTMLElement>(".setting-item"))) {
      const desc = row.querySelector<HTMLElement>(".setting-item-description");
      if (desc?.textContent) row.title = desc.textContent;
    }
  }
}
