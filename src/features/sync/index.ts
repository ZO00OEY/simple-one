import {
  addIcon,
  App,
  Component,
  EventRef,
  FileSystemAdapter,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  requestUrl,
  setIcon,
  setTooltip,
  Setting,
  SettingDefinitionItem,
  TAbstractFile,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import { migrateLinkFiles, readLocalSyncSettings, writeLocalSyncSettings, legacySyncRunning } from "./storage";
import { runAsync } from "../../shared/async";
import { settingsSection } from "../../shared/settingsLayout";
import type SimplePlugin from "../../main";
import { assertNoPrivateSyncFiles, coalesceDirty, defaultSyncIgnorePatterns, DirtyEntry, shouldIgnore } from "./dirty";
import {
  ChangeItem,
  findRemoteChangeOverlaps,
  parseGitNameStatus,
  parseGitStatus
} from "./gitStatus";
import { applyConflictResolutions, ConflictBlock, parseConflictBlocks } from "./conflict";
import { describeGitError, isMissingRemoteRefError, isTransientGitNetworkError, isUncertainGitAuthError } from "./gitError";
import { LiveReview, ZoeySyncConflictPreviewModal } from "./conflictPreview";
import { SetupDifferencesModal } from "./setupDifferences";
import { GitSetup, OverlapChoice, SetupOverlapContent, SetupPreview, VerifiedRepo, setupGitIgnore, missingSetupIgnoreRules, pathBatches, explainSetupError, parseGithubRepoUrl, applySetupIgnoreBase, setupIgnoreComparisonText, setupIgnoreDiffers, setupIgnoreRuleGroups, setupFinalIgnoreRuleGroups } from "./onboarding";
import { findNestedRepos, nestedGitIgnoreRules, nestedRepoFiles, rebuildNestedRepoTracking } from "./nestedRepos";

import { DEFAULT_MOBILE_OPTIONS, MobileOptions, mobileIgnores, newPathRecords } from "./linkDiff";
import { ConflictChoice, MobileGithub, RemoteSnapshot } from "./mobileGithub";
import { MobileHost, MobileSyncModal, renderMobileSettings, renderMobileSyncRules } from "./mobileUi";

type ChangeViewMode = "upload" | "commit";
type ViewStatusTone = "success" | "pending" | "error" | "checking" | "commit" | "fetch" | "merge" | "push";

interface ViewStatusState {
  text: string;
  tone: ViewStatusTone;
}

interface DesktopCommitResult {
  committed: boolean;
}

interface FileTrackingPreview {
  paths: string[];
  missingRules: string[];
}

interface InterruptedGitOperation {
  ref: string;
  label: string;
  abortArgs: string[];
}

interface GitRepairResult {
  operation: string;
  restoredLocalChanges: boolean;
}

interface LocalHistoryPreview {
  cutoff: string;
  branch: string;
  head: string;
  totalCommits: number;
  oldCommits: number;
  localSizeMiB: number;
}

class SyncDeferredError extends Error {}

const DEFAULT_GIT_AUTHOR_NAME = "default";
const DEFAULT_GIT_AUTHOR_EMAIL = "default@default.com";
const CHECKBOX_CHECKED_ICON = "simple-one-sync-square-check-contained";
const LAYOUT_SWITCH_ICON = "simple-one-sync-layout-panels";
const REFRESH_CHANGES_ICON = "simple-one-sync-refresh-changes";

addIcon(
  CHECKBOX_CHECKED_ICON,
  '<g fill="none" stroke="currentColor" stroke-width="8.333" stroke-linecap="round" stroke-linejoin="round"><rect x="12.5" y="12.5" width="75" height="75" rx="8.333"/><path d="m29.167 50.417 13.333 13.333 29.167-30"/></g>'
);
addIcon(
  LAYOUT_SWITCH_ICON,
  '<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><rect x="12" y="15" width="76" height="70" rx="8"/><path d="M42 15v70M42 43h46"/></g>'
);
addIcon(
  REFRESH_CHANGES_ICON,
  '<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M30 16H20a6 6 0 0 0-6 6v10M70 16h10a6 6 0 0 1 6 6v10M30 84H20a6 6 0 0 1-6-6V68M70 84h10a6 6 0 0 0 6-6V68"/><path d="M34 36h32M34 50h22M34 64h32"/></g>'
);

interface ServerAction {
  type: "upsert" | "delete";
  path: string;
  contentBase64?: string;
}

interface ServerCommand {
  id: string;
  kind: "notice" | "sync" | "open_file";
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

interface ErrorLogEntry {
  timestamp: number;
  context: string;
  message: string;
  status?: "success" | "error";
}

interface PluginSettings {
  legacyMigrationPending: boolean;
  mobile: MobileOptions;
  boundRepoUrl: string;
  desktopGitEnabled: boolean;
  desktopLightweightEnabled: boolean;
  mobileSyncEnabled: boolean;
  enabled: boolean;
  viewLayout: "list" | "tree";
  lastSyncAt: number;
  lastPullAt: number;
  serverUrl: string;
  serverPassword: string;
  deviceId: string;
  deviceName: string;
  baseVersion: number;
  dirty: DirtyEntry[];
  inFlight: DirtyEntry[];
  pendingRequestId: string;
  ignorePatterns: string[];
  mobileAutoSyncMinutes: number;
  commandPollSeconds: number;
  gitRemoteUrl: string;
  gitBranch: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  setupComplete: boolean;
  setupFlowVersion: number;
  setupStep: number;
  setupRepoUrl: string;
  setupVerified?: VerifiedRepo;
  setupBackup?: { step: number; repoUrl: string; verified?: VerifiedRepo };
  setupMutationStarted: boolean;
  viewRefreshDelaySeconds: number;
  autoCommitIdleMinutes: number;
  maxUncommittedMinutes: number;
  pullOnStartup: boolean;
  autoPullIntervalMinutes: number;
  pendingMergePushAfterResolve: boolean;
  errorLogs: ErrorLogEntry[];
}

const DEFAULT_SETTINGS: PluginSettings = {
  enabled: false,
  legacyMigrationPending: false,
  boundRepoUrl: "",
  mobile: { ...DEFAULT_MOBILE_OPTIONS, plugins: [], ignorePatterns: [] },
  desktopGitEnabled: true,
  desktopLightweightEnabled: false,
  mobileSyncEnabled: true,
  viewLayout: "list",
  lastSyncAt: 0,
  lastPullAt: 0,
  serverUrl: "",
  serverPassword: "",
  deviceId: "",
  deviceName: "",
  baseVersion: 0,
  dirty: [],
  inFlight: [],
  pendingRequestId: "",
  ignorePatterns: [],
  mobileAutoSyncMinutes: 10,
  commandPollSeconds: 60,
  gitRemoteUrl: "",
  gitBranch: "master",
  gitAuthorName: DEFAULT_GIT_AUTHOR_NAME,
  gitAuthorEmail: DEFAULT_GIT_AUTHOR_EMAIL,
  setupComplete: false,
  setupFlowVersion: 2,
  setupStep: 1,
  setupRepoUrl: "",
  setupMutationStarted: false,
  viewRefreshDelaySeconds: 7,
  autoCommitIdleMinutes: 5,
  maxUncommittedMinutes: 30,
  pullOnStartup: true,
  autoPullIntervalMinutes: 5,
  pendingMergePushAfterResolve: false,
  errorLogs: []
};

const SHARED_SETTING_KEYS = new Set<keyof PluginSettings>([
  "boundRepoUrl",
  "viewLayout",
  "serverUrl",
  "ignorePatterns",
  "mobileAutoSyncMinutes",
  "commandPollSeconds",
  "gitRemoteUrl",
  "gitBranch",
  "gitAuthorName",
  "gitAuthorEmail",
  "viewRefreshDelaySeconds",
  "autoCommitIdleMinutes",
  "maxUncommittedMinutes",
  "pullOnStartup",
  "autoPullIntervalMinutes"
]);

function pickLocalSettings(source: Partial<PluginSettings>): Partial<PluginSettings> {
  const result: Partial<PluginSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof PluginSettings>) {
    if (!SHARED_SETTING_KEYS.has(key) && source[key] !== undefined) {
      (result as Record<string, unknown>)[key] = source[key];
    }
  }
  for (const key of ["setupVerified", "setupBackup"] as const) {
    if (source[key] !== undefined) (result as Record<string, unknown>)[key] = source[key];
  }
  return result;
}

function pickSharedSettings(source: Partial<PluginSettings>): Partial<PluginSettings> {
  const result: Partial<PluginSettings> = {};
  for (const key of SHARED_SETTING_KEYS) {
    if (source[key] !== undefined) (result as Record<string, unknown>)[key] = source[key];
  }
  return result;
}

const ERROR_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LOGS = 500;
const DESKTOP_RETRY_DELAY_MS = 5 * 60 * 1000;
const DESKTOP_STARTUP_NETWORK_RETRY_DELAY_MS = 5 * 1000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleString();
}

