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
