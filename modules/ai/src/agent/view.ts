import { Setting, ButtonComponent, destructiveButton } from "../ui";
import { settingsCheckbox } from "../settingsLayout";
import { styleActionButton } from "../../../../src/shared/actionButton";
import { prepareChatMarkdown } from "./markdown";
import { historyGroups } from "./history";
import { bottomOverlap, viewportBottomOverlap } from "./layout";
import { Platform, setIcon, Menu, Component, FuzzySuggestModal, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, Modal } from "obsidian";
import type SimpleAIPlugin from "../main";
import { ModelPopover } from "./modelPopover";
import { label } from "../api/types";
import type { Skill, Session } from "./types";
import { skillsFor } from "./skills";
import { toolLabels } from "./tools";
import { roleNames } from "./cooperation";
import { usageText, usageRecords } from "./usage";
export const CHAT_VIEW = "simple-one-ai-chat";
const pausedTaskMessage = "已暂停，点击恢复继续任务。";

function laterPauseInTurn(session: Session, index: number): boolean {
  for (let next = index + 1; next < session.messages.length; next++) {
    const message = session.messages[next];
    if (message.role === "user" && !message.generated && !message.process) return false;
    if (message.role === "assistant" && !message.process && message.diagnostic && message.text === pausedTaskMessage) return true;
  }
  return false;
}

function createThinkingIcon(parent: HTMLElement): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const brain = document.createElementNS(ns, "path");
  brain.setAttribute("d", "M12 5.1c-1.5-1.9-4.6-1.5-5.1 1.2-2.4-.2-3.5 2.7-2 4.4-1.7 1.8-.9 4.5 1.3 5.3-.1 2.5 2.9 3.8 4.7 2L12 16V5.1Zm0 0c1.5-1.9 4.6-1.5 5.1 1.2 2.4-.2 3.5 2.7 2 4.4 1.7 1.8.9 4.5-1.3 5.3.1 2.5-2.9 3.8-4.7 2L12 16V5.1Z");
  const question = document.createElementNS(ns, "path");
  question.setAttribute("d", "M10.2 9.3a1.9 1.9 0 1 1 3.1 1.5c-.8.6-1.3.9-1.3 1.9m0 2.2v.1");
  icon.append(brain, question);
  parent.appendChild(icon);
  return icon;
}

