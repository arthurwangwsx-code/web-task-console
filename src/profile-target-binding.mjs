// Pure route validation only; no bridge API integration or send authorization.
// Inputs MUST come directly from trusted bridge code, not user/page JSON.
// The source discriminator is NOT authentication. profileId is an opaque
// extension-local UUID, NOT a Chrome directory or ChatGPT account identity.
// targetId is preserved verbatim: its encoding is deliberately not guessed.
const fail = code => { throw new Error(code); };
const opaque = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
export function selectProfile(profiles, { explicitProfileId } = {}) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.some(p => !opaque(p?.profileId))) fail('ROUTE_PROFILES_INVALID');
  const ids = profiles.map(p => p.profileId);
  if (new Set(ids).size !== ids.length) fail('ROUTE_PROFILE_DUPLICATE');
  if (explicitProfileId !== undefined) {
    const selected = profiles.find(p => p.profileId === explicitProfileId);
    if (!selected) fail('ROUTE_PROFILE_NOT_FOUND');
    return { profileId: selected.profileId };
  }
  if (profiles.length !== 1) fail('ROUTE_PROFILE_SELECTION_REQUIRED');
  return { profileId: profiles[0].profileId };
}
export function bindBrowserRoute(input, nowMs) {
  if (input?.source !== 'trusted-browser-bridge') fail('ROUTE_TRUSTED_BRIDGE_REQUIRED');
  if (!time(nowMs)) fail('ROUTE_TIME_INVALID');
  if (!opaque(input.profileId) || !opaque(input.targetId) || !Number.isSafeInteger(input.tabId) || input.tabId < 0 || !opaque(input.connectionGeneration)) fail('ROUTE_IDENTITY_INVALID');
  const lease = input.lease;
  if (!lease || !opaque(lease.id) || lease.resource !== 'browser_page' || lease.profileId !== input.profileId || lease.targetId !== input.targetId || !time(lease.expiresAt) || lease.expiresAt <= nowMs) fail('ROUTE_LEASE_INVALID_OR_EXPIRED');
  return { source: 'trusted-browser-bridge', profileId: input.profileId, targetId: input.targetId, tabId: input.tabId, connectionGeneration: input.connectionGeneration,
    lease: { id: lease.id, resource: 'browser_page', profileId: lease.profileId, targetId: lease.targetId, expiresAt: lease.expiresAt }, readOnly: true, authorizeSend: false };
}
const targetKeys = ['profileId', 'targetId', 'tabId'];
export function verifyBrowserRoute(route, current, nowMs) {
  const original = bindBrowserRoute(route, nowMs), fresh = bindBrowserRoute(current, nowMs);
  if (route.readOnly !== true || route.authorizeSend !== false) fail('ROUTE_NOT_READ_ONLY');
  if ([...targetKeys, 'connectionGeneration'].some(key => original[key] !== fresh[key])) fail('ROUTE_CHANGED');
  if (original.lease.id !== fresh.lease.id || original.lease.expiresAt !== fresh.lease.expiresAt) fail('ROUTE_LEASE_CHANGED');
  return true;
}
export function restoreObservationRoute(route, fresh, nowMs, { confirmed } = {}) {
  if (confirmed !== true) fail('ROUTE_EXPLICIT_RESTORE_REQUIRED');
  // Expired old lease is permitted for restore only. Validate its structure at
  // its last valid instant; no expired route becomes usable for dispatch.
  if (!time(route?.lease?.expiresAt) || route.lease.expiresAt === 0) fail('ROUTE_LEASE_INVALID_OR_EXPIRED');
  const original = bindBrowserRoute(route, route.lease.expiresAt - 1);
  if (route.readOnly !== true || route.authorizeSend !== false) fail('ROUTE_NOT_READ_ONLY');
  const replacement = bindBrowserRoute(fresh, nowMs);
  if (targetKeys.some(key => original[key] !== replacement[key])) fail('ROUTE_TARGET_REUSE_OR_CHANGE');
  return replacement;
}
// Route fields cannot prove native conversation/account/message identity.
// In particular, an RPC request ID MUST NOT be treated as a native message ID.
// A reused target with unchanged decoded profile/tab is not detectable here;
// the bridge MUST expose a changed connectionGeneration or invalidate its lease.
