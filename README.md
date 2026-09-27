# Simple Plugin

Simple Plugin brings everyday note tools into one Obsidian plugin: formatting, URL handling, diary and calendar views, website-to-note actions, display controls, and attachment review. Its settings interface is currently in Chinese.

## What it does

| Area | Available tools |
| --- | --- |
| Writing and links | Reformat the current note or pasted text with configurable rules; process a pasted URL or Obsidian link; copy the current note's link or path. URL paste processing and reformatting are separate settings. |
| Quick formatting | Add a note-title button and quick menu for formatting actions. |
| Diary and calendar | Create daily notes, carry forward unfinished tasks, manage recurring reminders, anniversaries, and imported holiday schedules. Choose a heading or callout for written reminders. |
| Website to note | Create notes from a URL or search supported sites using editable extraction rules and output folders. |
| Reading and display | Preview colors and HTML, zoom images, adjust image height and readable width, interact with Mermaid diagrams, and create two-column content. |
| Vault utilities | Filter native search by folder, fill properties for new notes from a selected Base view, and review attachment cleanup or organization actions. |

Each area can be configured under **Settings → Simple Plugin**. Some settings require an Obsidian restart; the relevant setting says so.

## Get started

1. Install the plugin using the instructions below and enable it in **Settings → Community plugins**.
2. Open **Settings → Simple Plugin**. Enable only the features you want.
3. For diary features, check the daily-note folder, filename pattern, and template before creating a note. On first load, the plugin adopts Obsidian's core Daily notes settings when available.
4. For website-to-note features, choose an output folder and review the site's extraction rules. Built-in categories otherwise start with the vault root as their output location.
5. For attachment tools, set Obsidian's attachment location to a dedicated folder in **Settings → Files and links**. If attachments currently go to the vault root, the plugin offers a **Quick configuration** button that sets the destination to `Attachment` for new files; it does not move existing files. Open **Attachment optimization** in the plugin settings and review the proposed actions before applying them. Attachment scanning and cleanup are disabled when the attachment location is the vault root or cannot be identified safely.

### Install manually

Download `main.js`, `manifest.json`, and `styles.css` from the same [release](https://github.com/ZO00OEY/simple-plugin/releases). Place all three in your vault's `.obsidian/plugins/simple-plugin/` folder, then enable **Simple Plugin** under **Settings → Community plugins**. The folder name must match the plugin ID `simple-plugin`.

## Data and network access

- Settings and any data you enter into them are stored locally by Obsidian in `.obsidian/plugins/simple-plugin/data.json`. The file is excluded from this repository and its releases. Back it up privately if you need to keep your configuration.
- When the corresponding features are enabled or used, the plugin reads and changes notes or attachments in the current vault. Attachment cleanup presents a review list before moving selected files to Obsidian's trash.
- URL-title lookup and website-to-note actions can request a URL you supply or a selected website. Built-in rules include sites such as Jinjiang, 52shuku, Fanqie, and Qidian. A site search sends its query to that site. Some desktop extraction fallbacks open the selected site in a hidden webview; Fanqie's fallback may use that site's cookies for a request to its own API. These fallbacks may not work on mobile.
- The plugin has no analytics or plugin-operated server. Network requests for the above actions go to the relevant websites; vault contents are not sent to a server run by this plugin.

## 中文使用提示

- 在 **设置 → 第三方插件 → Simple Plugin** 中按需启用功能。需要重启的选项会在设置中注明。
- **快速排版**的“URL 粘贴设置”和“重排版设置”分别控制粘贴链接、手动或粘贴时的重排版。文本中的 URL 自动转链接默认关闭。
- **日历与日记**可以设置自动提醒写入 Callout 或自定义级别的标题，并分别控制纪念日、假期安排的日历显示和日记提醒。
- 使用**附件优化**前，先在 Obsidian 的“文件与链接”中指定专用附件文件夹。附件位置为仓库根目录时，插件会禁用扫描和整理功能；清理操作会先显示待处理清单。
- 网址转笔记的预设输出目录初始可能是仓库根目录，请按自己的分类习惯修改。

## Build from source

Requires Node.js and npm:

```sh
npm ci
npm run build
```

The build checks TypeScript and writes `main.js`. Keep `main.js`, `manifest.json`, and `styles.css` together for a release. Never commit `data.json`, vault notes, or Obsidian workspace settings.

## License

The plugin source is available under the [MIT License](LICENSE). Bundled dependencies have their own notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
