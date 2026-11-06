# Simple One 1.0.33：官方警告核对与本地修复

## 范围与证据

- 官方来源：https://community.obsidian.md/account/plugins/simple-one 。本轮重新读取了 1.0.33 / 85f35ea 的完整展开结果：Completed、无 Error；依赖为 Pass / No vulnerable dependencies found；构建为 Pass / Build reproduced the release main.js byte-for-byte。
- 这些结果不等于“所有 Warning 都是漏洞”。下表逐类列出官方显示的警告/建议与代表性原始位置；不是用本地 lint 数量冒充官网总条数。完整原始位置仍以审核页链接为准。
- 本地基线：85f35ea3b280cb02da14f91a95f6a65f4721b2f9。开始时工作区干净，远程 main 同一提交；本轮分支 fix/1.0.33-warnings。
- 仅修改原独立副本，不修改已安装主库，不推送、发布、重扫或新增 workflow/权限，不运行 npm audit 或包含它的 npm run check。版本文件仍是 1.0.33，最低版本 1.7.2，SecretStorage 1.11.4 守卫不变。
- 原始本地诊断：.codex/output/warnings/baseline.json。它是可比较的本地工具证据，不是官方诊断导出。

## 已证实的问题与实际修复

### 1. 流式增量事件可写入继承属性

原 Anthropic content_block_delta 使用外部事件的 index 直接读取数组属性。index 为字符串 __proto__ 时，读取到 Array.prototype；text_delta 随后写入其 text 属性。已在隔离 VM 中用原始流解析源码复现，证据保存在 .codex/output/warnings/baseline-sse-proof.txt；未使用真实服务、密钥、笔记或应用上下文。

这是有证据的原型属性污染问题，攻击前提是流式来源返回恶意/异常事件。本次没有证明代码执行、任意文件访问或数据外传，不能扩大这些结论。

修复：对两种协议所有工具/内容索引验证为有界非负整数；Anthropic 增量必须对应本数组已创建的自有块，重复块起始被拒；文本/思考/工具 JSON 增量必须匹配块类型且为字符串。回归覆盖 __proto__、constructor、字符串数字、负数、小数、越界、缺失起始事件、重复块、错误字段及 Array.prototype 不变。

### 2. API JSON 信任边界

协议响应、SSE 事件、HTTP decode 和模型列表从 any 改为 unknown，通过实际对象、数组和字段校验再使用；不是用强制断言掩盖类型问题。拒绝非对象响应、畸形工具集合、非对象工具参数和错误内容块，同时保留兼容来源把可选 tool_calls 写为 null 的行为。流式累积状态明确分成两种协议的类型。

工具批量提案的每项 name/arguments 在执行前也做对象和类型验证；历史 read_note 结果仅在结构匹配时恢复读取缓存，普通非 JSON 消息明确跳过。搜索目录必须是字符串，避免把对象隐式拼接成路径前缀。原有读后写、审批、路径与范围检查不变。

### 3. 兼容性和维护问题

- AI 的计时器及动画帧使用 window API，浏览器计时器句柄用 number，避免混入 Node Timeout 类型；测试 VM 显式提供窗口上下文。
- 聊天视图的 DOM 类型检查使用 Obsidian 的跨窗口 instanceOf 方法。暂未做真实多窗口视觉 QA，不能把本地测试称为实机验证。
- 模块 DOM 创建使用已有 createDiv/createEl 帮助器；原来 createEl("div") 的几处也换成 createDiv。共享的独立网页/sandbox 工具仍保留浏览器 DOM API。
- 移除 forEach 回调隐式返回链式 ButtonComponent 的写法，避免其 then 方法被误判为 Promise；不是发现了两个未处理异步按钮。
- Notice.messageEl 仅在 requireApiVersion("1.8.7") 守卫内使用，基础最低版本不变。
- AI 设置内部导航直接调用已存在的 render()，保留 display() 作为宿主兼容入口，不再通过弃用的 display API 转发。既有设置导航 DOM 回归会覆盖该路径。
- 两处重复 CSS 是旧浏览器回退而非漏洞：保留普通背景和 100vh，把 color-mix 和 100dvh 放入 @supports；没有简单删除回退。
- CORS 错误原先建议关闭已经退休的“流式回复”设置。已纠正说明并保留单次请求行为：不自动重发付费请求，不自动回退导致重复计费。

## 官方 SOURCE CODE 警告逐类处理

以下路径均以 modules/ai/src 为前缀，另行注明 src/shared 的除外。位置为 1.0.33 的原始扫描位置，本地修改后行号会移动。

