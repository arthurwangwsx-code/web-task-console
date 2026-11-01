# 适配器边界与真实平台接入

本版本的服务器运行的是**合成演示**。以下模块是可测试的替换接口，**不是已经配对的浏览器扩展，也不是已经连通的 WorkSpace 客户端**。不包含真实账号、工具地址、内部业务代码、凭据、Cookie 或 Token；不会自动安装扩展、连接调试端口或访问用户浏览器配置。

## 三个独立事实层

1. **本地 orchestration intent**：希望发送什么、是否尝试过发送、标签关联、观察缓存。它不是业务任务账本。
2. **Browser / router**：页面显示已发送、工具调用获得 invocationId、router completed。都不能证明业务已完成。
3. **业务 owner**：准确 taskId / runId / sessionId 所对应的 producer 结果以及可核验的证据。已有业务运行、锁、重试和恢复仍归原 owner；不能在本项目重建一份竞争权威。

本地幂等键只能减少重复请求。它不是跨重启、跨服务、无限保留期的 exactly-once 承诺。先持久化 `sending` 再调用浏览器；崩溃/超时后先只读查询，不可直接重新发送。

## BrowserAdapter（仅 loopback 合成发送；真实外发已硬禁用）

```js
import { BrowserAdapter } from './src/browser-adapter.mjs';
const browser = new BrowserAdapter({
  driver: approvedHostBridge,
  allowedOrigins: ['http://127.0.0.1:4173'], // 独立合成 fixture
  allowExternal: false,
});
const tab = await browser.openOwned({ url: 'http://127.0.0.1:4173/fixture', ownerId: intent.id });
// 必须先把 intent 的 sending 状态与 tab 关联持久化。
const result = await browser.sendOnce({ ...tab, origin: 'http://127.0.0.1:4173', idempotencyKey: intent.idempotencyKey, prompt: intent.prompt });
```

旧 BrowserAdapter 的 fill/read/click 接口只用于 loopback 合成 fixture。即使配置 allowExternal:true 和精确允许来源，sendOnce 也会拒绝真实外发，因为该旧接口没有原生账号、任务/会话身份与原子发送契约；不能用它绕过扩展强绑定门禁。

真实接入使用 v0.3 独立扩展 controller + task-binding 协议，详见 [BINDING.md](BINDING.md) 与 [EXTENSION.md](EXTENSION.md)。Chrome 官方 API 实现目前仅具备自有标签/文档的只读操作；真实 ChromeHost 缺少已验证原生账号/会话/消息身份接口，三个发送入口均硬拒绝。任何未来 bridge 均不得提取认证、使用私有 ChatGPT HTTP 接口或绕过登录/风控/管理员限制。

以下是 loopback fixture 宿主契约，不足以接真实平台：

| 方法 | 参数及约束 |
|---|---|
| `openTab` | `{url, ownerId}`；必须新建标签，绝不复用用户标签；返回 `{tabId,url,documentId}`。不确定创建结果不自动重试。 |
| `readTab` | `{tabId}`；返回当前 `{tabId,url,documentId}`；只读，不重新绑定标签。 |
| `fillComposer` | `{tabId,documentId,expectedUrl,idempotencyKey,text}`；定位唯一已验证输入框、替换全文保留换行；绝不隐式提交。 |
| `readComposer` | 同一 guard；返回实际完整字符串，不标准化换行或省略空白。 |
| `clickSend` | 同一 guard；宿主必须将 documentId / URL 检查和唯一发送按钮点击绑定到同一文档；只点一次，不以 Enter 作为降级路径。 |
| `observeAck` | 同一 guard；限定时间只读观察；仅有匹配任务关联证据时返回 `{acknowledged:true,idempotencyKey,chatUrl?}`。看见一个通用气泡或按钮变化不足以关联。 |
| `closeTab` | `{tabId,documentId,expectedUrl}`；再次验证绑定后关闭；不调用任何 cancel-job 接口。 |

每一个宿主调用都应有有界超时，并区分“观察超时”与“执行未发生”。若当前官方宿主无法满足原子文档守卫、唯一目标或可靠 ACK 关联，应报告能力不足，停止该操作，不降级猜测。

页面选择器应由独立、版本化、经过真实 UI 验证的映射提供；当前没有可宣称稳定的 ChatGPT DOM 选择器。登录、确认框、页面更新、DOM 歧义或跨来源导航均 fail closed。未确认实际浏览器家族和授权设备前不可接线。

### 标签和发送保护

- 仅接受本 adapter 实例通过 `openOwned` 建立的句柄。
- 来源精确允许列表，默认外部来源关闭；来源允许列表本身不会授予权限。
- 文档 ID、完整 URL 和 owner 不匹配即拒绝；刷新后不会静默重绑，更不会重发。
- 填写后逐字读回，再单击发送。包括超时、ACK 丢失在内的异常统一保留 `unknown`；同键再次调用返回原结果，不再点击。
- adapter 的额外发送去重记录仅在内存；**跨进程恢复必须依赖引擎已持久化的 intent 守卫**。不能构造新 adapter 后直接重放旧发送。
- `safeClose` 只允许 `dispatchState: sent`、已验证 producer 终态及相同文档句柄。unknown、运行中、未核验、非自有标签均保护。关闭标签与取消任务完全独立。
- 页面刷新/浏览器重启后的旧句柄需人工检查；本版本没有恢复授权或重绑入口。可以继续只读查询业务 owner，不需要标签存活。

