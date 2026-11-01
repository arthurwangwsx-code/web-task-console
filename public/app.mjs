const $ = selector => document.querySelector(selector);
const stateOf = value => typeof value === 'string' ? value : value?.state ?? value?.status ?? 'unobserved';
let token = '', paused = false, busy = false;
const button = (label, action, className = 'secondary') => {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.className = className;
  node.addEventListener('click', () => mutate(action)); return node;
};
function text(tag, value, className) { const node = document.createElement(tag); node.textContent = String(value); if (className) node.className = className; return node; }
function freshKey() { $('#key').value = `demo-${crypto.randomUUID()}`; }
function showError(error) { $('#error').textContent = error.message ?? String(error); $('#error').hidden = false; }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Console-Token': token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`); return value;
}
async function mutate(action) {
  if (busy) return; busy = true; $('#error').hidden = true;
  document.querySelectorAll('button').forEach(node => { node.disabled = true; });
  try { await action(); await refresh(); } catch (error) { showError(error); await refresh().catch(() => {}); }
  finally { busy = false; document.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
}
function render(snapshot) {
  const intents = Array.isArray(snapshot.intents) ? snapshot.intents : Object.values(snapshot.intents ?? {});
  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : Object.values(snapshot.tabs ?? {});
  const dispatch = intent => stateOf(intent.dispatch ?? intent.dispatchState ?? intent.status);
  const unknown = intents.filter(intent => dispatch(intent) === 'unknown');
  $('#metric-total').textContent = intents.length;
  $('#metric-queued').textContent = intents.filter(intent => dispatch(intent) === 'queued').length;
  $('#metric-unknown').textContent = unknown.length;
  $('#metric-tabs').textContent = tabs.filter(tab => !(tab.closed || tab.state === 'closed')).length;
  $('#unknown-warning').hidden = unknown.length === 0;
  paused = snapshot.paused ?? snapshot.config?.paused ?? false;
  $('#pause').textContent = paused ? '恢复调度' : '暂停调度';
  $('#connection').textContent = `${paused ? '调度已暂停' : '本地连接正常'} · 仅合成演示 · 最近读取 ${new Date().toLocaleTimeString('zh-CN')}`;
  const root = $('#intents'); root.replaceChildren();
  if (!intents.length) root.append(text('div', '队列为空。先加入合成任务，再点击「推进一步」。', 'empty'));
  for (const intent of [...intents].reverse()) {
    const card = text('article', '', 'intent'); card.dataset.intentId = intent.id;
    const head = text('div', '', 'intent-head');
    head.append(text('div', intent.id ?? '未知意图', 'intent-title'));
    card.append(head, text('p', `key · ${intent.idempotencyKey ?? intent.key ?? '—'}`, 'key'));
    const grid = text('div', '', 'states');
    for (const [label, value] of [['本地发送', dispatch(intent)], ['路由观察', stateOf(intent.router ?? intent.routerState)], ['业务观察', stateOf(intent.provider ?? intent.providerState)]]) {
      const box = text('div', '', 'state-box');
      if (value === 'unknown') box.classList.add('state-unknown');
      if (['succeeded', 'verified'].includes(value)) box.classList.add('state-success');
      if (['failed', 'provider-failure'].includes(value)) box.classList.add('state-failed');
      box.append(text('span', label, 'state-label'), text('span', value, 'state-value')); grid.append(box);
    }
    card.append(grid);
    const refs = intent.refs ?? intent.observation ?? {};
    const identifiers = ['invocationId', 'taskId', 'runId', 'sessionId'].map(key => [key, intent[key] ?? refs[key] ?? intent.router?.[key] ?? intent.provider?.[key]]).filter(([,value]) => value);
    if (identifiers.length) card.append(text('div', identifiers.map(([key,value]) => `${key}: ${value}`).join(' · '), 'detail'));
    if (intent.blockedBy) card.append(text('div', `背压保护：${intent.blockedBy}`, 'detail'));
    if (intent.dispatch?.error || intent.poll?.error) card.append(text('div', intent.dispatch?.error ?? intent.poll?.error, 'detail'));
    if (intent.completion) card.append(text('div', intent.completion.verified ? '业务终态：已由适配器回执验证（当前为合成证据）' : '业务终态：尚未验证', 'detail'));
    if (intent.lastError ?? intent.error) card.append(text('div', typeof (intent.lastError ?? intent.error) === 'object' ? JSON.stringify(intent.lastError ?? intent.error) : intent.lastError ?? intent.error, 'detail'));
    const controls = text('div', '', 'actions');
    controls.append(button('只读回查', () => api(`/api/intents/${encodeURIComponent(intent.id)}/reconcile`, {})));
    if (dispatch(intent) === 'queued') controls.append(button('取消未发送意图', () => api(`/api/intents/${encodeURIComponent(intent.id)}/cancel`, {})));
    card.append(controls); root.append(card);
  }
  const tabRoot = $('#tabs'); tabRoot.replaceChildren();
  if (!tabs.length) tabRoot.append(text('div', '尚无受管标签；不会枚举或关闭用户已有标签。', 'empty'));
  for (const tab of tabs) {
    const row = text('div', '', 'tab'), details = document.createElement('div');
    const id = tab.id ?? tab.tabId;
    details.append(text('strong', `${id} · ${tab.closed || tab.state === 'closed' ? '已关闭' : tab.owned === false ? '非自有' : '受管'}`), text('p', tab.url ?? tab.chatUrl ?? '合成标签'), text('small', `关联意图：${tab.intentId ?? tab.ownerId ?? tab.taskId ?? '—'}`));
    row.append(details);
    if (!(tab.closed || tab.state === 'closed')) row.append(button('受保护关闭', () => api(`/api/tabs/${encodeURIComponent(id)}/close`, {})));
    tabRoot.append(row);
  }
  $('#diagnostics').textContent = JSON.stringify({ config: snapshot.config, metrics: snapshot.metrics }, null, 2);
}
async function refresh() { render(await api('/api/state')); }
$('#new-key').addEventListener('click', freshKey);
$('#intent-form').addEventListener('submit', event => { event.preventDefault(); mutate(async () => { await api('/api/intents', { idempotencyKey: $('#key').value, prompt: $('#prompt').value }); }); });
$('#tick').addEventListener('click', () => mutate(() => api('/api/tick', {})));
$('#pause').addEventListener('click', () => mutate(() => api('/api/pause', { paused: !paused })));
$('#scenario').addEventListener('change', () => mutate(() => api('/api/scenario', { scenario: $('#scenario').value })));
freshKey();
try { const bootstrap = await api('/api/bootstrap'); token = bootstrap.csrfToken; await refresh(); }
catch (error) { showError(error); $('#connection').textContent = '本地连接失败；请确认服务已启动并刷新页面。'; }
setInterval(() => { if (!busy && token) refresh().catch(error => { $('#connection').textContent = `读取失败：${error.message}；不会重发任务。`; }); }, 2000);
