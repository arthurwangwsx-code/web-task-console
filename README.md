# Web Task Console

**一个本地优先、独立且可迁移的浏览器任务控制原型。v0.3 提供两个隔离入口：本地合成演示，以及需人工授权的真实 Chrome 扩展验证版。**

用于验证：网页发送意图、任务关联、真实 owner 回执观察、容量控制与安全恢复如何协作。它不是新的业务执行引擎，不替代 ISpec / DevSpace / WorkSpace 已有任务账本、锁、租约或恢复能力。

## 立即运行

### A. 真实网页受控扩展（验证版）

`extension/` 使用 Chrome 官方 MV3 API。先在固定工程目录执行 `npm run build:extension`，可重复输出到该工程的 `dist/extension`；正常加载/重载选择此固定目录。详见 [BUILD.md](docs/BUILD.md)。按照 [EXTENSION.md](docs/EXTENSION.md) 正常加载源码并明确批准唯一可选站点 `https://chatgpt.com/*`。不需要 Node 服务或 localhost 配对。

**当前真实发送硬阻断，不是已接通真实任务的产品。** Chrome 官方 Tabs/Scripting 能确认标签、URL 与 documentId，但当前没有已验证的原生账号、会话归属、消息 ID 及点击边界原子校验契约。为满足“任务目标与会话绝不能串”的要求，真实 ChromeHost 的 send / dispatchVerified / execute(send) 三个入口均拒绝发送；人工确认 URL、网页正文或 JSON 都不能替代原生证明。

可实际使用的本地流程：保存意图 → 经用户授权新建自有 ChatGPT 标签 → 只读检查页面与绑定缺口 → 查看原目标、完整消息预览、SHA-256 摘要与本地审计。生产发送、原生消息采集和业务完成核验仍需接通可信 adapter 并单独验收。**扩展尚未安装，真实 ChatGPT → WorkSpace → producer 端到端未通过。**

已实现不可变 task↔canonical conversation 一一绑定协议、原生账号/浏览器/document 全上下文校验、发送前与原子发送边界双重门禁、同会话消息证据与恢复协议。合成 host 验证了这些路径，但不冒充官方身份 API。详情见 [BINDING.md](docs/BINDING.md)。

不编辑共享草稿、不读 cookie/token、不调用私有接口、不导入用户已有标签。已尝试任务刷新/重启后，只有新的原生证明才能恢复同账号/会话的**只读观察**，永不恢复发送权；人工 URL 恢复仅是未核验候选。没有可靠 ACK 就保持 unknown，不能换键或清存储绕过。最多 2 个未核验活跃任务，当前没有权威 owner 自动完成接口，槽位不会自动释放。

30 分钟无本地进展证据变化时可手动执行 `idleCheck`：按稳定建议 ID 去重、冷却、保存审计和带原目标/下一步的待核验草稿。unknown、进行中的工具或缺少权威状态均阻止续推。**无后台计时器、无自动发送、无自动续推**；详细边界见 [IDLE.md](docs/IDLE.md)。

### B. 完全本地的合成演示

需要 Node.js **24+**。运行与单元/集成测试 **无第三方依赖，不必先 npm install**。

```bash
npm start
# 浏览器打开 http://127.0.0.1:4173

npm run check
npm test
```

端口可通过 `PORT=4180 npm start` 修改；数据目录可通过 `CONSOLE_DATA_DIR=/private/path npm start` 指定。服务仅绑定 `127.0.0.1`，不支持公共托管或远程多用户部署。

### 三分钟演示

1. 保留合成任务文字，选择「丢 ACK」。点击「仅加入队列」：此时没有发送。
2. 点击「推进一步」：模拟 provider 已接受，发送 ACK 丢失，显示 `unknown`。
3. 再次推进、刷新页面或重启服务：**不重发**，原幂等键保持；未知任务占用容量，标签关闭被保护。
4. 点击「只读回查」：按原键读取模拟 provider 的独立回执，才恢复关联并核验业务终态。
5. 点击「受保护关闭」：只关闭该已核验完成意图的模拟标签，不取消业务。
6. 新键测试「仅路由完成」：router `completed` 仍不证明业务成功，不能关闭其标签。

