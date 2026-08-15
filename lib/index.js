// dsh-opencode-go-quota — Host half (persistent profile plugin).
// Runs in the DSH host process: GET/POST /ocg-quota/usage resolves the
// OpenCode Go API key from ~/.local/share/opencode/auth.json (the same key
// the model provider uses), calls the official usage endpoint
// https://opencode.ai/zen/go/v1/usage through a `node -` child (Node's own
// fetch/TLS, script on stdin so no shell quoting is involved), and returns
// the 5-hour / weekly / monthly windows with percent and reset time.
//
// The quota is ALSO surfaced to the agent as a dynamic systemPrompt section
// (Codex-CLI style): below the warn tier nothing is injected (zero prompt
// cost, stable prefix for cache hits); at/above it the warning is announced
// ONCE per tier — 60% warn, 80% critical, then one escalation per 2% past
// 90% — so the model proactively warns the user and suggests a pause point
// until the window resets, without repeating the same text every request.
import { buildUsageSection, percentOf, usageTier, announceTier } from './usage-text.js'

export const name = 'dsh-opencode-go-quota'
export const inject = ['webServer', 'shell', 'systemPrompt']

// Child script: read the key locally, then call the official usage endpoint.
const SCRIPT = [
  'const os = require("os");',
  'const fs = require("fs");',
  'const path = require("path");',
  '(async () => {',
  '  try {',
  '    const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");',
  '    let auth = null;',
  '    try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")); } catch (e) {}',
  '    const entry = auth ? auth["opencode-go"] : null;',
  '    const key = entry ? entry.key : null;',
  '    if (!key) { console.log(JSON.stringify({ ok: false, error: "opencode-go key not found in " + authPath })); return; }',
  '    if (typeof fetch !== "function") { console.log(JSON.stringify({ ok: false, error: "fetch unavailable in this node" })); return; }',
  '    const res = await fetch("https://opencode.ai/zen/go/v1/usage", {',
  '      headers: { Authorization: "Bearer " + key, Accept: "application/json" },',
  '      signal: AbortSignal.timeout(15000)',
  '    });',
  '    const text = await res.text();',
  '    let body = null;',
  '    try { body = JSON.parse(text); } catch (e) {}',
  '    console.log(JSON.stringify({ ok: true, status: res.status, body: body }));',
  '  } catch (e) {',
  '    console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));',
  '  }',
  '})();',
].join('\n')

/** Default usage cache TTL (ms); config.cacheTtl (seconds) overrides it. */
const DEFAULT_CACHE_TTL_MS = 60 * 1000

function num(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v) {
  return typeof v === 'string' ? v : null
}

