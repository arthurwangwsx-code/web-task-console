import { createHash, randomUUID } from 'node:crypto';

const terminal = new Set(['succeeded', 'failed', 'canceled']);
const dispatchStates = new Set(['queued', 'sending', 'sent', 'unknown', 'canceled']);
const providerStates = new Set(['unobserved', 'queued', 'running', 'succeeded', 'failed', 'canceled', 'unknown']);
const routerStates = new Set(['unknown', 'queued', 'running', 'completed', 'failed', 'canceled']);
const digest = x => createHash('sha256').update(x).digest('hex');
const copy = x => structuredClone(x);
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const safeError = error => String(error?.message || 'Adapter error').replace(/https?:\/\/\S+/g, '[url]').slice(0, 240);
export const defaultConfig = Object.freeze({
  maxQueued: 20, maxIntents: 200, maxActive: 2, maxActivePerScope: 1,
  maxTabs: 4, maxReceipts: 2000, receiptReserve: 4, maxObservationsPerIntent: 16,
  minDispatchIntervalMs: 300, pollBaseMs: 1000, pollMaxMs: 60000,
  allowedOrigins: ['http://127.0.0.1:4173'],
});

/** Local intent/observation cache ONLY. The provider remains the sole business authority. */
export class IntentEngine {
  constructor({ store, adapter, config = {}, clock = () => Date.now(), random = Math.random }) {
    this.store = store; this.adapter = adapter; this.config = { ...defaultConfig, ...config };
    this.clock = clock; this.random = random; this.chain = Promise.resolve();
    for (const key of ['maxQueued','maxIntents','maxActive','maxActivePerScope','maxTabs','maxReceipts','receiptReserve','maxObservationsPerIntent']) {
      if (!Number.isInteger(this.config[key]) || this.config[key] < 1) throw new Error(`Invalid config: ${key}`);
    }
  }
  exclusive(action) { const result = this.chain.then(action); this.chain = result.catch(() => {}); return result; }
  async open() {
    const old = await this.store.open();
    this.state = old ?? { version: 1, paused: false, intents: [], tabs: [], observations: [], audit: [], lastScope: null, lastDispatchAt: null };
    if (this.state.version !== 1 || !Array.isArray(this.state.intents) || this.state.intents.some(i => !dispatchStates.has(i.dispatch.state))) throw new Error('UNSUPPORTED_OR_CORRUPT_STORE');
    await this.recover(); return this;
  }
  stamp() { return new Date(this.clock()).toISOString(); }
  note(kind, intentId = null, detail = '') {
    this.state.audit.push({ at: this.stamp(), kind, intentId, detail });
    this.state.audit = this.state.audit.slice(-400);
  }
  save() { return this.store.save(this.state); }
  isTerminal(i) { return i.completion?.verified === true && terminal.has(i.provider.state); }
  active(i) { return ['sending','sent','unknown'].includes(i.dispatch.state) && !this.isTerminal(i); }
  view(i) {
    return { ...copy(i), status: this.isTerminal(i) ? i.provider.state : i.dispatch.state === 'sent' ? 'awaiting-provider' : i.dispatch.state };
  }
  snapshot() {
    return { mode: 'synthetic-demo', authority: 'intent-and-observation-cache-only', paused: this.state.paused,
      intents: this.state.intents.map(i => this.view(i)), tabs: copy(this.state.tabs), config: copy(this.config),
      metrics: { queued: this.state.intents.filter(i => i.dispatch.state === 'queued').length,
        active: this.state.intents.filter(i => this.active(i)).length,
        unknown: this.state.intents.filter(i => i.dispatch.state === 'unknown').length,
        openTabs: this.state.tabs.filter(t => t.state !== 'closed').length,
        receipts: this.state.observations.length }, audit: copy(this.state.audit) };
  }
  recover() { return this.exclusive(async () => {
    for (const i of this.state.intents) if (i.dispatch.state === 'sending') {
      i.dispatch = { ...i.dispatch, state: 'unknown', error: 'Interrupted during send; observation only. Never automatically resend.' };
      this.note('recovered-unknown', i.id);
    }
    for (const t of this.state.tabs) if (t.state === 'closing') t.state = 'close-unknown';
    await this.save();
  }); }
  enqueue(input) { return this.exclusive(async () => {
    const { idempotencyKey, prompt, origin = this.config.allowedOrigins[0], scope = 'demo' } = input ?? {};
    if (typeof idempotencyKey !== 'string' || !/^[\w.-]{1,128}$/.test(idempotencyKey)) throw fail('INVALID_IDEMPOTENCY_KEY', 400);
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32000) throw fail('INVALID_PROMPT', 400);
    if (typeof scope !== 'string' || !/^[\w.-]{1,80}$/.test(scope)) throw fail('INVALID_SCOPE', 400);
    if (!this.config.allowedOrigins.includes(origin) || new URL(origin).origin !== origin) throw fail('ORIGIN_NOT_APPROVED', 403);
    const fingerprint = digest(JSON.stringify({ prompt, origin, scope }));
    const old = this.state.intents.find(i => i.idempotencyKey === idempotencyKey);
    if (old) { if (old.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_KEY_CONFLICT'); return this.view(old); }
    if (this.state.intents.length >= this.config.maxIntents) throw fail('INTENT_RETENTION_FULL', 429);
    if (this.state.intents.filter(i => i.dispatch.state === 'queued').length >= this.config.maxQueued) throw fail('QUEUE_FULL', 429);
    const i = { id: randomUUID(), idempotencyKey, fingerprint, prompt, origin, scope, createdAt: this.stamp(),
      dispatch: { state: 'queued', attempts: 0 }, router: { state: 'unknown' }, provider: { state: 'unobserved' },
      completion: { verified: false }, poll: { failures: 0, nextAt: 0 }, tabId: null, observationIds: [] };
    this.state.intents.push(i); this.note('intent-created', i.id); await this.save(); return this.view(i);
  }); }
  blockReason(i) {
    const active = this.state.intents.filter(x => this.active(x));
    if (active.length >= this.config.maxActive) return 'ACTIVE_CAPACITY';
    if (active.filter(x => x.scope === i.scope).length >= this.config.maxActivePerScope) return 'SCOPE_CAPACITY';
    if (this.state.tabs.filter(t => t.state !== 'closed').length >= this.config.maxTabs) return 'TAB_CAPACITY';
    const reservations = active.filter(x => !x.observationIds.length).length * this.config.receiptReserve;
    if (this.config.maxReceipts - this.state.observations.length - reservations < this.config.receiptReserve) return 'RECEIPT_CAPACITY';
    if (this.state.lastDispatchAt !== null && this.clock() - this.state.lastDispatchAt < this.config.minDispatchIntervalMs) return 'DISPATCH_RATE_LIMIT';
    return null;
  }
  tick() { return this.exclusive(async () => {
    if (this.state.paused) return { dispatched: false, reason: 'PAUSED' };
    const queued = this.state.intents.filter(i => i.dispatch.state === 'queued');
    const scopes = [...new Set(queued.map(i => i.scope))];
    if (scopes.length > 1 && scopes[0] === this.state.lastScope) scopes.push(scopes.shift());
    let selected = null;
    for (const scope of scopes) { const i = queued.find(x => x.scope === scope); i.blockedBy = this.blockReason(i); if (!i.blockedBy) { selected = i; break; } }
    if (!selected) { await this.save(); return { dispatched: false, reason: queued[0]?.blockedBy ?? 'EMPTY' }; }
    const i = selected;
    const tab = { id: `tab-${i.id}`, ownerId: i.id, owned: true, state: 'opening', url: i.origin, externalId: null, documentId: null };
    i.tabId = tab.id; this.state.tabs.push(tab);
    i.dispatch = { state: 'sending', attempts: 1, startedAt: this.stamp() };
    this.state.lastDispatchAt = this.clock(); this.state.lastScope = i.scope;
    this.note('send-intent-persisted', i.id); await this.save(); // durable BEFORE any external side effect
    try {
      const opened = await this.adapter.openOwned({ ownerId: i.id, url: i.origin });
      if (!opened || opened.ownerId !== i.id || !opened.tabId || new URL(opened.url).origin !== i.origin) throw new Error('INVALID_OWNED_TAB');
      tab.externalId = opened.tabId; tab.documentId = opened.documentId; tab.url = opened.url; tab.state = 'open';
      await this.save();
      const ack = await this.adapter.sendOnce({ tabId: tab.externalId, documentId: tab.documentId, ownerId: i.id, idempotencyKey: i.idempotencyKey, prompt: i.prompt, origin: i.origin });
      if (ack?.acknowledged !== true) throw new Error('SEND_ACK_NOT_PROVEN');
      i.dispatch.state = 'sent'; i.dispatch.acknowledgedAt = this.stamp();
      if (ack.chatUrl && new URL(ack.chatUrl).origin === i.origin) i.chatUrl = ack.chatUrl;
      this.note('send-acknowledged', i.id);
    } catch (error) {
      i.dispatch.state = 'unknown'; i.dispatch.error = safeError(error); this.note('send-unknown', i.id);
    }
    await this.save(); return { dispatched: true, intent: this.view(i) };
  }); }
  getIntent(id) { const i = this.state.intents.find(x => x.id === id); if (!i) throw fail('INTENT_NOT_FOUND', 404); return i; }
  reconcile(id) { return this.exclusive(async () => {
    const i = this.getIntent(id);
    if (!this.active(i)) return this.view(i);
    if (i.poll.nextAt > this.clock()) throw fail('OBSERVATION_BACKOFF', 429);
    if (this.state.observations.length >= this.config.maxReceipts) throw fail('RECEIPT_CAPACITY', 429);
    try {
      const receipt = await this.adapter.observe(copy(i));
      if (!receipt) { this.backoff(i, 'No authoritative observation found; not proof of no execution.'); await this.save(); return this.view(i); }
      this.applyObservation(i, receipt);
      i.poll = { failures: 0, nextAt: this.clock() + this.config.pollBaseMs };
      this.note('observation-recorded', i.id);
    } catch (error) {
      this.backoff(i, safeError(error)); this.note('observation-error', i.id);
    }
    await this.save(); return this.view(i);
  }); }
  backoff(i, error) {
    i.poll.failures++; i.poll.error = error;
    const ms = Math.min(this.config.pollMaxMs, this.config.pollBaseMs * 2 ** Math.min(i.poll.failures - 1, 16));
    i.poll.nextAt = this.clock() + Math.ceil(ms * (0.8 + this.random() * 0.4));
  }
  applyObservation(i, r) {
    if (!r || typeof r.observationId !== 'string' || !r.observationId || r.idempotencyKey !== i.idempotencyKey ||
      typeof r.source !== 'string' || !r.source || !Number.isFinite(Date.parse(r.observedAt)) || !routerStates.has(r.router?.state)) throw new Error('INVALID_OR_UNCORRELATED_RECEIPT');
    if (r.provider && !providerStates.has(r.provider.state)) throw new Error('INVALID_PROVIDER_STATE');
    if (r.verified !== true) throw new Error('UNVERIFIED_RECEIPT');
    if (i.invocationId && r.invocationId && i.invocationId !== r.invocationId) throw new Error('INVOCATION_ID_CONFLICT');
    for (const key of ['taskId','runId','sessionId']) if (i.provider[key] && r.provider?.[key] && i.provider[key] !== r.provider[key]) throw new Error('PROVIDER_ID_CONFLICT');
    const exists = this.state.observations.find(x => x.observationId === r.observationId);
    if (exists) { if (exists.idempotencyKey !== r.idempotencyKey || JSON.stringify(exists) !== JSON.stringify(r)) throw new Error('OBSERVATION_ID_CONFLICT'); return; }
    if (i.observationIds.length >= this.config.maxObservationsPerIntent) throw new Error('INTENT_OBSERVATION_CAPACITY');
    if (i.lastObservedAt && Date.parse(r.observedAt) < Date.parse(i.lastObservedAt)) throw new Error('STALE_OBSERVATION');
    this.state.observations.push(copy(r)); i.observationIds.push(r.observationId); i.lastObservedAt = r.observedAt;
    if (r.invocationId) i.invocationId = r.invocationId;
    i.router = copy(r.router);
    if (r.provider) { i.provider = { ...i.provider, ...copy(r.provider) }; if (!r.provider.evidence) delete i.provider.evidence; }
    // Router completion, a browser ACK, and natural-language claims are not business success.
    const hasProviderId = Boolean(i.provider.taskId || i.provider.runId || i.provider.sessionId);
    const evidence = r.provider?.evidence;
    i.completion = { verified: terminal.has(r.provider?.state) && hasProviderId && evidence?.authoritative === true && evidence.source === r.source && typeof evidence.reference === 'string' && evidence.reference.length > 0,
      source: r.source, observationId: r.observationId };
    if (i.dispatch.state === 'unknown' && (r.invocationId || hasProviderId)) {
      i.dispatch.state = 'sent'; i.dispatch.recoveredByObservation = true; delete i.dispatch.error;
    }
  }
  closeTab(id) { return this.exclusive(async () => {
    const tab = this.state.tabs.find(t => t.id === id); if (!tab) throw fail('TAB_NOT_OWNED', 403);
    const i = this.getIntent(tab.ownerId);
    if (!tab.owned || tab.id !== i.tabId) throw fail('TAB_NOT_OWNED', 403);
    if (tab.state === 'closed') return copy(tab);
    if (tab.state === 'close-unknown') throw fail('TAB_CLOSE_UNKNOWN_REQUIRES_READBACK');
    if (!this.isTerminal(i)) throw fail('TAB_PROTECTED_ACTIVE_OR_UNKNOWN');
    if (!tab.externalId) throw fail('TAB_IDENTITY_UNKNOWN');
    tab.state = 'closing'; await this.save();
    try {
      const result = await this.adapter.safeClose({ tabId: tab.externalId, ownerId: i.id, documentId: tab.documentId, terminal: true, origin: i.origin, dispatchState: i.dispatch.state, providerState: i.provider.state, verified: i.completion.verified });
      if (result?.closed !== true) throw new Error('CLOSE_NOT_CONFIRMED');
      tab.state = 'closed'; this.note('owned-tab-closed', i.id);
    } catch (error) { tab.state = 'close-unknown'; tab.error = safeError(error); }
    await this.save(); return copy(tab);
  }); }
  cancelQueued(id) { return this.exclusive(async () => {
    const i = this.getIntent(id); if (i.dispatch.state !== 'queued') throw fail('ONLY_UNSENT_INTENTS_CAN_BE_CANCELED');
    i.dispatch.state = 'canceled'; this.note('queued-intent-canceled', i.id); await this.save(); return this.view(i);
  }); }
  setPaused(paused) { return this.exclusive(async () => { this.state.paused = Boolean(paused); await this.save(); return { paused: this.state.paused }; }); }
  async close() { await this.chain; await this.store.close(); }
}
