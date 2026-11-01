// Host results must come from a trusted adapter, NEVER page JSON or imported claims.
const fail = code => { throw new Error(code); };
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
export async function digestText(text) {
  if (typeof text !== 'string') fail('BINDING_TEXT_REQUIRED');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function canonicalConversation(url) {
  if (typeof url !== 'string') fail('BINDING_URL_INVALID');
  let parsed; try { parsed = new URL(url); } catch { fail('BINDING_URL_INVALID'); }
  const match = /^\/c\/([A-Za-z0-9-]{1,100})$/.exec(parsed.pathname);
  if (parsed.origin !== 'https://chatgpt.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !match || url !== 'https://chatgpt.com/c/' + match[1]) fail('BINDING_URL_INVALID');
  return { conversationId: match[1], canonicalUrl: url };
}
export async function createPendingBinding(intent) {
  if (!string(intent?.id) || !string(intent.idempotencyKey)) fail('BINDING_TASK_INVALID');
  return { state: 'pending', taskId: intent.id, idempotencyKey: intent.idempotencyKey, goalDigest: await digestText(intent.prompt), wireDigest: await digestText(intent.wirePrompt) };
}
export function assertUniqueBinding(intents, intentId, conversationId) {
  if (!Array.isArray(intents)) fail('BINDING_LEDGER_REQUIRED');
  if (intents.some(x => x.id !== intentId && x.binding?.state === 'verified' && x.binding.conversationId === conversationId)) fail('BINDING_CONVERSATION_IN_USE');
  if (intents.filter(x => x.id === intentId).length > 1) fail('BINDING_DUPLICATE_TASK');
}
function nativeIdentity(proof, context) {
  if (proof?.available !== true || proof.source !== 'native-host') fail('BINDING_NATIVE_IDENTITY_UNAVAILABLE');
  for (const key of ['accountContextId', 'conversationId', 'documentId', 'browserSessionId', 'reference']) if (!string(proof[key])) fail('BINDING_NATIVE_IDENTITY_INCOMPLETE');
  if (!Number.isSafeInteger(proof.tabId) || proof.tabId < 0) fail('BINDING_NATIVE_IDENTITY_INCOMPLETE');
  const canonical = canonicalConversation(proof.url);
  if (canonical.conversationId !== proof.conversationId) fail('BINDING_CONVERSATION_MISMATCH');
  if (!context || ['tabId','documentId','browserSessionId','url'].some(key => context[key] !== proof[key])) fail('BINDING_CONTEXT_CHANGED');
  if (context.accountContextId !== undefined && context.accountContextId !== proof.accountContextId) fail('BINDING_ACCOUNT_CHANGED');
  return { ...canonical, accountContextId: proof.accountContextId, documentId: proof.documentId, browserSessionId: proof.browserSessionId, tabId: proof.tabId };
}
const identityKeys = ['conversationId','canonicalUrl','accountContextId','documentId','browserSessionId','tabId'];
const digestKeys = ['taskId','idempotencyKey','goalDigest','wireDigest'];
export async function bindVerified(intents, intent, proof, context) {
  const pending = await createPendingBinding(intent);
  const identity = nativeIdentity(proof, context);
  const old = intent.binding;
  if (old?.dispatchAllowed === false) fail('BINDING_OBSERVATION_ONLY');
  if (old && (!['pending','verified'].includes(old.state) || digestKeys.some(key => old[key] !== pending[key]))) fail('BINDING_TASK_CHANGED');
  assertUniqueBinding(intents, intent.id, identity.conversationId);
  if (old?.state === 'verified') {
    if (identityKeys.some(key => old[key] !== identity[key])) fail('BINDING_IMMUTABLE');
    return structuredClone(old);
  }
  return { ...pending, ...identity, state: 'verified', proofSource: 'native-host', reference: proof.reference };
}
export async function verifyDispatchBinding(intent, binding, proof, context) {
  if (binding?.dispatchAllowed === false) fail('BINDING_OBSERVATION_ONLY');
  if (binding?.state !== 'verified' || binding.proofSource !== 'native-host') fail('BINDING_NOT_VERIFIED');
  const pending = await createPendingBinding(intent);
  if (digestKeys.some(key => binding[key] !== pending[key])) fail('BINDING_TASK_CHANGED');
  const identity = nativeIdentity(proof, context);
  if (identityKeys.some(key => binding[key] !== identity[key])) fail('BINDING_CONTEXT_CHANGED');
  // Dispatch lifecycle/attempt checks and transaction serialization belong to controller.
  return true;
}
const fixedObservationKeys = [...digestKeys, 'conversationId', 'canonicalUrl', 'accountContextId'];
export async function rebindObservation(binding, proof, context) {
  if (binding?.state !== 'verified' || binding.proofSource !== 'native-host') fail('BINDING_NOT_VERIFIED');
  const identity = nativeIdentity(proof, context);
  if (['conversationId', 'canonicalUrl', 'accountContextId'].some(key => identity[key] !== binding[key])) fail('OBSERVATION_IDENTITY_CHANGED');
  return { ...structuredClone(binding), ...identity, dispatchAllowed: false, reference: proof.reference };
}
export async function verifyObservationBinding(intent, originalBinding, observationBinding, proof, context) {
  if (originalBinding?.state !== 'verified' || originalBinding.proofSource !== 'native-host' || originalBinding.dispatchAllowed === false) fail('BINDING_ORIGINAL_REQUIRED');
  if (observationBinding?.state !== 'verified' || observationBinding.proofSource !== 'native-host' || observationBinding.dispatchAllowed !== false) fail('BINDING_OBSERVATION_ONLY_REQUIRED');
  const pending = await createPendingBinding(intent);
  if (digestKeys.some(key => originalBinding[key] !== pending[key])) fail('BINDING_TASK_CHANGED');
  if (fixedObservationKeys.some(key => originalBinding[key] !== observationBinding[key])) fail('OBSERVATION_IDENTITY_CHANGED');
  const identity = nativeIdentity(proof, context);
  if (identityKeys.some(key => observationBinding[key] !== identity[key])) fail('BINDING_CONTEXT_CHANGED');
  return true;
}
function safeBody(raw) {
  if (typeof raw !== 'string' || raw.length > 65536) fail('MESSAGE_BODY_INVALID');
  const names = /^(?:accesstoken|refreshtoken|authorization|cookies?|setcookie|password|passwd|passphrase|apikey|clientsecret|idtoken|sessiontoken|authtoken|privatekey|credentials)$/;
  const badKey = s => names.test(s.normalize('NFKC').replace(/[\s_-]/g, '').toLowerCase());
  const badValue = s => { const normalized = s.normalize('NFKC'); return /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/i.test(normalized) || /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(normalized); };
  if (badValue(raw)) fail('MESSAGE_SENSITIVE_CONTENT');
  // Inspect decoded string tokens too, including overwritten duplicate JSON keys.
  for (const match of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
    let value; try { value = JSON.parse(match[0]); } catch { continue; }
    if (badValue(value) || (raw.slice(match.index + match[0].length).trimStart().startsWith(':') && badKey(value))) fail('MESSAGE_SENSITIVE_CONTENT');
  }
  let parsed; try { parsed = JSON.parse(raw); } catch { return; }
  const queue = [[parsed, 0]]; let count = 0;
  while (queue.length) {
    if (++count > 10000) fail('MESSAGE_BODY_TOO_COMPLEX');
    const [value, depth] = queue.pop();
    if (depth > 64) fail('MESSAGE_BODY_TOO_COMPLEX');
    if (typeof value === 'string' && badValue(value)) fail('MESSAGE_SENSITIVE_CONTENT');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (badKey(key)) fail('MESSAGE_SENSITIVE_CONTENT');
      queue.push([child, depth + 1]);
    }
  }
}
export async function validateMessageEvidence(binding, evidence, previous = []) {
  if (binding?.state !== 'verified' || binding.proofSource !== 'native-host') fail('BINDING_NOT_VERIFIED');
  if (evidence?.source !== 'native-host' || !string(evidence.messageId) || !['user','assistant','tool'].includes(evidence.kind)) fail('MESSAGE_NATIVE_IDENTITY_REQUIRED');
  if (['conversationId','accountContextId','documentId','browserSessionId','tabId'].some(key => evidence[key] !== binding[key])) fail('MESSAGE_CONTEXT_MISMATCH');
  if (evidence.url !== undefined && canonicalConversation(evidence.url).canonicalUrl !== binding.canonicalUrl) fail('MESSAGE_CONTEXT_MISMATCH');
  if (!Number.isSafeInteger(evidence.observedAt) || evidence.observedAt > 8640000000000000 || evidence.observedAt < 0 || typeof evidence.truncated !== 'boolean') fail('MESSAGE_TIME_OR_TRUNCATION_REQUIRED');
  if (!Array.isArray(previous)) fail('MESSAGE_HISTORY_INVALID');
  for (const row of previous) if (row.taskId !== binding.taskId || row.conversationId !== binding.conversationId || row.accountContextId !== binding.accountContextId) fail('MESSAGE_HISTORY_CONTEXT_MISMATCH');
  let contentDigest = null;
  if (evidence.raw !== undefined) { safeBody(evidence.raw); contentDigest = await digestText(evidence.raw); }
  if (evidence.kind === 'user' && (evidence.truncated || contentDigest !== binding.wireDigest)) fail('MESSAGE_SENT_TEXT_MISMATCH');
  const old = previous.find(row => row.messageId === evidence.messageId);
  if (old) {
    if (old.kind !== evidence.kind || old.contentDigest !== contentDigest || old.truncated !== evidence.truncated) fail('MESSAGE_ID_CONTENT_CONFLICT');
    return structuredClone(old);
  }
  if (previous.some(row => row.observedAt > evidence.observedAt)) fail('MESSAGE_OUT_OF_ORDER');
  return { taskId: binding.taskId, conversationId: binding.conversationId, canonicalUrl: binding.canonicalUrl, accountContextId: binding.accountContextId, documentId: binding.documentId, browserSessionId: binding.browserSessionId, tabId: binding.tabId, messageId: evidence.messageId, kind: evidence.kind, source: 'native-host', observedAt: evidence.observedAt, truncated: evidence.truncated, contentDigest, sequence: previous.length + 1, identityVerified: true, businessState: 'unknown', businessVerified: false, ...(evidence.includeText === true && evidence.raw !== undefined ? { raw: evidence.raw } : {}) };
}
