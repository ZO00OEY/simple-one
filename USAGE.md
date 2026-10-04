# Simple One — User Guide

[Plugin overview](README.md) | English guide | [中文使用说明](USAGE.zh-CN.md)

Simple One is an Obsidian plugin for formatting notes, capturing webpages, managing daily notes, syncing your vault, and sharing selected notes online. Enable only the tools you need. The settings interface is currently in Chinese; the labels below help you find each tool.

## Install and get started

1. In Obsidian, open **Settings → Community plugins**, search for **Simple One**, and install it.
2. Enable the plugin, then open **Settings → Simple One**.
3. Turn on the features you want and configure their options.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the same version in [Releases](https://github.com/ZO00OEY/simple-one/releases) and place them in your vault's `.obsidian/plugins/simple-one/` folder. Keep your existing `data.json` and custom templates when upgrading. The plugin restores missing `default.html` and `reader-licenses.txt` from its bundled copy without a separate download.

## Sync your vault

Open **功能拓展 → 同步与分享** in Simple One settings. Choose a setup assistant:

| Option | Choose it when… | Start here |
| --- | --- | --- |
| Full Git sync | You use a computer and want vault backups and Git history. | **电脑端同步引导** |
| Lightweight sync | You use Android or iOS, or want to sync on a computer without installing Git. | **轻量同步引导** |

Follow the assistant to sign in, create or connect a repository, and review which files to sync. Desktop Git setup guides you through the required tools. After setup, use **同步设置** to adjust automatic backups, remote updates, or the lightweight mode's file and plugin choices.

Full Git mode has separate startup switches for fetching updates and backing up to the cloud. Fetching is enabled by default; startup backup is disabled. With both enabled, fetch and merge first, then commit local edits and upload. A deferred or failed merge stops that startup backup. Disabling startup backup leaves the timed backup rules active: 30 idle minutes or at most 60 minutes of continuous editing by default.

The **当前应用** badge shows the mode you are actually using. Mobile background sync depends on your operating system. If you previously used Simple Link, disable its sync before enabling Simple One sync.

On first setup or when differences need review, choose to merge both sides, mirror the cloud, mirror local files, or customize each difference. Review the final transfer and deletion lists before executing; mirroring can delete files unique to the other side within the sync scope.

During initial setup or rejoining after a reset, when downloads exceed 1,000 files, or at least 100 files make up 50% of the final in-scope file count, cloud updates finish first and a saved download task lets you choose automatic download or manual archive import. After closing or restarting Obsidian, use the red triangle in the sync sidebar toolbar to resume. Private archive links require signing into an authorized GitHub account in your browser.

Import a ZIP, or select an extracted repository folder if your system supports folder selection. ZIP input is read in small chunks; required files are verified and staged on disk before the confirmed plan is applied. Unselected plugins, credentials, and private Obsidian settings are protected. Individual files still have a 96 MiB processing limit. A wrong snapshot, missing content, or newly edited local target stops the import and preserves the previous baseline.

The task stays until file application, verification, and baseline persistence all succeed. Failure or newly edited local targets keep it visible. Expand the reset-progress section to explicitly clear the task and staging progress; the last completed baseline, uploaded files, imported files, and new edits are preserved.

Lightweight settings also offer a troubleshooting action to clear every baseline and restart whole-vault import. Confirmation clears baselines, caches, and unfinished progress while preserving actual files, repository binding, and sync rules, then opens a fresh full-vault review. This differs from resetting download progress, which preserves the last completed baseline.

Smaller initial batches can still use a repository archive, with individual-download fallback on failure. After establishing a baseline, everyday synchronization downloads individual files through the API and no longer prompts for whole-vault import. The former 64 MiB total ZIP cutoff has been removed.

## Share a note online

Keep editing in your current vault and publish only the notes you choose. Desktop prefers GitHub CLI; mobile and desktops without CLI use a locally saved GitHub Token through the API. Saving API authorization requires Obsidian 1.11.4 or later.

Publishing does not clone or synchronize a local share repository. Each run generates all enabled notes, referenced attachments, directories, and the HTML template from `share-manifest.json`, then compares Git blob hashes with the live remote tree. Unchanged files are not uploaded, and an unchanged target creates no commit. Deletions are limited to previously managed files explicitly withdrawn or replaced; other repository files are preserved. Missing source notes or attachments stop publication. Retrying regenerates the target and checks the actual remote result without synchronizing baselines or recovery state. Local `share-local.json` holds deployment commits, an unconfirmed commit, and published metadata for the sidebar.

1. Open **功能拓展 → 同步与分享 → 笔记分享引导**.
2. Complete authorization, create or connect a separate public GitHub repository, and initialize the website.
3. Open a note and click its share icon, or run **分享此笔记** from the command palette.
4. Send the copied note name and website link to the reader.

At the sidebar's top left, the accent-colored **推送新分享** button includes a cloud-upload icon and publishes all pending shares, content edits, directory moves, and deletions. Website, layout, sorting, and settings controls sit at the top right. Below the search field, only batch-directory and deletion-mode controls remain. The folder button reveals checkboxes. Save the selected destination, then use the top push button to publish. Individual rows offer original-note location and link copying. Right-click a row to edit its public directory and filename. Moving notes preserves their fixed sharing links.

Deletion mode requires selecting notes and confirming deletion. It removes public copies while preserving original vault notes. Display settings control the original-note location button and batch-directory button.

Filter through search, then select all, invert, or clear the selection. Moving is enabled only with selected notes. The folder picker offers **全部** (vault and share-library folders) and **专门分享库** (share-library folders only). Its top-right **新建** button creates a share-library folder beneath the current destination. Confirm with **移动到此**; without a chosen destination, each public copy follows its original note's directory. Push to apply the saved mapping to the cloud.

Directory mappings use the existing vault file `.obsidian/plugins/simple-one/share-manifest.json`: `directories` maps codes to paths, for example `{"writing":"写作/人物"}`, and each note's `directoryCode` references its destination. The next publish relocates copies to `notes/<directory>/<share ID>.md`, removes the previous paths, and updates the website catalog. The private manifest, including original vault paths, is not published.

The sidebar can show a flat list, your vault folders, or public categories. Its settings control paths, original-note location buttons, and batch-directory buttons. In **笔记分享设置**, use **检查网站部署** if the website has not caught up with your latest push.

The reader supports collapsible headings, Callouts, formulas, Mermaid, and Simple One columns. Under **笔记分享设置 → 界面设置**, you can import or export an HTML template, or restore the default. Push again to apply a template change. Custom templates must retain the reader's required elements and script references.

Shared notes and their included attachments are public, with no password protection. Deleting a share removes it from the current website but does not erase repository history or copies others have saved. Themes and plugin content may look different online.

## Everyday note tools

| Tool in settings | How to use it |
| --- | --- |
| **快速设置文本格式** | Select text or place the cursor on a line, then use the note-header action to apply a heading, quote, or Callout. |
| **快速排版** | Configure cleanup rules, then use the note-header action to tidy a note. You can also configure pasted-link titles and formatting. |
| **新建快速笔记** | Choose an output folder and website rule, then open the capture view and provide a URL. |
| **日历与日记** | Set your daily-note folder and template, then open the calendar to create notes and review tasks or reminders. |
| **附件优化** | Set an attachment folder first, scan your files, and review the list before renaming, moving, or deleting attachments. |
| **显示增强** | Adjust text width and image size, enable columns, enlarge images, and preview HTML, colors, or diagrams. |
| **快速复制当前笔记链接** | On desktop, use the note-header copy action; right-click to choose a note link or file path. |
| **搜索与属性补齐** | Exclude folders from search or configure new-note properties with Notebook Navigator and a Base. |

For columns, assign a shortcut in **Obsidian Settings → Hotkeys** if you want one. Desktop and mobile display options can be adjusted separately. Some switches take effect after reloading the plugin. Attachment deletion follows your Obsidian trash preference.

## Help and license

Report problems or suggestions through [GitHub Issues](https://github.com/ZO00OEY/simple-one/issues). Include your Obsidian version, device, theme, and steps to reproduce the problem.

Simple One has no analytics. Web capture visits the sites you request; sync and sharing use the repository or server you configure.

[MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

The share website reads its selected HTML template from the plugin directory on each publish. The built-in template is `default.html`; a compressed copy in `main.js` restores it if missing, so community-plugin installation works without extra files or downloads. Existing HTML is preserved. Replacing it takes effect on the next publish without rebuilding the plugin. Development builds regenerate this file from `src/features/share/reader/default.html`.

Imported templates are saved as `custom-name.html` (with a suffix for duplicate names) and can be selected from the HTML template dropdown. Restoring the default preserves custom files. Legacy `share-template.html` remains a custom template; select the default after upgrading to use the new default reader. Preserve edited HTML and custom templates when copying the plugin; missing defaults are restored automatically. Publishing fills only the appearance slot and preserves the selected template's own script and styles.
