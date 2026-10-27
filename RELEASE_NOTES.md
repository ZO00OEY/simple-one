# Simple One 1.0.26

- 精简同步修复弹窗，统一设置页字体与间距，使用红色确认按钮提示清理风险。
- 清理索引锁前，仅中断当前插件实例为当前笔记库启动的 Git 操作；不扫描或终止其他仓库及外部工具的 Git 进程。
- 取消索引锁的时间与大小限制；中断失败时停止清理，并保留错误提示。
- 清锁成功后更新活动错误状态，保留历史日志；清理后仍需重新同步。
- 移除多余的平台检测说明及专用代码，保留按平台应用显示设置的逻辑。

English: clearer sync repair confirmation, scoped interruption of Git tasks started by this plugin for the current vault, corrected post-repair status, and removal of redundant platform hints.

升级仅替换 `main.js`、`manifest.json`、`styles.css`，保留个人配置。源码与发布附件不包含个人设置、凭据、日志或分享清单。

---

# Simple One 1.0.25

本版作为对外介绍的复核版本，沿用 1.0.24 的功能和界面，不新增功能或改变配置格式。

- 重新核查同步与分享凭据的读写、迁移失败保护、恢复副本及公开发布边界。
- 完善 Secret Storage 说明，区分当前配置、旧备份、其他设备与本机 GitHub CLI 授权。
- 更新中英文介绍、版本映射与发布核对记录。安装仍只需要三个标准程序文件，升级保留个人配置与自定义模板。

English: a verified release baseline for the 1.0.24 feature set. This release refreshes release metadata and documentation, and rechecks credentials, recovery and public-export boundaries. No new features or configuration-format changes are introduced.

详见[本版验证记录](docs/release-review-1.0.25.md)及[个人配置与凭据说明](docs/private-files.md)。

---

# Simple One 1.0.24

## 设置与维护

- 按同步、分享、日程、拓展、编辑、显示、主题整理使用说明，统一普通分组、按钮、复选框图标和行间距。
- 附件清理、归位与内嵌图片转换共用操作栏；图片与非图片附件共用归位流程，保留确认与失败提示。
- 清除失效设置字段、旧展开控件样式和多余包装；补充附件操作栏与流程图交互回归测试。

## 流程图与分享阅读器

- 插件和默认分享阅读器共用画布模式、拖动平移、鼠标位置缩放、适应宽度及全屏交互。
- 修复全屏可能被编辑区裁切、切换笔记或卸载后残留界面的问题。
- 保留离线阅读器、数学字体、图表类型和第三方许可证，不依赖额外 CDN。
- 已有网站需要使用更新后的默认阅读器并重新推送；自定义模板不会被自动替换。

## 凭据与升级

- Obsidian 1.11.4+ 将轻量同步 GitHub Token 保存到 Secret Storage；已有 Token 先保存并读回验证，再从当前 JSON 和恢复副本移除，保留基线与缓存。
- 补充迁移失败、部分文件写入失败、Token 清除和恢复测试。旧版 Obsidian 保留原本的本机 JSON 保存方式；建议升级以启用 Secret Storage。
- 分享 GitHub 与 EdgeOne Makers 授权继续使用 Secret Storage 或本机 GitHub CLI。旧插件文件、历史备份和 Git 历史不会自动擦除。
- 下载本 Release 的 `main.js`、`manifest.json`、`styles.css`，保留个人配置与自定义模板。公开源码与发布附件不包含个人配置、Token、日志或分享清单。

English: shared settings and attachment components; shared pan/zoom/fullscreen diagram controls in Obsidian and the default reader; lightweight GitHub Token migration to Secret Storage on Obsidian 1.11.4+; updated bilingual guides and privacy documentation. Settings remain primarily Chinese. Preserve configuration and custom templates when upgrading.

详见[个人配置与凭据](docs/private-files.md)和[本版验证记录](docs/release-review-1.0.24.md)。

---

# Simple One 1.0.23

## 更清晰的设置与日常工作流

- 合并“快捷键与编辑”，统一边框分组和小型图标按钮；自动排版、快速新建笔记和文本显示替换进入独立设置页。
- 日历与日记拆分标签，增加点击日期新建日记开关；事件、纪念日、国家与公司假期分别管理，支持年度查看和导入入口。
- 精简电脑端与轻量 Git 同步设置，引导页复用紧凑同步规则；插件同步范围在弹窗内勾选，明确图片同步和缓存、文件移动追踪的含义。
- 整理分享管理与分享库列表；HTML 模板通过弹窗导入、导出和恢复，库的详细管理保留独立页面。
- 改进网页模板与规则的导入合并、字段排序和规则测试，并完善正文排版、显示替换及同步进度相关检查。