function formatStatusError(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "未知错误";
  return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

export default class SyncFeature extends Component {
  constructor(readonly host: SimplePlugin) { super(); }
  get app(): App { return this.host.app; }
  get manifest() { return this.host.manifest; }
  openSettings?: () => void;
  private loadData(): Promise<unknown> { return readLocalSyncSettings(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id); }
  private saveData(value: unknown): Promise<void> { return writeLocalSyncSettings(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, value); }

  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private syncing = false;
  private desktopTaskActive = false;
  private featureActive = false;
  private suppressPaths = new Set<string>();
  private statusEl?: HTMLElement;
  private ribbonEl?: HTMLElement;
  private featureEvents: EventRef[] = [];
  private featureIntervals: number[] = [];
  private viewRefreshTimer?: number;
  private idleCommitTimer?: number;
  private maxCommitTimer?: number;
  private desktopPushRetryTimer?: number;
  private firstUncommittedAt = 0;
  private automaticPushQueued = false;
  private automaticBackupQueued = false;
  private startupPullScheduled = false;
  private desktopGitQueue: Promise<void> = Promise.resolve();
  private desktopGitTrace: string[] = [];
  private sharedSettingsWritable = true;
  private deferredMergePaths: string[] = [];
  private syncActivity?: ViewStatusState;
  private setupPreview?: SetupPreview;
  private setupActivity?: ViewStatusState;

  getSetupActivity(): ViewStatusState | undefined {
    return this.setupActivity;
  }

  setSetupActivity(text: string, tone: ViewStatusTone): void {
    this.setupActivity = { text, tone };
    this.setStatus(text);
    for (const leaf of this.app.workspace.getLeavesOfType(ZoeySyncView.type)) {
      if (leaf.view instanceof ZoeySyncView) leaf.view.updateActivity(this.setupActivity);
    }
  }
  private setupChoices: Record<string, OverlapChoice> = {};
  private setupTrackingChoice?: "keep" | "rebuild";
  private mobileGithub?: MobileGithub;
  private switchingSyncMode = false;

  async initialize(): Promise<void> {
    await migrateLinkFiles(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, !legacySyncRunning(this.app), SHARED_SETTING_KEYS);
    await this.loadSettings();
    if (this.settings.enabled && legacySyncRunning(this.app)) {
      this.settings.enabled = false;
      await this.saveSettings();
      new Notice("旧 Simple Link 仍在运行，请先关闭旧插件的同步，再启用同步与分享。");
    }
    if (this.settings.enabled && this.useLightweightSync()) await this.getMobileGithub().load();
    if (!Platform.isMobile) await this.detectDesktopGitDefaults();
    this.statusEl = this.host.addStatusBarItem();
    this.host.registerView(ZoeySyncView.type, (leaf) => new ZoeySyncView(leaf, this));
    this.host.registerView(ZoeySyncConflictView.type, (leaf) => new ZoeySyncConflictView(leaf, this));
    this.host.addCommand({ id: "sync-now", name: "同步笔记", callback: () => void this.syncNow(true) });
    this.host.addCommand({ id: "test-connection", name: "测试同步连接", callback: () => void this.testConnection(true) });
    this.host.addCommand({ id: "recalibrate-mobile-hashes", name: "重新校验轻量同步范围哈希", callback: () => void this.calibrateMobileHashes() });
    this.host.addCommand({ id: "open-sync-view", name: "打开同步面板", callback: () => void this.openSyncView() });
    if (this.settings.enabled) {
      this.activateFeature();
      if (!Platform.isMobile) {
        this.app.workspace.onLayoutReady(() => void this.openSyncView());
      }
    } else if (this.statusEl) this.statusEl.addClass("simple-one-sync-hidden");
  }

  onunload(): void {
    this.deactivateFeature();
  }

  async setFeatureEnabled(enabled: boolean): Promise<void> {
    if (enabled && legacySyncRunning(this.app)) { new Notice("请先关闭旧 Simple Link 的同步，避免两套引擎同时操作笔记库。"); return; }
    if (!enabled && this.syncing) { new Notice("请等待当前同步完成后再关闭。"); return; }
    if (enabled && this.settings.legacyMigrationPending) {
      await migrateLinkFiles(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, true, SHARED_SETTING_KEYS);
      this.settings.legacyMigrationPending = false;
      this.mobileGithub = undefined;
    }
    this.settings.enabled = enabled;
    await this.saveSettings();
    if (enabled) {
      this.activateFeature();
      await this.openSyncView();
    } else {
      this.deactivateFeature();
    }
  }

  useLightweightSync(): boolean {
    return Platform.isMobile ? this.settings.mobileSyncEnabled : this.settings.desktopLightweightEnabled;
  }

  nativeGitEnabled(): boolean {
    return !Platform.isMobile && this.settings.desktopGitEnabled && !this.settings.desktopLightweightEnabled;
  }

  async setLightweightSyncEnabled(enabled: boolean): Promise<void> {
    if (!Platform.isMobile) { await this.setDesktopSyncMode(enabled ? "lightweight" : "off"); return; }
    if (this.syncing || this.switchingSyncMode) { new Notice("请等待当前同步完成。"); return; }
    if (enabled) await this.getMobileGithub().load();
    this.deactivateFeature();
    this.settings.mobileSyncEnabled = enabled;
    if (enabled) {
      this.settings.mobile.mode = "github";
      this.settings.desktopGitEnabled = false;
      this.settings.desktopLightweightEnabled = false;
    }
    await this.saveSettings();
    if (this.settings.enabled) this.activateFeature();
  }

  async setDesktopSyncMode(mode: "git" | "lightweight" | "off"): Promise<void> {
    if (Platform.isMobile) return;
    if (this.syncing || this.switchingSyncMode) { new Notice("请等待当前同步或模式切换完成。"); return; }
    if (mode === "lightweight") await this.getMobileGithub().load();
    this.switchingSyncMode = true;
    try {
    this.deactivateFeature();
    this.settings.desktopGitEnabled = false;
    this.settings.desktopLightweightEnabled = false;
    await this.desktopGitQueue;
    if (mode === "lightweight") {
      await this.getMobileGithub().load();
      this.settings.mobile.mode = "github";
      this.settings.desktopLightweightEnabled = true;
    } else {
      this.settings.desktopGitEnabled = mode === "git";
      if (mode === "git") this.settings.mobile.mode = "github";
    }
    this.startupPullScheduled = false;
    await this.saveSettings();
    if (this.settings.enabled) this.activateFeature();
    } finally { this.switchingSyncMode = false; }
  }

  getMobileGithub(): MobileGithub {
    if (!this.mobileGithub) {
      this.mobileGithub = new MobileGithub(this.app.vault.adapter,
        this.app.vault.configDir, this.manifest.id, () => this.settings.mobile,
        (message) => {
          if (this.syncing) this.setSyncActivity(message, "checking");
          else this.setStatus(message);
        });
      this.register(this.mobileGithub.onRemainingChange(() => {
        for (const leaf of this.app.workspace.getLeavesOfType(ZoeySyncView.type)) {
          if (leaf.view instanceof ZoeySyncView) leaf.view.updateQuota();
        }
      }));
    }
    return this.mobileGithub;
  }

  async completeLightweightGuide(options: MobileOptions): Promise<void> {
    if (this.host.share?.busy) throw new Error("请等待笔记分享发布完成。");
    if (legacySyncRunning(this.app)) throw new Error("请先关闭旧 Simple Link 的同步，再完成新入口的接入。");
    if (this.syncing || this.switchingSyncMode) throw new Error("请等待当前同步或模式切换完成后重试。");
    this.switchingSyncMode = true;
    this.syncing = true;
    this.deactivateFeature();
    const previous = { mobile: this.settings.mobile, boundRepoUrl: this.settings.boundRepoUrl,
      desktopGitEnabled: this.settings.desktopGitEnabled, desktopLightweightEnabled: this.settings.desktopLightweightEnabled,
      mobileSyncEnabled: this.settings.mobileSyncEnabled };
    let bound = false;
    try {
      await this.desktopGitQueue;
      if (this.settings.legacyMigrationPending) {
        await migrateLinkFiles(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, true, SHARED_SETTING_KEYS);
        this.settings.legacyMigrationPending = false;
        this.mobileGithub = undefined;
      }
      const engine = this.getMobileGithub();
      await engine.load();
      this.settings.mobile = { ...options, plugins: [...options.plugins], ignorePatterns: [...options.ignorePatterns], mode: "github", bound: false };
      const verified = await engine.verifyAccess();
      const remote = await engine.bind(verified);
      bound = true;
      this.settings.mobile.branch = remote.branch;
      this.settings.mobile.bound = true;
      this.settings.boundRepoUrl = this.settings.mobile.repoUrl;
      this.settings.desktopGitEnabled = false;
      this.settings.desktopLightweightEnabled = !Platform.isMobile;
      this.settings.mobileSyncEnabled = Platform.isMobile;
      this.settings.enabled = true;
      await this.saveSettings();
      await this.mobileHost().save();
      // Capture edits and moves during the review, while syncing suppresses automation.
      this.activateFeature();
      this.setStatus("正在检查首次同步差异…");
      const plan = await engine.preview();
      if (!await new MobileSyncModal(this.app, engine, plan, false, live => this.reviewLightweightDifferences(live)).wait()) {
        this.setStatus("首次同步未完成，请继续接入或手动同步");
        throw new Error("已保存连接，但同步已取消，接入尚未完成；请重试并确认同步以建立共同基线。");
      }
      if (!engine.state.baseCommitSha) throw new Error("同步未建立共同基线，请重新预览同步。");
      this.settings.lastSyncAt = Date.now();
      await this.saveSettings();
      this.setStatus("GitHub API · 两端已对齐");
      await this.recordSuccess("轻量首次同步", "已完成同步，保存共同基线与本地哈希缓存。");
    } catch (error) {
      // After a successful bind, retain the matching options rather than restore a stale binding.
      if (!bound) Object.assign(this.settings, previous);
      throw error;
    } finally {
      this.syncing = false;
      this.switchingSyncMode = false;
      if (this.settings.enabled) this.activateFeature();
    }
  }

  restartMobileAutomation(): void {
    if (!this.useLightweightSync() || !this.featureActive) return;
    for (const interval of this.featureIntervals) window.clearInterval(interval);
    this.featureIntervals = [];
    const options = this.settings.mobile;
    if (options.mode === "server") {
      this.addFeatureInterval(window.setInterval(() => void this.pollCommands(), Math.max(15, this.settings.commandPollSeconds) * 1000));
      if (this.settings.mobileAutoSyncMinutes > 0) this.addFeatureInterval(window.setInterval(
        () => void this.syncNow(false), Math.max(1, this.settings.mobileAutoSyncMinutes) * 60000));
      return;
    }
    if (options.autoSyncMinutes > 0) this.addFeatureInterval(window.setInterval(
      () => { if (options.bound) void this.syncNow(false); }, Math.max(1, options.autoSyncMinutes) * 60000));
  }

  mobileHost(): MobileHost {
    return { active: () => this.useLightweightSync(), app: this.app, options: this.settings.mobile, engine: () => this.getMobileGithub(),
      save: async () => {
        await this.saveSettings();
        if (this.useLightweightSync()) {
          const engine = this.getMobileGithub(); await engine.load();
          if (!this.settings.mobile.trackPaths) engine.state.paths = newPathRecords();
          if (!this.settings.mobile.cacheEnabled) engine.state.cache = {};
          await engine.save();
        }
      }, restart: () => this.restartMobileAutomation(), sync: () => this.syncNow(true),
      calibrate: () => this.calibrateMobileHashes() };
  }

  async calibrateMobileHashes(): Promise<void> {
    if (!this.useLightweightSync()) { new Notice("请先启用轻量 GitHub API 同步。"); return; }
    if (this.syncing) { new Notice("同步期间不能重新校验。"); return; }
    try {
      const result = await this.getMobileGithub().refreshCache(true);
      new Notice(`已校验 ${result.files} 个同步文件，用时 ${result.seconds.toFixed(2)} 秒；共同基准未改变。`);
      await this.refreshSyncView();
    } catch (error) { new Notice(messageOf(error), 10000); }
  }

  private activateFeature(): void {
    if (this.featureActive) return;
    this.featureActive = true;
    if (this.statusEl) this.statusEl.removeClass("simple-one-sync-hidden");
    this.ribbonEl = this.host.addRibbonIcon("refresh-cw", "打开 同步与分享", () => void this.openSyncView());
    this.registerViewRefreshEvents();
    if (this.useLightweightSync()) {
      this.registerMobileEvents();
      this.restartMobileAutomation();
      this.setStatus(Platform.isMobile ? "移动端 · 等待同步" : "电脑端 · 轻量 API 模式");
      if (this.settings.mobile.mode === "server") {
        window.setTimeout(() => void this.registerMobile().catch((error) => this.recordError("手机连接", error)), 1000);
      }
    } else if (this.nativeGitEnabled()) {
      this.configureDesktopAutomation();
      this.scheduleStartupPull();
      void this.resumeDesktopDirtyState();
      this.setStatus(this.settings.setupComplete ? "桌面端 · Git 模式" : "等待首次 Git 配置");
    } else this.setStatus("电脑同步已关闭");
  }

  private deactivateFeature(): void {
    this.featureActive = false;
    for (const ref of this.featureEvents) this.app.vault.offref(ref);
    this.featureEvents = [];
    for (const interval of this.featureIntervals) window.clearInterval(interval);
    this.featureIntervals = [];
    this.clearDesktopTimeouts();
    this.ribbonEl?.remove();
    this.ribbonEl = undefined;
    if (this.statusEl) this.statusEl.addClass("simple-one-sync-hidden");
    this.app.workspace.detachLeavesOfType(ZoeySyncView.type);
    this.app.workspace.detachLeavesOfType(ZoeySyncConflictView.type);
  }

  private addFeatureInterval(interval: number): void {
    this.featureIntervals.push(interval);
    this.registerInterval(interval);
  }

  private clearDesktopTimeouts(): void {
    if (this.viewRefreshTimer !== undefined) window.clearTimeout(this.viewRefreshTimer);
    if (this.idleCommitTimer !== undefined) window.clearTimeout(this.idleCommitTimer);
    if (this.maxCommitTimer !== undefined) window.clearTimeout(this.maxCommitTimer);
    if (this.desktopPushRetryTimer !== undefined) window.clearTimeout(this.desktopPushRetryTimer);
    this.viewRefreshTimer = undefined;
    this.idleCommitTimer = undefined;
    this.maxCommitTimer = undefined;
    this.desktopPushRetryTimer = undefined;
    this.firstUncommittedAt = 0;
  }

  private configureDesktopAutomation(): void {
    if (!this.settings.setupComplete) return;
    if (this.settings.autoPullIntervalMinutes > 0) {
      this.addFeatureInterval(
        window.setInterval(
          () => void this.enqueueDesktopGit(() => this.desktopFetchAndMerge(), "自动 Fetch + Merge").catch(() => undefined),
          Math.max(1, this.settings.autoPullIntervalMinutes) * 60 * 1000
        )
      );
    }
  }

  private scheduleStartupPull(): void {
    if (!this.settings.setupComplete) return;
    if (!this.settings.pullOnStartup || this.startupPullScheduled) return;
    this.startupPullScheduled = true;
    this.app.workspace.onLayoutReady(() => {
      if (!this.featureActive || !this.nativeGitEnabled()) return;
      void this.enqueueDesktopGit(
        async () => {
          const conflicts = await this.getUnmergedPaths();
          if (conflicts.length > 0) {
            throw new SyncDeferredError(`有 ${conflicts.length} 个合并冲突等待处理`);
          }
          try {
            return await this.desktopStartupSync();
          } catch (error) {
            if (!isTransientGitNetworkError(error) && !isUncertainGitAuthError(error)) throw error;
            this.setStatus("GitHub 连接或认证暂时异常 · 正在重试");
            await new Promise((resolve) => window.setTimeout(resolve, DESKTOP_STARTUP_NETWORK_RETRY_DELAY_MS));
            if (!this.featureActive) return false;
            return await this.desktopStartupSync();
          }
        },
        "启动时 Commit + Fetch + Merge"
      ).catch(() => undefined);
    });
  }

  async restartDesktopAutomation(): Promise<void> {
    if (!this.nativeGitEnabled() || !this.featureActive) return;
    for (const interval of this.featureIntervals) window.clearInterval(interval);
    this.featureIntervals = [];
    if (this.idleCommitTimer !== undefined) window.clearTimeout(this.idleCommitTimer);
    if (this.maxCommitTimer !== undefined) window.clearTimeout(this.maxCommitTimer);
    if (this.desktopPushRetryTimer !== undefined) window.clearTimeout(this.desktopPushRetryTimer);
    this.idleCommitTimer = undefined;
    this.maxCommitTimer = undefined;
    this.desktopPushRetryTimer = undefined;
    this.firstUncommittedAt = 0;
    this.configureDesktopAutomation();
    await this.resumeDesktopDirtyState();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as
      | (Partial<PluginSettings> & { desktopAutoSyncMinutes?: number; autoPushIntervalMinutes?: number })
      | null;
    const shared = await this.loadSharedSettings();
    const legacyShared = pickSharedSettings(saved ?? {});
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      shared ?? legacyShared,
      pickLocalSettings(saved ?? {})
    );
    // Preserve the active sync flow for installations configured before the guide existed.
    if (saved?.setupComplete === undefined && this.settings.gitRemoteUrl) this.settings.setupComplete = true;
    if (saved?.setupFlowVersion !== 2) {
      const oldStep = Math.max(1, Math.min(5, Number(saved?.setupStep) || 1));
      this.settings.setupStep = oldStep <= 2 ? 1 : oldStep - 1;
      if (this.settings.setupBackup) {
        const oldBackupStep = Math.max(1, Math.min(5, Number(this.settings.setupBackup.step) || 1));
        this.settings.setupBackup.step = oldBackupStep <= 2 ? 1 : oldBackupStep - 1;
      }
      this.settings.setupFlowVersion = 2;
    }
    delete (this.settings as unknown as { desktopAutoSyncMinutes?: number }).desktopAutoSyncMinutes;
    delete (this.settings as unknown as { autoPushIntervalMinutes?: number }).autoPushIntervalMinutes;
    this.settings.dirty = Array.isArray(this.settings.dirty) ? this.settings.dirty : [];
    this.settings.mobile = { ...DEFAULT_MOBILE_OPTIONS, ...(saved?.mobile ?? {}),
      plugins: [...(saved?.mobile?.plugins ?? [])], ignorePatterns: [...(saved?.mobile?.ignorePatterns ?? [])] };
    if (saved?.boundRepoUrl === undefined && !shared?.boundRepoUrl) this.settings.boundRepoUrl = this.settings.mobile.repoUrl || this.settings.gitRemoteUrl || this.settings.setupRepoUrl || "";
    if (!saved?.mobile && this.settings.serverUrl) this.settings.mobile.mode = "server";
    if (this.settings.desktopLightweightEnabled) { this.settings.desktopGitEnabled = false; this.settings.mobile.mode = "github"; }
    this.settings.inFlight = Array.isArray(this.settings.inFlight) ? this.settings.inFlight : [];
    const storedIgnorePatterns = shared?.ignorePatterns ?? saved?.ignorePatterns;
    this.settings.ignorePatterns = Array.isArray(storedIgnorePatterns)
      ? storedIgnorePatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : defaultSyncIgnorePatterns(this.app.vault.configDir);
    this.settings.errorLogs = Array.isArray(this.settings.errorLogs) ? this.settings.errorLogs : [];
    this.pruneErrorLogs();
    if (!this.settings.lastPullAt) {
      this.settings.lastPullAt = this.settings.errorLogs
        .filter((entry) => entry.status === "success" && /Fetch|Pull/.test(entry.context))
        .reduce((latest, entry) => Math.max(latest, entry.timestamp), 0);
    }
    if (!this.settings.deviceId) this.settings.deviceId = crypto.randomUUID();
    if (!this.settings.deviceName) {
      this.settings.deviceName = Platform.isMobile ? "Zoey Mobile" : "Zoey Desktop";
    }
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(pickLocalSettings(this.settings));
    if (this.sharedSettingsWritable) await this.saveSharedSettings();
    if (this.useLightweightSync()) {
      const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/mobile-ignore.json`;
      await this.app.vault.adapter.write(path, JSON.stringify({ generated: mobileIgnores(
        this.settings.mobile, this.app.vault.configDir, this.manifest.id),
        selectedPlugins: this.settings.mobile.plugins }, null, 2));
    }
  }

  private sharedSettingsPath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/sync-settings.json`;
  }

  private async loadSharedSettings(): Promise<Partial<PluginSettings> | null> {
    const path = this.sharedSettingsPath();
    if (!(await this.app.vault.adapter.exists(path))) return null;
    try {
      const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as Partial<PluginSettings>;
      return pickSharedSettings(parsed);
    } catch (error) {
      this.sharedSettingsWritable = false;
      console.error("同步与分享 shared settings", error);
      new Notice("同步与分享：同步配置文件存在冲突或格式错误，已停止覆盖该文件", 10000);
      return null;
    }
  }

  private async saveSharedSettings(): Promise<void> {
    const path = this.sharedSettingsPath();
    const content = `${JSON.stringify(pickSharedSettings(this.settings), null, 2)}\n`;
    if (await this.app.vault.adapter.exists(path)) {
      const current = await this.app.vault.adapter.read(path);
      if (current === content) return;
    }
    await this.app.vault.adapter.write(path, content);
  }

  private pruneErrorLogs(): void {
    const cutoff = Date.now() - ERROR_LOG_RETENTION_MS;
    this.settings.errorLogs = this.settings.errorLogs
      .filter((entry) => entry.timestamp >= cutoff && (entry.status === "success" || entry.message))
      .slice(-MAX_ERROR_LOGS);
  }

  private async recordError(context: string, error: unknown): Promise<void> {
    await this.recordLog(context, "error", messageOf(error));
  }

  private async recordSuccess(context: string, message = ""): Promise<void> {
    await this.recordLog(context, "success", message);
  }

  private async recordLog(context: string, status: "success" | "error", message = ""): Promise<void> {
    try {
      this.pruneErrorLogs();
      this.settings.errorLogs.push({
        timestamp: Date.now(),
        context,
        message,
        status
      });
      this.settings.errorLogs = this.settings.errorLogs.slice(-MAX_ERROR_LOGS);
      await this.saveSettings();
    } catch (saveError) {
      console.error("同步与分享 error log", saveError);
    }
  }

  getRecentErrorLogs(): ErrorLogEntry[] {
    this.pruneErrorLogs();
    return [...this.settings.errorLogs].reverse();
  }

  getActiveSyncError(): ErrorLogEntry | undefined {
    const logs = this.getRecentErrorLogs();
    const latestFetch = logs.find((entry) => /Fetch|Pull|Push|同步/.test(entry.context));
    const latestPush = logs.find((entry) => /Push|同步/.test(entry.context));
    return [latestFetch, latestPush]
      .filter((entry): entry is ErrorLogEntry => !!entry && entry.status === "error")
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  async clearErrorLogs(): Promise<void> {
    this.settings.errorLogs = [];
    await this.saveSettings();
    await this.refreshSyncView();
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(`同步与分享: ${text}`);
  }

  private setSyncActivity(text: string, tone: ViewStatusTone): void {
    this.syncActivity = { text, tone };
    this.setStatus(text);
    for (const leaf of this.app.workspace.getLeavesOfType(ZoeySyncView.type)) {
      if (leaf.view instanceof ZoeySyncView) leaf.view.updateActivity(this.syncActivity);
    }
  }

  private clearSyncActivity(): void {
    this.syncActivity = undefined;
  }

  getSyncActivity(): ViewStatusState | undefined {
    return this.syncActivity ? { ...this.syncActivity } : undefined;
  }

  private trackFeatureEvent(ref: EventRef): void {
    this.featureEvents.push(ref);
    this.registerEvent(ref);
  }

  private registerViewRefreshEvents(): void {
    const changed = (file: TAbstractFile): void => this.handleVaultChange([file.path]);
    this.trackFeatureEvent(this.app.vault.on("create", changed));
    this.trackFeatureEvent(this.app.vault.on("modify", changed));
    this.trackFeatureEvent(this.app.vault.on("delete", changed));
    this.trackFeatureEvent(
      this.app.vault.on("rename", (file, oldPath) => this.handleVaultChange([file.path, oldPath]))
    );
  }

  private handleVaultChange(paths: string[]): void {
    const relevantPaths = paths.filter((path) => !shouldIgnore(path, this.settings.ignorePatterns, this.app.vault.configDir));
    if (relevantPaths.length === 0) return;
    this.scheduleViewRefresh();
    if (this.nativeGitEnabled() && this.settings.setupComplete) {
      this.scheduleDesktopCommit();
    }
  }

  private scheduleViewRefresh(): void {
    if (this.viewRefreshTimer !== undefined) window.clearTimeout(this.viewRefreshTimer);
    this.viewRefreshTimer = window.setTimeout(() => {
      this.viewRefreshTimer = undefined;
      void this.refreshSyncView();
    }, Math.max(0.5, this.settings.viewRefreshDelaySeconds) * 1000);
  }

  private scheduleDesktopCommit(): void {
    if (!this.settings.setupComplete) return;
    if (this.settings.autoCommitIdleMinutes > 0) {
      if (this.idleCommitTimer !== undefined) window.clearTimeout(this.idleCommitTimer);
      this.idleCommitTimer = window.setTimeout(
        () => void this.runAutomaticCommit(),
        Math.max(0.1, this.settings.autoCommitIdleMinutes) * 60 * 1000
      );
    }
    if (this.firstUncommittedAt === 0) {
      this.firstUncommittedAt = Date.now();
      if (this.settings.maxUncommittedMinutes > 0) {
        this.maxCommitTimer = window.setTimeout(() => {
          void this.runAutomaticCommit();
        }, Math.max(1, this.settings.maxUncommittedMinutes) * 60 * 1000);
      }
    }
  }

  private scheduleDesktopPush(): void {
    if (!this.settings.setupComplete) return;
    if (this.desktopPushRetryTimer !== undefined) return;
    void this.runAutomaticPush();
  }

  private clearDesktopPushRetry(): void {
    if (this.desktopPushRetryTimer !== undefined) window.clearTimeout(this.desktopPushRetryTimer);
    this.desktopPushRetryTimer = undefined;
  }

  private async scheduleDesktopPushRetry(statusText?: string): Promise<void> {
    try {
      const interrupted = await this.getInterruptedGitOperation();
      const conflicts = await this.getUnmergedPaths();
      if (interrupted || conflicts.length > 0) return;
    } catch {
      // Git 暂时不可用时仍安排一次重试。
    }
    if (this.desktopPushRetryTimer !== undefined) window.clearTimeout(this.desktopPushRetryTimer);
    this.desktopPushRetryTimer = window.setTimeout(() => {
      this.desktopPushRetryTimer = undefined;
      void this.enqueueDesktopGit(() => this.desktopAutomaticPush(), "Push 重试").catch(() => undefined);
    }, DESKTOP_RETRY_DELAY_MS);
    this.setStatus(statusText ?? "Push 失败 · 5 分钟后重试");
  }

  private resetDesktopCommitTracking(): void {
    if (this.idleCommitTimer !== undefined) window.clearTimeout(this.idleCommitTimer);
    if (this.maxCommitTimer !== undefined) window.clearTimeout(this.maxCommitTimer);
    this.idleCommitTimer = undefined;
    this.maxCommitTimer = undefined;
    this.firstUncommittedAt = 0;
  }

  private async runAutomaticCommit(): Promise<void> {
    if (this.automaticBackupQueued) return;
    this.automaticBackupQueued = true;
    try {
      await this.enqueueDesktopGit(() => this.desktopAutomaticPush(true), "自动备份（Commit + Push）");
    } catch {
      // 上传失败由 Git 队列安排重试，本地 Commit 保留。
    } finally {
      this.automaticBackupQueued = false;
    }
  }

  private async runAutomaticPush(): Promise<void> {
    if (this.automaticPushQueued) return;
    this.automaticPushQueued = true;
    try {
      await this.enqueueDesktopGit(async () => {
        return await this.desktopAutomaticPush();
      }, "自动 Push");
    } catch {
      // 队列会记录错误；后续文件变化会再次尝试。
    } finally {
      this.automaticPushQueued = false;
    }
  }

  private enqueueDesktopGit(task: () => Promise<void | boolean>, errorContext?: string): Promise<void> {
    if (!this.nativeGitEnabled()) return Promise.reject(new SyncDeferredError("电脑端原生 Git 同步已关闭"));
    if (!this.settings.setupComplete) return Promise.reject(new Error("请先完成首次使用引导"));
    const trackedTask = async (): Promise<void> => {
      if (this.host.share?.busy) throw new SyncDeferredError("笔记分享正在发布，主库自动同步暂缓。");
      if (legacySyncRunning(this.app)) throw new SyncDeferredError("旧 Simple Link 仍在运行，已暂停新入口的 Git 操作");
      if (!this.nativeGitEnabled()) throw new SyncDeferredError("电脑端原生 Git 同步已关闭");
      if (!this.settings.setupComplete) throw new SyncDeferredError("请先完成首次使用引导");
      this.desktopTaskActive = true;
      try {
      const isFetchTask = !!errorContext && (errorContext.includes("Fetch") || errorContext.includes("Pull"));
      const isPushTask = !!errorContext && (errorContext.includes("Push") || errorContext.includes("同步"));
      this.desktopGitTrace = isFetchTask || isPushTask
        ? [
            `远端：origin/${this.settings.gitBranch}`,
            "凭据路径：GitHub CLI"
          ]
        : [];
      const meaningfulChange = await task();
      if (errorContext && (meaningfulChange !== false || isFetchTask || isPushTask)) {
        const resultMessage = isPushTask
          ? meaningfulChange === false ? "GitHub 连接成功；无需上传" : "GitHub 连接成功；上传完成"
          : isFetchTask
            ? meaningfulChange === false ? "GitHub 连接成功；无需合并" : "GitHub 连接成功；检查或合并完成"
            : "本机操作完成；未执行 GitHub 远端连接检查";
        const detail = [resultMessage, ...this.desktopGitTrace].filter(Boolean).join("\n");
        await this.recordSuccess(errorContext, detail);
      }
      this.clearSyncActivity();
      } finally {
        this.desktopTaskActive = false;
        await this.refreshSyncView();
      }
    };
    const run = this.desktopGitQueue.then(trackedTask, trackedTask);
    this.desktopGitQueue = run.catch(async (error) => {
      this.clearSyncActivity();
      if (error instanceof SyncDeferredError) {
        this.setStatus(error.message);
        await this.refreshSyncView();
        return;
      }
      console.error("同步与分享 desktop task", error);
      if (errorContext) {
        await this.recordError(errorContext, [...this.desktopGitTrace, describeGitError(error)].join("\n"));
        if (errorContext.includes("Push") || errorContext.includes("同步")) {
          await this.scheduleDesktopPushRetry();
        } else if (errorContext.includes("Fetch") || errorContext.includes("Pull")) {
          this.setStatus(this.settings.autoPullIntervalMinutes > 0 ? "Fetch 失败 · 等待下次自动检查" : "Fetch 失败");
        }
        await this.refreshSyncView();
      }
    });
    return run;
  }

  private async traceDesktopGitStep<T>(label: string, action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await action();
      this.desktopGitTrace.push(`${label}：成功（${Date.now() - startedAt} ms）`);
      return result;
    } catch (error) {
      this.desktopGitTrace.push(`${label}：失败（${Date.now() - startedAt} ms）`);
      throw error;
    }
  }

  private async hasDesktopChanges(): Promise<boolean> {
    return (await this.gitRaw(["status", "--porcelain=v1", "-z"])).length > 0;
  }

  private async hasDesktopHead(): Promise<boolean> {
    try {
      await this.gitRaw(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  async inspectLocalHistory(retentionDays = 30): Promise<LocalHistoryPreview> {
    if (!this.settings.setupComplete) throw new Error("请先完成电脑端 Git 接入");
    const nodeRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    if (!nodeRequire) throw new Error("本地历史瘦身仅支持电脑端");
    const path = nodeRequire("path") as typeof import("path");
    const root = await this.git(["rev-parse", "--show-toplevel"]);
    if (path.resolve(root).toLowerCase() !== path.resolve(this.vaultBasePath()).toLowerCase()) {
      throw new Error("当前 Vault 不是独立 Git 仓库，无法安全清理历史");
    }
    const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch !== this.settings.gitBranch) throw new Error(`当前分支是 ${branch}，与同步设置的 ${this.settings.gitBranch} 不一致`);
    if (await this.hasDesktopChanges()) throw new Error("工作区还有未提交的文件；请先完成同步再清理");
    if (await this.getInterruptedGitOperationLabel()) throw new Error("存在未完成的 Git 操作，请先修复");
    const worktrees = await this.gitRaw(["worktree", "list", "--porcelain"]);
    if (worktrees.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length !== 1) {
      throw new Error("仓库存在其他工作树，暂不能清理本地历史");
    }
    const allowedRefs = new Set([`refs/heads/${branch}`, `refs/remotes/origin/${branch}`, "refs/remotes/origin/HEAD"]);
    const refs = (await this.gitRaw(["for-each-ref", "--format=%(refname)"])).split(/\r?\n/).filter(Boolean);
    const extraRefs = refs.filter((ref) => !allowedRefs.has(ref));
    if (extraRefs.length) throw new Error(`仓库还存在其他分支、标签或暂存引用（如 ${extraRefs[0]}），请先处理后再清理`);
    const head = await this.git(["rev-parse", "HEAD"]);
    const remoteLine = await this.git(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], true);
    const remoteHead = remoteLine.split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/i.test(remoteHead) || remoteHead !== head) {
      throw new Error("GitHub 分支与本机 HEAD 不一致；请先完成 Fetch、Merge 和 Push，再重新检查");
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const totalCommits = Number(await this.git(["rev-list", "--count", "HEAD"]));
    const oldCommits = Number(await this.git(["rev-list", "--count", `--before=${cutoff}`, "HEAD"]));
    const objectStats = await this.gitRaw(["count-objects", "-v"]);
    const looseKiB = Number(objectStats.match(/^size: (\d+)$/m)?.[1] ?? 0);
    const packedKiB = Number(objectStats.match(/^size-pack: (\d+)$/m)?.[1] ?? 0);
    return { cutoff, branch, head, totalCommits, oldCommits, localSizeMiB: (looseKiB + packedKiB) / 1024 };
  }

  async slimLocalHistory(): Promise<{ before: LocalHistoryPreview; after: LocalHistoryPreview }> {
    let result: { before: LocalHistoryPreview; after: LocalHistoryPreview } | undefined;
    await this.enqueueDesktopGit(async () => {
      const before = await this.inspectLocalHistory();
      if (before.oldCommits === 0) {
        result = { before, after: before };
        return false;
      }
      await this.git(["fetch", `--shallow-since=${before.cutoff}`, "--no-tags", "origin", `refs/heads/${before.branch}`], true);
      const remoteLine = await this.git(["ls-remote", "--exit-code", "origin", `refs/heads/${before.branch}`], true);
      if (remoteLine.split(/\s+/)[0] !== before.head) {
        throw new Error("清理期间 GitHub 分支发生变化，已停止删除旧对象；请先同步后重试");
      }
      await this.git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
      await this.git(["gc", "--prune=now"]);
      const after = await this.inspectLocalHistory();
      result = { before, after };
    }, "本地历史瘦身");
    if (!result) throw new Error("本地历史瘦身未返回结果");
    return result;
  }

  private async getUnpushedCommitWindow(): Promise<{ oldestAt: number; latestAt: number } | null> {
    if (!(await this.hasDesktopHead())) return null;
    const remoteRef = `refs/remotes/origin/${this.settings.gitBranch}`;
    let range = "HEAD";
    try {
      await this.git(["show-ref", "--verify", "--quiet", remoteRef]);
      range = `${remoteRef}..HEAD`;
    } catch {
      // 远端分支尚不存在时，本机全部 Commit 都属于待 Push。
    }
    const output = (await this.gitRaw(["log", "--reverse", "--format=%ct", range])).trim();
    if (!output) return null;
    const timestamps = output
      .split(/\r?\n/)
      .map((value) => Number(value) * 1000)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (timestamps.length === 0) return null;
    return { oldestAt: timestamps[0], latestAt: timestamps[timestamps.length - 1] };
  }

  private async resumeDesktopDirtyState(): Promise<void> {
    try {
      const interrupted = await this.getInterruptedGitOperation();
      const conflicts = await this.getUnmergedPaths();
      if (interrupted || conflicts.length > 0) {
        this.setStatus(
          conflicts.length > 0
            ? `有 ${conflicts.length} 个合并冲突等待处理`
            : `检测到未完成的 ${interrupted?.label ?? "Git 操作"}`
        );
        await this.refreshSyncView();
        return;
      }
      const hasChanges = await this.hasDesktopChanges();
      if (hasChanges) {
        this.scheduleDesktopCommit();
      }
      const unpushed = await this.getUnpushedCommitWindow();
      if (unpushed) {
        this.scheduleDesktopPush();
      }
    } catch {
      // 仓库尚未完成配置时，不启动自动 Commit 计时。
    }
  }

  private async getInterruptedGitOperation(): Promise<InterruptedGitOperation | null> {
    const operations: InterruptedGitOperation[] = [
      { ref: "REBASE_HEAD", label: "Rebase", abortArgs: ["rebase", "--abort"] },
      { ref: "MERGE_HEAD", label: "Merge", abortArgs: ["merge", "--abort"] },
      { ref: "CHERRY_PICK_HEAD", label: "Cherry-pick", abortArgs: ["cherry-pick", "--abort"] },
      { ref: "REVERT_HEAD", label: "Revert", abortArgs: ["revert", "--abort"] }
    ];
    for (const operation of operations) {
      try {
        await this.git(["rev-parse", "--verify", "-q", operation.ref]);
        return operation;
      } catch {
        // 该操作没有处于进行中。
      }
    }
    return null;
  }

  async getInterruptedGitOperationLabel(): Promise<string | null> {
    if (!this.settings.setupComplete) throw new Error("请先完成首次使用引导");
    await this.ensureDesktopGit();
    return (await this.getInterruptedGitOperation())?.label ?? null;
  }

  private async restoreRecoveryStash(recoveryStash: string): Promise<void> {
    try {
      await this.git(["stash", "apply", recoveryStash]);
    } catch (error) {
      const conflicts = await this.getUnmergedPaths();
      if (conflicts.length === 0) throw error;
      for (const path of conflicts) {
        try {
          // Stash Apply 中 theirs 是修复前保存的最新本机内容。
          await this.git(["checkout", "--theirs", "--", path]);
          await this.git(["add", "--", path]);
        } catch (checkoutError) {
          try {
            await this.git(["cat-file", "-e", `:3:${path}`]);
          } catch {
            await this.git(["rm", "-f", "--", path]);
            continue;
          }
          throw checkoutError;
        }
      }
      const remaining = await this.getUnmergedPaths();
      if (remaining.length > 0) {
        throw new Error(`仍有 ${remaining.length} 个本机恢复冲突无法自动处理；备份保留在 ${recoveryStash}`);
      }
    }
    await this.git(["stash", "drop", recoveryStash]);
  }

  async repairInterruptedGitOperation(): Promise<GitRepairResult> {
    let result: GitRepairResult | undefined;
    await this.enqueueDesktopGit(async () => {
      await this.ensureDesktopGit();
      const operation = await this.getInterruptedGitOperation();
      if (!operation) throw new Error("没有检测到可自动修复的未完成 Git 操作");

      const hadChanges = await this.hasDesktopChanges();
      let recoveryStash = "";
      if (hadChanges) {
        const message = `同步与分享 repair backup ${new Date().toISOString()}`;
        await this.git(["stash", "push", "--include-untracked", "-m", message]);
        recoveryStash = (await this.git(["stash", "list", "-1", "--format=%gd"])).trim();
        if (!recoveryStash) throw new Error("无法建立本机修改的恢复备份，已停止修复");
      }

      try {
        await this.git(operation.abortArgs);
      } catch (error) {
        if (recoveryStash) {
          try {
            await this.restoreRecoveryStash(recoveryStash);
          } catch {
            throw new Error(
              `${operation.label} 退出失败；本机修改仍保存在 ${recoveryStash}，请不要手动删除该备份。原始错误：${messageOf(error)}`
            );
          }
        }
        throw error;
      }

      if (recoveryStash) {
        try {
          await this.restoreRecoveryStash(recoveryStash);
        } catch (error) {
          throw new Error(
            `${operation.label} 已退出，但恢复本机修改时需要人工处理；完整备份仍保存在 ${recoveryStash}。${messageOf(error)}`
          );
        }
      }

      if (await this.hasDesktopHead()) {
        try {
          await this.git(["symbolic-ref", "--quiet", "HEAD"]);
        } catch {
          throw new Error(`${operation.label} 已退出，但仓库仍处于 detached HEAD，请人工检查后再同步`);
        }
      }
      const commitResult = await this.desktopCommitOnly();
      if (commitResult.committed) this.scheduleDesktopPush();
      await this.desktopFetchAndMerge();
      result = { operation: operation.label, restoredLocalChanges: hadChanges };
      await this.refreshSyncView();
    }, "异常修复");
    if (!result) throw new Error("异常修复没有返回结果");
    return result;
  }

  private async ensureNormalGitState(): Promise<void> {
    const operation = await this.getInterruptedGitOperation();
    if (operation) {
      throw new Error(`检测到未完成的 ${operation.label}，自动 Commit、Merge 和 Push 已暂停`);
    }
    const unmergedPaths = await this.getUnmergedPaths();
    if (unmergedPaths.length > 0) {
      throw new Error(`检测到 ${unmergedPaths.length} 个尚未解决的 Git 冲突，自动 Commit、Merge 和 Push 已暂停`);
    }
    if (await this.hasDesktopHead()) {
      try {
        await this.git(["symbolic-ref", "--quiet", "HEAD"]);
      } catch {
        throw new Error("当前处于 detached HEAD，自动 Commit、Merge 和 Push 已暂停");
      }
    }
  }

  async openSyncView(refreshExisting = true): Promise<void> {
    if (!this.settings.enabled) {
      new Notice("同步与分享已关闭，请先在设置中启用");
      return;
    }
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(ZoeySyncView.type)[0] ?? null;
    const existing = !!leaf;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: ZoeySyncView.type, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (existing && refreshExisting) await this.refreshSyncView();
  }

  async reviewLightweightDifferences(live: LiveReview): Promise<Record<string, ConflictChoice> | null> {
    await this.openSyncView(false);
    const leaf = this.app.workspace.getLeavesOfType(ZoeySyncView.type)[0];
    if (!(leaf?.view instanceof ZoeySyncView)) throw new Error("无法打开轻量同步确认侧栏");
    // 首次接入从设置页进入，先让出侧栏的交互区域。
    (this.app as App & { setting?: { close(): void } }).setting?.close();
    return await leaf.view.reviewDifferences(live);
  }

  async refreshSyncView(): Promise<void> {
    const views = this.app.workspace
      .getLeavesOfType(ZoeySyncView.type)
      .map((leaf) => leaf.view)
      .filter((view): view is ZoeySyncView => view instanceof ZoeySyncView);
    await Promise.all(views.map((view) => view.render()));
  }

  async toggleViewLayout(): Promise<void> {
    this.settings.viewLayout = this.settings.viewLayout === "list" ? "tree" : "list";
    await this.saveSettings();
    await this.refreshSyncView();
  }

  getChangeViewMode(): ChangeViewMode {
    return "upload";
  }

  openPluginSettings(): void {
    const appWithSettings = this.app as App & {
      setting: {
        open(): void;
        openTabById(id: string): void;
      };
    };
    appWithSettings.setting.open();
    appWithSettings.setting.openTabById(this.manifest.id);
    this.openSettings?.();
  }

  needsLightweightBaseline(): boolean {
    return this.useLightweightSync() && this.settings.mobile.mode === "github" &&
      this.settings.mobile.bound && !this.getMobileGithub().state.baseCommitSha;
  }

  getLightweightPendingStatus(): ViewStatusState | undefined {
    if (!this.useLightweightSync() || this.settings.mobile.mode !== "github") return undefined;
    if (!this.settings.mobile.bound) return { tone: "pending", text: "轻量同步尚未接入" };
    const verification = this.mobileGithub?.state.downloadVerification;
    if (verification) return { tone: "pending", text: `下载${verification.phase === "verifying" ? "验证" : "同步"}未完成 · 保留原基准 · 点击同步继续恢复` };
    if (this.needsLightweightBaseline()) return { tone: "pending", text: "尚未建立同步基准 · 需核对云端" };
    return undefined;
  }

  async getChanges(mode: ChangeViewMode = this.getChangeViewMode()): Promise<ChangeItem[]> {
    if (Platform.isMobile && !this.settings.mobileSyncEnabled) return [];
    if (this.useLightweightSync()) {
      if (this.settings.mobile.mode === "github") {
        if (!this.settings.mobile.bound || this.syncing || this.needsLightweightBaseline() || this.getMobileGithub().state.downloadVerification) return [];
        const changes = this.getMobileGithub().cachedChanges(this.app.vault.getFiles().map(file => file.path));
        return changes.map((change) => ({ path: change.currentPath ?? change.basePath!,
          oldPath: change.status === "renamed" ? change.basePath! : undefined,
          kind: change.status === "renamed" ? "moved" : change.status }));
      }
      return [...this.settings.inFlight, ...this.settings.dirty].map((entry) => ({
        path: entry.path,
        oldPath: entry.fromPath,
        kind:
          entry.type === "add"
            ? "added"
            : entry.type === "delete"
              ? "deleted"
              : entry.type === "move"
                ? "moved"
                : "modified"
      }));
    }
    if (!this.nativeGitEnabled() || !this.settings.setupComplete) return [];
    if (mode === "commit") return parseGitStatus(await this.gitRaw(["status", "--porcelain=v1", "-z"]));
    return await this.getPendingUploadChanges();
  }

  async getLatestCommitAt(): Promise<number> {
    if (!this.nativeGitEnabled() || !this.settings.setupComplete) return 0;
    try {
      const seconds = Number((await this.gitRaw(["log", "-1", "--format=%ct"])).trim());
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    } catch {
      return 0;
    }
  }

  private async getPendingUploadChanges(): Promise<ChangeItem[]> {
    const remoteRef = `refs/remotes/origin/${this.settings.gitBranch}`;
    let hasRemoteRef = false;
    try {
      await this.git(["show-ref", "--verify", "--quiet", remoteRef]);
      hasRemoteRef = true;
    } catch {
      // 远端分支尚不存在时，所有当前本机文件都属于待上传内容。
    }
    const tracked = hasRemoteRef
      ? parseGitNameStatus(await this.gitRaw(["diff", "--name-status", "-z", "--find-renames", remoteRef]))
      : await this.getInitialUploadChanges();
    const knownPaths = new Set(tracked.map((change) => change.path));
    const untracked = (await this.gitRaw(["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean)
      .filter((path) => !knownPaths.has(path))
      .map((path): ChangeItem => ({ path, kind: "added" }));
    return [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path));
  }

  private async getInitialUploadChanges(): Promise<ChangeItem[]> {
    const deletedPaths = new Set(
      parseGitStatus(await this.gitRaw(["status", "--porcelain=v1", "-z"]))
        .filter((change) => change.kind === "deleted")
        .map((change) => change.path)
    );
    return (await this.gitRaw(["ls-files", "--cached", "-z"]))
      .split("\0")
      .filter(Boolean)
      .filter((path) => !deletedPaths.has(path))
      .map((path) => ({ path, kind: "added" }));
  }

  isSyncing(): boolean {
    return this.syncing || this.desktopTaskActive;
  }

  private registerMobileEvents(): void {
    const apiEvent = (type: "create" | "modify" | "delete" | "rename", file: TAbstractFile, oldPath?: string): void => {
      if (this.settings.mobile.mode !== "github") return;
      // Vault initialization reports existing files as create events. They are
      // not edits; the next stat/hash scan checks them after layout is ready.
      if (!this.app.workspace.layoutReady) return;
      const engine = this.getMobileGithub();
      if (!engine.allowed(file.path) && (!oldPath || !engine.allowed(oldPath))) return;
      engine.event(type, file.path, oldPath);
      void engine.save().catch((error) => this.recordError("路径记录", error));
      this.scheduleViewRefresh();
    };
    this.trackFeatureEvent(this.app.vault.on("create", (file) => apiEvent("create", file)));
    this.trackFeatureEvent(this.app.vault.on("modify", (file) => apiEvent("modify", file)));
    this.trackFeatureEvent(this.app.vault.on("delete", (file) => apiEvent("delete", file)));
    this.trackFeatureEvent(this.app.vault.on("rename", (file, oldPath) => apiEvent("rename", file, oldPath)));
    const record = (file: TAbstractFile, type: "add" | "modify" | "delete") => {
      if (!(file instanceof TFile)) return;
      void this.recordDirty({ type, path: file.path });
    };
    this.trackFeatureEvent(this.app.vault.on("create", (file) => record(file, "add")));
    this.trackFeatureEvent(this.app.vault.on("modify", (file) => record(file, "modify")));
    this.trackFeatureEvent(this.app.vault.on("delete", (file) => record(file, "delete")));
    this.trackFeatureEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        void this.recordDirty({ type: "move", fromPath: oldPath, path: file.path });
      })
    );
  }

  private async recordDirty(entry: DirtyEntry): Promise<void> {
    if (this.settings.mobile.mode === "github") return;
    if (
      shouldIgnore(entry.path, this.settings.ignorePatterns, this.app.vault.configDir) ||
      (entry.fromPath && shouldIgnore(entry.fromPath, this.settings.ignorePatterns, this.app.vault.configDir))
    ) return;
    if (this.suppressPaths.has(entry.path) || (entry.fromPath && this.suppressPaths.has(entry.fromPath))) return;
    this.settings.dirty = coalesceDirty(this.settings.dirty, entry);
    await this.saveSettings();
    this.setStatus(`${this.settings.dirty.length} 项待同步`);
    await this.refreshSyncView();
  }

  private validateServerSettings(): void {
    if (!this.settings.serverUrl || !this.settings.serverPassword) {
      throw new Error("请先填写服务器地址和认证密码");
    }
    const url = new URL(this.settings.serverUrl);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new Error("公网服务器必须使用 HTTPS");
  }

  private async serverRequest<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    this.validateServerSettings();
    const url = `${this.settings.serverUrl.replace(/\/$/, "")}${path}`;
    try {
      const response = await requestUrl({
        url,
        method,
        headers: {
          Authorization: `Bearer ${this.settings.serverPassword}`,
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined,
        throw: false
      });
      const data = response.json as T & { error?: string; details?: unknown };
      if (response.status < 200 || response.status >= 300) {
        const details = data.details ? `：${JSON.stringify(data.details)}` : "";
        throw new Error(`${data.error ?? `HTTP ${response.status}`}${details}`);
      }
      return data;
    } catch (error) {
      throw new Error(`服务器请求失败：${messageOf(error)}`);
    }
  }

  private platformName(): "ios" | "android" | "desktop" | "unknown" {
    if (!Platform.isMobile) return "desktop";
    if (Platform.isIosApp) return "ios";
    if (Platform.isAndroidApp) return "android";
    return "unknown";
  }

  async registerMobile(): Promise<void> {
    if (this.settings.mobile.mode !== "server") return;
    if (!this.settings.enabled || !Platform.isMobile || !this.settings.serverUrl || !this.settings.serverPassword) return;
    await this.serverRequest<{ currentVersion: number }>("POST", "/v1/devices/register", {
      deviceId: this.settings.deviceId,
      name: this.settings.deviceName,
      platform: this.platformName()
    });
    this.setStatus(`已连接 · v${this.settings.baseVersion}`);
  }

  async testConnection(showNotice: boolean): Promise<void> {
    try {
      if (this.useLightweightSync()) {
        if (this.settings.mobile.mode === "github") await this.getMobileGithub().verify();
        else { this.validateServerSettings(); await this.registerMobile(); }
      } else {
        if (!this.settings.setupComplete) throw new Error("请先完成首次使用引导");
        await this.testDesktopGit();
      }
      if (showNotice) new Notice(`同步与分享：${this.useLightweightSync() ? this.settings.mobile.mode === "github" ? "GitHub API" : "服务器" : "Git"}连接正常`);
    } catch (error) {
      await this.recordError("测试连接", error);
      if (showNotice) new Notice(`同步与分享：${messageOf(error)}`, 8000);
      throw error;
    }
  }

  async syncNow(showNotice: boolean): Promise<void> {
    if (this.host.share?.busy) { if (showNotice) new Notice("笔记分享正在发布，请稍后同步主库。"); return; }
    if (legacySyncRunning(this.app)) { if (showNotice) new Notice("请先关闭旧 Simple Link 的同步。"); return; }
    if (!this.useLightweightSync() && !this.nativeGitEnabled()) { if (showNotice) new Notice("当前设备同步已关闭"); return; }
    if (!this.useLightweightSync() && !this.settings.setupComplete) {
      if (showNotice) new Notice("请先完成「从零开始的 Git 同步使用指南」");
      return;
    }
    if (!this.settings.enabled) {
      if (showNotice) new Notice("同步与分享已关闭，请先在设置中启用");
      return;
    }
    if (this.syncing) {
      if (showNotice) new Notice("同步与分享：已有同步任务正在运行");
      return;
    }
    this.syncing = true;
    this.setStatus(this.useLightweightSync() ? "正在同步…" : "准备检查本机修改…");
    try {
      if (this.useLightweightSync()) {
        if (this.settings.mobile.mode === "github") {
          const engine = this.getMobileGithub();
          const plan = await engine.preview();
          if (showNotice) {
            if (!await new MobileSyncModal(this.app, engine, plan, false, live => this.reviewLightweightDifferences(live)).wait()) return;
          } else {
            if (!engine.state.baseCommitSha || plan.conflicts.length || plan.localDeletes.length || plan.remoteDeletes.length) {
              throw new SyncDeferredError("有首次配对、冲突或删除待确认，请手动预览同步。");
            }
            await engine.execute(plan);
          }
        } else await this.mobileSync();
        this.settings.lastSyncAt = Date.now();
        await this.saveSettings();
        this.setStatus(this.settings.mobile.mode === "github" ? "GitHub API · 两端已对齐" : `已同步 · v${this.settings.baseVersion}`);
      } else {
        await this.enqueueDesktopGit(() => this.desktopGitSync());
        this.setStatus("同步检查完成");
      }
      await this.recordSuccess(showNotice ? "手动同步" : "自动同步", "同步检查完成");
      if (showNotice) new Notice("同步与分享：同步完成");
    } catch (error) {
      if (error instanceof SyncDeferredError) {
        this.setStatus(error.message);
        if (showNotice) new Notice(error.message);
        return;
      }
      if (!this.useLightweightSync()) await this.scheduleDesktopPushRetry();
      await this.recordError(showNotice ? "手动同步" : "自动同步", error);
      this.setStatus(this.useLightweightSync() ? "同步失败" : "同步失败 · 5 分钟后重试");
      if (showNotice) new Notice(`同步与分享：${messageOf(error)}`, 10000);
      else console.error("同步与分享", error);
    } finally {
      this.syncing = false;
      this.clearSyncActivity();
      await this.refreshSyncView();
    }
  }

  async commitNow(showNotice: boolean): Promise<void> {
    if (legacySyncRunning(this.app)) { if (showNotice) new Notice("请先关闭旧 Simple Link 的同步。"); return; }
    if (this.nativeGitEnabled() && !this.settings.setupComplete) {
      if (showNotice) new Notice("请先完成「从零开始的 Git 同步引导」");
      return;
    }
    if (!this.settings.enabled) {
      if (showNotice) new Notice("同步与分享已关闭，请先在设置中启用");
      return;
    }
    if (!this.nativeGitEnabled()) {
      if (showNotice) new Notice("当前模式不使用原生 Git commit；请使用预览并同步");
      return;
    }
    if (this.syncing) {
      if (showNotice) new Notice("同步与分享：已有任务正在运行");
      return;
    }
    this.syncing = true;
    this.setStatus("Commit 中…");
    await this.refreshSyncView();
    try {
      let result: DesktopCommitResult = { committed: false };
      await this.enqueueDesktopGit(async () => {
        result = await this.desktopCommitOnly();
      });
      if (result.committed) this.scheduleDesktopPush();
      this.setStatus(result.committed ? "已 Commit" : "没有可 Commit 文件");
      if (showNotice) {
        new Notice(result.committed ? "同步与分享：Commit 完成" : "同步与分享：没有可 Commit 文件");
      }
    } catch (error) {
      await this.recordError("手动 Commit", error);
      this.setStatus("Commit 失败");
      if (showNotice) new Notice(`同步与分享：${messageOf(error)}`, 10000);
    } finally {
      this.syncing = false;
      await this.refreshSyncView();
    }
  }

  private async buildOperations(entries: DirtyEntry[]): Promise<Record<string, unknown>[]> {
    const operations: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (entry.type === "add" || entry.type === "modify") {
        if (!(await this.app.vault.adapter.exists(entry.path))) {
          operations.push({ type: "delete", path: entry.path });
          continue;
        }
        const content = await this.app.vault.adapter.readBinary(entry.path);
        operations.push({ type: "upsert", path: entry.path, contentBase64: arrayBufferToBase64(content) });
      } else if (entry.type === "move") {
        operations.push({ type: "move", path: entry.path, fromPath: entry.fromPath });
      } else {
        operations.push({ type: "delete", path: entry.path });
      }
    }
    return operations;
  }

  private async mobileSync(): Promise<void> {
    await this.registerMobile();
    if (this.settings.inFlight.length === 0 && this.settings.dirty.length > 0) {
      this.settings.inFlight = this.settings.dirty;
      this.settings.dirty = [];
      this.settings.pendingRequestId = crypto.randomUUID();
      await this.saveSettings();
    }
    if (!this.settings.pendingRequestId) this.settings.pendingRequestId = crypto.randomUUID();
    const operations = await this.buildOperations(this.settings.inFlight);
    await this.saveSettings();
    const response = await this.serverRequest<{
      baseVersion: number;
      actions: ServerAction[];
      commands: ServerCommand[];
      gitWarning?: string;
    }>("POST", "/v1/sync", {
      deviceId: this.settings.deviceId,
      requestId: this.settings.pendingRequestId,
      baseVersion: this.settings.baseVersion,
      operations
    });

    const newDirtyPaths = new Set(this.settings.dirty.flatMap((entry) => [entry.path, entry.fromPath ?? ""]));
    const overlap = response.actions.map((action) => action.path).filter((path) => newDirtyPaths.has(path));
    if (overlap.length > 0) {
      this.settings.inFlight = [];
      this.settings.pendingRequestId = "";
      await this.saveSettings();
      throw new Error(`同步期间这些文件又被修改，请再次同步处理冲突：${overlap.join(", ")}`);
    }

    await this.applyServerActions(response.actions);
    await this.serverRequest("POST", "/v1/sync/ack", {
      deviceId: this.settings.deviceId,
      version: response.baseVersion
    });
    this.settings.baseVersion = response.baseVersion;
    this.settings.inFlight = [];
    this.settings.pendingRequestId = "";
    await this.saveSettings();
    const triggerSync = await this.handleCommands(response.commands ?? []);
    if (response.gitWarning) new Notice(`同步与分享：GitHub 暂时不可用，本地服务器同步已完成`, 7000);
    if (triggerSync) window.setTimeout(() => void this.syncNow(false), 250);
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  private async applyServerActions(actions: ServerAction[]): Promise<void> {
    for (const action of actions) this.suppressPaths.add(action.path);
    try {
      for (const action of actions) {
        if (action.type === "delete") {
          if (await this.app.vault.adapter.exists(action.path)) await this.app.vault.adapter.remove(action.path);
        } else {
          if (!action.contentBase64) throw new Error(`服务器缺少文件内容：${action.path}`);
          await this.ensureParent(action.path);
          await this.app.vault.adapter.writeBinary(action.path, base64ToArrayBuffer(action.contentBase64));
        }
      }
    } finally {
      window.setTimeout(() => {
        for (const action of actions) this.suppressPaths.delete(action.path);
      }, 2000);
    }
  }

  private async pollCommands(): Promise<void> {
    if (!Platform.isMobile || !this.settings.serverUrl || !this.settings.serverPassword) return;
    try {
      const result = await this.serverRequest<{ commands: ServerCommand[] }>(
        "GET",
        `/v1/commands?deviceId=${encodeURIComponent(this.settings.deviceId)}`
      );
      const triggerSync = await this.handleCommands(result.commands);
      if (triggerSync) void this.syncNow(false);
    } catch (error) {
      console.error("同步与分享 command poll", error);
      await this.recordError("指令检查", error);
    }
  }

  private async handleCommands(commands: ServerCommand[]): Promise<boolean> {
    if (!commands.length) return false;
    const acknowledged: string[] = [];
    let triggerSync = false;
    for (const command of commands) {
      try {
        if (command.kind === "notice") {
          new Notice(`${command.title}${command.body ? `\n${command.body}` : ""}`, 8000);
        } else if (command.kind === "sync") {
          new Notice(command.title || "服务器要求同步");
          triggerSync = true;
        } else if (command.kind === "open_file") {
          const path = command.payload.path;
          if (typeof path !== "string" || !path) throw new Error("open_file 指令缺少 path");
          await this.app.workspace.openLinkText(path, "", false);
          new Notice(command.title || `已打开 ${path}`);
        }
        acknowledged.push(command.id);
      } catch (error) {
        new Notice(`同步与分享 指令失败：${messageOf(error)}`, 8000);
      }
    }
    if (acknowledged.length) {
      await this.serverRequest("POST", "/v1/commands/ack", {
        deviceId: this.settings.deviceId,
        ids: acknowledged
      });
    }
    return triggerSync;
  }

  getSetupPreview(): SetupPreview | undefined { return this.setupPreview; }
  getSetupChoices(): Record<string, OverlapChoice> { return { ...this.setupChoices }; }
  setSetupChoice(path: string, choice: OverlapChoice): void {
    this.setupChoices[path] = choice;
    if (path === ".gitignore" && this.setupPreview) {
      this.setupPreview.customIgnore = undefined;
      applySetupIgnoreBase(this.setupPreview, choice, this.app.vault.configDir);
      this.setupTrackingChoice = undefined;
    }
  }
  setSetupIgnoreMerge(text: string): void {
    if (!this.setupPreview) throw new Error("请先检查两端文件。");
    this.setupPreview.customIgnore = text;
    this.setupChoices[".gitignore"] = "local";
    applySetupIgnoreBase(this.setupPreview, "local", this.app.vault.configDir);
    this.setupTrackingChoice = undefined;
  }
  getSetupTrackingChoice(): "keep" | "rebuild" | undefined { return this.setupTrackingChoice; }
  setSetupTrackingChoice(choice: "keep" | "rebuild" | undefined): void { this.setupTrackingChoice = choice; }
  getVaultBasePath(): string { return this.vaultBasePath(); }
  async readSetupOverlap(path: string): Promise<SetupOverlapContent> {
    if (!this.settings.setupVerified || !this.setupPreview) throw new Error("请先检查本地与远端文件");
    return this.setup().readOverlap(this.settings.setupVerified, this.setupPreview, path);
  }

  private setup(): GitSetup {
    return new GitSetup(this.vaultBasePath(), (program, args, timeoutMs, onOutput, stdinText, signal) =>
      this.exec(program, args, program === "git" && (args[0] === "fetch" || args[0] === "push"), true, timeoutMs, onOutput, stdinText, signal), this.app.vault.configDir);
  }

  async inspectFileTracking(): Promise<FileTrackingPreview> {
    if (Platform.isMobile || !this.settings.setupComplete) throw new Error("请先完成电脑端 Git 接入");
    const nodeRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    if (!nodeRequire) throw new Error("文件追踪检查仅支持电脑端");
    const fs = (nodeRequire("fs") as typeof import("fs")).promises;
    const path = nodeRequire("path") as typeof import("path");
    const vaultPath = this.vaultBasePath();
    const root = (await this.gitRaw(["rev-parse", "--show-toplevel"])).trim();
    if ((await fs.realpath(root)).toLowerCase() !== (await fs.realpath(vaultPath)).toLowerCase()) {
      throw new Error("当前 Vault 不是独立的 Git 仓库，无法修复文件追踪");
    }
    await this.ensureNormalGitState();
    let existingIgnore = "";
    try { existingIgnore = await fs.readFile(path.join(vaultPath, ".gitignore"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const tracked = (await this.gitRaw(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean);
    const ignored = (await this.gitRaw(["ls-files", "-ci", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const nestedRepos = await findNestedRepos(vaultPath, this.app.vault.configDir);
    const nestedData = new Set((await nestedRepoFiles(vaultPath, nestedRepos, (args) => this.gitRaw(args), this.app.vault.configDir))
      .filter((name) => nestedRepos.some((repo) => name === `${repo.directory}/data.json`)));
    const paths = [...new Set([
      ...ignored.filter((file) => !nestedData.has(file)),
      ...tracked.filter((file) => shouldIgnore(file, setupGitIgnore(this.app.vault.configDir), this.app.vault.configDir))
    ])].filter((file) => file !== ".gitignore").sort();
    return { paths, missingRules: missingSetupIgnoreRules(existingIgnore, this.app.vault.configDir) };
  }

  async repairFileTracking(preview: FileTrackingPreview): Promise<number> {
    let repaired = 0;
    await this.enqueueDesktopGit(async () => {
      const current = await this.inspectFileTracking();
      if (JSON.stringify(current) !== JSON.stringify(preview)) throw new Error("文件追踪状态已变化，请重新检查后再修复");
      await this.setup().appendIgnore([]);
      const ignored = (await this.gitRaw(["ls-files", "-ci", "--exclude-standard", "-z"])).split("\0").filter((file) => file && file !== ".gitignore");
      if (preview.paths.some((file) => !ignored.includes(file))) throw new Error("部分文件仍未被 .gitignore 排除，已停止移除 Git 跟踪");
      for (const batch of pathBatches(preview.paths)) await this.git(["rm", "-f", "--cached", "--", ...batch]);
      repaired = preview.paths.length;
      return repaired > 0 || preview.missingRules.length > 0;
    }, "修复文件追踪");
    return repaired;
  }

  async beginSetup(): Promise<void> {
    if (this.syncing) throw new Error("当前有同步任务正在运行，请稍后重试");
    await this.desktopGitQueue;
    this.settings.setupBackup = {
      step: this.settings.setupStep,
      repoUrl: this.settings.setupRepoUrl,
      verified: this.settings.setupVerified
    };
    this.settings.setupComplete = false;
    this.settings.setupMutationStarted = false;
    this.settings.setupStep = 1;
    this.settings.setupVerified = undefined;
    this.setupPreview = undefined;
    this.setupChoices = {};
    this.setupTrackingChoice = undefined;
    this.clearDesktopTimeouts();
    for (const interval of this.featureIntervals) window.clearInterval(interval);
    this.featureIntervals = [];
    await this.saveSettings();
    await this.refreshSyncView();
  }

  async cancelSetup(): Promise<void> {
    const backup = this.settings.setupBackup;
    if (!backup) throw new Error("没有可恢复的旧同步配置");
    if (this.settings.setupMutationStarted) throw new Error("接入已开始修改本地 Git 状态；请完成接入或先手动检查 Git 状态，不能直接恢复自动同步。");
    this.settings.setupStep = backup.step;
    this.settings.setupRepoUrl = backup.repoUrl;
    this.settings.setupVerified = backup.verified;
    this.settings.setupComplete = true;
    this.settings.setupBackup = undefined;
    this.settings.setupMutationStarted = false;
    this.setupPreview = undefined;
    this.setupChoices = {};
    this.setupTrackingChoice = undefined;
    await this.saveSettings();
    await this.restartDesktopAutomation();
    this.setStatus("桌面端 · Git 模式");
    await this.refreshSyncView();
  }

  async authorizeSetup(onCode?: (code: string) => void, signal?: AbortSignal): Promise<void> {
    await this.setup().login(onCode, signal);
    await this.detectDesktopGitDefaults();
  }

  async authorizeSetupWithToken(token: string): Promise<void> {
    await this.setup().loginWithToken(token);
    await this.detectDesktopGitDefaults();
    this.settings.setupStep = Math.max(this.settings.setupStep, 2);
    await this.saveSettings();
  }

  async checkSetupAuthorization(): Promise<void> {
    await this.setup().checkTools();
    await this.setup().checkLogin();
    await this.detectDesktopGitDefaults();
    this.settings.setupStep = Math.max(this.settings.setupStep, 2);
    await this.saveSettings();
  }

  async createSetupRepository(name: string): Promise<void> {
    const url = await this.setup().createRepository(name);
    this.settings.setupRepoUrl = url;
    await this.saveSettings();
    await this.verifySetupRepository(url);
  }

  async verifySetupRepository(url: string): Promise<void> {
    const verified = await this.setup().verifyRepository(url);
    this.settings.setupRepoUrl = verified.url;
    this.settings.setupVerified = verified;
    this.settings.setupStep = 3;
    this.setupPreview = undefined;
    this.setupChoices = {};
    this.setupTrackingChoice = undefined;
    await this.saveSettings();
  }

  async inspectSetupRepository(onProgress?: (message: string) => void): Promise<void> {
    const repoUrl = this.settings.setupVerified?.url || this.settings.setupRepoUrl;
    if (!repoUrl) throw new Error("请先填写并核验私人仓库地址");
    onProgress?.("正在确认仓库与访问权限…");
    const verified = this.settings.setupComplete || !this.settings.setupVerified
      ? await this.setup().verifyRepository(repoUrl)
      : this.settings.setupVerified;
    this.settings.setupVerified = verified;
    this.setupPreview = await this.setup().preview(verified, onProgress);
    if (!this.settings.setupComplete) {
      this.setupChoices = {};
      this.setupTrackingChoice = undefined;
      this.settings.setupStep = 3;
      await this.saveSettings();
    }
  }

  async confirmSetupPreview(): Promise<void> {
    if (!this.setupPreview) throw new Error("请先检查本地与远端文件");
    if (setupIgnoreDiffers(this.setupPreview) && !this.setupChoices[".gitignore"]) {
      throw new Error("请先选择 .gitignore 基准。");
    }
    for (const path of this.setupPreview.overlaps) {
      if (!this.setupChoices[path]) throw new Error(`请选择同名文件的保留版本：${path}`);
    }
    if ((this.setupPreview.trackedExcludedLocal.length || this.setupPreview.trackedExcludedRemote.length) && !this.setupTrackingChoice) {
      throw new Error("请先选择如何处理已被 Git 跟踪的忽略文件。");
    }
    this.settings.setupStep = 4;
    await this.saveSettings();
  }

  async finishSetup(confirmedRebuildTracking = false, onProgress?: (message: string, error?: boolean) => void): Promise<void> {
    const verified = this.settings.setupVerified;
    const preview = this.setupPreview;
    if (!verified || !preview) throw new Error("请重新检查本地与远端内容");
    if ((preview.trackedExcludedLocal.length || preview.trackedExcludedRemote.length) && !this.setupTrackingChoice) {
      throw new Error("请先选择如何处理已被 Git 跟踪的忽略文件。");
    }
    if (this.setupTrackingChoice === "rebuild" && !confirmedRebuildTracking) {
      throw new Error("请先确认：停止跟踪后，本机文件保留，推送会从远端当前版本移除这些文件。");
    }
    let stage = "准备接入";
    const started = Date.now();
    const publishProgress = (): void => {
      const message = `首次接入 · ${stage}（已用时 ${Math.floor((Date.now() - started) / 1000)} 秒）`;
      const tone: ViewStatusTone = /Push|推送/.test(stage) ? "push" : /Merge：|合并本地/.test(stage) ? "merge" : /Fetch/.test(stage) ? "fetch" : /创建本地提交/.test(stage) ? "commit" : "checking";
      this.setSetupActivity(message, tone);
      onProgress?.(message);
    };
    publishProgress();
    const progressTimer = window.setInterval(publishProgress, 1000);
    try {
    const skippedPaths = await this.setup().finish(verified, preview, this.setupChoices, {
      name: this.settings.gitAuthorName,
      email: this.settings.gitAuthorEmail
    }, async () => {
      this.settings.setupMutationStarted = true;
      await this.saveSettings();
    }, new Set<string>(), this.setupTrackingChoice === "rebuild", current => {
      stage = current;
      publishProgress();
    });
    stage = "保存接入配置";
    publishProgress();
    preview.missingIgnoreRules = [];
    this.settings.gitRemoteUrl = verified.url;
    this.settings.gitBranch = verified.branch;
    this.settings.setupComplete = true;
    this.settings.setupBackup = undefined;
    this.settings.setupMutationStarted = false;
    await this.saveSettings();
    stage = "启用电脑端 Git 同步";
    publishProgress();
    await this.setDesktopSyncMode("git");
    if (!this.nativeGitEnabled()) throw new Error("当前同步仍在运行，请稍后启用电脑端 Git 同步。");
    this.setStatus(skippedPaths.length > 0
      ? `首次接入完成 · ${skippedPaths.length} 个预览后变化的文件留待后续 Commit`
      : "首次接入完成");
    if (skippedPaths.length > 0) new Notice(`首次推送成功；${skippedPaths.length} 个预览后变化的文件未提交，后续将自动 Commit。`, 10000);
    window.clearInterval(progressTimer);
    this.setSetupActivity("首次接入已成功 · 首次推送完成", "success");
    onProgress?.("首次接入已成功 · 首次推送完成");
    await this.refreshSyncView();
    this.setupActivity = undefined;
    } catch (error) {
      const message = `${stage}失败 · ${formatStatusError(explainSetupError(error))}`;
      this.setSetupActivity(message, "error");
      onProgress?.(message, true);
      throw error;
    } finally {
      window.clearInterval(progressTimer);
    }
  }

  private vaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("当前平台没有可用的本地 Vault 路径");
    return adapter.getBasePath();
  }

  private async detectDesktopGitDefaults(): Promise<void> {
    const needsAuthorName =
      !this.settings.gitAuthorName || this.settings.gitAuthorName === DEFAULT_GIT_AUTHOR_NAME;
    const needsAuthorEmail =
      !this.settings.gitAuthorEmail || this.settings.gitAuthorEmail === DEFAULT_GIT_AUTHOR_EMAIL;
    if (this.settings.gitRemoteUrl && !needsAuthorName && !needsAuthorEmail) return;
    try {
      // Missing origin or one author field must not block the other defaults.
      const [remote, branch, authorName, authorEmail] = await Promise.all([
        ["remote", "get-url", "origin"], ["branch", "--show-current"],
        ["config", "user.name"], ["config", "user.email"]
      ].map(args => this.git(args).then(value => value.trim()).catch(() => "")));
      if (!this.settings.gitRemoteUrl) this.settings.gitRemoteUrl = remote;
      if (branch) this.settings.gitBranch = branch;
      if (needsAuthorName && authorName) this.settings.gitAuthorName = authorName;
      if (needsAuthorEmail && authorEmail) this.settings.gitAuthorEmail = authorEmail;
      await this.saveSettings();
    } catch {
      // 尚未初始化 Git 时保留设置页默认值，由用户填写后再同步。
    }
  }

  async exec(program: string, args: string[], authenticated = false, trim = true, timeoutMs = 120000, onOutput?: (chunk: string) => void, stdinText?: string, signal?: AbortSignal): Promise<string> {
    if (this.host.share?.busy && program === "git" && !args.includes("-C") && args.some(arg => ["add", "commit", "push", "pull", "merge", "rebase", "reset", "checkout", "switch", "rm", "init", "clean", "stash", "update-index", "update-ref", "read-tree", "gc"].includes(arg))) throw new Error("笔记分享正在发布，主库 Git 修改暂缓。");
    if (program === "git" && args.some(arg => ["add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "checkout", "switch", "rm", "init", "clean", "stash", "update-index", "update-ref", "read-tree", "gc"].includes(arg)) && legacySyncRunning(this.app)) {
      throw new Error("旧 Simple Link 仍在运行，请先关闭旧同步，再操作新的 Git 引导。");
    }
    const nodeRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    if (!nodeRequire) throw new Error("当前平台不支持桌面命令");
    const childProcess = nodeRequire("child_process") as typeof import("child_process");
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (program === "git") env.GIT_TERMINAL_PROMPT = "0";
    if (program === "git" && authenticated) {
      // 本次 Git 命令直接向已登录的 gh 取凭据，避免系统 GCM 在自动同步时弹出登录窗口。
      env.GIT_CONFIG_COUNT = "2";
      env.GIT_CONFIG_KEY_0 = "credential.helper";
      env.GIT_CONFIG_VALUE_0 = "";
      env.GIT_CONFIG_KEY_1 = "credential.https://github.com.helper";
      env.GIT_CONFIG_VALUE_1 = "!gh auth git-credential";
    }
    return await new Promise((resolve, reject) => {
      const child = childProcess.execFile(
        program,
        args,
        { cwd: this.vaultBasePath(), env, windowsHide: true, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, signal },
        (error, stdout, stderr) => {
          if (error) {
            const diagnostic = (stderr || stdout || error.message).trim();
            const secret = stdinText?.trim();
            reject(new Error(secret ? diagnostic.split(secret).join("[hidden]") : diagnostic));
          }
          else resolve(trim ? stdout.trim() : stdout);
        }
      );
      if (onOutput) {
        child.stdout?.on("data", (chunk: string | Buffer) => onOutput(String(chunk)));
        child.stderr?.on("data", (chunk: string | Buffer) => onOutput(String(chunk)));
      }
      if (stdinText !== undefined) {
        child.stdin?.on("error", () => { /* command failure is handled by execFile callback */ });
        child.stdin?.end(stdinText);
      }
    });
  }

  private git(args: string[], authenticated = false): Promise<string> {
    return this.exec("git", args, authenticated);
  }

  private gitRaw(args: string[]): Promise<string> {
    return this.exec("git", args, false, false);
  }

  private async ensureDesktopGit(): Promise<void> {
    if (!this.settings.gitRemoteUrl) throw new Error("请填写 Git 仓库地址");
    if (!this.settings.gitAuthorName || !this.settings.gitAuthorEmail) {
      throw new Error("请填写 Git Author 名称和邮箱");
    }
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"]);
    } catch {
      await this.git(["init", "-b", this.settings.gitBranch]);
    }
    await this.git(["config", "user.name", this.settings.gitAuthorName]);
    await this.git(["config", "user.email", this.settings.gitAuthorEmail]);
    const remotes = await this.git(["remote"]);
    if (remotes.split(/\s+/).includes("origin")) {
      await this.git(["remote", "set-url", "origin", this.settings.gitRemoteUrl]);
    } else {
      await this.git(["remote", "add", "origin", this.settings.gitRemoteUrl]);
    }
  }

  private async testDesktopGit(): Promise<void> {
    await this.exec("git", ["--version"]);
    await this.ensureDesktopGit();
    await this.git(["ls-remote", "--heads", "origin", this.settings.gitBranch], true);
  }

  private async desktopGitSync(): Promise<void> {
    await this.desktopCommitOnly();
    await this.desktopFetchAndMerge(true);
    await this.desktopPushOnly(false);
  }

  private async desktopAutomaticPush(forceCommit = false): Promise<boolean> {
    if (forceCommit) {
      await this.desktopCommitOnly();
      this.resetDesktopCommitTracking();
      if (await this.hasDesktopChanges()) this.scheduleDesktopCommit();
    }
    return await this.desktopPushOnly();
  }

  private async desktopStartupSync(): Promise<boolean> {
    const result = await this.desktopCommitOnly();
    if (result.committed) this.scheduleDesktopPush();
    const merged = await this.desktopFetchAndMerge();
    await this.resumeDesktopDirtyState();
    return result.committed || merged;
  }

  private async desktopCommitOnly(): Promise<DesktopCommitResult> {
    this.setSyncActivity("正在检查本机修改…", "checking");
    await this.ensureDesktopGit();
    await this.ensureNormalGitState();
    assertNoPrivateSyncFiles((await this.gitRaw(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean), this.app.vault.configDir);
    await this.prepareNestedRepositories();
    const changes = parseGitStatus(await this.gitRaw(["status", "--porcelain=v1", "-z"]));
    if (changes.length === 0) {
      this.setStatus("本机没有需要 Commit 的修改");
      await this.refreshSyncView();
      return { committed: false };
    }
    this.setSyncActivity(`正在 Commit · ${changes.length} 个文件`, "commit");
    await this.git(["add", "-A"]);
    let committed = false;
    try {
      await this.git(["diff", "--cached", "--quiet"]);
    } catch {
      await this.git(["commit", "-m", `Zoey Commit: ${new Date().toISOString()}`]);
      committed = true;
    }
    if (committed) this.resetDesktopCommitTracking();
    this.setStatus(committed ? `已 Commit · ${changes.length} 个文件` : "本机没有需要 Commit 的修改");
    await this.refreshSyncView();
    return { committed };
  }

  private async prepareNestedRepositories(): Promise<void> {
    const vaultPath = this.vaultBasePath();
    const repos = await findNestedRepos(vaultPath, this.app.vault.configDir);
    if (!repos.length) return;
    const nodeRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    if (!nodeRequire) throw new Error("内嵌仓库同步仅支持桌面端");
    const fs = (nodeRequire("fs") as typeof import("fs")).promises;
    const path = nodeRequire("path") as typeof import("path");
    const ignorePath = path.join(vaultPath, ".gitignore");
    let existing = "";
    try { existing = await fs.readFile(ignorePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const missing = nestedGitIgnoreRules(repos).filter((rule) => !existing.split(/\r?\n/).includes(rule));
    if (missing.length) {
      const eol = existing.includes("\r\n") ? "\r\n" : "\n";
      const separator = existing ? `${existing.endsWith("\n") ? "" : eol}${eol}` : "";
      await fs.writeFile(ignorePath, `${existing}${separator}# Embedded Git metadata stays local${eol}${missing.join(eol)}${eol}`, "utf8");
    }
    await rebuildNestedRepoTracking(vaultPath, repos, (args) => this.gitRaw(args), this.app.vault.configDir);
  }

  private async desktopFetchAndMerge(pushAfterResolve = false): Promise<boolean> {
    this.setSyncActivity("正在检查云端更新…", "checking");
    await this.ensureDesktopGit();
    await this.ensureNormalGitState();
    this.setSyncActivity("正在 Fetch 云端更新…", "fetch");
    try {
      await this.traceDesktopGitStep("Git fetch（连接并下载远端分支）", () =>
        this.git(["fetch", "origin", this.settings.gitBranch], true)
      );
    } catch (error) {
      if (!isMissingRemoteRefError(error)) throw error;
      this.desktopGitTrace[this.desktopGitTrace.length - 1] = "Git fetch：远端分支不存在";
      this.setStatus("云端尚无分支 · 等待首次 Push");
      return false;
    }
    if (!(await this.hasDesktopHead())) {
      this.desktopGitTrace.push("合并检查：本机尚无 Commit");
      this.setStatus("已获取云端信息 · 等待首次 Commit");
      await this.recordSuccessfulPull();
      return false;
    }
    try {
      await this.git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"]);
      this.desktopGitTrace.push("合并检查：远端提交已包含在本机");
      this.deferredMergePaths = [];
      this.setStatus("云端已是最新");
      await this.recordSuccessfulPull();
      return false;
    } catch {
      // 远端有本机尚未包含的提交，只有此时才需要 Merge。
      this.desktopGitTrace.push("合并检查：远端有新提交");
    }
    const mergeBase = (await this.gitRaw(["merge-base", "HEAD", "FETCH_HEAD"])).trim();
    const localChanges = parseGitStatus(await this.gitRaw(["status", "--porcelain=v1", "-z"]));
    const remoteChanges = parseGitNameStatus(
      await this.gitRaw(["diff", "--name-status", "-z", "--find-renames", mergeBase, "FETCH_HEAD"])
    );
    const overlappingPaths = findRemoteChangeOverlaps(localChanges, remoteChanges);
    if (overlappingPaths.length > 0) {
      this.deferredMergePaths = overlappingPaths;
      const message = `同步暂缓 · ${overlappingPaths.length} 个文件仍在修改`;
      if (pushAfterResolve) await this.scheduleDesktopPushRetry(message);
      throw new SyncDeferredError(message);
    }
    this.deferredMergePaths = [];
    this.setSyncActivity("正在 Merge 云端更新…", "merge");
    try {
      await this.traceDesktopGitStep("Git merge（合并远端提交）", () => this.git(["merge", "--no-edit", "FETCH_HEAD"]));
    } catch (error) {
      const conflicts = await this.getUnmergedPaths();
      if (conflicts.length === 0) throw error;
      if (pushAfterResolve) {
        this.settings.pendingMergePushAfterResolve = true;
        await this.saveSettings();
      }
      await this.resolveMergeConflicts(conflicts);
    }
    this.setStatus("云端更新已合并");
    await this.recordSuccessfulPull();
    return true;
  }

  private async recordSuccessfulPull(): Promise<void> {
    this.settings.lastPullAt = Date.now();
    await this.saveSettings();
  }

  private async desktopPushOnly(fetchBeforePush = true): Promise<boolean> {
    await this.ensureDesktopGit();
    await this.ensureNormalGitState();
    if (fetchBeforePush) await this.desktopFetchAndMerge(true);
    await this.ensureNormalGitState();
    if (!(await this.getUnpushedCommitWindow())) {
      this.desktopGitTrace.push("上传检查：没有待上传 Commit");
      this.clearDesktopPushRetry();
      this.setStatus("已是最新 · 无需上传");
      await this.refreshSyncView();
      return false;
    }
    this.desktopGitTrace.push("上传检查：存在待上传 Commit");
    this.setSyncActivity("正在 Push 本机 Commit…", "push");
    await this.traceDesktopGitStep("Git push（上传本机提交）", () =>
      this.git(["push", "-u", "origin", `HEAD:${this.settings.gitBranch}`], true)
    );
    this.clearDesktopPushRetry();
    this.settings.pendingMergePushAfterResolve = false;
    this.settings.lastSyncAt = Date.now();
    await this.saveSettings();
    this.setStatus("已上传 · 刚刚");
    await this.refreshSyncView();
    return true;
  }

  async getPendingConflictPaths(): Promise<string[]> {
    if (!this.nativeGitEnabled()) return [];
    try {
      return await this.getUnmergedPaths();
    } catch {
      return [];
    }
  }

  getDeferredMergePaths(): string[] {
    return [...this.deferredMergePaths];
  }

  private async getUnmergedPaths(): Promise<string[]> {
    const output = await this.gitRaw(["diff", "--name-only", "--diff-filter=U", "-z"]);
    return output.split("\0").filter(Boolean);
  }

  private async resolveMergeConflicts(initialPaths: string[]): Promise<void> {
    let paths = initialPaths;
    while (paths.length > 0) {
      const outcome = await this.openConflictView(paths);
      if (outcome === "deferred") {
        const remaining = await this.getUnmergedPaths();
        throw new SyncDeferredError(`有 ${remaining.length} 个合并冲突等待处理`);
      }
      try {
        await this.git(["-c", "core.editor=true", "merge", "--continue"]);
        return;
      } catch (error) {
        paths = await this.getUnmergedPaths();
        if (paths.length === 0) throw error;
      }
    }
  }

  async continuePendingMergeConflicts(): Promise<void> {
    const pushAfterResolve = this.settings.pendingMergePushAfterResolve;
    try {
      await this.enqueueDesktopGit(async () => {
        const paths = await this.getUnmergedPaths();
        if (paths.length > 0) await this.resolveMergeConflicts(paths);
        else if ((await this.getInterruptedGitOperation())?.label === "Merge") {
          await this.git(["-c", "core.editor=true", "merge", "--continue"]);
        }
        if (this.settings.pendingMergePushAfterResolve) {
          await this.desktopPushOnly(false);
        }
        await this.refreshSyncView();
      }, pushAfterResolve ? "继续处理合并冲突 + Push" : "继续处理合并冲突");
    } catch (error) {
      if (error instanceof SyncDeferredError) return;
      if (this.settings.pendingMergePushAfterResolve) await this.scheduleDesktopPushRetry();
      new Notice(`同步与分享：无法继续处理冲突。${messageOf(error)}`, 12000);
    }
  }

  private async openConflictView(paths: string[]): Promise<"resolved" | "deferred"> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(ZoeySyncConflictView.type)[0] ?? null;
    if (!leaf) leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) throw new Error("无法打开右侧同步冲突处理面板");
    await leaf.setViewState({ type: ZoeySyncConflictView.type, active: true });
    if (!(leaf.view instanceof ZoeySyncConflictView)) throw new Error("无法打开同步冲突处理视图");
    const view = leaf.view;
    await this.app.workspace.revealLeaf(leaf);
    return await new Promise<"resolved" | "deferred">((resolve) => view.start(paths, resolve));
  }

  async readConflictFile(path: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(path);
    } catch {
      return null;
    }
  }

  async applyConflictText(path: string, content: string): Promise<void> {
    await this.app.vault.adapter.write(path, content);
    await this.git(["add", "--", path]);
  }

  async applyWholeConflictChoice(path: string, source: "github" | "local"): Promise<void> {
    const checkoutSide = source === "github" ? "--theirs" : "--ours";
    const stage = source === "github" ? 3 : 2;
    try {
      await this.git(["checkout", checkoutSide, "--", path]);
      await this.git(["add", "--", path]);
    } catch (error) {
      try {
        await this.git(["cat-file", "-e", `:${stage}:${path}`]);
      } catch {
        // 删除/修改冲突中，被选择的一侧代表删除该文件。
        await this.git(["rm", "-f", "--", path]);
        return;
      }
      throw error;
    }
  }
}

class FileTrackingModal extends Modal {
  private running = false;

  constructor(app: App, private plugin: SyncFeature, private preview: FileTrackingPreview) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-one-sync-tracking-modal");
    const body = this.contentEl;
    body.empty();
    body.createEl("h2", { text: "检查并修复文件追踪", cls: "simple-one-sync-tracking-title" });
    body.createEl("p", { text: `待补充 ${this.preview.missingRules.length} 条忽略规则；${this.preview.paths.length} 个已追踪文件应改为仅本机保留。`, cls: "simple-one-sync-tracking-summary" });
    body.createEl("p", { text: "修复只调整这些文件的 Git 跟踪，并补齐缺少的 .gitignore 规则。本机文件和 Git 历史都会保留；下一次 commit、push 后，文件会从远端当前版本退出。", cls: "simple-one-sync-tracking-description" });
    if (this.preview.missingRules.length) {
      const rules = body.createEl("details", { cls: "simple-one-sync-tracking-details" });
      rules.createEl("summary", { text: `查看待补充的规则（${this.preview.missingRules.length}）` });
      rules.createEl("pre", { text: this.preview.missingRules.join("\n"), cls: "simple-one-sync-tracking-preview" });
    }
    if (this.preview.paths.length) {
      const files = body.createEl("details", { cls: "simple-one-sync-tracking-details" });
      files.createEl("summary", { text: `查看将停止追踪的文件（${this.preview.paths.length}）` });
      files.createEl("pre", { text: this.preview.paths.join("\n"), cls: "simple-one-sync-tracking-preview" });
    }
    const actions = body.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
    const apply = actions.createEl("button", { text: "应用修复", cls: "mod-cta" });
    apply.disabled = this.preview.paths.length === 0 && this.preview.missingRules.length === 0;
    apply.addEventListener("click", () => {
      if (this.running) return;
      this.running = true;
      apply.disabled = true;
      apply.setText("正在修复…");
      void this.plugin.repairFileTracking(this.preview).then((count) => {
        new Notice(`同步与分享：已让 ${count} 个文件退出 Git 跟踪；本机文件已保留`);
        this.close();
      }).catch((error) => {
        new Notice(`同步与分享：修复失败。${messageOf(error)}`, 10000);
        apply.setText("请关闭后重新检查");
      }).finally(() => { this.running = false; });
    });
  }
}

class GitRepairModal extends Modal {
  private repairing = false;

  constructor(
    app: App,
    private plugin: SyncFeature,
    private operation: string
  ) {
    super(app);
  }

  onOpen(): void {
    const container = this.contentEl;
    container.empty();
    container.createEl("h2", { text: "恢复正常同步" });
    container.createEl("p", {
      text: `检测到上一次 ${this.operation} 没有完成，因此自动 Commit、Merge 和 Push 已暂停。`
    });
    const list = container.createEl("ul");
    list.createEl("li", { text: "保护当前本机内容，并退出未完成的异常操作。" });
    list.createEl("li", { text: "以恢复后的本机内容建立一个新的 commit。" });
    list.createEl("li", { text: "Fetch 云端版本并在本机 merge；如有冲突，在右侧面板逐项选择。" });
    list.createEl("li", { text: "修复完成后等待正常 push 计时，不会立即上传。" });
    container.createEl("p", {
      text: "操作前会建立临时安全备份；恢复成功后自动清理，通常不需要你处理。",
      cls: "simple-one-sync-conflict__warning"
    });

    const actions = container.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "暂不修复" });
    cancel.addEventListener("click", () => this.close());
    const repair = actions.createEl("button", { text: "确认恢复", cls: "mod-cta" });
    repair.addEventListener("click", () => {
      if (this.repairing) return;
      this.repairing = true;
      this.close();
      new Notice("同步与分享：正在恢复本机版本并检查云端更新…", 8000);
      void this.plugin
        .repairInterruptedGitOperation()
        .then((result) => {
          new Notice(
            `同步与分享：${result.operation} 异常状态已退出${
              result.restoredLocalChanges ? "，本机修改已恢复" : ""
            }；本地 Commit 和云端合并检查已完成，尚未立即 Push`,
            10000
          );
        })
        .catch((error) => {
          if (error instanceof SyncDeferredError) {
            new Notice("同步与分享：异常状态已退出，本机内容已重新 commit；合并冲突已保留在同步面板等待处理", 12000);
          } else {
            new Notice(`同步与分享：异常修复未完成。${messageOf(error)}`, 15000);
          }
        });
    });
  }
}

class LocalHistorySlimModal extends Modal {
  private running = false;

  constructor(app: App, private plugin: SyncFeature, private preview: LocalHistoryPreview) {
    super(app);
  }

  onOpen(): void {
    const body = this.contentEl;
    body.empty();
    body.createEl("h2", { text: "本地 Git 历史瘦身" });
    body.createEl("p", { text: "已实时核对 GitHub 分支与本机 head 一致，当前提交已上传。执行时会再核对一次。" });
    body.createEl("p", {
      text: `本机约有 ${this.preview.totalCommits} 个可见 Commit，其中 ${this.preview.oldCommits} 个早于 30 天；Git 对象约 ${this.preview.localSizeMiB.toFixed(1)} MiB。`
    });
    body.createEl("p", {
      text: "执行后本机只保留最近约 30 天的可见历史，并清理旧对象和本地恢复记录。GitHub 上的完整历史不会修改；以后仍可从 GitHub 重新获取。",
      cls: "simple-one-sync-conflict__warning"
    });
    const actions = body.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "清理本机旧历史", cls: "mod-cta" });
    confirm.disabled = this.preview.oldCommits === 0;
    confirm.addEventListener("click", () => {
      if (this.running) return;
      this.running = true;
      confirm.disabled = true;
      confirm.setText("正在清理…");
      void this.plugin.slimLocalHistory()
        .then(({ before, after }) => {
          this.close();
          new Notice(`同步与分享：本地可见 Commit ${before.totalCommits} → ${after.totalCommits}；Git 对象约 ${before.localSizeMiB.toFixed(1)} → ${after.localSizeMiB.toFixed(1)} MiB。`, 12000);
        })
        .catch((error) => {
          this.running = false;
          confirm.disabled = false;
          confirm.setText("清理本机旧历史");
          new Notice(`同步与分享：清理未完成。${messageOf(error)}`, 15000);
        });
    });
    if (this.preview.oldCommits === 0) {
      body.createEl("p", { text: "当前没有早于 30 天的可见 commit，无需清理。" });
    }
  }
}

class ZoeySyncConflictView extends ItemView {
  static readonly type = "simple-one-sync-conflict-view";
  private totalFiles = 0;
  private settled = false;
  private paths: string[] = [];
  private done?: (outcome: "resolved" | "deferred") => void;

  constructor(leaf: WorkspaceLeaf, private plugin: SyncFeature) {
    super(leaf);
  }

  getViewType(): string {
    return ZoeySyncConflictView.type;
  }

  getDisplayText(): string {
    return "处理同步冲突";
  }

  getIcon(): string {
    return "git-merge";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("simple-one-sync-conflict-view");
    container.createDiv({ text: "正在准备冲突内容…", cls: "simple-one-sync-conflict__intro" });
  }

  onClose(): Promise<void> {
    if (!this.settled) this.finish("deferred", false);
    return Promise.resolve();
  }

  start(paths: string[], done: (outcome: "resolved" | "deferred") => void): void {
    this.paths = [...paths];
    this.totalFiles = paths.length;
    this.done = done;
    this.settled = false;
    void this.renderCurrentFile();
  }

  private finish(outcome: "resolved" | "deferred", detach = true): void {
    if (this.settled) return;
    this.settled = true;
    this.done?.(outcome);
    this.done = undefined;
    if (detach) this.leaf.detach();
  }

  private async renderCurrentFile(): Promise<void> {
    const path = this.paths[0];
    const content = await this.plugin.readConflictFile(path);
    const blocks = content === null ? [] : parseConflictBlocks(content);
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("simple-one-sync-conflict-view");

    container.createEl("h2", { text: "发现内容冲突" });
    container.createEl("p", {
      text: "GitHub 和本机修改了同一处内容。请逐项选择最终保留什么；确认前不会上传到 GitHub。",
      cls: "simple-one-sync-conflict__intro"
    });
    const progress = container.createDiv({ cls: "simple-one-sync-conflict__progress" });
    progress.createSpan({ text: `已处理 ${this.totalFiles - this.paths.length} / ${this.totalFiles}` });
    progress.createEl("code", { text: path });

    if (content === null || blocks.length === 0) {
      this.renderWholeFileChoice(container, path);
      return;
    }
    this.renderTextBlocks(container, path, content, blocks);
  }

  private renderWholeFileChoice(container: HTMLElement, path: string): void {
    container.createEl("p", {
      text: "这个文件无法按文字分段显示，通常是附件冲突，或一台设备删除了文件、另一台设备修改了它。请选择保留哪一边。",
      cls: "simple-one-sync-conflict__warning"
    });
    const choices = container.createDiv({ cls: "simple-one-sync-conflict__whole-actions" });
    this.createActionButton(choices, "保留 GitHub 版本", async () => {
      await this.plugin.applyWholeConflictChoice(path, "github");
      await this.advance();
    });
    this.createActionButton(choices, "保留本机版本", async () => {
      await this.plugin.applyWholeConflictChoice(path, "local");
      await this.advance();
    }, true);
    this.renderFooter(container);
  }

  private renderTextBlocks(container: HTMLElement, path: string, content: string, blocks: ConflictBlock[]): void {
    const resolutions = Array.from<string | undefined>({ length: blocks.length });
    let applyButton: HTMLButtonElement;

    blocks.forEach((block, index) => {
      const card = container.createDiv({ cls: "simple-one-sync-conflict__block" });
      card.createEl("h3", { text: `第 ${index + 1} 处差异` });
      const comparison = card.createDiv({ cls: "simple-one-sync-conflict__comparison" });
      this.renderVersion(comparison, "GitHub 上的内容", block.github, "is-github");
      this.renderVersion(comparison, "本机内容", block.local, "is-local");

      const actions = card.createDiv({ cls: "simple-one-sync-conflict__block-actions" });
      actions.createSpan({ text: "最终保留：", cls: "simple-one-sync-conflict__action-label" });
      const result = card.createEl("textarea", { cls: "simple-one-sync-conflict__result" });
      result.placeholder = "先点击下面的选择，也可以直接在这里编辑最终内容";
      result.rows = Math.min(14, Math.max(4, block.github.split("\n").length, block.local.split("\n").length));
      const setResolution = (value: string): void => {
        resolutions[index] = value;
        result.value = value;
        applyButton.disabled = resolutions.some((item) => item === undefined);
      };
      this.createActionButton(actions, "使用 GitHub 内容", () => setResolution(block.github));
      this.createActionButton(actions, "使用本机内容", () => setResolution(block.local));
      this.createActionButton(actions, "两份都保留", () => setResolution(block.github + block.local));
      result.addEventListener("input", () => {
        resolutions[index] = result.value;
        applyButton.disabled = resolutions.some((item) => item === undefined);
      });
    });

    applyButton = container.createEl("button", {
      text: this.paths.length === 1 ? "应用并继续同步" : "应用并处理下一个文件",
      cls: "mod-cta simple-one-sync-conflict__continue"
    });
    applyButton.disabled = true;
    applyButton.addEventListener("click", asyncAction(async () => {
      if (resolutions.some((item) => item === undefined)) return;
      applyButton.disabled = true;
      try {
        await this.plugin.applyConflictText(path, applyConflictResolutions(content, blocks, resolutions as string[]));
        await this.advance();
      } catch (error) {
        new Notice(`无法应用冲突处理结果：${messageOf(error)}`, 8000);
        applyButton.disabled = false;
      }
    }));
    this.renderFooter(container);
  }

  private renderVersion(container: HTMLElement, label: string, value: string, className: string): void {
    const version = container.createDiv({ cls: `simple-one-sync-conflict__version ${className}` });
    version.createDiv({ text: label, cls: "simple-one-sync-conflict__source" });
    version.createEl("pre", { text: value || "（这一边删除了这段内容）" });
  }

  private createActionButton(
    container: HTMLElement,
    label: string,
    action: () => void | Promise<void>,
    cta = false
  ): HTMLButtonElement {
    const button = container.createEl("button", { text: label, cls: cta ? "mod-cta" : undefined });
    button.addEventListener("click", () => void action());
    return button;
  }

  private renderFooter(container: HTMLElement): void {
    const footer = container.createDiv({ cls: "simple-one-sync-conflict__footer" });
    const explanation = footer.createSpan({
      text: this.paths.length > 1
        ? "可以先处理其他文件；未处理的冲突会一直保留在同步面板。"
        : "未处理的冲突会一直保留在同步面板，稍后可以继续。"
    });
    const actions = footer.createDiv({ cls: "simple-one-sync-conflict__footer-actions" });
    if (this.paths.length > 1) {
      this.createActionButton(actions, "稍后处理此文件", () => void this.deferCurrentFile());
    }
    this.createActionButton(actions, "暂时收起", () => this.finish("deferred"));
    explanation.setAttr("aria-live", "polite");
  }

  private async advance(): Promise<void> {
    this.paths.shift();
    if (this.paths.length > 0) {
      await this.renderCurrentFile();
    } else {
      this.finish("resolved");
    }
  }

  private async deferCurrentFile(): Promise<void> {
    const current = this.paths.shift();
    if (!current) return;
    this.paths.push(current);
    await this.renderCurrentFile();
  }
}

class ErrorLogModal extends Modal {
  constructor(app: App, private plugin: SyncFeature) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-one-sync-error-modal");
    void this.render().catch(error => new Notice(messageOf(error), 8000));
  }

  private async render(): Promise<void> {
    const lastCommitAt = await this.plugin.getLatestCommitAt();
    const container = this.contentEl;
    container.empty();
    const overview = container.createDiv({ cls: "simple-one-sync-error-modal__overview" });
    const heading = overview.createDiv();
    heading.createEl("h2", { text: "最近同步日志" });
    heading.createEl("p", {
      text: "仅保留最近 24 小时的 commit、同步和连接记录。",
      cls: "simple-one-sync-error-modal__intro"
    });
    const lastTimes = overview.createDiv({ cls: "simple-one-sync-error-modal__last-times" });
    const formatTime = (timestamp: number): string => {
      if (!timestamp) return "暂无记录";
      const absolute = new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
      const days = Math.floor(Math.max(0, Date.now() - timestamp) / 86400000);
      const relative = days >= 7 ? `${days} 天前` : formatRelativeTime(timestamp);
      return `${absolute}（${relative}）`;
    };
    for (const [label, timestamp] of [
      ["上次 Commit", lastCommitAt],
      ["上次 Push", this.plugin.settings.lastSyncAt],
      ["上次 Pull", this.plugin.settings.lastPullAt]
    ] as const) {
      const row = lastTimes.createDiv({ cls: "simple-one-sync-error-modal__last-time" });
      row.createSpan({ text: label });
      row.createEl("time", { text: formatTime(timestamp) });
    }

    const logs = this.plugin.getRecentErrorLogs();
    if (logs.length === 0) {
      container.createDiv({ text: "最近 24 小时没有同步记录。", cls: "simple-one-sync-error-modal__empty" });
    } else {
      const list = container.createDiv({ cls: "simple-one-sync-error-modal__list" });
      for (const entry of logs) {
        const isError = entry.status !== "success";
        const item = list.createEl("details", {
          cls: `simple-one-sync-error-modal__item ${isError ? "is-error" : "is-success"}`
        });
        const header = item.createEl("summary", { cls: "simple-one-sync-error-modal__header" });
        header.createSpan({ text: entry.context, cls: "simple-one-sync-error-modal__context" });
        header.createEl("time", {
          text: new Date(entry.timestamp).toLocaleString("zh-CN", { hour12: false }),
          cls: "simple-one-sync-error-modal__time"
        });
        item.createEl("pre", { text: entry.message || "这条旧记录未保存执行详情。" });
      }
    }

    const actions = container.createDiv({ cls: "simple-one-sync-error-modal__actions" });
    if (logs.length > 0) {
      const clearButton = actions.createEl("button", { text: "清空日志" });
      clearButton.addEventListener("click", asyncAction(async () => {
        await this.plugin.clearErrorLogs();
        await this.render();
      }));
    }
    const closeButton = actions.createEl("button", { text: "关闭", cls: "mod-cta" });
    closeButton.addEventListener("click", () => this.close());
  }
}

class ZoeySyncView extends ItemView {
  static readonly type = "simple-one-sync-view";
  private renderGeneration = 0;
  private lightweightPage = 0;
  private review?: ZoeySyncConflictPreviewModal;
  private closed = false;

  constructor(leaf: WorkspaceLeaf, private plugin: SyncFeature) {
    super(leaf);
  }

  getViewType(): string {
    return ZoeySyncView.type;
  }

  getDisplayText(): string {
    return "同步与分享";
  }

  getIcon(): string {
    return "refresh-cw";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    // Restoring a leaf is part of workspace initialization. Do not make that
    // initialization wait for a vault-wide hash scan or thousands of DOM rows.
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        if (this.leaf.view !== this) return;
        void this.render().catch((error) => {
          new Notice(`同步与分享 面板加载失败：${messageOf(error)}`, 10000);
        });
      }, 0);
    });
  }

  async reviewDifferences(live: LiveReview): Promise<Record<string, ConflictChoice> | null> {
    if (this.review) throw new Error("已有轻量同步差异正在确认");
    ++this.renderGeneration;
    const container = this.containerEl.children[1] as HTMLElement;
    const review = new ZoeySyncConflictPreviewModal(this.app, live);
    this.review = review;
    try { return await review.waitIn(container); }
    finally {
      this.review = undefined;
      container.removeClass("simple-one-sync-preview", "is-mobile-review", "is-sidebar-review");
      if (!this.closed) await this.render();
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    ++this.renderGeneration;
    this.review?.close();
  }

  updateActivity(state: ViewStatusState): void {
    const container = this.containerEl.children[1] as HTMLElement;
    const status = container.querySelector<HTMLElement>(".simple-one-sync-view__status");
    if (!status) return;
    status.className = `simple-one-sync-view__status is-${state.tone}`;
    status.querySelector<HTMLElement>(".simple-one-sync-view__status-text")?.setText(state.text);
  }

  updateQuota(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    const quota = container.querySelector<HTMLElement>(".simple-one-sync-view__quota");
    if (!quota) return;
    const visible = this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github";
    if (!visible) {
      quota.remove();
      return;
    }
    const remaining = this.plugin.getMobileGithub().remaining;
    quota.setText(remaining === null ? "GitHub 额度待查询" : `当前窗口剩余 ${remaining.toLocaleString()} 次`);
    quota.setAttr("title", "以最近一次 GitHub 响应为准；下一次请求会更新额度，同账号其他设备可能共享额度。");
  }

  async render(): Promise<void> {
    if (this.closed || this.review || !this.app.workspace.layoutReady) return;
    const generation = ++this.renderGeneration;
    const container = this.containerEl.children[1] as HTMLElement;
    const mode = this.plugin.getChangeViewMode();

    let changes: ChangeItem[] = [];
    let changesError: unknown;
    const pendingConflictPaths = await this.plugin.getPendingConflictPaths();
    const deferredMergePaths = this.plugin.getDeferredMergePaths();
    try {
      changes = await this.plugin.getChanges(mode);
    } catch (error) {
      changesError = error;
    }
    let statusState = await this.getStatusState(mode, changes, changesError);
    if (pendingConflictPaths.length > 0) {
      statusState = { tone: "error", text: `有 ${pendingConflictPaths.length} 个合并冲突等待处理` };
    } else if (deferredMergePaths.length > 0) {
      statusState = { tone: "error", text: `同步暂缓 · ${deferredMergePaths.length} 个文件仍在修改` };
    }
    if (generation !== this.renderGeneration) return;
    container.empty();
    container.addClass("simple-one-sync-view");
    const recentLogs = this.plugin.getRecentErrorLogs();
    const hasActiveError = !!this.plugin.getActiveSyncError() || recentLogs[0]?.status === "error";

    const header = container.createDiv({ cls: "simple-one-sync-view__header" });
    const actions = header.createDiv({ cls: "simple-one-sync-view__actions" });
    const layoutButton = actions.createDiv({ cls: "clickable-icon nav-action-button" });
    layoutButton.setAttr("role", "button");
    layoutButton.setAttr("tabindex", "0");
    layoutButton.setAttr("aria-label", "更改布局");
    setIcon(layoutButton, LAYOUT_SWITCH_ICON);
    layoutButton.addEventListener("click", () => void this.plugin.toggleViewLayout());
    const refreshButton = actions.createDiv({ cls: "clickable-icon nav-action-button" });
    refreshButton.setAttr("role", "button");
    refreshButton.setAttr("tabindex", "0");
    refreshButton.setAttr("aria-label", "刷新更改区");
    setIcon(refreshButton, REFRESH_CHANGES_ICON);
    refreshButton.addEventListener("click", () => void this.render());
    if (recentLogs.length > 0) {
      const errorButton = actions.createDiv({
        cls: `clickable-icon nav-action-button simple-one-sync-view__error-button${hasActiveError ? " is-active" : ""}`
      });
      errorButton.setAttr("role", "button");
      errorButton.setAttr("tabindex", "0");
      errorButton.setAttr("aria-label", `查看最近同步日志，共 ${recentLogs.length} 条`);
      setIcon(errorButton, hasActiveError ? "triangle-alert" : "history");
      setTooltip(errorButton, `查看最近同步日志（${recentLogs.length}）`);
      errorButton.addEventListener("click", () => new ErrorLogModal(this.app, this.plugin).open());
    }
    const settingsButton = actions.createDiv({ cls: "clickable-icon nav-action-button" });
    settingsButton.setAttr("role", "button");
    settingsButton.setAttr("tabindex", "0");
    settingsButton.setAttr("aria-label", "同步面板设置");
    setIcon(settingsButton, "settings");
    setTooltip(settingsButton, "同步面板设置");
    settingsButton.addEventListener("click", (event) => this.openViewSettingsMenu(event));

    const status = container.createDiv({ cls: "simple-one-sync-view__status" });
    status.addClass(`is-${statusState.tone}`);
    status.createSpan({ cls: "simple-one-sync-view__status-dot" });
    const statusCopy = status.createDiv({ cls: "simple-one-sync-view__status-copy" });
    statusCopy.createSpan({ text: statusState.text, cls: "simple-one-sync-view__status-text" });
    if (this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github") {
      statusCopy.createSpan({ cls: "simple-one-sync-view__quota" });
      this.updateQuota();
    }

    if (pendingConflictPaths.length > 0) {
      const reminder = container.createDiv({ cls: "simple-one-sync-view__conflict-reminder" });
      setIcon(reminder.createSpan({ cls: "simple-one-sync-view__conflict-reminder-icon" }), "triangle-alert");
      const copy = reminder.createDiv({ cls: "simple-one-sync-view__conflict-reminder-copy" });
      copy.createDiv({ text: "同步尚未完成", cls: "simple-one-sync-view__conflict-reminder-title" });
      copy.createDiv({
        text: `${pendingConflictPaths.length} 个异常文件等待确认；已能合并的内容会保留，不会被回滚。`,
        cls: "simple-one-sync-view__conflict-reminder-desc"
      });
      const continueButton = reminder.createEl("button", { text: "继续处理", cls: "mod-cta" });
      continueButton.addEventListener("click", () => void this.plugin.continuePendingMergeConflicts());
    } else if (deferredMergePaths.length > 0) {
      const reminder = container.createDiv({
        cls: "simple-one-sync-view__conflict-reminder simple-one-sync-view__conflict-reminder--deferred"
      });
      setIcon(reminder.createSpan({ cls: "simple-one-sync-view__conflict-reminder-icon" }), "triangle-alert");
      const copy = reminder.createDiv({ cls: "simple-one-sync-view__conflict-reminder-copy" });
      const fileLabel =
        deferredMergePaths.length === 1 ? `“${deferredMergePaths[0]}”` : `${deferredMergePaths.length} 个文件`;
      copy.createDiv({ text: "同步暂缓：文件仍在修改", cls: "simple-one-sync-view__conflict-reminder-title" });
      copy.createDiv({
        text: `${fileLabel}正在修改，云端也有新版本。为避免覆盖本机内容，已暂停合并；停止修改并完成本地 Commit 后，将自动重新尝试同步。`,
        cls: "simple-one-sync-view__conflict-reminder-desc"
      });
    }

    const section = container.createDiv({ cls: "simple-one-sync-view__section" });
    const sectionHeader = section.createDiv({ cls: "simple-one-sync-view__section-header" });
    const actionButton = sectionHeader.createEl("button", { cls: "simple-one-sync-view__section-action" });
    const actionSpinner = actionButton.createSpan({ cls: "simple-one-sync-view__section-action-spinner" });
    const actionLabel = actionButton.createSpan({
      text: this.plugin.isSyncing() ? (mode === "commit" ? "Commit 中…" : "同步中…") : mode === "commit" ? "Commit" : "同步"
    });
    setIcon(actionSpinner, "loader-circle");
    actionButton.toggleClass("is-loading", this.plugin.isSyncing());
    actionButton.disabled = this.plugin.isSyncing() || pendingConflictPaths.length > 0;
    actionButton.setAttr(
      "aria-label",
      mode === "commit" ? "Commit 当前列表中的本机更改" : "下载远端更新并上传本机更改"
    );
    actionButton.addEventListener("click", asyncAction(async () => {
      actionButton.disabled = true;
      actionButton.addClass("is-loading");
      actionLabel.setText(mode === "commit" ? "Commit 中…" : "同步中…");
      try {
        if (mode === "commit") await this.plugin.commitNow(true);
        else await this.plugin.syncNow(true);
        await this.render();
      } finally {
        actionButton.disabled = this.plugin.isSyncing();
        actionButton.removeClass("is-loading");
      }
    }));

    if (!changesError) {
      if (mode === "commit" && changes.length === 0) actionButton.disabled = true;
      if (this.plugin.useLightweightSync() && this.plugin.isSyncing()) {
        section.createDiv({ text: "正在核对两端或等待文件选择，当前列表暂不显示。", cls: "simple-one-sync-view__empty" });
      } else if (this.plugin.getLightweightPendingStatus()) {
        section.createDiv({ text: "尚未完成轻量同步首次对齐。点击同步核对实际差异；没有基准时，空列表不代表没有变化。", cls: "simple-one-sync-view__empty" });
      } else if (changes.length === 0) {
        const empty = section.createDiv({ cls: "simple-one-sync-view__empty" });
        setIcon(empty.createSpan(), "check-circle-2");
        empty.createSpan({ text: this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github" ? "本机暂未发现候选变化，云端状态将在同步时核对" : mode === "upload" ? "没有待上传文件" : "没有待 Commit 文件" });
      } else {
        const lightweight = this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github";
        let visible = changes;
        if (lightweight) {
          section.createDiv({ text: "候选变化；同步时检查哈希并核对云端后确定实际传输数量。" });
          const pages = Math.ceil(changes.length / 100);
          this.lightweightPage = Math.min(this.lightweightPage, pages - 1);
          visible = changes.slice(this.lightweightPage * 100, (this.lightweightPage + 1) * 100);
          if (pages > 1) {
            const paging = section.createDiv();
            const prev = paging.createEl("button", { text: "上一页" });
            prev.disabled = this.lightweightPage === 0;
            prev.addEventListener("click", () => { this.lightweightPage--; void this.render(); });
            paging.createSpan({ text: " 第 " + (this.lightweightPage + 1) + " / " + pages + " 页 " });
            const next = paging.createEl("button", { text: "下一页" });
            next.disabled = this.lightweightPage === pages - 1;
            next.addEventListener("click", () => { this.lightweightPage++; void this.render(); });
          }
        }
        if (this.plugin.settings.viewLayout === "tree") this.renderTree(section, visible);
        else for (const change of visible) this.renderChange(section, change, true);
      }
    } else {
      if (mode === "commit") actionButton.disabled = true;
      section.createDiv({ text: `无法读取更改：${messageOf(changesError)}`, cls: "simple-one-sync-view__empty is-error" });
    }
  }

  private openViewSettingsMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("打开高级设置").setIcon("settings").onClick(() => this.plugin.openPluginSettings())
    );
    menu.showAtMouseEvent(event);
  }

  private async getStatusState(
    mode: ChangeViewMode,
    changes: ChangeItem[],
    changesError: unknown
  ): Promise<ViewStatusState> {
    const setupActivity = this.plugin.getSetupActivity();
    if (setupActivity) return setupActivity;
    if (this.plugin.nativeGitEnabled() && !this.plugin.settings.setupComplete) {
      return { tone: "pending", text: `首次接入未完成 · 请在设置中继续第 ${this.plugin.getSetupPreview() ? this.plugin.settings.setupStep : Math.min(this.plugin.settings.setupStep, 3)} 步` };
    }
    const activity = this.plugin.getSyncActivity();
    if (activity) return activity;
    if (this.plugin.isSyncing()) {
      return { tone: "checking", text: mode === "commit" ? "正在整理 Commit 结果…" : "正在整理同步结果…" };
    }
    if (changesError) {
      return { tone: "error", text: `读取状态失败 · ${formatStatusError(messageOf(changesError))}` };
    }

    const lightweightPending = this.plugin.getLightweightPendingStatus();
    if (lightweightPending) return lightweightPending;

    if (mode === "commit") {
      const lastCommitAt = await this.plugin.getLatestCommitAt();
      const lastCommitText = lastCommitAt ? `上次确认 ${formatRelativeTime(lastCommitAt)}` : "尚未确认";
      if (changes.length > 0) {
        return { tone: "pending", text: `待确认 · ${changes.length} 个文件 · ${lastCommitText}` };
      }
      return {
        tone: "success",
        text: lastCommitAt ? `已确认 · ${formatRelativeTime(lastCommitAt)}` : "已确认 · 尚无 Commit 记录"
      };
    }

    const { lastSyncAt } = this.plugin.settings;
    const lastSyncText = lastSyncAt
      ? `${this.plugin.useLightweightSync() ? "上次同步" : "上次 Push"} ${formatRelativeTime(lastSyncAt)}`
      : this.plugin.useLightweightSync()
        ? "尚未同步"
        : "尚未 Push";
    const activeError = this.plugin.getActiveSyncError();
    if (activeError) {
      const detail = `${activeError.context}：${formatStatusError(activeError.message)}`;
      return { tone: "error", text: `同步异常 · ${detail} · ${formatRelativeTime(activeError.timestamp)}` };
    }
    if (changes.length > 0) {
      return { tone: "pending", text: `${this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github" ? "候选变化" : "待上传"} · ${changes.length} 个文件 · ${lastSyncText}` };
    }
    return {
      tone: "success",
      text: this.plugin.useLightweightSync()
        ? lastSyncAt
          ? `本机无候选变化 · 上次同步 ${formatRelativeTime(lastSyncAt)}`
          : "本机无候选变化 · 尚无同步记录"
        : lastSyncAt
          ? `已上传 · ${formatRelativeTime(lastSyncAt)}`
          : "已上传 · 尚无 Push 记录"
    };
  }

  private renderTree(parent: HTMLElement, changes: ChangeItem[]): void {
    const groups = new Map<string, ChangeItem[]>();
    for (const change of changes) {
      const slash = change.path.indexOf("/");
      const group = slash === -1 ? "Vault 根目录" : change.path.slice(0, slash);
      const current = groups.get(group) ?? [];
      current.push(change);
      groups.set(group, current);
    }
    for (const [group, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const groupEl = parent.createDiv({ cls: "simple-one-sync-view__group" });
      const label = groupEl.createDiv({ cls: "simple-one-sync-view__group-label" });
      setIcon(label.createSpan(), "folder-closed");
      label.createSpan({ text: group });
      label.createSpan({ text: String(items.length), cls: "simple-one-sync-view__group-count" });
      for (const change of items) this.renderChange(groupEl, change, false);
    }
  }

  private renderChange(parent: HTMLElement, change: ChangeItem, fullPath: boolean): void {
    const row = parent.createDiv({ cls: "simple-one-sync-view__change" });
    row.setAttr("data-kind", change.kind);
    row.createSpan({ text: this.changeMark(change.kind), cls: "simple-one-sync-view__mark" });
    const text = row.createDiv({ cls: "simple-one-sync-view__change-text" });
    const label = fullPath ? change.path : change.path.split("/").slice(1).join("/") || change.path;
    text.createDiv({ text: label, cls: "simple-one-sync-view__path" });
    if (change.kind === "moved" && change.oldPath) {
      text.createDiv({ text: `从 ${change.oldPath}`, cls: "simple-one-sync-view__old-path" });
    }
    if (change.kind !== "deleted") {
      row.addClass("is-clickable");
      row.addEventListener("click", () => void this.app.workspace.openLinkText(change.path, "", false));
    }
  }

  private changeMark(kind: ChangeItem["kind"]): string {
    if (kind === "added") return "+";
    if (kind === "deleted") return "−";
    if (kind === "moved") return "→";
    return "M";
  }
}

type SyncSettingsPage = "root" | "mobile" | "server" | "setup" | "desktop-settings" | "beginner-desktop" | "beginner-mobile" | "beginner-server";

export class SyncSettingsTab extends PluginSettingTab {
  private desktopPage: SyncSettingsPage = "root";
  private navigationParents: SyncSettingsPage[] = [];
  private setupViewStep = 1;
  private lightweightGuideController?: AbortController;
  private lightweightGuideToken = "";
  private lightweightGuideStatus = "";
  private lightweightGuideStep = 1;
  private lightweightGuideDraft?: MobileOptions;
  private lightweightGuideLogin = "";
  private lightweightGuideVerified?: RemoteSnapshot;
  private lightweightGuideRepoMode: "existing" | "create" = "existing";
  private lightweightGuideRepoName = "";
  private lightweightGuideBusy = false;
  private lightweightGuideStateChecked = false;
  private lightweightGuideStateError = "";
  private setupRepoInput = "";
  private setupRepoNameInput = "";
  private setupRepoMode: "existing" | "create" = "existing";
  private setupPlatform: "github" | "gitee" = "github";
  private setupAuthMode: "browser" | "token" | "verify" | null = null;
  private setupDeviceCode = "";
  private setupBrowserPending = false;
  private setupBrowserController?: AbortController;
  private setupBrowserRequest = 0;
  private setupTokenInput = "";
  private setupAuthVerified = false;
  private setupOverlapContent?: SetupOverlapContent;
  private setupBusy = false;
  private setupRebuildConfirmed = false;
  private setupReviewPreview?: SetupPreview;
  private setupReviewStage: 1 | 2 | 3 = 1;
  private setupBaseConfirmed = false;
  private setupRulesConfirmed = false;
  private setupMessage = "";
  private setupFailure = false;

  constructor(app: App, private plugin: SyncFeature) {
    super(app, plugin.host);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{ name: "同步与设备设置", aliases: ["电脑", "手机", "服务器", "GitHub", "Token"], render: (setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClass("simple-one-sync-settings-render");
      this.settingsHost = setting.settingEl;
      this.renderSettings();
      return () => { this.settingsHost = undefined; this.lightweightGuideController?.abort(); this.setupBrowserController?.abort(); };
    } }];
  }

  private settingsHost?: HTMLElement;
  private settingsTitleChanged?: (title: string) => void;

  renderInto(container: HTMLElement, onTitleChanged?: (title: string) => void): void {
    this.settingsHost = container; this.settingsTitleChanged = onTitleChanged; this.renderSettings();
  }

  getPageTitle(): string {
    const titles: Record<SyncSettingsPage, string> = {
      root: "同步与分享",
      setup: "电脑端同步引导",
      "beginner-desktop": "电脑端同步引导",
      "beginner-mobile": "轻量同步引导",
      "beginner-server": "笔记分享引导",
      "desktop-settings": "电脑端 Git 同步设置",
      mobile: "轻量 Git 同步设置",
      server: "笔记分享设置"
    };
    return titles[this.desktopPage];
  }

  resetNavigation(): void {
    this.stopSetupBrowserAuthorization();
    this.lightweightGuideController?.abort();
    this.navigationParents = [];
    this.desktopPage = "root";
  }

  private navigateTo(page: SyncSettingsPage): void {
    if (page !== this.desktopPage) {
      if (this.desktopPage === "setup") this.stopSetupBrowserAuthorization();
      (this.navigationParents ??= []).push(this.desktopPage);
      this.desktopPage = page;
    }
    this.renderSettings();
  }

  backToOverview(): boolean {
    if (this.desktopPage === "root") return false;
    this.stopSetupBrowserAuthorization();
    this.lightweightGuideController?.abort();
    this.desktopPage = this.navigationParents?.pop() ?? "root";
    this.renderSettings();
    return true;
  }

  hide(): void {
    this.plugin.host?.share?.detachSettings();
    this.lightweightGuideController?.abort(); this.setupBrowserController?.abort();
    this.lightweightGuideController = undefined; this.setupBrowserController = undefined;
    this.settingsHost = undefined;
    this.settingsTitleChanged = undefined;
  }

  display(): void { this.renderSettings(); }

  private renderSettings(): void {
    this.plugin.host?.share?.detachSettings();
    const containerEl = this.settingsHost ?? this.containerEl;
    this.settingsTitleChanged?.(this.getPageTitle());
    containerEl.empty();
    if (this.desktopPage !== "beginner-mobile") { this.lightweightGuideController?.abort(); this.lightweightGuideController = undefined; this.lightweightGuideToken = ""; this.lightweightGuideStatus = ""; this.lightweightGuideStep = 1; this.lightweightGuideDraft = undefined; this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined; }
    containerEl.addClass("simple-one-sync-settings");
    containerEl.toggleClass("simple-one-sync-setup-page", ["setup", "desktop-settings"].includes(this.desktopPage) && !Platform.isMobile);
    containerEl.toggleClass("simple-one-sync-mobile-guide-page", this.desktopPage === "beginner-mobile");

    if (this.desktopPage === "beginner-mobile") { this.displayBeginnerMobile(containerEl); return; }
    if (this.desktopPage === "beginner-desktop") { this.displayDevicePreview(containerEl, "从创建仓库开始：电脑端同步", "请在电脑端打开此引导，完成 GitHub 授权、仓库接入与两端检查。"); return; }
    if (this.desktopPage === "beginner-server") { this.plugin.host?.share?.renderSettings(containerEl, true, !this.settingsTitleChanged); return; }
    if (this.desktopPage === "mobile") { this.displayMobilePreview(containerEl); return; }
    if (this.desktopPage === "server") { this.plugin.host?.share?.renderSettings(containerEl, false, !this.settingsTitleChanged); return; }
    if (!Platform.isMobile && this.desktopPage === "setup") { this.displaySetup(containerEl); return; }
    if (!Platform.isMobile && this.desktopPage === "desktop-settings") { this.displayDesktopSettings(containerEl); return; }

    this.addEnableSetting(containerEl);
    this.addDefaultRepoSetting(containerEl);
    this.displayBeginner(containerEl);
    this.displayDesktop(containerEl);
  }

  private addDefaultRepoSetting(parent: HTMLElement): void {
    const row = new Setting(parent).setName("当前绑定 Git 仓库")
      .addText((input) => input.setPlaceholder("https://github.com/用户名/仓库.git")
        .setValue(this.plugin.settings.boundRepoUrl).onChange(async (value) => {
          this.plugin.settings.boundRepoUrl = value.trim();
          await this.plugin.saveSettings();
        }));
    row.settingEl.addClass("simple-one-sync-stacked-setting");
  }

  private addDesktopEngineControls(parent: HTMLElement): void {
    if (Platform.isMobile) return;
    const row = new Setting(parent).setName("启用电脑端原生 Git 同步")
      .setDesc("关闭后停止原生 Git 同步，下方设置暂停使用。")
      .addToggle((toggle) => toggle.setValue(this.plugin.nativeGitEnabled()).onChange(async (enabled) => {
        await this.plugin.setDesktopSyncMode(enabled ? "git" : this.plugin.useLightweightSync() ? "lightweight" : "off"); this.renderSettings();
      }));
    row.settingEl.addClass("simple-one-sync-engine-switch");
  }

  private addLightweightEngineControl(parent: HTMLElement): void {
    const row = new Setting(parent).setName("启用轻量 Git 同步")
      .setDesc("关闭后停止轻量同步，下方设置暂停使用。")
      .addToggle((toggle) => toggle.setValue(this.plugin.useLightweightSync()).onChange(async (enabled) => {
        await this.plugin.setLightweightSyncEnabled(enabled); this.renderSettings();
      }));
    row.settingEl.addClass("simple-one-sync-engine-switch");
  }

  private syncSettingsBody(parent: HTMLElement, enabled: boolean): HTMLElement {
    const body = parent.createEl("fieldset", { cls: "simple-one-sync-engine-body" });
    body.disabled = !enabled;
    body.inert = !enabled;
    body.toggleClass("is-disabled", !enabled);
    return body;
  }

  private addEnableSetting(parent: HTMLElement): void {
    new Setting(parent)
      .setName("启用同步与分享")
      .setDesc("显示右侧同步面板，并允许手动或定时同步。关闭后保留配置，但停止本插件的同步工作。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          await this.plugin.setFeatureEnabled(value);
          this.renderSettings();
        })
      );
  }

  private displayMobile(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("手机端设置").setHeading();
    containerEl.createEl("p", {
      text: "移动端兼容仍在完善，以下仅保留当前已经实现的服务器同步设置。",
      cls: "simple-one-sync-section-desc"
    });
    new Setting(containerEl)
      .setName("服务器地址")
      .setDesc("公网必须使用 HTTPS，例如 HTTPS://sync.example.com。")
      .addText((text) =>
        text
          .setPlaceholder("https://sync.example.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("认证密码")
      .setDesc("保存在本机插件数据中；该文件已加入 Git 忽略。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.serverPassword).onChange(async (value) => {
          this.plugin.settings.serverPassword = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("设备名称").addText((text) =>
      text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
        this.plugin.settings.deviceName = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("自动同步间隔（分钟）").addText((text) =>
      text.setValue(String(this.plugin.settings.mobileAutoSyncMinutes)).onChange(async (value) => {
        this.plugin.settings.mobileAutoSyncMinutes = Math.max(0, Number(value) || 0);
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("指令检查间隔（秒）").addText((text) =>
      text.setValue(String(this.plugin.settings.commandPollSeconds)).onChange(async (value) => {
        this.plugin.settings.commandPollSeconds = Math.max(15, Number(value) || 60);
        await this.plugin.saveSettings();
      })
    );
  }

  private currentDevice(): "git" | "mobile" {
    return Platform.isMobile ? "mobile" : "git";
  }

  private addSyncBadges(button: HTMLButtonElement, recommended: boolean, active: boolean): void {
    if (!recommended && !active) return;
    const badges = button.createSpan({ cls: "simple-one-sync-device-badges" });
    if (recommended) badges.createSpan({ text: "当前平台推荐", cls: "simple-one-sync-device-badge" });
    if (active) badges.createSpan({ text: "当前应用", cls: "simple-one-sync-device-badge is-applied" });
  }

  private addBeginnerLink(parent: HTMLElement, title: string, icon: string, page: "setup" | "beginner-desktop" | "beginner-mobile" | "beginner-server"): void {
    const button = parent.createEl("button", { cls: "simple-one-sync-page-link simple-one-sync-beginner-link", attr: { type: "button" } });
    setIcon(button.createSpan({ cls: "simple-one-sync-page-link__icon" }), icon);
    button.createSpan({ text: title, cls: "simple-one-sync-page-link__title" });
    button.addEventListener("click", () => {
      if (page === "setup") this.prepareSetupGuide();
      this.navigateTo(page);
    });
  }

  private prepareSetupGuide(): void {
    this.stopSetupBrowserAuthorization();
    this.setupAuthMode = null;
    this.setupAuthVerified = false;
    this.setupFailure = false;
    this.setupViewStep = !this.plugin.settings.setupComplete && this.plugin.settings.setupStep === 4 && !this.plugin.getSetupPreview() ? 3 : this.plugin.settings.setupStep;
    this.setupRepoInput = this.plugin.settings.setupRepoUrl || this.plugin.settings.gitRemoteUrl;
    this.setupRepoMode = "existing";
  }

  private displayBeginner(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("入门小助手").setHeading();
    containerEl.createEl("p", { text: "从创建仓库开始，按设备查看接入步骤。", cls: "simple-one-sync-section-desc" });
    const links = containerEl.createDiv({ cls: "simple-one-sync-beginner-links" });
    this.addBeginnerLink(links, "电脑端同步引导", "monitor", Platform.isMobile ? "beginner-desktop" : "setup");
    this.addBeginnerLink(links, "轻量同步引导", "smartphone", "beginner-mobile");
    this.addBeginnerLink(links, "笔记分享引导", "share-2", "beginner-server");
  }

  private displayBeginnerMobile(containerEl: HTMLElement): void {
    containerEl.addClass("simple-one-sync-setup-page");
    const page = containerEl.createDiv({ cls: "simple-one-sync-setup-layout" });
    this.displayDevicePreview(page, "轻量同步引导", "按四步完成 Token 授权、仓库核验与同步规则设置。");
    if (!this.lightweightGuideDraft) {
      const options = this.plugin.settings.mobile;
      const repoUrl = this.plugin.settings.boundRepoUrl || options.repoUrl || this.plugin.settings.gitRemoteUrl || this.plugin.settings.setupRepoUrl;
      this.lightweightGuideDraft = { ...options, plugins: [...options.plugins], ignorePatterns: [...options.ignorePatterns],
        repoUrl, branch: options.repoUrl === repoUrl ? options.branch : "" };
    }
    const options = this.plugin.settings.mobile;
    const engine = this.plugin.getMobileGithub();
    if (options.bound && !this.lightweightGuideStateChecked && !this.plugin.isSyncing()) {
      this.lightweightGuideStateChecked = true;
      void engine.load().catch(error => { this.lightweightGuideStateError = messageOf(error); }).finally(() => {
        if (this.desktopPage === "beginner-mobile") this.renderSettings();
      });
    }
    let completed = false;
    try {
      const repo = parseGithubRepoUrl(options.repoUrl);
      completed = options.mode === "github" && options.bound && !!engine.state.baseCommitSha && engine.state.binding === `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${options.branch}`;
    } catch { /* An incomplete repository address remains an unfinished setup. */ }
    const connectionStatus = page.createDiv({ cls: `simple-one-sync-setup-status is-${completed ? "success" : "disconnected"}`, attr: { role: "status" } });
    setIcon(connectionStatus.createSpan({ cls: "simple-one-sync-setup-status__icon" }), completed ? "check" : "unplug");
    const connectionCopy = connectionStatus.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    connectionCopy.createEl("strong", { text: completed ? "首次接入已完成" : options.bound ? "仓库已绑定，首次同步待核验" : "首次接入尚未完成" });
    connectionCopy.createEl("p", { text: this.lightweightGuideStateError || (completed ? "轻量同步已建立共同基线；可重新检查授权、仓库和同步规则。" : "按下方步骤核验授权与仓库，确认首次同步后完成接入。") });
    const restart = connectionStatus.createEl("button", { text: "重新检查或修复接入", attr: { type: "button" } });
    restart.disabled = this.lightweightGuideBusy || this.plugin.isSyncing();
    restart.addEventListener("click", () => {
      if (restart.disabled) return;
      this.lightweightGuideController?.abort(); this.lightweightGuideStep = 1;
      this.lightweightGuideToken = ""; this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined;
      this.lightweightGuideStateChecked = false; this.lightweightGuideStateError = "";
      this.lightweightGuideDraft = undefined; this.renderSettings();
    });
    const nav = page.createDiv({ cls: "simple-one-sync-setup-nav simple-one-sync-lightweight-nav" });
    const available = this.lightweightGuideVerified ? 4 : this.lightweightGuideLogin ? 3 : 2;
    ["获取 Token", "核验 Token", "选择仓库", "同步规则"].forEach((label, index) => {
      const step = index + 1;
      const done = step === 1 ? !!(this.lightweightGuideToken || this.lightweightGuideLogin) : step === 2 ? !!this.lightweightGuideLogin : step === 3 && !!this.lightweightGuideVerified;
      const button = nav.createEl("button", { cls: `simple-one-sync-setup-nav__step${step === this.lightweightGuideStep ? " is-active" : ""}${done ? " is-done" : ""}`,
        attr: { type: "button", "aria-current": step === this.lightweightGuideStep ? "step" : "false" } });
      button.createSpan({ text: String(step), cls: "simple-one-sync-setup-nav__marker" });
      button.createSpan({ text: label, cls: "simple-one-sync-setup-nav__label" });
      button.disabled = step > available || this.lightweightGuideBusy;
      button.addEventListener("click", () => {
        if (this.lightweightGuideBusy || (step === 3 && !this.lightweightGuideLogin) || (step === 4 && !this.lightweightGuideVerified)) return;
        this.lightweightGuideController?.abort(); this.lightweightGuideStep = step; this.renderSettings();
      });
    });
    if (this.lightweightGuideStep !== 1) { this.displayLightweightGuideStep(page); return; }
    const card = page.createDiv({ cls: "simple-one-sync-mobile-guide__card" });
    const ready = !!this.lightweightGuideToken;
    card.createEl("p", { text: "建议先在电脑端完成浏览器登录授权，再在本引导内一键获取 token。手机端可选择「已有 token，直接填入」核验连接。", cls: "simple-one-sync-section-desc" });
    const loginStatus = card.createDiv({ cls: "simple-one-sync-setup-status", attr: { role: "status", "aria-live": "polite" } });
    const loginIcon = loginStatus.createSpan({ cls: "simple-one-sync-setup-status__icon" });
    setIcon(loginIcon, "loader-circle");
    const loginCopy = loginStatus.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    const loginTitle = loginCopy.createEl("strong", { text: "正在检查本机登录状态…" });
    const loginDescription = loginCopy.createEl("p", { text: "检查 Git 与 GitHub CLI。" });
    const prerequisites = loginStatus.createEl("button", { text: "安装与登录帮助", attr: { type: "button" } });
    prerequisites.hidden = true;
    prerequisites.addEventListener("click", () => {
      this.setupViewStep = 1;
      this.navigateTo(Platform.isMobile ? "beginner-desktop" : "setup");
    });
    const actions = card.createDiv({ cls: "simple-one-sync-mobile-guide__actions" });
    const acquire = actions.createEl("button", { text: "一键获取 token（pc 端）", cls: Platform.isMobile ? "" : "mod-cta", attr: { type: "button" } });
    const fill = actions.createEl("button", { text: "已有 token，直接填入", cls: Platform.isMobile ? "mod-cta" : "", attr: { type: "button" } });
    let loginReady = false;
    let acquiring = false;
    acquire.disabled = true;
    const status = card.createEl("p", { text: this.lightweightGuideStatus, cls: "simple-one-sync-mobile-guide__result", attr: { role: "status", "aria-live": "polite" } });
    if (ready) status.addClass("simple-one-sync-setup-done");
    const report = (text: string, error = false) => {
      this.lightweightGuideStatus = text; status.setText(text); status.toggleClass("simple-one-sync-setup-error", error);
    };
    const valid = () => this.desktopPage === "beginner-mobile" && card.isConnected &&
      (this.settingsHost ?? this.containerEl) === containerEl;
    const tokenBox = card.createDiv({ cls: "simple-one-sync-mobile-guide__token" }); tokenBox.hidden = !ready;
    tokenBox.createDiv({ text: "GitHub Token", cls: "simple-one-sync-mobile-guide__token-label" });
    const row = tokenBox.createDiv({ cls: "simple-one-sync-mobile-guide__token-row" });
    row.createEl("code", { text: this.lightweightGuideToken, cls: "simple-one-sync-mobile-guide__token-text" });
    const copy = row.createEl("button", { text: "复制 token", attr: { type: "button" } });
    const copyStatus = tokenBox.createEl("p", { cls: "simple-one-sync-mobile-guide__result", attr: { role: "status", "aria-live": "polite" } });
    const reportCopy = (text: string, error = false) => {
      copyStatus.setText(text); copyStatus.toggleClass("simple-one-sync-setup-done", !error); copyStatus.toggleClass("simple-one-sync-setup-error", error);
    };
    copy.addEventListener("click", () => void navigator.clipboard.writeText(this.lightweightGuideToken)
      .then(() => reportCopy("Token 已复制。"), () => reportCopy("复制失败，请手动复制 Token。", true)));
    tokenBox.createEl("p", { text: "请妥善保存 token，便于在手机端填入或更换设备时使用。", cls: "simple-one-sync-mobile-guide__token-reminder" });
    const accept = (token: string) => {
      if (!valid()) return;
      this.lightweightGuideDraft!.token = token;
      this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined;
      this.lightweightGuideToken = token; this.lightweightGuideStatus = "";
      this.renderSettings();
    };
    fill.addEventListener("click", () => { this.lightweightGuideStep = 2; this.renderSettings(); });
    const updateLoginStatus = (loggedIn: boolean, description: string, needsPrerequisites = !loggedIn): void => {
      if (!valid()) return;
      loginReady = loggedIn && !Platform.isMobile;
      acquire.disabled = !loginReady || acquiring;
      loginStatus.toggleClass("is-success", loggedIn);
      loginStatus.toggleClass("is-error", !loggedIn);
      setIcon(loginIcon, loggedIn ? "check" : "triangle-alert");
      loginTitle.setText(loggedIn ? "当前已登录成功" : "当前未登录");
      loginDescription.setText(description);
      prerequisites.hidden = !needsPrerequisites;
    };
    if (Platform.isMobile) {
      loginTitle.setText("在电脑端获取，在手机端填入");
      loginDescription.setText("请先在电脑端获取 token，再点击「已有 token，直接填入」核验连接。");
      setIcon(loginIcon, "smartphone");
    } else {
      void Promise.allSettled([
        this.plugin.exec("git", ["--version"], false, true, 10000),
        this.plugin.exec("gh", ["--version"], false, true, 10000),
        this.plugin.exec("gh", ["auth", "status", "--active", "--hostname", "github.com"], false, true, 30000)
      ]).then(([git, gh, auth]) => {
        const tools = `Git ${git.status === "fulfilled" ? "已安装" : "未找到"} · GitHub CLI ${gh.status === "fulfilled" ? "已安装" : "未找到"}`;
        const needsPrerequisites = git.status !== "fulfilled" || gh.status !== "fulfilled" || auth.status !== "fulfilled";
        updateLoginStatus(auth.status === "fulfilled" && gh.status === "fulfilled", `${tools}。${auth.status !== "fulfilled" || gh.status !== "fulfilled" ? "请先完成安装与登录，再回到本引导获取 Token。" : "点击下方按钮即可一键获取 Token。"}`, needsPrerequisites);
      });
    }
    acquire.addEventListener("click", () => void (async () => {
      if (acquire.disabled) return;
      acquiring = true; acquire.disabled = true; fill.disabled = true;
      const login = new AbortController(); this.lightweightGuideController = login;
      try {
        report("正在检查 GitHub 登录状态…");
        await this.plugin.exec("gh", ["--version"], false, true, 10000);
        try { await this.plugin.exec("gh", ["auth", "status", "--active", "--hostname", "github.com"], false, true, 30000); }
        catch {
          if (!valid() || login.signal.aborted) return;
          updateLoginStatus(false, "登录已失效，请先完成安装与登录，再获取 Token。");
          throw new Error("请先完成 GitHub 登录");
        }
        if (!valid() || login.signal.aborted) return;
        loginDescription.setText("GitHub CLI 登录已核验，正在获取 token。");
        report("正在获取登录 Token…");
        const token = (await this.plugin.exec("gh", ["auth", "token", "--hostname", "github.com"], false, true, 30000)).trim();
        if (!token) throw new Error("当前登录未返回 Token");
        accept(token);
      } catch (error) {
        if (valid() && !login.signal.aborted) report(`获取失败：${messageOf(error)}。可重试或填入 Token。`, true);
      } finally {
        if (this.lightweightGuideController === login) this.lightweightGuideController = undefined;
        acquiring = false;
        if (valid()) { acquire.disabled = !loginReady; fill.disabled = false; }
      }
    })());
    if (ready) {
      const footer = card.createDiv({ cls: "simple-one-sync-setup-footer" });
      const next = footer.createEl("button", { text: "我已保存好 token", cls: "mod-cta", attr: { type: "button", title: "继续配置轻量同步" } });
      next.addEventListener("click", () => { this.lightweightGuideStep = 2; this.renderSettings(); });
    }
  }

  private displayLightweightGuideStep(page: HTMLElement): void {
    const options = this.lightweightGuideDraft!;
    const step = this.lightweightGuideStep;
    const host = page.parentElement;
    const sameGuide = () => !!host?.isConnected && (this.settingsHost ?? this.containerEl) === host &&
      this.desktopPage === "beginner-mobile" && this.lightweightGuideDraft === options;
    const body = page.createDiv({ cls: "simple-one-sync-mobile-guide__card" });
    const engine = new MobileGithub(this.app.vault.adapter, this.app.vault.configDir, this.plugin.manifest.id, () => options, () => {});
    const valid = () => body.isConnected && sameGuide() && this.lightweightGuideStep === step;
    const status = body.createEl("p", { cls: "simple-one-sync-mobile-guide__result", attr: { role: "status", "aria-live": "polite" } });
    const report = (text: string, error = false) => {
      if (!valid()) return;
      status.setText(text); status.toggleClass("simple-one-sync-setup-error", error); status.toggleClass("simple-one-sync-setup-done", !error);
    };
    const run = async (action: () => Promise<void>) => {
      if (this.lightweightGuideBusy) return;
      this.lightweightGuideBusy = true;
      const controls = Array.from(page.querySelectorAll<HTMLInputElement | HTMLButtonElement>("button, input"));
      const disabled = controls.map((control) => control.disabled);
      controls.forEach((control) => { control.disabled = true; });
      try { await action(); }
      catch (error) { report(messageOf(error), true); }
      finally {
        this.lightweightGuideBusy = false;
        if (valid()) controls.forEach((control, index) => { control.disabled = disabled[index]; });
        updateNext();
        if (!valid() && sameGuide()) this.renderSettings();
      }
    };
    new Setting(body).setName("").setHeading();
    if (step === 2) {
      body.createEl("p", { text: "填入 token，核验是否能成功连接 GitHub。连接成功后自动进入选择仓库。" });
      body.createEl("p", { text: "Token 仅保存在本机，不写入共享配置。" });
      const tokenSetting = new Setting(body).setName("GitHub token").addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("粘贴 GitHub token").setValue(options.token).onChange((value) => {
          options.token = value.trim(); this.lightweightGuideToken = options.token;
          this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined;
          status.empty(); updateNext();
        });
      });
      tokenSetting.settingEl.addClass("simple-one-sync-token-input");
      body.appendChild(status);
      new Setting(body).addButton((button) => button.setButtonText("核验连接").setCta().onClick(() => void run(async () => {
        this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined;
        report("正在核验 GitHub 连接…");
        const login = await engine.verifyToken();
        if (!valid()) return;
        this.lightweightGuideLogin = login;
        this.lightweightGuideStep = 3;
        this.renderSettings();
      })));
      if (this.lightweightGuideLogin) report(`✓ Token 有效，当前账号：${this.lightweightGuideLogin}。`);
    } else if (step === 3) {
      body.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-repository", "simple-one-sync-setup-body");
      body.createEl("p", { text: "可以核验已有仓库，也可以由插件创建一个新的私人仓库。", cls: "simple-one-sync-setup-step-desc" });
      body.createEl("p", { text: `✓ GitHub 连接成功，当前账号：${this.lightweightGuideLogin}。`, cls: "simple-one-sync-setup-done" });
      body.createEl("p", { text: "优先读取共享配置中的同步仓库地址；没有记录时，可手动填写或新建 GitHub 私人仓库。" });
      const modes = body.createDiv({ cls: "simple-one-sync-setup-options" });
      for (const mode of ["existing", "create"] as const) {
        const selected = mode === this.lightweightGuideRepoMode;
        const button = modes.createEl("button", { text: mode === "existing" ? "使用已有 GitHub 仓库" : "新建 GitHub 私人仓库",
          cls: `simple-one-sync-setup-option${selected ? " is-selected" : ""}`, attr: { type: "button", "aria-pressed": String(selected) } });
        button.addEventListener("click", () => { this.lightweightGuideRepoMode = mode; this.lightweightGuideVerified = undefined; this.renderSettings(); });
      }
      const card = body.createDiv({ cls: "simple-one-sync-setup-detail" });
      const checkRepository = async () => {
        this.lightweightGuideVerified = undefined;
        options.branch = "";
        report("正在检查仓库默认分支与读写权限…");
        const remote = await engine.verifyAccess();
        if (!valid()) return;
        options.repoUrl = parseGithubRepoUrl(options.repoUrl).url; options.branch = remote.branch;
        this.lightweightGuideVerified = remote;
        this.lightweightGuideStep = 4;
        this.renderSettings();
      };
      if (this.lightweightGuideRepoMode === "create") {
        const heading = card.createDiv({ cls: "simple-one-sync-setup-section-header" });
        new Setting(heading).setName("创建 GitHub 新仓库").setHeading();
        card.createEl("p", { text: "填写仓库名称后，在当前 GitHub 账号下创建 private（私人）仓库，并初始化 README 和默认分支。此时不会推送本地文件。" });
        new Setting(card).setName("新仓库名称").addText((text) => text.setPlaceholder("例如 my-Obsidian-vault").setValue(this.lightweightGuideRepoName)
          .onChange((value) => { this.lightweightGuideRepoName = value.trim(); })).settingEl.addClass("simple-one-sync-setup-repo-name");
        card.appendChild(status);
        new Setting(card).addButton((button) => button.setButtonText("创建私人仓库").setCta().onClick(() => void run(async () => {
          report("正在创建私人仓库…");
          const repo = await engine.createPrivateRepository(this.lightweightGuideRepoName);
          if (!valid()) return;
          options.repoUrl = repo.url; options.branch = repo.branch;
          this.lightweightGuideRepoMode = "existing";
          try { await checkRepository(); }
          catch (error) {
            if (!valid()) return;
            this.renderSettings();
            new Notice(`私人仓库已创建，但核验未完成：${messageOf(error)}。请检查已有仓库后继续。`, 10000);
          }
        }))).settingEl.addClass("simple-one-sync-setup-action");
      } else {
        new Setting(card).setName("核验已有 GitHub 仓库").setHeading();
        card.createEl("p", { text: "在已有 GitHub 仓库页面点击「code」，复制 HTTPS 地址并填入下方。" });
        card.createEl("p", { text: "核验仓库私人状态、默认主分支以及当前 token 的读写权限，通过后自动进入同步规则。", cls: "simple-one-sync-setup-helper" });
        const invalidate = () => { this.lightweightGuideVerified = undefined; status.empty(); updateNext(); };
        const repoSetting = new Setting(card).setName("GitHub 仓库地址").addText((text) => text.setPlaceholder("https://github.com/用户名/仓库.git").setValue(options.repoUrl)
          .onChange((value) => { options.repoUrl = value.trim(); invalidate(); }));
        repoSetting.settingEl.addClass("simple-one-sync-setup-repo-url");
        card.appendChild(status);
        new Setting(card).addButton((button) => button.setButtonText("检查仓库").setCta().onClick(() => void run(checkRepository)))
          .settingEl.addClass("simple-one-sync-setup-action", "simple-one-sync-setup-check-action", "simple-one-sync-setup-auth-submit");
        if (this.lightweightGuideVerified) report(`✓ 已核验私人仓库与读写权限 · 分支 ${this.lightweightGuideVerified.branch}。`);
      }
    } else {
      body.createEl("p", { text: `${options.repoUrl} · ${options.branch}` });
      body.createEl("p", { text: "勾选本机同步规则，完成后仍可在轻量 Git 同步设置中调整。" });
      renderMobileSyncRules(body, options, () => {}, () => engine.listCloudPlugins(), this.plugin.manifest.id);
      body.createEl("p", { text: "完成后绑定并启用轻量同步；首次同步请查看文件预览，再确认执行。" });
    }
    let next: HTMLButtonElement | undefined;
    if (step === 4) {
      body.appendChild(status);
      const footer = body.createDiv({ cls: "simple-one-sync-setup-footer" });
      next = footer.createEl("button", { text: "完成接入并启用同步", cls: "mod-cta", attr: { type: "button" } });
      next.addEventListener("click", () => {
        if (next?.disabled) return;
        void run(async () => {
          report("正在接入仓库；接下来请审核并确认首次同步…");
          await this.plugin.completeLightweightGuide(options);
          if (!valid()) return;
          report("✓ 接入已完成，两端已对齐，共同基线与本地哈希缓存已保存。");
          page.querySelectorAll(".simple-one-sync-lightweight-nav button").forEach(button => button.addClass("is-done"));
          await new Promise<void>(resolve => window.setTimeout(resolve, 650));
          if (!valid()) return;
          this.navigationParents = ["root"]; this.desktopPage = "mobile"; this.renderSettings();
        });
      });
    }
    const updateNext = () => {
      if (next) next.disabled = this.lightweightGuideBusy || !this.lightweightGuideVerified;
      const available = this.lightweightGuideVerified ? 4 : this.lightweightGuideLogin ? 3 : 2;
      page.querySelectorAll<HTMLButtonElement>(".simple-one-sync-lightweight-nav button").forEach((button, index) => {
        button.disabled = this.lightweightGuideBusy || index + 1 > available;
      });
    };
    updateNext();
  }

  private displayDesktopSettings(containerEl: HTMLElement): void {
    const page = containerEl.createDiv({ cls: "simple-one-sync-setup-layout" });
    this.renderDeviceHeader(page, "电脑端 Git 同步");
    this.addDesktopEngineControls(page.createDiv({ cls: "simple-card" }));
    const body = this.syncSettingsBody(page, this.plugin.nativeGitEnabled());
    this.displayDesktopAdvanced(body);
  }

  private displayDesktop(containerEl: HTMLElement): void {
    const currentDevice = this.currentDevice();
    new Setting(containerEl).setName("同步设置").setHeading();
    containerEl.createEl("p", { text: "按当前平台自动推荐同步方式；绿色标记表示实际启用的方式。电脑端也可使用轻量同步。", cls: "simple-one-sync-section-desc" });
    this.addSetupEntry(containerEl, currentDevice === "git");
    const entries = [
      { page: "mobile", title: "轻量 Git 同步", desc: "适用于安卓、iOS，也适用于电脑", icon: "smartphone" },
      { page: "server", title: "笔记分享设置", desc: "公开仓库 · GitHub Pages · 分享管理", icon: "share-2" }
    ] as const;
    for (const entry of entries) {
      const isCurrent = currentDevice === entry.page;
      const accessible = isCurrent || !Platform.isMobile;
      const button = containerEl.createEl("button", {
        cls: `simple-one-sync-page-link simple-one-sync-device-link${accessible ? "" : " is-disabled"}`,
        attr: { type: "button" }
      });
      button.disabled = !accessible;
      setIcon(button.createSpan({ cls: "simple-one-sync-page-link__icon" }), entry.icon);
      const copy = button.createSpan({ cls: "simple-one-sync-page-link__copy" });
      copy.createSpan({ text: entry.title, cls: "simple-one-sync-page-link__title" });
      copy.createSpan({ text: entry.desc, cls: "simple-one-sync-page-link__desc" });
      if (accessible) {
        if (entry.page === "mobile") this.addSyncBadges(button, isCurrent, this.plugin.settings.enabled && this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github");
        setIcon(button.createSpan({ cls: "simple-one-sync-page-link__chevron" }), "chevron-right");
        button.addEventListener("click", () => this.navigateTo(entry.page));
      }
    }
  }

  private renderDeviceHeader(container: HTMLElement, title: string): void {
    if (this.settingsHost) return; // Simple One supplies the shared header and back button.
    const header = container.createDiv({ cls: "simple-one-sync-page-header" });
    const back = header.createEl("button", { cls: "clickable-icon simple-one-sync-page-back", attr: { type: "button", "aria-label": "返回同步与分享" } });
    setIcon(back, "arrow-left");
    back.addEventListener("click", () => this.backToOverview());
    new Setting(header).setName(title).setHeading();
  }

  private displayDevicePreview(containerEl: HTMLElement, title: string, description: string): void {
    this.renderDeviceHeader(containerEl, title);
    containerEl.createEl("p", { text: description, cls: "simple-one-sync-section-desc" });
  }

  private displayMobilePreview(containerEl: HTMLElement): void {
    const page = containerEl.createDiv({ cls: "simple-one-sync-setup-layout" });
    this.displayDevicePreview(page, "轻量 Git 同步", "适用于安卓、iOS，也适用于电脑");
    this.addLightweightEngineControl(settingsSection(page, "同步开关"));
    const body = this.syncSettingsBody(page, this.plugin.useLightweightSync());
    renderMobileSettings(body, this.plugin.mobileHost(), false, () => this.renderSettings());
    if (this.plugin.settings.mobile.mode === "server") this.displayMobile(body);
  }

  private addSetupEntry(parent: HTMLElement, isCurrent: boolean): void {
    const button = parent.createEl("button", { cls: `simple-one-sync-page-link simple-one-sync-device-link simple-one-sync-device-link--desktop${isCurrent ? "" : " is-disabled"}`, attr: { type: "button" } });
    button.disabled = !isCurrent;
    setIcon(button.createSpan({ cls: "simple-one-sync-page-link__icon" }), "monitor");
    const copy = button.createSpan({ cls: "simple-one-sync-page-link__copy" });
    copy.createSpan({ text: "电脑端 Git 同步设置", cls: "simple-one-sync-page-link__title" });
    copy.createSpan({ text: "界面、自动同步时间与 Git 设置", cls: "simple-one-sync-page-link__desc" });
    if (!isCurrent) return;
    this.addSyncBadges(button, isCurrent, this.plugin.settings.enabled && this.plugin.nativeGitEnabled());
    setIcon(button.createSpan({ cls: "simple-one-sync-page-link__chevron" }), "chevron-right");
    button.addEventListener("click", () => {
      this.navigateTo("desktop-settings");
    });
  }

  private setupLink(parent: HTMLElement, label: string, href: string): void {
    parent.createEl("a", { text: label, href, attr: { target: "_blank", rel: "noopener noreferrer" } });
  }

  private syncSetupProgress(step: number, message: string, tone?: ViewStatusTone): void {
    if (this.desktopPage !== "setup" || step < 1 || step > 3 || !message) return;
    const label = ["安装与授权", "选择仓库", "检查本地与云端文件"][step - 1];
    this.plugin.setSetupActivity(`接入引导 · ${label} · ${message}`, tone ?? (/Fetch/.test(message) ? "fetch" : "checking"));
  }

  private async runSetup(action: () => Promise<void>, success: string | undefined, advanceView = true): Promise<void> {
    if (this.setupBusy) return;
    this.setupBusy = true;
    this.setupFailure = false;
    this.setupMessage = "正在检查，请稍候…";
    const step = this.setupViewStep;
    const started = Date.now();
    const publish = () => {
      if (this.setupViewStep !== step || this.setupFailure) return;
      const elapsed = /已用时/.test(this.setupMessage) ? "" : `（已用时 ${Math.floor((Date.now() - started) / 1000)} 秒）`;
      this.syncSetupProgress(step, this.setupMessage + elapsed);
    };
    publish();
    const timer = step <= 3 ? window.setInterval(publish, 1000) : undefined;
    this.renderSettings();
    try {
      await action();
      if (success !== undefined) this.setupMessage = success;
      this.syncSetupProgress(step, this.setupMessage || "✓ 本步已完成。", "success");
      if (advanceView) this.setupViewStep = this.plugin.settings.setupStep;
    } catch (error) {
      this.setupFailure = true;
      this.setupMessage = explainSetupError(error);
      this.syncSetupProgress(step, this.setupMessage, "error");
      new Notice(`同步与分享：${this.setupMessage}`, 10000);
    } finally {
      if (timer !== undefined) window.clearInterval(timer);
      this.setupBusy = false;
      this.renderSettings();
    }
  }

  private verifySetupAuthorization(action: () => Promise<void>, success: string): void {
    if (this.setupBusy) return;
    this.setupAuthVerified = false;
    void this.runSetup(async () => {
      await action();
      this.setupAuthVerified = true;
      if (this.setupAuthMode === "browser") this.stopSetupBrowserAuthorization();
      this.setupMessage = success;
      await this.advanceSetupAfterAuthorization();
    }, "", false);
  }

  private async advanceSetupAfterAuthorization(): Promise<void> {
    this.syncSetupProgress(1, "✓ GitHub 授权已核验，正在进入选择仓库。", "success");
    this.renderSettings();
    const success = (this.settingsHost ?? this.containerEl).querySelector(".simple-one-sync-setup-auth .simple-one-sync-setup-done");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 650));
    if (!success?.isConnected || this.desktopPage !== "setup" || this.setupViewStep !== 1 ||
      this.setupPlatform !== "github" || !this.setupAuthVerified) return;
    this.setupViewStep = 2;
    this.setupMessage = "";
    this.renderSettings();
  }

  private async advanceSetupAfterCheck(step: number, ready: () => boolean): Promise<void> {
    if (this.desktopPage !== "setup" || this.setupViewStep !== step || !ready()) return;
    this.setupMessage = "✓ 已成功，正在进入下一步…";
    this.syncSetupProgress(step, this.setupMessage, "success");
    this.renderSettings();
    const body = (this.settingsHost ?? this.containerEl).querySelector(".simple-one-sync-setup-body");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 650));
    if (!body?.isConnected || this.desktopPage !== "setup" || this.setupViewStep !== step || !ready()) return;
    this.setupViewStep = step + 1;
    this.setupMessage = "";
    this.renderSettings();
  }

  private async advanceSetupAfterPreview(): Promise<void> {
    if (this.plugin.settings.setupComplete || this.setupViewStep !== 3 || this.setupReviewStage !== 3 ||
      !this.setupBaseConfirmed || !this.setupRulesConfirmed || !this.setupPreviewReady()) return;
    await this.plugin.confirmSetupPreview();
    await this.advanceSetupAfterCheck(3, () => this.setupPreviewReady());
  }

  private updateSetupPreviewSelection(): void {
    this.renderSettings();
  }

  private async verifyExistingSetupAuthorization(): Promise<void> {
    try {
      await this.plugin.checkSetupAuthorization();
    } catch (error) {
      const raw = messageOf(error);
      if (/ENOENT|is not recognized|spawn (?:git|gh)/i.test(raw)) {
        throw new Error("当前设备未找到 GitHub CLI，请先安装后重试。");
      }
      throw new Error("当前 GitHub CLI 中未找到登录状态，请先选择浏览器登录授权或 Token 授权。");
    }
  }

  private stopSetupBrowserAuthorization(): void {
    this.setupBrowserController?.abort();
    this.setupBrowserController = undefined;
    this.setupBrowserRequest++;
    this.setupBrowserPending = false;
    this.setupDeviceCode = "";
  }

  private async startSetupBrowserAuthorization(): Promise<void> {
    this.setupBrowserController?.abort();
    this.setupAuthVerified = false;
    const controller = new AbortController();
    this.setupBrowserController = controller;
    const request = ++this.setupBrowserRequest;
    this.setupBrowserPending = true;
    this.setupFailure = false;
    this.setupDeviceCode = "";
    this.setupMessage = "正在获取设备码…";
    const started = Date.now();
    const publish = () => {
      if (request !== this.setupBrowserRequest || !this.setupBrowserPending) return;
      this.syncSetupProgress(1, `${this.setupMessage}（已用时 ${Math.floor((Date.now() - started) / 1000)} 秒）`);
    };
    publish();
    const progressTimer = window.setInterval(publish, 1000);
    this.renderSettings();
    try {
      await this.plugin.authorizeSetup((code) => {
        if (request !== this.setupBrowserRequest) return;
        this.setupDeviceCode = code;
        this.setupMessage = "设备码已获取，等待浏览器完成登录授权…";
        publish();
        this.renderSettings();
      }, controller.signal);
      if (request !== this.setupBrowserRequest) return;
      this.setupMessage = "浏览器授权已返回，正在核验 GitHub 登录状态…";
      publish();
      await this.plugin.checkSetupAuthorization();
      if (request !== this.setupBrowserRequest || this.desktopPage !== "setup" || this.setupAuthMode !== "browser") return;
      this.setupAuthVerified = true;
      this.setupBrowserPending = false;
      this.setupMessage = "";
      await this.advanceSetupAfterAuthorization();
    } catch (error) {
      if (request !== this.setupBrowserRequest || controller.signal.aborted) return;
      this.setupFailure = true;
      this.setupMessage = explainSetupError(error);
      this.syncSetupProgress(1, this.setupMessage, "error");
      new Notice(`同步与分享：${this.setupMessage}`, 10000);
    } finally {
      window.clearInterval(progressTimer);
      if (request === this.setupBrowserRequest) {
        this.setupBrowserPending = false;
        this.setupBrowserController = undefined;
        this.renderSettings();
      }
    }
  }

  private displaySetup(containerEl: HTMLElement): void {
    const page = containerEl.createDiv({ cls: "simple-one-sync-setup-layout" });
    this.renderDeviceHeader(page, "从创建仓库开始：电脑端同步");
    page.createEl("p", { text: "按顺序完成四步。已核验的步骤可以随时返回查看。", cls: "simple-one-sync-section-desc" });
    const guidedDone = this.plugin.settings.setupComplete && !!this.plugin.settings.setupVerified;
    const latestConnectionLog = this.plugin.getRecentErrorLogs()
      .find((entry) => /测试连接|Fetch|Pull|Push|同步/.test(entry.context));
    const loggedFailure = guidedDone && latestConnectionLog?.status === "error" ? latestConnectionLog : undefined;
    let tone: "success" | "error" | "disconnected" = "disconnected";
    let title = "当前未连接";
    let description = "尚未完成 GitHub 授权与仓库接入。按下方步骤继续。";
    if (!this.plugin.settings.enabled) {
      description = "同步与分享已关闭。返回同步与分享首页启用后，再继续同步。";
    } else if (this.setupFailure) {
      tone = "error";
      title = this.setupViewStep <= 2 ? "连接失败" : "接入检查失败";
      description = `上次检查未通过：${formatStatusError(this.setupMessage)}。请在当前步骤重试。`;
    } else if (loggedFailure) {
      tone = "error";
      title = loggedFailure.context === "测试连接" ? "连接失败" : "同步异常";
      description = `上次${loggedFailure.context}未通过。请在同步面板查看详情，检查后重试。`;
    } else if (guidedDone) {
      tone = "success";
      title = "首次接入已完成";
      description = "已连接 GitHub，自动同步已启用；需要重新核验时可再次运行引导。";
    } else if (this.plugin.settings.setupComplete) {
      title = "当前连接待核验";
      description = "检测到旧版同步配置，但尚未通过本向导核验。可从第一步重新检查。";
    } else if (this.plugin.settings.setupMutationStarted) {
      description = "接入尚未完成，自动同步已暂停。请检查第 3 步并完成接入。";
    }
    const status = page.createDiv({ cls: `simple-one-sync-setup-status is-${tone}`, attr: { role: "status" } });
    const statusIcon = status.createSpan({ cls: "simple-one-sync-setup-status__icon" });
    setIcon(statusIcon, tone === "success" ? "check" : tone === "error" ? "triangle-alert" : "unplug");
    const copy = status.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    copy.createEl("strong", { text: title });
    copy.createEl("p", { text: description });
    if (guidedDone && this.plugin.settings.enabled) {
      const restart = status.createEl("button", { text: "重新检查或修复接入", attr: { type: "button" } });
      restart.addEventListener("click", () => {
        void this.runSetup(() => this.plugin.beginSetup(), "已暂停自动 Git 操作，请从第 1 步开始。");
      });
    } else if (this.plugin.settings.setupComplete && !guidedDone) {
      const restart = status.createEl("button", { text: "从第一步重新检查接入", attr: { type: "button" } });
      restart.addEventListener("click", () => {
        void this.runSetup(() => this.plugin.beginSetup(), "已暂停自动 Git 操作，请从第 1 步开始。");
      });
    }
    if (!this.plugin.settings.setupComplete && this.plugin.settings.setupBackup && !this.plugin.settings.setupMutationStarted) {
      const cancel = status.createEl("button", { text: "取消向导，恢复旧同步", attr: { type: "button", title: "退出向导并恢复之前已配置的自动同步" } });
      cancel.disabled = this.setupBusy;
      cancel.addEventListener("click", () => void this.runSetup(() => this.plugin.cancelSetup(), "已恢复之前的同步配置。"));
    }
    const panel = page.createDiv({ cls: "simple-one-sync-setup-tab-panel" });
    const steps = ["安装与授权", "选择仓库", "检查两端", "完成接入"];
    const nav = panel.createDiv({ cls: "simple-one-sync-setup-nav" });
    steps.forEach((label, index) => {
      const number = index + 1;
      const done = number === 1
        ? this.plugin.settings.setupStep >= 2
        : number === 2
          ? !!this.plugin.settings.setupVerified && this.plugin.settings.setupStep >= 3
          : number === 3
            ? this.plugin.settings.setupStep >= 4
            : guidedDone;
      const tab = nav.createEl("button", { cls: `simple-one-sync-setup-nav__step${done ? " is-done" : ""}${this.setupViewStep === number ? " is-active" : ""}`, attr: { type: "button", "aria-current": this.setupViewStep === number ? "step" : "false" } });
      tab.createSpan({ text: String(number), cls: "simple-one-sync-setup-nav__marker" });
      tab.createSpan({ text: label, cls: "simple-one-sync-setup-nav__label" });
      tab.disabled = !this.plugin.settings.setupComplete && number > this.plugin.settings.setupStep;
      tab.addEventListener("click", () => { this.setupViewStep = number; this.setupMessage = ""; this.setupFailure = false; this.renderSettings(); });
    });
    const body = panel.createDiv({ cls: "simple-one-sync-card simple-one-sync-setup-body" });
    const descriptions = [
      "",
      "可以核验已有仓库，也可以由插件创建一个新的私人仓库。",
      "核对本地与远端文件，并决定同名文件如何处理。",
      guidedDone ? "接入已完成，可回看核验结果或重新检查两端状态。" : "确认接入信息，然后执行首次推送。"
    ];
    if (this.setupViewStep !== 1) {
      new Setting(body).setName("").setHeading();
      body.createEl("p", { text: descriptions[this.setupViewStep - 1], cls: "simple-one-sync-setup-step-desc" });
    }
    if (this.setupViewStep === 1) this.displaySetupAuth(body);
    if (this.setupViewStep === 2) this.displaySetupRepo(body);
    if (this.setupViewStep === 3) this.displaySetupPreview(body);
    if (this.setupViewStep === 4) this.displaySetupFinish(body);
  }

  private displaySetupAuth(body: HTMLElement): void {
    body.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-platform-step");
    const heading = body.createDiv({ cls: "simple-one-sync-setup-section-header" });
    new Setting(heading).setName("选择同步平台").setHeading();
    heading.createSpan({ text: "当前仅支持 GitHub", cls: "simple-one-sync-setup-badge" });
    const options = body.createDiv({ cls: "simple-one-sync-setup-options" });
    for (const platform of ["github", "gitee"] as const) {
      const selected = this.setupPlatform === platform;
      const button = options.createEl("button", { text: platform === "github" ? "GitHub" : "Gitee", cls: `simple-one-sync-setup-option${selected ? " is-selected" : ""}`, attr: { type: "button", "aria-pressed": String(selected) } });
      button.addEventListener("click", () => {
        if (platform !== "github") { this.stopSetupBrowserAuthorization(); this.setupAuthMode = null; this.setupAuthVerified = false; }
        this.setupPlatform = platform;
        this.setupMessage = "";
        this.setupFailure = false;
        this.renderSettings();
      });
    }
    if (this.setupPlatform === "gitee") body.createEl("p", { text: "Gitee 尚未做实际兼容，请选择 GitHub 继续。", cls: "simple-one-sync-setup-intro__unavailable" });
    else {
      const platformContent = body.createDiv({ cls: "simple-one-sync-setup-platform-content", attr: { role: "group", "aria-label": "GitHub 接入步骤" } });
      const toolsCard = platformContent.createDiv({ cls: "simple-one-sync-setup-detail" });
      new Setting(toolsCard).setName("安装工具").setHeading();
      toolsCard.createEl("p", { text: "电脑端需要 Git 执行同步命令，GitHub CLI 用于登录、建仓和仓库核验。若没有 GitHub 账号，请先完成注册。" });
      const downloadLinks = toolsCard.createDiv({ cls: "simple-one-sync-setup-links" });
      this.setupLink(downloadLinks, "下载 Git ↗", "https://git-scm.com/downloads");
      this.setupLink(downloadLinks, "下载 GitHub CLI ↗", "https://cli.github.com/");

      const authCard = platformContent.createDiv({ cls: "simple-one-sync-setup-detail simple-one-sync-setup-auth" });
      new Setting(authCard).setName("选择 GitHub 授权方式").setHeading();
      const authOptions = authCard.createDiv({ cls: "simple-one-sync-setup-options" });
      for (const mode of ["browser", "token", "verify"] as const) {
        const selected = this.setupAuthMode === mode;
        const label = mode === "browser" ? "浏览器登录授权" : mode === "token" ? "Token 授权" : "验证已有授权";
        const button = authOptions.createEl("button", { text: label, cls: `simple-one-sync-setup-option${selected ? " is-selected" : ""}`, attr: { type: "button", "aria-pressed": String(selected) } });
        button.disabled = this.setupBusy;
        button.addEventListener("click", () => {
          if (mode !== "browser") this.stopSetupBrowserAuthorization();
          this.setupAuthMode = mode;
          this.setupAuthVerified = false;
          this.setupTokenInput = "";
          this.setupMessage = "";
          this.setupFailure = false;
          if (mode === "browser") void this.startSetupBrowserAuthorization();
          else if (mode === "verify") {
            this.verifySetupAuthorization(
              () => this.verifyExistingSetupAuthorization(),
              "已成功，GitHub 授权已核验。"
            );
          } else this.renderSettings();
        });
      }
      if (this.setupAuthMode === "browser") {
        const instruction = authCard.createEl("p");
        instruction.append("在下方获取设备码，然后在浏览器中");
        this.setupLink(instruction, "打开 GitHub 设备码填写页 ↗", "https://github.com/login/device");
        instruction.append("，按提示登录 GitHub、输入设备码并完成授权。");
        const deviceAction = authCard.createDiv({ cls: "simple-one-sync-setup-device-action" });
        deviceAction.createEl("code", {
          text: this.setupDeviceCode || (this.setupBrowserPending ? "正在获取…" : ""),
          cls: `simple-one-sync-setup-device-slot${this.setupDeviceCode ? " simple-one-sync-setup-device-code" : this.setupBrowserPending ? " simple-one-sync-setup-feedback" : ""}`,
          attr: { "aria-live": "polite" }
        });
        const copy = deviceAction.createEl("button", { cls: "simple-one-sync-setup-device-icon-button", attr: { type: "button", "aria-label": "复制设备码" } });
        setIcon(copy, "copy");
        setTooltip(copy, "复制设备码");
        copy.disabled = !this.setupDeviceCode;
        copy.addEventListener("click", () => void navigator.clipboard.writeText(this.setupDeviceCode));
        const refresh = deviceAction.createEl("button", { cls: "simple-one-sync-setup-device-icon-button", attr: { type: "button", "aria-label": "刷新设备码" } });
        setIcon(refresh, "refresh-cw");
        setTooltip(refresh, "刷新设备码");
        refresh.disabled = this.setupBusy;
        refresh.addEventListener("click", () => void this.startSetupBrowserAuthorization());
        new Setting(authCard).addButton((button) => button.setButtonText("已填写设备码，验证授权").setCta().setDisabled(this.setupBusy || !this.setupDeviceCode).onClick(() =>
          this.verifySetupAuthorization(() => this.plugin.checkSetupAuthorization(), "GitHub 授权已核验。")))
          .settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
      } else if (this.setupAuthMode === "token") {
        authCard.createEl("p", { text: "本插件不在设置中保存 token；token 会交给本机 GitHub CLI 保存，用于登录与后续同步。" });
        const tokenHint = authCard.createDiv({ cls: "simple-one-sync-setup-token-hint" });
        const hintIcon = tokenHint.createSpan({ cls: "simple-one-sync-setup-token-hint__icon", attr: { "aria-hidden": "true" } });
        setIcon(hintIcon, "circle-alert");
        tokenHint.createSpan({ text: "创建 Classic Token 时，请勾选 repo、read:org 和 gist；仅当需要同步 GitHub Actions 工作流文件时，再勾选 workflow。" });
        let tokenVerifyButton: HTMLButtonElement | undefined;
        const tokenSetting = new Setting(authCard).setName("GitHub token").addText((text) => {
          text.setPlaceholder("粘贴 token").setValue(this.setupTokenInput);
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          text.onChange((value) => { this.setupTokenInput = value; if (tokenVerifyButton) tokenVerifyButton.disabled = this.setupBusy || !value.trim(); });
        });
        tokenSetting.settingEl.addClass("simple-one-sync-setup-token-setting");
        this.setupLink(tokenSetting.descEl, "前往 GitHub 创建 Token ↗", "https://github.com/settings/tokens");
        new Setting(authCard).addButton((button) => {
          tokenVerifyButton = button.buttonEl;
          button.setButtonText("已填写 token，验证授权").setCta().setDisabled(this.setupBusy || !this.setupTokenInput.trim()).onClick(() => {
            const token = this.setupTokenInput;
            this.setupTokenInput = "";
            this.verifySetupAuthorization(() => this.plugin.authorizeSetupWithToken(token), "GitHub Token 已通过 GitHub CLI 核验。");
          });
        }).settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
      } else if (this.setupAuthMode === "verify") {
        authCard.createEl("p", { text: this.setupAuthVerified ? "当前 GitHub CLI 登录状态已核验。" : this.setupBusy ? "正在验证当前 GitHub CLI 登录状态…" : "选择后会自动验证当前 GitHub CLI 登录状态。", cls: this.setupAuthVerified || this.setupBusy ? "simple-one-sync-setup-feedback" : "" });
        if (this.setupFailure && !this.setupBusy) {
          new Setting(authCard).addButton((button) => button.setButtonText("重新验证").setCta().onClick(() =>
            this.verifySetupAuthorization(
              () => this.verifyExistingSetupAuthorization(),
              "已成功，GitHub 授权已核验。"
            )))
            .settingEl.addClass("simple-one-sync-setup-auth-action", "simple-one-sync-setup-auth-submit");
        }
      }
      if (this.setupAuthVerified) authCard.createEl("p", { text: "✓ 已成功", cls: "simple-one-sync-setup-done" });
      else if (this.setupMessage) {
        const feedback = authCard.createEl("p", { text: this.setupMessage, cls: this.setupFailure ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback", attr: { role: "status", "aria-live": "polite" } });
        authCard.querySelector(".simple-one-sync-setup-auth-submit")?.before(feedback);
      }
    }
  }

  private displaySetupRepo(body: HTMLElement): void {
    body.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-repository");
    const options = body.createDiv({ cls: "simple-one-sync-setup-options" });
    for (const mode of ["existing", "create"] as const) {
      const selected = this.setupRepoMode === mode;
      const button = options.createEl("button", { text: mode === "existing" ? "使用已有 GitHub 仓库" : "新建 GitHub 私人仓库", cls: `simple-one-sync-setup-option${selected ? " is-selected" : ""}`, attr: { type: "button", "aria-pressed": String(selected) } });
      button.addEventListener("click", () => { this.setupRepoMode = mode; this.setupMessage = ""; this.setupFailure = false; this.renderSettings(); });
    }
    const card = body.createDiv({ cls: "simple-one-sync-setup-detail" });
    if (this.setupRepoMode === "existing") {
      new Setting(card).setName("核验已有 GitHub 仓库").setHeading();
      card.createEl("p", { text: "在已有 GitHub 仓库页面点击「code」，复制 HTTPS 地址并填入下方。" });
      card.createEl("p", { text: "核验会检查仓库是否为私有，以及当前登录账号是否具有写入权限。", cls: "simple-one-sync-setup-helper" });
      const repoUrlSetting = new Setting(card).setName("GitHub 仓库地址").addText((text) => text.setPlaceholder("https://github.com/user/vault.git").setValue(this.setupRepoInput).onChange((value) => { this.setupRepoInput = value.trim(); }));
      repoUrlSetting.settingEl.addClass("simple-one-sync-setup-repo-url");
      new Setting(card).addButton((button) => button.setButtonText("检查仓库").setCta().setDisabled(this.setupBusy).onClick(() => void this.runSetup(async () => {
        await this.plugin.verifySetupRepository(this.setupRepoInput);
        await this.advanceSetupAfterCheck(2, () => this.setupRepoReady());
      }, "", false)))
        .settingEl.addClass("simple-one-sync-setup-action", "simple-one-sync-setup-check-action", "simple-one-sync-setup-auth-submit");
    } else {
      const heading = card.createDiv({ cls: "simple-one-sync-setup-section-header" });
      new Setting(heading).setName("创建 GitHub 新仓库").setHeading();
      card.createEl("p", { text: "填写仓库名称后，插件会在当前 GitHub 账号下创建一个空的 private（私人）仓库。此时不会推送本地文件。" });
      new Setting(card).setName("新仓库名称").addText((text) => text.setPlaceholder("例如 my-Obsidian-vault").setValue(this.setupRepoNameInput).onChange((value) => { this.setupRepoNameInput = value.trim(); })).settingEl.addClass("simple-one-sync-setup-repo-name");
      new Setting(card).addButton((button) => button.setButtonText("创建私人仓库").setCta().setDisabled(this.setupBusy).onClick(() => void this.runSetup(async () => {
        try { await this.plugin.createSetupRepository(this.setupRepoNameInput); }
        finally { this.setupRepoInput = this.plugin.settings.setupRepoUrl; }
        await this.advanceSetupAfterCheck(2, () => this.setupRepoReady());
      }, "", false)))
        .settingEl.addClass("simple-one-sync-setup-action");
    }
    const feedback = card.createDiv({ cls: "simple-one-sync-setup-repo-feedback", attr: { role: "status", "aria-live": "polite" } });
    if (this.setupMessage) {
      feedback.createEl("p", { text: this.setupMessage, cls: this.setupFailure ? "simple-one-sync-setup-error" : this.setupMessage.startsWith("✓") ? "simple-one-sync-setup-done" : "simple-one-sync-setup-repo-result" });
    }
    if (!this.setupBusy && !this.setupFailure && this.setupRepoReady() && this.plugin.settings.setupVerified) {
      feedback.createEl("p", { text: `✓ 已核验 ${this.plugin.settings.setupVerified.url} · 分支 ${this.plugin.settings.setupVerified.branch}`, cls: "simple-one-sync-setup-done" });
    }
    card.querySelector(".simple-one-sync-setup-action")?.before(feedback);
  }

  private setupRepoReady(): boolean {
    const verified = this.plugin.settings.setupVerified;
    if (!verified || (!this.plugin.settings.setupComplete && this.plugin.settings.setupStep < 3)) return false;
    if (this.setupRepoMode === "create") return this.setupRepoNameInput.trim().toLowerCase() === verified.name.toLowerCase();
    try { return parseGithubRepoUrl(this.setupRepoInput).url.toLowerCase() === verified.url.toLowerCase(); }
    catch { return false; }
  }

  private displaySetupPreview(body: HTMLElement): void {
    const preview = this.plugin.getSetupPreview();
    body.createEl("p", { text: `当前 Vault：${this.plugin.getVaultBasePath()}`, cls: "simple-one-sync-section-desc" });
    body.createEl("p", { text: "先检查本机和 GitHub 的文件差异，再决定如何接入。检查不会合并、删除或推送笔记。", cls: "simple-one-sync-section-desc" });
    if (this.plugin.settings.setupComplete && !this.plugin.settings.setupVerified) {
      body.createEl("p", { text: "当前连接来自旧版设置，尚未经过此向导核验。使用上方「从第一步重新检查接入」后可查看两端文件。" });
    }
    body.createEl("p", { text: this.setupMessage, cls: `simple-one-sync-setup-preview-progress ${this.setupFailure ? "simple-one-sync-setup-error" : this.setupMessage.startsWith("✓") ? "simple-one-sync-setup-done" : "simple-one-sync-section-desc"}`, attr: { role: "status", "aria-live": "polite" } });
    if (!preview && this.plugin.settings.setupStep >= 3 && (this.plugin.settings.setupVerified || this.plugin.settings.setupRepoUrl)) {
      const actionLabel = !this.plugin.settings.setupVerified
        ? "重新核验仓库并检查本地与云端文件"
        : this.plugin.settings.setupComplete
          ? "重新检查本地与云端文件"
          : "检查本地与云端文件";
      const action = body.createDiv({ cls: "simple-one-sync-setup-file-check" });
      const check = action.createEl("button", { text: this.setupBusy ? "正在检查…" : actionLabel, cls: "mod-cta", attr: { type: "button" } });
      check.disabled = this.setupBusy;
      check.addEventListener("click", () => void this.runSetup(async () => {
        this.setupOverlapContent = undefined;
        this.setupRebuildConfirmed = false;
        const started = Date.now();
        let stage = "正在开始检查…";
        const updateProgress = () => {
          if (this.desktopPage !== "setup" || this.setupViewStep !== 3) return;
          this.setupMessage = `${stage}（已用时 ${Math.floor((Date.now() - started) / 1000)} 秒）`;
          this.syncSetupProgress(3, this.setupMessage, stage.startsWith("✓") ? "success" : undefined);
          const progress = (this.settingsHost ?? this.containerEl).querySelector(".simple-one-sync-setup-preview-progress");
          if (progress) progress.textContent = this.setupMessage;
        };
        const timer = window.setInterval(updateProgress, 1000);
        try {
          await this.plugin.inspectSetupRepository((message) => { stage = message; updateProgress(); });
        } finally {
          window.clearInterval(timer);
        }
        this.setupMessage = "✓ 检查完成，请依次确认忽略规则、追踪和文件差异。";
      }, undefined, false));
    }
    if (!preview) return;
    if (this.setupReviewPreview !== preview) {
      this.setupReviewPreview = preview;
      this.setupReviewStage = 1;
      this.setupBaseConfirmed = false;
      this.setupRulesConfirmed = false;
      this.setupRebuildConfirmed = false;
    }
    const summary = body.createDiv({ cls: "simple-one-sync-setup-detail" });
    new Setting(summary).setName("两端检查概况").setHeading();
    const overview = summary.createDiv({ cls: "simple-one-sync-setup-overview" });
    for (const [label, value] of [["本机文件", preview.localFiles.length], ["GitHub 文件", preview.remoteFiles.length], ["仅本机", preview.localOnly.length], ["仅 GitHub", preview.remoteOnly.length], ["同名差异", preview.overlaps.length]] as [string, number][]) {
      const item = overview.createDiv({ cls: "simple-one-sync-setup-overview__item" });
      item.createEl("strong", { text: String(value) });
      item.createSpan({ text: label });
    }
    if (preview.nestedRepos.length) summary.createEl("p", {
      text: `发现 ${preview.nestedRepos.length} 个内嵌 Git 仓库。只会排除它们的 .git 元数据；这些仓库自己的历史不受影响。`,
      cls: "simple-one-sync-section-desc"
    });
    if (preview.alreadyLinked) summary.createEl("p", { text: "本机已包含 GitHub 的提交记录，可以继续核对文件。", cls: "simple-one-sync-setup-done" });
    else if (preview.relatedHistory) summary.createEl("p", { text: "两端有共同历史；完成接入时会合并 GitHub 的新提交，冲突会停下等待处理。", cls: "simple-one-sync-section-desc" });
    summary.createEl("p", { text: preview.localRoot ? `本机分支：${preview.localBranch} · GitHub 分支：${preview.branch}` : `当前 Vault 还没有 Git 仓库；完成接入时会创建 ${preview.branch} 分支。`, cls: "simple-one-sync-section-desc" });
    if (preview.localRoot && !preview.relatedHistory && preview.localBranch !== preview.branch) summary.createEl("p", {
      text: `本机已有独立历史，${preview.localBranch} 分支将接入远端 ${preview.branch} 分支，请确认目标仓库。`, cls: "simple-one-sync-section-desc"
    });
    const nav = body.createDiv({ cls: "simple-one-sync-setup-nav simple-one-sync-review-nav", attr: { "aria-label": "两端检查确认进度" } });
    ["忽略规则基准", "建议规则与追踪", "文件差异"].forEach((label, index) => {
      const stage = (index + 1) as 1 | 2 | 3;
      const done = stage === 1 ? this.setupBaseConfirmed : stage === 2 ? this.setupRulesConfirmed : false;
      const button = nav.createEl("button", { cls: `simple-one-sync-setup-nav__step${this.setupReviewStage === stage ? " is-active" : ""}${done ? " is-done" : ""}`,
        attr: { type: "button", "aria-current": this.setupReviewStage === stage ? "step" : "false" } });
      button.createSpan({ text: String(stage), cls: "simple-one-sync-setup-nav__marker" });
      button.createSpan({ text: label, cls: "simple-one-sync-setup-nav__label" });
      button.disabled = this.setupBusy || (stage === 2 && !this.setupBaseConfirmed) || (stage === 3 && !this.setupRulesConfirmed);
      button.addEventListener("click", () => { this.setupReviewStage = stage; this.renderSettings(); });
    });
    const module = body.createDiv({ cls: "simple-one-sync-setup-detail simple-one-sync-review-module" });
    const footer = () => module.createDiv({ cls: "simple-one-sync-setup-footer simple-one-sync-review-footer" });
    const ignoreChoice = this.plugin.getSetupChoices()[".gitignore"];
    if (this.setupReviewStage === 1) {
      new Setting(module).setName("1 · 选择 Git 忽略规则基准").setHeading();
      const differs = setupIgnoreDiffers(preview);
      module.createEl("p", { text: differs ? "两端 .gitignore 不同。先查看规则，再在下方选择作为基准的版本。" : "两端 .gitignore 一致，确认后继续检查建议规则。" });
      if (differs) {
        const compare = module.createEl("button", { text: "查看差异 / 合并编辑", attr: { type: "button" } });
        compare.disabled = this.setupBusy;
        compare.addEventListener("click", () => void this.reviewSetupIgnoreDifferences(preview));
      }
      if (preview.customIgnore !== undefined) {
        module.createEl("p", { text: "✓ 已保存合并编辑结果，作为本次接入的规则基准。", cls: "simple-one-sync-setup-done" });
        const result = module.createEl("details", { cls: "simple-one-sync-setup-files" });
        result.createEl("summary", { text: "查看已合并的完整基准" });
        result.createEl("pre", { text: preview.customIgnore || "（空）" });
      }
      const actions = footer();
      if (differs) {
        const choice = new Setting(actions).setName("使用哪一端作为基准？");
        for (const base of ["local", "remote"] as const) choice.addButton(button => {
          button.setButtonText(base === "local" ? "应用本地" : "应用远端").setDisabled(this.setupBusy);
          if (ignoreChoice === base && preview.customIgnore === undefined) button.setCta();
          button.onClick(() => {
            this.plugin.setSetupChoice(".gitignore", base);
            this.setupBaseConfirmed = false;
            this.setupRulesConfirmed = false;
            this.setupRebuildConfirmed = false;
            this.renderSettings();
          });
        });
      }
      const next = actions.createEl("button", { text: "确认基准，下一步", cls: "mod-cta", attr: { type: "button" } });
      next.disabled = this.setupBusy || (differs && !ignoreChoice);
      next.addEventListener("click", () => this.confirmSetupIgnoreBase());
    } else if (this.setupReviewStage === 2) {
      new Setting(module).setName("2 · 建议规则与文件追踪").setHeading();
      module.createEl("p", { text: `以${preview.customIgnore !== undefined ? "合并编辑后的" : ignoreChoice === "remote" ? "远端" : "本机"}规则为基准，补充 ${preview.missingIgnoreRules.length} 条建议规则，保护缓存、凭据、本机状态及内嵌仓库的 .git 元数据。原有用户规则保留。` });
      this.renderSetupRuleCards(module, "查看建议规则", setupIgnoreRuleGroups(preview, this.plugin.app.vault.configDir));
      const customTitle = preview.customIgnore !== undefined ? "合并后的自有规则" : ignoreChoice === "remote" ? "远端自有规则" : "本机自有规则";
      this.renderSetupRuleCards(module, "查看最终 .gitignore", setupFinalIgnoreRuleGroups(preview, this.plugin.app.vault.configDir, customTitle));
      const original = module.createEl("details", { cls: "simple-one-sync-setup-files" });
      original.createEl("summary", { text: "查看完整文件（含注释与原始顺序）" });
      original.createEl("pre", { text: preview.optimizedIgnore || "（空）" });
      const excluded = preview.trackedExcludedLocal.length + preview.trackedExcludedRemote.length;
      module.createEl("p", { text: `本机 ${preview.trackedExcludedLocal.length} 个、远端 ${preview.trackedExcludedRemote.length} 个文件已被追踪，但符合忽略规则。` });
      this.setupFileList(module, "本机建议停止追踪", preview.trackedExcludedLocal);
      this.setupFileList(module, "远端建议停止追踪", preview.trackedExcludedRemote);
      module.createEl("p", { text: "重建追踪会保留本机文件；第四步提交并推送后，这些文件将从远端当前版本退出。仅添加忽略规则不会停止追踪已有文件。" });
      const actions = footer();
      if (excluded && !this.plugin.settings.setupComplete) {
        actions.createEl("p", { text: "确认应用建议规则，并选择如何处理已有追踪：" });
        for (const choice of ["rebuild", "keep"] as const) {
          const button = actions.createEl("button", { text: choice === "rebuild" ? "应用建议并重建追踪，下一步" : "应用建议但保留追踪，下一步", cls: choice === "rebuild" ? "mod-cta" : "", attr: { type: "button" } });
          button.disabled = this.setupBusy;
          button.addEventListener("click", () => this.confirmSetupRules(choice));
        }
      } else {
        const button = actions.createEl("button", { text: this.plugin.settings.setupComplete ? "已查看规则，下一步" : "确认应用建议规则，下一步", cls: "mod-cta", attr: { type: "button" } });
        button.disabled = this.setupBusy;
        button.addEventListener("click", () => this.confirmSetupRules());
      }
    } else {
      new Setting(module).setName("3 · 确认文件差异").setHeading();
      this.setupFileList(module, "仅本机文件", preview.localOnly);
      this.setupFileList(module, "仅远端文件", preview.remoteOnly);
      const files = preview.overlaps.filter(path => path !== ".gitignore");
      const choices = this.plugin.getSetupChoices();
      if (this.plugin.settings.setupComplete) this.setupFileList(module, "同名文件", files);
      else if (files.length) module.createEl("p", { text: `同名差异已选择 ${files.filter(path => !!choices[path]).length} / ${files.length} 个文件。忽略规则已在第一环节单独确认。` });
      else module.createEl("p", { text: "没有需要逐项选择的同名文件差异。", cls: "simple-one-sync-setup-done" });
      module.createEl("p", { text: "本页仅确认方案；实际合并、提交与推送在第四步执行。" });
      const actions = footer();
      if (files.length && !this.plugin.settings.setupComplete) {
        const resolve = actions.createEl("button", { text: "对照并选择文件版本", attr: { type: "button" } });
        resolve.disabled = this.setupBusy;
        resolve.addEventListener("click", () => {
          new SetupDifferencesModal(this.app, files, choices, path => this.plugin.readSetupOverlap(path), selected => {
            if (this.plugin.getSetupPreview() !== preview) return;
            for (const path of files) this.plugin.setSetupChoice(path, selected[path]);
            this.updateSetupPreviewSelection();
          }).open();
        });
      }
      if (!this.plugin.settings.setupComplete) {
        const next = actions.createEl("button", { text: "确认差异，进入完成接入", cls: "mod-cta", attr: { type: "button" } });
        next.disabled = this.setupBusy || !this.setupPreviewReady();
        next.addEventListener("click", () => void this.runSetup(() => this.advanceSetupAfterPreview(), "", false));
      }
    }
  }

  private renderSetupRuleCards(container: HTMLElement, title: string, groups: { title: string; rules: string[] }[]): void {
    const section = container.createEl("details", { cls: "simple-one-sync-rule-section" });
    section.createEl("summary", { text: title });
    const cards = section.createDiv({ cls: "simple-one-sync-rule-cards" });
    for (const group of groups) {
      const rules = [...new Set(group.rules)];
      const card = cards.createEl("details", { cls: "simple-one-sync-rule-card" });
      const heading = card.createEl("summary");
      heading.createSpan({ text: group.title, cls: "simple-one-sync-rule-card__title" });
      heading.createSpan({ text: `${rules.length} 条`, cls: "simple-one-sync-rule-card__count" });
      card.createEl("pre", { text: rules.join("\n") });
    }
    if (!groups.length) section.createEl("p", { text: "没有规则。", cls: "simple-one-sync-section-desc" });
  }

  private async reviewSetupIgnoreDifferences(preview: SetupPreview): Promise<void> {
    if (!setupIgnoreDiffers(preview)) return;
    const host = this.settingsHost ?? this.containerEl;
    const result = await new ZoeySyncConflictPreviewModal(this.app, {
      editableColumns: true,
      title: ".gitignore 差异与合并",
      description: "仅展示变化区块。确认后保存接入基准，第四步才应用到仓库；相同内容会原样保留。",
      files: [{ path: ".gitignore", description: "规则内容差异", totalLines: 0,
        localUpdatedAt: "", remoteUpdatedAt: "", blocks: [], mergeable: true }],
      read: async () => ({ local: setupIgnoreComparisonText(preview.localIgnore), remote: setupIgnoreComparisonText(preview.remoteIgnore) })
    }).wait();
    if (!result || this.plugin.getSetupPreview() !== preview || !host?.isConnected ||
      (this.settingsHost ?? this.containerEl) !== host || this.desktopPage !== "setup" || this.setupViewStep !== 3) return;
    const choice = result[".gitignore"];
    if (choice?.choice === "manual" && choice.text !== undefined) this.plugin.setSetupIgnoreMerge(choice.text);
    else if (choice?.choice === "local" || choice?.choice === "remote") this.plugin.setSetupChoice(".gitignore", choice.choice);
    else return;
    this.setupBaseConfirmed = false;
    this.setupRulesConfirmed = false;
    this.setupRebuildConfirmed = false;
    this.renderSettings();
  }

  private confirmSetupIgnoreBase(): void {
    const preview = this.plugin.getSetupPreview();
    if (!preview || this.setupBusy || (setupIgnoreDiffers(preview) && !this.plugin.getSetupChoices()[".gitignore"])) return;
    if (!this.plugin.getSetupChoices()[".gitignore"]) this.plugin.setSetupChoice(".gitignore", "local");
    this.setupBaseConfirmed = true;
    this.setupReviewStage = 2;
    this.renderSettings();
  }

  private confirmSetupRules(choice?: "keep" | "rebuild"): void {
    const preview = this.plugin.getSetupPreview();
    if (!preview || this.setupBusy || !this.setupBaseConfirmed) return;
    if (!this.plugin.settings.setupComplete && (preview.trackedExcludedLocal.length || preview.trackedExcludedRemote.length) && !choice) return;
    if (choice) this.plugin.setSetupTrackingChoice(choice);
    this.setupRebuildConfirmed = choice === "rebuild";
    this.setupRulesConfirmed = true;
    this.setupReviewStage = 3;
    this.renderSettings();
  }

  private setupPreviewReady(): boolean {
    const preview = this.plugin.getSetupPreview();
    if (!preview) return false;
    const choices = this.plugin.getSetupChoices();
    if (setupIgnoreDiffers(preview) && !choices[".gitignore"]) return false;
    if (preview.overlaps.some((path) => !choices[path])) return false;
    return !(preview.trackedExcludedLocal.length || preview.trackedExcludedRemote.length) || !!this.plugin.getSetupTrackingChoice();
  }

  private setupFileList(body: HTMLElement, title: string, paths: string[]): void {
    if (paths.length === 0) return;
    const details = body.createEl("details", { cls: "simple-one-sync-setup-files" });
    details.createEl("summary", { text: `${title}（${paths.length}）` });
    for (const path of paths.slice(0, 200)) details.createDiv({ text: path });
    if (paths.length > 200) details.createEl("p", { text: `还有 ${paths.length - 200} 个文件未在这里展开。` });
  }

  private displaySetupFinish(body: HTMLElement): void {
    const preview = this.plugin.getSetupPreview();
    if (!preview) {
      body.createEl("p", { text: this.plugin.settings.setupComplete && this.plugin.settings.setupVerified
        ? `已接入 ${this.plugin.settings.setupVerified.url}。如需查看当前两端文件，请返回第 3 步重新读取。`
        : this.plugin.settings.setupComplete
          ? "当前连接来自旧版设置，尚未经过此向导；如需检查接入，请从第一步重新开始。"
        : "本次打开后尚无检查结果，请返回第 3 步重新检查。" });
      return;
    }
    const remoteIgnoreSelected = this.plugin.getSetupChoices()[".gitignore"] === "remote";
    const ignoreSummary = preview.customIgnore !== undefined ? `将采用合并编辑后的 .gitignore，并补充 ${preview.missingIgnoreRules.length} 条建议规则。` : remoteIgnoreSelected ? `将以远端 .gitignore 为基准优化，补充 ${preview.missingIgnoreRules.length} 条建议规则。`
      : preview.missingIgnoreRules.length ? `将保留现有 .gitignore，并补充 ${preview.missingIgnoreRules.length} 条建议规则。`
      : "现有 .gitignore 已包含建议规则。";
    body.createEl("p", { text: `将保留本地 ${preview.localFiles.length} 个文件，并接入远端 ${preview.remoteFiles.length} 个文件。${ignoreSummary}` });
    if (preview.nestedRepos.length) body.createEl("p", {
      text: `已识别 ${preview.nestedRepos.length} 个内嵌仓库；${this.plugin.settings.setupComplete ? "下次同步" : "完成接入"}时将重建主仓库对小库文件的追踪，并忽略小库的 .git 元数据。`,
      cls: "simple-one-sync-section-desc"
    });
    if (preview.localRoot) {
      const trackingChoice = this.plugin.getSetupTrackingChoice();
      body.createEl("p", { text: trackingChoice === "rebuild"
        ? "已选择按忽略规则重建追踪。本机文件保留；下次推送后，被忽略文件会从 GitHub 当前版本退出。"
        : trackingChoice === "keep"
          ? "已选择暂时保留现有追踪；已提交的本机状态仍会继续同步。"
          : "本次保持现有追踪；如需清理已提交的本机文件，可在 Git 同步设置中检查并修复。", cls: "simple-one-sync-section-desc" });
    }
    const authorNameSetting = new Setting(body).setName("提交作者名称").setDesc("显示在 Git 提交记录中，不是登录账号。")
      .addText((text) => text.setValue(this.plugin.settings.gitAuthorName === DEFAULT_GIT_AUTHOR_NAME ? "" : this.plugin.settings.gitAuthorName).onChange(async (value) => {
        this.plugin.settings.gitAuthorName = value.trim();
        await this.plugin.saveSettings();
      }));
    authorNameSetting.settingEl.addClass("simple-one-sync-setup-author-setting");
    const authorEmailSetting = new Setting(body).setName("提交作者邮箱").setDesc("用于 Git 提交记录，不是登录密码。")
      .addText((text) => text.setValue(this.plugin.settings.gitAuthorEmail === DEFAULT_GIT_AUTHOR_EMAIL ? "" : this.plugin.settings.gitAuthorEmail).onChange(async (value) => {
        this.plugin.settings.gitAuthorEmail = value.trim();
        await this.plugin.saveSettings();
      }));
    authorEmailSetting.settingEl.addClass("simple-one-sync-setup-author-setting");
    if (!this.plugin.settings.setupComplete && preview.missingIgnoreRules.length > 0) {
      const rules = body.createEl("details", { cls: "simple-one-sync-setup-files" });
      rules.createEl("summary", { text: `查看将补充的 ${preview.missingIgnoreRules.length} 条 .gitignore 规则` });
      rules.createEl("pre", { text: preview.missingIgnoreRules.join("\n") });
    }
    if (preview.overlaps.length) this.setupFileList(body, "已选择远端版本的同名文件", preview.overlaps.filter((path) => this.plugin.getSetupChoices()[path] === "remote"));
    if (this.setupBusy || this.setupFailure) {
      body.createEl("p", {
        text: this.setupBusy ? "正在完成接入，请稍候…" : this.setupMessage,
        cls: `simple-one-sync-setup-finish-progress ${this.setupFailure ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback"}`,
        attr: { role: "status", "aria-live": "polite" }
      });
    }
    if (!this.plugin.settings.setupComplete) {
      const footer = body.createDiv({ cls: "simple-one-sync-setup-footer" });
      const finish = footer.createEl("button", { text: "完成接入并首次推送", cls: "mod-cta", attr: { type: "button" } });
      finish.disabled = this.setupBusy || (this.plugin.getSetupTrackingChoice() === "rebuild" && !this.setupRebuildConfirmed);
      finish.addEventListener("click", () => void this.runSetup(() => this.plugin.finishSetup(this.setupRebuildConfirmed, (message, error) => {
        if (this.desktopPage !== "setup" || this.setupViewStep !== 4) return;
        this.setupMessage = message;
        const progress = (this.settingsHost ?? this.containerEl).querySelector(".simple-one-sync-setup-finish-progress");
        if (progress) {
          progress.textContent = message;
          progress.toggleClass("simple-one-sync-setup-error", !!error);
          progress.toggleClass("simple-one-sync-setup-feedback", !error);
        }
      }), "首次推送成功，向导已完成。"));
    }
  }

  private displayDesktopAdvanced(containerEl: HTMLElement): void {
    const preview = this.currentDevice() !== "git";
    const section = (title: string): HTMLElement => {
      const card = settingsSection(containerEl, title);
      card.addClass("simple-one-sync-advanced__body");
      return card;
    };
    let advancedBody = section("自动备份设置");
    new Setting(advancedBody)
      .setName("停止修改后备份（分钟）")
      .setDesc("持续多久没有文件变化后保存本地版本（commit），随即上传（push）。设为 0 可关闭。")
      .addText((text) => this.addTimingInput(text, "autoCommitIdleMinutes", 5));
    new Setting(advancedBody)
      .setName("连续修改时备份（分钟）")
      .setDesc("从首次未备份改动起，最长等待此时间就 commit 并 push；持续修改不会推迟。设为 0 可关闭。")
      .addText((text) => this.addTimingInput(text, "maxUncommittedMinutes", 30));

    advancedBody = section("自动获取云端更新设置");
    new Setting(advancedBody)
      .setName("启动后备份并检查云端更新")
      .setDesc("启动后先 commit 当前本机改动，再获取并合并云端更新；有待上传版本时接着 push。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pullOnStartup).onChange(async (value) => {
          this.plugin.settings.pullOnStartup = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(advancedBody)
      .setName("自动 fetch 与 merge 间隔（分钟）")
      .setDesc("按此时间间隔获取云端最新提交并合并到本机；不会执行 push。设为 0 可关闭。")
      .addText((text) => this.addTimingInput(text, "autoPullIntervalMinutes", 5));

    advancedBody = section("Git 上传设置");
    new Setting(advancedBody)
      .setName("分支")
      .setDesc("默认使用 master；只有仓库使用其他分支时才需要修改。")
      .addText((text) =>
        text.setValue(this.plugin.settings.gitBranch).onChange(async (value) => {
          this.plugin.settings.gitBranch = value.trim() || "master";
          await this.plugin.saveSettings();
        })
      );
    new Setting(advancedBody)
      .setName("提交作者名称")
      .setDesc("Git 创建版本记录时使用；通常会自动读取本机已有的 Git 配置。")
      .addText((text) =>
        text.setValue(this.plugin.settings.gitAuthorName).onChange(async (value) => {
          this.plugin.settings.gitAuthorName = value.trim();
          await this.plugin.saveSettings();
        })
      );
    new Setting(advancedBody)
      .setName("提交作者邮箱")
      .setDesc("用于标识 Git 提交作者，不是登录密码；通常会自动读取。")
      .addText((text) =>
        text.setValue(this.plugin.settings.gitAuthorEmail).onChange(async (value) => {
          this.plugin.settings.gitAuthorEmail = value.trim();
          await this.plugin.saveSettings();
        })
      );

    advancedBody = section("故障排查");
    new Setting(advancedBody).setName("按忽略规则修复追踪")
      .setDesc("先检查 .gitignore 和已追踪文件，再只让应忽略的文件退出 Git 跟踪。本机文件保留；不会立即 commit 或 push。若有未解决的合并冲突，请先处理。")
      .addButton((button) => button.setButtonText("检查并修复文件追踪").setDisabled(preview).onClick(async () => {
        button.setDisabled(true);
        button.setButtonText("正在检查…");
        try {
          const result = await this.plugin.inspectFileTracking();
          new FileTrackingModal(this.app, this.plugin, result).open();
        } catch (error) {
          new Notice(`同步与分享：无法检查文件追踪。${messageOf(error)}`, 10000);
        } finally {
          button.setDisabled(false);
          button.setButtonText("检查并修复文件追踪");
        }
      }));
    new Setting(advancedBody)
      .setName("异常修复")
      .setDesc("恢复未完成的 rebase、merge 等 Git 操作，以当前本机内容重新 commit，再 fetch 并 merge；不会立即 push。")
      .addButton((button) =>
        button.setButtonText("恢复正常同步").setDisabled(preview).onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("正在检查…");
          try {
            const operation = await this.plugin.getInterruptedGitOperationLabel();
            if (!operation) {
              new Notice("同步与分享：没有检测到未完成的 rebase、merge、cherry-pick 或 revert");
              return;
            }
            new GitRepairModal(this.app, this.plugin, operation).open();
          } catch (error) {
            new Notice(`同步与分享：无法检查 Git 状态。${messageOf(error)}`, 10000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("恢复正常同步");
          }
        })
      );
    new Setting(advancedBody)
      .setName("本地 Git 历史瘦身")
      .setDesc("默认保留最近 30 天的本地历史。先联网确认当前 commit 已上传，再清理本机旧历史；不会删除 GitHub 上的版本。")
      .addButton((button) =>
        button.setButtonText("检查并预览").setDisabled(preview).onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("正在核验…");
          try {
            const result = await this.plugin.inspectLocalHistory();
            new LocalHistorySlimModal(this.app, this.plugin, result).open();
          } catch (error) {
            new Notice(`同步与分享：无法预览本地历史。${messageOf(error)}`, 12000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("检查并预览");
          }
        })
      );
    const logs = this.plugin.getRecentErrorLogs();
    const errorCount = logs.filter((entry) => entry.status !== "success").length;
    new Setting(advancedBody)
      .setName("最近同步日志")
      .setDesc(
        errorCount > 0
          ? `最近 24 小时共 ${logs.length} 条记录，其中 ${errorCount} 条错误。`
          : `最近 24 小时共 ${logs.length} 条记录，没有错误。`
      )
      .addButton((button) =>
        button.setButtonText("查看日志").onClick(() => new ErrorLogModal(this.app, this.plugin).open())
      );
  }

  private addTimingInput(
    text: import("obsidian").TextComponent,
    key:
      | "autoCommitIdleMinutes"
      | "maxUncommittedMinutes"
      | "autoPullIntervalMinutes",
    fallback: number
  ): void {
    text.inputEl.type = "number";
    text.inputEl.min = "0";
    text.inputEl.step = "1";
    text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
      this.plugin.settings[key] = Math.max(0, Number(value) || (value.trim() === "0" ? 0 : fallback));
      await this.plugin.saveSettings();
      await this.plugin.restartDesktopAutomation();
    });
  }
}


const asyncAction = runAsync;
