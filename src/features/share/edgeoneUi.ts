import { Setting, setIcon } from "obsidian";
import { EDGEONE_PROJECTS_URL, EDGEONE_SETTINGS_URL, EdgeOneConnection } from "./edgeone";

export function shareExternalLink(parent: HTMLElement, text: string, href: string): void {
  parent.createEl("a", { text, href, cls: "simple-share-external-link",
    attr: { target: "_blank", rel: "noopener noreferrer" } });
}

export function renderMainlandPreviewNotice(parent: HTMLElement, projectUrl: string): void {
  const first = parent.createDiv({ cls: "simple-share-inline-notice" });
  first.createSpan({ text: "当前加速区域包含中国大陆。未绑定自定义域名时，需从" });
  shareExternalLink(first, "项目概览 ↗", projectUrl);
  first.createSpan({ text: "获取预览链接（有效期 3 小时）。" });
  parent.createDiv({ text: "长期访问请绑定已备案的自定义域名。" });
}

export interface EdgeOneRepositoryVisibility {
  private: boolean | null;
  checking: boolean;
  error: string;
  refresh: () => void;
}

function renderGithubAccessReminder(parent: HTMLElement, visibility?: EdgeOneRepositoryVisibility,
  phase: "creation" | "deployment" = "deployment"): void {
  if (!visibility) return;
  if (visibility.checking || visibility.error) {
    const status = parent.createDiv({ cls: "simple-share-edgeone-visibility-status" });
    status.createEl("p", { text: visibility.checking ? "正在检查 GitHub 分享仓库是否公开…" : visibility.error,
      cls: visibility.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-helper", attr: { role: "status", "aria-live": "polite" } });
    if (visibility.error) status.createEl("button", { text: "重新检查仓库状态", attr: { type: "button" } })
      .addEventListener("click", visibility.refresh);
    return;
  }
  if (!visibility.private) return;
  parent.createEl("p", {
    text: phase === "creation"
      ? "分享仓库为私有，请确认 EdgeOne Makers 已获该仓库的 GitHub 授权。"
      : "本次部署未成功，且分享仓库为私有。请检查 EdgeOne Makers 是否仍有该仓库的 GitHub 授权，并查看部署日志确认原因。",
    cls: "simple-one-sync-setup-error"
  });
  if (phase === "deployment") shareExternalLink(parent.createDiv({ cls: "simple-share-provider-links" }),
    "在 GitHub 检查或补充授权 ↗", "https://github.com/settings/installations");
}

export function renderEdgeOneRow(parent: HTMLElement, connection: EdgeOneConnection, enabled: boolean,
  publishing: boolean, openGuide: () => void): void {
  const row = new Setting(parent).setName("EdgeOne Makers").setClass("simple-share-provider-row");
  const links = row.descEl.createDiv({ cls: "simple-share-provider-links" });
  if (connection.website) shareExternalLink(links, "打开分享网站 ↗", connection.website);
  shareExternalLink(links, "在腾讯检查项目设置 ↗", EDGEONE_PROJECTS_URL);
  if (!connection.linked) shareExternalLink(links, "腾讯授权设置 ↗", EDGEONE_SETTINGS_URL);
  row.addButton(button => button.setButtonText(connection.linked ? "重新检查或修复接入" : "开始接入引导")
    .setDisabled(!enabled || publishing || connection.busy).onClick(openGuide));
  if (connection.linked) {
    row.addButton(button => button.setButtonText(connection.busy ? "检查中…" : "检查网站部署")
      .setDisabled(!enabled || publishing || connection.busy)
      .onClick(() => { void connection.run(async () => { await connection.checkDeployment(); }); }));
  }
  const result = connection.linked ? connection.state.lastCheck : undefined;
  row.infoEl.createEl("p", {
    text: connection.error || (connection.busy ? connection.message : result?.text) ||
      (connection.linked ? `已关联项目 ${connection.state.projectName}，尚未查询部署状态。` : "尚未接入腾讯分享网站。"),
    cls: `simple-share-edgeone-result ${connection.error || result?.kind === "error" ? "simple-share-error" : !connection.busy && result?.kind === "success" ? "simple-share-success" : "simple-share-status"}`,
    attr: { role: "status", "aria-live": "polite" }
  });
}

export function renderEdgeOneGuide(parent: HTMLElement, connection: EdgeOneConnection, enabled: boolean,
  publishing: boolean, back: () => void, shareGuide: () => void, embedded = false, onProjectReady?: () => void,
  repositoryVisibility?: EdgeOneRepositoryVisibility, progressText = ""): void {
  const blocked = !enabled || publishing || connection.busy;
  const completed = connection.completed;
  const runAndContinue = async (work: () => Promise<void>): Promise<void> => {
    await connection.run(work);
    if (connection.error) return;
    connection.authMode = "verify";
    connection.refresh();
    if (embedded && connection.projectCheckDone && connection.linked) onProjectReady?.();
  };
  if (connection.authMode === null) {
    connection.tokenVerified = false;
    connection.projectCheckDone = false;
    connection.error = "";
    connection.authMode = connection.hasToken ? "verify" : "create";
    if (connection.hasToken) void Promise.resolve().then(async () => {
      repositoryVisibility?.refresh();
      await runAndContinue(() => connection.verifyToken(true));
      if (connection.error && !connection.tokenVerified) { connection.authMode = "create"; connection.refresh(); }
    });
  }
  if (!embedded) {
  const status = parent.createDiv({ cls: `simple-one-sync-setup-status is-${connection.error ? "error" : completed ? "success" : "disconnected"}`, attr: { role: "status" } });
  setIcon(status.createSpan({ cls: "simple-one-sync-setup-status__icon" }), connection.error ? "triangle-alert" : completed ? "check" : "unplug");
  const copy = status.createDiv({ cls: "simple-one-sync-setup-status__copy" });
  copy.createEl("strong", { text: connection.error ? "腾讯接入需要检查" : completed ? "腾讯接入已完成" : "腾讯接入尚未完成" });
  copy.createEl("p", { text: connection.error || (completed
    ? "当前分享仓库已关联腾讯项目，最近一次分享已部署到正式网站。"
    : "核验腾讯授权，关联分享仓库，然后初始化网站。") });
  }
  const available = connection.authMode === "verify" && connection.tokenVerified && connection.hasToken
    ? connection.linked ? 3 : 2 : 1;
  const step = Math.min(connection.state.step, available);
  if (!embedded) {
  const nav = parent.createDiv({ cls: "simple-one-sync-setup-nav simple-share-edgeone-nav" });
  ["注册与授权", "关联分享仓库", "初始化并完成"].forEach((title, index) => {
    const target = index + 1;
    const button = nav.createEl("button", { cls: `simple-one-sync-setup-nav__step${step === target ? " is-active" : ""}${target < available || completed ? " is-done" : ""}`,
      attr: { type: "button", "aria-current": target === step ? "step" : "false" } });
    button.createSpan({ text: String(target), cls: "simple-one-sync-setup-nav__marker" });
    button.createSpan({ text: title, cls: "simple-one-sync-setup-nav__label" });
    button.disabled = blocked || target > available;
    button.addEventListener("click", () => {
      if (target === 2) void connection.run(() => connection.enterRepositoryStep());
      else { connection.state.step = target; connection.refresh(); }
    });
  });
  }
  const body = parent.createDiv({ cls: `simple-one-sync-setup-body simple-share-guide-body simple-share-edgeone-guide${embedded ? " is-embedded" : " simple-one-sync-card"}` });
  const authBody = step === 1 || embedded && step >= 2
    ? body.createDiv({ cls: "simple-share-edgeone-flow-step simple-share-edgeone-auth-section" }) : body;
  if (step === 1 || embedded && step >= 2) {
    new Setting(authBody).setName("授权 Simple One 管理 EdgeOne Makers").setHeading();
    if (step >= 2) authBody.createEl("p", { text: "EdgeOne Makers API Token 已核验。", cls: "simple-one-sync-setup-feedback" });
  }
  if (step === 1) {
    if (connection.authMode === "create") {
      const links = authBody.createDiv({ cls: "simple-share-provider-links" });
      shareExternalLink(links, "创建 EdgeOne Makers API Token ↗", EDGEONE_SETTINGS_URL);
      authBody.createEl("p", { text: "登录腾讯云，依次进入 EdgeOne → Makers → 设置 → API Token，点击「创建 API Token」。" });
    } else if (connection.authMode === "verify") {
      authBody.createEl("p", { text: connection.tokenVerified ? "EdgeOne Makers API Token 已核验。" : "正在核验本机已保存的 EdgeOne Makers API Token…",
        cls: connection.tokenVerified ? "simple-one-sync-setup-feedback" : "simple-one-sync-setup-helper", attr: { role: "status", "aria-live": "polite" } });
    }
    if (connection.authMode === "create") {
    new Setting(authBody).setName("EdgeOne Makers API Token").setClass("simple-one-sync-token-input")
      .addText(text => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.setPlaceholder("粘贴完整的 API Token").setValue(connection.draftToken).onChange(value => { connection.draftToken = value; });
        text.inputEl.disabled = blocked;
      });
    new Setting(authBody).addButton(button => button.setButtonText("核验连接").setCta().setDisabled(blocked)
      .onClick(() => { void runAndContinue(() => connection.verifyToken()); }));
    }
  } else if (step === 2 || embedded && step >= 2) {
    const site = connection.site();
    const ready = !!site.owner && !!site.repo;
    if (!ready) {
      body.createEl("p", { text: "请先完成笔记分享引导，创建或连接分享仓库。" });
      const button = body.createEl("button", { text: "前往笔记分享引导", attr: { type: "button" } });
      button.disabled = blocked; button.addEventListener("click", shareGuide);
    } else {
      const areaNames = { overseas: "全球（不含中国大陆）", mainland: "中国大陆", global: "全球（含中国大陆）" };
      const project = body.createDiv({ cls: "simple-one-sync-setup-detail simple-share-edgeone-project-stage" });
      if (!connection.projectCheckDone) {
        const lookup = project.createDiv({ cls: "simple-share-edgeone-flow-step simple-share-edgeone-project-step" });
        new Setting(lookup).setName("查找 EdgeOne Makers 项目").setHeading();
        lookup.createEl("p", {
          text: connection.busy ? connection.message || "正在查找匹配项目…"
            : connection.error ? "项目查找未完成，可重试。" : "核验 API Token 后自动查找与当前分享仓库和分支匹配的项目。",
          cls: "simple-one-sync-setup-helper", attr: { role: "status", "aria-live": "polite" }
        });
        if (connection.error && connection.hasToken) new Setting(lookup).addButton(button => {
          button.buttonEl.addClass("simple-share-find-project");
          button.setButtonText("重新查找项目").setDisabled(blocked)
            .onClick(() => { void runAndContinue(async () => { await connection.enterRepositoryStep(); connection.projectCheckDone = true; }); });
        });
      } else if (connection.linked) {
        const linked = project.createDiv({ cls: "simple-share-edgeone-flow-step simple-share-edgeone-project-step" });
        new Setting(linked).setName("已关联 EdgeOne Makers 项目").setHeading();
        const deploying = embedded && (publishing || connection.state.lastCheck?.kind === "pending");
        if (deploying) linked.createEl("progress", { attr: { "aria-label": "正在验证仓库读取并部署" } });
        const detail = deploying && progressText &&
          !(connection.state.lastCheck?.kind === "pending" && /正在检查网站部署/.test(progressText))
          ? progressText : connection.message;
        linked.createEl("p", { text: detail,
          cls: deploying || !embedded && connection.completed ? "simple-one-sync-setup-feedback" : "simple-one-sync-setup-helper",
          attr: { role: "status", "aria-live": "polite" } });
        renderGithubAccessReminder(linked, repositoryVisibility);
        if (repositoryVisibility) shareExternalLink(linked.createDiv({ cls: "simple-share-provider-links" }), "查看 EdgeOne 项目及部署日志 ↗", EDGEONE_PROJECTS_URL);
        if (!embedded) new Setting(linked).addButton(button => button.setButtonText("继续初始化或检查网站").setCta().setDisabled(blocked)
          .onClick(() => { connection.state.step = 3; connection.refresh(); }));
      } else if (connection.candidates.length) {
        const choice = project.createDiv({ cls: "simple-share-edgeone-flow-step simple-share-edgeone-project-step" });
        new Setting(choice).setName("选择已有项目").setHeading();
        choice.createEl("p", { text: connection.message, cls: "simple-one-sync-setup-helper", attr: { role: "status", "aria-live": "polite" } });
        new Setting(choice).setName("匹配的 EdgeOne Makers 项目")
          .addDropdown(dropdown => dropdown.addOptions(Object.fromEntries(connection.candidates.map(item => [item.ProjectId, `${item.Name}（${item.ProjectId}）`])))
            .setValue(connection.selectedProject).setDisabled(blocked).onChange(value => { connection.selectedProject = value; }));
        new Setting(choice).addButton(button => button.setButtonText("关联所选项目并继续").setCta().setDisabled(blocked)
          .onClick(() => { void runAndContinue(() => connection.connectProject()); }));
      } else {
        project.createEl("p", { text: connection.message, cls: "simple-one-sync-setup-helper", attr: { role: "status", "aria-live": "polite" } });
        const steps = project.createDiv({ cls: "simple-share-edgeone-project-steps" });
        const github = steps.createDiv({ cls: "simple-share-edgeone-flow-step simple-share-edgeone-project-step" });
        new Setting(github).setName("使用 GitHub 分享仓库");
        github.createEl("p", { text: `本次使用：${site.owner}/${site.repo}（${site.branch} 分支）`, cls: "simple-share-edgeone-selected-repo" });
        if (connection.projectCreationFailed) {
          github.createEl("p", { text: "项目创建未成功。若错误涉及仓库读取，请检查 EdgeOne 的 GitHub 连接和仓库授权后重试。",
            cls: "simple-one-sync-setup-helper" });
          renderGithubAccessReminder(github, repositoryVisibility, "creation");
          const links = github.createDiv({ cls: "simple-share-provider-links" });
          shareExternalLink(links, "在 EdgeOne 导入 GitHub 仓库 ↗", EDGEONE_PROJECTS_URL);
          shareExternalLink(links, "在 GitHub 检查或补充授权 ↗", "https://github.com/settings/installations");
        }
        const region = steps.createDiv({ cls: "simple-share-edgeone-flow-step simple-share-edgeone-project-step" });
        const regionSetting = new Setting(region).setName("为新建 EdgeOne Makers 项目选择加速区域")
          .setDesc(`项目名称自动使用分享仓库名：${site.repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")}。`)
          .addDropdown(dropdown => dropdown.addOptions(areaNames)
            .setValue(connection.area).setDisabled(blocked).onChange(value => {
              connection.area = value as typeof connection.area;
              updateAreaNote();
            }));
        const areaNote = regionSetting.infoEl.createDiv({ cls: "simple-share-edgeone-area-note", attr: { role: "note" } });
        setIcon(areaNote.createSpan({ cls: "simple-share-edgeone-area-note__icon" }), "circle-alert");
        const areaCopy = areaNote.createDiv();
        const updateAreaNote = () => {
          areaCopy.replaceChildren();
          if (connection.area === "overseas") areaCopy.textContent = "该区域不提供中国大陆节点加速；项目域名在非中国大陆可直接访问，绑定自定义域名无需备案。";
          else renderMainlandPreviewNotice(areaCopy, EDGEONE_PROJECTS_URL);
        };
        updateAreaNote();
        new Setting(project).addButton(button => button.setButtonText("创建并关联项目").setCta().setDisabled(blocked)
          .onClick(() => { void runAndContinue(() => connection.connectProject()); }))
          .addButton(button => {
            button.buttonEl.addClass("simple-share-find-project");
            button.setButtonText("已在腾讯创建？重新查找").setDisabled(blocked)
              .onClick(() => { void runAndContinue(async () => { await connection.enterRepositoryStep(); connection.projectCheckDone = true; }); });
          });
      }
    }
  } else {
    body.createEl("h3", { text: completed ? "接入已完成" : "初始化腾讯分享网站" });
    body.createEl("p", { text: `项目：${connection.state.projectName ?? ""}` });
    body.createEl("p", { text: "检查最近一次推送的分享。若腾讯尚未开始部署，插件会请求初始化并持续反馈进度。" });
    if (connection.website) shareExternalLink(body, "打开腾讯分享网站 ↗", connection.website);
    shareExternalLink(body.createDiv({ cls: "simple-share-provider-links" }), "查看腾讯项目及构建日志 ↗", EDGEONE_PROJECTS_URL);
    new Setting(body)
      .addButton(button => button.setButtonText(completed ? "重新检查网站部署" : "初始化并检查进度").setCta().setDisabled(blocked)
        .onClick(() => { void connection.run(async () => {
          if (completed) await connection.checkDeployment(); else await connection.initializeWebsite();
        }); }))
      .addButton(button => button.setButtonText("返回分享设置").onClick(() => { connection.stop(); back(); }));
  }
  if (connection.busy) body.createEl("progress", { attr: { "aria-label": "腾讯接入正在进行" } });
  if (connection.error || connection.message && (connection.busy || step !== 2 || !connection.projectCheckDone)) body.createEl("p", {
    text: connection.error || connection.message,
    cls: connection.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback",
    attr: { role: "status", "aria-live": "polite" }
  });
}