## WorkspaceObserver（只读）

```js
import { WorkspaceObserver } from './src/workspace-observer.mjs';
const observer = new WorkspaceObserver({
  source: 'approved-owner-instance',
  readByKey: ({idempotencyKey}) => approvedReadByKey(idempotencyKey),
  readByInvocation: ({invocationId,idempotencyKey}) => approvedReadInvocation(invocationId, idempotencyKey),
  readProvider: ({taskId,runId,sessionId,idempotencyKey}) => approvedReadProducer({taskId,runId,sessionId,idempotencyKey}),
});
```

这些回调应封装当前连接器**实际发现并核对 schema 的只读接口**；不猜测 endpoint，不把示例名字当成既有 MCP 能力。`readByKey` 与 `readByInvocation` 至少配置一个；只有后者且无 invocationId 时返回 null、零调用。回调不得调用 prepare/start/retry/cancel 或写入。ISpec/DevSpace 仅为可选 owner 适配，不是运行依赖，也不会自动导入内部包。

回调将真实响应转换为下述显式结构：

```json
{
  "idempotencyKey": "synthetic-key",
  "invocationId": "synthetic-invocation",
  "source": "approved-owner-instance",
  "observationId": "synthetic-observation",
  "observedAt": "2026-01-01T00:00:00Z",
  "router": { "state": "completed" },
  "provider": {
    "taskId": "synthetic-task",
    "runId": "synthetic-run",
    "sessionId": "synthetic-session",
    "state": "succeeded",
    "evidence": {
      "authoritative": true,
      "source": "approved-owner-instance",
      "reference": "synthetic-producer-receipt"
    }
  },
  "verified": true
}
```

顶层 `verified: true` 表示**整个观察来自已授权、核对身份的只读 authority**，而不是任务完成。只有 router 的可信观察也可以进入缓存。它不能由聊天文字、预览恢复计划、页面成功 toast 或用户随意填写产生。该模块校验结构/关联，不会把一个布尔值变成可信证明：接线方仍需验证 source 身份与证据引用。业务完成另外需要 provider 终态、确切 ID 和 `provider.evidence` 中独立的 authoritative 证据；不能只检查顶层 verified。

可选 `readProvider` 返回 producer 字段、原 `idempotencyKey`，并且必须返回本次 producer 观察的 `observationId`、`observedAt`、`source`、`verified`。所有已知 provider ID 必须保持一致；禁止把 sessionId 当 runId。adapter 将 router/producer 两个观察 ID 编码为一个无歧义组合 ID，并使用 producer 的观察时间，因此 producer 状态变化不复用旧 router ID。provider 响应缺有效来源/观察 ID/时间会报错；即便 router 已核验，未核验的 producer 也会使组合观察 verified 为 false，且不会附加 authoritative evidence。接线方必须确保新状态使用新观察 ID，不能在同一 ID 下修改内容。

初始查询找不到结果、缺来源/时间/观察 ID 时返回 `null`（没有可接纳的新观察），由引擎保持原状态并退避；不生成伪造 receipt。键或已知 invocationId/provider ID 不一致抛错，不接受误关联。provider 只有 `succeeded` 字样但无可信证据时，观察本身可以 verified，但其 evidence 缺失，**绝不可视为已核验业务终态**。router completed 不生成 provider 对象。实际工具拒绝、权限错误、超时交由上层退避与人工接管，不重发写操作。

## Profile / target / lease 路由

未来可信浏览器 bridge 应规范化 profile、opaque target、tab、连接 generation 和 browser_page lease；它们只是浏览器路由，不是 ChatGPT 身份。多 profile 模糊、重连、租约过期必须停止。纯接口与部署验收边界见 [PROFILE_BRIDGE.md](PROFILE_BRIDGE.md)。未接实际 MCP 发送，不复制内部实现。

## capability_status 的窄只读适配

`CapabilityStatusObserver` 仅调用 capability_status({invocationId}) 并处理 structuredContent.data。没有已验证的 readByKey 时不冒充存在；没有 invocationId 就没有观察，不再次 invoke。succeeded 只映射 router completed，结果默认 external-observed/verified:false，不生成业务终态；调用证据保留最小元信息和摘要。见 [CAPABILITY_STATUS.md](CAPABILITY_STATUS.md)，包括将来认证服务端 host metadata 的隐私、版本与部署核验边界。

## 接真实环境前的验收门槛

1. 用户指定并核验设备、浏览器、账号、连接器、目标工程和允许来源；扩展安装或权限新增需单独批准。
2. 在用户创建的测试聊天、独立合成任务上验证读回、多行发送、ACK 关联与真实 owner 回执链；禁止用生产任务做故障注入。
3. 验证刷新、标签重建、浏览器/控制进程重启、发送超时后查原键、容量满；确认 owner 不会因页面关闭被取消。
4. 记录 adapter/selector/connector schema 版本、真实证据和未验证范围。验收前保持 demo 默认，禁止自动外发。

已实现单测覆盖安全门禁与结构约束；**真实 ChatGPT → WorkSpace → producer 全链路尚未验证**。

官方 API 参考：
- https://developer.chrome.com/docs/extensions/reference/api/tabs
- https://developer.chrome.com/docs/extensions/reference/api/scripting
- https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
