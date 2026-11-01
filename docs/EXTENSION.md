# 受控 Chrome 扩展：人工安装与真实网页边界

`extension/` 是 Manifest V3 扩展源代码。它提供独立的浏览器本地控制台，通过 Chrome 官方 Tabs / Scripting / Storage / Permissions 接口操作用户明确授权的 ChatGPT 页面。**源代码存在不等于安装成功、页面映射有效或真实业务全链路已验收。**

扩展与 `npm start` 的合成演示是两个独立入口，不会通过 localhost 自动配对，也不会混用意图或测试回执。真实发送可能触发 ChatGPT 与用户选中的连接器操作，因此每条任务必须审阅具体文字、目标环境与权限。

## 真实发送当前默认硬阻断

当前真实 `ChromeHost` **缺少官方账号上下文与原生消息 ID 证明 API**，无法用可靠原生证据建立“本任务 ↔ 本会话 ↔ 本账号 ↔ 本文档”的绑定，因此实际 `send` 默认硬阻断，不会点击网页发送按钮。页面文字、URL、用户确认、DOM 属性和 JSON 声明都不能替代该原生证明。不能声称现在已经可以安全发送真实任务。

控制台显式显示 `binding.state`（`pending` / `verified`）、绑定 `conversationId`、原目标 `goalDigest`、实际发送文本 `wireDigest`、原生证据来源和缺口。「检查原生绑定（只读）」只向当前登记目标的宿主查询，当前真实宿主返回 unavailable。**旧 `user-confirmed` 只读恢复不等于 `verified`，不会解锁发送。**

发送按钮仅在意图为 `ready`、`binding.state === 'verified'` 且 `dispatchValidated === true` 时可能启用；每次后台初始化/重启都会将 `dispatchValidated` 清为 false，只有只读 verifyBinding 成功后才能恢复该标记。点击时后台仍需重新 fresh verify，并使用原子身份核验与发送契约。没有受支持的原生宿主接口就继续阻断，不能通过修改本地布尔值、换会话、跨账号或降级点击来“完成接线”。Node 合成 host 的 verified 只验证协议行为，不证明真实 Chrome 可用。

## 验证版容量边界

**最多 2 个未核验真实任务；当前没有权威 owner 自动完成接口，槽位不会自动释放。** 本版不是普通可持续调度器。当前真实发送因原生绑定证据缺口而硬阻断；若未来受支持宿主通过门禁尝试发送，点击成功仍不能当成可靠 ACK，发送后 `unknown` 保持保护，需在原生 WorkSpace 外部核验。不要通过删除本地记录、清除扩展数据或换键绕过容量。

## 用户指定的 Chrome Profile

目标是用户本地的默认 Google Chrome Profile，经用户在该浏览器正常安装并授权扩展。此项目不会自行读取 profile 目录或选择账号；云端研究浏览器不代表用户本地 Chrome。既有插件机制须另行只读核验，不能靠复制内部源码或凭据接线。

## 安装和权限

由用户在**自己选定的 Chrome / Chromium 浏览器与账号**中执行正常安装流程，不绕过企业策略或浏览器拒绝：

1. 检查 `extension/manifest.json` 与本说明；源码依项目根目录 MIT LICENSE 授权。
2. 先在固定工程目录运行 `npm run build:extension`，按 [构建说明](BUILD.md) 生成 `dist/extension`。仅在浏览器政策允许时由用户进入扩展管理，选择「加载已解压的扩展程序」并选择该固定输出目录；若该入口受策略拒绝，不绕过。
3. 检查浏览器提示，仅在同意其权限时继续；如果浏览器/管理员拒绝，停止并报告，不通过调试端口或其他浏览器绕过。
4. 点击工具栏扩展按钮打开「网页任务控制台」。扩展不会自动读取现有聊天。
5. 点击「授权 ChatGPT 站点」，通过 Chrome 原生权限提示批准 `https://chatgpt.com/*`。拒绝时不发送。可随时用「撤销站点访问」移除该站点权限。

权限设计应与实际 manifest 对照：

- `storage`：保存本地编排意图、关联信息与页面观察，不使用同步存储。
- `scripting`：只向扩展自己创建、登记且有用户站点许可的标签注入受限页面操作。
- 可选主机权限只限 `https://chatgpt.com/*`，由按钮触发原生申请；不能据此操作其他来源。
- 不申请全站 `<all_urls>`、广泛 `tabs` 读取、`cookies`、`webRequest`、`debugger` 或 `nativeMessaging` 权限。
- 不提取 cookie/token，不使用私有 ChatGPT HTTP API，不导出浏览器 profile，不访问 `.env`，不切换账号。

