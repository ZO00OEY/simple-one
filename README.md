# Simple One

Simple One brings everyday note tools into one Obsidian plugin: formatting, URL handling, diary and calendar views, website-to-note actions, display controls, and attachment review. Its settings interface is currently in Chinese.

## What it does

| Area | Available tools |
| --- | --- |
| Writing and links | Reformat the current note or pasted text with configurable rules; process a pasted URL or Obsidian link; copy the current note's link or path. URL paste processing and reformatting are separate settings. |
| Quick formatting | Add a note-title button and quick menu for formatting actions. |
| Diary and calendar | Create daily notes, carry forward unfinished tasks, manage recurring reminders, anniversaries, and imported holiday schedules. Choose a heading or callout for written reminders. |
| Website to note | Create notes from a URL or search supported sites using editable extraction rules and output folders. |
| Reading and display | Preview colors and HTML, zoom images, adjust image height and readable width, interact with Mermaid diagrams, and create two-column content. |
| Vault utilities | Filter native search by folder, fill properties for new notes from a selected Base view, and review attachment cleanup or organization actions. |

Each area can be configured under **Settings → Simple One**. Some settings require an Obsidian restart; the relevant setting says so.

## Get started

1. Install the plugin using the instructions below and enable it in **Settings → Community plugins**.
2. Open **Settings → Simple One**. Enable only the features you want.
3. For diary features, check the daily-note folder, filename pattern, and template before creating a note. On first load, the plugin adopts Obsidian's core Daily notes settings when available.
4. For website-to-note features, choose an output folder and review the site's extraction rules. Built-in categories otherwise start with the vault root as their output location.
5. For attachment tools, set Obsidian's attachment location to a dedicated folder in **Settings → Files and links**. If attachments currently go to the vault root, the plugin offers a **Quick configuration** button that sets the destination to `Attachment` for new files; it does not move existing files. Open **Attachment optimization** in the plugin settings and review the proposed actions before applying them. Attachment scanning and cleanup are disabled when the attachment location is the vault root or cannot be identified safely.

### Install manually

