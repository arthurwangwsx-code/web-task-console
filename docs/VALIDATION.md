# 验证记录

记录日期：2026-10-31。所有 fixture 均为新建合成数据；未访问真实 WorkSpace 工程或执行业务任务。

## 已执行并通过

环境：Node.js 24.22.1，npm 11.9.0。标准测试不需要第三方依赖。

| 检查 | 结果 |
|---|---|
| `npm run check` | 33 个 JavaScript 模块语法检查通过；manifest JSON 有效；零 runtime dependencies |
| `npm test` | **167 tests / 167 pass / 0 fail / 0 skipped** |
| BrowserAdapter 合成驱动单测 | 外部默认禁用、精确来源、逐字多行读回、并发同键只点击一次、丢 ACK 不重发、刷新文档失效、自有标签与关闭保护 |
| 可重复构建测试 | 相同源码两次逐文件哈希一致、MIT/清单、旧构建备份、拒绝未标记/修改/陌生文件/symlink/锁、只复制显式清单；现有 158 项回归仍通过，新增 9 项构建测试 |
| Profile/target/lease 纯契约 | 多 profile 明确选择、只保留必要身份、opaque target 不猜编码、过期/轮换/重连/target reuse 失效、显式只读恢复永不授权发送；未接实际 bridge API |
| capability_status 纯适配测试 | invocation-only 零 fallback、精确 ID、succeeded→router completed、未知枚举、原文/主体最小化、稳定摘要、错误脱敏与预算；不调用真实 MCP，不恢复发送权 |
| WorkspaceObserver 单测 | router 不冒充 producer、来源与原键/ID 校验、缺证据不成功、独立 producer 更新合并、不继承未认证来源信任 |
| 意图/恢复单测 | 持久化前置、同键复用/异内容冲突、并发串行化、unknown 不重发、原键回查恢复、完整文件重启、锁冲突、磁盘写失败不发送 |
| 多维背压 | 排队、活跃、scope、标签、回执独立预算；轮转跳过阻塞 scope；暂停与派发间隔 |
| 回执严谨性 | 陈旧观察、矛盾 invocation、无证据终态、旧运行证据污染、关闭 ACK 丢失后的重关均 fail closed |
| 真实本地 HTTP 集成 | 精确 Host、Origin、CSRF、body/Content-Type、静态资源白名单、状态码及 CSP |
| HTTP 端到端合成流程 | 多行仅入队 → 丢 ACK → unknown 保护 → 重复 tick 不发送 → 原键只读恢复 → 已核验完成后关闭；发送计数始终 1 |
| 特殊幂等键回归 | `constructor` / `__proto__` / `toString` 均经真实 HTTP、丢 ACK、JSON 文件重启、原键恢复与关闭，发送计数保持 1；新建及加载字典均为 null-prototype，旧 unknown 不自动重放 |
| Chrome API 合成实现 | 可选站点授权、同键串行单击、worker 崩溃、browser session/tab/document 绑定、精确 URL、首次对话显式确认、只读恢复后不可发送、未核验 JSON 不晋升权威 |
| 页面探针合成 DOM | 多行逐字读回、不覆盖/返回已有草稿、modal/inert/遮挡阻止单击、跨草稿选区拒绝；不是实际 Chromium DOM 执行 |
| 源码窄范围隐私检查 | 新项目中未发现选定的内部主机、工作区 ID、历史聊天 ID、绝对工作区路径或常见私钥/硬编码 bearer 模式；不是全面安全审计 |

`test/adapters.test.mjs` 使用合成宿主驱动，**不是 Chromium/真实网页执行**。`test/server.test.mjs` 使用真实 Node HTTP 服务与本地请求，但不是实际浏览器 UI。

## 已尝试，但被环境阻断

1. 初版合成 UI 脚本尝试启动已安装 Chromium，进程在初始化时出现 `socket() Operation not permitted`。
2. 一次受支持的升级执行请求未进入测试，执行器 bubblewrap 在只读挂载准备阶段失败。未读取受限位置，未绕过或反复尝试。
3. 已有受支持云浏览器可发现，但打开执行命名空间的 `http://127.0.0.1:4173` 返回 `ERR_CONNECTION_REFUSED`；未暴露公网端口、未调整安全策略。

因此：**真实 Chromium UI、实际页面刷新/移动布局、真实 DOM 故障注入尚未通过。没有验收截图。**

