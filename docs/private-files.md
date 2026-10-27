# 个人配置与凭据 / Personal files and credentials

文件默认位于 `.obsidian/plugins/simple-one/`，使用自定义配置目录时替换 `.obsidian`。它们按需生成，刚安装时不一定全部存在。

**公开发布插件、同步自己的私人笔记库、发布笔记网站是三件事。可跨设备同步，不代表可以公开。**

| 文件或位置 | 内容 | 私人笔记库同步 | 公开插件发布 |
| --- | --- | --- | --- |
| `data.json` | 功能、显示、日记、模板与规则等个人配置，自定义内容可能含隐私 | 支持同步普通配置 | 排除；升级保留 |
| `sync-settings.json` | 仓库地址、分支、作者名称／邮箱、忽略规则与时间间隔 | 支持同步 | 排除 |
| `sync-api-local.json*` | 轻量同步本机设置、凭据引用、基线、缓存与恢复状态；旧版本可能含 Token | 排除 | 必须排除；旧版与备份可能含明文 Token |
| `sync-local.json*` | 本机方案与接入状态；旧数据或服务器模式可能含凭据／服务器密码 | 排除 | 必须排除 |
| `sync-log.json*` | 同步日志，可能含私人路径与仓库信息 | 排除 | 排除，反馈前脱敏 |
| `link-state.json*`、`mobile-ignore.json*` | 旧同步基线、恢复记录与本机排除项 | 排除 | 排除 |
| `share-manifest.json` | 分享库、目录映射、分享条目及原笔记路径 | 支持在自己的设备间同步 | 排除；网站不接收该私人清单 |
| `share-local.json*` | 发布状态、部署关联、查询缓存与接入进度，包括 `.edgeone`、`.details` 及库编号后缀 | 排除 | 排除 |
| `share-template-selection.json*`、`custom-*.html`、`share-template*.html` | 模板选择与自定义模板，可能含个人域名或脚本 | 按同步范围和个人规则 | 排除 |
| Obsidian Secret Storage | 1.11.4+ 的轻量同步 GitHub Token、手动接入分享的 GitHub Token、EdgeOne Makers API Token | 插件不通过共享 JSON 迁移；新设备重新授权 | 不在发布文件中 |
| GitHub CLI／Git 凭据存储 | 本机 GitHub 登录与 Git 授权 | 不属于插件配置同步 | 不在发布文件中 |

## 最需要保护的内容

- **1.0.24 在 Obsidian 1.11.4+ 将轻量同步 Token 迁移到 Secret Storage**：先保存并读回确认，再清除当前 `sync-api-local.json`、`.recovery` 和重写的 `sync-local.json` 中的 Token；同步基线与缓存不变。密钥按本机设备编号区分，当前凭据引用与本机设置一起保存，避免部分写入失败后找不到授权。
- 更旧的 Obsidian 没有该 API，仍按旧方式将轻量同步 Token 保存在本机 JSON；要使用 Secret Storage 请先升级。历史备份、旧插件目录和 Git 历史不会自动擦除，仍需当作敏感数据保护。
- 分享 GitHub Token 和 EdgeOne Token 使用 Secret Storage（需要 Obsidian 1.11.4 或以上），或既有 GitHub CLI 授权；不要导出授权数据作为问题附件。
- `sync-settings.json` 不含轻量同步 Token，但仓库地址和作者邮箱仍属个人信息。
- 升级只替换 `main.js`、`manifest.json`、`styles.css`。保留个人配置、自定义模板与本机状态；不要用另一设备的基线覆盖本机。
- 源码仓库的忽略规则比私人笔记库严格，不要把对 `data.json*` 的排除规则照搬到私人笔记库。公开分享使用独立分享库。
- 不要发送整个插件目录排查问题；提供脱敏错误、复现步骤和截图。

## English summary

Personal preferences, device state and credentials are different categories. `data.json` stores personal settings and rules. `sync-settings.json` stores cross-device settings, including repository and author information. Both stay out of public plugin releases.

**On Obsidian 1.11.4+, version 1.0.24 migrates lightweight GitHub Tokens to Secret Storage**, verifies the saved secret, and removes plaintext Tokens from the current JSON and recovery copy while preserving sync state. Older Obsidian versions retain legacy JSON storage. Historical backups and old plugin directories are not automatically scrubbed. `sync-local.json` may also hold legacy credentials or a server password. Keep these files private and do not replicate device baselines between devices.

Sharing GitHub Tokens and EdgeOne Tokens use Obsidian Secret Storage or a local GitHub CLI login. The plugin does not transfer those secrets through its shared JSON files. `share-manifest.json` contains private source paths; the website receives generated public notes and assets, not that private manifest.

Release assets contain only `main.js`, `manifest.json` and `styles.css`. Preserve settings and custom templates when upgrading, and authorize each device separately when needed.