function readBody(req, cap = 4096) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > cap) {
        // Drain the rest of the body instead of destroying the socket: a
        // destroy() would cut the connection before the 400 response below
        // could flush, so the caller would see ECONNRESET instead of 400.
        req.resume()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx, config = {}) {
  const shell = ctx.shell
  /** Tier thresholds (percent); cordis.yml config overrides. */
  const warnAt = Number(config.warnAt) > 0 ? Number(config.warnAt) : 60
  const criticalAt = Number(config.criticalAt) > 0 ? Number(config.criticalAt) : 80
  const escalateFrom = Number(config.escalateFrom) > 0 ? Number(config.escalateFrom) : 90
  const escalateStep = Number(config.escalateStep) > 0 ? Number(config.escalateStep) : 2
  /** Ring-alert thresholds for weekly/monthly (UI only — never injected into prompts). */
  const weeklyWarnAt = Number(config.weeklyWarnAt) > 0 ? Number(config.weeklyWarnAt) : 90
  const monthlyWarnAt = Number(config.monthlyWarnAt) > 0 ? Number(config.monthlyWarnAt) : 95
  /** Usage cache TTL in ms (config.cacheTtl in seconds, default 60). */
  const cacheTtlMs = Number(config.cacheTtl) > 0 ? Number(config.cacheTtl) * 1000 : DEFAULT_CACHE_TTL_MS
  const tierCfg = { warnAt, criticalAt, escalateFrom, escalateStep }
  if (!(warnAt < criticalAt && criticalAt < escalateFrom)) {
    // Nonsensical tiers silently flatten the ladder (e.g. warnAt>=criticalAt
    // never reaches the warn tier) — surface it instead of misbehaving.
    console.warn('[dsh-opencode-go-quota] inconsistent tier config (expected warnAt < criticalAt < escalateFrom): warnAt=' + warnAt + ', criticalAt=' + criticalAt + ', escalateFrom=' + escalateFrom)
  }
  /**
   * Last announced warning tier (one announcement per tier, reset when a
   * window reset drops usage below the warn tier). Global across sessions by
   * design: the quota is a shared resource, and the high-water mark also
   * suppresses re-announcement while usage oscillates inside a tier band.
   */
  let announcedTier = 0
  let cache = null
  let cacheAt = 0
  /** In-flight usage fetch, shared by the route handler and the prompt refresh. */
  let inflight = null

  async function fetchUsage() {
    let spec
    try {
      spec = shell.resolve({
        command: 'node -',
        stdin: SCRIPT,
        timeoutMs: 20000,
        stdoutMaxBytes: 20000,
      })
    } catch (e) {
      return { ok: false, error: 'shell.resolve failed: ' + String((e && e.message) || e) }
    }
    let result
    try {
      result = await shell.run(spec)
    } catch (e) {
      return { ok: false, error: 'shell.run failed: ' + String((e && e.message) || e) }
    }
    if (result.exitCode !== 0) {
      const errText = result.stderr ? result.stderr.text : ''
      return { ok: false, error: 'node exited ' + result.exitCode + ': ' + (errText || 'no stderr') }
    }
    const text = result.stdout ? result.stdout.text : ''
    let parsed = null
    try { parsed = JSON.parse(text.trim()) } catch (e) {}
    if (!parsed || parsed.ok !== true) {
      return { ok: false, error: (parsed && parsed.error) || 'unparseable child output' }
    }
    if (parsed.status === 404) {
      return { ok: false, error: 'usage endpoint not deployed yet (HTTP 404)' }
    }
    if (parsed.status === 401 || parsed.status === 403) {
      return { ok: false, error: 'OpenCode Go key rejected (HTTP ' + parsed.status + ')' }
    }
    if (parsed.status < 200 || parsed.status >= 300) {
      return { ok: false, error: 'HTTP ' + parsed.status }
    }
    const usage = parsed.body && parsed.body.usage
    if (!usage) {
      return { ok: false, error: 'unexpected response shape' }
    }
    return {
      ok: true,
      windows: [
        { key: 'rolling', letter: '5', label: '5小时', percent: num(usage.rolling && usage.rolling.percent), resetsAt: str(usage.rolling && usage.rolling.resetsAt) },
        { key: 'weekly', letter: 'W', label: '周', percent: num(usage.weekly && usage.weekly.percent), resetsAt: str(usage.weekly && usage.weekly.resetsAt) },
        { key: 'monthly', letter: 'M', label: '月', percent: num(usage.monthly && usage.monthly.percent), resetsAt: str(usage.monthly && usage.monthly.resetsAt) },
      ],
      thresholds: { warnAt, criticalAt, escalateFrom, escalateStep, weeklyWarnAt, monthlyWarnAt },
    }
  }

  async function getUsage(force) {
    if (!force && cache && Date.now() - cacheAt < cacheTtlMs) return cache
    if (inflight) return inflight
    inflight = (async () => {
      const fresh = await fetchUsage()
      if (fresh.ok !== true) {
        console.error('[dsh-opencode-go-quota] usage fetch failed:', fresh.error)
      }
      const payload = Object.assign({ fetchedAt: Date.now() }, fresh)
      cache = payload
      cacheAt = Date.now()
      return payload
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  /**
   * Background refresh when the cache is missing or older than the TTL.
   * Called from the prompt section provider, so quota awareness does not
   * depend on the browser poll reaching the route (headless/API sessions).
   * Concurrent callers share the in-flight fetch via {@link inflight}.
   */
  function refreshIfStale() {
    if (cache && Date.now() - cacheAt < cacheTtlMs) return
    void getUsage(false).catch(() => {})
  }

  const handler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    let url
    try { url = new URL(req.url ?? '/', 'http://x') } catch (e) { url = null }
    if (!url || url.pathname !== '/ocg-quota/usage') {
      res.writeHead(404)
      res.end()
      return
    }
    let force = false
    if (req.method === 'POST') {
      const raw = await readBody(req)
      if (raw === null) {
        res.writeHead(400)
        res.end()
        return
      }
      try { force = JSON.parse(raw).refresh === true } catch (e) { force = false }
    }
    let payload
    try {
      payload = await getUsage(force)
    } catch (e) {
      console.error('[dsh-opencode-go-quota] usage request failed:', e)
      payload = { ok: false, error: String((e && e.message) || e), fetchedAt: Date.now() }
    }
    const body = JSON.stringify(payload)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
    res.end(body)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/ocg-quota',
    handler,
  }), 'dsh-opencode-go-quota: /ocg-quota routes')

  // Dynamic prompt injection, gated by the one-announcement-per-tier policy:
  // below warnAt → empty (zero prompt cost, stable prefix for cache hits);
  // entering a new tier → render the status + that tier's warning ONCE;
  // same tier afterwards → empty again; window reset (tier 0) clears the
  // memory so the next climb re-announces.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:ocg-quota',
    order: 210,
    text: () => {
      // No usable data (never fetched, or the fetch failed): stay silent and
      // KEEP the announcement memory — a transient failure must not reset it
      // (otherwise the tier is re-announced after recovery). A background
      // refresh keeps the prompt feature independent of the browser poll.
      const pct = percentOf(cache)
      if (pct == null) {
        refreshIfStale()
        return ''
      }
      const tier = usageTier(pct, tierCfg)
      const next = announceTier(tier, announcedTier)
      if (next === announcedTier) return ''
      announcedTier = next
      return next === 0 ? '' : buildUsageSection(cache, next, tierCfg)
    },
  }), 'dsh-opencode-go-quota: dynamic usage section')
}
