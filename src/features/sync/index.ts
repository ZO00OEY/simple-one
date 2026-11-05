import { tooltipText } from "../../shared/tooltipText";
import { createFileListLayout, fileListPanel, renderLayoutToggle, FileListLayout, renderFileTree, renderPathTree } from "./fileTree";
import { remoteSnapshotRef } from "./directRemote";
import { legacyScopeRules, readRootIgnore, rootIgnoreMatcher, organizedLocalIgnore } from "./localIgnore";
import { inspectIgnoreTracking, applyIgnoreTracking, preserveRootIgnore, type IgnoreTrackingPlan } from "./nativeIgnore";
import { setActionIcon, styleActionButton } from "../../shared/actionButton";
import { compactSettingsSection } from "../../shared/settingsLayout";
import { desktopProcess, type NodeFs, type NodePath, type NodeCommands, type NodeChildProcess } from "../../shared/desktopNode";
import {
  addIcon,
  App,
  Component,
  EventRef,
  FileSystemAdapter,
  ItemView,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  requestUrl,
  requireApiVersion,
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
import type SimplePlugin from "../../main";
import { assertNoPrivateSyncFiles, coalesceDirty, defaultSyncIgnorePatterns, DirtyEntry, shouldIgnore } from "./dirty";
import {
  ChangeItem,
  findRemoteChangeOverlaps,
  parseGitNameStatus,
  parseGitStatus
} from "./gitStatus";
import { applyConflictResolutions, ConflictBlock, parseConflictBlocks } from "./conflict";
import { describeGitIndexLockError, describeGitError, isMissingRemoteRefError, isTransientGitNetworkError, isUncertainGitAuthError } from "./gitError";
import { LiveReview, ZoeySyncConflictPreviewModal } from "./conflictPreview";
import { SetupDifferencesModal } from "./setupDifferences";
import { GitSetup, OverlapChoice, SetupOverlapContent, SetupPreview, VerifiedRepo, explainSetupError, parseGithubRepoUrl } from "./onboarding";
import { preserveUntrackedFiles } from "./untrackedFiles";
import { transferProgress } from "./transferProgress";
import { hasCaseInsensitivePathCollisions, isInvalidGitPathError, repairRemoteFilenames } from "./remoteFilenameRepair";
import { findNestedRepos, nestedRepoFiles, rebuildNestedRepoTracking } from "./nestedRepos";

import { DEFAULT_MOBILE_OPTIONS, LocalSyncEdit, MobileOptions, newPathRecords } from "./linkDiff";
import { ConflictChoice, MobileGithub, MobilePlan, VerifiedAccess } from "./mobileGithub";
import { MobileHost, MobileSyncModal, renderMobileSettings, type MobileSyncFlow } from "./mobileUi";
import { renderDownloadTask, renderPlanConfirmation, renderStrategy } from "./syncFlowUi";
import type { SyncStrategy } from "./syncPlan";

type ViewStatusTone = "success" | "pending" | "error" | "checking" | "commit" | "fetch" | "merge" | "push";

interface ViewStatusState {
  text: string;
  tone: ViewStatusTone;
}

interface DesktopCommitResult {
  committed: boolean;
}

type FileTrackingPreview = IgnoreTrackingPlan;

interface InterruptedGitOperation {
  ref: string;
  label: string;
  abortArgs: string[];
}

interface GitRepairResult {
  lockOnly?: boolean;
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

addIcon(
  CHECKBOX_CHECKED_ICON,
  '<g fill="none" stroke="currentColor" stroke-width="8.333" stroke-linecap="round" stroke-linejoin="round"><rect x="12.5" y="12.5" width="75" height="75" rx="8.333"/><path d="m29.167 50.417 13.333 13.333 29.167-30"/></g>'
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
  status?: "success" | "error" | "pending";
  timings?: Array<{ title: string; message: string }>;
}

interface PluginSettings {
  recordSyncPerformance: boolean;
  legacyMigrationPending: boolean;
  mobile: MobileOptions;
  lightweightGuideProgress?: { step: number; complete: boolean; repoUrl: string; branch: string; login: string };
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
  backupOnStartup: boolean;
  autoPullIntervalMinutes: number;
  pendingMergePushAfterResolve: boolean;
  errorLogs: ErrorLogEntry[];
}

const DEFAULT_SETTINGS: PluginSettings = {
  recordSyncPerformance: false,
  enabled: false,
  legacyMigrationPending: false,
  boundRepoUrl: "",
  mobile: { ...DEFAULT_MOBILE_OPTIONS, plugins: [...DEFAULT_MOBILE_OPTIONS.plugins], ignorePatterns: [] },
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
  autoCommitIdleMinutes: 30,
  maxUncommittedMinutes: 60,
  pullOnStartup: true,
  backupOnStartup: false,
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
  "backupOnStartup",
  "autoPullIntervalMinutes"
]);

function pickLocalSettings(source: Partial<PluginSettings>): Partial<PluginSettings> {
  const result: Partial<PluginSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof PluginSettings>) {
    if (!SHARED_SETTING_KEYS.has(key) && source[key] !== undefined) {
      (result as Record<string, unknown>)[key] = source[key];
    }
  }
  for (const key of ["setupVerified", "setupBackup", "lightweightGuideProgress"] as const) {
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
  // Errors from other windows or hosts do not share this realm’s Error constructor.
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : String(error);
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
  openSettings?: (share?: boolean) => void;
  private syncSecrets() { return requireApiVersion("1.11.4") ? this.app.secretStorage : undefined; }
  private loadData(): Promise<unknown> { return readLocalSyncSettings(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, this.syncSecrets()); }
  private saveData(value: unknown): Promise<void> { return writeLocalSyncSettings(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, value, this.syncSecrets()); }

  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private syncing = false;
  private desktopTaskActive = false;
  private featureActive = false;
  private suppressPaths = new Set<string>();
  private statusEl?: HTMLElement;
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
  private desktopStartupTimer?: number;
  private desktopStartupGeneration = 0;
  private desktopGitQueue: Promise<void> = Promise.resolve();
  private desktopGitProcesses = new Map<NodeChildProcess, Promise<void>>();
  private setupGitPaused = false;
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
  private lightweightPlan?: MobilePlan;
  private switchingSyncMode = false;
  private mobileAutomationGeneration = 0;

  async initialize(): Promise<void> {
    await migrateLinkFiles(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, !legacySyncRunning(this.app), SHARED_SETTING_KEYS);
    await this.loadSettings();
    if (this.settings.enabled && legacySyncRunning(this.app)) {
      this.settings.enabled = false;
      await this.saveSettings();
      new Notice("旧 Simple Link 仍在运行，请先关闭旧插件的同步，再启用同步。");
    }
    if (this.settings.enabled && this.useLightweightSync()) await this.getMobileGithub().load();
    if (!Platform.isMobile) await this.detectDesktopGitDefaults();
    this.statusEl = this.host.addStatusBarItem();
    this.host.registerView(ZoeySyncView.type, (leaf) => new ZoeySyncView(leaf, this));
    this.host.registerView(ZoeySyncConflictView.type, (leaf) => new ZoeySyncConflictView(leaf, this));
    this.host.addCommand({ id: "sync-now", name: "同步笔记", callback: () => void this.syncNow(true) });
    this.host.addCommand({ id: "test-connection", name: "测试同步连接", callback: () => void this.testConnection(true) });
    this.host.addCommand({ id: "recalibrate-mobile-hashes", name: "重新校验轻量同步范围哈希", callback: () => void this.calibrateMobileHashes() });
    this.host.addCommand({ id: "open-sync-view", name: "打开同步", callback: () => void this.openSyncView() });
    if (this.settings.enabled) {
      this.activateFeature();
    } else if (this.statusEl) this.statusEl.addClass("simple-one-sync-hidden");
  }

  onunload(): void {
    this.deactivateFeature();
  }

  async setFeatureEnabled(enabled: boolean): Promise<void> {
    if (this.switchingSyncMode) { new Notice("请等待同步模式切换完成。"); return; }
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
    await this.changeSyncMode(enabled, () => {
      this.settings.mobileSyncEnabled = enabled;
      if (enabled) {
        this.settings.mobile.mode = "github";
        this.settings.desktopGitEnabled = false;
        this.settings.desktopLightweightEnabled = false;
      }
    });
  }

  async setDesktopSyncMode(mode: "git" | "lightweight" | "off"): Promise<void> {
    if (Platform.isMobile) return;
    await this.changeSyncMode(mode === "lightweight", () => {
      this.settings.desktopGitEnabled = mode === "git";
      this.settings.desktopLightweightEnabled = mode === "lightweight";
      if (mode !== "off") this.settings.mobile.mode = "github";
    });
  }

  private async changeSyncMode(loadLightweight: boolean, apply: () => void): Promise<void> {
    if (this.syncing || this.switchingSyncMode) { new Notice("请等待当前同步或模式切换完成。"); return; }
    this.switchingSyncMode = true;
    const previous = {
      desktopGitEnabled: this.settings.desktopGitEnabled,
      desktopLightweightEnabled: this.settings.desktopLightweightEnabled,
      mobileSyncEnabled: this.settings.mobileSyncEnabled
    };
    const previousMobileMode = this.settings.mobile.mode;
    const previousStartupPullScheduled = this.startupPullScheduled;
    let saveAttempted = false;
    try {
      this.deactivateFeature();
      // Keep the running Git task's settings intact until it safely finishes.
      await this.desktopGitQueue;
      this.clearDesktopTimeouts();
      if (loadLightweight) await this.getMobileGithub().load();
      apply();
      this.startupPullScheduled = false;
      saveAttempted = true;
      await this.saveSettings();
      if (this.settings.enabled) this.activateFeature();
    } catch (error) {
      this.deactivateFeature();
      Object.assign(this.settings, previous);
      this.settings.mobile.mode = previousMobileMode;
      this.startupPullScheduled = previousStartupPullScheduled;
      try {
        if (saveAttempted) await this.saveSettings();
        if (this.settings.enabled) this.activateFeature();
      } catch (restoreError) {
        this.deactivateFeature();
        this.settings.enabled = false;
        const failure = new Error(`同步模式切换失败：${messageOf(error)}；恢复旧模式失败：${messageOf(restoreError)}。同步已停止，请检查设置后重新启用。`);
        this.setStatus(failure.message);
        throw failure;
      }
      throw error;
    } finally {
      this.switchingSyncMode = false;
      await this.refreshSyncView();
    }
  }

  getMobileGithub(): MobileGithub {
    if (!this.mobileGithub) {
      this.mobileGithub = new MobileGithub(this.app.vault.adapter,
        this.app.vault.configDir, this.manifest.id, () => this.settings.mobile,
        (message) => {
          if (this.syncing) this.setSyncActivity(message, "checking");
          else this.setStatus(message);
        }, (context, status, message) => this.recordOperationLog(context, status, message),
        () => this.settings.recordSyncPerformance === true);
      this.register(this.mobileGithub.onRemainingChange(() => {
        for (const leaf of this.app.workspace.getLeavesOfType(ZoeySyncView.type)) {
          if (leaf.view instanceof ZoeySyncView) leaf.view.updateQuota();
        }
      }));
    }
    return this.mobileGithub;
  }

  async restartLightweightSetup(): Promise<boolean> {
    if (this.syncing || this.switchingSyncMode || this.desktopTaskActive || this.host.share?.busy) throw new Error("请等待当前同步或发布任务停止后重新接入。");
    if (legacySyncRunning(this.app)) throw new Error("请先关闭旧 Simple Link 同步，再重新接入。");
    this.switchingSyncMode = true;
    try {
      const preserved = await this.getMobileGithub().restartSetup();
      this.settings.mobile.bound = false;
      this.settings.lightweightGuideProgress = undefined;
      await this.saveSettings();
      await this.mobileHost().save();
      this.setStatus(preserved ? "已清理未完成同步，保留共同基线 · 请重新接入" : "已清理未完成同步 · 请重新接入并核对两端文件");
      return preserved;
    } finally { this.switchingSyncMode = false; }
  }

  async completeLightweightGuide(options: MobileOptions, onProgress?: (message: string) => void): Promise<void> {
    if (this.host.share?.busy) throw new Error("请等待笔记分享发布完成。");
    if (legacySyncRunning(this.app)) throw new Error("请先关闭旧 Simple Link 的同步，再完成新入口的接入。");
    if (this.syncing || this.switchingSyncMode || this.desktopTaskActive) throw new Error("请等待当前同步或模式切换完成后重试。");
    this.switchingSyncMode = true;
    this.deactivateFeature();
    const previous = { mobile: this.settings.mobile, boundRepoUrl: this.settings.boundRepoUrl,
      desktopGitEnabled: this.settings.desktopGitEnabled, desktopLightweightEnabled: this.settings.desktopLightweightEnabled,
      mobileSyncEnabled: this.settings.mobileSyncEnabled, enabled: this.settings.enabled,
      lightweightGuideProgress: this.settings.lightweightGuideProgress };
    const candidate = { ...options, plugins: [...options.plugins], ignorePatterns: [...options.ignorePatterns], mode: "github" as const, bound: false };
    let engine: MobileGithub | undefined;
    let previousState: MobileGithub["state"] | undefined;
    let complete = false;
    const current = () => { if (this.settings.mobile !== candidate) throw new Error("接入配置已变化，请重新核验仓库。"); };
    try {
      await this.desktopGitQueue;
      if (this.settings.legacyMigrationPending) {
        await migrateLinkFiles(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, true, SHARED_SETTING_KEYS);
        this.settings.legacyMigrationPending = false; this.mobileGithub = undefined;
      }
      engine = this.getMobileGithub();
      await engine.load();
      if (engine.state.pending || engine.state.downloadVerification) throw new Error("还有未完成的同步或下载验证，请先用原连接恢复或重新检查接入；本机规则尚未改写。");
      previousState = engine.state;
      this.settings.mobile = candidate;
      onProgress?.("正在核验仓库…");
      const verified = await engine.verifyAccess(); current();
      candidate.branch = verified.branch;
      onProgress?.("正在准备本机规则…");
      await engine.prepareLocalRules(); current();
      onProgress?.("正在保存接入配置…");
      await engine.bind(verified); current();
      candidate.bound = true;
      this.settings.boundRepoUrl = candidate.repoUrl;
      this.settings.desktopGitEnabled = false;
      this.settings.desktopLightweightEnabled = !Platform.isMobile;
      this.settings.mobileSyncEnabled = Platform.isMobile;
      this.settings.enabled = true;
      this.settings.lightweightGuideProgress = { step: 4, complete: true, repoUrl: candidate.repoUrl, branch: candidate.branch, login: verified.login };
      await this.saveSettings(); current();
      complete = true;
      this.setStatus("接入完成 · 请在侧边栏手动同步");
      onProgress?.("接入完成");
      try { await this.recordSuccess("轻量接入", "账号、仓库权限、本机规则与绑定配置已准备；尚未执行同步。"); }
      catch { /* Optional log failures do not invalidate a completed connection. */ }
    } catch (error) {
      if (!complete && this.settings.mobile === candidate) {
        Object.assign(this.settings, previous);
        if (engine && previousState) {
          engine.state = previousState;
          try { await engine.save(); } catch { /* Preserve the original failure; the next attempt rechecks persisted state. */ }
        }
        try { await this.saveSettings(); } catch { /* Do not report success after a failed local save. */ }
      }
      throw error;
    } finally {
      this.switchingSyncMode = false;
      this.clearSyncActivity();
      if (this.settings.enabled) this.activateFeature();
      if (complete) this.setStatus("接入完成 · 请在侧边栏手动同步");
      await this.refreshSyncView(true);
    }
  }

  restartMobileAutomation(): void {
    const generation = ++this.mobileAutomationGeneration;
    if (!this.useLightweightSync() || !this.featureActive) return;
    for (const interval of this.featureIntervals) window.clearInterval(interval);
    this.featureIntervals = [];
    const options = this.settings.mobile;
    const mode = options.mode;
    const current = () => generation === this.mobileAutomationGeneration && this.featureActive && this.settings.enabled &&
      !this.switchingSyncMode && this.useLightweightSync() && this.settings.mobile === options && options.mode === mode;
    if (options.mode === "server") {
      this.addFeatureInterval(window.setInterval(() => { if (current()) void this.pollCommands(); }, Math.max(15, this.settings.commandPollSeconds) * 1000));
      if (this.settings.mobileAutoSyncMinutes > 0) this.addFeatureInterval(window.setInterval(
        () => { if (current()) void this.syncNow(false); }, Math.max(1, this.settings.mobileAutoSyncMinutes) * 60000));
      return;
    }
    if (options.autoSyncMinutes > 0) this.addFeatureInterval(window.setInterval(
      () => { if (current() && options.bound && this.getMobileGithub().state.baseCommitSha) void this.syncNow(false); }, Math.max(1, options.autoSyncMinutes) * 60000));
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
      calibrate: () => this.calibrateMobileHashes(), reimport: () => this.reimportLightweightVault() };
  }

  async reimportLightweightVault(): Promise<void> {
    if (!this.useLightweightSync() || !this.settings.mobile.bound) throw new Error("请先启用并绑定轻量同步仓库。");
    if (this.syncing || this.switchingSyncMode || this.desktopTaskActive || this.host.share?.busy) throw new Error("请等待当前同步或发布任务停止后重新导入。");
    if (legacySyncRunning(this.app)) throw new Error("请先关闭旧 Simple Link 同步，再重新导入。");
    this.switchingSyncMode = true;
    try {
      await this.getMobileGithub().restartSetup(true);
      this.settings.lightweightGuideProgress = undefined;
      await this.saveSettings();
      this.setStatus("已清除所有同步基准 · 等待重新配对确认");
    } finally { this.switchingSyncMode = false; }
    await this.syncNow(true);
  }

  async calibrateMobileHashes(): Promise<void> {
    if (!this.useLightweightSync()) { new Notice("请先启用轻量 GitHub API 同步。"); return; }
    if (this.syncing || this.switchingSyncMode) { new Notice("同步或模式切换期间不能重新校验。"); return; }
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
    this.registerViewRefreshEvents();
    if (this.useLightweightSync()) {
      this.registerMobileEvents();
      this.restartMobileAutomation();
      this.setStatus(Platform.isMobile ? "移动端 · 等待同步" : "电脑端 · 轻量 API 模式");
      if (this.settings.mobile.mode === "server") {
        const generation = this.mobileAutomationGeneration;
        window.setTimeout(() => {
          if (generation === this.mobileAutomationGeneration && this.featureActive && !this.switchingSyncMode && this.useLightweightSync()) {
            void this.registerMobile().catch((error) => this.recordError("手机连接", error));
          }
        }, 1000);
      }
    } else if (this.nativeGitEnabled()) {
      this.configureDesktopAutomation();
      this.scheduleDesktopStartup();
      this.setStatus(this.settings.setupComplete ? "桌面端 · Git 模式" : "等待首次 Git 配置");
    } else this.setStatus("电脑同步已关闭");
  }

  private deactivateFeature(): void {
    this.mobileAutomationGeneration++;
    this.featureActive = false;
    for (const ref of this.featureEvents) this.app.vault.offref(ref);
    this.featureEvents = [];
    for (const interval of this.featureIntervals) window.clearInterval(interval);
    this.featureIntervals = [];
    this.clearDesktopTimeouts();
    if (this.statusEl) this.statusEl.addClass("simple-one-sync-hidden");
    this.app.workspace.detachLeavesOfType(ZoeySyncView.type);
    this.app.workspace.detachLeavesOfType(ZoeySyncConflictView.type);
  }

  private addFeatureInterval(interval: number): void {
    this.featureIntervals.push(interval);
    this.registerInterval(interval);
  }

  private clearDesktopTimeouts(): void {
    this.desktopStartupGeneration++;
    if (this.desktopStartupTimer !== undefined) window.clearTimeout(this.desktopStartupTimer);
    this.desktopStartupTimer = undefined;
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

  private scheduleDesktopStartup(): void {
    const generation = this.desktopStartupGeneration;
    this.app.workspace.onLayoutReady(() => {
      if (generation !== this.desktopStartupGeneration || !this.featureActive || !this.nativeGitEnabled()) return;
      this.desktopStartupTimer = window.setTimeout(() => {
        this.desktopStartupTimer = undefined;
        if (generation !== this.desktopStartupGeneration || !this.featureActive || !this.nativeGitEnabled()) return;
        this.scheduleStartupPull();
        void this.resumeDesktopDirtyState(false).catch(error => this.recordError("启动状态恢复", error));
      }, 3000);
    });
  }

  private scheduleStartupPull(): void {
    if (!this.settings.setupComplete) return;
    if ((!this.settings.pullOnStartup && !this.settings.backupOnStartup) || this.startupPullScheduled) return;
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
        this.settings.backupOnStartup ? "启动时同步（Fetch + Merge + Commit + Push）" : "启动时 Fetch + Merge"
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
    await this.resumeDesktopDirtyState(false);
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
    if (this.settings.backupOnStartup) this.settings.pullOnStartup = false;
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
      plugins: [...(saved?.mobile?.plugins?.includes("*") ? saved.mobile.plugins : DEFAULT_MOBILE_OPTIONS.plugins)], ignorePatterns: [...(saved?.mobile?.ignorePatterns ?? [])] };
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
      console.error("同步 shared settings", error);
      new Notice("同步：同步配置文件存在冲突或格式错误，已停止覆盖该文件", 10000);
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

  private syncLog?: { context: string; timings: NonNullable<ErrorLogEntry["timings"]>; recorded: boolean };

  async recordOperationLog(context: string, status: "success" | "error", message: string): Promise<void> {
    if (context.startsWith("轻量") && context.endsWith("耗时")) {
      if (!this.settings.recordSyncPerformance) return;
      if (this.syncLog) {
        this.syncLog.timings.push({ title: context.replace(/耗时$/, ""), message });
        return;
      }
      await this.recordLog("轻量检查", status, status === "error" ? "检查失败" : "检查完成",
        [{ title: context.replace(/耗时$/, ""), message }]);
      return;
    }
    await this.recordLog(context, status, message);
  }

  private async recordLog(context: string, status: "success" | "error" | "pending", message = "", timings?: ErrorLogEntry["timings"]): Promise<void> {
    try {
      this.pruneErrorLogs();
      this.settings.errorLogs.push({
        timestamp: Date.now(),
        context,
        message,
        status,
        ...(timings ? { timings } : this.syncLog?.context === context ? { timings: this.syncLog.timings } : {})
      });
      if (this.syncLog?.context === context) this.syncLog.recorded = true;
      this.settings.errorLogs = this.settings.errorLogs.slice(-MAX_ERROR_LOGS);
      await this.saveSettings();
    } catch (saveError) {
      console.error("同步 error log", saveError);
    }
  }

  getRecentErrorLogs(): ErrorLogEntry[] {
    this.pruneErrorLogs();
    return [...this.settings.errorLogs].reverse();
  }

  getActiveSyncError(): ErrorLogEntry | undefined {
    const recent = this.getRecentErrorLogs();
    const connected = recent.findIndex(entry => entry.context === "轻量接入" && entry.status === "success");
    const logs = recent.filter((entry, index) => !(connected >= 0 && index > connected &&
      entry.status === "error" && /请先完成(?:手机端|轻量同步).*引导/.test(entry.message)));
    const latestFetch = logs.find((entry) => entry.status !== "pending" && /Fetch|Pull|Push|同步/.test(entry.context));
    const latestPush = logs.find((entry) => entry.status !== "pending" && /Push|同步/.test(entry.context));
    // A successful Fetch also resolves an earlier generic sync/setup error.
    // An explicit Push failure still needs a successful Push or full sync.
    return [latestFetch, latestPush && /Push/.test(latestPush.context) ? latestPush : undefined]
      .filter((entry): entry is ErrorLogEntry => !!entry && entry.status === "error")
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  openShareLogs(): void { new ErrorLogModal(this.app, this, "分享").open(); }

  async clearErrorLogs(contextPrefix = ""): Promise<void> {
    this.settings.errorLogs = contextPrefix ? this.settings.errorLogs.filter(entry => !entry.context.startsWith(contextPrefix)) : [];
    await this.saveSettings();
    await this.refreshSyncView();
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(`同步: ${text}`);
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
    this.setStatus(statusText ?? "同步失败 · 5 分钟后重试");
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

  private enqueueSetupGit<T>(task: () => Promise<T>): Promise<T> {
    if (this.switchingSyncMode) return Promise.reject(new SyncDeferredError("同步模式切换中，请稍后重试"));
    this.setupGitPaused = true;
    this.clearDesktopTimeouts();
    const run = this.desktopGitQueue.then(async () => {
      if (this.switchingSyncMode) throw new SyncDeferredError("同步模式切换中，请稍后重试");
      if (this.host.share?.busy || legacySyncRunning(this.app)) throw new Error("请先等待分享完成或关闭旧 Simple Link 同步");
      this.desktopTaskActive = true;
      try { return await task(); } finally { this.desktopTaskActive = false; }
    });
    this.desktopGitQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private enqueueDesktopGit(task: () => Promise<void | boolean>, errorContext?: string): Promise<void> {
    if (this.switchingSyncMode) return Promise.reject(new SyncDeferredError("同步模式切换中，请稍后重试"));
    if (this.setupGitPaused) return Promise.reject(new SyncDeferredError("接入引导中，后台 Git 同步已暂停"));
    if (!this.nativeGitEnabled()) return Promise.reject(new SyncDeferredError("电脑端原生 Git 同步已关闭"));
    if (!this.settings.setupComplete) return Promise.reject(new Error("请先完成首次使用引导"));
    const trackedTask = async (): Promise<void> => {
      if (this.switchingSyncMode) throw new SyncDeferredError("同步模式切换中，请稍后重试");
      if (this.setupGitPaused) throw new SyncDeferredError("接入引导中，后台 Git 同步已暂停");
      if (this.host.share?.busy) throw new SyncDeferredError("笔记分享正在发布，主库自动同步暂缓。");
      if (legacySyncRunning(this.app)) throw new SyncDeferredError("旧 Simple Link 仍在运行，已暂停新入口的 Git 操作");
      if (!this.nativeGitEnabled()) throw new SyncDeferredError("电脑端原生 Git 同步已关闭");
      if (!this.settings.setupComplete) throw new SyncDeferredError("请先完成首次使用引导");
      this.desktopTaskActive = true;
      try {
      const isFetchTask = !!errorContext && (errorContext.includes("Fetch") || errorContext.includes("Pull"));
      const isPushTask = !!errorContext && (errorContext.includes("Push") || errorContext.includes("同步"));
      this.desktopGitTrace = this.settings.recordSyncPerformance && (isFetchTask || isPushTask)
        ? [
            `远端：${this.settings.gitRemoteUrl} · ${this.settings.gitBranch}`,
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
        await this.recordLog(`完整同步 · ${errorContext}`, "success", resultMessage,
          this.settings.recordSyncPerformance && this.desktopGitTrace.length
            ? [{ title: "完整同步执行", message: this.desktopGitTrace.join("\n") }] : undefined);
      }
      this.clearSyncActivity();
      } finally {
        if (this.settings.recordSyncPerformance && this.syncLog && !this.useLightweightSync() && this.desktopGitTrace.length) {
          this.syncLog.timings.push({ title: "完整同步执行", message: this.desktopGitTrace.join("\n") });
        }
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
      console.error("同步 desktop task", error);
      if (errorContext) {
        await this.recordLog(`完整同步 · ${errorContext}`, "error", describeGitError(error),
          this.settings.recordSyncPerformance && this.desktopGitTrace.length
            ? [{ title: "完整同步执行", message: this.desktopGitTrace.join("\n") }] : undefined);
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
    if (!this.settings.recordSyncPerformance) return action();
    const startedAt = Date.now();
    try {
      const result = await action();
      this.desktopGitTrace.push(`${label}：${((Date.now() - startedAt) / 1000).toFixed(2)} 秒`);
      return result;
    } catch (error) {
      this.desktopGitTrace.push(`${label}：失败 · ${((Date.now() - startedAt) / 1000).toFixed(2)} 秒`);
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
    const path = nodeRequire("path") as NodePath;
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
    const allowedRefs = new Set([`refs/heads/${branch}`, await remoteSnapshotRef(this.settings.gitRemoteUrl, branch)]);
    // Existing user tracking refs remain untouched; only tolerate history already in HEAD.
    for (const ref of [`refs/remotes/origin/${branch}`, "refs/remotes/origin/HEAD"]) {
      try { await this.git(["merge-base", "--is-ancestor", ref, "HEAD"]); allowedRefs.add(ref); }
      catch { /* Unrelated references still block history cleanup. */ }
    }
    const refs = (await this.gitRaw(["for-each-ref", "--format=%(refname)"])).split(/\r?\n/).filter(Boolean);
    const extraRefs = refs.filter((ref) => !allowedRefs.has(ref));
    if (extraRefs.length) throw new Error(`仓库还存在其他分支、标签或暂存引用（如 ${extraRefs[0]}），请先处理后再清理`);
    const head = await this.git(["rev-parse", "HEAD"]);
    const remoteLine = await this.git(["ls-remote", "--exit-code", "--", this.settings.gitRemoteUrl, `refs/heads/${branch}`], true);
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
      await this.git(["fetch", `--shallow-since=${before.cutoff}`, "--no-tags", "--refmap=", "--", this.settings.gitRemoteUrl, `+refs/heads/${before.branch}:${await remoteSnapshotRef(this.settings.gitRemoteUrl, before.branch)}`], true);
      const remoteLine = await this.git(["ls-remote", "--exit-code", "--", this.settings.gitRemoteUrl, `refs/heads/${before.branch}`], true);
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
    const remoteRef = await remoteSnapshotRef(this.settings.gitRemoteUrl, this.settings.gitBranch);
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

  private async resumeDesktopDirtyState(uploadPending = true): Promise<void> {
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
      if (unpushed && uploadPending) {
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
    const operation = (await this.getInterruptedGitOperation())?.label;
    const lock = await this.indexLock();
    return [operation, lock ? "Git 索引锁" : null].filter(Boolean).join("、") || null;
  }

  private async indexLock() {
    const nodeRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    if (!nodeRequire) throw new Error("当前平台不支持桌面锁文件检查");
    const fs = (nodeRequire("fs") as NodeFs).promises;
    const path = (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index.lock"])).trim();
    try { return { fs, path, stat: await fs.lstat(path) }; }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  private async interruptGitProcesses(): Promise<void> {
    // Only handles launched by this instance for this vault; never scan system Git processes.
    for (const [child, finished] of [...this.desktopGitProcesses]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      if (desktopProcess?.platform === "win32" && child.pid) {
        try { await this.exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]); }
        catch (error) { if (this.desktopGitProcesses.has(child)) throw error; }
      } else if (!child.kill("SIGTERM") && this.desktopGitProcesses.has(child)) {
        throw new Error("无法中断当前库的 Git 操作，已停止清理");
      }
      let timer: number | undefined;
      try {
        await Promise.race([finished, new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("当前库的 Git 操作尚未退出，已停止清理")), 10000);
        })]);
      } finally { if (timer !== undefined) window.clearTimeout(timer); }
    }
  }

  private async cleanIndexLock(): Promise<boolean> {
    const lock = await this.indexLock();
    if (!lock) return false;
    const { fs, path, stat } = lock;
    if (!stat.isFile()) throw new Error("索引锁路径不是普通文件，无法清理");
    try { await fs.unlink(path); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    return true;
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
    // Interrupt before waiting for the queue, which may contain the blocked Git operation.
    this.clearDesktopTimeouts();
    await this.interruptGitProcesses();
    let result: GitRepairResult | undefined;
    await this.enqueueDesktopGit(async () => {
      await this.ensureDesktopGit();
      const cleanedLock = await this.cleanIndexLock();
      const activeError = this.getActiveSyncError();
      if (cleanedLock && activeError && describeGitIndexLockError(activeError.message)) {
        await this.recordSuccess("同步修复", "索引锁已清理，请重新同步");
      }
      const operation = await this.getInterruptedGitOperation();
      if (!operation) {
        if (!cleanedLock) throw new Error("没有检测到残留索引锁或可自动修复的未完成 Git 操作");
        result = { operation: "Git 索引锁", restoredLocalChanges: false, lockOnly: true };
        await this.refreshSyncView();
        return;
      }

      const hadChanges = await this.hasDesktopChanges();
      let recoveryStash = "";
      if (hadChanges) {
        const message = `同步 repair backup ${new Date().toISOString()}`;
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

  async openSyncView(refreshExisting = true, reveal = true): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(ZoeySyncView.type)[0] ?? null;
    const existing = !!leaf;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: ZoeySyncView.type, active: reveal });
    }
    if (reveal) await this.app.workspace.revealLeaf(leaf);
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

  async refreshSyncView(reuseChanges = false): Promise<void> {
    const views = this.app.workspace
      .getLeavesOfType(ZoeySyncView.type)
      .map((leaf) => leaf.view)
      .filter((view): view is ZoeySyncView => view instanceof ZoeySyncView);
    await Promise.all(views.map((view) => view.render(reuseChanges)));
  }

  private async lightweightView(): Promise<ZoeySyncView> {
    await this.openSyncView(false);
    const view = this.app.workspace.getLeavesOfType(ZoeySyncView.type)[0]?.view;
    if (!(view instanceof ZoeySyncView)) throw new Error("无法打开轻量同步确认侧栏");
    (this.app as App & { setting?: { close(): void } }).setting?.close();
    return view;
  }

  private lightweightFlow(): MobileSyncFlow {
    return {
      strategy: async plan => (await this.lightweightView()).chooseStrategy(plan),
      confirm: async plan => (await this.lightweightView()).confirmLightweightPlan(plan),
      transfer: () => this.openDownloadTask(),
      ready: plan => this.showLightweightPlan(plan)
    };
  }

  getLightweightPlan(): MobilePlan | undefined {
    return this.syncing && this.useLightweightSync() && this.settings.mobile.mode === "github" ? this.lightweightPlan : undefined;
  }

  private async showLightweightPlan(plan: MobilePlan): Promise<void> {
    this.lightweightPlan = plan;
    await this.refreshSyncView(true);
  }

  async openDownloadTask(): Promise<void> {
    const view = await this.lightweightView();
    await view.showDownloadTask();
  }

  async runDownloadTask(action: () => Promise<void>): Promise<void> {
    if (this.syncing || this.switchingSyncMode || this.host.share?.busy) throw new Error("请等待当前同步或发布结束再处理下载待办。");
    const engine = this.getMobileGithub();
    this.syncing = true;
    this.syncLog = { context: "轻量同步 · 手动继续下载", timings: [], recorded: false };
    const expectedCommit = engine.state.pending?.commit;
    try {
      await action();
      const rechecked = engine.needsLocalRecheck;
      if (rechecked && !await this.runLightweightCycle(engine, true, 1)) return;
      if (!engine.downloadTask && !engine.needsLocalRecheck && (engine.state.baseCommitSha === expectedCommit || rechecked && engine.state.baseCommitSha)) {
        this.settings.lastSyncAt = Date.now();
        this.settings.lightweightGuideProgress = { step: 4, complete: true, repoUrl: this.settings.mobile.repoUrl,
          branch: this.settings.mobile.branch, login: this.settings.lightweightGuideProgress?.login || "" };
        await this.saveSettings();
        this.setStatus("GitHub API · 两端已对齐");
        await this.recordSuccess("轻量同步 · 手动继续下载", "文件已应用并验证，共同基准已确认。");
      }
    } catch (error) {
      await this.recordError("轻量同步 · 手动继续下载", error);
      throw error;
    } finally {
      if (this.syncLog && !this.syncLog.recorded) await this.recordLog(this.syncLog.context, "pending", "下载待办已重新检查，请重新预览同步。");
      this.syncLog = undefined;
      this.syncing = false;
      this.clearSyncActivity();
      await this.refreshSyncView();
    }
  }

  async toggleViewLayout(): Promise<void> {
    this.settings.viewLayout = this.settings.viewLayout === "list" ? "tree" : "list";
    await this.saveSettings();
    await this.refreshSyncView(true);
  }

  openPluginSettings(share = false): void {
    const appWithSettings = this.app as App & {
      setting: {
        open(): void;
        openTabById(id: string): void;
      };
    };
    appWithSettings.setting.open();
    appWithSettings.setting.openTabById(this.manifest.id);
    this.openSettings?.(share);
  }

  needsLightweightBaseline(): boolean {
    return this.useLightweightSync() && this.settings.mobile.mode === "github" &&
      this.settings.mobile.bound && !this.getMobileGithub().state.baseCommitSha && !this.getMobileGithub().needsLocalRecheck;
  }

  getLightweightPendingStatus(): ViewStatusState | undefined {
    if (!this.useLightweightSync() || this.settings.mobile.mode !== "github") return undefined;
    if (!this.settings.mobile.bound) return { tone: "pending", text: "轻量同步尚未接入" };
    if (this.mobileGithub?.needsLocalRecheck) return { tone: "pending", text: "同步期间的新修改已保留 · 安全文件已处理 · 待继续核对" };
    if (this.mobileGithub?.downloadTask) return { tone: "pending", text: "下载待办未完成 · 点击上方红色提醒继续" };
    const verification = this.mobileGithub?.state.downloadVerification;
    if (verification) return { tone: "pending", text: `下载${verification.phase === "verifying" ? "验证" : "同步"}未完成 · 保留原基准 · 点击同步继续恢复` };
    if (this.needsLightweightBaseline()) return { tone: "pending", text: "尚未建立同步基准 · 需核对云端" };
    return undefined;
  }

  async getChanges(): Promise<ChangeItem[]> {
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
    const remoteRef = await remoteSnapshotRef(this.settings.gitRemoteUrl, this.settings.gitBranch);
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
    return this.syncing || this.desktopTaskActive || this.switchingSyncMode;
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
    if (this.switchingSyncMode) return;
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
    if (this.switchingSyncMode) { if (showNotice) new Notice("请等待同步模式切换完成。"); return; }
    try {
      if (this.useLightweightSync()) {
        if (this.settings.mobile.mode === "github") await this.getMobileGithub().verify();
        else { this.validateServerSettings(); await this.registerMobile(); }
      } else {
        if (!this.settings.setupComplete) throw new Error("请先完成首次使用引导");
        await this.testDesktopGit();
      }
      if (showNotice) new Notice(`同步：${this.useLightweightSync() ? this.settings.mobile.mode === "github" ? "GitHub API" : "服务器" : "Git"}连接正常`);
    } catch (error) {
      await this.recordError("测试连接", error);
      if (showNotice) new Notice(`同步：${messageOf(error)}`, 8000);
      throw error;
    }
  }

  private async runLightweightCycle(engine: MobileGithub, interactive: boolean, attempts = 2): Promise<boolean> {
    const scope = await engine.recheckScope?.();
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const plan = await engine.preview();
        if (interactive) {
          if (!await new MobileSyncModal(this.app, engine, plan, live => this.reviewLightweightDifferences(live), this.lightweightFlow()).wait()) return false;
        } else {
          if ((!engine.state.baseCommitSha && !engine.needsLocalRecheck) || plan.conflicts.length) throw new SyncDeferredError("有首次配对或冲突待确认，请手动同步。");
          await this.showLightweightPlan(plan); await engine.execute(plan);
        }
        if (!engine.needsLocalRecheck) return true;
      } catch (error) { if (!(error instanceof LocalSyncEdit)) throw error; }
      await engine.recheckScope?.(scope);
      this.setSyncActivity("检测到同步期间的新修改，正在重新核对…", "checking");
    }
    this.setStatus("安全文件已处理，持续修改留待下次同步");
    return false;
  }

  async syncNow(showNotice: boolean): Promise<void> {
    if (this.switchingSyncMode) { if (showNotice) new Notice("请等待同步模式切换完成。"); return; }
    if (this.host.share?.busy) { if (showNotice) new Notice("笔记分享正在发布，请稍后同步主库。"); return; }
    if (legacySyncRunning(this.app)) { if (showNotice) new Notice("请先关闭旧 Simple Link 的同步。"); return; }
    if (!this.useLightweightSync() && !this.nativeGitEnabled()) { if (showNotice) new Notice("当前设备同步已关闭"); return; }
    if (!this.useLightweightSync() && !this.settings.setupComplete) {
      if (showNotice) new Notice("请先完成「从零开始的 Git 同步使用指南」");
      return;
    }
    if (!this.settings.enabled) {
      if (showNotice) new Notice("同步已关闭，请先在设置中启用");
      return;
    }
    if (this.syncing) {
      if (showNotice) new Notice("同步：已有同步任务正在运行");
      return;
    }
    this.syncing = true;
    this.setStatus(this.useLightweightSync() ? "正在同步…" : "准备检查本机修改…");
    const logContext = `${this.useLightweightSync() ? "轻量同步" : "完整同步"} · ${showNotice ? "手动" : "自动"}`;
    this.syncLog = { context: logContext, timings: [], recorded: false };
    try {
      if (this.useLightweightSync()) {
        if (this.settings.mobile.mode === "github") {
          const engine = this.getMobileGithub();
          await engine.load();
          if (engine.downloadTask) {
            this.setStatus("下载待办尚未完成，请从上方红色提醒继续");
            if (showNotice) await this.openDownloadTask();
            return;
          }
          if (!await this.runLightweightCycle(engine, showNotice)) return;
        } else await this.mobileSync();
        this.settings.lastSyncAt = Date.now();
        await this.saveSettings();
        this.setStatus(this.settings.mobile.mode === "github" ? "GitHub API · 两端已对齐" : `已同步 · v${this.settings.baseVersion}`);
      } else {
        await this.enqueueDesktopGit(() => this.desktopGitSync());
        this.setStatus("同步检查完成");
      }
      await this.recordSuccess(logContext, "同步检查完成");
      if (showNotice) new Notice("同步：同步完成");
    } catch (error) {
      if (error instanceof SyncDeferredError) {
        this.setStatus(error.message);
        if (showNotice) new Notice(error.message);
        return;
      }
      if (!this.useLightweightSync()) await this.scheduleDesktopPushRetry();
      await this.recordError(logContext, error);
      this.setStatus(this.useLightweightSync() ? "同步失败" : "同步失败 · 5 分钟后重试");
      if (showNotice) new Notice(`同步：${messageOf(error)}`, 10000);
      else console.error("同步", error);
    } finally {
      if (this.syncLog && !this.syncLog.recorded) await this.recordLog(logContext, "pending", "同步检查结束，尚未确认完成");
      this.syncLog = undefined;
      this.lightweightPlan = undefined;
      this.syncing = false;
      this.clearSyncActivity();
      await this.refreshSyncView();
    }
  }

  async commitNow(showNotice: boolean): Promise<void> {
    if (this.switchingSyncMode) { if (showNotice) new Notice("请等待同步模式切换完成。"); return; }
    if (legacySyncRunning(this.app)) { if (showNotice) new Notice("请先关闭旧 Simple Link 的同步。"); return; }
    if (this.nativeGitEnabled() && !this.settings.setupComplete) {
      if (showNotice) new Notice("请先完成「从零开始的 Git 同步引导」");
      return;
    }
    if (!this.settings.enabled) {
      if (showNotice) new Notice("同步已关闭，请先在设置中启用");
      return;
    }
    if (!this.nativeGitEnabled()) {
      if (showNotice) new Notice("当前模式不使用原生 Git commit；请使用预览并同步");
      return;
    }
    if (this.syncing) {
      if (showNotice) new Notice("同步：已有任务正在运行");
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
        new Notice(result.committed ? "同步：Commit 完成" : "同步：没有可 Commit 文件");
      }
    } catch (error) {
      await this.recordError("手动 Commit", error);
      this.setStatus("Commit 失败");
      if (showNotice) new Notice(`同步：${messageOf(error)}`, 10000);
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
    const generation = this.mobileAutomationGeneration;
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
    if (response.gitWarning) new Notice(`同步：GitHub 暂时不可用，本地服务器同步已完成`, 7000);
    if (triggerSync) window.setTimeout(() => {
      if (generation === this.mobileAutomationGeneration && this.featureActive && this.useLightweightSync() && this.settings.mobile.mode === "server") void this.syncNow(false);
    }, 250);
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
    if (this.switchingSyncMode || !this.featureActive || !this.useLightweightSync() || this.settings.mobile.mode !== "server") return;
    if (!Platform.isMobile || !this.settings.serverUrl || !this.settings.serverPassword) return;
    const generation = this.mobileAutomationGeneration;
    try {
      const result = await this.serverRequest<{ commands: ServerCommand[] }>(
        "GET",
        `/v1/commands?deviceId=${encodeURIComponent(this.settings.deviceId)}`
      );
      if (generation !== this.mobileAutomationGeneration || this.switchingSyncMode || !this.featureActive) return;
      const triggerSync = await this.handleCommands(result.commands);
      if (triggerSync && generation === this.mobileAutomationGeneration && !this.switchingSyncMode && this.featureActive) void this.syncNow(false);
    } catch (error) {
      console.error("同步 command poll", error);
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
        new Notice(`同步 指令失败：${messageOf(error)}`, 8000);
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
  }
  getSetupTrackingChoice(): "keep" | "rebuild" | undefined { return this.setupTrackingChoice; }
  setSetupTrackingChoice(choice: "keep" | "rebuild" | undefined): void { this.setupTrackingChoice = choice; }
  getVaultBasePath(): string { return this.vaultBasePath(); }
  async trustSetupVault(): Promise<void> {
    await this.exec("git", ["config", "--global", "--add", "safe.directory", this.vaultBasePath().replace(/\\/g, "/")]);
  }
  async readSetupOverlap(path: string): Promise<SetupOverlapContent> {
    if (!this.settings.setupVerified || !this.setupPreview) throw new Error("请先检查本地与远端文件");
    return this.setup().readOverlap(this.setupPreview, path);
  }

  async readSetupImage(path: string, side: "local" | "remote") {
    if (!this.settings.setupVerified || !this.setupPreview) throw new Error("请先检查本地与远端文件");
    return this.setup().readOverlapImage(this.setupPreview, path, side);
  }

  private setup(): GitSetup {
    return new GitSetup(this.vaultBasePath(), (program, args, timeoutMs, onOutput, stdinText, signal) =>
      this.exec(program, args, program === "git", true, timeoutMs, onOutput, stdinText, signal), this.app.vault.configDir);
  }

  async inspectFileTracking(): Promise<FileTrackingPreview> {
    if (Platform.isMobile || !this.settings.setupComplete) throw new Error("请先完成电脑端 Git 接入");
    const nodeRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    if (!nodeRequire) throw new Error("文件追踪检查仅支持电脑端");
    const fs = (nodeRequire("fs") as NodeFs).promises;
    const vaultPath = this.vaultBasePath();
    const root = (await this.gitRaw(["rev-parse", "--show-toplevel"])).trim();
    if ((await fs.realpath(root)).toLowerCase() !== (await fs.realpath(vaultPath)).toLowerCase()) {
      throw new Error("当前 Vault 不是独立的 Git 仓库，无法修复文件追踪");
    }
    await this.ensureNormalGitState();
    const nestedRepos = await findNestedRepos(vaultPath, this.app.vault.configDir);
    const nested = await nestedRepoFiles(vaultPath, nestedRepos, args => this.gitRaw(args), this.app.vault.configDir);
    const legacy = [...this.settings.ignorePatterns, ...legacyScopeRules(this.settings.mobile)]
      .map(line => line.split("{config}").join(this.app.vault.configDir));
    return inspectIgnoreTracking(this.app.vault.adapter, this.app.vault.configDir, args => this.gitRaw(args), legacy, nested);
  }

  async repairFileTracking(preview: FileTrackingPreview): Promise<number> {
    await this.enqueueDesktopGit(async () => {
      const current = await this.inspectFileTracking();
      if (JSON.stringify(current) !== JSON.stringify(preview)) throw new Error("文件追踪状态已变化，请重新检查后再修复");
      await applyIgnoreTracking(this.app.vault.adapter, this.app.vault.configDir, args => this.gitRaw(args), preview);
      return preview.paths.length > 0 || preview.addPaths.length > 0 || preview.missingRules.length > 0;
    }, "重建忽略规则与修复文件追踪");
    return preview.paths.length;
  }

  async beginSetup(): Promise<void> {
    if (this.syncing || this.switchingSyncMode) throw new Error("当前有同步或模式切换任务正在运行，请稍后重试");
    this.setupGitPaused = true;
    this.clearDesktopTimeouts();
    await this.desktopGitQueue;
    this.setupActivity = undefined;
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
    this.setupGitPaused = false;
    this.setupActivity = undefined;
    await this.restartDesktopAutomation();
    if (!this.startupPullScheduled) this.scheduleDesktopStartup();
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
    this.setupPreview = undefined;
    this.setupActivity = undefined;
    await this.enqueueSetupGit(async () => {
      onProgress?.("正在确认仓库与访问权限…");
      const setup = this.setup();
      const verified = await setup.verifyRepository(repoUrl);
      this.settings.setupVerified = verified;
      onProgress?.("只读核对本机文件与忽略规则…");
      const commitSummary = "检查阶段不提交、不解除追踪";
      this.setupPreview = await setup.preview(verified, onProgress);
      this.setupPreview.commitSummary = commitSummary;
    });
    if (!this.settings.setupComplete) {
      this.setupChoices = {};
      this.setupTrackingChoice = undefined;
      this.settings.setupStep = 3;
      await this.saveSettings();
    }
  }

  async confirmSetupPreview(): Promise<void> {
    if (!this.setupPreview) throw new Error("请先检查本地与远端文件");
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
    this.settings.gitAuthorName = this.settings.gitAuthorName.trim() || DEFAULT_GIT_AUTHOR_NAME;
    this.settings.gitAuthorEmail = this.settings.gitAuthorEmail.trim() || DEFAULT_GIT_AUTHOR_EMAIL;
    const skippedPaths = await this.enqueueSetupGit(() => this.setup().finish(verified, preview, this.setupChoices, {
      name: this.settings.gitAuthorName,
      email: this.settings.gitAuthorEmail
    }, async () => {
      this.settings.setupMutationStarted = true;
      await this.saveSettings();
    }, new Set<string>(), this.setupTrackingChoice === "rebuild", current => {
      stage = current;
      publishProgress();
    }));
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
    this.setupGitPaused = false;
    await this.setDesktopSyncMode("git");
    if (!this.nativeGitEnabled()) throw new Error("当前同步仍在运行，请稍后启用电脑端 Git 同步。");
    this.setStatus(skippedPaths.length > 0
      ? `首次接入完成 · ${skippedPaths.length} 个预览后变化的文件留待后续同步`
      : "首次接入完成");
    if (skippedPaths.length > 0) new Notice(`接入已完成；${skippedPaths.length} 个预览后变化的文件未提交，请在同步面板继续同步。`, 10000);
    window.clearInterval(progressTimer);
    this.setSetupActivity("接入已完成 · 首次同步将在同步面板执行", "success");
    onProgress?.("接入已完成 · 首次同步将在同步面板执行");
    this.setupActivity = undefined;
    void this.refreshSyncView().catch(error => this.recordError("刷新同步面板", error));
    window.setTimeout(() => void this.syncNow(false).catch(error => this.recordError("首次同步", error)), 0);
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
    const childProcess = nodeRequire("child_process") as NodeCommands;
    const env: Record<string, string | undefined> = { ...desktopProcess?.env };
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
      let markFinished: () => void;
      const finished = new Promise<void>(done => { markFinished = done; });
      const child = childProcess.execFile(
        program,
        args,
        { cwd: this.vaultBasePath(), env, windowsHide: true, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, signal },
        (error, stdout, stderr) => {
          this.desktopGitProcesses.delete(child);
          markFinished();
          if (error) {
            const diagnostic = (stderr || stdout || error.message).trim();
            const secret = stdinText?.trim();
            reject(new Error(secret ? diagnostic.split(secret).join("[hidden]") : diagnostic));
          }
          else resolve(trim ? stdout.trim() : stdout);
        }
      );
      // Commands redirecting Git to another repository are not current-vault tasks.
      if (program === "git" && !args.some(arg => /^-C|^--(?:git-dir|work-tree)(?:=|$)/.test(arg))) {
        this.desktopGitProcesses.set(child, finished);
      }
      if (onOutput) {
        child.stdout?.on("data", (chunk: unknown) => onOutput(String(chunk)));
        child.stderr?.on("data", (chunk: unknown) => onOutput(String(chunk)));
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

  }

  private async requireLocalIgnoreReady(): Promise<void> {
    const text = await readRootIgnore(this.app.vault.adapter);
    if (!text.includes("# >>> simple-one:fixed") || organizedLocalIgnore(text, this.app.vault.configDir) !== text) {
      throw new SyncDeferredError("请先在故障排查中「重建忽略规则与修复文件追踪」，确认本机规则迁移；未执行同步。");
    }
    const ignored = rootIgnoreMatcher(text, this.app.vault.configDir);
    const tracked = (await this.gitRaw(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean).filter(ignored);
    if (tracked.length) throw new SyncDeferredError(`还有 ${tracked.length} 个排除文件受到 Git 追踪。请先预览并修复文件追踪；未拉取、覆盖或删除本机文件。`);
  }

  private async testDesktopGit(): Promise<void> {
    await this.exec("git", ["--version"]);
    await this.ensureDesktopGit();
    await this.git(["ls-remote", "--heads", "--", this.settings.gitRemoteUrl, this.settings.gitBranch], true);
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
    if (!this.settings.pullOnStartup && !this.settings.backupOnStartup) return false;
    let changed = await this.desktopFetchAndMerge();
    if (this.settings.backupOnStartup) {
      const result = await this.desktopCommitOnly();
      const pushed = await this.desktopPushOnly(false);
      if (await this.hasDesktopChanges()) this.scheduleDesktopCommit();
      changed = result.committed || changed || pushed;
    }
    // A successful startup check counts even when no files needed transferring.
    this.settings.lastSyncAt = Date.now();
    await this.saveSettings();
    return changed;
  }

  private async desktopCommitOnly(): Promise<DesktopCommitResult> {
    this.setSyncActivity("正在检查本机修改…", "checking");
    await this.requireLocalIgnoreReady();
    await this.ensureDesktopGit();
    await this.ensureNormalGitState();
    assertNoPrivateSyncFiles((await this.gitRaw(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean), this.app.vault.configDir);
    await this.prepareNestedRepositories();
    const changes = parseGitStatus(await this.gitRaw(["status", "--porcelain=v1", "-z"]));
    if (this.settings.recordSyncPerformance) this.desktopGitTrace.push(`本机改动：${changes.length} 个文件`);
    if (changes.length === 0) {
      this.setStatus("本机没有待同步修改");
      await this.refreshSyncView();
      return { committed: false };
    }
    this.setSyncActivity(`正在保存本机修改 · ${changes.length} 个文件`, "commit");
    await this.git(["add", "-A"]);
    let committed = false;
    try {
      await this.git(["diff", "--cached", "--quiet"]);
    } catch {
      await this.git(["commit", "-m", `Zoey Commit: ${new Date().toISOString()}`]);
      committed = true;
    }
    if (committed) this.resetDesktopCommitTracking();
    this.setStatus(committed ? `已保存本机修改 · ${changes.length} 个文件` : "本机没有待同步修改");
    await this.refreshSyncView();
    return { committed };
  }

  private async prepareNestedRepositories(): Promise<void> {
    const vaultPath = this.vaultBasePath();
    const repos = await findNestedRepos(vaultPath, this.app.vault.configDir);
    if (!repos.length) return;
    await rebuildNestedRepoTracking(vaultPath, repos, (args) => this.gitRaw(args), this.app.vault.configDir);
  }

  private async desktopFetchAndMerge(pushAfterResolve = false, allowFilenameRepair = true): Promise<boolean> {
    this.setSyncActivity("正在检查云端更新…", "checking");
    await this.requireLocalIgnoreReady();
    await this.ensureDesktopGit();
    await this.ensureNormalGitState();
    const remoteRef = await remoteSnapshotRef(this.settings.gitRemoteUrl, this.settings.gitBranch);
    this.setSyncActivity("正在下载", "fetch");
    try {
      await this.traceDesktopGitStep("Git fetch（连接并下载远端分支）", () =>
        this.exec("git", ["fetch", "--progress", "--no-tags", "--refmap=", "--", this.settings.gitRemoteUrl, `+refs/heads/${this.settings.gitBranch}:${remoteRef}`], true, true, 120000,
          transferProgress("下载", text => this.setSyncActivity(text, "fetch")))
      );
    } catch (error) {
      if (!isMissingRemoteRefError(error)) throw error;
      await this.git(["update-ref", "-d", await remoteSnapshotRef(this.settings.gitRemoteUrl, this.settings.gitBranch)]);
      this.desktopGitTrace[this.desktopGitTrace.length - 1] = "Git fetch：远端分支不存在";
      this.setStatus("云端尚无分支 · 等待首次同步");
      return false;
    }
    if (!(await this.hasDesktopHead())) {
      this.desktopGitTrace.push("合并检查：本机尚无 Commit");
      this.setStatus("已获取云端信息 · 等待首次同步");
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
    const localChanges = parseGitStatus(await this.gitRaw(["status", "--porcelain=v1", "--untracked-files=no", "-z"]));
    const remoteChanges = parseGitNameStatus(
      await this.gitRaw(["diff", "--name-status", "-z", "--find-renames", mergeBase, "FETCH_HEAD"])
    );
    const ignored = rootIgnoreMatcher(await readRootIgnore(this.app.vault.adapter), this.app.vault.configDir);
    const headFiles = new Set((await this.gitRaw(["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean));
    if (remoteChanges.some(change => (ignored(change.path) || (change.oldPath && ignored(change.oldPath))) &&
      !(change.kind === "deleted" && !headFiles.has(change.path)))) {
      throw new SyncDeferredError("远端更新涉及本机排除文件，已在合并前停止。请先在已接入设备修复远端追踪，或重新打开接入引导预览历史迁移；本机规则和状态文件未被覆盖。");
    }
    const overlappingPaths = findRemoteChangeOverlaps(localChanges, remoteChanges);
    if (overlappingPaths.length > 0) {
      this.deferredMergePaths = overlappingPaths;
      const message = `同步暂缓 · ${overlappingPaths.length} 个文件仍在修改`;
      if (pushAfterResolve) await this.scheduleDesktopPushRetry(message);
      throw new SyncDeferredError(message);
    }
    if (allowFilenameRepair && hasCaseInsensitivePathCollisions(
      (await this.gitRaw(["ls-tree", "-r", "--name-only", "-z", "FETCH_HEAD"])).split("\0").filter(Boolean)
    )) {
      this.setSyncActivity("正在修复云端大小写重名文件…", "checking");
      const repairedNames = await repairRemoteFilenames((args, authenticated = false, stdin) =>
        this.exec("git", args, authenticated, false, 120000, undefined, stdin), this.settings.gitBranch, this.settings.gitRemoteUrl);
      this.desktopGitTrace.push(`已提交并推送云端文件名修复 · ${repairedNames.length} 项`, ...repairedNames);
      new Notice(`同步：已在云端提交 ${repairedNames.length} 项文件名修复，重试下载并合并`, 10000);
      return await this.desktopFetchAndMerge(pushAfterResolve, false);
    }
    this.deferredMergePaths = [];
    const backup = await preserveUntrackedFiles(this.vaultBasePath(), args => this.gitRaw(args), mergeBase);
    if (backup) {
      this.desktopGitTrace.push(`已移开 ${backup.files.length} 个阻挡合并的本机未追踪文件，继续 Git merge。本机副本：${backup.directory}`);
      new Notice(`同步：已移开 ${backup.files.length} 个阻挡合并的本机未追踪文件，继续合并云端版本。本机副本：${backup.directory}`, 15000);
    }
    this.setSyncActivity("正在合并云端更新…", "merge");
    try {
      await preserveRootIgnore(this.app.vault.adapter, args => this.gitRaw(args), () =>
        this.traceDesktopGitStep("Git merge（合并远端提交）", () => this.git(["merge", "--no-edit", "FETCH_HEAD"])));
    } catch (error) {
      const conflicts = await this.getUnmergedPaths();
      if (conflicts.length === 0) {
        await backup?.restore();
        if (allowFilenameRepair && isInvalidGitPathError(error)) {
          await this.ensureNormalGitState();
          this.setSyncActivity("正在修复云端非法文件名…", "checking");
          const repairedNames = await repairRemoteFilenames((args, authenticated = false, stdin) =>
            this.exec("git", args, authenticated, false, 120000, undefined, stdin), this.settings.gitBranch, this.settings.gitRemoteUrl);
          if (repairedNames.length) {
            this.desktopGitTrace.push(`已提交并推送云端文件名修复 · ${repairedNames.length} 项`, ...repairedNames);
            new Notice(`同步：已在云端提交 ${repairedNames.length} 项文件名修复，重试下载并合并`, 10000);
            return await this.desktopFetchAndMerge(pushAfterResolve, false);
          }
        }
        throw error;
      }
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
    await this.requireLocalIgnoreReady();
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
    this.setSyncActivity("正在上传", "push");
    const pushedHead = await this.git(["rev-parse", "HEAD"]);
    await this.traceDesktopGitStep("Git push（上传本机提交）", () =>
      this.exec("git", ["push", "--progress", "--no-follow-tags", "--", this.settings.gitRemoteUrl, `${pushedHead}:refs/heads/${this.settings.gitBranch}`], true, true, 120000,
        transferProgress("上传", text => this.setSyncActivity(text, "push")))
    );
    await this.git(["update-ref", await remoteSnapshotRef(this.settings.gitRemoteUrl, this.settings.gitBranch), pushedHead]);
    this.clearDesktopPushRetry();
    this.settings.pendingMergePushAfterResolve = false;
    this.settings.lastSyncAt = Date.now();
    await this.saveSettings();
    this.setStatus("已同步 · 刚刚");
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
      new Notice(`同步：无法继续处理冲突。${messageOf(error)}`, 12000);
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
    body.createEl("h2", { text: "重建忽略规则与 Git 追踪", cls: "simple-one-sync-tracking-title" });
    body.createEl("p", { text: `.gitignore ${this.preview.originalIgnore === this.preview.nextIgnore ? "无需更改" : "将更新"} · 取消追踪 ${this.preview.paths.length} 个 · 新增追踪 ${this.preview.addPaths.length} 个`, cls: "simple-one-sync-tracking-summary" });
    body.createEl("p", { text: "仅暂存差异，不提交或推送。", cls: "simple-one-sync-tracking-description" });
    const layout = fileListPanel(body, this.plugin.settings, () => this.plugin.saveSettings());
    if (this.preview.paths.length) {
      const files = body.createEl("details", { cls: "simple-one-sync-tracking-details" });
      files.createEl("summary", { text: `按忽略规则取消追踪（${this.preview.paths.length}）` });
      renderPathTree(files, this.preview.paths, "−", layout);
    }
    if (this.preview.addPaths.length) {
      const files = body.createEl("details", { cls: "simple-one-sync-tracking-details" });
      files.createEl("summary", { text: `新增追踪（${this.preview.addPaths.length}）` });
      renderPathTree(files, this.preview.addPaths, "+", layout);
    }
    const consent = body.createEl("label", { cls: "simple-one-sync-tracking-consent" });
    const acknowledgement = consent.createEl("input", { attr: { type: "checkbox" } });
    consent.createSpan({ text: "我已确认：取消追踪的文件保留在本机，推送后从云端移除。" });
    consent.hidden = this.preview.paths.length === 0;
    const actions = body.createDiv({ cls: "modal-button-container simple-one-sync-tracking-actions" });
    const apply = styleActionButton(actions.createEl("button", { text: "应用修复", cls: "mod-cta" }), "text");
    styleActionButton(actions.createEl("button", { text: "关闭" }), "text").addEventListener("click", () => this.close());
    const empty = this.preview.paths.length === 0 && this.preview.addPaths.length === 0 && this.preview.missingRules.length === 0;
    apply.disabled = empty || (this.preview.paths.length > 0 && !acknowledgement.checked);
    acknowledgement.addEventListener("change", () => { apply.disabled = empty || (this.preview.paths.length > 0 && !acknowledgement.checked); });
    apply.addEventListener("click", () => {
      if (this.running || apply.disabled) return;
      this.running = true;
      apply.disabled = true;
      apply.setText("正在修复…");
      void this.plugin.repairFileTracking(this.preview).then((count) => {
        new Notice(`同步：已按忽略规则取消追踪 ${count} 个本机文件`);
        this.close();
      }).catch((error) => {
        new Notice(`同步：修复失败。${messageOf(error)}`, 10000);
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
    this.modalEl.addClass("simple-one-sync-repair-modal");
    const lockOnly = this.operation === "Git 索引锁";
    this.titleEl.setText(lockOnly ? "清理同步锁" : "修复同步");
    container.createEl("p", {
      text: lockOnly
        ? "中断 Git 操作并清理索引锁后，请重新同步。"
        : `检测到 ${this.operation}。将备份本机修改、退出异常操作，并检查云端更新。`
    });
    container.createEl("p", {
      text: "将中断本插件为当前笔记库启动的 Git 操作，再清理锁。其他仓库及外部工具启动的 Git 操作不会被中断。",
      cls: "simple-one-sync-repair-warning"
    });

    const actions = container.createDiv({ cls: "modal-button-container" });
    const cancel = styleActionButton(actions.createEl("button", { text: "取消" }), "text");
    cancel.addEventListener("click", () => this.close());
    const repair = styleActionButton(actions.createEl("button", { text: lockOnly ? "确认清理" : "确认修复", cls: "mod-warning" }), "text");
    repair.addEventListener("click", () => {
      if (this.repairing) return;
      this.repairing = true;
      this.close();
      new Notice(lockOnly ? "同步：正在清理索引锁…" : "同步：正在修复…", 8000);
      void this.plugin
        .repairInterruptedGitOperation()
        .then((result) => {
          if (result.lockOnly) {
            new Notice("同步：已清理残留索引锁，请重新同步；本次未提交或上传文件", 10000);
            return;
          }
          new Notice(
            `同步：${result.operation} 异常状态已退出${
              result.restoredLocalChanges ? "，本机修改已恢复" : ""
            }；本地 Commit 和云端合并检查已完成，尚未立即 Push`,
            10000
          );
        })
        .catch((error) => {
          if (error instanceof SyncDeferredError) {
            new Notice("同步：异常状态已退出，本机内容已重新 commit；合并冲突已保留在同步面板等待处理", 12000);
          } else {
            new Notice(`同步：异常修复未完成。${messageOf(error)}`, 15000);
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
    this.modalEl.addClass("simple-one-modal");
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
    styleActionButton(actions.createEl("button", { text: "取消" }), "text").addEventListener("click", () => this.close());
    const confirm = styleActionButton(actions.createEl("button", { text: "清理本机旧历史", cls: "mod-cta" }), "text");
    confirm.disabled = this.preview.oldCommits === 0;
    confirm.addEventListener("click", () => {
      if (this.running) return;
      this.running = true;
      confirm.disabled = true;
      confirm.setText("正在清理…");
      void this.plugin.slimLocalHistory()
        .then(({ before, after }) => {
          this.close();
          new Notice(`同步：本地可见 Commit ${before.totalCommits} → ${after.totalCommits}；Git 对象约 ${before.localSizeMiB.toFixed(1)} → ${after.localSizeMiB.toFixed(1)} MiB。`, 12000);
        })
        .catch((error) => {
          this.running = false;
          confirm.disabled = false;
          confirm.setText("清理本机旧历史");
          new Notice(`同步：清理未完成。${messageOf(error)}`, 15000);
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

    applyButton = styleActionButton(container.createEl("button", {
      text: this.paths.length === 1 ? "应用并继续同步" : "应用并处理下一个文件",
      cls: "mod-cta simple-one-sync-conflict__continue"
    }), "text");
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
    const button = styleActionButton(container.createEl("button", { text: label, cls: cta ? "mod-cta" : undefined }), "text");
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
  constructor(app: App, private plugin: SyncFeature, private contextPrefix = "") {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("simple-one-sync-error-modal");
    void this.render().catch(error => new Notice(messageOf(error), 8000));
  }

  private async render(): Promise<void> {
    const lastCommitAt = this.contextPrefix ? 0 : await this.plugin.getLatestCommitAt();
    const container = this.contentEl;
    container.empty();
    const overview = container.createDiv({ cls: "simple-one-sync-error-modal__overview" });
    const heading = overview.createDiv();
    heading.createEl("h2", { text: this.contextPrefix ? "最近分享日志" : "最近同步与分享日志" });
    heading.createEl("p", {
      text: this.contextPrefix ? "最近 24 小时的分享变更及部署结果；开启分享性能详情后可查看分步耗时。" : "保留最近 24 小时的备份、同步、分享和连接记录。开启性能详情后可查看分步耗时。",
      cls: "simple-one-sync-error-modal__intro"
    });
    const lastTimes = overview.createDiv({ cls: "simple-one-sync-error-modal__last-times" });
    lastTimes.hidden = !!this.contextPrefix;
    const formatTime = (timestamp: number): string => {
      if (!timestamp) return "暂无记录";
      const absolute = new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
      const days = Math.floor(Math.max(0, Date.now() - timestamp) / 86400000);
      const relative = days >= 7 ? `${days} 天前` : formatRelativeTime(timestamp);
      return `${absolute}（${relative}）`;
    };
    for (const [label, timestamp] of [
      ["上次本地备份", lastCommitAt],
      ["上次同步", this.plugin.settings.lastSyncAt],
      ["上次云端检查", this.plugin.settings.lastPullAt]
    ] as const) {
      const row = lastTimes.createDiv({ cls: "simple-one-sync-error-modal__last-time" });
      row.createSpan({ text: label });
      row.createEl("time", { text: formatTime(timestamp) });
    }

    const logs = this.plugin.getRecentErrorLogs().filter(entry => !this.contextPrefix || entry.context.startsWith(this.contextPrefix));
    if (logs.length === 0) {
      container.createDiv({ text: this.contextPrefix ? "最近 24 小时没有分享记录。" : "最近 24 小时没有同步或分享记录。", cls: "simple-one-sync-error-modal__empty" });
    } else {
      const list = container.createDiv({ cls: "simple-one-sync-error-modal__list" });
      for (const entry of logs) {
        const isError = entry.status === "error" || !entry.status;
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
        for (const timing of entry.timings ?? []) {
          const detail = item.createDiv({ cls: "simple-one-sync-error-modal__timing" });
          detail.createEl("h4", { text: timing.title });
          detail.createEl("pre", { text: timing.message });
        }
      }
    }

    const actions = container.createDiv({ cls: "simple-one-sync-error-modal__actions" });
    if (logs.length > 0) {
      const clearButton = styleActionButton(actions.createEl("button", { text: "清空日志" }), "text");
      clearButton.addEventListener("click", asyncAction(async () => {
        await this.plugin.clearErrorLogs(this.contextPrefix);
        await this.render();
      }));
    }
    const closeButton = styleActionButton(actions.createEl("button", { text: "关闭", cls: "mod-cta" }), "text");
    closeButton.addEventListener("click", () => this.close());
  }
}

class ZoeySyncView extends ItemView {
  private collapsedFolders = new Set<string>();
  static readonly type = "simple-one-sync-view";
  private renderGeneration = 0;
  private lightweightPage = 0;
  private showLastPull = false;
  private review?: ZoeySyncConflictPreviewModal;
  private closed = false;
  private changesSnapshot?: ChangeItem[];
  private snapshotError?: unknown;
  private refreshing = false;
  private fileLayout?: FileListLayout;
  private lastRefreshAt = 0;
  private promptCancel?: () => void;
  private downloadPage = false;
  private transferError = "";
  private transferBusy = false;

  constructor(leaf: WorkspaceLeaf, private plugin: SyncFeature) {
    super(leaf);
  }

  getViewType(): string {
    return ZoeySyncView.type;
  }

  getDisplayText(): string {
    return "同步";
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
          new Notice(`同步 面板加载失败：${messageOf(error)}`, 10000);
        });
      }, 0);
    });
  }

  async reviewDifferences(live: LiveReview): Promise<Record<string, ConflictChoice> | null> {
    if (this.review) throw new Error("已有轻量同步差异正在确认");
    ++this.renderGeneration;
    const container = this.containerEl.children[1] as HTMLElement;
    const review = new ZoeySyncConflictPreviewModal(this.app, { ...live, layout: createFileListLayout(this.plugin.settings, () => this.plugin.saveSettings()) });
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
    this.promptCancel?.();
  }

  private waitForChoice<T>(render: (root: HTMLElement, resolve: (value: T) => void) => void, cancelled: T): Promise<T> {
    if (this.promptCancel || this.review) throw new Error("已有同步步骤正在确认。");
    ++this.renderGeneration;
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    return new Promise<T>(resolve => {
      const finish = (value: T): void => {
        this.promptCancel = undefined;
        resolve(value);
        if (!this.closed) void this.render().catch(error => new Notice(messageOf(error)));
      };
      this.promptCancel = () => finish(cancelled);
      render(root, finish);
    });
  }

  async chooseStrategy(plan: import("./mobileGithub").MobilePlan): Promise<SyncStrategy | null> {
    return this.waitForChoice((root, resolve) => renderStrategy(root, plan, resolve), null as SyncStrategy | null);
  }

  async confirmLightweightPlan(plan: import("./mobileGithub").MobilePlan): Promise<boolean> {
    return this.waitForChoice((root, resolve) => renderPlanConfirmation(root, plan, resolve, createFileListLayout(this.plugin.settings, () => this.plugin.saveSettings())), false);
  }

  async showDownloadTask(): Promise<void> {
    this.downloadPage = true;
    await this.render();
  }

  private async runTransferAction(action: () => Promise<void>): Promise<void> {
    if (this.transferBusy) return;
    this.transferBusy = true;
    this.transferError = "";
    const root = this.containerEl.children[1] as HTMLElement;
    root.querySelectorAll<HTMLButtonElement>(".simple-one-sync-transfer button").forEach(button => { button.disabled = true; });
    try { await this.plugin.runDownloadTask(action); }
    catch (error) { this.transferError = messageOf(error); }
    finally { this.transferBusy = false; await this.render(); }
  }

  updateActivity(state: ViewStatusState): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.querySelector<HTMLElement>(".simple-one-sync-transfer__progress")?.setText(state.text);
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
    quota.setText(remaining === null ? "API 额度待查询" : `API 剩余 ${remaining.toLocaleString()} 次`);
    quota.setAttribute("aria-label", "以最近一次 GitHub 响应为准；下一次请求会更新额度，同账号其他设备可能共享额度。");
  }

  async render(reuseChanges = false): Promise<void> {
    if (this.closed || this.review || this.promptCancel || !this.app.workspace.layoutReady) return;
    const generation = ++this.renderGeneration;
    const container = this.containerEl.children[1] as HTMLElement;

    if (this.plugin.settings.enabled === false) {
      container.empty();
      container.addClass("simple-one-sync-view");
      container.createEl("p", { text: "同步已关闭，可在同步设置中启用。" });
      styleActionButton(container.createEl("button", { text: "打开同步设置", attr: { type: "button" } }), "text")
        .addEventListener("click", () => this.plugin.openPluginSettings());
      return;
    }

    const verifiedPlan = this.plugin.getLightweightPlan?.();
    let changes: ChangeItem[] = [];
    let changesError: unknown;
    const pendingConflictPaths = await this.plugin.getPendingConflictPaths();
    const deferredMergePaths = this.plugin.getDeferredMergePaths();
    try {
      if (reuseChanges && this.changesSnapshot) { changes = this.changesSnapshot; changesError = this.snapshotError; }
      else changes = await this.plugin.getChanges();
    } catch (error) {
      changesError = error;
    }
    if (verifiedPlan) {
      const paths = new Set([...verifiedPlan.uploads, ...verifiedPlan.downloads, ...verifiedPlan.localDeletes, ...verifiedPlan.remoteDeletes]);
      changes = [...paths].sort().map(path => ({ path, kind: !verifiedPlan.desired[path] ? "deleted"
        : verifiedPlan.local[path] && verifiedPlan.remote.files[path] ? "modified" : "added" }));
      changesError = undefined;
    }
    let statusState = await this.getStatusState(changes, changesError);
    if (pendingConflictPaths.length > 0) {
      statusState = { tone: "error", text: `有 ${pendingConflictPaths.length} 个合并冲突等待处理` };
    } else if (deferredMergePaths.length > 0) {
      statusState = { tone: "error", text: `同步暂缓 · ${deferredMergePaths.length} 个文件仍在修改` };
    }
    if (generation !== this.renderGeneration) return;
    if (!changesError && !verifiedPlan) this.changesSnapshot = changes;
    this.snapshotError = changesError;
    if (this.refreshing && !changesError) this.lastRefreshAt = Date.now();
    container.empty();
    container.addClass("simple-one-sync-view");
    const recentLogs = this.plugin.getRecentErrorLogs();
    const hasActiveError = !!this.plugin.getActiveSyncError();

    const header = container.createDiv({ cls: "simple-one-sync-view__header" });
    const actions = header.createDiv({ cls: "simple-one-sync-view__actions" });
    this.fileLayout = createFileListLayout(this.plugin.settings, () => this.plugin.saveSettings());
    renderLayoutToggle(actions, this.fileLayout);
    const refreshButton = actions.createDiv({ cls: "clickable-icon nav-action-button" });
    actions.prepend(refreshButton);
    refreshButton.setAttr("role", "button");
    refreshButton.setAttr("tabindex", "0");
    refreshButton.setAttr("aria-label", "刷新更改区");
    setActionIcon(refreshButton, "refresh-cw", "plain");
    setTooltip(refreshButton, "刷新本地文件列表");
    refreshButton.addEventListener("click", asyncAction(async () => {
      if (refreshButton.getAttr("aria-busy") === "true") return;
      refreshButton.setAttr("aria-busy", "true");
      refreshButton.addClass("is-loading");
      this.refreshing = true;
      container.querySelector(".simple-one-sync-view__status-text")?.setText("正在刷新文件列表…");
      try { await this.render(); }
      finally { this.refreshing = false; refreshButton.removeClass("is-loading"); refreshButton.removeAttribute("aria-busy"); }
    }));
    if (recentLogs.length > 0) {
      const errorButton = actions.createDiv({
        cls: `clickable-icon nav-action-button simple-one-sync-view__error-button${hasActiveError ? " is-active" : ""}`
      });
      errorButton.setAttr("role", "button");
      errorButton.setAttr("tabindex", "0");
      errorButton.setAttr("aria-label", `查看最近同步与分享日志，共 ${recentLogs.length} 条`);
      setIcon(errorButton, hasActiveError ? "triangle-alert" : "history");
      setTooltip(errorButton, `查看最近同步与分享日志（${recentLogs.length}）`);
      errorButton.addEventListener("click", () => new ErrorLogModal(this.app, this.plugin).open());
    }
    const settingsButton = actions.createDiv({ cls: "clickable-icon nav-action-button" });
    settingsButton.setAttr("role", "button");
    settingsButton.setAttr("tabindex", "0");
    setActionIcon(settingsButton, "settings", "plain");
    setTooltip(settingsButton, "打开同步设置");
    settingsButton.setAttr("aria-label", "打开同步设置");
    settingsButton.addEventListener("click", () => this.plugin.openPluginSettings());
    const downloadEngine = this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github" ? this.plugin.getMobileGithub() : undefined;
    if (downloadEngine?.downloadTask) {
      const reminder = styleActionButton(actions.createEl("button", { cls: "clickable-icon nav-action-button simple-one-sync-download-alert",
        attr: { type: "button", "aria-label": tooltipText("下载待办尚未完成", "继续逐文件下载") } }), "bordered");
      setIcon(reminder, "triangle-alert");
      reminder.addEventListener("click", () => void this.showDownloadTask());
    }


    const status = container.createDiv({ cls: "simple-one-sync-view__status" });
    status.addClass(`is-${statusState.tone}`);
    status.createSpan({ cls: "simple-one-sync-view__status-dot" });
    const statusCopy = status.createDiv({ cls: "simple-one-sync-view__status-copy" });
    const statusText = statusCopy.createSpan({ text: statusState.text, cls: "simple-one-sync-view__status-text" });
    if (this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github") {
      setTooltip(statusText, verifiedPlan
        ? "正在执行本次已核验计划；范围、文件和云端状态变化时会停止并要求重新核对。"
        : "候选文件仅反映本机变化；同步时核验内容并检查云端，实际传输数量可能不同。");
    }
    if (this.plugin.nativeGitEnabled()) {
      statusText.setAttr("role", "button");
      statusText.setAttr("tabindex", "0");
      const hint = this.showLastPull ? "点击查看上次上传时间" : "点击查看上次获取云端更新时间";
      statusText.setAttr("aria-label", hint);
      setTooltip(statusText, hint);
      const toggleTime = asyncAction(async () => {
        this.showLastPull = !this.showLastPull;
        await this.render();
      });
      statusText.addEventListener("click", toggleTime);
      statusText.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleTime();
        }
      });
    }
    const errors = new Map<string, Set<string>>();
    const addError = (context: string, error: unknown): void => {
      const message = messageOf(error).replace(/^(?:Error:\s*)+/, "").trim() || "未知错误";
      const contexts = errors.get(message) ?? new Set<string>(); contexts.add(context); errors.set(message, contexts);
    };
    if (changesError) addError("无法读取更改", changesError);
    const activeError = this.plugin.getActiveSyncError();
    if (activeError) addError(activeError.context || "同步", activeError.message);
    if (this.downloadPage && this.transferError) addError("下载恢复", this.transferError);
    for (const [message, contexts] of errors) statusCopy.createDiv({
      text: [...contexts].join(" / ") + "：" + message, cls: "simple-one-sync-view__error-detail", attr: { role: "alert" }
    });
    if (changesError) statusCopy.createSpan({ text: this.changesSnapshot?.length
      ? "暂时保留上次文件列表，请重新刷新。" : "暂无可显示的文件列表，请重新刷新。", cls: "simple-one-sync-view__refresh-time" });
    const statusMeta = statusCopy.createDiv({ cls: "simple-one-sync-view__status-meta" });
    if (this.lastRefreshAt) statusMeta.createSpan({ text: `列表已刷新 · ${formatRelativeTime(this.lastRefreshAt)}`, cls: "simple-one-sync-view__refresh-time" });
    if (this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github" && this.plugin.settings.lastSyncAt) {
      statusMeta.createSpan({ text: `上次同步 ${formatRelativeTime(this.plugin.settings.lastSyncAt)}`, cls: "simple-one-sync-view__refresh-time" });
    }
    if (downloadEngine) {
      statusMeta.createSpan({ cls: "simple-one-sync-view__quota" });
      this.updateQuota();
    }

    if (this.downloadPage && downloadEngine?.downloadTask) {
      renderDownloadTask(container, downloadEngine, action => this.runTransferAction(action));
      if (this.transferBusy) container.querySelectorAll<HTMLButtonElement>(".simple-one-sync-transfer button").forEach(button => { button.disabled = true; });
      return;
    }
    if (!downloadEngine?.downloadTask) this.downloadPage = false;

    if (pendingConflictPaths.length > 0) {
      const reminder = container.createDiv({ cls: "simple-one-sync-view__conflict-reminder" });
      setIcon(reminder.createSpan({ cls: "simple-one-sync-view__conflict-reminder-icon" }), "triangle-alert");
      const copy = reminder.createDiv({ cls: "simple-one-sync-view__conflict-reminder-copy" });
      copy.createDiv({ text: "同步尚未完成", cls: "simple-one-sync-view__conflict-reminder-title" });
      copy.createDiv({
        text: `${pendingConflictPaths.length} 个异常文件等待确认；已能合并的内容会保留，不会被回滚。`,
        cls: "simple-one-sync-view__conflict-reminder-desc"
      });
      const continueButton = styleActionButton(reminder.createEl("button", { text: "继续处理", cls: "mod-cta" }), "text");
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
      text: this.plugin.isSyncing() ? "同步中…" : "同步"
    });
    setIcon(actionSpinner, "loader-circle");
    actionButton.toggleClass("is-loading", this.plugin.isSyncing());
    actionButton.disabled = this.plugin.isSyncing() || pendingConflictPaths.length > 0;
    actionButton.setAttr(
      "aria-label",
      "下载远端更新并上传本机更改"
    );
    setTooltip(actionButton, this.plugin.useLightweightSync()
      ? "核验本机候选变化与云端文件后同步；能够确定的变更自动同步；首次对齐或无法自动判断的差异需要确认。"
      : "下载远端更新并上传本机更改");
    actionButton.addEventListener("click", asyncAction(async () => {
      actionButton.disabled = true;
      actionButton.addClass("is-loading");
      actionLabel.setText("同步中…");
      try {
        await this.plugin.syncNow(true);
        await this.render();
      } finally {
        actionButton.disabled = this.plugin.isSyncing();
        actionButton.removeClass("is-loading");
      }
    }));

    if (verifiedPlan) section.createDiv({ text: `本次同步变更 · 上传 ${verifiedPlan.uploads.length} · 下载 ${verifiedPlan.downloads.length} · 删除本机 ${verifiedPlan.localDeletes.length} · 删除云端 ${verifiedPlan.remoteDeletes.length}`, cls: "simple-one-sync-view__refresh-time" });
    if (!changesError) {
      if (this.plugin.useLightweightSync() && this.plugin.isSyncing() && !verifiedPlan) {
        // Keep the list empty until the sync plan is ready for display.
      } else if (this.plugin.getLightweightPendingStatus()) {
        section.createDiv({ text: "已接入。点击同步，完成首次文件对齐。", cls: "simple-one-sync-view__empty" });
      } else if (changes.length === 0) {
        const empty = section.createDiv({ cls: "simple-one-sync-view__empty" });
        setIcon(empty.createSpan(), "check-circle-2");
        empty.createSpan({ text: verifiedPlan ? "两端没有需要同步的变更" : "本机暂无变更" });
      } else {
        let visible = changes;
        {
          const pages = Math.ceil(changes.length / 100);
          this.lightweightPage = Math.min(this.lightweightPage, pages - 1);
          visible = changes.slice(this.lightweightPage * 100, (this.lightweightPage + 1) * 100);
          if (pages > 1) {
            const paging = section.createDiv();
            const prev = styleActionButton(paging.createEl("button", { text: "上一页" }), "text");
            prev.disabled = this.lightweightPage === 0;
            prev.addEventListener("click", () => { this.lightweightPage--; void this.render(true); });
            paging.createSpan({ text: " 第 " + (this.lightweightPage + 1) + " / " + pages + " 页 · 本页 " + visible.length + "/" + changes.length + " 个 " });
            const next = styleActionButton(paging.createEl("button", { text: "下一页" }), "text");
            next.disabled = this.lightweightPage === pages - 1;
            next.addEventListener("click", () => { this.lightweightPage++; void this.render(true); });
          }
        }
        this.renderTree(section, visible);
      }
    } else {
      if (this.changesSnapshot?.length) {
        const visible = this.changesSnapshot.slice(this.lightweightPage * 100, (this.lightweightPage + 1) * 100);
        this.renderTree(section, visible);
      }
    }
  }

  private async getStatusState(
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
      return { tone: "checking", text: "正在整理同步结果…" };
    }
    if (changesError) {
      return { tone: "error", text: "刷新失败" };
    }

    const lightweightPending = this.plugin.getLightweightPendingStatus();
    if (lightweightPending) return lightweightPending;

    const { lastSyncAt, lastPullAt } = this.plugin.settings;
    const showPull = this.plugin.nativeGitEnabled() && this.showLastPull;
    const lastSyncText = showPull
      ? lastPullAt ? `上次获取云端更新 ${formatRelativeTime(lastPullAt)}` : "尚未获取云端更新"
      : lastSyncAt ? `上次同步 ${formatRelativeTime(lastSyncAt)}` : "尚未同步";
    const activeError = this.plugin.getActiveSyncError();
    if (activeError) {
      return { tone: "error", text: `同步失败 · ${formatRelativeTime(activeError.timestamp)}` };
    }
    if (changes.length > 0) {
      return { tone: "pending", text: this.plugin.useLightweightSync() && this.plugin.settings.mobile.mode === "github"
        ? `本机变更 · ${changes.length} 个文件` : `本机变更 · ${changes.length} 个文件 · ${lastSyncText}` };
    }
    return {
      tone: "success",
      text: this.plugin.useLightweightSync()
        ? "本机暂无变更"
        : `本机暂无变更 · ${lastSyncText}`
    };
  }

  private renderTree(parent: HTMLElement, changes: ChangeItem[]): void {
    renderFileTree(parent, changes, change => change.path, (folder, change, fullPath) => this.renderChange(folder, change, fullPath), { collapsed: this.collapsedFolders, layout: this.fileLayout });
  }

  private renderChange(parent: HTMLElement, change: ChangeItem, fullPath: boolean): void {
    const row = parent.createDiv({ cls: "simple-one-sync-view__change" });
    row.setAttr("data-kind", change.kind);
    row.setAttribute("aria-label", change.path);
    row.createSpan({ text: this.changeMark(change.kind), cls: "simple-one-sync-view__mark" });
    const text = row.createDiv({ cls: "simple-one-sync-view__change-text" });
    const label = fullPath ? change.path : change.path.split("/").pop() || change.path;
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

type SyncSettingsPage = "root" | "share-root" | "mobile" | "server" | "setup" | "desktop-settings" | "beginner-desktop" | "beginner-mobile" | "beginner-server";

export class SyncSettingsTab extends PluginSettingTab {
  private desktopPage: SyncSettingsPage = "root";
  private navigationParents: SyncSettingsPage[] = [];
  private navigationRoot: SyncSettingsPage = "root";
  private setupViewStep = 1;
  private lightweightGuideController?: AbortController;
  private lightweightGuideToken = "";
  private lightweightGuideStatus = "";
  private lightweightGuideStep = 1;
  private lightweightGuideDraft?: MobileOptions;
  private lightweightGuideLogin = "";
  private lightweightGuideVerified?: VerifiedAccess;
  private lightweightGuideRepoMode: "existing" | "create" = "existing";
  private lightweightGuideTokenMode: "acquire" | "existing" = "acquire";
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
  private setupTrustRequired = false;
  private setupBusy = false;
  private setupRebuildConfirmed = false;
  private setupReviewPreview?: SetupPreview;
  private setupFinishedPreview?: SetupPreview;
  private setupFileFilter: "local" | "remote" | "changed" = "changed";
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
      root: "同步",
      "share-root": "分享",
      setup: "电脑端同步引导",
      "beginner-desktop": "电脑端同步引导",
      "beginner-mobile": "轻量同步引导",
      "beginner-server": "笔记分享引导",
      "desktop-settings": "电脑端 Git 同步设置",
      mobile: "轻量 Git 同步设置",
      server: this.plugin.host?.share?.isEdgeOneGuideOpen ? "腾讯 EdgeOne 接入引导" : this.plugin.host?.share?.isLibraryManagementOpen ? "分享库管理" : "笔记分享设置"
    };
    return titles[this.desktopPage];
  }

  resetNavigation(sharing = false): void {
    this.stopSetupBrowserAuthorization();
    this.lightweightGuideController?.abort();
    this.navigationParents = [];
    this.navigationRoot = sharing ? "share-root" : "root";
    this.desktopPage = this.navigationRoot;
  }

  openShareSettings(): void {
    this.navigateTo("server");
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
    if (["server", "share-root"].includes(this.desktopPage) && this.plugin.host?.share?.backFromEdgeOneGuide()) return true;
    if (["server", "share-root"].includes(this.desktopPage) && this.plugin.host?.share?.backFromShareLibraryManagement?.()) return true;
    if (this.desktopPage === (this.navigationRoot ?? "root")) return false;
    this.stopSetupBrowserAuthorization();
    this.lightweightGuideController?.abort();
    this.desktopPage = this.navigationParents?.pop() ?? this.navigationRoot ?? "root";
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
    containerEl.toggleClass("simple-desktop-git-settings", false);
    containerEl.toggleClass("simple-one-sync-root", this.desktopPage === "root");
    containerEl.toggleClass("simple-one-sync-setup-page", ["setup", "desktop-settings"].includes(this.desktopPage) && !Platform.isMobile);
    containerEl.toggleClass("simple-one-sync-mobile-guide-page", this.desktopPage === "beginner-mobile");
    if (this.desktopPage === "share-root") {
      containerEl.addClass("simple-one-sync-root");
      const links = containerEl.createDiv({ cls: "simple-one-sync-beginner-links" });
      this.addBeginnerLink(links, "笔记分享引导", "share-2", "beginner-server");
      this.plugin.host?.share?.renderSettings(containerEl.createDiv(), false, false, title => {
        const root = title === "笔记分享设置";
        links.style.display = root ? "" : "none";
        containerEl.toggleClass("simple-one-sync-root", root);
        this.settingsTitleChanged?.(title === "笔记分享设置" ? "分享" : title);
      });
      return;
    }

    if (this.desktopPage === "beginner-mobile") { this.displayBeginnerMobile(containerEl); return; }
    if (this.desktopPage === "beginner-desktop") { this.displayDevicePreview(containerEl, "从创建仓库开始：电脑端同步", "请在电脑端打开此引导，完成 GitHub 授权、仓库接入与两端检查。"); return; }
    if (this.desktopPage === "beginner-server") { this.plugin.host?.share?.renderSettings(containerEl, true, !this.settingsTitleChanged); return; }
    if (this.desktopPage === "mobile") { this.displayMobilePreview(containerEl); return; }
    if (this.desktopPage === "server") { this.plugin.host?.share?.renderSettings(containerEl, false, !this.settingsTitleChanged, this.settingsTitleChanged); return; }
    if (!Platform.isMobile && this.desktopPage === "setup") { this.displaySetup(containerEl); return; }
    if (!Platform.isMobile && this.desktopPage === "desktop-settings") { this.displayDesktopSettings(containerEl); return; }

    this.displayBeginner(containerEl);
    this.displayDesktop(containerEl);
  }

  private syncSettingsBody(parent: HTMLElement, enabled: boolean): HTMLElement {
    const body = parent.createEl("fieldset", { cls: "simple-one-sync-engine-body" });
    body.disabled = !enabled;
    body.inert = !enabled;
    body.toggleClass("is-disabled", !enabled);
    return body;
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

  private addSyncBadges(parent: HTMLElement, recommended: boolean, active: boolean, onToggle: () => Promise<void>): void {
    const badges = parent.createSpan({ cls: "simple-one-sync-device-badges" });
    if (recommended) badges.createSpan({ text: "当前平台推荐", cls: "simple-one-sync-device-badge" });
    const state = badges.createEl("button", { text: active ? "当前启用" : "当前未启用", cls: `simple-one-sync-device-badge simple-one-sync-state-toggle${active ? " is-applied" : ""}`, attr: { type: "button", "aria-pressed": String(active), "aria-label": active ? "关闭此功能" : "启用此功能" } });
    state.addEventListener("click", event => {
      event.stopPropagation();
      void (async () => {
      state.disabled = true;
      try { await onToggle(); }
      catch (error) { new Notice(`切换失败：${messageOf(error)}`); }
      finally { this.renderSettings(); }
      })();
    });
  }

  private addSettingsArrow(parent: HTMLElement, page: "desktop-settings" | "mobile" | "server", title: string): void {
    const arrow = styleActionButton(parent.createEl("button", { cls: "clickable-icon simple-one-sync-entry-arrow", attr: { type: "button", "aria-label": `打开${title}` } }), "bordered");
    setIcon(arrow, "chevron-right");
    parent.tabIndex = 0;
    parent.setAttribute("role", "link");
    parent.setAttribute("aria-label", `打开${title}`);
    parent.addEventListener("click", () => this.navigateTo(page));
    parent.addEventListener("keydown", event => {
      if (event.target !== parent || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      this.navigateTo(page);
    });
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
    const links = containerEl.createDiv({ cls: "simple-one-sync-beginner-links" });
    this.addBeginnerLink(links, "电脑端同步引导", "monitor", Platform.isMobile ? "beginner-desktop" : "setup");
    this.addBeginnerLink(links, "轻量同步引导", "smartphone", "beginner-mobile");
  }

  private displayBeginnerMobile(containerEl: HTMLElement): void {
    containerEl.addClass("simple-one-sync-setup-page");
    const page = containerEl.createDiv({ cls: "simple-one-sync-setup-layout" });
    this.displayDevicePreview(page, "轻量同步引导", "核验账号与私人仓库，准备本机配置即可完成接入。文件比对与同步在侧边栏单独执行。");
    if (!this.lightweightGuideDraft) {
      const options = this.plugin.settings.mobile;
      const progress = this.plugin.settings.lightweightGuideProgress;
      const repoUrl = progress?.repoUrl || this.plugin.settings.boundRepoUrl || options.repoUrl || this.plugin.settings.gitRemoteUrl || this.plugin.settings.setupRepoUrl;
      this.lightweightGuideDraft = { ...options, plugins: [...options.plugins], ignorePatterns: [...options.ignorePatterns],
        repoUrl, branch: progress?.repoUrl === repoUrl ? progress.branch : options.repoUrl === repoUrl ? options.branch : "" };
      this.lightweightGuideStep = progress ? Math.max(1, Math.min(4, progress.step)) : 1;
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
      completed = options.mode === "github" && options.bound && !!this.plugin.settings.lightweightGuideProgress?.complete && this.plugin.settings.lightweightGuideProgress.repoUrl === options.repoUrl && this.plugin.settings.lightweightGuideProgress.branch === options.branch && engine.state.binding === `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${options.branch}`;
    } catch { /* An incomplete repository address remains an unfinished setup. */ }
    const connectionStatus = page.createDiv({ cls: `simple-one-sync-setup-status is-${completed ? "success" : "disconnected"}`, attr: { role: "status" } });
    setIcon(connectionStatus.createSpan({ cls: "simple-one-sync-setup-status__icon" }), completed ? "check" : "unplug");
    const connectionCopy = connectionStatus.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    connectionCopy.createEl("strong", { text: completed ? "首次接入已完成" : options.bound ? "接入配置待核验" : "首次接入尚未完成" });
    connectionCopy.createEl("p", { text: this.lightweightGuideStateError || (completed ? "账号与本机配置已接入。文件尚未同步时没有共同基线，这是正常状态。" : "核验授权与仓库并准备本机规则；接入不会扫描、上传或下载文件。") });
    const restart = connectionStatus.createEl("button", { text: "重新检查或修复接入", attr: { type: "button" } });
    styleActionButton(restart, "text");
    restart.disabled = this.lightweightGuideBusy || this.plugin.isSyncing();
    restart.addEventListener("click", () => { void (async () => {
      if (restart.disabled) return;
      this.lightweightGuideBusy = true;
      restart.disabled = true; restart.setText("正在清理…");
      try {
        await this.plugin.restartLightweightSetup();
        this.lightweightGuideController?.abort(); this.lightweightGuideStep = 1;
        this.lightweightGuideToken = ""; this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined;
        this.lightweightGuideStateChecked = false; this.lightweightGuideStateError = "";
        this.lightweightGuideDraft = undefined;
      } catch (error) { this.lightweightGuideStateError = messageOf(error); }
      finally {
        this.lightweightGuideBusy = false;
        if (this.desktopPage === "beginner-mobile") this.renderSettings();
      }
    })(); });
    const nav = page.createDiv({ cls: "simple-one-sync-setup-nav simple-one-sync-lightweight-nav" });
    const progress = this.plugin.settings.lightweightGuideProgress;
    const finished = completed || !!progress?.complete;
    const available = Math.max(finished ? 4 : progress?.step || 2, this.lightweightGuideVerified ? 4 : this.lightweightGuideLogin ? 3 : 2);
    ["获取 Token", "核验 Token", "选择仓库", "完成接入"].forEach((label, index) => {
      const step = index + 1;
      const done = finished || step < (progress?.step || 1) || (step === 1 ? !!(this.lightweightGuideToken || this.lightweightGuideLogin) : step === 2 ? !!this.lightweightGuideLogin : step === 3 && !!this.lightweightGuideVerified);
      const button = nav.createEl("button", { cls: `simple-one-sync-setup-nav__step${step === this.lightweightGuideStep ? " is-active" : ""}${done ? " is-done" : ""}`,
        attr: { type: "button", "aria-current": step === this.lightweightGuideStep ? "step" : "false" } });
      button.createSpan({ text: String(step), cls: "simple-one-sync-setup-nav__marker" });
      button.createSpan({ text: label, cls: "simple-one-sync-setup-nav__label" });
      button.disabled = step > available || this.lightweightGuideBusy;
      button.addEventListener("click", () => {
        if (this.lightweightGuideBusy || step > available) return;
        this.lightweightGuideController?.abort(); this.lightweightGuideStep = step; this.renderSettings();
      });
    });
    if (this.lightweightGuideStep !== 1) { this.displayLightweightGuideStep(page); return; }
    const guideCard = page.createDiv({ cls: "simple-one-sync-mobile-guide__card" });
    new Setting(guideCard).setName("获取 GitHub token").setHeading();
    guideCard.createEl("p", { text: "电脑端可从已登录的 GitHub CLI 获取；已有 token 可直接填入并核验。", cls: "simple-one-sync-setup-step-desc" });
    const methods = guideCard.createDiv({ cls: "simple-one-sync-setup-options" });
    for (const mode of ["acquire", "existing"] as const) {
      const selected = mode === this.lightweightGuideTokenMode;
      const button = methods.createEl("button", { text: mode === "acquire" ? "在电脑端获取 Token" : "已有 Token，直接填入",
        cls: `simple-one-sync-setup-option${selected ? " is-selected" : ""}`, attr: { type: "button", "aria-pressed": String(selected) } });
      button.addEventListener("click", () => { this.lightweightGuideTokenMode = mode; this.renderSettings(); });
    }
    const card = guideCard.createDiv({ cls: "simple-one-sync-lightweight-choice-content" });
    if (this.lightweightGuideTokenMode === "existing") {
      card.createEl("p", { text: "将已保存的 GitHub token 填入下一步。token 仅保存在本机，不写入共享配置。" });
      const next = card.createEl("button", { text: "填入并核验 token", cls: "mod-cta", attr: { type: "button" } });
      styleActionButton(next, "text");
      next.addEventListener("click", () => { this.lightweightGuideStep = 2; this.renderSettings(); });
      return;
    }
    const ready = !!this.lightweightGuideToken;
    card.createEl("p", { text: "先在电脑端登录 GitHub CLI，再一键获取 token。请保存 token，以便在手机端或新设备使用。", cls: "simple-one-sync-section-desc" });
    const loginStatus = card.createDiv({ cls: "simple-one-sync-setup-status", attr: { role: "status", "aria-live": "polite" } });
    const loginIcon = loginStatus.createSpan({ cls: "simple-one-sync-setup-status__icon" });
    setIcon(loginIcon, "loader-circle");
    const loginCopy = loginStatus.createDiv({ cls: "simple-one-sync-setup-status__copy" });
    const loginTitle = loginCopy.createEl("strong", { text: "正在检查本机登录状态…" });
    const loginDescription = loginCopy.createEl("p", { text: "检查 Git 与 GitHub CLI。" });
    const prerequisites = loginStatus.createEl("button", { text: "安装与登录帮助", attr: { type: "button" } });
    styleActionButton(prerequisites, "text");
    prerequisites.hidden = true;
    prerequisites.addEventListener("click", () => {
      this.setupViewStep = 1;
      this.navigateTo(Platform.isMobile ? "beginner-desktop" : "setup");
    });
    const actions = card.createDiv({ cls: "simple-one-sync-mobile-guide__actions" });
    const acquire = actions.createEl("button", { text: "一键获取 token（pc 端）", cls: Platform.isMobile ? "" : "mod-cta", attr: { type: "button" } });
    styleActionButton(acquire, "text");
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
    const copy = row.createEl("button", { cls: "simple-one-sync-mobile-guide__copy", attr: { type: "button", "aria-label": "复制 token" } });
    setActionIcon(copy, "copy", "plain");
    const copyStatus = tokenBox.createEl("p", { cls: "simple-one-sync-mobile-guide__result", attr: { role: "status", "aria-live": "polite" } });
    const reportCopy = (text: string, error = false) => {
      copyStatus.setText(text); copyStatus.toggleClass("simple-one-sync-setup-done", !error); copyStatus.toggleClass("simple-one-sync-setup-error", error);
    };
    copy.addEventListener("click", () => void navigator.clipboard.writeText(this.lightweightGuideToken)
      .then(() => reportCopy("Token 已复制。"), () => reportCopy("复制失败，请手动复制 Token。", true)));
    tokenBox.createEl("p", { text: "请妥善保存 token，便于在手机端填入或更换设备时使用。", cls: "simple-one-sync-mobile-guide__token-reminder" });
    const accept = async (token: string) => {
      if (!valid()) return;
      this.lightweightGuideDraft!.token = token;
      this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined;
      this.lightweightGuideToken = token; this.lightweightGuideStatus = "";
      await this.saveLightweightGuideProgress(2);
      if (!valid()) return;
      this.renderSettings();
    };
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
      acquiring = true; acquire.disabled = true;
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
        await accept(token);
      } catch (error) {
        if (valid() && !login.signal.aborted) report(`获取失败：${messageOf(error)}。可重试或填入 Token。`, true);
      } finally {
        if (this.lightweightGuideController === login) this.lightweightGuideController = undefined;
        acquiring = false;
        if (valid()) acquire.disabled = !loginReady;
      }
    })());
    if (ready) {
      const footer = card.createDiv({ cls: "simple-one-sync-setup-footer" });
      const next = footer.createEl("button", { text: "我已保存好 token", cls: "mod-cta", attr: { type: "button", "aria-label": "继续配置轻量同步" } });
      styleActionButton(next, "text");
      next.addEventListener("click", () => { this.lightweightGuideStep = 2; this.renderSettings(); });
    }
  }

  private async saveLightweightGuideProgress(step: number): Promise<void> {
    const options = this.lightweightGuideDraft!;
    const previous = this.plugin.settings.lightweightGuideProgress;
    const sameRepo = previous?.repoUrl === options.repoUrl && previous.branch === options.branch;
    const next = { step: Math.max(step, sameRepo ? previous.step : 1), complete: sameRepo && previous.complete,
      repoUrl: options.repoUrl, branch: options.branch, login: this.lightweightGuideLogin || previous?.login || "" };
    this.plugin.settings.lightweightGuideProgress = next;
    try { await this.plugin.saveSettings(); }
    catch (error) { if (this.plugin.settings.lightweightGuideProgress === next) this.plugin.settings.lightweightGuideProgress = previous; throw error; }
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
      status.setText(text); status.toggleClass("simple-one-sync-setup-error", error); status.toggleClass("simple-one-sync-setup-done", !error && (text.startsWith("✓") || text === "接入完成"));
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
    new Setting(body).setName(["核验 GitHub Token", "选择 GitHub 仓库", "完成接入"][step - 2]).setHeading();
    if (step === 2) {
      body.createEl("p", { text: "填入 token 并核验 GitHub 连接；成功后自动进入选择仓库。token 仅保存在本机。", cls: "simple-one-sync-setup-step-desc" });
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
      new Setting(body).addButton((button) => {
        styleActionButton(button.buttonEl, "text");
        button.setButtonText("核验连接").setCta().onClick(() => void run(async () => {
          this.lightweightGuideLogin = ""; this.lightweightGuideVerified = undefined;
          report("正在核验 GitHub 连接…");
          const login = await engine.verifyToken();
          if (!valid()) return;
          this.lightweightGuideLogin = login;
          await this.saveLightweightGuideProgress(3);
          if (!valid()) return;
          this.lightweightGuideStep = 3;
          this.renderSettings();
        }));
      });
      if (this.lightweightGuideLogin) report(`✓ Token 有效，当前账号：${this.lightweightGuideLogin}。`);
    } else if (step === 3) {
      body.addClass("simple-one-sync-setup-intro", "simple-one-sync-setup-repository", "simple-one-sync-setup-body");
      body.createEl("p", { text: "核验已有私人仓库或新建私人仓库。", cls: "simple-one-sync-setup-step-desc" });
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
        report("正在检查仓库…");
        const remote = await engine.verifyAccess();
        if (!valid()) return;
        options.repoUrl = parseGithubRepoUrl(options.repoUrl).url; options.branch = remote.branch;
        this.lightweightGuideVerified = remote;
        await this.saveLightweightGuideProgress(4);
        if (!valid()) return;
        this.lightweightGuideStep = 4;
        this.renderSettings();
      };
      if (this.lightweightGuideRepoMode === "create") {
        card.createEl("p", { text: "填写仓库名称后，会自动在当前 GitHub 账号下创建私人仓库，并初始化 README 和默认分支。" });
        new Setting(card).setName("新仓库名称").addText((text) => text.setPlaceholder("例如 my-Obsidian-vault").setValue(this.lightweightGuideRepoName)
          .onChange((value) => { this.lightweightGuideRepoName = value.trim(); })).settingEl.addClass("simple-one-sync-setup-repo-name");
        card.appendChild(status);
        new Setting(card).addButton((button) => {
          styleActionButton(button.buttonEl, "text");
          button.setButtonText("创建私人仓库").setCta().onClick(() => void run(async () => {
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
          }));
        }).settingEl.addClass("simple-one-sync-setup-action");
      } else {
        card.createEl("p", { text: "在已有仓库页面点击 code → copy，复制 HTTPS 地址并粘贴到下方输入框。", cls: "simple-one-sync-setup-helper" });
        const invalidate = () => { this.lightweightGuideVerified = undefined; status.empty(); updateNext(); };
        const repoSetting = new Setting(card).addText((text) => {
          text.inputEl.setAttribute("aria-label", "GitHub 仓库地址");
          text.setPlaceholder("https://github.com/用户名/仓库.git").setValue(options.repoUrl)
            .onChange((value) => { options.repoUrl = value.trim(); invalidate(); });
        });
        repoSetting.settingEl.addClass("simple-one-sync-setup-repo-url");
        card.appendChild(status);
        new Setting(card).addButton((button) => {
          styleActionButton(button.buttonEl, "text");
          button.setButtonText("检查仓库").setCta().onClick(() => void run(checkRepository));
        })
          .settingEl.addClass("simple-one-sync-setup-action", "simple-one-sync-setup-check-action", "simple-one-sync-setup-auth-submit");
      }
    } else {
      body.createEl("p", { text: "只核验账号、仓库权限并准备本机配置。接入完成后，在侧边栏单独开始同步。", cls: "simple-one-sync-setup-step-desc" });
      body.createEl("p", { text: options.repoUrl });
      body.createEl("p", { text: "分支：" + options.branch });
    }
    let next: HTMLButtonElement | undefined;
    if (step === 4) {
      body.appendChild(status);
      const footer = body.createDiv({ cls: "simple-one-sync-setup-footer" });
      let connected = this.plugin.settings.mobile.bound && !!this.plugin.settings.lightweightGuideProgress?.complete && this.plugin.settings.mobile.repoUrl === options.repoUrl && this.plugin.settings.mobile.branch === options.branch;
      next = footer.createEl("button", { text: connected ? "打开同步" : "准备接入", cls: "mod-cta", attr: { type: "button" } });
      styleActionButton(next, "text");
      if (connected) report("✓ 接入完成。请在侧边栏手动同步。尚未建立同步基准是正常状态。");
      next.addEventListener("click", () => {
        if (next?.disabled) return;
        if (connected) { void this.plugin.openSyncView().catch(error => report(messageOf(error), true)); return; }
        void run(async () => {
          next!.setText("正在准备…");
          try {
            await this.plugin.completeLightweightGuide({ ...options, plugins: [...options.plugins], ignorePatterns: [...options.ignorePatterns] }, message => report(message));
            if (!valid()) return;
            connected = true;
            report("✓ 接入完成。请在侧边栏手动同步；这里没有执行文件同步。");
            next!.setText("打开同步");
            page.querySelectorAll(".simple-one-sync-lightweight-nav button").forEach(button => button.addClass("is-done"));
            this.renderSettings();
          } catch (error) { if (valid()) next!.setText("重试接入"); throw error; }
        });
      });
      next.dataset.connected = connected ? "true" : "false";
    }

    const updateNext = () => {
      if (next) next.disabled = this.lightweightGuideBusy || (!this.lightweightGuideVerified && !this.plugin.settings.lightweightGuideProgress?.complete);
      const progress = this.plugin.settings.lightweightGuideProgress;
      const available = Math.max(progress?.step || (this.plugin.settings.mobile.bound && this.plugin.settings.lightweightGuideProgress?.complete ? 4 : 2), this.lightweightGuideVerified ? 4 : this.lightweightGuideLogin ? 3 : 2);
      page.querySelectorAll<HTMLButtonElement>(".simple-one-sync-lightweight-nav button").forEach((button, index) => {
        button.disabled = this.lightweightGuideBusy || index + 1 > available;
      });
    };
    updateNext();
  }

  private displayDesktopSettings(containerEl: HTMLElement): void {
    const page = containerEl.createDiv({ cls: "simple-one-sync-setup-layout" });
    this.renderDeviceHeader(page, "电脑端 Git 同步");
    const body = this.syncSettingsBody(page, this.plugin.nativeGitEnabled());
    this.displayDesktopAdvanced(body);
  }

  private displayDesktop(containerEl: HTMLElement): void {
    const currentDevice = this.currentDevice();
    new Setting(containerEl).setName("同步设置").setHeading();
    this.addSetupEntry(containerEl, currentDevice === "git");
    const entries = [
      { page: "mobile", title: "轻量 Git 同步", desc: "适用于安卓、iOS，也适用于电脑", icon: "smartphone" }
    ] as const;
    for (const entry of entries) {
      const isCurrent = currentDevice === entry.page;
      const accessible = isCurrent || !Platform.isMobile;
      const button = containerEl.createDiv( {
        cls: `simple-one-sync-page-link simple-one-sync-device-link${accessible ? "" : " is-disabled"}`,
        attr: { "aria-disabled": String(!accessible) }
      });
      setIcon(button.createSpan({ cls: "simple-one-sync-page-link__icon" }), entry.icon);
      const copy = button.createSpan({ cls: "simple-one-sync-page-link__copy" });
      copy.createSpan({ text: entry.title, cls: "simple-one-sync-page-link__title" });
      copy.createSpan({ text: entry.desc, cls: "simple-one-sync-page-link__desc" });
      if (accessible) {
          const active = this.plugin.settings.enabled && this.plugin.useLightweightSync();
          this.addSyncBadges(button, isCurrent, active, async () => {
            await this.plugin.setLightweightSyncEnabled(!active);
            if (!active && !this.plugin.settings.enabled) await this.plugin.setFeatureEnabled(true);
          });
        this.addSettingsArrow(button, entry.page, entry.title);
      }
    }
  }

  private renderDeviceHeader(container: HTMLElement, title: string): void {
    if (this.settingsHost) return; // Simple One supplies the shared header and back button.
    const header = container.createDiv({ cls: "simple-one-sync-page-header" });
    const back = header.createEl("button", { cls: "clickable-icon simple-one-sync-page-back", attr: { type: "button", "aria-label": "返回同步" } });
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
    const body = this.syncSettingsBody(page, this.plugin.useLightweightSync());
    const advanced = renderMobileSettings(body, this.plugin.mobileHost(), false);
    this.performanceSetting(advanced ?? compactSettingsSection(body, "故障排查"));
    if (this.plugin.settings.mobile.mode === "server") this.displayMobile(body);
  }

  private addSetupEntry(parent: HTMLElement, isCurrent: boolean): void {
    const button = parent.createDiv( { cls: `simple-one-sync-page-link simple-one-sync-device-link simple-one-sync-device-link--desktop${isCurrent ? "" : " is-disabled"}`, attr: { "aria-disabled": String(!isCurrent) } });
    setIcon(button.createSpan({ cls: "simple-one-sync-page-link__icon" }), "monitor");
    const copy = button.createSpan({ cls: "simple-one-sync-page-link__copy" });
    copy.createSpan({ text: "电脑端 Git 同步设置", cls: "simple-one-sync-page-link__title" });
    copy.createSpan({ text: "界面、自动同步时间与 Git 设置", cls: "simple-one-sync-page-link__desc" });
    if (!isCurrent) return;
    const active = this.plugin.settings.enabled && this.plugin.nativeGitEnabled();
    this.addSyncBadges(button, isCurrent, active, async () => {
      await this.plugin.setDesktopSyncMode(active ? "off" : "git");
      if (!active && !this.plugin.settings.enabled) await this.plugin.setFeatureEnabled(true);
    });
    this.addSettingsArrow(button, "desktop-settings", "电脑端 Git 同步设置");
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
      this.setupTrustRequired = /detected dubious ownership|unsafe repository|safe\.directory/i.test(messageOf(error));
      this.setupMessage = this.setupTrustRequired
        ? `Git 尚未信任此笔记库：目录所有者与当前用户不一致，可能由迁移电脑、更换系统用户或使用管理员身份创建目录引起。确认来源可信后，可仅将当前路径加入本机 Git 信任列表：${this.plugin.getVaultBasePath()}`
        : explainSetupError(error);
      this.syncSetupProgress(step, this.setupMessage, "error");
      new Notice(`同步：${this.setupMessage}`, 10000);
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
    if (this.setupViewStep !== 3 ||
      !this.setupPreviewReady()) return;
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
        throw new Error("当前设备缺少 Git 或 GitHub CLI，请先安装后重试。");
      }
      if (/not logged (?:in|into)|not authenticated|gh auth login/i.test(raw)) {
        throw new Error("当前 GitHub CLI 中未找到登录状态，请先选择浏览器登录授权或 Token 授权。");
      }
      throw error;
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
      new Notice(`同步：${this.setupMessage}`, 10000);
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
    let tone: "success" | "error" | "disconnected" = "disconnected";
    let title = "当前未连接";
    let description = "尚未完成 GitHub 授权与仓库接入。按下方步骤继续。";
    if (guidedDone) {
      tone = "success";
      title = "接入成功";
      description = "笔记库接入已完成。同步进度、结果和失败原因请查看右侧同步面板。";
    } else if (!this.plugin.settings.enabled) {
      description = "同步已关闭。返回同步首页启用后，再继续同步。";
    } else if (this.setupFailure) {
      tone = "error";
      title = this.setupViewStep <= 2 ? "连接失败" : "接入检查失败";
      description = `上次检查未通过：${formatStatusError(this.setupMessage)}。请在当前步骤重试。`;
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
      const restart = styleActionButton(status.createEl("button", { text: "重新检查或修复接入", attr: { type: "button" } }), "text");
      restart.addEventListener("click", () => {
        void this.runSetup(() => this.plugin.beginSetup(), "已暂停自动 Git 操作，请从第 1 步开始。");
      });
    } else if (this.plugin.settings.setupComplete && !guidedDone) {
      const restart = styleActionButton(status.createEl("button", { text: "从第一步重新检查接入", attr: { type: "button" } }), "text");
      restart.addEventListener("click", () => {
        void this.runSetup(() => this.plugin.beginSetup(), "已暂停自动 Git 操作，请从第 1 步开始。");
      });
    }
    if (!this.plugin.settings.setupComplete && this.plugin.settings.setupBackup && !this.plugin.settings.setupMutationStarted) {
      const cancel = styleActionButton(status.createEl("button", { text: "取消向导，恢复旧同步", attr: { type: "button", "aria-label": "退出向导并恢复之前已配置的自动同步" } }), "text");
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
      guidedDone ? "接入已完成，可回看核验结果或重新检查两端状态。" : "确认接入信息；接入成功后将自动触发一次同步。"
    ];
    if (this.setupViewStep !== 1) {
      new Setting(body).setName(steps[this.setupViewStep - 1]).setHeading();
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
        setActionIcon(copy, "copy", "plain");
        setTooltip(copy, "复制设备码");
        copy.disabled = !this.setupDeviceCode;
        copy.addEventListener("click", () => void navigator.clipboard.writeText(this.setupDeviceCode));
        const refresh = deviceAction.createEl("button", { cls: "simple-one-sync-setup-device-icon-button", attr: { type: "button", "aria-label": "刷新设备码" } });
        setActionIcon(refresh, "refresh-cw", "plain");
        setTooltip(refresh, "刷新设备码");
        refresh.disabled = this.setupBusy;
        refresh.addEventListener("click", () => void this.startSetupBrowserAuthorization());
        new Setting(authCard).addButton((button) => { styleActionButton(button.buttonEl, "text"); return (button.setButtonText("已填写设备码，验证授权").setCta().setDisabled(this.setupBusy || !this.setupDeviceCode).onClick(() =>
          this.verifySetupAuthorization(() => this.plugin.checkSetupAuthorization(), "GitHub 授权已核验。"))); })
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
        new Setting(authCard).addButton((button) => { styleActionButton(button.buttonEl, "text");
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
          new Setting(authCard).addButton((button) => { styleActionButton(button.buttonEl, "text"); return (button.setButtonText("重新验证").setCta().onClick(() =>
            this.verifySetupAuthorization(
              () => this.verifyExistingSetupAuthorization(),
              "已成功，GitHub 授权已核验。"
            ))); })
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
      card.createEl("p", { text: "在已有 GitHub 仓库页面点击「code」，复制 HTTPS 地址并填入下方。" });
      card.createEl("p", { text: "核验会检查仓库是否为私有，以及当前登录账号是否具有写入权限。", cls: "simple-one-sync-setup-helper" });
      const repoUrlSetting = new Setting(card).setName("GitHub 仓库地址").addText((text) => text.setPlaceholder("https://github.com/user/vault.git").setValue(this.setupRepoInput).onChange((value) => { this.setupRepoInput = value.trim(); }));
      repoUrlSetting.settingEl.addClass("simple-one-sync-setup-repo-url");
      new Setting(card).addButton((button) => { styleActionButton(button.buttonEl, "text"); return (button.setButtonText("检查仓库").setCta().setDisabled(this.setupBusy).onClick(() => void this.runSetup(async () => {
        await this.plugin.verifySetupRepository(this.setupRepoInput);
        await this.advanceSetupAfterCheck(2, () => this.setupRepoReady());
      }, "", false))); })
        .settingEl.addClass("simple-one-sync-setup-action", "simple-one-sync-setup-check-action", "simple-one-sync-setup-auth-submit");
    } else {
      card.createEl("p", { text: "填写仓库名称后，插件会在当前 GitHub 账号下创建一个空的 private（私人）仓库。此时不会推送本地文件。" });
      new Setting(card).setName("新仓库名称").addText((text) => text.setPlaceholder("例如 my-Obsidian-vault").setValue(this.setupRepoNameInput).onChange((value) => { this.setupRepoNameInput = value.trim(); })).settingEl.addClass("simple-one-sync-setup-repo-name");
      new Setting(card).addButton((button) => { styleActionButton(button.buttonEl, "text"); return (button.setButtonText("创建私人仓库").setCta().setDisabled(this.setupBusy).onClick(() => void this.runSetup(async () => {
        try { await this.plugin.createSetupRepository(this.setupRepoNameInput); }
        finally { this.setupRepoInput = this.plugin.settings.setupRepoUrl; }
        await this.advanceSetupAfterCheck(2, () => this.setupRepoReady());
      }, "", false))); })
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
    body.addClass("simple-one-sync-check-page");
    body.createEl("p", { text: `当前 Vault：${this.plugin.getVaultBasePath()}`, cls: "simple-one-sync-section-desc" });
    if (this.plugin.settings.setupComplete && !this.plugin.settings.setupVerified) {
      body.createEl("p", { text: "当前连接来自旧版设置，尚未经过此向导核验。使用上方「从第一步重新检查接入」后可查看两端文件。" });
    }
    body.createEl("p", { text: preview && !this.setupBusy && !this.setupFailure ? ["✓ 检查完成", preview.commitSummary, "忽略规则已自动整理"].filter(Boolean).join(" · ") : this.setupMessage, cls: `simple-one-sync-setup-preview-progress ${this.setupFailure ? "simple-one-sync-setup-error" : this.setupMessage.startsWith("✓") ? "simple-one-sync-setup-done" : "simple-one-sync-section-desc"}`, attr: { role: "status", "aria-live": "polite" } });
    if ((!preview || this.setupFailure) && this.plugin.settings.setupStep >= 3 && (this.plugin.settings.setupVerified || this.plugin.settings.setupRepoUrl)) {
      const needsTrust = this.setupFailure && this.setupTrustRequired;
      const actionLabel = needsTrust ? "信任此笔记库并重试" : preview ? "重新检查两端" : "检查两端";
      const action = body.createDiv({ cls: "simple-one-sync-setup-file-check" });
      const check = styleActionButton(action.createEl("button", { text: this.setupBusy ? "正在检查…" : actionLabel, cls: "mod-cta", attr: { type: "button" } }), "text");
      check.disabled = this.setupBusy;
      check.toggleClass("simple-one-sync-trust-action", needsTrust && !this.setupBusy);
      check.addEventListener("click", () => void this.runSetup(async () => {
        if (needsTrust) await this.plugin.trustSetupVault();
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
        this.setupMessage = "✓ 检查完成 · 忽略规则已自动整理";
      }, undefined, false));
    }
    if (!preview) return;
    if (this.setupReviewPreview !== preview) {
      this.setupReviewPreview = preview;
      this.setupFileFilter = "changed";
      this.plugin.setSetupTrackingChoice(undefined);
      this.setupRebuildConfirmed = false;
    }
    if (preview.trackedExcludedLocal.length + preview.trackedExcludedRemote.length) {
      const consent = body.createEl("label", { cls: "simple-preview-checkbox-row" });
      const check = consent.createEl("input", { attr: { type: "checkbox" } });
      check.checked = this.setupRebuildConfirmed;
      consent.createSpan({ text: "我已查看排除清单，确认仅让这些文件退出追踪：本机保留，接入并推送后远端当前版本删除（包括历史根 .gitignore）。" });
      check.addEventListener("change", () => {
        this.setupRebuildConfirmed = check.checked;
        this.plugin.setSetupTrackingChoice(check.checked ? "rebuild" : undefined);
        this.renderSettings();
      });
      this.setupFileList(body, "本机将退出追踪的文件", preview.trackedExcludedLocal);
      this.setupFileList(body, "远端当前版本将移除的文件", preview.trackedExcludedRemote);
    }
    const summary = body.createDiv({ cls: "simple-one-sync-setup-detail" });
    new Setting(summary).setName("两端检查概况").setHeading();
    const overview = summary.createDiv({ cls: "simple-one-sync-setup-overview" });
    const groups: { label: string; value: number; filter?: "local" | "remote" | "changed" }[] = [
      { label: "本机文件", value: preview.localFiles.length },
      { label: "GitHub 文件", value: preview.remoteFiles.length },
      { label: "仅本机", value: preview.localOnly.length, filter: "local" },
      { label: "仅 GitHub", value: preview.remoteOnly.length, filter: "remote" },
      { label: "文件变化", value: preview.relatedHistory ? (preview.changedFiles ?? []).length : preview.overlaps.length, filter: "changed" }
    ];
    for (const group of groups) {
      const item = group.filter
        ? overview.createEl("button", { cls: "simple-one-sync-setup-overview__item is-filter", attr: { type: "button", "aria-pressed": String(this.setupFileFilter === group.filter) } })
        : overview.createDiv({ cls: "simple-one-sync-setup-overview__item" });
      item.createEl("strong", { text: String(group.value) });
      item.createSpan({ text: group.label });
      if (group.filter) {
        if (this.setupFileFilter === group.filter) item.addClass("is-selected");
        item.addEventListener("click", () => { this.setupFileFilter = group.filter!; this.renderSettings(); });
      }
    }
    summary.createEl("p", { text: preview.localRoot ? `本机分支：${preview.localBranch} · GitHub 分支：${preview.branch}` : `当前 Vault 还没有 Git 仓库；完成接入时会创建 ${preview.branch} 分支。`, cls: "simple-one-sync-section-desc" });
    if (preview.localRoot && !preview.relatedHistory && preview.localBranch !== preview.branch) summary.createEl("p", {
      text: `本机已有独立历史，${preview.localBranch} 分支将接入远端 ${preview.branch} 分支，请确认目标仓库。`, cls: "simple-one-sync-section-desc"
    });
    const module = summary.createDiv({ cls: "simple-one-sync-check-results", attr: { "aria-live": "polite" } });
    const files = preview.overlaps.filter(path => path !== ".gitignore");
    const choices = this.plugin.getSetupChoices();
    const selectedPaths = this.setupFileFilter === "local" ? preview.localOnly : this.setupFileFilter === "remote" ? preview.remoteOnly : preview.relatedHistory ? (preview.changedFiles ?? []) : files;
    const selectedLabel = this.setupFileFilter === "local" ? "仅本机" : this.setupFileFilter === "remote" ? "仅 GitHub" : "文件变化";
    module.createEl("p", { text: selectedPaths.length ? `${selectedLabel} · ${selectedPaths.length} 个文件` : `${selectedLabel} · 无文件`, cls: "simple-one-sync-section-desc" });
    renderPathTree(module, selectedPaths, this.setupFileFilter === "local" || this.setupFileFilter === "remote" ? "+" : "M", fileListPanel(module, this.plugin.settings, () => this.plugin.saveSettings()));
    const hasDifferences = (preview.changedFiles ?? []).length > 0 || preview.localOnly.length > 0 || preview.remoteOnly.length > 0 || files.length > 0;
    const bottom = body.createDiv({ cls: "simple-one-sync-check-bottom" });
    bottom.createEl("p", { text: !hasDifferences ? "当前两端没有文件差异。" : preview.relatedHistory ? "以上变化将由 Git 处理，遇到冲突时暂停。" : "请确认同名文件版本。", cls: "simple-one-sync-section-desc" });
    if (files.length && !this.plugin.settings.setupComplete) bottom.createEl("p", { text: `已选择 ${files.filter(path => !!choices[path]).length} / ${files.length} 个版本。` });
    const actions = bottom.createDiv({ cls: "simple-one-sync-check-actions" });
      if (files.length && !this.plugin.settings.setupComplete) {
        const resolve = styleActionButton(actions.createEl("button", { text: "对照并选择文件版本", attr: { type: "button" } }), "text");
        resolve.disabled = this.setupBusy;
        resolve.addEventListener("click", () => {
          new SetupDifferencesModal(this.app, files, choices, path => this.plugin.readSetupOverlap(path), selected => {
            if (this.plugin.getSetupPreview() !== preview) return;
            for (const path of files) this.plugin.setSetupChoice(path, selected[path]);
            this.updateSetupPreviewSelection();
          }, createFileListLayout(this.plugin.settings, () => this.plugin.saveSettings()), (path, side) => this.plugin.readSetupImage(path, side)).open();
        });
      }
      {
        const next = styleActionButton(actions.createEl("button", { text: "下一步：完成接入", cls: "mod-cta", attr: { type: "button" } }), "text");
        next.disabled = this.setupBusy || !this.setupPreviewReady();
        next.addEventListener("click", () => void this.runSetup(() => this.advanceSetupAfterPreview(), "", false));
      }
  }

  private setupPreviewReady(): boolean {
    const preview = this.plugin.getSetupPreview();
    if (!preview) return false;
    const choices = this.plugin.getSetupChoices();
    if (preview.overlaps.some((path) => !choices[path])) return false;
    return !(preview.trackedExcludedLocal.length || preview.trackedExcludedRemote.length) || !!this.plugin.getSetupTrackingChoice();
  }

  private setupFileList(body: HTMLElement, title: string, paths: string[]): void {
    if (paths.length === 0) return;
    const details = body.createEl("details", { cls: "simple-one-sync-setup-files" });
    details.createEl("summary", { text: `${title}（${paths.length}）` });
    renderPathTree(details, paths, "M", fileListPanel(body, this.plugin.settings, () => this.plugin.saveSettings()));
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
    const ignoreSummary = "根 .gitignore 仅本机保留，接入前原规则保留在原规则区；不会合并云端规则。历史追踪迁移按已确认的删除清单处理。";
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
      .addText((text) => text.setPlaceholder(DEFAULT_GIT_AUTHOR_NAME).setValue(this.plugin.settings.gitAuthorName === DEFAULT_GIT_AUTHOR_NAME ? "" : this.plugin.settings.gitAuthorName).onChange(async (value) => {
        this.plugin.settings.gitAuthorName = value.trim();
        await this.plugin.saveSettings();
      }));
    authorNameSetting.settingEl.addClass("simple-one-sync-setup-author-setting");
    const authorEmailSetting = new Setting(body).setName("提交作者邮箱").setDesc("用于 Git 提交记录，不是登录密码。")
      .addText((text) => text.setPlaceholder(DEFAULT_GIT_AUTHOR_EMAIL).setValue(this.plugin.settings.gitAuthorEmail === DEFAULT_GIT_AUTHOR_EMAIL ? "" : this.plugin.settings.gitAuthorEmail).onChange(async (value) => {
        this.plugin.settings.gitAuthorEmail = value.trim();
        await this.plugin.saveSettings();
      }));
    authorEmailSetting.settingEl.addClass("simple-one-sync-setup-author-setting");
    if (preview.overlaps.length) this.setupFileList(body, "已选择远端版本的同名文件", preview.overlaps.filter((path) => this.plugin.getSetupChoices()[path] === "remote"));
    const finished = this.setupFinishedPreview === preview;
    if (finished) {
      body.createEl("p", { text: "✓ 接入成功。同步进度与结果请查看右侧同步面板，无需再次接入。", cls: "simple-one-sync-setup-done simple-one-sync-finish-success", attr: { role: "status" } });
    }
    if (this.setupBusy || this.setupFailure) {
      body.createEl("p", {
        text: this.setupBusy ? "正在完成接入，请稍候…" : this.setupMessage,
        cls: `simple-one-sync-setup-finish-progress ${this.setupFailure ? "simple-one-sync-setup-error" : "simple-one-sync-setup-feedback"}`,
        attr: { role: "status", "aria-live": "polite" }
      });
    }
    if (!finished) {
      const footer = body.createDiv({ cls: "simple-one-sync-setup-footer simple-one-sync-check-actions" });
      const needsTrust = this.setupFailure && this.setupTrustRequired;
      const finish = styleActionButton(footer.createEl("button", { text: this.setupBusy ? "正在完成接入…" : needsTrust ? "信任此笔记库并重试" : this.plugin.settings.setupComplete ? "应用接入设置" : "确认完成接入", cls: "mod-cta", attr: { type: "button" } }), "text");
      finish.toggleClass("simple-one-sync-trust-action", needsTrust && !this.setupBusy);
      finish.disabled = this.setupBusy || (this.plugin.getSetupTrackingChoice() === "rebuild" && !this.setupRebuildConfirmed);
      finish.addEventListener("click", () => void this.runSetup(async () => { if (needsTrust) await this.plugin.trustSetupVault(); await this.plugin.finishSetup(this.setupRebuildConfirmed, (message, error) => {
        if (this.desktopPage !== "setup" || this.setupViewStep !== 4) return;
        this.setupMessage = message;
        const progress = (this.settingsHost ?? this.containerEl).querySelector(".simple-one-sync-setup-finish-progress");
        if (progress) {
          progress.textContent = message;
          progress.toggleClass("simple-one-sync-setup-error", !!error);
          progress.toggleClass("simple-one-sync-setup-feedback", !error);
        }
      }); this.setupFinishedPreview = preview; }, "接入成功，同步进度与结果请查看右侧同步面板。"));
    }
  }

  private performanceSetting(container: HTMLElement): void {
    const name = "记录同步性能详情";
    const setting = new Setting(container).setName(name)
      .setDesc("同时适用于轻量同步与完整同步。开启后记录各步骤耗时及文件数；关闭时只保存简单同步记录。");
    setting.settingEl.addClass("simple-sync-checkbox-row");
    const input = setting.settingEl.createEl("input", { type: "checkbox", attr: { "aria-label": name } });
    input.checked = this.plugin.settings.recordSyncPerformance === true;
    setting.settingEl.prepend(input);
    setting.nameEl.addEventListener("click", () => input.click());
    input.addEventListener("change", () => void (async () => {
      this.plugin.settings.recordSyncPerformance = input.checked;
      await this.plugin.saveSettings();
    })().catch(error => new Notice(`保存性能记录设置失败：${messageOf(error)}`)));
  }

  private displayDesktopAdvanced(containerEl: HTMLElement): void {
    containerEl.addClass("simple-desktop-git-settings");
    const preview = this.currentDevice() !== "git";
    const section = (title: string): HTMLElement => {
      const card = compactSettingsSection(containerEl, title);
      card.addClass("simple-one-sync-advanced__body");
      return card;
    };
    let advancedBody = section("自动备份与更新");
    const startup = (name: string, desc: string, key: "pullOnStartup" | "backupOnStartup", other: "pullOnStartup" | "backupOnStartup"): HTMLInputElement => {
      const setting = new Setting(advancedBody).setName(name).setDesc(desc);
      setting.settingEl.addClass("simple-sync-checkbox-row");
      const input = setting.settingEl.createEl("input", { type: "checkbox", attr: { "aria-label": name } });
      input.checked = this.plugin.settings[key];
      setting.settingEl.prepend(input);
      setting.nameEl.addEventListener("click", () => input.click());
      input.addEventListener("change", () => void (async () => {
        this.plugin.settings[key] = input.checked;
        if (input.checked) {
          this.plugin.settings[other] = false;
          (key === "pullOnStartup" ? backup : pull).checked = false;
        }
        await this.plugin.saveSettings();
      })().catch(error => new Notice(`保存启动同步设置失败：${messageOf(error)}`)));
      return input;
    };
    const pull = startup("启动时获取云端更新", "启动后先获取云端更新，本机改动按下方备份时间上传。与下一项互斥。", "pullOnStartup", "backupOnStartup");
    const backup = startup("启动时获取云端更新并备份", "启动后先获取云端更新，再备份本机改动。与上一项互斥。", "backupOnStartup", "pullOnStartup");
    new Setting(advancedBody)
      .setName("检查云端更新间隔（分钟）")
      .setDesc("每隔多久检查云端更新并下载。填 0 关闭定时检查。")
      .addText((text) => this.addTimingInput(text, "autoPullIntervalMinutes", 5));
    new Setting(advancedBody)
      .setName("停止修改后备份（分钟）")
      .setDesc("停止修改多久后自动备份。填 0 关闭。")
      .addText((text) => this.addTimingInput(text, "autoCommitIdleMinutes", 30));
    new Setting(advancedBody)
      .setName("连续修改时备份（分钟）")
      .setDesc("持续修改时，每隔多久自动备份。填 0 关闭。")
      .addText((text) => this.addTimingInput(text, "maxUncommittedMinutes", 60));

    advancedBody = section("Git 上传设置");
    new Setting(advancedBody).setName("仓库地址")
      .setDesc("电脑端 Git 同步使用的远程仓库地址。")
      .addText(text => text.setPlaceholder("https://github.com/用户名/仓库.git")
        .setValue(this.plugin.settings.gitRemoteUrl).onChange(async value => {
          this.plugin.settings.gitRemoteUrl = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(advancedBody)
      .setName("上传分支")
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
    this.performanceSetting(advancedBody);
    new Setting(advancedBody).setName("重建忽略规则与 Git 追踪").setClass("mod-action").setClass("simple-setting-icon-action")
      .setDesc("预览 .gitignore 的变化，以及由此取消或新增追踪的文件；已删除文件由正常同步处理。确认后只暂存差异，不提交或推送。")
      .addButton((button) => button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("play").setTooltip("重建忽略规则与 Git 追踪").setDisabled(preview).onClick(async () => {
        button.setDisabled(true);
        button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("loader-circle").setTooltip("正在检查…");
        try {
          const result = await this.plugin.inspectFileTracking();
          new FileTrackingModal(this.app, this.plugin, result).open();
        } catch (error) {
          new Notice(`同步：无法检查文件追踪。${messageOf(error)}`, 10000);
        } finally {
          button.setDisabled(false);
          button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("play").setTooltip("重建忽略规则与 Git 追踪");
        }
      }));
    new Setting(advancedBody)
      .setName("检查并修复未完成的 Git 操作").setClass("mod-action").setClass("simple-setting-icon-action")
      .setDesc("清理索引锁或修复中断的 Git 操作。操作前会弹窗确认。")
      .addButton((button) =>
        button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("play").setTooltip("检查并修复未完成的 Git 操作").setDisabled(preview).onClick(async () => {
          button.setDisabled(true);
          button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("loader-circle").setTooltip("正在检查…");
          try {
            const operation = await this.plugin.getInterruptedGitOperationLabel();
            if (!operation) {
              new Notice("同步：没有检测到索引锁或未完成的 rebase、merge、cherry-pick、revert");
              return;
            }
            new GitRepairModal(this.app, this.plugin, operation).open();
          } catch (error) {
            new Notice(`同步：无法检查 Git 状态。${messageOf(error)}`, 10000);
          } finally {
            button.setDisabled(false);
            button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("play").setTooltip("检查并修复未完成的 Git 操作");
          }
        })
      );
    new Setting(advancedBody)
      .setName("预览清理本地旧历史（保留近 30 天）").setClass("mod-action").setClass("simple-setting-icon-action")
      .setDesc("默认保留最近 30 天的本地历史。先联网确认当前 commit 已上传，再清理本机旧历史；不会删除 GitHub 上的版本。")
      .addButton((button) =>
        button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("play").setTooltip("检查并预览旧历史清理").setDisabled(preview).onClick(async () => {
          button.setDisabled(true);
          button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("loader-circle").setTooltip("正在核验…");
          try {
            const result = await this.plugin.inspectLocalHistory();
            new LocalHistorySlimModal(this.app, this.plugin, result).open();
          } catch (error) {
            new Notice(`同步：无法预览本地历史。${messageOf(error)}`, 12000);
          } finally {
            button.setDisabled(false);
            button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("play").setTooltip("检查并预览旧历史清理");
          }
        })
      );
    const logs = this.plugin.getRecentErrorLogs();
    const errorCount = logs.filter((entry) => entry.status !== "success").length;
    new Setting(advancedBody).setClass("mod-action").setClass("simple-setting-icon-action")
      .setName(errorCount > 0 ? `同步与分享日志（${errorCount} 条错误）` : "查看最近 24 小时同步与分享日志")
      .setDesc(
        errorCount > 0
          ? `最近 24 小时共 ${logs.length} 条记录，其中 ${errorCount} 条错误。`
          : `最近 24 小时共 ${logs.length} 条记录，没有错误。`
      )
      .addButton((button) =>
        button.setClass("simple-action-button").setClass("simple-action-button--bordered").setIcon("play").setTooltip("查看同步与分享日志").onClick(() => new ErrorLogModal(this.app, this.plugin).open())
      );
    for (const row of Array.from(containerEl.querySelectorAll<HTMLElement>(".simple-one-sync-advanced__body > .setting-item"))) {
      const description = row.querySelector<HTMLElement>(".setting-item-description");
      if (description?.textContent) row.setAttribute("aria-label", description.textContent);
      const input = row.querySelector<HTMLInputElement>("input[type=number], input[type=text]");
      if (input && row.getAttribute("aria-label")) input.setAttribute("aria-label", row.getAttribute("aria-label")!);
    }

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
