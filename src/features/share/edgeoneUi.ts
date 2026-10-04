import { Setting, setIcon } from "obsidian";
import { EDGEONE_PROJECTS_URL, EDGEONE_SETTINGS_URL, EdgeOneConnection } from "./edgeone";

export function shareExternalLink(parent: HTMLElement, text: string, href: string): void {
  parent.createEl("a", { text, href, cls: "simple-share-external-link",
    attr: { target: "_blank", rel: "noopener noreferrer" } });
}

export function renderEdgeOneRow(parent: HTMLElement, connection: EdgeOneConnection, enabled: boolean,
  publishing: boolean, openGuide: () => void): void {
  const row = new Setting(parent).setName("腾讯 EdgeOne Pages（Makers）").setClass("simple-share-provider-row");
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
  publishing: boolean, back: () => void, shareGuide: () => void): void {
  const blocked = !enabled || publishing || connection.busy;
  const completed = connection.completed;
  const status = parent.createDiv({ cls: `simple-one-sync-setup-status is-${connection.error ? "error" : completed ? "success" : "disconnected"}`, attr: { role: "status" } });
  setIcon(status.createSpan({ cls: "simple-one-sync-setup-status__icon" }), connection.error ? "triangle-alert" : completed ? "check" : "unplug");
  const copy = status.createDiv({ cls: "simple-one-sync-setup-status__copy" });
  copy.createEl("strong", { text: connection.error ? "腾讯接入需要检查" : completed ? "腾讯接入已完成" : "腾讯接入尚未完成" });
  copy.createEl("p", { text: connection.error || (completed
    ? "当前分享仓库已关联腾讯项目，最近一次分享已部署到正式网站。"
    : "核验腾讯授权，关联分享仓库，然后初始化网站。") });
  const available = connection.hasToken ? connection.linked ? 3 : 2 : 1;
  const step = Math.min(connection.state.step, available);
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
  const body = parent.createDiv({ cls: "simple-one-sync-card simple-one-sync-setup-body simple-share-guide-body simple-share-edgeone-guide" });
  if (step === 1) {
    new Setting(body).setName("选择授权方式").setHeading();
    const options = body.createDiv({ cls: "simple-one-sync-setup-options simple-share-edgeone-auth-options" });
    for (const mode of ["create", "verify"] as const) {
      const button = options.createEl("button", { text: mode === "verify" ? "验证已有授权" : "填写 API Token",
        cls: `simple-one-sync-setup-option${connection.authMode === mode ? " is-selected" : ""}`,
        attr: { type: "button", "aria-pressed": String(connection.authMode === mode) } });
      button.disabled = blocked || (mode === "verify" && !connection.hasToken);
      button.addEventListener("click", () => {
        connection.authMode = mode; connection.draftToken = ""; connection.error = ""; connection.message = "";
        if (mode === "verify") void connection.run(() => connection.verifyToken(true));
        else connection.refresh();
      });
    }
    if (connection.authMode === "create") {
      const links = body.createDiv({ cls: "simple-share-provider-links" });
      shareExternalLink(links, "打开腾讯 API Token 设置 ↗", EDGEONE_SETTINGS_URL);
      body.createEl("p", { text: "登录腾讯云，选择 EdgeOne → Makers → 设置 → API Token，点击「创建 API Token」。复制创建后的完整 API Token，粘贴到下方核验。" });
      body.createEl("p", { text: "授权时间长度可给长授权，过期将无法查询构建状态。" });
    } else {
      body.createEl("p", { text: connection.hasToken ? "点击「验证已有授权」直接读取已保存的 API Token，重新检验连接。核验通过后进入关联分享仓库。" : "尚未保存 API Token，请先选择「填写 API Token」。" });
    }
    body.createEl("p", { text: "Token 仅存在你的本地设置中。" });
    if (connection.authMode === "create") {
    new Setting(body).setName("腾讯 API Token").setClass("simple-one-sync-token-input")
      .addText(text => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.setPlaceholder("粘贴腾讯 API Token").setValue(connection.draftToken).onChange(value => { connection.draftToken = value; });
        text.inputEl.disabled = blocked;
      });
    new Setting(body).addButton(button => button.setButtonText("核验连接").setCta().setDisabled(blocked)
      .onClick(() => { void connection.run(() => connection.verifyToken()); }));
    }
  } else if (step === 2) {
    const site = connection.site();
    const ready = !!site.initialized && !!site.owner && !!site.repo;
    if (!ready) {
      body.createEl("p", { text: "请先完成笔记分享引导，创建并初始化专用的公开分享仓库。" });
      const button = body.createEl("button", { text: "前往笔记分享引导", attr: { type: "button" } });
      button.disabled = blocked; button.addEventListener("click", shareGuide);
    } else {
      const repo = new Setting(body).setName("当前分享仓库").setClass("simple-share-repository-row");
      shareExternalLink(repo.descEl, `https://github.com/${site.owner}/${site.repo}`, `https://github.com/${site.owner}/${site.repo}`);
      body.createEl("p", { text: connection.linked
        ? `已关联腾讯项目 ${connection.state.projectName}，分支为 ${site.branch}。后续推送分享会触发腾讯自动更新。`
        : "当前分享仓库尚未关联腾讯项目，请选择已有项目或创建并关联。若提示 GitHub 尚未授权，请在腾讯控制台选择「导入 Git 仓库 → GitHub」，完成授权后返回重试。" });
      const links = body.createDiv({ cls: "simple-share-provider-links" });
      shareExternalLink(links, "打开腾讯项目页并授权 GitHub ↗", EDGEONE_PROJECTS_URL);
      if (connection.linked) {
        new Setting(body).addButton(button => button.setButtonText("继续初始化或检查网站").setCta().setDisabled(blocked)
          .onClick(() => { connection.state.step = 3; connection.refresh(); }));
      } else {
      new Setting(body).setName("腾讯项目名称").setDesc("可使用建议名称，也可以填写自己的名称。")
        .addText(text => {
          text.setValue(connection.draftName || site.repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")).onChange(value => { connection.draftName = value; });
          text.inputEl.disabled = blocked;
        });
      new Setting(body).setName("访问区域").setDesc("中国大陆区域或全球区域请按腾讯要求完成域名备案。")
        .addDropdown(dropdown => dropdown.addOptions({ overseas: "全球（不含中国大陆）", mainland: "中国大陆", global: "全球（含中国大陆）" })
          .setValue(connection.area).setDisabled(blocked).onChange(value => { connection.area = value as typeof connection.area; }));
      if (connection.candidates.length) new Setting(body).setName("已有腾讯项目")
        .addDropdown(dropdown => dropdown.addOptions(Object.fromEntries(connection.candidates.map(project => [project.ProjectId, project.Name])))
          .setValue(connection.selectedProject).setDisabled(blocked).onChange(value => { connection.selectedProject = value; }));
      new Setting(body)
        .addButton(button => button.setButtonText("查找已有项目").setDisabled(blocked).onClick(() => { void connection.run(() => connection.findProjects()); }))
        .addButton(button => button.setButtonText(connection.selectedProject ? "关联项目并继续" : "创建并关联项目").setCta().setDisabled(blocked)
          .onClick(() => { void connection.run(() => connection.connectProject()); }));
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
  if (connection.message || connection.error) body.createEl("p", {
    text: connection.error || connection.message,
    cls: connection.error ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback",
    attr: { role: "status", "aria-live": "polite" }
  });
}