export class ChatView extends ItemView {
  private unsubscribe?: () => void;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private approval!: HTMLElement;
  private composer!: HTMLTextAreaElement;
  private tokenPreview!: HTMLElement;
  private tokenPreviewKey = "";
  private tokenPreviewVersion = 0;
  private tokenPreviewTimer?: number;
  private header!: HTMLElement;
  private attachments!: HTMLElement;
  private model!: ButtonComponent;
  private modelText!: HTMLElement;
  private modelArrow!: HTMLElement;
  private modelPopover?: ModelPopover;
  private sendButton!: ButtonComponent;
  private links!: HTMLElement;
  private referencesExpanded = false;
  private drawer!: HTMLElement;
  private drawerList!: HTMLElement;
  private drawerSearch!: HTMLInputElement;
  private drawerToggle!: ButtonComponent;
  private drawerTab: "sessions" | "archived" = "sessions";
  private drawerOpen = false;
  private selecting = false;
  private selectedSessions = new Set<string>();
  private selectionBar!: HTMLElement;
  private selectionFooter!: HTMLElement;
  private searchVersion = 0;
  private searchTimer?: number;
  private cleanupLayout?: () => void;
  private shownId = "";
  private rendered = "";
  private lastRenderedSession = "";
  private scrollToLatest?: ButtonComponent;
  private renderedCount = 0;
  private renderedMessages?: Session["messages"];
  private visibleLimit = 80;
  private messageComponents: Component[] = [];
  private toolResults = new Map<string, { summary: HTMLElement; content: HTMLElement; name: string }>();
  private processes = new Map<string, { details: HTMLElement; requests: HTMLElement }>();
  private pendingCard?: { row: HTMLElement; label: HTMLElement; status: HTMLElement; text: HTMLElement; value: string; version: number; owner?: Component };
  private timer?: number;
  constructor(leaf: WorkspaceLeaf, private plugin: SimpleAIPlugin) { super(leaf); }
  getViewType(): string { return CHAT_VIEW; }
  getDisplayText(): string { return "AI"; }
  getIcon(): string { return "bot"; }
  async onOpen(): Promise<void> {
    const el = this.contentEl; el.empty(); el.addClass("simple-ai-chat");
    const top = el.createDiv("simple-ai-topbar");
    this.drawerToggle = this.iconButton(top, "panel-left", "展开会话列表", () => this.toggleDrawer());
    this.drawerToggle.buttonEl.setAttribute("aria-expanded", "false");
    this.header = top.createDiv({ text: "新会话", cls: "simple-ai-chat-header" });
    this.iconButton(top, "link", "关联当前焦点笔记", () => { void this.perform(async () => {
      const active = this.app.workspace.getActiveFile();
      const path = active?.extension === "md" ? active.path : this.plugin.lastFocusedNote;
      if (!path) throw new Error("请先打开要关联的笔记，再点击链条图标。");
      await this.plugin.runtime.bindNote(this.plugin.runtime.active, path);
    }); });
    this.iconButton(top, "message-circle-plus", "开启新对话", () => this.newChat());
    this.buildDrawer();
    this.body = el.createDiv("simple-ai-messages"); this.body.setAttribute("aria-live", "polite");
    this.scrollToLatest = new ButtonComponent(el).setIcon("arrow-down").setTooltip("回到底部").onClick(() => {
      this.body.scrollTo({ top: this.body.scrollHeight, behavior: "smooth" });
    });
    this.scrollToLatest.buttonEl.addClass("simple-ai-scroll-to-latest");
    this.scrollToLatest.buttonEl.setAttribute("aria-label", "回到底部");
    this.scrollToLatest.buttonEl.hidden = true;
    this.registerDomEvent(this.body, "scroll", () => this.updateScrollToLatest());
    const scrollLayout = new ResizeObserver(() => this.updateScrollToLatest());
    scrollLayout.observe(this.body);
    this.register(() => scrollLayout.disconnect());
    this.status = el.createDiv("simple-ai-chat-status");
    this.approval = el.createDiv("simple-ai-chat-actions");
    this.links = el.createDiv("simple-ai-bound-notes");
    this.attachments = el.createDiv("simple-ai-attachments");
    const compose = el.createDiv("simple-ai-compose");
    this.tokenPreview = compose.createDiv("simple-ai-token-preview");
    this.tokenPreview.setAttribute("aria-live", "polite");
    this.tokenPreview.setAttribute("aria-label", "本地粗估下一次主 agent请求的输入，包含当前有效历史、规则及附件文本；不含工具定义，未解析图片也未计入。不同模型的分词和缓存计费可能不同。");
    this.composer = compose.createEl("textarea", { placeholder: "发消息，或添加截图整理笔记……", attr: { "aria-label": "消息输入" } });
    this.setupComposerResize(compose);
    this.composer.onfocus = () => this.scheduleTokenPreview();
    this.composer.onblur = () => this.scheduleTokenPreview();
    this.composer.oninput = () => { this.plugin.runtime.active.draft = this.composer.value; this.refresh(); if (this.timer) window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.persist(); }, 400); };
    this.composer.onkeydown = e => {
      if (e.key !== "Enter" || e.isComposing || e.keyCode === 229 || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const shortcut = this.plugin.settings.sendShortcut ?? "off";
      if (shortcut === "enter" && !e.shiftKey || shortcut === "shift-enter" && e.shiftKey) {
        e.preventDefault();
        if (!this.plugin.runtime.busy) void this.send();
      }
    };
    this.composer.onpaste = e => { const files = Array.from(e.clipboardData?.files ?? []); if (files.some(f => f.type.startsWith("image/"))) { e.preventDefault(); void this.addImages(files); } };
    const bottom = compose.createDiv("simple-ai-compose-toolbar");
    const picker = compose.createEl("input", { type: "file", attr: { accept: "image/png,image/jpeg,image/webp,image/gif", multiple: "", "aria-label": "插入照片" } }); picker.hidden = true;
    picker.onchange = () => { void this.addImages(Array.from(picker.files ?? [])); picker.value = ""; };
    const files = compose.createEl("input", { type: "file", attr: { accept: ".md,.txt,.csv,.json,.canvas,.base", multiple: "", "aria-label": "插入文本文件" } }); files.hidden = true;
    files.onchange = () => { void this.addTextFiles(Array.from(files.files ?? [])); files.value = ""; };
    const add = this.iconButton(bottom, "plus", "插入与会话功能", () => {});
    add.buttonEl.addClass("simple-ai-compose-add");
    add.onClick(event => {
      this.modelPopover?.close();
      this.showMenu(event, () => picker.click(), () => files.click());
    });
    this.model = new ButtonComponent(bottom).onClick(() => {
      if (this.modelPopover) { this.modelPopover.close(); return; }
      if (this.plugin.runtime.busy) { new Notice("请先停止当前任务，再切换模型或审批。"); return; }
      this.model.buttonEl.setAttribute("aria-expanded", "true");
      this.modelPopover = new ModelPopover(this.plugin, this.contentEl, this.model.buttonEl, this.plugin.runtime.active, () => this.refresh(), () => { this.modelPopover = undefined; this.model.buttonEl.setAttribute("aria-expanded", "false"); });
    });
    this.model.buttonEl.addClass("simple-ai-model-button"); this.model.buttonEl.setAttribute("aria-haspopup", "dialog"); this.model.buttonEl.setAttribute("aria-expanded", "false");
    this.modelText = this.model.buttonEl.createSpan("simple-ai-model-label");
    this.modelArrow = this.model.buttonEl.createSpan("simple-ai-model-arrow"); setIcon(this.modelArrow, "chevron-down");
    this.sendButton = this.iconButton(bottom, "arrow-up", "发送消息", () => { if (this.plugin.runtime.busy) this.plugin.runtime.stop(); else void this.send(); });
    this.sendButton.buttonEl.addClass("simple-ai-send-button");
    this.setupBottomSpace();
    this.registerEvent(this.app.vault.on("modify", () => { this.tokenPreviewKey = ""; this.scheduleTokenPreview(); }));
    this.unsubscribe = this.plugin.runtime.subscribe(() => this.refresh()); this.refresh();
  }
  private async persist(): Promise<void> { try { await this.plugin.runtime.save(); } catch { new Notice("会话保存失败，请检查存储。"); } }
  private async perform(fn: () => Promise<void>): Promise<void> { try { await fn(); } catch (e) { new Notice(e instanceof Error ? e.message : "操作失败。"); } }
  private async send(): Promise<void> {
    const r = this.plugin.runtime, s = r.active;
    const resume = s.status === "interrupted" && !this.composer.value.trim() && !s.images.length && !s.files?.length && !s.draftSkills?.length;
    await this.perform(() => r.send(s, this.composer.value, resume));
  }
  private async addImages(files: File[]): Promise<void> {
    const s = this.plugin.runtime.active;
    await this.perform(async () => {
      for (const file of files) {
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw new Error("支持 PNG、JPEG、WebP、GIF 图片。");
        if (file.size > 4 * 1024 * 1024 || s.images.length >= 4) throw new Error("每次最多4张图片，每张最多4MB。请压缩后添加。");
        const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = () => reject(new Error("图片读取失败")); r.readAsDataURL(file); });
        s.images.push({ name: file.name, mime: file.type, data, addedAt: Date.now() });
      }
      await this.persist(); this.refresh();
    });
  }
  private async addTextFiles(files: File[]): Promise<void> {
    const session = this.plugin.runtime.active;
    await this.perform(async () => {
      const additions = [];
      for (const file of files) {
        if (!/\.(md|txt|csv|json|canvas|base)$/i.test(file.name)) throw new Error("文件支持 Markdown、TXT、CSV、JSON、Canvas 和 Bases 文本。");
        if (file.size > 256 * 1024 || (session.files?.length ?? 0) + additions.length >= 4) throw new Error("每次最多4份文本文件，每份不超过256KB。");
        const text = await file.text();
        if (text.includes("\0") || text.includes("\ufffd")) throw new Error("无法识别文件编码，请使用 UTF-8 文本文件。");
        additions.push({ name: file.name, text, addedAt: Date.now() });
      }
      if ([...(session.files ?? []), ...additions].reduce((total, file) => total + file.text.length, 0) > 60000) throw new Error("附加文件合计最多60000字符，请拆分发送。");
      session.files = [...(session.files ?? []), ...additions]; await this.persist(); this.refresh();
    });
  }
  private refresh(): void {
    const r = this.plugin.runtime, s = r.active; if (!s || !this.body) return;
    this.scheduleTokenPreview();
    if (this.shownId !== s.id || r.busy) this.modelPopover?.close();
    this.header.setText(s.title); this.header.setAttribute("aria-label", s.title);
    const resume = s.status === "interrupted" && !s.draft.trim() && !s.images.length && !s.files?.length && !s.draftSkills?.length;
    const sendLabel = r.busy ? "暂停任务" : resume ? "恢复任务" : "发送消息";
    this.sendButton.setIcon(r.busy ? "square" : resume ? "play" : "arrow-up").setTooltip(sendLabel);
    this.sendButton.buttonEl.setAttribute("aria-label", sendLabel);
    if (this.shownId !== s.id) this.referencesExpanded = false;
    this.links.empty();
    const references = s.references ?? [];
    let referenceList = this.links;
    if (references.length > 1) {
      const details = this.links.createEl("details", { cls: "simple-ai-reference-picker" }); details.open = this.referencesExpanded;
      details.ontoggle = () => { this.referencesExpanded = details.open; };
      const summary = details.createEl("summary", { attr: { "aria-label": "查看关联的 " + references.length + " 篇笔记" } });
      setIcon(summary.createSpan("simple-ai-reference-icon"), "paperclip");
      summary.createSpan({ text: references[0].split("/").pop()!.replace(/\.md$/i, ""), cls: "simple-ai-reference-name" });
      summary.createSpan({ text: "共 " + references.length + " 篇", cls: "simple-ai-reference-count" });
      setIcon(summary.createSpan("simple-ai-reference-icon"), "chevron-down");
      referenceList = details.createDiv("simple-ai-reference-list-popover");
    }
    for (const path of references) {
      const chip = referenceList.createDiv("simple-ai-note-chip");
      setIcon(chip.createSpan("simple-ai-reference-icon"), "file-text");
      const open = new ButtonComponent(chip).setButtonText(path.split("/").pop()!.replace(/\.md$/i, "")).setTooltip(path).onClick(() => { void this.app.workspace.openLinkText(path, "", false); });
      open.buttonEl.addClass("simple-ai-note-name");
      this.iconButton(chip, "x", "取消关联：" + path, () => { if (r.busy) { new Notice("请等待当前任务完成后再取消关联。"); return; } s.references = s.references?.filter(p => p !== path); void this.persist(); r.changed(); });
    }
    if (this.drawerOpen) void this.renderDrawer();
    if (this.shownId !== s.id || !s.draft && !this.composer.matches(":focus")) { this.composer.value = s.draft; this.shownId = s.id; }
    if (s.status === "running" && !s.draft) this.composer.value = "";
    const lastDiagnostic = [...s.messages].reverse().find(m => !m.process && m.role === "assistant");
    const problemShown = lastDiagnostic?.diagnostic && lastDiagnostic.text === s.problem;
    this.status.setText(r.pendingReply?.sessionId === s.id ? "" : r.activity || (problemShown ? "" : s.problem) || "");
    this.approval.empty();
    const pending = s.changes.filter(c => c.state === "proposed");
    if (pending.length) {
      this.approval.createSpan({ text: `${pending.length} 项修改待确认` });
      new ButtonComponent(this.approval).setButtonText("查看方案").onClick(() => new ChangesModal(this.plugin, s).open());
      new ButtonComponent(this.approval).setButtonText("确认执行").setDisabled(r.busy).onClick(() => { void this.perform(() => r.applyProposals(s, pending.map(c => c.id))); });
      new ButtonComponent(this.approval).setButtonText("放弃方案").setDisabled(r.busy).onClick(() => { void this.perform(async () => { pending.forEach(c => { c.state = "skipped"; }); await r.save(); r.changed(); }); });
    }
    const source = this.plugin.settings.sources.find(x => x.id === (s.selected ?? this.plugin.settings.selected)?.sourceId);
    const model = source?.models.find(m => m.id === (s.selected ?? this.plugin.settings.selected)?.modelId);
    const modelLabel = source && model ? label(source, model, this.plugin.settings.showSourceName && this.plugin.settings.sources.filter(source => source.models.length).length > 1) : "选择模型";
    this.modelText.setText(Array.from(modelLabel).length > 30 ? Array.from(modelLabel).slice(0, 30).join("") + "…" : modelLabel); this.model.setTooltip(modelLabel); this.model.buttonEl.setAttribute("aria-label", "选择模型：" + modelLabel);
    this.attachments.empty();
    s.images.forEach((image, index) => { new ButtonComponent(this.attachments).setButtonText(`${image.name} ×`).setTooltip("移除图片").onClick(() => { s.images.splice(index, 1); void this.persist(); this.refresh(); }); });
    (s.files ?? []).forEach((file, index) => { new ButtonComponent(this.attachments).setButtonText(file.name + " ×").setTooltip("移除文件").onClick(() => { s.files?.splice(index, 1); void this.persist(); this.refresh(); }); });
    const availableSkills = skillsFor(this.plugin.settings.agent);
    for (const id of s.draftSkills ?? []) new ButtonComponent(this.attachments).setButtonText("@" + (availableSkills.find(skill => skill.id === id)?.name ?? id) + " ×").setTooltip("移除本次技能").onClick(() => { s.draftSkills = s.draftSkills?.filter(x => x !== id); void this.persist(); this.refresh(); });
    const reset = this.rendered !== s.id || this.renderedMessages !== s.messages || s.messages.length < this.renderedCount;
    const sessionChanged = this.lastRenderedSession !== s.id;
    const nearBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 100;
    if (reset) {
      this.messageComponents.forEach(c => c.unload()); this.messageComponents = [];
      this.toolResults.clear();
      this.processes.clear();
      this.body.empty(); this.renderedCount = Math.max(0, s.messages.length - this.visibleLimit); this.rendered = s.id;
      this.renderedMessages = s.messages;
      while (this.renderedCount > 0 && s.messages[this.renderedCount]?.role === "tool") this.renderedCount--;
      if (this.renderedCount) {
        const earlier = new ButtonComponent(this.body).setIcon("ellipsis").setTooltip("加载更早消息").onClick(() => { this.visibleLimit += 80; this.rendered = ""; this.refresh(); });
        earlier.buttonEl.addClass("simple-ai-load-earlier");
        earlier.buttonEl.setAttribute("aria-label", "加载更早消息");
      }
    }
    if (!s.messages.length && !this.body.children.length) this.body.createEl("p", { cls: "simple-ai-hint", text: "发截图整理笔记，或说说你想找什么。" });
    if (s.messages.length === this.renderedCount) { this.updateLatestActions(s); this.updateProcesses(s); this.updatePending(s); this.mergeReplyRows(s); return; }
    if (!this.renderedCount && !reset) this.body.empty();
    for (let index = this.renderedCount; index < s.messages.length; index++) {
      const m = s.messages[index];
      if (m.role === "user" && m.generated && m.text === "继续上次任务。先核对已有工具结果，不要重复执行已经完成的修改。") continue;
      if (m.role === "assistant" && !m.process && m.diagnostic && m.text === pausedTaskMessage && laterPauseInTurn(s, index)) continue;
      const taskId = m.execution?.taskId ?? m.taskId ?? "legacy";
      const parent = m.process || m.role === "tool" || m.role === "assistant" && (!m.text && m.calls?.length || m.diagnostic && m.execution) ? this.processFor(taskId) : this.body;
      if (m.role === "tool") {
        const result = m.callId ? this.toolResults.get(`${m.process ? "aux:" + m.delegateCallId : "main"}:${m.callId}`) : undefined;
        if (result) {
          result.summary.setText(result.name + (m.error ? " · 未完成，查看原因" : " · 操作结果")); result.content.setText(m.text);
        } else {
          const row = parent.createDiv("simple-ai-message simple-ai-message-assistant");
          row.createDiv({ text: m.process ? "子 Agent 工具结果" : "工具结果", cls: "simple-ai-message-label" });
          const box = row.createEl("details", { cls: "simple-ai-tool-result" }); box.createEl("summary", { text: m.error ? "操作未完成 · 查看原因" : "操作结果" }); box.createEl("pre", { text: m.text });
        }
        continue;
      }
      const row = parent.createDiv(`simple-ai-message simple-ai-message-${m.role}`);
      if (parent === this.body && m.role === "assistant") {
        row.dataset.taskId = taskId; row.dataset.messageIndex = String(index);
        const previous = Array.from(this.body.querySelectorAll<HTMLElement>(":scope > .simple-ai-message-assistant[data-task-id]")).filter(node => node !== row && node.dataset.taskId === taskId).pop();
        if (previous && taskId !== "legacy") { previous.addClass("simple-ai-reply-has-next"); row.addClass("simple-ai-reply-continuation"); }
      }
      if (m.role === "assistant" && !m.process && parent === this.body) {
        const separator = row.createDiv("simple-ai-reply-separator");
        const duration = new ButtonComponent(separator).setButtonText("用时未记录").onClick(() => {
          const button = duration.buttonEl;
          button.dataset.showMetadata = button.dataset.showMetadata === "true" ? "false" : "true";
          this.renderReplyMetadata(button);
        });
        duration.buttonEl.addClass("simple-ai-reply-duration"); duration.buttonEl.dataset.messageIndex = String(index);
        duration.buttonEl.dataset.taskId = taskId;
      }
      const actor = m.execution;
      if (parent !== this.body && actor) row.dataset.recordId = actor.recordId;
      if (m.role !== "user" || m.process) {
        const heading = row.createDiv("simple-ai-message-label");
        heading.createSpan({ text: m.role === "user" ? "委派要求" : actor ? `${roleNames[actor.role] ?? "历史角色"} · [${actor.sourceName ?? actor.sourceId}] ${actor.modelName ?? actor.modelId}` : "Simple AI" });
        if (actor) heading.setAttribute("aria-label", `API 来源：${actor.sourceName ?? actor.sourceId} · 模型 ID：${actor.modelId}`);
      }
      const owner = new Component(); owner.load(); this.messageComponents.push(owner);
      const text = row.createDiv("simple-ai-message-content");
      if (m.role === "assistant" && !m.process && m.diagnostic && m.text === pausedTaskMessage) {
        text.addClass("simple-ai-resume-message");
        text.dataset.messageIndex = String(index);
        text.setAttribute("role", "button"); text.tabIndex = 0;
        text.setAttribute("aria-label", "恢复任务");
        let resuming = false;
        const resume = () => {
          if (resuming || r.busy || r.active !== s || s.status !== "interrupted" || s.problem !== pausedTaskMessage || text.ownerDocument.getSelection()?.toString()) return;
          resuming = true;
          void this.perform(async () => { try { await r.send(s, "", true); } finally { resuming = false; } });
        };
        text.addEventListener("click", resume);
        text.addEventListener("keydown", event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault(); resume();
        });
      }
      if (m.reasoning) {
        const reasoning = row.createEl("details", { cls: "simple-ai-reasoning" });
        reasoning.hidden = true;
        const summary = reasoning.createEl("summary", { attr: { "aria-label": "展开思考过程" } });
        createThinkingIcon(summary);
        summary.createSpan({ text: "思考完毕" });
        const reasoningText = reasoning.createDiv({ cls: "simple-ai-reasoning-text" });
        void MarkdownRenderer.render(this.app, prepareChatMarkdown(m.reasoning), reasoningText, "", owner).catch(() => reasoningText.setText(m.reasoning ?? ""));
        const closeReasoning = () => {
          reasoning.open = false;
          summary.scrollIntoView({ block: "nearest" });
        };
        let blankPress: { x: number; y: number; at: number } | undefined;
        reasoning.addEventListener("pointerdown", event => {
          blankPress = event.target === reasoning || event.target === reasoningText
            ? { x: event.clientX, y: event.clientY, at: Date.now() } : undefined;
        });
        reasoning.addEventListener("pointercancel", () => { blankPress = undefined; });
        reasoning.addEventListener("click", event => {
          const press = blankPress; blankPress = undefined;
          if (!press || Date.now() - press.at > 350 || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) return;
          if (event.target !== reasoning && event.target !== reasoningText) return;
          if (reasoning.ownerDocument.getSelection()?.toString()) return;
          closeReasoning();
        });
        row.insertBefore(reasoning, text);
      }
      void MarkdownRenderer.render(this.app, prepareChatMarkdown(m.text), text, "", owner).catch(() => text.setText(m.text)).then(() => {
        if (m.role === "user" && !m.process && text.isConnected) this.foldUserMessage(text, owner);
      });
      for (const i of m.images ?? []) new ButtonComponent(row).setButtonText("查看原图 · " + i.name).onClick(() => { void this.perform(async () => { const image = await r.storage.image(i); const modal = new Modal(this.app); modal.titleEl.setText(i.name); modal.contentEl.createEl("img", { attr: { src: `data:${image.mime};base64,${image.data}`, alt: i.name, style: "max-width:100%" } }); modal.open(); }); });
      for (const file of m.files ?? []) row.createDiv({ text: "文件：" + file.name, cls: "simple-ai-hint" });
      if (m.skills?.length) row.createDiv({ text: "指定技能：" + m.skills.join("、"), cls: "simple-ai-hint" });
      for (const c of m.calls ?? []) {
        const name = toolLabels[c.name] ?? c.name;
        const box = (parent === this.body ? this.processFor(taskId) : row).createEl("details", { cls: "simple-ai-tool-result" });
        if (actor) box.dataset.recordId = actor.recordId;
        const summary = box.createEl("summary", { text: name + " · 等待结果" });
        if (c.name === "delegate_task") box.createEl("pre", { text: "委派要求：" + String(c.arguments.task ?? "") });
        else box.createEl("pre", { text: "调用参数：" + JSON.stringify(c.arguments) });
        const content = box.createEl("pre", { text: "工具结果将在这里显示。" });
        this.toolResults.set(`${m.process ? "aux:" + m.delegateCallId : "main"}:${c.id}`, { summary, content, name });
      }
      if (m.process) continue;
      const actions = row.createDiv("simple-ai-message-actions");
      actions.dataset.messageIndex = String(index);
      if (m.role !== "assistant" || parent !== this.body) actions.createEl("time", { text: m.timestamp ? new Date(m.timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", year: "numeric", hour12: false }) : "时间未记录", attr: m.timestamp ? { datetime: new Date(m.timestamp).toISOString() } : {} });
      this.iconButton(actions, "copy", "复制当前消息", () => { void this.perform(async () => { await navigator.clipboard.writeText(m.role === "assistant" && parent === this.body && taskId !== "legacy" ? s.messages.slice(0, index + 1).filter(message => message.role === "assistant" && !message.process && (message.execution?.taskId ?? message.taskId) === taskId).map(message => message.text).filter(Boolean).join("\n\n") : m.text); new Notice("复制成功", 2000); }); });
      if (m.role === "assistant") this.iconButton(actions, "rotate-cw", "重试回复（最新回复在当前对话重试）", () => { void this.perform(() => r.retryMessage(s, index)); });
      else {
        const versions = [...(m.editHistory ?? []), m.text];
        let selectedVersion = versions.length - 1;
        if (versions.length > 1) {
          const navigation = actions.createSpan("simple-ai-message-versions"); actions.prepend(navigation);
          const count = navigation.createSpan();
          const renderVersion = () => {
            count.setText((selectedVersion + 1) + '/' + versions.length);
            text.empty();
            void MarkdownRenderer.render(this.app, prepareChatMarkdown(versions[selectedVersion]), text, "", owner).catch(() => text.setText(versions[selectedVersion]));
            previous.setDisabled(selectedVersion === 0); next.setDisabled(selectedVersion === versions.length - 1);
          };
          const previous = this.iconButton(navigation, "chevron-left", "上一个提问版本", () => { selectedVersion--; renderVersion(); });
          navigation.appendChild(count);
          const next = this.iconButton(navigation, "chevron-right", "下一个提问版本", () => { selectedVersion++; renderVersion(); });
          count.setText(versions.length + '/' + versions.length); next.setDisabled(true);
        }
        this.iconButton(actions, "pencil", "编辑并重新发送", () => {
          if (row.hasClass("simple-ai-message-editing")) return;
          row.addClass("simple-ai-message-editing");
          const input = row.createEl("textarea", { cls: "simple-ai-inline-edit", attr: { "aria-label": "编辑消息内容" } });
          input.value = versions[selectedVersion]; text.after(input);
          const resize = () => { input.setCssStyles({ height: "auto" }); input.style.height = Math.max(72, input.scrollHeight) + "px"; };
          input.addEventListener("input", resize);
          const controls = row.createDiv("simple-ai-inline-edit-actions");
          const cancel = () => { input.remove(); controls.remove(); row.removeClass("simple-ai-message-editing"); };
          this.iconButton(controls, "x", "取消编辑", cancel);
          const confirm = this.iconButton(controls, "check", "确认并重新发送", () => {
            if (!input.value.trim()) { input.focus(); return; }
            const value = input.value;
            confirm.setDisabled(true);
            void this.perform(async () => {
              try { await r.editMessage(s, index, value); }
              finally { if (input.isConnected) confirm.setDisabled(false); }
            });
          });
          input.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); cancel(); } });
          resize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
        });
      }
      this.iconButton(actions, "git-branch", "从这里分支", () => { void this.perform(async () => { await r.fork(s, index); this.composer.focus(); }); });
      if (m.role === "assistant" && parent === this.body) {
        this.processFor(taskId);
        const details = this.iconButton(actions, "info", "调用详情", () => this.showProcess(taskId, index));
        details.buttonEl.addClass("simple-ai-call-details");
        details.buttonEl.setAttribute("aria-haspopup", "dialog");
      }
    }
    this.renderedCount = s.messages.length;
    this.updateLatestActions(s);
    this.updateProcesses(s);
    this.updatePending(s);
    this.mergeReplyRows(s);
    if (nearBottom || sessionChanged) window.requestAnimationFrame(() => { if (this.plugin.runtime.active === s) this.body.scrollTop = this.body.scrollHeight; });
    this.lastRenderedSession = s.id;
    this.updateScrollToLatest();
  }
  private updateScrollToLatest(): void {
    if (!this.scrollToLatest || !this.body) return;
    const gap = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight;
    const chatRect = this.contentEl.getBoundingClientRect(), messagesRect = this.body.getBoundingClientRect();
    this.scrollToLatest.buttonEl.style.bottom = `${Math.max(0, chatRect.bottom - messagesRect.bottom) + 12}px`;
    this.scrollToLatest.buttonEl.hidden = this.body.scrollHeight <= this.body.clientHeight + 80 || gap <= 140;
  }
  private mergeReplyRows(session: Session): void {
    const groups = new Map<number, HTMLElement>();
    for (const row of Array.from(this.body.querySelectorAll<HTMLElement>(":scope > .simple-ai-message-assistant[data-message-index]"))) {
      const index = Number(row.dataset.messageIndex);
      let start = index;
      while (start > 0 && !(session.messages[start].role === "user" && !session.messages[start].generated && !session.messages[start].process)) start--;
      const first = groups.get(start);
      if (!first) { groups.set(start, row); continue; }
      const separator = first.querySelector<HTMLElement>(":scope > .simple-ai-reply-separator");
      const button = separator?.querySelector<HTMLElement>("button");
      if (button) { button.dataset.messageIndex = String(index); button.dataset.taskId = row.dataset.taskId; }
      first.querySelector(":scope > .simple-ai-message-actions")?.remove();
      for (const node of Array.from(row.children)) if (!node.matches(".simple-ai-reply-separator, .simple-ai-message-label")) first.appendChild(node);
      first.dataset.messageIndex = String(index); first.removeClass("simple-ai-reply-has-next"); row.remove();
    }
    for (const row of groups.values()) {
      const prompts = Array.from(row.querySelectorAll<HTMLElement>(":scope > .simple-ai-resume-message"));
      for (const duplicate of prompts.slice(0, -1)) duplicate.remove();
      const prompt = prompts[prompts.length - 1];
      if (prompt) {
        const index = Number(prompt.dataset.messageIndex);
        const laterQuestion = session.messages.slice(index + 1).some(message => message.role === "user" && !message.generated && !message.process);
        const enabled = session.status === "interrupted" && session.problem === pausedTaskMessage && !this.plugin.runtime.busy && !laterQuestion;
        prompt.setAttribute("aria-disabled", String(!enabled)); prompt.tabIndex = enabled ? 0 : -1;
      }
      const separator = row.querySelector<HTMLElement>(":scope > .simple-ai-reply-separator");
      if (!separator) continue;
      let metadata = row.querySelector<HTMLElement>(":scope > .simple-ai-reply-metadata");
      if (!metadata) { metadata = createDiv(); metadata.className = "simple-ai-reply-metadata"; separator.after(metadata); }
      const index = Number(row.dataset.messageIndex); let start = index;
      while (start > 0 && !(session.messages[start].role === "user" && !session.messages[start].generated && !session.messages[start].process)) start--;
      const messages = session.messages.slice(start, index + 1);
      const ids = new Set(messages.map(m => m.execution?.recordId).filter(Boolean));
      const models = [...new Set(messages.filter(m => m.execution && !m.process).map(m => '[' + (m.execution!.sourceName ?? m.execution!.sourceId) + '] ' + (m.execution!.modelName ?? m.execution!.modelId)))];
      metadata.setText((session.messages[index].timestamp ? new Date(session.messages[index].timestamp).toLocaleString("zh-CN", { hour12: false }) : "时间未记录") + ' · ' + ids.size + ' 次调用' + (models.length ? '\n' + models.join('\n') : ''));
      const duration = separator.querySelector<HTMLElement>("button");
      if (duration) {
        const begin = session.messages[start].timestamp, end = session.messages[index].timestamp;
        if (begin && end) duration.dataset.duration = '用时 ' + Math.floor((end - begin) / 1000) + ' 秒';
        this.renderReplyMetadata(duration);
      }
    }
  }
  private scheduleTokenPreview(): void {
    const r = this.plugin.runtime, s = r.active;
    if (!s || !this.tokenPreview) return;
    const editing = s.draft.length > 0 || this.composer.ownerDocument.activeElement === this.composer;
    this.tokenPreview.hidden = editing;
    if (editing) {
      this.tokenPreviewKey = ""; this.tokenPreviewVersion++;
      if (this.tokenPreviewTimer) { window.clearTimeout(this.tokenPreviewTimer); this.tokenPreviewTimer = undefined; }
      return;
    }
    const key = JSON.stringify([r.busy, s.id, s.revision, s.status, s.contextStart, s.summary, s.draft, s.images.map(i => [i.id, i.name, i.summary]), s.files?.map(f => [f.name, f.text.length]), s.draftSkills, s.references, s.folders, s.permission, s.selected, this.plugin.settings.selected, this.plugin.settings.sources.map(source => [source.id, source.protocol, source.models.map(model => model.id)]), this.plugin.settings.agent]);
    if (key === this.tokenPreviewKey) return;
    this.tokenPreviewKey = key;
    const version = ++this.tokenPreviewVersion;
    if (this.tokenPreviewTimer) window.clearTimeout(this.tokenPreviewTimer);
    if (r.busy) { this.tokenPreview.setText("下次输入：任务结束后更新"); return; }
    this.tokenPreview.setText("正在估算下次输入…");
    this.tokenPreviewTimer = window.setTimeout(() => {
      this.tokenPreviewTimer = undefined;
      void r.estimateNextInput(s).then(result => {
        if (version !== this.tokenPreviewVersion || r.active !== s || r.busy) return;
        this.tokenPreview.setText(`下次输入约 ${result.tokens.toLocaleString("zh-CN")} Token${result.pendingImages ? " · 图片待解析" : ""}`);
      }).catch(() => {
        if (version === this.tokenPreviewVersion) this.tokenPreview.setText("输入 token 暂无法估算，请检查模型与参考配置");
      });
    }, 300);
  }
  private updatePending(s: Session): void {
    const r = this.plugin.runtime, pending = r.pendingReply;
    if (!pending || pending.sessionId !== s.id || s.status !== "running") {
      this.pendingCard?.owner?.unload(); this.pendingCard?.row.remove(); this.pendingCard = undefined;
      const last = Array.from(this.body.querySelectorAll<HTMLElement>(":scope > .simple-ai-message-assistant[data-task-id]")).pop();
      last?.removeClass("simple-ai-reply-has-next"); return;
    }
    const nearBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 100;
    if (!this.pendingCard?.row.isConnected) {
      this.pendingCard?.owner?.unload();
      const row = this.body.createDiv("simple-ai-message simple-ai-message-assistant simple-ai-pending-reply");
      row.setAttribute("aria-busy", "true");
      row.createDiv("simple-ai-reply-separator").createSpan({ text: "正在回复", cls: "simple-ai-hint" });
      const label = row.createDiv("simple-ai-message-label");
      const status = row.createDiv("simple-ai-reply-status"); status.setAttribute("role", "status");
      const marker = status.createSpan({ cls: "simple-ai-thinking-marker" });
      createThinkingIcon(marker);
      status.createSpan({ text: "正在思考" });
      const dots = status.createSpan({ cls: "simple-ai-thinking-dots", attr: { "aria-hidden": "true" } });
      for (let i = 0; i < 3; i++) dots.createSpan({ text: "." });
      const text = row.createDiv("simple-ai-message-content");
      this.pendingCard = { row, label, status, text, value: "", version: 0 };
    }
    const card = this.pendingCard, message = pending.message, actor = message.execution!;
    const prior = Array.from(this.body.querySelectorAll<HTMLElement>(":scope > .simple-ai-message-assistant[data-task-id]")).filter(row => row.dataset.taskId === actor.taskId).pop();
    card.row.classList.toggle("simple-ai-reply-continuation", !!prior);
    if (prior) prior.addClass("simple-ai-reply-has-next");
    card.label.setText(`${roleNames[actor.role]} · [${actor.sourceName ?? actor.sourceId}] ${actor.modelName ?? actor.modelId}`);
    card.status.hidden = !!message.text;
    card.status.setAttribute("aria-label", r.activity);
    card.text.hidden = !message.text;
    if (card.value !== message.text) {
      card.value = message.text;
      const value = message.text, version = ++card.version;
      const owner = new Component(); owner.load();
      const rendered = createDiv();
      void MarkdownRenderer.render(this.app, prepareChatMarkdown(value), rendered, "", owner).catch(() => rendered.setText(value)).then(() => {
        if (this.pendingCard !== card || !card.row.isConnected || version !== card.version) { owner.unload(); return; }
        card.owner?.unload(); card.owner = owner;
        card.text.replaceChildren(...Array.from(rendered.childNodes));
        if (nearBottom) this.body.scrollTop = this.body.scrollHeight;
      });
    }
    // Keep this live card after newly appended work records and tool results.
    if (this.body.lastElementChild !== card.row) this.body.appendChild(card.row);
    if (nearBottom) this.body.scrollTop = this.body.scrollHeight;
  }
  private setupComposerResize(compose: HTMLElement): void {
    const edge = compose.createDiv({ cls: "simple-ai-compose-resize", attr: { role: "separator", tabindex: "0", "aria-label": "拖动顶部边缘调整输入区高度", "aria-orientation": "horizontal" } });
    const scrollPosition = () => ({ bottom: this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight <= 2, top: this.body.scrollTop });
    let drag: { id: number; y: number; height: number; scroll: ReturnType<typeof scrollPosition> } | undefined;
    const resize = (height: number) => {
      const scroll = drag?.scroll ?? scrollPosition();
      const min = parseFloat(getComputedStyle(this.composer).minHeight) || 62;
      const max = Math.max(min, this.contentEl.clientHeight * 0.65 - 36);
      const value = Math.round(Math.max(min, Math.min(max, height)));
      this.composer.style.height = `${value}px`;
      this.body.scrollTop = scroll.bottom ? this.body.scrollHeight - this.body.clientHeight : scroll.top;
      edge.setAttribute("aria-valuemin", String(min)); edge.setAttribute("aria-valuemax", String(Math.round(max)));
      edge.setAttribute("aria-valuenow", String(value));
    };
    this.registerDomEvent(edge, "pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      drag = { id: event.pointerId, y: event.clientY, height: this.composer.getBoundingClientRect().height, scroll: scrollPosition() };
      edge.setPointerCapture(event.pointerId); edge.addClass("is-dragging");
    });
    this.registerDomEvent(edge, "pointermove", event => {
      if (drag?.id === event.pointerId) resize(drag.height + drag.y - event.clientY);
    });
    const finish = () => { drag = undefined; edge.removeClass("is-dragging"); };
    this.registerDomEvent(edge, "pointerup", finish);
    this.registerDomEvent(edge, "pointercancel", finish);
    this.registerDomEvent(edge, "lostpointercapture", finish);
    this.registerDomEvent(edge, "keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault(); resize(this.composer.getBoundingClientRect().height + (event.key === "ArrowUp" ? 20 : -20));
    });
  }
  private foldUserMessage(text: HTMLElement, owner: Component): void {
    let expanded = false;
    let collapsible = false;
    const more = createEl("button");
    more.type = "button"; more.className = "simple-ai-message-show-more"; more.hidden = true;
    styleActionButton(more, "text");
    const actions = text.parentElement?.querySelector<HTMLElement>(":scope > .simple-ai-message-actions");
    if (actions) actions.prepend(more);
    else text.after(more);
    const update = () => {
      if (!text.isConnected || !text.clientWidth) return;
      const style = getComputedStyle(text);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
      const limit = Math.ceil(lineHeight * 5);
      text.style.setProperty("--simple-ai-message-preview-height", `${limit}px`);
      collapsible = text.scrollHeight > limit + 1;
      text.classList.toggle("simple-ai-message-foldable", collapsible);
      text.classList.toggle("simple-ai-message-collapsed", collapsible && !expanded);
      more.hidden = !collapsible;
      more.textContent = expanded ? "收起 ↑" : "显示更多 ↓";
      more.setAttribute("aria-expanded", String(expanded));
      if (collapsible) {
        text.tabIndex = 0; text.setAttribute("role", "button");
        text.setAttribute("aria-expanded", String(expanded));
        text.setAttribute("aria-label", expanded ? "点击收起消息" : "点击展开消息");
      } else {
        text.removeAttribute("tabindex"); text.removeAttribute("role");
        text.removeAttribute("aria-expanded"); text.removeAttribute("title");
      }
    };
    const toggle = (event: MouseEvent | KeyboardEvent) => {
      if (!collapsible || (event.target instanceof Element && event.target.closest("a, button, input, textarea, select, summary"))) return;
      if (event instanceof KeyboardEvent && (event.target !== text || !["Enter", " "].includes(event.key))) return;
      if (window.getSelection()?.isCollapsed === false) return;
      if (event instanceof KeyboardEvent) event.preventDefault();
      expanded = !expanded; update();
    };
    const toggleMore = () => { expanded = !expanded; update(); };
    more.addEventListener("click", toggleMore);
    text.addEventListener("click", toggle); text.addEventListener("keydown", toggle);
    const observer = new ResizeObserver(update); observer.observe(text);
    owner.register(() => { observer.disconnect(); more.removeEventListener("click", toggleMore); more.remove(); text.removeEventListener("click", toggle); text.removeEventListener("keydown", toggle); });
    update();
  }
  private processFor(taskId: string): HTMLElement {
    let process = this.processes.get(taskId);
    if (!process) {
      // Keep work records off the transcript; the details icon opens them.
      const details = createDiv(); details.className = "simple-ai-work-process";
      const requests = details.createDiv("simple-ai-work-requests");
      process = { details, requests }; this.processes.set(taskId, process);
    }
    return process.details;
  }
  private updateProcesses(session: Session): void {
    for (const [taskId, process] of this.processes) {
      const records = this.plugin.cooperation.taskRecords(taskId).filter(r => r.role === "main" || r.role === "auxiliary");
      const chat = session.messages.filter(m => (m.execution?.taskId ?? m.taskId ?? "legacy") === taskId);
      const calls = new Set([...records.map(r => r.id), ...chat.filter(m => m.role === "assistant" && m.execution).map(m => m.execution!.recordId)]);
      for (const button of Array.from(this.body.querySelectorAll<HTMLElement>(".simple-ai-reply-duration"))) {
        if (button.dataset.taskId !== taskId) continue;
        const index = Number(button.dataset.messageIndex), message = session.messages[index];
        const sameTask = taskId === "legacy" ? [message] : session.messages.slice(0, index + 1).filter(m => (m.execution?.taskId ?? m.taskId ?? "legacy") === taskId);
        const starts = sameTask.flatMap(m => m.role === "user" && m.timestamp ? [m.timestamp] : m.execution?.started !== undefined ? [m.execution.started] : []);
        const ended = message?.execution?.ended ?? message?.timestamp;
        const started = starts.length ? Math.min(...starts) : undefined;
        const seconds = ended !== undefined && started !== undefined && ended >= started ? Math.floor((ended - started) / 1000) : undefined;
        button.dataset.duration = seconds === undefined ? "用时未记录" : `用时 ${seconds >= 60 ? Math.floor(seconds / 60) + " 分 " + seconds % 60 + " 秒" : seconds + " 秒"}`;
        const date = message?.timestamp ? new Date(message.timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", year: "numeric", hour12: false }) : "时间未记录";
        button.dataset.metadata = `${date} · ${calls.size} 次调用`;
        this.renderReplyMetadata(button);
      }
      const operations = Array.from(process.details.querySelectorAll<HTMLElement>("[data-record-id]"))
        .filter(node => !node.parentElement?.closest("[data-record-id]"));
      const expanded = new Set(Array.from(process.requests.querySelectorAll<HTMLDetailsElement>(".simple-ai-request[open]"), node => node.dataset.requestId));
      for (const node of operations) node.remove();
      process.requests.empty();
      const requestRecords = usageRecords(records, [session], session.id).filter(record => record.taskId === taskId && (record.role === "main" || record.role === "auxiliary"));
      for (const record of requestRecords) {
        const seconds = record.ended === undefined ? record.state === "running" ? "执行中" : "耗时未记录" : ((record.ended - record.started) / 1000).toFixed(1) + " 秒";
        const entry = process.requests.createEl("details", { cls: "simple-ai-request" });
        entry.dataset.requestId = record.id; entry.open = expanded.has(record.id);
        const summary = entry.createEl("summary");
        summary.createSpan({ cls: "simple-ai-request-model", text: `${roleNames[record.role]} · [${record.sourceName}] ${record.modelId}` });
        summary.createSpan({ cls: "simple-ai-request-usage", text: usageText(record.usage) });
        summary.createSpan({ cls: "simple-ai-request-time", text: `${new Date(record.started).toLocaleTimeString("zh-CN", { hour12: false })} · ${seconds}` });
        const content = entry.createDiv("simple-ai-request-content");
        if (record.error) content.createDiv({ text: record.error, cls: "simple-ai-hint" });
        for (const node of operations.filter(node => node.dataset.recordId === record.id)) content.appendChild(node);
        const message = chat.find(message => message.role === "assistant" && message.execution?.recordId === record.id);
        if (!content.children.length) {
          if (message?.reasoning) {
            const reasoning = content.createEl("details"); reasoning.createEl("summary", { text: "思考过程" }); reasoning.createEl("pre", { text: message.reasoning });
          }
          content.createEl("pre", { text: message?.text || record.output || (record.state === "running" ? "正在等待回复…" : "此调用没有记录操作内容。") });
        }
      }
      const unmatched = operations.filter(node => !requestRecords.some(record => record.id === node.dataset.recordId));
      unmatched.push(...Array.from(process.details.children).filter((node): node is HTMLElement => node.instanceOf(HTMLElement) && node !== process.requests));
      if (unmatched.length) {
        const legacy = process.requests.createEl("details", { cls: "simple-ai-request" });
        legacy.createEl("summary", { text: "其他操作记录" });
        for (const node of unmatched) legacy.appendChild(node);
      }
    }
  }
  private renderReplyMetadata(button: HTMLElement): void {
    const showMetadata = button.dataset.showMetadata === "true";
    button.replaceChildren();
    createThinkingIcon(button);
    button.createSpan({ text: `思考完毕 · ${button.dataset.duration ?? "用时未记录"}${showMetadata ? " ⌄" : " ›"}` });
    const message = button.closest<HTMLElement>(".simple-ai-message");
    const metadata = message?.querySelector<HTMLElement>(":scope > .simple-ai-reply-metadata");
    if (metadata) metadata.hidden = !showMetadata;
    message?.querySelectorAll<HTMLDetailsElement>(":scope > .simple-ai-reasoning").forEach(reasoning => {
      reasoning.hidden = !showMetadata;
      reasoning.open = showMetadata;
      reasoning.querySelector("summary")?.setAttribute("aria-label", showMetadata ? "收起思考过程" : "展开思考过程");
    });
    button.setAttribute("aria-expanded", String(showMetadata));
    button.setAttribute("aria-label", showMetadata ? "收起思考过程和调用信息" : "展开思考过程和调用信息");
  }
  private showProcess(_taskId: string, index: number): void { this.showUsage(index); }
  private iconButton(el: HTMLElement, icon: string, label: string, action: () => void): ButtonComponent {
    const button = new ButtonComponent(el).setIcon(icon).setTooltip(label).onClick(action);
    button.buttonEl.addClass("simple-ai-icon-button"); button.buttonEl.setAttribute("aria-label", label); return button;
  }
  private newChat(): void { this.plugin.runtime.create(); this.toggleDrawer(false); void this.persist(); this.composer.focus(); }
  private showUsage(index?: number): void {
    const modal = new Modal(this.app); modal.titleEl.setText("使用详情");
    modal.modalEl.addClass("simple-ai-config-modal");
    const session = this.plugin.runtime.active;
    let start = 0;
    if (index !== undefined) { start = index; while (start > 0 && !(session.messages[start].role === "user" && !session.messages[start].generated && !session.messages[start].process)) start--; }
    const messages = index === undefined ? session.messages : session.messages.slice(start, index + 1);
    const from = index === undefined ? -Infinity : session.messages[start]?.timestamp ?? 0;
    const until = index === undefined ? Infinity : session.messages[index]?.execution?.ended ?? session.messages[index]?.timestamp ?? Infinity;
    const records = usageRecords([...(this.plugin.cooperation.state.traffic ?? []), ...this.plugin.cooperation.state.records], [session], session.id).filter(record => record.started >= from && record.started <= until);
    new Setting(modal.contentEl).setName(index === undefined ? "当前对话" : "当前回复").addButton(button => button.setButtonText("导出记录").onClick(() => {
      void this.perform(async () => {
        const secrets = this.plugin.settings.sources.flatMap(source => this.plugin.getKeys(source.id).map(key => key.value)).filter(Boolean);
        const scrub = (value: string) => secrets.reduce((text, secret) => text.split(secret).join("[密钥已隐藏]"), value);
        const payload = { format: "simple-ai-diagnostics", version: 1, exportedAt: new Date().toISOString(), scope: index === undefined ? "conversation" : "reply", session: { id: session.id, title: session.title, parent: session.parent }, messages, records,
          configuration: { selected: session.selected ?? this.plugin.settings.selected, auxiliary: this.plugin.settings.agent.cooperation.auxiliary, examiner: this.plugin.settings.agent.cooperation.examiner, autoCompactTokens: this.plugin.settings.agent.autoCompactTokens } };
        const json = JSON.stringify(payload, (key, value) => key === "data" ? undefined : typeof value === "string" ? scrub(value) : value, 2);
        const directory = "999 attachment/Simple AI 日志";
        for (const folder of ["999 attachment", directory]) if (!await this.app.vault.adapter.exists(folder)) await this.app.vault.createFolder(folder);
        const path = directory + '/' + 'simple-ai-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8) + '.json';
        await this.app.vault.create(path, json);
        new Notice("调用记录已导出：" + path, 10000);
      });
    }));
    const total = (items: typeof records) => usageText({ inputTokens: items.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0), outputTokens: items.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0), cacheReadTokens: items.reduce((n, r) => n + (r.usage?.cacheReadTokens ?? 0), 0) });
    const totals = modal.contentEl.createEl("details", { cls: "simple-ai-request" });
    const summary = totals.createEl("summary", { text: (index === undefined ? "本对话总用量 · " : "本轮用量 · ") + records.length + " 次调用" });
    summary.createSpan({ text: total(records), cls: "simple-ai-request-usage" });
    const models = new Map<string, typeof records>();
    for (const record of records) { const key = JSON.stringify([record.sourceId, record.modelId]); const items = models.get(key) ?? []; items.push(record); models.set(key, items); }
    for (const items of models.values()) totals.createDiv({ text: '[' + items[0].sourceName + '] ' + items[0].modelId + ' · ' + total(items), cls: "simple-ai-hint" });
    for (const record of records) {
      const entry = modal.contentEl.createEl("details", { cls: "simple-ai-request" });
      const heading = entry.createEl("summary");
      heading.createSpan({ cls: "simple-ai-request-model", text: roleNames[record.role] + ' · [' + record.sourceName + '] ' + record.modelId });
      heading.createSpan({ cls: "simple-ai-request-usage", text: usageText(record.usage) });
      heading.createSpan({ cls: "simple-ai-request-time", text: new Date(record.started).toLocaleString("zh-CN", { hour12: false }) });
      const content = entry.createDiv("simple-ai-request-content");
      const message = session.messages.find(m => m.execution?.recordId === record.id && m.role === "assistant");
      if (record.rules) { const rules = content.createEl("details"); rules.createEl("summary", { text: "系统提示词" }); rules.createEl("pre", { text: record.rules }); }
      if (record.input) { const request = content.createEl("details"); request.createEl("summary", { text: record.truncated ? "请求内容（记录已截断）" : "请求内容" }); request.createEl("pre", { text: record.input }); }
      if (message?.reasoning) { const thinking = content.createEl("details"); thinking.createEl("summary", { text: "思考过程" }); thinking.createEl("pre", { text: message.reasoning }); }
      if (message?.text || record.output || record.error) content.createEl("pre", { text: message?.text || record.output || record.error });
      for (const call of message?.calls ?? []) {
        const tool = content.createEl("details"); tool.createEl("summary", { text: toolLabels[call.name] ?? call.name });
        tool.createEl("pre", { text: "调用参数：" + JSON.stringify(call.arguments) });
        const result = session.messages.find(m => m.role === "tool" && m.callId === call.id);
        tool.createEl("pre", { text: result?.text ?? "未记录结果" });
      }
      if (!content.children.length) content.createDiv({ text: "此调用未保留详细内容。", cls: "simple-ai-hint" });
    }
    modal.open();
  }
  private updateLatestActions(s: Session): void {
    let index = s.messages.length - 1;
    while (index >= 0 && (s.messages[index].role !== "assistant" || s.messages[index].process || s.messages[index].calls?.length || s.messages[index].diagnostic)) index--;
    const actions = this.body.querySelector<HTMLElement>(`.simple-ai-message-actions[data-message-index="${index}"]`);
    const existing = this.body.querySelector(".simple-ai-latest-operations");
    if (actions && existing?.parentElement === actions) return;
    existing?.remove();
    if (!actions) return;
    const operations = actions.createSpan("simple-ai-latest-operations");
    this.iconButton(operations, "scan-text", "操作预览", () => new ChangesModal(this.plugin, s, "preview").open());
    this.iconButton(operations, "list-checks", "操作记录", () => new ChangesModal(this.plugin, s).open());
    this.iconButton(operations, "undo-2", "撤销修改", () => new ChangesModal(this.plugin, s, "undo").open());
  }
  private showMenu(event: MouseEvent, insertPhoto: () => void, insertFile: () => void): void {
    const menu = new Menu().setUseNativeMenu(false);
    (menu as Menu & { dom?: HTMLElement }).dom?.addClass("simple-ai-compose-menu");
    menu.addItem(i => i.setTitle("插入照片").setIcon("image-plus").onClick(insertPhoto));
    menu.addItem(i => i.setTitle("插入文件").setIcon("file-plus").onClick(insertFile));
    menu.addItem(i => i.setTitle("插入技能").setIcon("at-sign").onClick(() => new SkillMentionPicker(this.plugin, this.plugin.runtime.active, () => { void this.persist(); this.refresh(); }).open()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("使用详情").setIcon("chart-no-axes-column").onClick(() => this.showUsage()));
    menu.addItem(i => i.setTitle("压缩上下文").setIcon("minimize-2").onClick(() => { void this.perform(() => this.plugin.runtime.compact(this.plugin.runtime.active)); }));
    menu.addItem(i => i.setTitle("继续上次任务").setIcon("play").onClick(() => { void this.perform(() => this.plugin.runtime.send(this.plugin.runtime.active, "", true)); }));
    menu.addItem(i => i.setTitle("查看当前完整提示词").setIcon("file-search").onClick(() => { void this.perform(async () => {
      const result = await this.plugin.runtime.nextRequestPreview(this.plugin.runtime.active); const modal = new Modal(this.app);
      modal.modalEl.addClass("simple-ai-config-modal", "simple-ai-prompt-preview");
      modal.titleEl.setText("当前完整提示词");
      modal.contentEl.createEl("p", { cls: "simple-ai-hint", text: "下一次主 agent请求预览：包含前置规则、参考正文、有效历史、输入草稿、附件文本和工具定义。仅查看，不发送请求。" });
      if (result.pendingImages) modal.contentEl.createEl("p", { cls: "simple-ai-hint", text: `${result.pendingImages} 张图片尚未解析；发送时会先读取图片，随后将解析结果加入主 Agent提示词。此处以“尚未提取”显示。` });
      const text = JSON.stringify(result.body, null, 2);
      new Setting(modal.contentEl).addButton(button => button.setButtonText("复制完整提示词").onClick(() => { void this.perform(async () => { await navigator.clipboard.writeText(text); new Notice("已复制完整提示词。"); }); }));
      modal.contentEl.createEl("pre", { text }); modal.open();
    }); }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("跳转设置").setIcon("settings").onClick(() => {
      this.toggleDrawer(false);
      this.plugin.openSettings();
    }));
    menu.showAtMouseEvent(event);
  }
  private buildDrawer(): void {
    this.drawer = this.contentEl.createDiv("simple-ai-drawer"); this.drawer.hidden = true;
    this.drawer.setAttribute("role", "region"); this.drawer.setAttribute("aria-label", "会话与笔记列表");
    const heading = this.drawer.createDiv("simple-ai-drawer-heading");
    this.drawerSearch = heading.createEl("input", { type: "search", placeholder: "搜索会话标题或聊天内容", attr: { "aria-label": "搜索会话或笔记" } });
    this.drawerSearch.oninput = () => { this.searchVersion++; if (this.searchTimer) window.clearTimeout(this.searchTimer); this.searchTimer = window.setTimeout(() => { void this.renderDrawer(); }, 250); };
    this.iconButton(heading, "panel-left-close", "收起列表", () => this.toggleDrawer(false));
    const tabs = this.drawer.createDiv("simple-ai-history-tabs");
    for (const [value, text] of [["sessions", "会话历史"], ["archived", "已归档"]] as const) new ButtonComponent(tabs).setButtonText(text).onClick(() => {
      this.selecting = false; this.selectedSessions.clear(); this.drawerTab = value;
      this.drawerSearch.placeholder = "搜索会话标题或聊天内容";
      for (const button of Array.from(tabs.querySelectorAll("button[aria-pressed]"))) button.setAttribute("aria-pressed", String(button.textContent === text));
      void this.renderDrawer();
    }).buttonEl.setAttribute("aria-pressed", String(value === this.drawerTab));
    this.selectionBar = this.drawer.createDiv("simple-ai-selection-bar");
    this.selectionFooter = this.drawer.createDiv("simple-ai-selection-footer");
    this.drawerList = this.drawer.createDiv("simple-ai-drawer-list");
    this.drawer.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); if (this.selecting) { this.selecting = false; this.selectedSessions.clear(); void this.renderDrawer(); } else { this.toggleDrawer(false); this.drawerToggle.buttonEl.focus(); } } });
  }
  private toggleDrawer(open = !this.drawerOpen): void {
    this.drawerOpen = open; this.drawer.hidden = !open; this.searchVersion++;
    if (!open) { this.selecting = false; this.selectedSessions.clear(); }
    this.drawerToggle.buttonEl.setAttribute("aria-expanded", String(open));
    if (open) { void this.renderDrawer(); this.drawerSearch.focus(); }
  }
  private async renderDrawer(): Promise<void> {
    if (!this.drawerOpen) return;
    ++this.searchVersion;
    const query = this.drawerSearch.value.trim().toLowerCase(), r = this.plugin.runtime;
    this.drawerList.empty(); this.renderSelection();
    {
      const groups = historyGroups(r.state.sessions.filter(s => !!s.archived === (this.drawerTab === "archived")), query);
      for (const group of groups) {
        const heading = this.drawerList.createDiv("simple-ai-history-group-heading");
        const groupButton = new ButtonComponent(heading).setButtonText(group.title).onClick(() => {
          this.selecting = true;
          const allSelected = group.sessions.every(session => this.selectedSessions.has(session.id));
          for (const session of group.sessions) {
            if (allSelected) this.selectedSessions.delete(session.id); else this.selectedSessions.add(session.id);
          }
          void this.renderDrawer();
        });
        groupButton.buttonEl.addClass("simple-ai-history-group-select");
        const updateGroupSelection = () => {
          const selected = group.sessions.filter(session => this.selectedSessions.has(session.id)).length;
          const allSelected = selected === group.sessions.length;
          groupButton.buttonEl.setAttribute("aria-pressed", allSelected ? "true" : selected ? "mixed" : "false");
          groupButton.buttonEl.setAttribute("aria-label", `${allSelected ? "取消选择" : "选择"}${group.title}的全部 ${group.sessions.length} 个对话`);
          groupButton.setTooltip(`${allSelected ? "取消选择" : "选择"}这一组的全部 ${group.sessions.length} 个对话`);
          groupButton.buttonEl.toggleClass("is-partially-selected", selected > 0 && !allSelected);
        };
        updateGroupSelection();
        if (!this.selecting) this.iconButton(heading, "list-checks", "选择对话", () => { this.selecting = true; void this.renderDrawer(); });
        for (const s of group.sessions) {
          const row = this.drawerList.createDiv("simple-ai-history-row"); row.toggleClass("is-active", s.id === r.state.active);
          if (this.selecting) {
            const checkbox = row.createEl("input", { type: "checkbox", attr: { "aria-label": "选择会话：" + s.title } }); checkbox.checked = this.selectedSessions.has(s.id);
            checkbox.onchange = () => { if (checkbox.checked) this.selectedSessions.add(s.id); else this.selectedSessions.delete(s.id); updateGroupSelection(); this.renderSelection(); };
          }
          new ButtonComponent(row).setButtonText(s.title).setTooltip(s.title).onClick(() => {
            if (this.selecting) { if (this.selectedSessions.has(s.id)) this.selectedSessions.delete(s.id); else this.selectedSessions.add(s.id); void this.renderDrawer(); return; }
            r.state.active = s.id; this.visibleLimit = 80; this.toggleDrawer(false); r.changed(); void this.persist();
          }).buttonEl.addClass("simple-ai-history-title");
          if (!this.selecting) this.iconButton(row, s.archived ? "archive-restore" : "archive", s.archived ? "取消归档" : "归档会话", () => { if (s.status === "running") return; s.archived = !s.archived; s.archivedAt = s.archived ? Date.now() : undefined; void this.persist(); void this.renderDrawer(); });
        }
      }
      if (!groups.length) this.drawerList.createEl("p", { text: "没有找到会话。", cls: "simple-ai-hint" });
      return;
    }
  }
  private renderSelection(): void {
    this.selectionBar.empty(); this.selectionFooter.empty();
    if (!this.selecting) return;
    this.selectionBar.createSpan({ text: this.selectedSessions.size ? "已选择 " + this.selectedSessions.size + " 个对话" : "选择对话" });
    this.iconButton(this.selectionBar, "x", "退出选择", () => { this.selecting = false; this.selectedSessions.clear(); void this.renderDrawer(); });
    const ids = [...this.selectedSessions];
    const runtime = this.plugin.runtime;
    const summarize = new ButtonComponent(this.selectionFooter).setButtonText("总结记忆").setTooltip("提取所选对话中的长期偏好与规则，合并到记忆文件").setDisabled(!ids.length || runtime.busy || runtime.memoryBusy || this.plugin.cooperation.busy).onClick(() => { void this.perform(async () => {
      if (!this.plugin.settings.agent.memory.enabled) { new Notice("请先在设置中启用记忆功能。"); return; }
      const task = runtime.checkMemory(true, false, ids); this.renderSelection();
      await task;
      new Notice(runtime.state.memory.lastResult?.text ?? "记忆总结已结束。");
      this.renderSelection();
    }); });
    const icon = summarize.buttonEl.createSpan(); setIcon(icon, "brain"); summarize.buttonEl.prepend(icon);
    const remove = new ButtonComponent(this.selectionFooter).setButtonText("删除").setDisabled(!ids.length || this.plugin.runtime.busy).onClick(() => {
      const modal = new Modal(this.app); modal.titleEl.setText("删除 " + ids.length + " 个对话？");
      modal.contentEl.createEl("p", { text: "删除这些对话及其专属图片、附件和对话备份。其他对话仍引用的共享图片会保留。笔记和已提取的长期记忆不受影响。" });
      new Setting(modal.contentEl).addButton(b => b.setButtonText("取消").onClick(() => modal.close())).addButton(b => destructiveButton(b.setButtonText("删除")).onClick(() => { void this.perform(async () => { await this.plugin.runtime.manageSessions(ids, "delete"); this.selectedSessions.clear(); this.selecting = false; modal.close(); void this.renderDrawer(); }); }));
      modal.open();
    });
    remove.buttonEl.addClass("simple-ai-delete-sessions"); const trash = remove.buttonEl.createSpan(); setIcon(trash, "trash-2"); remove.buttonEl.prepend(trash);
  }
  private setupBottomSpace(): void {
    const doc = this.contentEl.ownerDocument, win = doc.defaultView!;
    let frame = 0, closed = false; const bars = new Set<Element>();
    const focusTimers = new Set<number>();
    const update = () => {
      frame = 0; if (closed) return;
      const found = Array.from(doc.querySelectorAll(".status-bar"));
      for (const bar of bars) if (!found.includes(bar)) { resize.unobserve(bar); bars.delete(bar); }
      for (const bar of found) if (!bars.has(bar)) { bars.add(bar); resize.observe(bar); }
      const rects = found.filter(bar => win.getComputedStyle(bar).visibility !== "hidden" && win.getComputedStyle(bar).display !== "none").map(bar => bar.getBoundingClientRect());
      const pane = this.contentEl.getBoundingClientRect();
      const mobile = Platform.isMobile || doc.body.classList.contains("is-mobile");
      const focused = this.contentEl.contains(doc.activeElement) && doc.activeElement?.matches("textarea, input, [contenteditable='true']");
      const hostStyle = win.getComputedStyle(doc.body);
      const keyboardHeight = focused ? Math.max(0, ...["--keyboard-height", "--mobile-keyboard-height"].map(key => parseFloat(hostStyle.getPropertyValue(key)) || 0)) : 0;
      const hostGap = keyboardHeight ? Math.max(0, pane.bottom - (win.innerHeight - keyboardHeight)) : 0;
      const viewportGap = mobile ? Math.max(viewportBottomOverlap(pane, win.visualViewport), hostGap) : 0;
      this.contentEl.style.setProperty("--simple-ai-status-gap", `${bottomOverlap(pane, rects)}px`);
      this.contentEl.style.setProperty("--simple-ai-viewport-gap", `${viewportGap}px`);
      this.contentEl.style.setProperty("--simple-ai-safe-bottom", viewportGap ? "0px" : "env(safe-area-inset-bottom, 0px)");
      if (mobile && focused && viewportGap > 0) {
        const field = doc.activeElement as HTMLElement;
        if (field !== this.composer) field.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };
    const schedule = () => { if (!closed && !frame) frame = win.requestAnimationFrame(update); };
    const focusChanged = () => {
      schedule();
      for (const delay of [100, 300, 600]) {
        const timer = win.setTimeout(() => { focusTimers.delete(timer); schedule(); }, delay);
        focusTimers.add(timer);
      }
    };
    this.registerDomEvent(this.contentEl, "focusin", focusChanged);
    this.registerDomEvent(this.contentEl, "focusout", focusChanged);
    const resize = new ResizeObserver(schedule); resize.observe(this.contentEl);
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.target === doc.body || (record.target.nodeType === 1 && (record.target as Element).closest(".status-bar")) || [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node.nodeType === 1 && ((node as Element).matches(".status-bar") || !!(node as Element).querySelector(".status-bar"))))) schedule();
    });
    mutations.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    win.addEventListener("resize", schedule); win.visualViewport?.addEventListener("resize", schedule); win.visualViewport?.addEventListener("scroll", schedule); schedule();
    this.cleanupLayout = () => { closed = true; for (const timer of focusTimers) win.clearTimeout(timer); if (frame) win.cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); win.removeEventListener("resize", schedule); win.visualViewport?.removeEventListener("resize", schedule); win.visualViewport?.removeEventListener("scroll", schedule); };
  }
  async onClose(): Promise<void> {
    this.tokenPreviewVersion++; if (this.tokenPreviewTimer) window.clearTimeout(this.tokenPreviewTimer);
    this.pendingCard?.owner?.unload(); this.pendingCard = undefined; this.processes.clear();
    this.toolResults.clear();
    this.modelPopover?.close(); this.cleanupLayout?.(); this.searchVersion++; this.drawerOpen = false; if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.messageComponents.forEach(c => c.unload()); this.messageComponents = []; this.unsubscribe?.(); if (this.timer) window.clearTimeout(this.timer); await this.persist();
  }
}
class ChangesModal extends Modal {
  constructor(private plugin: SimpleAIPlugin, private session: Session, private mode: "all" | "preview" | "undo" = "all") { super(plugin.app); }
  onOpen(): void {
    this.modalEl.addClass("simple-ai-config-modal"); this.titleEl.setText(this.mode === "preview" ? "操作预览" : this.mode === "undo" ? "撤销修改" : "操作记录与撤销修改"); this.contentEl.empty();
    const changes = this.session.changes.filter(c => this.mode !== "undo" || c.state === "done");
    if (!changes.length) this.contentEl.createEl("p", { text: this.mode === "undo" ? "暂无已完成的修改可撤销。" : "还没有笔记修改。" });
    const selected = new Set(changes.filter(c => c.state === "proposed").map(c => c.id));
    if (selected.size) {
      new ButtonComponent(this.contentEl).setButtonText("应用勾选方案").setCta().onClick(async () => { try { await this.plugin.runtime.applyProposals(this.session, [...selected]); } catch (e) { new Notice(e instanceof Error ? e.message : "应用失败"); } this.onOpen(); });
      new ButtonComponent(this.contentEl).setButtonText("放弃勾选方案").onClick(() => { for (const c of this.session.changes) if (selected.has(c.id) && c.state === "proposed") c.state = "skipped"; void this.plugin.runtime.save().catch(() => new Notice("保存失败")); this.onOpen(); });
    }
    for (const batch of new Set(this.session.changes.filter(c => c.state === "done" && c.batchId).map(c => c.batchId!))) {
      new ButtonComponent(this.contentEl).setButtonText("撤销一批 · " + batch.slice(0, 8)).onClick(async () => { try { await this.plugin.runtime.undoBatch(this.session, batch); } catch (e) { new Notice(e instanceof Error ? e.message : "撤销中断，已完成项保留"); } this.onOpen(); });
    }
    for (const c of [...changes].reverse()) {
      if (c.state === "proposed") new Setting(this.contentEl).setName(c.path + (c.target ? " → " + c.target : "")).addToggle(t => settingsCheckbox(t).setValue(true).onChange(v => { if (v) selected.add(c.id); else selected.delete(c.id); }));
      const kinds = { delete: "笔记移入回收站", create: "新建", edit: "修改", move: "移动/重命名", "folder-create": "创建文件夹", "folder-delete": "移入回收站", "folder-move": "移动/重命名文件夹" };
      const states = { proposed: "待应用", applied: "方案已应用", skipped: "已放弃", pending: "执行中或结果待核对", done: "已完成", undone: "已撤销", failed: "失败，请核对" };
      const box = this.contentEl.createEl("details"); box.createEl("summary", { text: `${kinds[c.kind]} · ${c.path}${c.target ? " → " + c.target : ""} · ${states[c.state]}` });
      if (c.kind === "folder-delete") box.createEl("p", { text: "删除使用 Obsidian 回收站；非空目录请从回收站恢复。" });
      box.createEl("pre", { text: `修改前\n${c.before}\n\n修改后\n${c.after}` });
      new ButtonComponent(box).setButtonText("撤销这一项").setDisabled(this.plugin.runtime.busy || c.state !== "done" || c.kind === "folder-delete" && c.before !== "[]").onClick(async () => {
        try { await this.plugin.runtime.undo(this.session, c.id); this.onOpen(); } catch (e) { new Notice(e instanceof Error ? e.message : "撤销失败"); }
      });
    }
  }
}

class SkillMentionPicker extends FuzzySuggestModal<Skill> {
  constructor(private plugin: SimpleAIPlugin, private session: Session, private changed: () => void) { super(plugin.app); this.setPlaceholder("搜索并添加本次要使用的技能"); }
  getItems(): Skill[] { return skillsFor(this.plugin.settings.agent); }
  getItemText(skill: Skill): string { return skill.name + " · " + skill.description; }
  onChooseItem(skill: Skill): void {
    if (this.plugin.runtime.busy) { new Notice("请先等待任务结束再添加技能。"); return; }
    this.session.draftSkills = [...new Set([...(this.session.draftSkills ?? []), skill.id])];
    this.plugin.runtime.userActive(); this.changed();
  }
}
