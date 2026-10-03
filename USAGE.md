# Simple One — User Guide

[Plugin overview](README.md) | English guide | [中文使用说明](USAGE.zh-CN.md)

Simple One is an Obsidian plugin for formatting notes, capturing webpages, managing daily notes, syncing your vault, and sharing selected notes online. Enable only the tools you need. The settings interface is currently in Chinese; the labels below help you find each tool.

## Install and get started

1. In Obsidian, open **Settings → Community plugins**, search for **Simple One**, and install it.
2. Enable the plugin, then open **Settings → Simple One**.
3. Turn on the features you want and configure their options.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/ZO00OEY/simple-one/releases) and place them in your vault's `.obsidian/plugins/simple-one/` folder. Keep your existing `data.json` when upgrading.

## Sync your vault

Open **功能拓展 → 同步与分享** in Simple One settings. Choose a setup assistant:

| Option | Choose it when… | Start here |
| --- | --- | --- |
| Full Git sync | You use a computer and want vault backups and Git history. | **电脑端同步引导** |
| Lightweight sync | You use Android or iOS, or want to sync on a computer without installing Git. | **轻量同步引导** |

Follow the assistant to sign in, create or connect a repository, and review which files to sync. Desktop Git setup guides you through the required tools. After setup, use **同步设置** to adjust automatic backups, remote updates, or the lightweight mode's file and plugin choices.

The **当前应用** badge shows the mode you are actually using. Mobile background sync depends on your operating system. If you previously used Simple Link, disable its sync before enabling Simple One sync.

## Share a note online

Keep editing in your current vault and publish only the notes you choose. Sharing setup and publishing are available on desktop; anyone can read the website on a computer or phone.

1. Open **功能拓展 → 同步与分享 → 笔记分享引导**.
2. Complete authorization, create or connect a separate public GitHub repository, and initialize the website.
3. Open a note and click its share icon, or run **分享此笔记** from the command palette.
4. Send the copied note name and website link to the reader.

Use the sharing sidebar to find shared notes, copy links, change their public names and categories, or cancel sharing. Click **推送新分享** to publish pending changes, including edits and withdrawals. Renaming or moving a note keeps its sharing link.

The sidebar can show a flat list, your vault folders, or public categories. Its settings let you show paths and withdrawn notes. In **笔记分享设置**, use **检查网站部署** if the website has not caught up with your latest push.

The reader supports collapsible headings, Callouts, formulas, Mermaid, and Simple One columns. Under **笔记分享设置 → 界面设置**, you can import or export an HTML template, or restore the default. Push again to apply a template change. Custom templates must retain the reader's required elements and script references.

Shared notes and their included attachments are public, with no password protection. Withdrawal removes a note from the current website but does not erase repository history or copies others have saved. Themes and plugin content may look different online.

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
