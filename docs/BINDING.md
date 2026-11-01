# Fail-closed task / conversation binding

The local ledger stores orchestration intents and an observation cache. It is not
Workspace / business-run authority. A chat response saying “done” is not a native
business completion receipt.

## Current safety boundary

Chrome Tabs and document IDs identify a browser page, **not** the signed-in ChatGPT
account or a native message. The default Chrome host cannot supply the native
identity contract below. Real sending must remain disabled in that case. Neither
a URL pasted by the user, manually selected receipt JSON, DOM text, nor a page
claim is a verified binding. These may only be stored as unverified read-only
observations. No account cookies, tokens, or private APIs are accessed.

`source: "native-host"` is a type discriminator, not authentication. These helpers
must be called only with a response obtained directly from a trusted host adapter
whose official identity contract has been independently validated. They must not
be exposed to page messages or arbitrary JSON import. Mock native-host fixtures
prove local invariants only; they do not establish that such a real verifier is
available or that ChatGPT / Workspace end-to-end execution works.

## Contract

- `createPendingBinding(intent)` hashes `prompt` (task goal) and `wirePrompt`
  (exact send text, including newlines and marker) with SHA-256. Task ID,
  idempotency key and both digests become immutable.
- `bindVerified(intents, intent, proof, context)` accepts only a native proof
  containing `available: true`, `source: "native-host"`, `reference`,
  `accountContextId`, `conversationId`, `tabId`, `documentId`, `browserSessionId`
  and `url`. The account context must be a non-secret opaque identity, never an
  authentication token. Context independently supplies tab, document, session,
  URL and optionally account context.
- URLs must be exact `https://chatgpt.com/c/<conversationId>` canonical URLs,
  without credentials, query, fragment, trailing slash or encoded aliases.
- The returned `intent.binding` is immutable. Even an account difference cannot
  permit another task to use the same canonical conversation ID. Completed
  intents retain their reservation; no silent reassignment is allowed.
- Pure functions cannot lock concurrent callers. The controller must serialize
  bind/dispatch operations and call `assertUniqueBinding(candidate.intents,
  intent.id, binding.conversationId)` inside the candidate-state transaction
  before committing. Two successful stale-snapshot proposals are not two
  successful commits.
- `verifyDispatchBinding(intent, binding, freshProof, context)` recomputes both
  digests and checks every identity immediately before dispatch. It does not
  authorize a send or reset an attempt. The controller separately enforces queue,
  capacity, lifecycle and one-shot rules, including never retrying `unknown`.
- A refreshed document, new browser session, replaced tab, changed account or
  changed conversation fails closed. A restart does not legitimize old evidence;
  the stored binding must match a fresh native proof in the same context.
- The host must additionally validate exact target document, URL, account,
  goal/wire identity and untouched draft at the actual click boundary, then
  obtain post-click native evidence. A check followed by an unconstrained click
  is a time-of-check/time-of-use race. An uncertain click remains `unknown`.

## Message observation contract

`validateMessageEvidence(binding, evidence, previous = [])` requires native-host
source, exact conversation/account/document/session/tab association, nonempty
native `messageId`, kind `user | assistant | tool`, integer epoch-millisecond
`observedAt` and explicit boolean `truncated`. User acknowledgment requires an
untruncated body hashing to the exact wire message; absence is not an ACK.
Unmatched, earlier or conflicting reused message IDs are rejected. The host must
ensure timestamps and native IDs belong to the current dispatch, rather than
replaying historical messages. Streaming mutations are deliberately not merged.

The default record retains native IDs, digest, association, ordering and truncation,
not message text. `includeText: true` explicitly retains bounded text after a
credential-shape filter. That filter checks decoded nested JSON keys/values and
escaped lexical strings; it is **not a comprehensive secret scanner**. Avoid
sensitive text even with metadata-only mode. Errors do not echo rejected input.
Records carry `identityVerified: true`, `businessVerified: false` and
`businessState: "unknown"`; no body text promotes business success.

For human audit, display the immutable task ID, goal digest, canonical URL,
wire digest, native evidence reference, native message IDs and timestamps together.
Do not silently fall back to another tab or conversation. If an official verifier
cannot provide a required field, explain the missing capability and block sends.

## Tests and limits

`node --test test/task-binding.test.mjs` exercises synthetic native proofs,
canonical URL/userinfo rejection, uniqueness and serialized collision handling,
account/document/session/navigation changes, immutable goal/message hashes,
restart round-trips, reply isolation, monotonic evidence and escaped credential
shapes. A synthetic navigation check is not proof of an atomic real-browser click.
No real authenticated ChatGPT / Workspace E2E is claimed by these tests.

## 只读观察恢复

不可变派发 binding 保留最初 task、goal/wire digest、账号、canonical conversation 及原派发上下文。刷新或浏览器重启后，显式 restore 可请求可信 host 新原生身份；只有同账号、同会话及原任务摘要才产生独立 observationBinding。它允许新的 tab/document/browserSession，但固定 dispatchAllowed:false，不修改原 binding、不恢复发送权。消息历史按同 task/account/conversation 保持关联，每条仍保留实际观察文档。仅人工 URL 确认不产生该原生观察证明。
