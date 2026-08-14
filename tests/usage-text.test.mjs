// dsh-opencode-go-quota — usage-text unit checks (node --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUsageSection, countdownText, usageTier, percentOf, announceTier,
} from '../lib/usage-text.js'

const NOW = new Date('2026-08-15T00:00:00Z').getTime()
const CFG = { warnAt: 60, criticalAt: 80, escalateFrom: 90, escalateStep: 2 }

const payload = (rolling, weekly = 30, monthly = 18) => ({
  ok: true,
  windows: [
    { key: 'rolling', letter: '5', label: '5小时', percent: rolling, resetsAt: new Date(NOW + 133 * 60000).toISOString() },
    { key: 'weekly', letter: 'W', label: '周', percent: weekly, resetsAt: null },
    { key: 'monthly', letter: 'M', label: '月', percent: monthly, resetsAt: null },
  ],
})

test('countdownText renders minutes/hours/days', () => {
  assert.equal(countdownText(new Date(NOW + 42 * 60000).toISOString(), NOW), '42 分钟')
  assert.equal(countdownText(new Date(NOW + 133 * 60000).toISOString(), NOW), '2 小时 13 分')
  assert.equal(countdownText(new Date(NOW + 26 * 3600000).toISOString(), NOW), '1 天 2 小时')
  assert.equal(countdownText(new Date(NOW - 1000).toISOString(), NOW), '即将重置')
})

test('usageTier boundaries: 59→0, 60→1, 79→1, 80→2, 89→2, 90→3, 92→4, 99→7, 100→8', () => {
  const cases = [[59, 0], [60, 1], [79, 1], [80, 2], [89, 2], [90, 3], [91, 3], [92, 4], [94, 5], [96, 6], [98, 7], [100, 8]]
  for (const [pct, want] of cases) assert.equal(usageTier(pct, CFG), want, 'pct=' + pct)
  assert.equal(usageTier(null, CFG), 0)
})

test('below warnAt: nothing is injected (zero prompt cost)', () => {
  assert.equal(buildUsageSection(payload(42), usageTier(42, CFG), CFG, NOW), '')
  assert.equal(buildUsageSection(payload(59), usageTier(59, CFG), CFG, NOW), '')
})

test('warn tier (60-79): status line + warn instruction, announced once', () => {
  const tier = usageTier(65, CFG)
  assert.equal(tier, 1)
  const text = buildUsageSection(payload(65), tier, CFG, NOW)
  assert.ok(text.startsWith('OpenCode Go 额度：5小时已用 65%'))
  assert.ok(text.includes('周 30%'))
  assert.ok(text.includes('月 18%'))
  assert.ok(text.includes('注意：5小时额度已用 65%'))
  assert.ok(text.includes('建议暂停'))
  // one-announcement gate: same tier again → silent, higher tier → announce
  assert.equal(announceTier(tier, 1), 1)
  assert.equal(announceTier(1, 0), 1)
  assert.equal(announceTier(2, 1), 2)
  assert.equal(announceTier(0, 3), 0) // window reset clears the memory
})

test('critical tier (80-89): distinct, more urgent wording', () => {
  const text = buildUsageSection(payload(85), 2, CFG, NOW)
  assert.ok(text.includes('告急：5小时额度已用 85%'))
  assert.ok(text.includes('任务边界暂停'))
  assert.ok(!text.includes('注意：'))
})

test('escalation past 90%: one tier per 2%, urgency increases, no repeats within a tier', () => {
  const t90 = buildUsageSection(payload(90), 3, CFG, NOW)
  const t92 = buildUsageSection(payload(92), 4, CFG, NOW)
  const t94 = buildUsageSection(payload(94), 5, CFG, NOW)
  assert.ok(t90.includes('严重：5小时额度已用 90%'))
  assert.ok(t92.includes('濒临耗尽：5小时额度已用 92%'))
  assert.ok(t94.includes('即将耗尽：5小时额度已用 94%'))
  assert.ok(t92.includes('立即暂停'))
  assert.ok(t94.includes('停止工作'))
  // every ladder tier has distinct, progressively stronger wording
  const markers = [
    '告急：', '严重：', '濒临耗尽：', '即将耗尽：', '几乎耗尽：', '近极限：', '已用尽：',
  ]
  const texts = [2, 3, 4, 5, 6, 7, 8].map((t) => buildUsageSection(payload(80 + t * 2), t, CFG, NOW))
  for (let i = 0; i < markers.length; i++) {
    assert.ok(texts[i].includes(markers[i]), 'tier ' + (i + 2) + ' should carry its marker')
  }
})

test('exhausted tier (>=100)', () => {
  const text = buildUsageSection(payload(100), 8, CFG, NOW)
  assert.ok(text.includes('已用尽：5小时额度已用 100%'))
  assert.ok(text.includes('等待重置'))
})

test('announceTier: same or lower non-zero tier stays silent, higher tier announces', () => {
  assert.equal(announceTier(3, 3), 3) // silent (no change)
  assert.equal(announceTier(1, 3), 3) // drop inside tiers → silent
  assert.equal(announceTier(5, 3), 5) // escalation → announce
  assert.equal(announceTier(0, 5), 0) // reset
})

test('no data / failure / unknown percent -> empty and tier 0', () => {
  assert.equal(percentOf(null), null)
  assert.equal(percentOf({ ok: false, error: 'boom' }), null)
  assert.equal(percentOf(payload(null)), null)
  assert.equal(usageTier(percentOf(null), CFG), 0)
  assert.equal(buildUsageSection(null, 1, CFG, NOW), '')
})

test('custom thresholds take effect', () => {
  const custom = { warnAt: 65, criticalAt: 90, escalateFrom: 95, escalateStep: 2 }
  assert.equal(usageTier(70, custom), 1)
  assert.equal(usageTier(88, custom), 1)
  assert.equal(usageTier(90, custom), 2)
  assert.equal(usageTier(95, custom), 3)
  assert.equal(usageTier(97, custom), 4)
})
