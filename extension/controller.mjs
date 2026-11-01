import { createPendingBinding, bindVerified, assertUniqueBinding, verifyDispatchBinding, validateMessageEvidence, rebindObservation, verifyObservationBinding } from './task-binding.mjs';
import { evaluateIdle } from './idle-policy.mjs';
import { safeErrorCode } from './errors.mjs';
const clone = x => structuredClone(x);
const attempted = i => ['sending','sent','unknown'].includes(i.state);
const iso = now => new Date(now()).toISOString();
export const limits = Object.freeze({ maxIntents: 50, maxQueued: 20, maxTabs: 4, maxActive: 2, maxReceipts: 40, maxReceiptsPerIntent: 8, maxStorageBytes: 4_000_000, observeIntervalMs: 2000 });

// Conservative credential-shape guard, NOT a complete secret detector. Inspect
// decoded data before retaining raw JSON; never put rejected values in an error.
function rejectCredentialLikeReceipt(value, raw) {
  const names = new Set(['accesstoken','refreshtoken','authorization','cookie','cookies','setcookie','password','passwd','passphrase','apikey','clientsecret','idtoken','sessiontoken','authtoken','privatekey','credentials']);
  const suspiciousKey = key => names.has(key.normalize('NFKC').replace(/[\s_-]/g, '').toLowerCase());
  const suspiciousValue = text => /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/i.test(text.normalize('NFKC')) || /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text);
  const reject = () => { throw new Error('CREDENTIAL_LIKE_RECEIPT_REJECTED'); };
  const pending = [{ value, depth: 0 }]; let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++visited > 10000 || item.depth > 64) throw new Error('RECEIPT_STRUCTURE_TOO_COMPLEX');
    if (typeof item.value === 'string') { if (suspiciousValue(item.value)) reject(); }
    else if (item.value && typeof item.value === 'object') {
      for (const [key, child] of Object.entries(item.value)) {
        if (suspiciousKey(key)) reject();
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  // JSON.parse discards overwritten duplicate keys. Since raw is preserved,
  // inspect every decoded string token, including overwritten values.
  for (const match of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
    const decoded = JSON.parse(match[0]);
    const isKey = raw.slice(match.index + match[0].length).trimStart().startsWith(':');
    if ((isKey && suspiciousKey(decoded)) || suspiciousValue(decoded)) reject();
  }
}

export function extractReceipt(raw, intent, context) {
  if (typeof raw !== 'string' || raw.length > 65536) throw new Error('RECEIPT_TOO_LARGE');
  let value; try { value = JSON.parse(raw); } catch { throw new Error('RECEIPT_MUST_BE_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RECEIPT_OBJECT_REQUIRED');
  rejectCredentialLikeReceipt(value, raw);
  const refs = {};
  for (const key of ['invocationId','taskId','runId','sessionId','idempotencyKey']) {
    const values = [value[key], value.provider?.[key], value.result?.[key], value.structuredContent?.[key]].filter(v => v !== undefined);
    if (values.some(v => typeof v !== 'string' || !v || v.length > 256) || new Set(values).size > 1) throw new Error('AMBIGUOUS_RECEIPT_IDENTIFIERS');
    if (values.length) refs[key] = values[0];
  }
  if (!refs.invocationId && !refs.taskId && !refs.runId && !refs.sessionId) throw new Error('NATIVE_RECEIPT_ID_REQUIRED');
  if (refs.idempotencyKey && refs.idempotencyKey !== intent.idempotencyKey) throw new Error('RECEIPT_KEY_MISMATCH');
  return { raw, refs, captureMethod: 'user-selected-json', provenance: 'external-observed', verified: false,
    businessState: 'unknown', correlation: refs.idempotencyKey ? 'key-matched-unverified' : 'conversation-only-unverified', ...context };
}

/** Browser-local intent controller. No producer authority and no silent recovery writes. */
export class ExtensionController {
  constructor({ store, host, sessionId, uuid = () => crypto.randomUUID(), now = Date.now }) {
    Object.assign(this, { store, host, sessionId, uuid, now }); this.tail = Promise.resolve();
  }
  serial(fn) { const run = this.tail.then(fn); this.tail = run.catch(() => {}); return run; }
  async init() {
    this.state = await this.store.read() ?? { version: 1, intents: [], ownedTabs: [], paused: false, config: clone(limits) };
    if (this.state.version !== 1 || !Array.isArray(this.state.intents) || !Array.isArray(this.state.ownedTabs)) throw new Error('INVALID_EXTENSION_STORE');
    this.state.config = clone(limits);
    for (const i of this.state.intents) {
      if (['opening','sending'].includes(i.state)) { i.state = 'unknown'; i.error = 'INTERRUPTED_ACTION_OBSERVE_ONLY'; }
      if (i.restoreState === 'opening') i.restoreState = 'opening-unknown';
      i.binding ??= await createPendingBinding(i);
      i.messageEvidence ??= [];
      i.audit ??= [];
      // Worker/browser restarts never restore dispatch permission from disk.
      i.dispatchValidated = false;
      i.observationValidated = false;
    }
    for (const tab of this.state.ownedTabs) if (tab.browserSessionId !== this.sessionId) tab.status = 'detached-after-browser-restart';
    await this.save(); return this;
  }
  async save() {
    if (new TextEncoder().encode(JSON.stringify(this.state)).length > limits.maxStorageBytes) throw new Error('LOCAL_STORAGE_BUDGET');
    await this.store.write(clone(this.state));
  }
  async commitLocal(edit) {
    // Local-only mutations publish their candidate only after budget validation
    // and durable storage succeed. Never use this rollback pattern after an
    // external click/create: those paths must retain sending/unknown protection.
    const candidate = clone(this.state);
    edit(candidate);
    if (new TextEncoder().encode(JSON.stringify(candidate)).length > limits.maxStorageBytes) throw new Error('LOCAL_STORAGE_BUDGET');
    await this.store.write(clone(candidate));
    this.state = candidate;
  }
  snapshot() { return { ...clone(this.state), mode: 'controlled-browser-native-identity-required', authority: 'intent-and-observation-cache-only' }; }
  get(id) { const i = this.state.intents.find(i => i.id === id); if (!i) throw new Error('INTENT_NOT_FOUND'); return i; }
  tab(i) {
    const tab = this.state.ownedTabs.find(t => t.tabId === i.tabId && t.intentId === i.id);
    if (!tab || tab.browserSessionId !== this.sessionId || tab.status === 'removed') throw new Error('OWNED_TAB_NOT_AVAILABLE');
    return tab;
  }
  async hostRead(action) {
    try { return await action(); } catch (error) { throw new Error(safeErrorCode(error)); }
  }
  async permitted() { if (!await this.hostRead(() => this.host.hasPermission())) throw new Error('CHATGPT_PERMISSION_REQUIRED'); }
  create({ idempotencyKey, prompt }) { return this.serial(async () => {
    if (typeof idempotencyKey !== 'string' || !/^[\w.-]{1,128}$/.test(idempotencyKey)) throw new Error('INVALID_IDEMPOTENCY_KEY');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('INVALID_PROMPT');
    const old = this.state.intents.find(i => i.idempotencyKey === idempotencyKey);
    if (old) { if (old.prompt !== prompt) throw new Error('IDEMPOTENCY_CONFLICT'); return clone(old); }
    if (this.state.intents.length >= limits.maxIntents || this.state.intents.filter(i => i.state === 'queued').length >= limits.maxQueued) throw new Error('INTENT_QUEUE_FULL');
    const i = { id: this.uuid(), idempotencyKey, prompt, wirePrompt: `${prompt}\n\n[web-task-console key=${idempotencyKey}]`, state: 'queued', attempts: 0,
      tabId: null, chatUrl: null, conversationId: null, nativeReceipts: [], provider: { state: 'unknown', verified: false }, createdAt: iso(this.now), poll: { nextAt: 0, failures: 0 } };
    i.binding = await createPendingBinding(i); i.messageEvidence = []; i.audit = []; i.dispatchValidated = false;
    await this.commitLocal(candidate => candidate.intents.push(i)); return clone(i);
  }); }
  open({ id }) { return this.serial(async () => {
    const i = this.get(id); if (i.state !== 'queued') throw new Error('ONLY_QUEUED_CAN_OPEN');
    if (this.state.paused) throw new Error('PAUSED'); await this.permitted();
    if (this.state.ownedTabs.filter(t => t.status !== 'removed').length >= limits.maxTabs) throw new Error('TAB_CAPACITY');
    i.state = 'opening'; await this.save(); // Creation itself can be uncertain; do not retry it.
    try {
      const opened = await this.host.open('https://chatgpt.com/');
      if (this.state.ownedTabs.some(t => t.tabId === opened.tabId && t.browserSessionId === this.sessionId)) throw new Error('TAB_ID_ALREADY_OWNED');
      const tab = { ...opened, intentId: i.id, browserSessionId: this.sessionId, documentId: null, conversationId: null, status: 'unbound' };
      this.state.ownedTabs.push(tab); i.tabId = opened.tabId; i.chatUrl = opened.url; i.state = 'ready'; await this.save();
    } catch (error) { i.state = 'unknown'; i.error = safeErrorCode(error); await this.save(); }
    return clone(i);
  }); }
  async inspectInside(i) {
    await this.permitted(); const tab = this.tab(i);
    if (i.poll.nextAt > this.now()) throw new Error('OBSERVATION_BACKOFF');
    try {
      const bind = !tab.documentId && i.state === 'ready' && i.attempts === 0;
      const observation = await this.host.inspect(tab, i.wirePrompt, bind);
      if (observation.url !== 'https://chatgpt.com/' && !observation.conversationId) throw new Error('UNRECOGNIZED_CHAT_URL');
      if (tab.conversationId && observation.conversationId !== tab.conversationId) throw new Error('CONVERSATION_CHANGED');
      if (i.state === 'ready' && observation.conversationId && (i.binding?.state !== 'verified' || observation.conversationId !== i.binding.conversationId)) throw new Error('UNSENT_TAB_HAS_EXISTING_CONVERSATION');
      await this.commitLocal(candidate => {
        const next = candidate.intents.find(x => x.id === i.id);
        const owned = candidate.ownedTabs.find(t => t.tabId === tab.tabId && t.intentId === i.id && t.browserSessionId === this.sessionId);
        if (bind) owned.documentId = observation.documentId;
        owned.status = 'bound';
        // A new /c URL is only a candidate, never automatic native binding.
        if (observation.conversationId && !owned.conversationId) next.observedChatUrl = observation.url;
        else { owned.url = observation.url; next.chatUrl = observation.url; }
        next.browserObservation = { ...observation, observedAt: iso(this.now), verified: false };
        next.poll = { nextAt: this.now() + limits.observeIntervalMs, failures: 0 };
        delete next.error;
      });
      return observation;
    } catch (error) {
      await this.commitLocal(candidate => {
        const next = candidate.intents.find(x => x.id === i.id);
        next.poll.failures++; next.poll.nextAt = this.now() + Math.min(60000, limits.observeIntervalMs * 2 ** Math.min(next.poll.failures - 1, 6));
        next.error = safeErrorCode(error);
      });
      throw new Error(safeErrorCode(error));
    }
  }
  inspect({ id }) { return this.serial(async () => { await this.inspectInside(this.get(id)); return clone(this.get(id)); }); }
  context(tab, observation) {
    return { tabId: tab.tabId, documentId: observation.documentId, url: observation.url, browserSessionId: this.sessionId };
  }
  async identity(tab, context) {
    // This callback is trusted host code, never JSON supplied by a page or UI.
    return this.host.verifyIdentity ? this.hostRead(() => this.host.verifyIdentity(tab, context)) : { available: false };
  }
  verifyBinding({ id }) { return this.serial(async () => {
    const i = this.get(id); await this.permitted(); const tab = this.tab(i);
    const observation = await this.hostRead(() => this.host.inspect(tab, i.wirePrompt, !tab.documentId));
    const context = this.context(tab, observation);
    const proof = await this.identity(tab, context);
    if (proof?.available !== true) {
      await this.commitLocal(candidate => {
        const next = candidate.intents.find(x => x.id === id);
        next.dispatchValidated = false;
        next.bindingCheck = { available: false, reason: 'NATIVE_ACCOUNT_AND_MESSAGE_ID_CONTRACT_UNAVAILABLE', at: iso(this.now) };
      });
      return clone(this.get(id));
    }
    const binding = await bindVerified(this.state.intents, i, proof, context);
    await this.commitLocal(candidate => {
      assertUniqueBinding(candidate.intents, id, binding.conversationId);
      const next = candidate.intents.find(x => x.id === id);
      if (next.audit.length >= 100) throw new Error('AUDIT_CAPACITY');
      next.binding = binding; next.dispatchValidated = true; next.observationValidated = true;
      next.conversationId = binding.conversationId; next.chatUrl = binding.canonicalUrl;
      next.bindingCheck = { available: true, source: 'native-host', at: iso(this.now) };
      next.audit.push({ type: 'binding-verified', at: iso(this.now), conversationId: binding.conversationId, reference: binding.reference });
      const owned = candidate.ownedTabs.find(t => t.tabId === tab.tabId && t.intentId === id && t.browserSessionId === this.sessionId);
      Object.assign(owned, { url: binding.canonicalUrl, documentId: binding.documentId, conversationId: binding.conversationId, status: 'native-bound' });
    });
    return clone(this.get(id));
  }); }
  async freshBinding(i, observation = null, readOnly = false) {
    assertUniqueBinding(this.state.intents, i.id, i.binding?.conversationId);
    const tab = this.tab(i);
    if (!observation) observation = await this.hostRead(() => this.host.inspect(tab, i.wirePrompt, false));
    const context = this.context(tab, observation);
    const proof = await this.identity(tab, context);
    const binding = readOnly && i.observationBinding ? i.observationBinding : i.binding;
    if (binding.dispatchAllowed === false) await verifyObservationBinding(i, i.binding, binding, proof, context);
    else await verifyDispatchBinding(i, binding, proof, context);
    return { tab, context, proof, binding };
  }
  restore({ id, chatUrl, confirmed }) { return this.serial(async () => {
    const i = this.get(id);
    if (confirmed !== true || !attempted(i)) throw new Error('READONLY_RESTORE_REQUIRES_ATTEMPT_AND_CONFIRMATION');
    await this.permitted();
    let url; try { url = new URL(chatUrl); } catch { throw new Error('EXACT_CHAT_URL_REQUIRED'); }
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash || !/^\/c\/[a-zA-Z0-9-]{1,100}$/.test(url.pathname)) throw new Error('EXACT_CHAT_URL_REQUIRED');
    const conversationId = url.pathname.slice(3);
    if (i.conversationId && conversationId !== i.conversationId) throw new Error('CONVERSATION_BINDING_CONFLICT');
    if (this.state.intents.some(x => x.id !== i.id && x.binding?.state === 'verified' && x.binding.conversationId === conversationId)) throw new Error('BINDING_CONVERSATION_IN_USE');
    if (i.restoreState === 'opening-unknown') throw new Error('RESTORE_TAB_CREATION_UNKNOWN_INSPECT_MANUALLY');
    let tab = this.state.ownedTabs.find(t => t.tabId === i.tabId && t.intentId === i.id && t.browserSessionId === this.sessionId && t.status !== 'removed');
    if (!tab) {
      if (this.state.paused) throw new Error('PAUSED_NEW_READONLY_TAB');
      if (this.state.ownedTabs.filter(t => t.browserSessionId === this.sessionId && t.status !== 'removed').length >= limits.maxTabs) throw new Error('TAB_CAPACITY');
      i.restoreState = 'opening'; await this.save();
      try {
        const opened = await this.host.open(url.href);
        if (this.state.ownedTabs.some(t => t.tabId === opened.tabId && t.browserSessionId === this.sessionId)) throw new Error('TAB_ID_ALREADY_OWNED');
        tab = { ...opened, intentId: i.id, browserSessionId: this.sessionId, documentId: null, conversationId, status: 'unbound', readOnly: true };
        this.state.ownedTabs.push(tab); i.tabId = opened.tabId; i.restoreState = 'created'; await this.save();
      } catch (error) { i.restoreState = 'opening-unknown'; i.error = safeErrorCode(error); await this.save(); throw new Error(safeErrorCode(error)); }
    }
    const observation = await this.hostRead(() => this.host.rebindReadOnly(tab, url.href, i.wirePrompt));
    if (observation.url !== url.href || observation.conversationId !== conversationId || !observation.documentId) throw new Error('READONLY_REBIND_RESULT_MISMATCH');
    let observationBinding = null;
    if (i.binding?.state === 'verified') {
      const context = this.context(tab, observation);
      const proof = await this.identity(tab, context);
      if (proof?.available === true) {
        observationBinding = await rebindObservation(i.binding, proof, context);
        await verifyObservationBinding(i, i.binding, observationBinding, proof, context);
      }
    }
    await this.commitLocal(candidate => {
      const owned = candidate.ownedTabs.find(t => t.tabId === tab.tabId && t.intentId === id && t.browserSessionId === this.sessionId);
      Object.assign(owned, { url: url.href, conversationId, documentId: observation.documentId, readOnly: true, status: 'bound-readonly' });
      const next = candidate.intents.find(x => x.id === id);
      if (next.audit.length >= 100) throw new Error('AUDIT_CAPACITY');
      next.audit.push({ type: observationBinding ? 'native-observation-rebound' : 'user-confirmed-readonly-restore', at: iso(this.now), conversationId, dispatchAllowed: false });
      Object.assign(next, { chatUrl: url.href, conversationId, restoreState: 'bound-readonly', dispatchValidated: false,
        observationBinding, observationValidated: observationBinding !== null,
        conversationBinding: { provenance: 'user-confirmed', verified: false, at: iso(this.now) },
        browserObservation: { ...observation, observedAt: iso(this.now), verified: false } });
    });
    return clone(this.get(id));
  }); }
  send({ id, confirmed }) { return this.serial(async () => {
    let i = this.get(id);
    if (confirmed !== true) throw new Error('EXPLICIT_SEND_CONFIRMATION_REQUIRED');
    if (this.state.paused) throw new Error('PAUSED');
    if (i.state !== 'ready' || i.attempts !== 0) throw new Error('SEND_ALREADY_ATTEMPTED_OR_NOT_READY');
    if (i.binding?.state !== 'verified' || !i.dispatchValidated) throw new Error('NATIVE_BINDING_VERIFICATION_REQUIRED');
    if (typeof this.host.dispatchVerified !== 'function') throw new Error('ATOMIC_NATIVE_DISPATCH_UNAVAILABLE');
    if (this.state.intents.filter(attempted).length >= limits.maxActive) throw new Error('ACTIVE_OR_UNKNOWN_CAPACITY');
    if (this.state.intents.reduce((n,x) => n+x.nativeReceipts.length,0) >= limits.maxReceipts) throw new Error('RECEIPT_CAPACITY');
    const observation = await this.inspectInside(i);
    i = this.get(id);
    if (!observation.draftMatches || observation.composerCount !== 1 || observation.sendButtonCount !== 1 || !observation.sendEnabled) throw new Error('PASTE_EXACT_PREVIEW_AND_SELECT_WORKSPACE_FIRST');
    const dispatch = await this.freshBinding(i, observation);
    if (i.audit.length >= 99) throw new Error('AUDIT_CAPACITY');
    i.state = 'sending'; i.attempts = 1; i.attemptedAt = iso(this.now);
    i.audit.push({ type: 'dispatch-attempt', at: i.attemptedAt, conversationId: i.binding.conversationId, wireDigest: i.binding.wireDigest });
    await this.save();
    try {
      // Host must atomically revalidate native identity + document + exact draft
      // at the dispatch boundary. A preflight proof alone is insufficient.
      const result = await this.host.dispatchVerified(dispatch.tab, i.wirePrompt, clone(i.binding));
      i.browserObservation = { url: i.binding.canonicalUrl, documentId: i.binding.documentId, clickDispatched: result.clickDispatched === true, observedAt: iso(this.now), verified: false };
      i.audit.push({ type: 'dispatch-returned', at: iso(this.now), conversationId: i.binding.conversationId, wireDigest: i.binding.wireDigest, clickDispatched: result.clickDispatched === true });
      // No stable public native ACK API has been verified. Keep unknown even if click returned.
      i.state = 'unknown'; i.error = result.clickDispatched ? 'CLICK_SENT_ACK_NOT_VERIFIED_OBSERVE_ONLY' : 'SEND_OUTCOME_UNKNOWN';
      if (result.messageEvidence) {
        const evidence = await validateMessageEvidence(i.binding, result.messageEvidence, i.messageEvidence);
        if (!i.messageEvidence.some(x => x.messageId === evidence.messageId)) i.messageEvidence.push(evidence);
        if (evidence.kind === 'user') { i.transport = { state: 'acknowledged', messageId: evidence.messageId }; i.state = 'sent'; delete i.error; }
      }
    } catch (error) { i.state = 'unknown'; i.error = safeErrorCode(error); }
    await this.save(); return clone(i);
  }); }
  capture({ id, confirmed }) { return this.serial(async () => {
    if (confirmed !== true) throw new Error('EXPLICIT_CAPTURE_CONFIRMATION_REQUIRED');
    const i = this.get(id); if (!attempted(i)) throw new Error('NO_SENT_TASK_TO_OBSERVE'); await this.permitted();
    if (i.nativeReceipts.length >= limits.maxReceiptsPerIntent || this.state.intents.reduce((n,x) => n+x.nativeReceipts.length,0) >= limits.maxReceipts) throw new Error('RECEIPT_CAPACITY');
    const tab = this.tab(i);
    if (!tab.conversationId || i.conversationId !== tab.conversationId) throw new Error('CONFIRM_TASK_CONVERSATION_BEFORE_CAPTURE');
    const { binding } = await this.freshBinding(i, null, true);
    const capture = await this.hostRead(() => this.host.capture(tab, i.wirePrompt));
    if (!capture.conversationId || capture.conversationId !== binding.conversationId || capture.url !== binding.canonicalUrl || capture.documentId !== binding.documentId) throw new Error('CONVERSATION_CHANGED_OR_MISSING');
    await this.freshBinding(i, null, true);
    // Selection is still unverified external data, never native message proof.
    const receipt = extractReceipt(capture.selectedReceipt, i, { observedAt: iso(this.now), conversationId: capture.conversationId, chatUrl: capture.url, documentId: capture.documentId });
    if (i.nativeReceipts.some(r => r.raw === receipt.raw && r.conversationId === receipt.conversationId)) return clone(i);
    await this.commitLocal(candidate => {
      const next = candidate.intents.find(x => x.id === i.id);
      const nextTab = candidate.ownedTabs.find(x => x.tabId === tab.tabId && x.intentId === i.id && x.browserSessionId === this.sessionId);
      next.nativeReceipts.push(receipt); next.conversationId = capture.conversationId; next.chatUrl = capture.url;
      nextTab.conversationId = capture.conversationId; nextTab.url = capture.url;
    });
    return clone(this.get(i.id));
  }); }
  observeMessages({ id, includeText = false }) { return this.serial(async () => {
    const i = this.get(id); await this.permitted();
    if (!attempted(i)) throw new Error('NO_SENT_TASK_TO_OBSERVE');
    const { binding } = await this.freshBinding(i, null, true);
    if (typeof this.host.observeMessages !== 'function') throw new Error('NATIVE_MESSAGE_OBSERVER_UNAVAILABLE');
    const rows = await this.hostRead(() => this.host.observeMessages(this.tab(i), clone(binding)));
    if (!Array.isArray(rows) || rows.length > 20) throw new Error('NATIVE_MESSAGE_RESULT_INVALID');
    const history = clone(i.messageEvidence);
    for (const row of rows) {
      const value = await validateMessageEvidence(binding, { ...row, includeText: includeText === true }, history);
      if (!history.some(x => x.messageId === value.messageId)) history.push(value);
    }
    if (history.length > 100) throw new Error('MESSAGE_EVIDENCE_CAPACITY');
    await this.freshBinding(i, null, true); // Fail closed if observation raced navigation.
    await this.commitLocal(candidate => {
      const next = candidate.intents.find(x => x.id === id);
      if (history.length !== next.messageEvidence.length) next.lastObservedProgressAt = iso(this.now);
      next.messageEvidence = history;
    });
    return clone(this.get(id));
  }); }
  idleCheck({ id }) { return this.serial(async () => {
    const i = this.get(id);
    const proposal = evaluateIdle(i, this.now(), i.lastIdleProposal);
    if (proposal.status.startsWith('blocked-') && (!i.lastIdleProposal || JSON.stringify(proposal) !== JSON.stringify(i.lastIdleProposal))) {
      await this.commitLocal(candidate => {
        const next = candidate.intents.find(x => x.id === id);
        if (next.audit.length >= 100) throw new Error('AUDIT_CAPACITY');
        next.lastIdleProposal = proposal;
        next.audit.push({ type: 'idle-advisory', suggestionId: proposal.suggestionId, status: proposal.status, at: iso(this.now), autoSendAllowed: false });
      });
    }
    return { ...clone(this.get(id)), idleCheck: proposal };
  }); }
  cancel({ id }) { return this.serial(async () => {
    const i = this.get(id); if (i.state !== 'queued') throw new Error('ONLY_UNSENT_QUEUED_CAN_CANCEL');
    await this.commitLocal(candidate => { candidate.intents.find(x => x.id === id).state = 'canceled'; }); return clone(this.get(id));
  }); }
  pause({ paused }) { return this.serial(async () => {
    if (typeof paused !== 'boolean') throw new Error('INVALID_PAUSE');
    await this.commitLocal(candidate => { candidate.paused = paused; }); return { paused };
  }); }
  removed(tabId) { return this.serial(async () => {
    const tab = this.state.ownedTabs.find(t => t.tabId === tabId && t.browserSessionId === this.sessionId); if (!tab) return;
    tab.status = 'removed'; const i = this.get(tab.intentId);
    if (i.state === 'sending' || i.state === 'ready') { i.state = 'unknown'; i.error = 'OWNED_TAB_REMOVED_NO_REPLAY'; }
    await this.save();
  }); }
}