最终 `scripts/browser-test.mjs` 已完成语法检查，尚未在可启动 Chromium 的环境执行。它覆盖控制台多行、丢 ACK、重复推进、刷新保留、unknown 关闭保护、只读恢复、关闭、桌面/手机截图，以及独立合成 DOM 中的单击/ACK 丢失/刷新文档保护。其通过结果必须在新环境实际运行后再记录。

另外，离线生成依赖 lockfile 失败：Playwright 元数据不在 npm 缓存（`ENOTCACHED`）。没有伪造 lockfile、没有安装未经核实的依赖。运行服务和 167 项标准测试不受影响。

## v0.2 真实页面只读观察与扩展实现

通过已提供的受支持云浏览器工具，新建 ChatGPT 研究标签并只读检查输入控件：观察到 `contenteditable="true"`、`role="textbox"`、`aria-label="询问 ChatGPT"` 和同 form 内 `type="submit"`、`aria-label="发送"` 按钮。新标签仍可能显示共享未发送草稿，因此未改写、清空或发送；研究标签已关闭。仅通用控件属性进入源码，未保存草稿、聊天历史或账号信息。

这证明该时点这组控件属性存在，**不证明安装后的扩展 click 可用或稳定，也不证明工具已被调用**。未用 sandbox 被拒的路径重启 Chromium。MV3 源采用已核对的官方 Tabs / Scripting(documentIds, ISOLATED) / Storage / Permissions API，仍等待正常安装和真实验收。

独立审查提出的初次对话误绑定、背景按钮遮挡点击、选区跨草稿均已修复并有回归；最多两任务限制在 UI/README 显示，不把有限验证版称为持续生产队列。

## v0.3 强绑定、隐私与本地事务回归

- task↔canonical conversation 唯一绑定、原目标/完整消息摘要、账号/浏览器/tab/document 校验；并发抢同会话、错 URL、改目标、点击瞬间导航、重启均 fail closed。
- 原生用户消息 ACK 只表示 transport acknowledged；业务始终 unknown，聊天回复不证明 producer 完成。跨会话/账号/文档回复拒绝，默认只存摘要、来源、时序、截断和消息 ID。
- 真实 ChromeHost 的 send、dispatchVerified、execute(send) 均拒绝缺失的原生原子契约；UI disabled 不是唯一安全门禁。worker 重启也不信任持久化的发送许可。
- 刷新/浏览器重启后，独立 observationBinding 仅在可信原生新证明下恢复同账号、同会话观察；原 dispatch binding 不变、dispatchAllowed 为 false，不能恢复发送。合成测试已验证恢复后观察仍可用。
- JSON.parse 后递归检查、逐字符串 token 检查覆盖 Unicode 转义/嵌套/重复键；URL userinfo 拒绝；宿主异常只保留固定错误码，不让异常文本夹带凭据进入存储或 UI。不是完整密钥检测，不清理旧记录。
- create、pause/cancel、页面观察、回执/消息采集、只读重绑均候选提交；预算/写入失败不产生内存幽灵状态。外部创建/点击后的未知副作用另行保守保存，绝不回滚成可重试。
- 30 分钟 idle 建议已接入扩展控制器；稳定 ID、冷却与审计、跨重启去重；unknown/运行中/无权威状态只建议只读核查，未实现后台计时/自动续推。
- 独立只读审查复现的错误异常泄密、只读重绑幽灵状态及恢复后不可观察均已修复并加入回归。

## 从未执行 / 不应误称完成

- 已实现受控 Chrome bridge 和强身份 adapter 契约；**真实账号/原生消息证明 API 尚不可用，生产发送硬阻断。扩展实际安装/加载、用户来源授权、真实发送均未执行**。
- 真实 ChatGPT 多行发送、登录后页面选择器和 ACK 关联。
- 实际 WorkSpace invocation/provider 回执接线与 producer 验证。
- 真实外部任务取消、自动恢复、生产环境压力测试。
- 公开部署、GitHub repo 创建/上传、commit/push。

许可证已获 owner 批准并加入标准 MIT LICENSE，版权标注为 `2026 arthurwangwsx-code`，package.json 的 SPDX 字段为 `MIT`。此变更不代表已经上传或发布。

## 接续条件

1. 在允许隔离测试浏览器子进程的开发机运行 README 的 `test:browser`；不要附着现有用户 profile。
2. 先取得可信受支持的原生账号/会话/消息身份及原子发送契约（不能靠页面 JSON 或缓存伪造）；然后单独确认安装权限。真实 owner schema、来源与证据仍须当前核验。
3. 仅在用户单独创建的测试聊天/合成业务 scope 中进行真实全链路验收。`unknown` 没有证明前仍不得重发。
