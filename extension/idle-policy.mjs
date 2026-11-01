/** Pure local advisory policy. No timers, browser calls, owner writes or send paths. */
export const IDLE_THRESHOLD_MS = 30 * 60 * 1000;
export const IDLE_COOLDOWN_MS = 30 * 60 * 1000;
const attemptedStates = new Set(['sending', 'sent', 'unknown']);
const dueStatuses = new Set(['blocked-unknown', 'blocked-running', 'blocked-needs-authoritative-status']);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function gate(intent) {
  if (['unknown', 'sending'].includes(intent.state) || intent.provider?.state === 'unknown' || intent.router?.state === 'unknown') {
    return { status: 'blocked-unknown', reasons: ['UNKNOWN_OR_UNACKNOWLEDGED_OUTCOME', 'AUTHORITATIVE_OWNER_STATUS_REQUIRED'] };
  }
  if (['running', 'queued'].includes(intent.provider?.state) || ['running', 'queued'].includes(intent.router?.state)) {
    return { status: 'blocked-running', reasons: ['ONGOING_TOOL_OR_PROVIDER_OBSERVED', 'AUTHORITATIVE_OWNER_STATUS_REQUIRED'] };
  }
  // A caller-supplied verified flag or JSON receipt never grants authority.
  // This version has no authenticated owner status adapter, so no eligible path.
  return { status: 'blocked-needs-authoritative-status', reasons: ['NO_AUTHENTICATED_OWNER_STATUS_ADAPTER'] };
}

/**
 * lastObservedProgressAt is only a local evidence-change anchor, NOT proof of
 * effective business progress. Poll timestamps intentionally do not reset it.
 * Repeated due checks reuse one stable proposal per anchor; a changed anchor
 * cannot create a new proposal until the prior proposal's cooldown has elapsed.
 */
export function evaluateIdle(intent, nowMs, previousProposal = null) {
  if (!intent || typeof intent.id !== 'string' || !intent.id || intent.id.length > 160) throw new Error('INVALID_IDLE_INTENT');
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8.64e15) throw new Error('INVALID_IDLE_CLOCK');
  const anchorMs = timestamp(intent.lastObservedProgressAt ?? intent.attemptedAt);
  const anchorAt = anchorMs === null ? null : new Date(anchorMs).toISOString();
  const suggestionId = 'idle:' + encodeURIComponent(intent.id) + ':' + (anchorAt ?? 'no-anchor');
  const base = {
    suggestionId, intentId: intent.id, createdAt: new Date(nowMs).toISOString(),
    anchorAt, idleMs: anchorMs === null ? null : Math.max(0, nowMs - anchorMs),
    thresholdMs: IDLE_THRESHOLD_MS, cooldownMs: IDLE_COOLDOWN_MS,
    eligible: false, autoSendAllowed: false, requiresUserConfirmation: true,
    status: 'not-due', reasons: [], nextSteps: [], draft: null,
    evidenceClass: 'local-idle-observation-not-business-proof',
  };
  if (!attemptedStates.has(intent.state)) return { ...base, reasons: ['NO_ATTEMPTED_REMOTE_TASK'] };
  if (anchorMs === null) return { ...base, reasons: ['MISSING_OR_INVALID_PROGRESS_ANCHOR'] };
  if (anchorMs > nowMs) return { ...base, reasons: ['CLOCK_OR_ANCHOR_IN_FUTURE'] };
  if (nowMs - anchorMs < IDLE_THRESHOLD_MS) return { ...base, reasons: ['IDLE_THRESHOLD_NOT_REACHED'] };
  const previousCreatedMs = previousProposal?.intentId === intent.id && dueStatuses.has(previousProposal.status)
    ? timestamp(previousProposal.createdAt) : null;
  if (previousCreatedMs !== null && previousCreatedMs > nowMs) return { ...base, reasons: ['PRIOR_PROPOSAL_CLOCK_IN_FUTURE'] };
  const sameAnchor = previousCreatedMs !== null && previousProposal.anchorAt === anchorAt;
  if (!sameAnchor && previousCreatedMs !== null && nowMs - previousCreatedMs < IDLE_COOLDOWN_MS) {
    return { ...base, reasons: ['PROPOSAL_COOLDOWN_ACTIVE'], cooldownUntil: new Date(previousCreatedMs + IDLE_COOLDOWN_MS).toISOString() };
  }
  const createdMs = sameAnchor ? previousCreatedMs : nowMs;
  const nextSteps = [
    '在原聊天和原生 owner 中只读核对原 invocationId / taskId / runId / sessionId，不新建或重发任务。',
    '确认没有进行中的工具或 producer、没有发送/执行结果 unknown；没有结果也不等于没有执行。',
    '取得可关联的权威状态后，由用户审阅原目标、具体下一步与完整续推文案，再单独授权；本模块不发送。',
  ];
  const goal = typeof intent.prompt === 'string' ? intent.prompt.slice(0, 16000) : '原目标尚未记录，须先人工核对。';
  return {
    ...base, ...gate(intent), createdAt: new Date(createdMs).toISOString(),
    idleMs: Math.max(0, createdMs - anchorMs),
    cooldownUntil: new Date(createdMs + IDLE_COOLDOWN_MS).toISOString(),
    nextSteps,
    draft: '待核验续推草稿（不得直接发送）\n\n原目标：\n' + goal + '\n\n下一步：\n' + nextSteps.join('\n') + '\n\n保留原任务与原幂等键，不把沉默当成失败；若仍在运行或结果未知，只记录观察，不续推、不重发。',
  };
}
