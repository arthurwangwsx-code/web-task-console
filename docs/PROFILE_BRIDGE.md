# Profile / Target / Lease 路由边界

目标是用户选定的本地 Google Chrome 默认 Profile，通过其正常授权的浏览器插件连接。**“默认 Profile”是用户的选择，不是本项目已经核验的事实**；不会把云端浏览器、某个活动标签或单个可用连接默认为用户本机 Default。

## 可参考的公开架构

Chrome 支持扩展经 Native Messaging 与已注册的本机宿主通信，宿主通过标准输入/输出交换消息。注册清单可限制允许的扩展来源；扩展需声明 nativeMessaging 权限。这些是官方传输机制，不提供 ChatGPT 会话/消息语义。[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

可选桥接架构为：用户授权的 MV3 扩展 → Native Messaging host → 本地受保护 IPC → 已授权 runtime。具体 runtime、socket、注册与安装必须另行核验；本项目没有实现/安装 native host，没有读取任何已有 profile、凭据或内部插件源码。现有 extension manifest 也未新增 nativeMessaging 权限。

## 四种身份必须分开

| 身份 | 可证明或关联的对象 | 不能据此推定 |
|---|---|---|
| profileId | 已连接扩展/桥接的逻辑 profile 标识 | Chrome 目录名 Default、当前 ChatGPT 账号 |
| targetId + tabId | 该 profile 中登记的浏览器目标 | 任务属于该聊天、原生消息已发送 |
| connection generation + browser_page lease | 当前连接/操作租约的有效范围 | 跨重连长期授权、业务没有运行 |
| invocation / RPC request ID | 一次工具或桥接调用 | ChatGPT native message ID、producer 业务完成 |

targetId 应从可信桥接返回值原样保留，不自行拼接、解码或根据命名猜测。接线方应把桥接已核实的 profileId、tabId、targetId 关系规范化；此纯模型不宣称实现任何现有工具的编码协议。

## 本地纯契约

src/profile-target-binding.mjs 提供纯路由守卫，不执行浏览器命令、MCP、IPC 或租约申请。输入由授权 host adapter 规范化，不能来自网页 JSON 或任意用户 claims。source 字符串只是类型标签，不是认证。

- 多个 profile 而无显式选择时拒绝；唯一 profile 也不被自动标成 Default。
- 记录精确 profile/target/tab/连接 generation；browser_page 租约必须匹配该 profile/target 且未过期。
- 每次使用前重新比对当前上下文；重连、target/tab 变化、租约轮换/过期均 fail closed。
- 显式确认可在新的可信上下文恢复**只读观察**；不会恢复发送，不将 unknown 变为可重试。
- 所有返回路由都保持 authorizeSend:false；路由校验不能替代 extension/task-binding.mjs 的任务/账号/canonical conversation/消息证据门禁。

租约模型是本项目的规范化接口，不是已验证的远端参数 schema。实际 lease 名称、字段、期限与 target.restore 语义尚须按部署版本核验；不能以此文档猜测 RPC 参数。

## 接线验收清单

1. 由用户确认本机浏览器与目标 Profile；在多个连接间精确选择，不通过读取 profile 目录或 cookie 识别账号。
2. 分别记录安装扩展、native host、runtime 的版本/构建指纹；源码版本不能被当作运行构建版本。
3. 通过正常审批确认插件及 host 注册权限。拒绝或不明确时停止，不通过另一调试入口绕过。
4. 核对目标清单、profile/target 绑定和 lease API 的实际 schema；在每次操作时校验有效租约和当前连接。
5. 单独验证 tab.list/open、page.snapshot 等只读/创建范围；page.type/click 是写操作，不能因租约可用就当作已授权发送。
6. task↔URL↔Tab 一一绑定、原文摘要、导航瞬间校验、真实消息/回执和业务 owner 状态仍须独立验收。没有语义 send/reply 契约时保留 unknown；不把桥接 RPC 回包当作发送 ACK。

本项目当前没有把上述桥接接入真实发送。纯模型和合成测试仅验证本地不变量，不证明已连接用户的默认 Chrome。
