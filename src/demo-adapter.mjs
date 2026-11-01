import { randomUUID } from 'node:crypto';

// JSON.parse and structuredClone do not preserve null prototypes. Normalize on
// EVERY load, and use own-property membership even when a dictionary is new.
function dictionary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DEMO_STORE_DICTIONARY');
  return Object.assign(Object.create(null), value);
}
const own = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;

/** Synthetic provider, isolated from the intent cache; never contacts a real platform. */
export class DemoAdapter {
  constructor(store) { this.store = store; this.scenario = 'success'; }
  async open() {
    this.state = await this.store.open() ?? { version: 1, jobs: Object.create(null), tabs: Object.create(null), sends: 0 };
    if (this.state.version !== 1) throw new Error('DEMO_STORE_VERSION');
    this.state.jobs = dictionary(this.state.jobs);
    this.state.tabs = dictionary(this.state.tabs);
    await this.store.save(this.state); return this;
  }
  setScenario(scenario) {
    if (!['success','lost-ack','router-only','provider-failure','no-receipt','poll-error'].includes(scenario)) throw Object.assign(new Error('INVALID_SCENARIO'), { statusCode: 400 });
    this.scenario = scenario; return { scenario };
  }
  async openOwned({ ownerId, url }) {
    const tabId = `demo-tab-${ownerId}`;
    const tab = { tabId, ownerId, url, documentId: randomUUID(), closed: false };
    this.state.tabs[tabId] = tab; await this.store.save(this.state); return structuredClone(tab);
  }
  async sendOnce({ tabId, documentId, ownerId, idempotencyKey, prompt, origin }) {
    const tab = own(this.state.tabs, tabId);
    if (!tab || tab.closed || tab.documentId !== documentId || tab.ownerId !== ownerId || new URL(tab.url).origin !== origin) throw new Error('DEMO_TAB_GUARD');
    if (Object.hasOwn(this.state.jobs, idempotencyKey)) throw new Error('DEMO_DUPLICATE_SEND_BLOCKED');
    this.state.sends++;
    this.state.jobs[idempotencyKey] = { idempotencyKey, scenario: this.scenario, invocationId: `demo-inv-${randomUUID()}`, taskId: `demo-task-${randomUUID()}`, runId: `demo-run-${randomUUID()}`, sessionId: `demo-session-${randomUUID()}`, prompt, observedAt: new Date().toISOString(), observationId: `demo-obs-${randomUUID()}` };
    await this.store.save(this.state); // Accepted remotely, then lose transport ACK.
    if (['lost-ack','no-receipt'].includes(this.scenario)) throw new Error('Synthetic send ACK lost after provider accepted');
    return { acknowledged: true, chatUrl: `${origin}/fixture.html#${encodeURIComponent(ownerId)}` };
  }
  async observe(intent) {
    const job = own(this.state.jobs, intent.idempotencyKey);
    if (!job || job.scenario === 'no-receipt') return null;
    if (job.scenario === 'poll-error') throw new Error('Synthetic provider unavailable');
    const provider = job.scenario === 'router-only' ? undefined : {
      taskId: job.taskId, runId: job.runId, sessionId: job.sessionId,
      state: job.scenario === 'provider-failure' ? 'failed' : 'succeeded',
      evidence: { authoritative: true, source: 'synthetic-workspace', reference: job.scenario === 'provider-failure' ? 'synthetic-exit-code:1' : 'synthetic-exit-code:0; fixture-output-present' },
    };
    return { observationId: job.observationId, observedAt: job.observedAt, source: 'synthetic-workspace',
      idempotencyKey: job.idempotencyKey, invocationId: job.invocationId, router: { state: 'completed' }, ...(provider ? { provider } : {}), verified: true };
  }
  async safeClose({ tabId, ownerId, documentId, terminal, origin }) {
    const tab = own(this.state.tabs, tabId);
    if (!tab || tab.ownerId !== ownerId || tab.documentId !== documentId || new URL(tab.url).origin !== origin || !terminal) throw new Error('DEMO_CLOSE_PROTECTED');
    tab.closed = true; await this.store.save(this.state); return { closed: true };
  }
  async close() { await this.store.close(); }
}
