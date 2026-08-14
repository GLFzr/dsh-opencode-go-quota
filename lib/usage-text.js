// dsh-opencode-go-quota — usage-to-prompt text (pure, dependency-free).
// The host injects one dynamic systemPrompt section per agent request; this
// module renders its text. To keep prompt tokens low and prefix-cache hits
// high, NOTHING is injected below the warn tier — and above it the warning
// is announced ONCE per tier (the host tracks the announced tier across
// requests): 60% warn tier, 80% critical tier, then one escalation per 2%
// past 90% (90/92/94/... with increasing urgency, capped at the exhausted
// tier). The model perceives the quota and proactively warns the user,
// suggesting a pause point until the 5-hour window resets.

/** Human countdown for a reset time, e.g. "2 小时 13 分". */
export function countdownText(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now
  if (!(ms > 0)) return '即将重置'
  const m = Math.floor(ms / 60000)
  if (m < 60) return m + ' 分钟'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分'
  const d = Math.floor(h / 24)
  return d + ' 天 ' + (h % 24) + ' 小时'
}

/**
 * Warning tier for a 5-hour usage percent.
 * 0 = below warnAt → nothing is injected.
 * 1 = warn tier, 2 = critical tier, then one tier per `escalateStep`
 * percent past `escalateFrom` (90%, 92%, 94%, ...), capped at 8.
 */
export function usageTier(percent, cfg = {}) {
  if (percent == null) return 0
  if (percent < cfg.warnAt) return 0
  if (percent < cfg.criticalAt) return 1
  if (percent < cfg.escalateFrom) return 2
  const escalated = 3 + Math.floor((percent - cfg.escalateFrom) / cfg.escalateStep)
  return Math.min(escalated, 8)
}

/** The 5-hour percent of a usage payload (null when unknown). */
export function percentOf(payload) {
  if (!payload || payload.ok !== true) return null
  const windows = payload.windows || []
  const rolling = windows.find((w) => w.key === 'rolling') || windows[0]
  return rolling && rolling.percent != null ? rolling.percent : null
}

/**
 * One-announcement-per-tier gate. The host stores the last announced tier
 * between requests and calls this per agent request.
 * @param tier - current usage tier.
 * @param announced - last announced tier (host memory).
 * @returns the tier to announce now: the same value as `announced` means
 * "stay silent" (already announced); 0 resets the memory after the window
 * resets below the warn tier; a higher tier means "announce this one".
 */
export function announceTier(tier, announced) {
  if (tier === 0) return 0
  return tier > announced ? tier : announced
}

/** Escalating warning lines, indexed by tier (0 unused). */
const TIER_LINES = [
  '',
  // 1: 60-79% — advise a pause at a suitable point.
  '注意：5小时额度已用 {pct}%，{reset}。若当前任务较长且非紧急，可在合适的节点主动提醒用户额度即将用尽，建议暂停，待额度恢复后续跑。',
  // 2: 80-89% — urgent; warn in the reply and stop at a task boundary.
  '告急：5小时额度已用 {pct}%，{reset}。请在回复中主动提醒用户额度已接近用尽；若当前任务较长，建议在合适的任务边界暂停，等额度恢复后（或用户明确同意继续时）再继续，不要默默消耗额度。',
  // 3: 90-91% — severe; no new long tasks.
  '严重：5小时额度已用 {pct}%，{reset}。请优先提醒用户额度严重告急；除必要收尾外，不建议再发起新的长任务，等待重置。',
  // 4: 92-93% — nearly spent; finish the step then pause.
  '濒临耗尽：5小时额度已用 {pct}%，{reset}。强烈建议完成当前步骤后立即暂停，等待重置；向用户明确说明剩余额度极有限。',
  // 5: 94-95% — about to run out; stop beyond cleanup.
  '即将耗尽：5小时额度已用 {pct}%，{reset}。除必要收尾外停止工作；向用户报告额度即将耗尽，等待重置或用户指示。',
  // 6: 96-97% — almost gone; wrap up now.
  '几乎耗尽：5小时额度已用 {pct}%，{reset}。立即收尾当前步骤，停止一切新工作；明确提醒用户额度几乎耗尽，等待重置。',
  // 7: 98-99% — at the edge; nothing non-essential.
  '近极限：5小时额度已用 {pct}%，{reset}。停止一切非必要请求；提醒用户额度已近极限，随时可能无法继续。',
  // 8: >=100% — spent; wait for the reset.
  '已用尽：5小时额度已用 100%，{reset}。已无法继续消耗额度；告知用户等待重置，重置前任务暂停。',
]

/**
 * Render the dynamic prompt section for one announced tier (callers gate on
 * `announceTier` first). The text is the status line plus that tier's
 * warning instruction.
 * @param payload - the cached /ocg-quota/usage payload ({ ok, windows }).
 * @param tier - the tier to announce (1..8).
 * @param cfg - { warnAt, criticalAt, escalateFrom, escalateStep }.
 * @param now - clock for the reset countdown (tests inject a fake).
 * @returns the section text, or '' when there is nothing to render.
 */
export function buildUsageSection(payload, tier, cfg = { warnAt: 60, criticalAt: 80, escalateFrom: 90, escalateStep: 2 }, now = Date.now()) {
  if (!payload || payload.ok !== true) return ''
  const windows = payload.windows || []
  const rolling = windows.find((w) => w.key === 'rolling') || windows[0]
  if (!rolling || rolling.percent == null) return ''
  const pct = Math.round(rolling.percent)
  const reset = rolling.resetsAt ? countdownText(rolling.resetsAt, now) : '短期内不会重置'
  const line = TIER_LINES[tier]
  if (!line) return ''
  let text = 'OpenCode Go 额度：5小时已用 ' + pct + '%（约 ' + reset + ' 后重置）'
  const weekly = windows.find((w) => w.key === 'weekly')
  const monthly = windows.find((w) => w.key === 'monthly')
  const parts = []
  if (weekly && weekly.percent != null) parts.push('周 ' + Math.round(weekly.percent) + '%')
  if (monthly && monthly.percent != null) parts.push('月 ' + Math.round(monthly.percent) + '%')
  if (parts.length > 0) text += '，' + parts.join('，')
  text += '。\n' + line.replace('{pct}', pct).replace('{reset}', '约 ' + reset + ' 后重置')
  return text
}
