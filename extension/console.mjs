const $ = selector => document.querySelector(selector);
const originPermission = { origins: ['https://chatgpt.com/*'] };
const asList = value => Array.isArray(value) ? value : Object.values(value ?? {});
const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = String(value ?? '—');
  if (className) element.className = className;
  return element;
};
let busy = false, paused = false;
function showError(error) { $('#error').textContent = error?.message ?? String(error); $('#error').hidden = false; }
async function message(op, params = {}) {
  const result = await chrome.runtime.sendMessage({ op, ...params });
  if (!result?.ok) throw new Error(result?.error ?? '后台未返回确认；不要重复发送。');
  return result.value;
}
function markerPreview() { $('#marker-preview').textContent = `[web-task-console key=${$('#key').value}]`; }
function freshKey() { $('#key').value = `web-${crypto.randomUUID()}`; markerPreview(); }
async function permissionState() {
  const allowed = await chrome.permissions.contains(originPermission);
  $('#permission-state').textContent = allowed ? '已授予 ChatGPT 站点访问；每次发送仍须单独确认。' : '尚未授权。不会读取或发送 ChatGPT 页面。';
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button, input, textarea').forEach(node => { node.disabled = value || node.dataset.policyDisabled === 'true'; });
}
async function mutate(action) {
  if (busy) return;
  setBusy(true); $('#error').hidden = true;
  try { await action(); }
  catch (error) { showError(error); }
  finally {
    try { await refresh(); } catch (error) { showError(error); }
    setBusy(false);
  }
}
function button(label, action, className = 'secondary') {
  const node = text('button', label, className); node.type = 'button';
  node.addEventListener('click', () => mutate(action)); return node;
}
function wirePrompt(intent) {
  return intent.wirePrompt ?? `${intent.prompt}\n\n[web-task-console key=${intent.idempotencyKey}]`;
}
function candidateChatUrl(intent) {
  for (const value of [intent.chatUrl, intent.observedChatUrl, intent.browserObservation?.url]) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.origin === 'https://chatgpt.com' && /^\/c\/[A-Za-z0-9-]+$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password) return value;
    } catch { /* No inferred or guessed URL. */ }
  }
  return '';
}
function details(label, value) {
  const box = document.createElement('details'); box.append(text('summary', label), text('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); return box;
}
function sendReady(intent) { return intent.state === 'ready' && intent.binding?.state === 'verified' && intent.dispatchValidated === true; }
function nativeFresh(intent) { return intent.binding?.state === 'verified' && (intent.dispatchValidated === true || intent.observationValidated === true); }
function bindingPanel(intent) {
  const binding = intent.binding ?? {};
  const box = text('section', '', 'binding');
  box.append(text('strong', `任务↔会话原生绑定：${binding.state ?? 'pending'}`));
  for (const [label, value] of [
    ['conversationId', binding.conversationId],
    ['goalDigest', binding.goalDigest ?? intent.goalDigest],
    ['wireDigest', binding.wireDigest ?? intent.wireDigest],
    ['source', binding.proofSource ?? binding.source],
    ['verifiedAt', binding.verifiedAt],
  ]) box.append(text('p', `${label}: ${value ?? '尚无证据'}`, 'identifier'));
  if (binding.state !== 'verified') box.append(text('p', '原生证据缺口：当前真实 ChromeHost 无官方账号及原生消息 ID 证明 API，发送硬阻断。user-confirmed 只读恢复 ≠ verified。', 'error-text'));
  box.append(text('p', `dispatchValidated: ${intent.dispatchValidated === true}；进程重启后必须重新核验`, 'identifier'));
  if (intent.observationBinding) box.append(text('p', `只读原生恢复：observationValidated ${intent.observationValidated === true} · dispatchAllowed: false · conversationId: ${intent.observationBinding.conversationId ?? '未知'}`, 'identifier'));
  const gap = intent.bindingCheck?.reason ?? binding.reason ?? binding.error ?? binding.missingEvidence ?? binding.missing;
  if (intent.bindingCheck) box.append(text('p', `原生接口 available: ${intent.bindingCheck.available === true} · ${intent.bindingCheck.at ?? '检查时间未知'}`, 'identifier'));
  if (gap) box.append(text('p', `绑定检查结果：${typeof gap === 'string' ? gap : JSON.stringify(gap)}`, 'hint'));
  return box;
}
function evidencePanel(intent) {
  const evidence = intent.messageEvidence;
  const records = Array.isArray(evidence) ? evidence : evidence?.records ?? evidence?.messages ?? [];
  const conversationId = intent.binding?.conversationId ?? intent.conversationId;
  const sameConversation = Array.isArray(records) && conversationId ? records.filter(record => record?.taskId === intent.id && record?.conversationId === conversationId) : [];
  const box = document.createElement('details');
  box.append(text('summary', `本会话消息证据摘要 ${sameConversation.length} 条`));
  if (!sameConversation.length) box.append(text('p', '没有可关联到本意图会话的原生消息证据；不展示或猜测其他会话记录。', 'hint'));
  for (const record of sameConversation) {
    const row = text('div', '', 'evidence-row');
    row.append(text('p', record.summary ?? `${record.kind ?? '未知类型'} 消息摘要（只显示身份/内容摘要，不展开正文）`, 'hint'));
    row.append(text('p', `来源：${record.source ?? '未核验'} · 时序：${record.sequence ?? record.timestamp ?? record.observedAt ?? record.createdAt ?? '未知'}`, 'identifier'));
    row.append(text('p', `nativeMessageId: ${record.nativeMessageId ?? record.messageId ?? '未知'} · observedAt: ${record.observedAt ?? '未知'} · digest: ${record.digest ?? record.contentDigest ?? '未知'}`, 'identifier'));
    box.append(row);
  }
  return box;
}
function idlePanel(intent) {
  const proposal = intent.lastIdleProposal;
  const box = text('section', '', 'idle');
  box.append(text('strong', '空闲 30 分钟检查：只提供建议，不自动发送'));
  if (!proposal) box.append(text('p', '尚无空闲检查结果。点击检查只生成待确认建议，不推进任务。', 'hint'));
  else {
    box.append(text('p', `原目标：${proposal.originalGoal ?? proposal.goal ?? intent.prompt ?? '未提供'}`, 'hint'));
    box.append(text('p', `下一步建议：${proposal.nextStep ?? (Array.isArray(proposal.nextSteps) && proposal.nextSteps.length ? proposal.nextSteps.join('；') : null) ?? proposal.proposal ?? '未提出下一步'}`, 'hint'));
    box.append(text('p', `建议状态：${proposal.status ?? '未知'} · autoSendAllowed: false`, 'identifier'));
    box.append(text('p', `检查时间：${proposal.checkedAt ?? proposal.createdAt ?? proposal.at ?? '未知'} · requires confirmation：是`, 'identifier'));
    box.append(details('本意图建议记录', proposal));
  }
  box.append(text('p', '建议不能跨会话执行；仍需用户逐次确认及原生绑定 fresh verify。缺证明时继续阻断。', 'hint'));
  return box;
}
function render(state) {
  const intents = asList(state.intents), tabs = asList(state.ownedTabs);
  paused = Boolean(state.paused);
  const unknown = intents.filter(intent => ['unknown','sending','opening'].includes(intent.state));
  $('#total').textContent = intents.length;
  $('#queued').textContent = intents.filter(intent => ['queued','ready'].includes(intent.state)).length;
  $('#unknown').textContent = unknown.length;
  $('#tabs-count').textContent = tabs.filter(tab => !['closed','removed'].includes(tab.status)).length;
  $('#unknown-warning').hidden = !unknown.length;
  $('#pause').textContent = paused ? '恢复操作' : '暂停操作';
  $('#connection').textContent = `${paused ? '写操作已暂停' : '本地状态可用'} · 页面不会自动轮询或发送 · ${new Date().toLocaleTimeString('zh-CN')}`;
  const root = $('#intents'); root.replaceChildren();
  if (!intents.length) root.append(text('p', '尚无意图。保存不会打开页面或发送任务。', 'empty'));
  for (const intent of [...intents].reverse()) {
    const card = text('article', '', 'intent');
    const heading = text('div', '', 'section-head');
    heading.append(text('strong', intent.idempotencyKey), text('span', intent.state, `pill ${intent.state === 'unknown' ? 'danger' : ''}`));
    card.append(heading, text('p', intent.id, 'hint'), bindingPanel(intent));
    const attempted = ['sending', 'sent', 'unknown'].includes(intent.state);
    const draftLabel = text('label', attempted ? '原始发送文本：仅供对照，禁止重发' : '完整发送文本：点击选中后手动复制');
    const draft = document.createElement('textarea');
    draft.id = `wire-${intent.id}`; draftLabel.htmlFor = draft.id;
    draft.value = wirePrompt(intent); draft.readOnly = true; draft.rows = 6;
    draft.addEventListener('click', () => draft.select());
    card.append(draftLabel, draft, text('p', attempted ? '该意图已尝试发送。原始文本仅用于核对，不要再次粘贴提交。只读恢复聊天不会恢复发送权或释放容量。' : '这是待审阅文本，不是发送许可。真实宿主缺少原生任务↔会话证明，发送默认阻断；不要改键、手工篡改本地状态或换会话绕过。扩展不编辑共享草稿。', 'hint'));
    if (intent.error) card.append(text('p', typeof intent.error === 'string' ? intent.error : JSON.stringify(intent.error), 'error-text'));
    for (const [label, value] of [[intent.binding?.state === 'verified' ? 'chatUrl（原生身份已绑定；不代表业务完成）' : 'chatUrl（用户确认只读关联，未核验）', intent.chatUrl], ['observedChatUrl（候选，尚未绑定）', intent.observedChatUrl], ['conversationId', intent.conversationId], ['tabId', intent.tabId]]) if (value !== undefined && value !== null) card.append(text('p', `${label}: ${value}`, 'identifier'));
    const actions = text('div', '', 'actions');
    if (intent.state === 'queued') {
      actions.append(button('新建自有 ChatGPT 标签', () => message('open', { id: intent.id })));
      actions.append(button('取消未发送意图', () => message('cancel', { id: intent.id })));
    }
    actions.append(button('检查原生绑定（只读）', () => message('verifyBinding', { id: intent.id })));
    actions.append(button('只读观察原生消息摘要', () => message('observeMessages', { id: intent.id })));
    actions.append(button('检查 30 分钟空闲建议', () => message('idleCheck', { id: intent.id })));
    if (intent.state === 'ready') {
      const sendButton = button(sendReady(intent) ? '审阅并确认发送一次' : intent.binding?.state === 'verified' ? '发送已阻断：请重新核验绑定' : '发送已阻断：缺原生绑定证明', async () => {
      if (!sendReady(intent)) throw new Error('缺少已核验的原生任务↔会话绑定，禁止发送。');
      const approved = window.confirm(`确认仅向本意图登记的 ChatGPT 标签发送一次？\n\n请先在该标签核对账号，手动选择 WorkSpace 插件并粘贴以下全文；确认目标环境和授权范围。扩展不修改草稿，只在逐字匹配后单击一次。单击成功不被当成 ACK；发送后保持 unknown，必须通过原生 WorkSpace 外部核验。\n\n${wirePrompt(intent)}\n\n选择「确定」才会尝试发送。结果不明时不会自动重发。`);
      if (approved) await message('send', { id: intent.id, confirmed: true });
      }, 'primary');
      sendButton.dataset.policyDisabled = String(!sendReady(intent));
      sendButton.disabled = !sendReady(intent);
      actions.append(sendButton);
    }
    if (attempted) actions.append(button('确认并只读绑定/恢复聊天', async () => {
      const chatUrl = window.prompt('请输入已人工核对、确属该原键任务的精确 ChatGPT 对话 URL（https://chatgpt.com/c/...）。候选 URL 不代表已核验；不要猜测或使用其他任务聊天。', candidateChatUrl(intent));
      if (chatUrl === null) return;
      const approved = window.confirm(`确认此精确 URL 确属原键 ${intent.idempotencyKey} 的任务？\n\n${chatUrl}\n\n仅建立 user-confirmed / unverified 的只读绑定。刷新后只读重绑；浏览器重启后可能新建自有只读标签。不会恢复发送权、释放槽位或证明业务完成。`);
      if (approved) await message('restore', { id: intent.id, chatUrl, confirmed: true });
    }));
    if (intent.tabId !== undefined && intent.tabId !== null) {
      actions.append(button('只读检查页面', () => message('inspect', { id: intent.id })));
      const captureButton = button(nativeFresh(intent) ? '采集所选原生 JSON（未核验）' : '采集已阻断：需原生绑定重核验', async () => {
        if (!nativeFresh(intent)) throw new Error('需要 fresh native binding；人工只读恢复不能授权采集。');
        const approved = window.confirm('请先核对本意图已确认绑定的聊天，再在其自有 ChatGPT 标签中手动展开原生 WorkSpace 工具卡片，仅选中需要留存的 JSON 原文。\n\n确认所选内容不含凭据、cookie、token 或无关私人信息。此操作只采集当前选择，不自动抓聊天正文。即使 JSON 声称 completed，也只作为 external-observed / unverified 保存，不能证明业务完成。是否采集？');
        if (approved) await message('capture', { id: intent.id, confirmed: true });
      });
      captureButton.dataset.policyDisabled = String(!nativeFresh(intent));
      captureButton.disabled = !nativeFresh(intent);
      actions.append(captureButton);
    }
    card.append(actions, evidencePanel(intent), idlePanel(intent));
    if (!nativeFresh(intent)) card.append(text('p', '采集 JSON 也要求 fresh native binding；人工 user-confirmed 本身不恢复采集权限。只有可信原生重新核验得到 observationValidated 后可恢复观察，仍不能发送。当前真实宿主缺证明时继续阻断。', 'hint'));
    if (intent.browserObservation) card.append(details('页面观察（external-observed / unverified）', intent.browserObservation));
    const receipts = asList(intent.nativeReceipts);
    if (receipts.length) {
      card.append(text('p', '下列是用户选择的 JSON 候选，来源未核验；不能证明来自原生工具或 producer。请通过原生 WorkSpace 查询核验。', 'hint'));
      card.append(details(`原生回执候选 ${receipts.length} 条（unverified）`, receipts));
    }
    card.append(text('p', '业务状态：未在本扩展核验。聊天回复、页面发送成功或 router completed 均不能证明完成。', 'authority'));
    root.append(card);
  }
  const tabRoot = $('#tabs'); tabRoot.replaceChildren();
  if (!tabs.length) tabRoot.append(text('p', '没有自有标签。', 'empty'));
  for (const tab of tabs) {
    const card = text('div', '', 'tab');
    card.append(text('strong', `tab ${tab.tabId} · ${tab.status ?? 'registered'}`), text('p', tab.url ?? 'URL 待观察'), text('p', `intent: ${tab.intentId ?? '—'} · document: ${tab.documentId ?? '—'} · conversation: ${tab.conversationId ?? '—'}`, 'identifier'));
    tabRoot.append(card);
  }
  $('#config').textContent = JSON.stringify({ config: state.config, paused: state.paused, version: state.version }, null, 2);
}
async function refresh() { render(await message('state')); await permissionState(); }
$('#grant').addEventListener('click', () => {
  if (busy) return;
  // Start the permission API directly in this user gesture; never request in a timer.
  const approval = chrome.permissions.request(originPermission);
  mutate(async () => {
    if (!await approval) throw new Error('站点授权未授予；没有读取页面或发送。');
    await message('permissionChanged');
  });
});
$('#revoke').addEventListener('click', () => {
  if (busy || !window.confirm('撤销 ChatGPT 站点访问？现有意图保留；不会取消真实任务。')) return;
  const removal = chrome.permissions.remove(originPermission);
  mutate(async () => { await removal; await message('permissionChanged'); });
});
$('#new-key').addEventListener('click', () => {
  if (window.confirm('新键只用于新任务。若旧任务结果为 unknown，请勿换键重发。继续生成新键？')) freshKey();
});
$('#key').addEventListener('input', markerPreview);
$('#create-form').addEventListener('submit', event => {
  event.preventDefault(); mutate(() => message('create', { idempotencyKey: $('#key').value, prompt: $('#prompt').value }));
});
$('#pause').addEventListener('click', () => mutate(() => message('pause', { paused: !paused })));
freshKey();
await refresh().catch(showError);
setInterval(() => { if (!busy) refresh().catch(error => { $('#connection').textContent = `本地读取失败：${error.message}；不会重发。`; }); }, 4000);