## 修复与清理

- 防止日记异步补写覆盖等待期间的新编辑。
- 防止 HTML 剪贴在剪贴板等待后按过期位置删除笔记；复制失败时保留原文。
- 清理 7 个无调用的旧设置方法及 24 条废弃样式规则，统一标题组件和窗口计时器。
- 启用 TypeScript 未使用代码检查，补齐默认测试链；清除上一版的 lint 错误和警告。

## 安装、兼容性与隐私

下载本 Release 的 **main.js、manifest.json、styles.css**，替换笔记库配置目录下 plugins/simple-one/ 的同名文件并重载。请保留个人配置文件；默认分享阅读器已内置。

基础要求 Obsidian 1.7.2；Secret Storage 的 Token 分享授权与 EdgeOne 授权需要 1.11.4 或以上。电脑端原生同步需要 Git。首次同步与批量文件操作前请保留独立备份。

公开仓库及 Release 不包含个人配置、授权凭据、运行状态或分享清单。分享正文和附件本身是公开内容，普通正文及外部链接不会自动脱敏。

验证范围：生产依赖审计、零警告 ESLint/CSS、完整回归测试及生产构建；并行独立代码与隐私复核。真实移动端触控、多窗口、剪贴板权限和各主题视觉效果仍需实机确认，未对用户私人笔记库执行破坏性验证。

中英文 README 已更新，增加安装、同步方式选择、设置导航和隐私边界。详细审查见 [docs/release-review-1.0.23.md](docs/release-review-1.0.23.md)。大改前备份标签 backup/pre-bugfix-2026-10-27 继续保留。

---

# Simple One 1.0.22

- 将同步与笔记分享分成独立入口；分享侧栏支持目录批量选择、拖动笔记和更清晰的发布状态。
- 改进分享网站的目录管理、链接复制、附件复用与发布恢复，并更新默认阅读器。
- 新增电脑端正文排版设置；优化设置页分组和快速新建笔记的目录选择。
- 为晋江搜索加入 GB18030 关键词编码及翻页规则。
- 修复内嵌图片转换时笔记变化可能导致错误替换、未引用附件列表过期、内置纪念日设置被重置，以及双列内容保存失败未提示的问题。
- 清理网页搜索的旧渲染代码，并合并重复的页面等待逻辑。

发布附件仅包含 `main.js`、`manifest.json` 和 `styles.css`；个人配置、授权信息与本机同步状态不纳入公开仓库。
验证：生产依赖安全审计、ESLint/CSS 检查、完整测试与 TypeScript 构建通过；Obsidian 内视觉效果仍需实际确认。

# Simple One 1.0.17

- 轻量同步新增合并、以云端为准、以本地为准与自定义策略，执行前统一预览上传、下载与删除清单。
- 大批量首次下载支持持久化待办、固定版本 ZIP 或已解压目录导入，校验文件并保护本机设置与未完成进度。
- 分享改为直接通过 GitHub 文件哈希发布，支持手机与未安装 CLI 的电脑使用 Token 授权，减少克隆与重复上传。
- 默认分享阅读器使用独立 HTML，同时在插件内保留压缩副本；市场安装后自动生成缺失的阅读器与许可证，保留已有 HTML 和自定义模板。改进分享目录管理、复制内容选项及腾讯 EdgeOne 接入与部署核验。
- 改进同步与分享侧栏、快速新建笔记界面；移除无调用的旧链接格式化函数。
- 修正安装与审核说明，Release 只提供三个标准插件文件；默认 HTML 阅读器与许可证内置于插件，无需额外安装包或手动补充文件。

验证：生产依赖安全审计、ESLint/CSS 检查、同步/分享/阅读器回归测试与 TypeScript 构建。Obsidian 内视觉效果仍待用户确认。

# Simple One 1.0.16

- 将压缩依赖 fflate 升级至 0.8.3，修复官方审核提示的 ZIP64 安全公告。
- 将生产依赖安全检查加入发布检查流程，阻止带已知依赖漏洞的版本发布。
- 保留 1.0.15 的轻量同步恢复、整库下载及审核兼容性改进。

# Simple One 1.0.15