Chrome 的站点权限在能力上可能覆盖同源其他页面；本项目在应用层进一步限制到自建并登记的 tab 与文档身份。这种应用层限制不应被误说成浏览器权限模型本身只授予某一个 tab。

## 首次操作：只读验证，不绕过发送门禁

1. 在扩展控制台填写明确任务、目标环境、允许动作与停止点。先使用不含个人或内部业务信息的独立测试任务。
2. 保存意图：这一步不打开网页、不发送任务。原幂等键必须保留。
3. 点击该意图的「新建自有 ChatGPT 标签」；不要在此期间手动提交或导航到其他聊天。
4. 在新建标签中人工核对当前账号、页面状态和工具选择。需要 WorkSpace 时，按 ChatGPT 当前 UI 选择/提及实际可用的连接器。**纯文本 `@WorkSpace` 不是工具选中或可调用的证据。**
5. 回到扩展控制台，点击只读文本框选中完整 `wirePrompt`，手动复制；在自有 ChatGPT 标签中手动选择 WorkSpace 插件并粘贴全文。扩展**不会编辑 contenteditable 或共享草稿**。
6. 点击「只读检查页面」可观察 `draftEmpty` / `draftMatches` 与候选控件数量，不回传其他草稿正文。草稿匹配不是任务/账号/会话身份的原生证明。
7. 点击「检查原生绑定（只读）」，查看 pending/verified、内容摘要和缺口。当前真实 ChromeHost 返回 unavailable，发送按钮保持禁用；**在此停止发送，不手工篡改状态或换途径绕过**。只有未来受支持宿主真正提供并验证原生绑定后，才可能由 ready + verified + dispatchValidated 进入单次确认，后台仍会 fresh verify；此能力当前不能宣称已实现真实验收。
8. 对已有尝试记录，使用「只读检查页面」可能得到 `/c/` 对话 URL 候选，它只进入 `observedChatUrl`，**不会自动绑定 conversationId**。人工在原聊天核对任务和原键，再点击「确认并只读绑定/恢复聊天」，输入精确已核对 URL 并确认。默认值仅可来自现有已绑定 URL 或观察候选；不能自动猜测。
9. 首次对话身份绑定标为 `user-confirmed / unverified`。它只允许后续读取，不恢复发送权、不释放容量、不证明任务完成。
10. **人工 restore 不保证可以采集。** 采集 JSON 也要求 fresh native binding；当前真实 ChromeHost 缺少该证明，采集默认阻断。只有未来受支持宿主通过原生重新核验后，才可在绑定聊天手动选中所需 JSON 并单独确认采集。采集门禁为原 `binding.state === verified` 且 `dispatchValidated` 或 `observationValidated` 为 true；后者仅恢复观察，不能发送。即便采集成功，内容仍是未核验的候选，不证明业务完成；不自动抓聊天正文，片段不得含凭据或无关个人信息。
11. 打开/发送/恢复/采集不会被定时器重复执行；界面的定时刷新仅读取扩展本地状态。

扩展会附加可见标记：

```text
[web-task-console key=<原幂等键>]
```

它只帮助关联同一任务的页面发送记录，不是认证令牌或密码，不提供密码学来源证明，也不保证业务系统使用了这个幂等键。用户需在发送预览中确认自己同意附加该文字。

## 三层状态，不以聊天文字证明完成

- **本地意图**：queued / opening / ready / sending / sent / unknown / canceled 等记录只描述编排动作。
- **页面观察**：ChatGPT URL、conversationId、tabId、documentId、发送关联标记与页面可见的原生工具区域，只是 `external-observed`。
- **业务权威**：WorkSpace invocation 和真实 producer taskId/runId/sessionId，以及原生只读查询返回的可信证据，才可用于独立业务核验。

当前没有已验证的稳定公开原生回执读取 API，因此不猜测原生卡片选择器、不自动解析聊天正文。手工展开卡片并选择 JSON 只是未来通过 fresh native binding 后的受控采集入口，当前宿主不可据此绕过采集门禁；扩展不能证明所选内容确实来自原生工具而非模型生成或用户修改，因此扩展 UI 中的页面观察和原生回执候选一律标为 **unverified**。模型回复里的“完成”、一个成功提示、工具区域的 `completed` 或回执形状的 JSON，都不被升级为业务终态。当前 UI 不提供「手工设为成功」或导入任意回执作为可信来源的入口。

真实任务是否已被接受、正在运行或完成，需要通过原生 WorkSpace/owner 的只读接口核对原 invocation/provider 标识和任务关联。未经验证的候选字段不能当作可取消、恢复或关闭任务的授权。

## 同会话消息证据与空闲建议

