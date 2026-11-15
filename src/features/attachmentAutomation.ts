import { TFile, TFolder, type TAbstractFile } from "obsidian";
import type SimplePlugin from "../main";
import { checkUnusedAttachments, planAttachmentImageRename, planAttachmentOrganization, planInlineImageExtraction, registerAttachmentCleanupGuard } from "./attachmentOrganizer";

const KEYS = ["autoCleanAttachments", "autoOrganizeImages", "autoOrganizeAttachments", "autoExtractInlineImages"] as const;

/** Debounce edits, serialize writes, and wait for Obsidian's reference cache. */
export function registerAttachmentAutomation(plugin: SimplePlugin): () => void {
  const { vault, metadataCache, workspace } = plugin.app;
  const pending = new Set<string>();
  const unreferenced = new Map<string, { since: number; stamp: string }>();
  const noteReferences = new Map<string, string[]>();
  const deletedNoteAttachments = new Set<string>();
  const rememberReferences = () => {
    noteReferences.clear();
    for (const [path, links] of Object.entries(metadataCache.resolvedLinks)) {
      if (path.endsWith(".md")) noteReferences.set(path, Object.keys(links));
    }
  };
  let timer: number | undefined;
  let disposed = false, ready = false, resolved = false, running = false, full = false, cleanupDue = false;
  registerAttachmentCleanupGuard(plugin, () => !disposed && ready && resolved);
  let previous = KEYS.map(key => Boolean(plugin.settings[key]));
  let previousImageMode = plugin.settings.imageAttachmentFolderMode;
  let previousAttachmentMode = plugin.settings.attachmentFolderMode;
  const enabled = () => !disposed && KEYS.some(key => plugin.settings[key]);
  const active = (key: typeof KEYS[number]) => () => !disposed && Boolean(plugin.settings[key]);
  const schedule = () => {
    if (!enabled() || !ready) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = undefined; void run(); }, 10_000);
  };
  const attempt = async (action: () => Promise<void>) => {
    try { await action(); } catch (error) { console.error("Simple One attachment automation:", error); }
  };
  const run = async () => {
    if (!enabled() || running || !resolved) return;
    running = true;
    const all = full;
    full = false;
    const paths = new Set(pending);
    pending.clear();
    const notes = [...paths].map(path => vault.getAbstractFileByPath(path))
      .filter((file): file is TFile => file instanceof TFile && file.extension === "md");
    for (const note of notes) {
      for (const path of Object.keys(metadataCache.resolvedLinks[note.path] ?? {})) paths.add(path);
    }
    try {
      if (plugin.settings.autoExtractInlineImages && (all || notes.length)) {
        await attempt(() => planInlineImageExtraction(plugin, {
          active: active("autoExtractInlineImages"), notes: all ? undefined : notes,
        }));
      }
      if (plugin.settings.autoOrganizeImages && (all || paths.size)) {
        await attempt(() => planAttachmentImageRename(plugin, {
          active: active("autoOrganizeImages"), paths: all ? undefined : paths,
        }));
      }
      if (plugin.settings.autoOrganizeAttachments && (all || paths.size)) {
        await attempt(() => planAttachmentOrganization(plugin, {
          active: active("autoOrganizeAttachments"), paths: all ? undefined : paths,
        }));
      }
      if (plugin.settings.autoCleanAttachments && cleanupDue && resolved
        && vault.getMarkdownFiles().every(file => metadataCache.getFileCache(file))) {
        cleanupDue = false;
        const seen = new Set<string>();
        const deletedCandidates = new Set(deletedNoteAttachments);
        let completed = false;
        await attempt(async () => {
          await checkUnusedAttachments(plugin, {
            deletedNoteAttachments: deletedCandidates,
            active: () => active("autoCleanAttachments")() && resolved,
            canDelete: (file: TFile | TFolder) => {
              seen.add(file.path);
              const now = Date.now();
              const stamp = file instanceof TFile ? `${file.stat.mtime}:${file.stat.size}` : "folder";
              const first = unreferenced.get(file.path);
              if (!first || first.stamp !== stamp) {
                unreferenced.set(file.path, { since: now, stamp });
                return false;
              }
              // Allow pasted files time to acquire references; require two stable scans.
              return now - first.since >= 60_000 && (!(file instanceof TFile) || now - file.stat.mtime >= 300_000);
            },
          });
          completed = true;
        });
        if (completed) {
          for (const path of unreferenced.keys()) if (!seen.has(path)) unreferenced.delete(path);
          for (const path of deletedCandidates) if (!seen.has(path) || !vault.getAbstractFileByPath(path)) deletedNoteAttachments.delete(path);
        }
      }
    } finally {
      running = false;
      if (pending.size || full) schedule();
    }
  };
  const changed = (file: TAbstractFile) => {
    if (file instanceof TFile && file.extension === "md") resolved = false;
    if (!enabled()) return;
    if (file instanceof TFile) {
      pending.add(file.path);
    }
    schedule();
  };
  plugin.registerEvent(vault.on("create", changed));
  plugin.registerEvent(vault.on("modify", changed));
  plugin.registerEvent(vault.on("rename", changed));
  plugin.registerEvent(vault.on("delete", (file) => {
    if (file instanceof TFile && file.extension === "md") {
      if (plugin.settings.autoCleanAttachments) {
        for (const path of noteReferences.get(file.path) ?? Object.keys(metadataCache.resolvedLinks[file.path] ?? {})) {
          deletedNoteAttachments.add(path);
        }
        cleanupDue = true;
      }
      noteReferences.delete(file.path);
    }
    changed(file);
  }));
  plugin.registerEvent(metadataCache.on("resolved", () => {
    resolved = true;
    rememberReferences();
    if (pending.size || full || cleanupDue) schedule();
  }));
  workspace.onLayoutReady(() => {
    if (disposed) return;
    ready = true;
    resolved = vault.getMarkdownFiles().every(file => Boolean(metadataCache.getFileCache(file)));
    rememberReferences();
    full = enabled();
    cleanupDue = full;
    schedule();
  });
  const interval = window.setInterval(() => {
    if (!plugin.settings.autoCleanAttachments || disposed) return;
    cleanupDue = true;
    schedule();
  }, 60_000);
  plugin.register(() => {
    disposed = true;
    window.clearInterval(interval);
    if (timer !== undefined) window.clearTimeout(timer);
    pending.clear();
    unreferenced.clear();
    noteReferences.clear();
    deletedNoteAttachments.clear();
  });
  return () => {
    const current = KEYS.map(key => Boolean(plugin.settings[key]));
    if (current.some((value, index) => value && !previous[index])) full = true;
    if (plugin.settings.autoOrganizeImages && previousImageMode !== plugin.settings.imageAttachmentFolderMode) full = true;
    if (plugin.settings.autoOrganizeAttachments && previousAttachmentMode !== plugin.settings.attachmentFolderMode) full = true;
    previous = current;
    previousImageMode = plugin.settings.imageAttachmentFolderMode;
    previousAttachmentMode = plugin.settings.attachmentFolderMode;
    if (!plugin.settings.autoCleanAttachments) {
      unreferenced.clear();
      deletedNoteAttachments.clear();
    }
    cleanupDue = Boolean(plugin.settings.autoCleanAttachments);
    if (!enabled()) {
      full = false;
      pending.clear();
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    } else schedule();
  };
}
