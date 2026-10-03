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