「只读观察原生消息摘要」调用 `observeMessages`，只接受原生宿主的数据；当前真实宿主不可用。UI 不提供 `includeText` 开关，只保留最小摘要/身份元数据，不请求正文。控制台只显示可关联到当前 `taskId` 与已绑定 `conversationId` 的消息证据摘要、内容 digest、原生消息 ID、来源和顺序/观察时间，不展示其他任务或会话的记录。原生身份核验只证明消息归属，不证明业务完成；原始聊天内容与用户选择的 JSON 候选保持独立，不能升级为可信消息证据。

「检查 30 分钟空闲建议」调用本地 advisory policy。它不是定时自动发送器，不因聊天沉默推断失败，也不把页面轮询时间当作有效业务进展。每条意图展示 `lastIdleProposal` 的原目标、下一步建议、状态与时间，始终要求用户确认，`autoSendAllowed` 保持 false。若任务仍在运行、结果 unknown 或没有可信 owner 状态，只给出只读核验建议；不跨会话续推、不重发。即便用户同意建议，仍不能绕过缺失的原生绑定/权威状态门禁。

## unknown、刷新与恢复

- 在产生发送副作用前持久化发送意图。当前版本没有可靠公开 ACK 接口，因此即使点击成功也保持 `unknown`；超时、丢 ACK、service worker 中断同样保留保护。
- `unknown` 不自动重发，也不提供换键重发按钮。不要新建另一条同内容任务来绕过保护。
- 只读未找到消息/回执不等于证明没有发送；应检查原聊天和原生 owner。
- 页面刷新、文档变化、跨来源导航或已登记 tab 丢失不会被静默当成新的授权。不要依赖恢复出的 tabId 单独证明身份。
- 对已尝试发送的 `sending/sent/unknown` 意图，用户可输入并确认原任务的精确 `/c/` URL，只读绑定/恢复该聊天。首次绑定是用户确认的未核验关联，不是原生 owner 证据。
- 刷新后只对精确同一已确认聊天进行只读文档重绑；浏览器重启后可创建另一个自有只读标签。恢复路径永远不恢复发送权，不能用于重新提交任务。
- 如果受支持原生宿主重新取得可信 fresh proof，只读恢复可保存独立 `observationBinding`：固定原 task/conversation/account/goal，允许 tab/document/session 随恢复更新，并明确 `dispatchAllowed: false`；此时 `observationValidated: true` 仅恢复观察/采集。原 `binding` 不变，`dispatchValidated` 仍为 false，所以发送继续禁用。人工 `user-confirmed` 本身绝不产生这些原生核验权限。
- 扩展不自动关闭受管标签，也不自动取消后台业务。手动关闭网页不等于取消 WorkSpace 任务。
- 撤销站点权限后意图仍保留；这不会撤销已经发生的远端操作。
- 暂停控制只阻止后续扩展写操作，不会取消已发送任务。

## 本地数据与公开边界

保存内容可能包括任务原文、可见关联标记、对话 URL/ID、标签/文档 ID 和页面原生工具区域的观察片段。它们保存在当前浏览器扩展本地，不是加密保险库，也不应导出到公开仓库。

不要把真实数据用于共享截图、测试 fixture 或 GitHub issue。发布只包含源码、通用协议和合成数据；浏览器存储、真实聊天、回执、账号信息和任何登录材料都不得入仓库。

卸载/清除扩展数据会丢失本地去重和关联屏障，不能据此认为旧任务从未执行；重新安装后必须先用原生权威来源核查旧任务，不能直接重放。

## 验证状态与停止条件

最高优先级停止条件：当前真实宿主无法提供官方账号上下文与原生消息身份契约，真实 send 硬阻断。现有页面定位、人工粘贴或用户确认都不能弥补该缺口。

- 可以通过 Node 单元测试验证核心状态机、Chrome API 合成实现和页面操作的合成 fixture；这不证明当前 ChatGPT 页面定位有效。
- 当前执行环境启动 Chromium 曾被沙箱拒绝；没有重试该被拒绝路径或绕过安全策略。
- 未通过正常加载/权限流程及真实浏览器 UI 验证前，不能声称扩展已安装、已配对或已可操作真实账号。
- 未取得真实 WorkSpace invocation 与 producer 的独立证据前，不能声称真实端到端任务完成。
- 找不到唯一输入框/发送按钮、读回不一致、登录/确认拦截、文档身份变化或无法可靠关联 ACK 时，必须 fail closed，不猜定位、不降级为 Enter 发送、不自动重试。扩展不通过猜测编辑事件修改共享草稿；输入完全由用户手动完成。

完成真实验收至少需记录：浏览器与扩展版本、授权来源、页面映射版本、合成任务原键、一次发送证据、conversationId、原生 invocation/provider 回执、刷新/ACK 丢失下不重发结果，以及未验证部分。所有真实平台验证均在用户批准的独立测试范围中进行。

## 官方接口参考

- [Chrome Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [声明扩展权限](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