- 修复轻量同步中断后重新接入被旧任务阻塞的问题：清理临时状态，保留完整基线，并重新核对差异。
- 空笔记库首次下载、较大批次下载及保留两端文件时，优先按固定提交打包下载；按忽略规则过滤，校验失败自动回退逐文件下载。
- 将插件产物压缩至 5 MB 以下，并加入构建体积上限，保留分享网站的 Mermaid、公式与字体支持。
- 完善桌面 API 类型与浏览器兼容性，启用严格的类型安全检查；移除直接访问 localStorage 的代码。
- 简化分享阅读器 CSS，消除 :has、扩展系统字体与无必要的缩进规则。

分享网站使用标准浏览器 DOM 与 fetch API，其与 Obsidian 插件运行环境的区别见 docs/automated-review-notes.md。

# Simple One 1.0.14

- 新增笔记分享：在原笔记库中选择笔记，发布到独立公开仓库与 GitHub Pages，分享链接在笔记改名或移动后保持不变。
- 提供分享管理侧栏，支持目录布局、名称排序、公开分类与名称、链接复制及撤下笔记；通过「推送新分享」发布待办更改。
- 分享网站支持标题折叠、Callout、公式、Mermaid 和分列内容，支持导入、导出 HTML 模板与恢复默认模板。
- 统一电脑端同步、轻量同步与分享引导的界面，完善仓库重名提示、部署状态检查及当前同步模式提示。
- 改进轻量同步的差异预览与冲突处理，补充桌面自动备份及分享回归检查。
- 整理中英文项目介绍，将详细使用说明移至独立文档，并在主页提供语言与使用说明链接。
- 统一分享阅读器的压缩包格式，确保 Windows 与 Linux 构建产物一致。

笔记分享创建与发布目前需要电脑端；分享网站可在手机浏览。公开内容不提供访问密码，撤下不会清除 Git 历史或已保存的副本。

# Simple One 1.0.11

- 集成桌面 Git 与移动端轻量同步功能，提供仓库接入、差异预览、冲突处理与设备状态隔离。
- 整理忽略规则管理：自动检测内嵌仓库并排除 Git 元数据，将设备同步基准、凭据与恢复状态留在本机。
- 生成的 `.gitignore` 按分类排列并去重，推荐规则之外的自有规则集中展示。
- 忽略规则界面默认折叠，展开后分层缩进，每条路径独占一行，长路径横向滚动。
- 补充同步、迁移、移动端运行和仓库接入回归检查。

验证：完整 lint、CSS 检查、基础功能与同步测试、TypeScript 构建通过；界面效果待用户验收。

# Simple One 1.0.10

- 修复选中内容后按下右键，无法通过 Obsidian 原生菜单正常高亮的问题。双列功能此前误拦截了普通右键事件，导致原生菜单无法正常出现；现在仅在触发左右键同时按下的双列操作时拦截，普通右键恢复原生菜单，高亮等格式操作可正常使用。
- 保留左右键同时按下触发双列的功能。

验证：TypeScript 构建、现有 smoke 测试及右键事件回归检查通过；Obsidian 内实际高亮效果待确认。

# Simple One 1.0.9

- 修复附件删除接口，遵循 Obsidian 的回收站设置；兼容自定义配置目录。
- 将浏览器原生确认框改为 Obsidian 弹窗，并补齐异步回调的错误处理。
- 粘贴前检查是否已被其他插件处理，避免重复接管。
- 修复多窗口元素检查和计时器写法；保留旧版设置页，增加 Obsidian 1.13 的功能搜索入口。
- 调整 CSS 覆盖、双列区块状态和自定义标签样式，移除 `!important` 与 `:has()`。
- 取消双列命令的默认快捷键；已有用户自定义快捷键保留。
- 加入桌面窗口定位优化，将超出显示器可用区域的设置和插件市场弹窗移回可见范围。
- 主 README 使用英文，完整中文使用说明保留在 README.zh-CN.md；补充安装指南、数据访问说明及直接依赖声明。
- 根据官方复查结果，修复 ES2020 检查环境中的数组索引与类型声明兼容问题。
- 发布产物通过 GitHub Actions 构建并生成来源证明。

Validation: official recommended ESLint rules (zero errors/warnings), CSS checks,
TypeScript build, formatting/window/platform smoke checks, and dependency audit.

Vault enumeration, clipboard access, Notebook Navigator local-storage fallback,
and inline-image Base64 decoding remain intentional capabilities.
