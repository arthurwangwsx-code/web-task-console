/**
 * Narrow read-only projection of capability_status({invocationId}).
 * No transport, credentials, registry discovery, invoke or retry implementation.
 * The injected reader must be the caller's approved MCP read-only tool.
 */
const fail = code => { throw new Error(code); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const lifecycle = new Map([['queued','queued'], ['running','running'], ['succeeded','completed'], ['failed','failed'], ['cancelled','canceled'], ['canceled','canceled']]);
const encoder = new TextEncoder();
async function hash(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(n => n.toString(16).padStart(2,'0')).join('');
}
function boundedCanonical(value) {
  let visited = 0, bytes = 0;
  const stack = new Set();
  function walk(item, depth) {
    if (++visited > 10000 || depth > 64) fail('STATUS_SNAPSHOT_TOO_COMPLEX');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('STATUS_SNAPSHOT_NOT_JSON'); return item; }
    if (typeof item === 'string') { bytes += encoder.encode(item).length; if (bytes > 1048576) fail('STATUS_SNAPSHOT_TOO_LARGE'); return item; }
    if (!Array.isArray(item) && !object(item)) fail('STATUS_SNAPSHOT_NOT_JSON');
    if (stack.has(item)) fail('STATUS_SNAPSHOT_NOT_JSON');
    stack.add(item);
    let result;
    if (Array.isArray(item)) result = item.map(x => walk(x, depth + 1));
    else {
      result = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        bytes += encoder.encode(key).length;
        if (bytes > 1048576) fail('STATUS_SNAPSHOT_TOO_LARGE');
        // Transport results must be plain decoded JSON, not getters/proxies.
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('STATUS_SNAPSHOT_NOT_JSON');
        result[key] = walk(descriptor.value, depth + 1);
      }
    }
    stack.delete(item); return result;
  }
  const encoded = JSON.stringify(walk(value, 0));
  if (encoder.encode(encoded).length > 1048576) fail('STATUS_SNAPSHOT_TOO_LARGE');
  return encoded;
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail('STATUS_TIME_INVALID');
  return new Date(value).toISOString();
}

/** Pure projection. Input text content/_meta/result claims never grant authority. */
export async function mapCapabilityStatus(envelope, { invocationId, idempotencyKey, source, observedAt }) {
  if (!identifier(invocationId) || !identifier(idempotencyKey) || !identifier(source)) fail('STATUS_QUERY_ID_INVALID');
  const receivedAt = iso(observedAt);
  if (envelope?.isError === true) fail('STATUS_TOOL_ERROR');
  const structured = object(envelope) && Object.hasOwn(envelope, 'structuredContent') ? envelope.structuredContent : null;
  if (!object(structured) || !Object.hasOwn(structured, 'data')) fail('STATUS_STRUCTURED_DATA_REQUIRED');
  if (structured.data === null) return null; // Not found is NOT proof of no execution.
  const data = structured.data;
  if (!object(data)) fail('STATUS_INVOCATION_OBJECT_REQUIRED');
  if (['id','capabilityId','providerId','status'].some(key => !Object.hasOwn(data, key))) fail('STATUS_INVOCATION_FIELDS_REQUIRED');
  if (!identifier(data.id) || data.id !== invocationId) fail('STATUS_INVOCATION_MISMATCH');
  if (!identifier(data.capabilityId) || !identifier(data.providerId)) fail('STATUS_ROUTE_ID_INVALID');
  if (typeof data.status !== 'string' || !data.status || data.status.length > 256) fail('STATUS_LIFECYCLE_INVALID');
  if (Object.hasOwn(data, 'principalId') && (typeof data.principalId !== 'string' || !data.principalId || data.principalId.length > 512)) fail('STATUS_PRINCIPAL_INVALID');
  const canonical = boundedCanonical(data);
  const snapshotDigest = await hash(canonical);
  const known = lifecycle.has(data.status);
  const evidence = {
    schemaVersion: 1, kind: 'workspace-capability-status', operation: 'capability_status',
    requestedInvocationId: invocationId, returnedInvocationId: data.id,
    capabilityId: data.capabilityId, providerId: data.providerId,
    status: known ? data.status : 'unrecognized', snapshotDigest, receivedAt,
    correlation: 'exact-invocation-local-key-unverified', provenance: 'external-observed',
    authority: 'router-only', chatIdentityVerified: false, businessVerified: false,
  };
  if (!known) evidence.unrecognizedStatusDigest = await hash(data.status);
  if (Object.hasOwn(data, 'principalId')) evidence.principalDigest = await hash(data.principalId);
  if (Object.hasOwn(data, 'result')) evidence.resultDigest = await hash(boundedCanonical(data.result));
  for (const field of ['queuedAt','startedAt','finishedAt']) if (Object.hasOwn(data, field) && data[field] !== null) evidence[field] = iso(data[field]);
  const times = ['queuedAt','startedAt','finishedAt'].filter(key => evidence[key]).map(key => Date.parse(evidence[key]));
  if (times.some((time, n) => n > 0 && time < times[n - 1])) fail('STATUS_TIME_ORDER_INVALID');
  if (Object.hasOwn(structured, 'meta') && object(structured.meta) && Object.hasOwn(structured.meta, 'requestId')) {
    if (!identifier(structured.meta.requestId)) fail('STATUS_REQUEST_ID_INVALID');
    evidence.requestId = structured.meta.requestId;
  }
  const observationId = 'capability-status:' + await hash(JSON.stringify([source, invocationId, snapshotDigest, evidence.requestId ?? null]));
  return {
    observationId, observedAt: receivedAt, source, idempotencyKey, invocationId,
    router: { state: known ? lifecycle.get(data.status) : 'unknown' },
    // The read response does not prove the original task key or ChatGPT binding.
    verified: false, provenance: 'external-observed', callEvidence: evidence,
    // Deliberately no provider, completion, native message or browser identity.
  };
}

export class CapabilityStatusObserver {
  constructor({ capabilityStatus, source, now = Date.now } = {}) {
    if (typeof capabilityStatus !== 'function' || !identifier(source) || typeof now !== 'function') fail('STATUS_READER_CONFIG_REQUIRED');
    Object.assign(this, { capabilityStatus, source, now });
  }
  async readByInvocation({ invocationId, idempotencyKey }) {
    if (!identifier(idempotencyKey)) fail('STATUS_QUERY_ID_INVALID');
    if (invocationId === undefined || invocationId === null) return null;
    if (!identifier(invocationId)) fail('STATUS_QUERY_ID_INVALID');
    let envelope;
    try {
      // The real tool accepts invocationId, NOT an idempotency-key lookup.
      envelope = await this.capabilityStatus({ invocationId });
    } catch { fail('STATUS_READ_FAILED'); } // Never return arbitrary upstream text.
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8640000000000000) fail('STATUS_TIME_INVALID');
    return mapCapabilityStatus(envelope, { invocationId, idempotencyKey, source: this.source, observedAt: new Date(timestamp).toISOString() });
  }
  async observe(intent) { return this.readByInvocation({ invocationId: intent.invocationId, idempotencyKey: intent.idempotencyKey }); }
}