| 级别/规则或官网要点 | 原始位置举例 | 判断与处理 |
| --- | --- | --- |
| Warning / @typescript-eslint/no-unsafe-assignment | agent/protocol.ts:36、agent/stream.ts:33、api/client.ts:139；cooperation.ts:54、runtime.ts:51、storage.ts:16、tools.ts:66、main.ts:58、api/settings.ts:39 等 | API/流/工具解析边界已修；私有历史存储、模型考核和配置恢复仍有警告，不能只加断言声称安全。其持久化兼容与恢复策略需另做字段级 schema/迁移测试，避免破坏既有数据。 |
| Warning / @typescript-eslint/no-unsafe-member-access | protocol.ts:31–66、stream.ts:34–85、client.ts:142–188；cooperation/storage/runtime 等 | 上述网络边界已校验；其余持久数据路径保留，不声称已发现 exploit。 |
| Warning / Empty block statement（本地 no-empty） | cooperation.ts:54/256/267/268、runtime.ts:51、storage.ts:16、tools.ts:66、client.ts:116 | tools 的非 JSON 历史明确 continue；流 reader cancel 失败显式忽略且不遮蔽原结果；存储恢复等其他 catch 保留，需逐个核实恢复语义，不能统一抛错导致旧库无法打开。 |
| Warning / @typescript-eslint/no-unsafe-return | cooperation.ts:98、storage.ts:37/52、stream.ts:74、view.ts:733、client.ts:150/184 | 网络响应返回已类型化；内部持久数据、日志 JSON replacer 等仍保留。 |
| Warning / unnecessary type assertion | cooperation.ts:124/125、view.ts:475 | 属维护建议，不构成信任边界校验；本批未为计数清零改写这些已运行的内部对象引用。 |
| Warning / @typescript-eslint/no-unsafe-call | cooperation.ts:256/299/304、stream.ts:37/74/80、client.ts:160；src/shared/searchUrl.ts:12 | 网络边界已修；考核输出/持久化路径保留。共享编码库的官网警告在本地现有 src 检查中没有复现，未替换可用编码功能。 |
| Warning / @typescript-eslint/no-unsafe-argument | cooperation.ts:334、protocol.ts:13/48、runtime.ts:92、storage.ts:35/118/127、stream.ts:34/82/86、tools.ts:66/178/189、client.ts:144/160；src/shared/searchUrl.ts:12 | 协议、流、模型列表与工具提案边界已修；其余同上。 |
| Warning / prefer-create-el | examinerView.ts:46、settings.ts:234/238、trafficSettings.ts:17/18、view.ts:469/546/593/637；src/shared/mermaidViewer.ts、themeColorPicker.ts | AI 模块已使用相应帮助器；官网描述也覆盖 createEl("div") 这种应使用 createDiv 的情形，不全是 document.createElement。独立 reader/sandbox 没有 Obsidian DOM 扩展，保留浏览器实现；既有规则例外未改变。 |
| Warning / Unexpected any | protocol.ts:6/9/26、storage.ts:13、stream.ts:10/32/37/74、client.ts:120/136/184 | protocol、stream、client 的 any 已移除；storage 通用反序列化的两处仍保留，需完整私有状态 schema，不能将其伪装为已验证 Session。 |
| Warning / window.setTimeout | runtime.ts:251/493、search.ts:51、view.ts:127/501/815、client.ts:83/130 | 已修。 |
| Warning / window.clearTimeout | runtime.ts:372/492、view.ts:127/491/498/815/947/950/951、client.ts:115/134 | 已修。 |
| Warning / restrict-plus-operands | search.ts:29 | 已验证 folder 字符串，再拼接前缀；畸形搜索不会读取/修改笔记。 |
| Warning / control characters in regex | agent/types.ts:103 | 刻意拒绝路径控制字符，属于输入验证；移除正则会削弱路径检查，保留。 |
| Warning / Promise returned where void expected | view.ts:246/247 | 链式按钮有 then 方法导致误判；forEach 回调改成无返回的块，功能不变。 |
| Warning / window.requestAnimationFrame | view.ts:430 | 已修。 |
| Warning / cross-window instanceof | view.ts:687 | 已改为 node.instanceOf(HTMLElement)。 |
| Warning / missing getSettingDefinitions | api/settings.ts:309 | AI 页面是外层设置宿主中的动态导航/模型表单；基础搜索入口由 src/settings.ts 的 getSettingDefinitions 提供。没有添加空 definitions 来掩盖警告。完整动态 AI 字段索引需要设计 1.13+ 声明式适配，保留该建议及动态子项暂不被原生搜索索引的限制。 |
| Warning / fetch（本地 no-restricted-globals） | main.ts:28 | 保留。streamChat 需要 Response.body.getReader、AbortController 和逐块更新；requestUrl 不提供流式读取。无 update 回调的 API 路径仍用 requestUrl；来源连接测试也用非流式。当前没有通用“关闭流式回复”设置，已修复错误提示，不会自动重试付费调用。来源 HTTP/HTTPS 与认证头由用户配置；没有由此推断恶意传输。 |

## 官方 Recommendation 逐类处理

