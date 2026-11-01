# WorkSpace invocation 只读回查适配

src/capability-status-observer.mjs 是独立、无网络实现的只读 adapter。它依据已提供的 capability_status({ invocationId }) 返回形状做纯投影；**本项目没有因此配对真实 WorkSpace、调用真实任务或开启浏览器发送**。原生身份/原子发送缺口不变。

## 已知边界与明确不做的事

- 工具参数仅传精确 invocationId，不传幂等键查找参数、不枚举 provider/runtime。
- 目前没有已验证的 readByKey。缺少 invocationId 时直接返回 null，上层维持 unknown；找不到结果同样不证明没有执行。
- 不提供 invoke/start/retry/cancel；绝不再次 invoke 原键来冒充只读查询。每次调用只读一次，无自动重试。
- principalId 是调用系统的主体标识，不是 ChatGPT 账号、Chrome Profile 或对话身份。默认只保留 SHA-256 摘要。
- providerId 是能力路由的 provider 标识，不是业务 taskId/runId/sessionId。status: succeeded 只映射为 router.state: completed，不生成业务 provider 或完成结论。
- 返回值没有原幂等键/ChatGPT URL/原生消息身份的独立证明。本地键只作原 invocation 关联上下文，因此输出始终 external-observed / verified:false，不能清除 unknown、释放容量或授权继续发送。

## 使用

    import { CapabilityStatusObserver } from './src/capability-status-observer.mjs';
    const observer = new CapabilityStatusObserver({
      source: 'approved-workspace-instance',
      capabilityStatus: args => approvedCapabilityStatus(args),
    });
    const observation = await observer.observe({
      idempotencyKey: 'synthetic-key',
      invocationId: 'inv_synthetic',
    });

approvedCapabilityStatus 只是接线占位名，不是本项目提供的函数或已发现端点。必须在授权环境注入已核对的只读 MCP 调用；身份、设备、授权和 schema 版本须在部署前独立核验。mapCapabilityStatus(envelope, context) 可单独用于无 I/O 的投影测试。

已有通用 WorkspaceObserver 也支持仅配置 readByInvocation。未配置 readByKey 且没有 invocationId 时不会调用任何回调。该通用类仍要求自己既有的来源/关联证据契约；不能把本 adapter 的本地键回填视为远端确认。

## 输入与证据

只接纳 structuredContent.data，不从 content[].text 解析或回退。去标识形状：

    {
      "structuredContent": {
        "data": {
          "id": "inv_synthetic",
          "principalId": "local:synthetic",
          "capabilityId": "synthetic.system.status",
          "providerId": "synthetic.system.control",
          "status": "succeeded",
          "queuedAt": "2026-01-01T00:00:00Z",
          "startedAt": "2026-01-01T00:00:01Z",
          "finishedAt": "2026-01-01T00:00:02Z",
          "result": {}
        },
        "meta": { "requestId": "synthetic-read-request" }
      }
    }

严格比较请求 invocationId 与返回 data.id；不匹配拒绝。时间、路由标识、结构/深度/大小都有边界。已知枚举保守映射为 queued/running/completed/failed/canceled；其它状态为 unknown，不猜测新版本语义。除已研究的 succeeded 返回外，其余枚举映射只经合成测试，部署时仍需验证实际契约。

返回 callEvidence 包括请求/返回 invocationId、操作名称、路由标识、状态、requestId（如有）、时序和摘要，可由调用方持久化进私有观察缓存。result、principal 原文、冗余文本、任意 _meta 与其它字段不默认保存；不会从 result 抽取貌似业务完成的内容。错误仅返回受控代码，不回显上游异常正文。

摘要用于比较证据，不是加密存储，也不是匿名化保证；低熵值可能被猜出，摘要及路由元信息仍应视为私有运行数据。禁止把真实证据、摘要、浏览器状态或账号关联表放入公开仓库。

## 未来可选的已认证 host metadata 接口

官方文档列出 MCP 调用中的 openai/subject、openai/session、openai/organization 匿名标识，用于用户/同一 ChatGPT session 的调用关联。它们**不是已知的 /c/UUID、原生消息 ID 或浏览器 documentId**，不能直接填入现有强绑定字段。[OpenAI Plugins Reference](https://developers.openai.com/plugins/reference)

未来只可由受用户授权、已认证的服务端接收真实 request context；不能信任模型参数、用户 JSON 或 DOM 中同名字段。服务端仍须验证凭据、权限和作用域；声明 schema 或字段本身不证明身份安全。[OpenAI Authentication](https://developers.openai.com/plugins/build/auth)

本项目尚未验证当前 WorkSpace 是否传入这些字段，也未实现/部署服务端 metadata adapter。若以后采用，应记录 connector/host/schema 版本、字段是否缺失/变化、匿名值的作用域与保留期，最小化保存且不公开导出。仍需独立证明 task↔URL↔Tab↔账号↔原生消息的关系和原子发送边界；这些匿名字段本身不解锁任何发送。

用户指定的默认 Google Chrome Profile 必须由用户在其本地 Chrome 正常选定并授权扩展。本项目不读取 profile 目录或凭据；云端研究浏览器不能被视为用户本地 Chrome，也不提供任何内部插件源码。
