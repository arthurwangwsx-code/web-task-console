/** Optional host bridge. No browser profile, credentials, or network API access. */
const terminal = new Set(['succeeded', 'failed', 'canceled']);
const clone = value => structuredClone(value);
function originOf(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported URL');
  return url.origin;
}

export class BrowserAdapter {
  constructor({ driver, allowedOrigins = [], allowExternal = false } = {}) {
    this.driver = driver;
    this.allowExternal = allowExternal;
    this.allowedOrigins = new Set(allowedOrigins.map(value => {
      const origin = originOf(value);
      if (value !== origin) throw new Error('Allowlist entries must be exact origins');
      return origin;
    }));
    this.owned = new Map();
    this.attempts = new Map();
    this.tail = Promise.resolve();
  }

  _serial(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  _allowed(url) {
    const origin = originOf(url);
    if (!this.allowedOrigins.has(origin)) throw new Error('Origin not approved');
    const host = new URL(url).hostname;
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(host);
    if (!local && !this.allowExternal) throw new Error('External browser actions disabled');
    return origin;
  }

  async _owned(tabId, documentId, ownerId) {
    const handle = this.owned.get(String(tabId));
    if (!handle || (ownerId !== undefined && handle.ownerId !== ownerId)) throw new Error('Not an owned tab');
    if (!documentId || handle.documentId !== documentId) throw new Error('Document changed; explicit rebind required');
    const current = await this.driver.readTab({ tabId });
    if (!current || String(current.tabId) !== String(tabId) || current.documentId !== documentId || current.url !== handle.url) {
      throw new Error('Tab navigated or disappeared; action blocked');
    }
    this._allowed(current.url);
    return handle;
  }

  openOwned({ url, ownerId }) {
    return this._serial(async () => {
      this._allowed(url);
      if (typeof ownerId !== 'string' || !ownerId) throw new Error('Owner ID required');
      const tab = await this.driver.openTab({ url, ownerId });
      // An uncertain create is never retried. Do not claim ownership of an ambiguous handle.
      if (!tab || tab.tabId === undefined || !tab.documentId || tab.url !== url) throw new Error('Ambiguous tab creation; inspect manually');
      if (this.owned.has(String(tab.tabId))) throw new Error('Host returned an already owned tab');
      const handle = { tabId: tab.tabId, url, ownerId, documentId: tab.documentId };
      this.owned.set(String(tab.tabId), handle);
      return clone(handle);
    });
  }

  sendOnce({ tabId, documentId, idempotencyKey, prompt, origin, ownerId }) {
    return this._serial(async () => {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey || typeof prompt !== 'string' || !prompt) throw new Error('Key and prompt required');
      const old = this.attempts.get(idempotencyKey);
      if (old) {
        if (old.prompt !== prompt || old.tabId !== String(tabId) || old.documentId !== documentId || old.origin !== origin || old.ownerId !== ownerId) throw new Error('Idempotency conflict');
        return clone(old.result);
      }
      const handle = await this._owned(tabId, documentId, ownerId);
      if (origin !== originOf(handle.url)) throw new Error('Target origin mismatch');
      if (!['127.0.0.1', '[::1]', 'localhost'].includes(new URL(handle.url).hostname)) {
        // The legacy fixture driver has no account/conversation proof contract.
        // Explicit origin opt-in must not bypass the strict native binding path.
        throw new Error('Native task/conversation dispatch contract unavailable in legacy BrowserAdapter');
      }
      // Record BEFORE any UI side effect. The engine must durably reserve its intent first.
      const attempt = { prompt, tabId: String(tabId), documentId, origin, ownerId, result: { acknowledged: false, state: 'unknown' } };
      this.attempts.set(idempotencyKey, attempt);
      try {
        const guard = { tabId, documentId, expectedUrl: handle.url, idempotencyKey };
        await this.driver.fillComposer({ ...guard, text: prompt });
        const text = await this.driver.readComposer(guard);
        if (text !== prompt) throw new Error('Composer readback mismatch');
        await this._owned(tabId, documentId, ownerId);
        // Host must enforce guard atomically with click; never fall back to Enter.
        await this.driver.clickSend(guard);
        const ack = await this.driver.observeAck(guard);
        if (ack?.acknowledged === true && ack.idempotencyKey === idempotencyKey) {
          // A correlated visible send acknowledgement is not a provider receipt.
          attempt.result = { acknowledged: true, state: 'sent' };
          if (ack.chatUrl && originOf(ack.chatUrl) === origin) attempt.result.chatUrl = ack.chatUrl;
        }
      } catch {
        // No raw page text/errors copied to logs. Timeout and interrupted sends stay unknown.
        attempt.result = { acknowledged: false, state: 'unknown' };
      }
      return clone(attempt.result);
    });
  }

  observe({ tabId, documentId, ownerId }) {
    return this._serial(async () => clone(await this._owned(tabId, documentId, ownerId)));
  }

  safeClose({ tabId, documentId, ownerId, dispatchState, providerState, verified = false }) {
    return this._serial(async () => {
      if (dispatchState !== 'sent' || !terminal.has(providerState) || verified !== true) throw new Error('Active, unknown, or unverified task protects tab');
      const handle = await this._owned(tabId, documentId, ownerId);
      await this.driver.closeTab({ tabId, documentId, expectedUrl: handle.url });
      this.owned.delete(String(tabId));
      return { closed: true, canceledJob: false };
    });
  }
}
