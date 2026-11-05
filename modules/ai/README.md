# 内置 AI 模块

从 Simple AI 的已验证实现迁入，随 Simple One 打包，无需另装插件。源码与模拟测试集中保留，方便核对原有模型、Agent、聊天、记忆及用量行为。

宿主入口是 `src/features/ai.ts`，仅启用 AI 后加载运行时（需要 Obsidian 1.11.4+）。设置不再分基础／高级页；模型来源随宿主配置保存，聊天与本机偏好位于私有目录，密钥使用独立命名空间。不包含自动读取或迁移独立 Simple AI 数据的逻辑。

从 Simple One 目录运行 `npm run test:ai`，或单独 `npm test --prefix modules/ai`。根构建执行严格 TypeScript 检查并将本模块打入 `main.js`；样式在构建时合入 `styles.css`，保留模块已有的作用域和布局规则。