Download `main.js`, `manifest.json`, and `styles.css` from the same [release](https://github.com/ZO00OEY/simple-plugin/releases). Place all three in your vault's `.obsidian/plugins/simple-one/` folder, then enable **Simple One** under **Settings → Community plugins**. The folder name must match the plugin ID `simple-one`.

Regular users do **not** need to install Node.js or npm. Obsidian loads the prebuilt `main.js` from the release. The build commands below are only for people who want to compile or modify the source code.

## Data and network access

- Settings and any data you enter into them are stored locally by Obsidian in `.obsidian/plugins/simple-one/data.json`. The file is excluded from this repository and its releases. Back it up privately if you need to keep your configuration.
- The public 2026 China national holiday schedule is maintained in `src/default.json` and bundled into `main.js` when built. It is used as initial data only when no holiday schedules have been saved. Existing schedules, including company schedules, remain in your local `data.json`.
- When the corresponding features are enabled or used, the plugin reads and changes notes or attachments in the current vault. Attachment cleanup presents a review list before moving selected files to Obsidian's trash.
- URL-title lookup and website-to-note actions can request a URL you supply or a selected website. Built-in rules include sites such as Jinjiang, 52shuku, Fanqie, and Qidian. A site search sends its query to that site. Some desktop extraction fallbacks open the selected site in a hidden webview; Fanqie's fallback may use that site's cookies for a request to its own API. These fallbacks may not work on mobile.
- The plugin has no analytics or plugin-operated server. Network requests for the above actions go to the relevant websites; vault contents are not sent to a server run by this plugin.

## Build from source

Requires Node.js and npm:

```sh
npm ci
npm run build
```

The build checks TypeScript and writes `main.js`. Keep `main.js`, `manifest.json`, and `styles.css` together for a release. Never commit `data.json`, vault notes, or Obsidian workspace settings.

## License

The plugin source is available under the [MIT License](LICENSE). Bundled dependencies have their own notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## 中文说明

Simple One 将日常笔记工具集中到一个 Obsidian 插件中，包括文本排版、URL 处理、日记与日历、网址转笔记、显示增强和附件整理。插件设置界面目前使用中文。

### 功能一览

| 分类 | 功能 |
| --- | --- |
| 写作与链接 | 按可配置的规则重排版当前笔记或粘贴的文本；处理粘贴的普通 URL 或 Obsidian 链接；复制当前笔记的链接或路径。URL 粘贴处理与重排版分别设置。 |
| 快速排版 | 在笔记标题栏添加按钮和快捷菜单，用于执行排版操作。 |
| 日记与日历 | 创建日记、结转未完成任务、管理周期提醒、纪念日和导入的假期安排。写入日记的提醒可使用自定义级别的标题或 Callout。 |
| 网址转笔记 | 根据 URL 创建笔记，或在支持的网站中搜索；可编辑网页提取规则和笔记输出目录。 |
| 阅读与显示 | 预览颜色和 HTML、放大图片、调整图片高度和正文宽度、操作 Mermaid 图表，以及创建双列内容。 |
| 仓库工具 | 按文件夹筛选 Obsidian 原生搜索结果、根据选定的 Base 视图为新笔记补齐属性，以及检查附件清理和归位方案。 |

各类功能可在 **设置 → 第三方插件 → Simple One** 中配置。部分选项需要重启 Obsidian，设置项会注明。

### 开始使用

1. 按下方说明安装插件，然后在 **设置 → 第三方插件** 中启用 **Simple One**。
2. 打开 **设置 → 第三方插件 → Simple One**，按需启用功能。
3. 使用日记前，检查日记文件夹、文件名规则和模板。首次加载时，如果 Obsidian 自带的“日记”插件已有这些设置，Simple One 会沿用它们。
4. 使用网址转笔记前，选择笔记输出目录并检查网站提取规则。内置分类在未指定输出目录时，最初会将笔记保存到仓库根目录。
5. 使用附件工具前，在 Obsidian 的 **设置 → 文件与链接** 中为新附件指定专用文件夹。如果当前设置为仓库根目录，插件会提供“快速配置”按钮，把以后新附件的存放目录设为 `Attachment`；它不会移动已有附件。随后在插件设置中打开 **附件优化**，执行操作前先检查待处理清单。附件存放位置为仓库根目录或无法安全识别时，附件扫描与整理功能会被禁用。

#### 手动安装

从同一个[发布版本](https://github.com/ZO00OEY/simple-plugin/releases)下载 `main.js`、`manifest.json` 和 `styles.css`，一起放进仓库的 `.obsidian/plugins/simple-one/` 文件夹。然后在 **设置 → 第三方插件** 中启用 **Simple One**。文件夹名必须与插件 ID `simple-one` 一致。

**普通用户不需要安装 Node.js 或 npm。**Obsidian 会加载发布包中已经构建好的 `main.js`。下方的构建命令只供需要自行编译或修改源码的人使用。插件通过官方社区审核后，也可以直接在 Obsidian 内安装。

### 数据与网络访问

- 插件设置及你在设置中填写的数据由 Obsidian 保存在本地的 `.obsidian/plugins/simple-one/data.json`。该文件不包含在本仓库和发布版本中。如需保留配置，请自行私下备份。
- 中国大陆 2026 年国家放假调休安排单独维护在 `src/default.json`，构建时打包进 `main.js`。只有尚未保存假期安排时才作为初始数据载入；已有安排及公司安排仍保存在本机 `data.json`，不会被覆盖。
- 启用或使用相应功能时，插件会读取或修改当前仓库中的笔记和附件。清理未引用附件会先显示待处理清单，经确认后才将选中的文件移入 Obsidian 回收站。
- 提取 URL 标题和网址转笔记功能可能访问你提供的 URL 或所选网站。内置规则涉及晋江、52书库、番茄、起点等网站；站内搜索会把搜索词发送给对应网站。部分桌面端提取流程会在隐藏的网页视图中打开所选网站；番茄的备用流程可能使用该网站的 Cookie 请求其自身接口。这些备用流程在移动端可能不可用。
- 插件没有统计分析功能，也没有由插件作者运营的服务器。上述联网操作直接访问相关网站；插件不会把仓库内容发送到由本插件运营的服务器。

### 从源码构建

需要先安装 Node.js 和 npm：

```sh
npm ci
npm run build
```

构建命令会检查 TypeScript 并生成 `main.js`。发布时需要同时提供 `main.js`、`manifest.json` 和 `styles.css`。不要将 `data.json`、仓库笔记或 Obsidian 工作区设置提交到公开仓库。

### 许可协议

插件源码采用 [MIT License](LICENSE)。简单说，其他人可以使用、修改和再发布代码，包括商业使用，但分发时需要保留原版权声明和许可文本。插件使用的第三方依赖另有[许可声明](THIRD_PARTY_NOTICES.md)。
