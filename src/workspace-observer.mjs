/** Read-only observation adapter; execution authority always remains with its owner. */
const routers = new Set(['queued', 'running', 'completed', 'failed', 'canceled', 'unknown']);
const providers = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled', 'unknown']);
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const provenanceValid = (value, source) => value?.source === source && nonempty(value.observationId) && Number.isFinite(Date.parse(value.observedAt));

export class WorkspaceObserver {
  constructor({ readByKey, readByInvocation, readProvider, source } = {}) {
    if (!nonempty(source) || (typeof readByKey !== 'function' && typeof readByInvocation !== 'function')) throw new Error('Named source and a read-only lookup are required');
    if ([readByKey, readByInvocation, readProvider].some(fn => fn !== undefined && typeof fn !== 'function')) throw new Error('Read-only lookup must be a function');
    Object.assign(this, { readByKey, readByInvocation, readProvider, source });
  }

  async observe(intent) {
    const key = intent.idempotencyKey;
    if (!nonempty(key)) throw new Error('Exact idempotency key required');
    const invocationId = intent.invocationId;
    if (invocationId !== undefined && invocationId !== null && !nonempty(invocationId)) throw new Error('Exact invocation ID required');
    const raw = invocationId && this.readByInvocation
      ? await this.readByInvocation({ invocationId, idempotencyKey: key })
      : this.readByKey ? await this.readByKey({ idempotencyKey: key }) : null;
    if (!raw) return null;
    if (raw.idempotencyKey !== key || (invocationId && raw.invocationId !== invocationId)) throw new Error('Receipt correlation mismatch');
    if (!provenanceValid(raw, this.source)) return null;
    const observation = {
      observationId: raw.observationId, observedAt: raw.observedAt, source: this.source, idempotencyKey: key,
      router: { state: routers.has(raw.router?.state) ? raw.router.state : 'unknown' }, verified: raw.verified === true,
    };
    if (nonempty(raw.invocationId)) observation.invocationId = raw.invocationId;
    let producer = raw.provider;
    if (producer && this.readProvider) {
      const ids = Object.fromEntries(['taskId', 'runId', 'sessionId'].filter(name => nonempty(producer[name])).map(name => [name, producer[name]]));
      if (Object.keys(ids).length) {
        const resolved = await this.readProvider({ ...ids, idempotencyKey: key });
        if (resolved) {
          if (resolved.idempotencyKey !== key || Object.entries(ids).some(([name, id]) => resolved[name] !== id)) throw new Error('Provider receipt correlation mismatch');
          if (!provenanceValid(resolved, this.source)) throw new Error('Provider observation provenance missing or mismatched');
          // Both source snapshots identify the merged observation; unchanged router IDs
          // must not collide with newer producer state under a reused receipt ID.
          observation.observationId = JSON.stringify([raw.observationId, resolved.observationId]);
          observation.observedAt = resolved.observedAt;
          observation.verified = observation.verified && resolved.verified === true;
          producer = resolved;
        }
      }
    }
    if (producer) {
      const ids = Object.fromEntries(['taskId', 'runId', 'sessionId'].filter(name => nonempty(producer[name])).map(name => [name, producer[name]]));
      observation.provider = { ...ids, state: providers.has(producer.state) ? producer.state : 'unknown' };
      // Router completion and prose are not evidence. Adapter trust must be established out of band.
      const evidence = producer.evidence;
      if (Object.keys(ids).length && observation.verified && evidence?.authoritative === true && nonempty(evidence.reference) && evidence.source === this.source) {
        observation.provider.evidence = { authoritative: true, source: this.source, reference: evidence.reference };
      }
    }
    return observation;
  }
}
