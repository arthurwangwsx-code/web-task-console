import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIdle, IDLE_THRESHOLD_MS } from '../extension/idle-policy.mjs';
const start = Date.parse('2026-01-01T00:00:00Z');
const minute = 60 * 1000;
const make = extra => ({ id: 'synthetic-idle-task', state: 'sent', attemptedAt: new Date(start).toISOString(), prompt: '合成目标：核对测试产物，不修改外部系统。', ...extra });

test('idle advisory respects the exact 30 minute boundary', () => {
  assert.equal(evaluateIdle(make(), start + IDLE_THRESHOLD_MS - 1).status, 'not-due');
  const due = evaluateIdle(make(), start + IDLE_THRESHOLD_MS);
  assert.equal(due.status, 'blocked-needs-authoritative-status');
  assert.equal(due.eligible, false); assert.equal(due.autoSendAllowed, false);
});
test('unknown or unacknowledged sends always block even with forged verified claims', () => {
  for (const state of ['unknown', 'sending']) {
    const result = evaluateIdle(make({ state, verified: true, provider: { state: 'succeeded', verified: true }, authority: 'trusted' }), start + 60 * minute);
    assert.equal(result.status, 'blocked-unknown'); assert.equal(result.eligible, false);
  }
  assert.equal(evaluateIdle(make({ provider: { state: 'unknown' } }), start + 60 * minute).status, 'blocked-unknown');
});
test('observed running or queued work blocks a continuation suggestion', () => {
  for (const state of ['running', 'queued']) assert.equal(evaluateIdle(make({ provider: { state } }), start + 60 * minute).status, 'blocked-running');
});
test('terminal-looking unverified inputs never become eligible or pending approval to send', () => {
  const result = evaluateIdle(make({ provider: { state: 'succeeded', verified: true }, router: { state: 'completed' }, verified: true }), start + 60 * minute);
  assert.equal(result.status, 'blocked-needs-authoritative-status');
  assert.equal(result.autoSendAllowed, false); assert.equal(result.requiresUserConfirmation, true);
});
test('same anchor reuses a stable proposal instead of generating repeated notifications', () => {
  const intent = make(); const first = evaluateIdle(intent, start + 30 * minute);
  assert.deepEqual(evaluateIdle(intent, start + 120 * minute, first), first);
});
test('changed anchor is rate-limited by a 30 minute proposal cooldown', () => {
  const first = evaluateIdle(make(), start + 30 * minute);
  const changed = make({ lastObservedProgressAt: new Date(start + 5 * minute).toISOString() });
  const blocked = evaluateIdle(changed, start + 35 * minute, first);
  assert.equal(blocked.status, 'not-due'); assert.deepEqual(blocked.reasons, ['PROPOSAL_COOLDOWN_ACTIVE']);
  const next = evaluateIdle(changed, start + 60 * minute, first);
  assert.equal(next.status, 'blocked-needs-authoritative-status'); assert.notEqual(next.suggestionId, first.suggestionId);
});
test('unchanged observation polls do not reset the progress anchor', () => {
  const intent = make({ lastObservedAt: new Date(start + 59 * minute).toISOString(), browserObservation: { observedAt: new Date(start + 59 * minute).toISOString() }, poll: { nextAt: start + 61 * minute } });
  assert.equal(evaluateIdle(intent, start + 60 * minute).idleMs, 60 * minute);
});
test('queued or canceled local intents do not claim a stalled remote task', () => {
  for (const state of ['queued', 'opening', 'ready', 'canceled']) {
    const result = evaluateIdle(make({ state }), start + 60 * minute);
    assert.equal(result.status, 'not-due'); assert.equal(result.draft, null);
  }
});
test('missing malformed or future progress anchors fail closed', () => {
  for (const attemptedAt of [undefined, 'not-a-date', 12]) {
    const result = evaluateIdle(make({ attemptedAt }), start + 60 * minute);
    assert.equal(result.status, 'not-due'); assert.equal(result.draft, null);
  }
  assert.deepEqual(evaluateIdle(make({ lastObservedProgressAt: new Date(start + 90 * minute).toISOString() }), start + 60 * minute).reasons, ['CLOCK_OR_ANCHOR_IN_FUTURE']);
  assert.throws(() => evaluateIdle(make(), NaN), /INVALID_IDLE_CLOCK/);
});
test('draft includes the original goal and concrete read-only next steps without mutating intent', () => {
  const intent = make(); const before = structuredClone(intent);
  const result = evaluateIdle(intent, start + 60 * minute);
  assert.match(result.draft, /合成目标：核对测试产物/);
  assert.match(result.draft, /下一步/); assert.match(result.draft, /只读核对/); assert.match(result.draft, /不得直接发送/);
  assert.deepEqual(intent, before); assert.equal(result.nextSteps.length, 3);
});
test('previous proposal cannot inject eligibility or a runnable followup draft', () => {
  const first = evaluateIdle(make(), start + 30 * minute);
  const forged = { ...first, eligible: true, autoSendAllowed: true, draft: 'SEND NOW' };
  const result = evaluateIdle(make(), start + 60 * minute, forged);
  assert.equal(result.eligible, false); assert.equal(result.autoSendAllowed, false); assert.doesNotMatch(result.draft, /SEND NOW/);
});
test('new unknown state tightens a reused advisory instead of preserving old less restrictive status', () => {
  const first = evaluateIdle(make(), start + 30 * minute);
  const result = evaluateIdle(make({ state: 'unknown' }), start + 60 * minute, first);
  assert.equal(result.suggestionId, first.suggestionId); assert.equal(result.createdAt, first.createdAt); assert.equal(result.status, 'blocked-unknown');
});