> `npm start` 控制台的「受管标签」仍是**合成标签模型**，并未创建真实 ChatGPT 标签。真实网页只读控制仅在独立的 `extension/` 中，经正常安装和站点批准执行；发送还受缺失原生证明的硬门禁。把演示模型当成真实平台证据是错误的。

## 已实现

- 扩展严格绑定：不可变 task/goal/wire 摘要、唯一 canonical conversation、原生账号与上下文校验；pending/冲突/unknown 不发送。
- 本地只读观察缓存：消息 ID/来源/时序/截断及摘要，正文默认不留；选定 JSON 始终未核验，不能证明业务完成。
- 隐私与事务回归：解码后递归过滤可疑凭据形状（含 Unicode/重复键）、URL userinfo 拒绝、固定错误码、候选状态先预算后提交；非完整密钥扫描。
- 中文本地控制台：多行任务、手动队列推进、三层状态、原键回查、受保护关闭、刷新保持。
- 单写者文件锁，原子写入与 fsync；**先持久化 sending，再调用外部动作**。
- `idempotencyKey + payload fingerprint`：同键同内容复用、异内容冲突；崩溃中的 sending 恢复为 unknown，不能自动重放。
- 意图数、排队数、活跃数、每 scope 活跃数、受管标签数、回执容量多维背压；按 scope 轮转选取可执行意图，带发送间隔。
- 观察失败指数退避与 jitter；只读查询找不到不等于未执行；未知保留写保护与容量。
- 浏览器页面 / 路由调用 / producer 业务状态严格分离，taskId、runId、sessionId、invocationId 分字段。
- 终态必须来自本次可关联的、已核验来源的 producer 证据；不继承旧证据、不接受陈旧观察、矛盾 ID 或聊天文字。
- BrowserAdapter：精确来源、只操作自建标签、文档绑定、多行逐字读回、单次点击、丢 ACK 不重发、刷新拒绝、关闭保护。
- WorkspaceObserver：可选原键 / invocation / producer 只读回查；支持 invocation-only，无 ID 不查询。独立 CapabilityStatusObserver 只投影调用状态，保留最小调用证据，绝不将 router 成功升级业务完成。见 [CAPABILITY_STATUS.md](docs/CAPABILITY_STATUS.md)。
- 本地 HTTP 同源 / Host / CSRF / CSP / 请求大小限制，无 CORS、遥测、外部脚本或凭据访问。

## 架构与权威边界

```text
本地 UI → 意图队列 / 观察缓存 → 浏览器发送 adapter → 已授权网页
                    ↑                                  ↓
                    └── 只读 owner observer ← router + producer 回执
```

本地 dispatch：`queued → sending → sent | unknown`。仅未发送意图可取消。

router：独立的 `queued/running/completed/failed/...`。

provider：独立的 `unobserved/queued/running/succeeded/failed/canceled/unknown`。

`sent ≠ router completed ≠ business succeeded`。UI 显示的完成结论是证据投影，不是改变 owner 状态。`close-tab ≠ cancel-job`。没有自动取消真实任务的路径。

本地幂等键不是永久 exactly-once：保留期、owner 的去重策略、不同工具/账号、人工改键都会影响保证。不能因为回查没有结果就换键重发。

## 数据与安全

- `.data/` 保存本地任务内容与回执、合成 provider 状态，文件默认 0600、目录默认 0700；**不是加密存储**。
- 不存 cookie、登录 token、浏览器 profile，不读 `.env`、钥匙串或第三方私有目录。认证只能留在用户授权浏览器/官方连接器。
- 数据目录、日志、截图、node_modules 均排除出源码。请不要把真实任务内容放入公开仓库。
- 当前缓存上限 200 intents、2000 观察、每意图 16 观察；达到上限停发，不静默删除幂等记录。审计最近 400 条。不提供自动 TTL 清除，避免丢失去重屏障。
- 不要删除未知任务记录或不确定是否存活的锁。崩溃留下 `.lock` 时，先确认旧进程已终止、保留原 JSON，再人工删除对应锁文件后重启；启动会将残留 sending 变成 unknown。**从备份恢复旧账本可能导致重复；不得直接继续发送。**
- 单机、单用户、单写者；不能抵御同用户恶意本地进程、浏览器扩展或被入侵操作系统。CSRF token 仅是本地控制令牌，不是平台登录凭据。
- 关闭结果未知保留 `close-unknown`，不能盲目再关闭；当前需人工在原浏览器核查，没有自动重新绑定/解除保护入口。