| 官网建议 | 原始位置/范围 | 处理与原因 |
| --- | --- | --- |
| Missing GitHub artifact attestations | release main.js、styles.css | 保留。用户选择手动发布、不新增 workflow/凭据/权限，本轮不处理授权和发布证明。已通过的构建复现与 attestation 是不同证据。 |
| Vault Enumeration | vault.getFiles/getMarkdownFiles 等 | 目录/附件管理、搜索与同步需要；搜索仍排除隐藏路径并遵守会话范围，不会因枚举本身把全部文件上传。发送内容仍走用户触发的工具/引用/同步流程，未发现仅凭枚举可证明的外传漏洞。 |
| Clipboard Access | 粘贴图片事件、消息/提示词复制等 | 用户粘贴时读事件 clipboardData，明确复制动作写剪贴板；其他宿主功能也有用户发起的复制/粘贴。未发现由此证明的后台剪贴板窃取，保留功能。 |
| noticeEl deprecated → messageEl | runtime.ts:130 | 已用版本守卫迁移。 |
| keyCode deprecated | view.ts:129 | 保留 229 作为 isComposing 以外的 IME 兼容回退；不能为了建议清零导致中文输入候选确认时误发送。 |
| setWarning deprecated → setDestructive | view.ts:898、api/settings.ts:21 | setDestructive 从 1.13.0 才提供，而 AI 支持 1.11.4+；旧版本仍需兼容按钮语义。保留，不提高整个插件最低版本。 |
| display deprecated → getSettingDefinitions | api/settings.ts:322 等内部导航调用 | 内部调用已直接走现有 render；保留宿主兼容 display 入口。声明式搜索适配的剩余限制见上表。 |

## 官方 CSS LINT 逐类处理

官网没有在这几项 UI 中展示独立规则 ID，以下保留其描述，不猜测规则名。

| 级别/描述 | 1.0.33 原始位置 | 处理与影响 |
| --- | --- | --- |
| Warning / multicolumn partially supported by Obsidian 1.6.5 | styles.css:615/722/8326/8909，modules/ai/styles.css:120 | 布局/阅读功能所需；扫描使用的 CSS 兼容标签为 1.6.5，不能据此断言当前 1.7.2+ 实际失效。本批未删除布局功能。 |
| Warning / css-text-indent partial support | styles.css:7922/7927/7930/7936 | 阅读排版语义；未发现具体功能失败证据，保留。 |
| Warning / css-display-contents partial support | styles.css:8911/8937，modules/ai/styles.css:122/148 | 布局兼容性建议；需主题/移动端可视回归才适合替换，本批不扩大 UI 重写。 |
| Warning / duplicate background | styles.css:9086，modules/ai/styles.css:297 | 已重构为基础背景 + @supports color-mix，保留回退。 |
| Warning / duplicate height | styles.css:9252，modules/ai/styles.css:463 | 已重构为 100vh + @supports 100dvh，保留旧 WebView 回退。 |
| Warning / Avoid !important | modules/ai/styles.css:3/31/41 等，及生成 styles.css 的对应位置 | 主题/宿主覆盖中大量使用，属于可维护性建议；直接删除可能破坏布局。未发现安全漏洞证据，留待有视觉覆盖的独立样式整理。 |
| Warning / Avoid :has | modules/ai/styles.css:399/648/655/656，styles.css:9188/9437/9444/9445 | 当前为聊天元数据与设置控件的局部状态布局，未测得性能故障；改成 class 要同步所有动态路径，留待单独 UI 状态/性能测试。 |

## 验证与交付状态

本地规则文件完全未修改，没有关闭或整体降低规则，没有新增 any 或以强制类型断言处理不可信响应。最终比较从 0 errors / 421 warnings 降至 0 errors / 144 warnings，减少 277 条（约 66%）。此数量仅为本地相同配置对比，不是官网警告总数。

最终 npm run lint、完整 npm test、npm run build:verify 均为退出码 0；退出码分别保存在 .codex/output/warnings/lint.exit.txt、full-test.exit.txt、build.exit.txt，日志同目录。完整套件包含 20 项 API 检查、实际 reader 构建/解压回归、AI 设置导航和新增工具提案/搜索验证，不只是 focused tests。两次删除生成输入/产物后的构建完全一致；main.js 为 4,093,902 字节，低于 5,000,000 字节限制，SHA-256 f0c0ea5031cef5b4c0849d49ca28d143764e9562e8ebb4d1e2373a7db7768688。styles.css SHA-256 a9512d5d4bfd7a05ec05b0dcb0c98b07c68d84f55ce173b00e15dc106b1103c2。readerPayload/default.html/licenses 哈希未变，压缩确定性修复保留。六项产物哈希见 .codex/output/warnings/build-hashes.json。

未做实机 Obsidian/手机/弹出窗口视觉 QA，未做 Windows/Linux CI，未声称完成全插件安全审计或所有警告清零。尚未推送/发布，未来发布本批修改需要用户新的明确授权。

## 1.0.34 手动发布准备

用户随后明确授权手动发布这批修复。报告对照的官方结果仍是 1.0.33，修复发行版本准备为 1.0.34。最终执行代码与已完整测试 exit 0 的代码相同，仅更新版本元数据与发布说明；再次执行版本/附件一致性、安全回归和重复构建。保持规则、依赖版本、构建流程及最低 App 版本不变，不增加 workflow 或授权范围。新版本的官方审核结果应单独确认，不能套用旧版本 Completed。