## 真实平台接入（身份与权威回执契约缺失，发送默认禁止）

详见 [ADAPTERS.md](docs/ADAPTERS.md)、[PROFILE_BRIDGE.md](docs/PROFILE_BRIDGE.md) 与 [EXTENSION.md](docs/EXTENSION.md)。Node 默认入口仍硬接合成 adapter；独立扩展使用官方 Chrome API。HTTP 不提供切换真实账号、执行任意 shell、导入回执或设置外部 URL 的接口。

生产接入仍需**验收官方 Chrome bridge**、来源/设备/账号确认、页面定位，以及另行接通真实 owner 的结构化回执读取和来源验证。当前页面编辑由用户完成；生产扩展不会单击发送。未来可信 host 必须在点击瞬间原子验证账号、会话、document 与逐字草稿，不声称自动选择 WorkSpace。扩展安装/新增权限必须先获得用户批准；不连私有 ChatGPT API、不提取会话、不绕过登录或风控。不假设一个被发现的 connector 就已可调用。

现有 ISpec / DevSpace 可选，只接读状态或已验证的浏览器控制，不自动导入包、不改内部代码，不创建竞争执行账本。

## 测试

`npm test` 为 Node 内置测试器，覆盖状态机、adapter 合成驱动、HTTP 安全、多行、丢 ACK、进程重启、unknown 标签保护和队列背压。

可选真实**合成 Chromium**测试：

```bash
npm install --ignore-scripts
npx playwright install chromium
npm run test:browser
# 若已有兼容的测试 Chromium：CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

此测试创建隔离临时浏览器 context，不附着已登录用户 profile，完全不访问真实平台。输出截图到被忽略的 `artifacts/`。开发依赖固定 Playwright 1.62.1；当前环境无法从离线缓存生成 lockfile，尚无依赖完整性锁，不建议直接用于生产供应链。

见 [验证报告](docs/VALIDATION.md)：当前 167 项核心/adapter/HTTP/Chrome API 合成测试通过（包括唯一强绑定、身份/导航竞态、消息污染、只读恢复、存储失败与凭据形状过滤回归）；真实合成浏览器受执行环境限制阻断；**真实 ChatGPT → WorkSpace → producer 全链路未验证**。不要把单元测试成功称为真实平台验收。

## 文件导航

| 文件 | 作用 |
|---|---|
| `extension/task-binding.mjs` | 原生强绑定、消息关联、只读恢复上下文 |
| `extension/idle-policy.mjs` | 30 分钟建议、unknown/运行中门禁和冷却 |
| `src/engine.mjs` | 意图状态机、容量、观察投影、标签保护 |
| `src/store.mjs` | 单写者锁与原子持久化 |
| `src/demo-adapter.mjs` | 独立合成 provider，绝不调用外部平台 |
| `src/browser-adapter.mjs` | 可替换的受支持浏览器宿主接口 |
| `scripts/build-extension.mjs` | 显式清单、确定性构建、固定 dist/extension 与旧输出保护 |
| `src/profile-target-binding.mjs` | 多 Profile 选择、opaque target、租约与只读重连守卫 |
| `src/capability-status-observer.mjs` | 只读 capability_status(invocationId) 投影、最小证据与摘要 |
| `src/workspace-observer.mjs` | 可替换的只读 owner 观察器 |
| `src/server.mjs`, `public/` | 本地服务与中文控制台 |
| `test/`, `scripts/browser-test.mjs` | 单测、HTTP 集成与合成浏览器测试 |
| `extension/` | 独立 Chrome MV3 控制台、窄权限真实页面桥接与持久化保护 |

## 公开前检查

本地构建不会自动创建/上传 GitHub 仓库、commit/push 或部署。`private: true` 防止误发 npm，不改变源码许可证。公开前由 owner 确认 GitHub 身份、可见性与项目名称，做 secret/privacy 扫描、生成依赖 lockfile、在可用测试机运行浏览器验收；只发布通用协议与合成 fixtures，不加入内部路径、工程文档、聊天记录或回执。

## 许可证

本项目采用 [MIT License](LICENSE)，SPDX 标识为 `MIT`。Copyright (c) 2026 arthurwangwsx-code。许可证已获 owner 确认；第三方开发依赖保留其各自许可证。
