// dsh-opencode-go-quota — host-half tests: route registration, usage
// normalization, cache TTL, force refresh, error mapping, and the
// prompt-section announcement state machine (incl. the no-data memory
// retention and the headless self-refresh regressions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { apply, parseOpenCodeGoAuth } from '../lib/index.js'

const OK_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 42, resetsAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
    weekly: { status: 'ok', percent: 10, resetsAt: null },
    monthly: { status: 'ok', percent: 5, resetsAt: null },
  },
}

function childOut(body) {
  return JSON.stringify({ ok: true, status: 200, body })
}

/** Fake cordis ctx: captures the route, the prompt section, and the effects. */
function makeCtx(runImpl) {
  const routes = []
  const sections = []
  const ctx = {
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
    shell: {
      resolve(spec) { return spec },
      async run(spec) { return runImpl(spec) },
    },
    systemPrompt: {
      section(section) { sections.push(section); return () => {} },
    },
    effect(fn) { return fn() },
  }
  return { ctx, routes, sections }
}

/** One real HTTP request against a captured route handler. */
function request(handler, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const req = http.request({ hostname: '127.0.0.1', port, path, method }, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          server.close()
          let parsed = null
          try { parsed = JSON.parse(data) } catch {}
          resolve({ status: res.statusCode, body: parsed })
        })
      })
      req.on('error', (e) => { server.close(); reject(e) })
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })
  })
}

/** Stateful harness: mutate the simulated quota, fail the child, fetch. */
function harness() {
  let percent = 42
  let failing = false
  const runImpl = async () => {
    if (failing) return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'boom' } }
    const body = {
      usage: {
        rolling: { status: 'ok', percent, resetsAt: new Date(Date.now() + 3600e3).toISOString() },
        weekly: { status: 'ok', percent: 10, resetsAt: null },
        monthly: { status: 'ok', percent: 5, resetsAt: null },
      },
    }
    return { exitCode: 0, stdout: { text: childOut(body) }, stderr: { text: '' } }
  }
  const { ctx, routes, sections } = makeCtx(runImpl)
  apply(ctx, {})
  return {
    handler: routes[0].handler,
    sections,
    setPercent(p) { percent = p },
    setFailing(f) { failing = f },
    fetch(force) { return request(this.handler, force ? 'POST' : 'GET', '/ocg-quota/usage', force ? { refresh: true } : undefined) },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('registers the /ocg-quota prefix route and one prompt section', () => {
  const h = harness()
  assert.ok(h.handler)
  assert.equal(h.sections.length, 1)
})

test('GET /ocg-quota/usage returns normalized windows and default thresholds', async () => {
  const h = harness()
  const r = await h.fetch(false)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.windows[0].key, 'rolling')
  assert.equal(r.body.windows[0].percent, 42)
  assert.equal(r.body.windows[1].key, 'weekly')
  assert.equal(r.body.windows[2].key, 'monthly')
  assert.deepEqual(r.body.thresholds, { warnAt: 60, criticalAt: 80, escalateFrom: 90, escalateStep: 2, weeklyWarnAt: 90, monthlyWarnAt: 95 })
})

test('usage is cached within cacheTtl; POST refresh bypasses the cache', async () => {
  let calls = 0
  const runImpl = async () => { calls++; return { exitCode: 0, stdout: { text: childOut(OK_BODY) }, stderr: { text: '' } } }
  const { ctx, routes } = makeCtx(runImpl)
  apply(ctx, {})
  const handler = routes[0].handler
  await request(handler, 'GET', '/ocg-quota/usage')
  await request(handler, 'GET', '/ocg-quota/usage')
  assert.equal(calls, 1)
  await request(handler, 'POST', '/ocg-quota/usage', { refresh: true })
  assert.equal(calls, 2)
})

test('cacheTtl config controls the cache window', async () => {
  let calls = 0
  const runImpl = async () => { calls++; return { exitCode: 0, stdout: { text: childOut(OK_BODY) }, stderr: { text: '' } } }
  const { ctx, routes } = makeCtx(runImpl)
  apply(ctx, { cacheTtl: 0.2 })
  const handler = routes[0].handler
  await request(handler, 'GET', '/ocg-quota/usage')
  await request(handler, 'GET', '/ocg-quota/usage')
  assert.equal(calls, 1)
  await sleep(300)
  await request(handler, 'GET', '/ocg-quota/usage')
  assert.equal(calls, 2)
})

test('error mapping: 404 / 401 / 403 / other status / child non-zero exit', async () => {
  const cases = [
    [{ ok: true, status: 404, body: null }, /not deployed/],
    [{ ok: true, status: 401, body: null }, /key rejected/],
    [{ ok: true, status: 403, body: null }, /key rejected/],
    [{ ok: true, status: 500, body: null }, /HTTP 500/],
  ]
  for (const [payload, re] of cases) {
    const { ctx, routes } = makeCtx(async () => ({ exitCode: 0, stdout: { text: JSON.stringify(payload) }, stderr: { text: '' } }))
    apply(ctx, {})
    const r = await request(routes[0].handler, 'GET', '/ocg-quota/usage')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, false)
    assert.match(r.body.error, re)
  }
  const { ctx, routes } = makeCtx(async () => ({ exitCode: 7, stdout: { text: '' }, stderr: { text: 'kaboom' } }))
  apply(ctx, {})
  const r = await request(routes[0].handler, 'GET', '/ocg-quota/usage')
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /node exited 7/)
})

test('non-GET/POST methods get 405; oversized POST bodies get 400', async () => {
  const h = harness()
  const put = await request(h.handler, 'PUT', '/ocg-quota/usage')
  assert.equal(put.status, 405)
  const big = await request(h.handler, 'POST', '/ocg-quota/usage', { refresh: true, padding: 'x'.repeat(10000) })
  assert.equal(big.status, 400)
})

test('prompt section: silent below warnAt, announces each new tier exactly once', async () => {
  const h = harness()
  await h.fetch(false) // seed cache at 42%
  const section = h.sections[0]
  assert.equal(section.text(), '') // 42% < warnAt 60 → nothing
  h.setPercent(65)
  await h.fetch(true)
  assert.match(section.text(), /注意：5小时额度已用 65%/)
  assert.equal(section.text(), '') // same tier again → silent
  h.setPercent(85)
  await h.fetch(true)
  assert.match(section.text(), /告急：5小时额度已用 85%/)
  assert.equal(section.text(), '')
  h.setPercent(95)
  await h.fetch(true)
  assert.match(section.text(), /即将耗尽：5小时额度已用 95%/)
})

test('regression: transient fetch failure keeps the announcement memory', async () => {
  const h = harness()
  await h.fetch(false)
  h.setPercent(95)
  await h.fetch(true)
  const section = h.sections[0]
  assert.match(section.text(), /即将耗尽/) // tier 5 announced
  h.setFailing(true) // endpoint dies
  await h.fetch(true)
  assert.equal(section.text(), '') // no data → silent…
  assert.equal(section.text(), '') // …and memory is NOT reset
  h.setFailing(false) // endpoint recovers at the same tier
  await h.fetch(true)
  assert.equal(section.text(), '') // no duplicate announcement
})

test('window reset clears memory; the next climb re-announces', async () => {
  const h = harness()
  await h.fetch(false)
  h.setPercent(95)
  await h.fetch(true)
  const section = h.sections[0]
  assert.match(section.text(), /即将耗尽/)
  h.setPercent(20) // rolling window reset
  await h.fetch(true)
  assert.equal(section.text(), '') // silent + memory cleared
  h.setPercent(65)
  await h.fetch(true)
  assert.match(section.text(), /注意/) // re-announced after the reset
})

test('regression: prompt section self-refreshes without the browser poll', async () => {
  const h = harness()
  h.setPercent(65)
  const section = h.sections[0]
  assert.equal(section.text(), '') // cache null → silent now…
  // …but a background refresh was kicked off; poll until it lands.
  let text = ''
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    text = section.text()
    if (text) break
    await sleep(20)
  }
  assert.match(text, /注意：5小时额度已用 65%/)
})

test('custom thresholds flow into the route payload and the section', async () => {
  const { ctx, routes, sections } = makeCtx(async () => ({ exitCode: 0, stdout: { text: childOut(OK_BODY) }, stderr: { text: '' } }))
  apply(ctx, { warnAt: 70, criticalAt: 90, escalateFrom: 95, escalateStep: 3, weeklyWarnAt: 85, monthlyWarnAt: 92 })
  const r = await request(routes[0].handler, 'GET', '/ocg-quota/usage')
  assert.deepEqual(r.body.thresholds, { warnAt: 70, criticalAt: 90, escalateFrom: 95, escalateStep: 3, weeklyWarnAt: 85, monthlyWarnAt: 92 })
  assert.equal(sections[0].text(), '') // 42% below warnAt 70 → silent
})

test('parseOpenCodeGoAuth: BOM tolerance, failure distinction, empty-key rejection', () => {
  assert.equal(parseOpenCodeGoAuth('{"opencode-go":{"key":"abc"}}'), 'abc')
  // A UTF-8 BOM used to make JSON.parse throw, misreported as "key not found"
  assert.equal(parseOpenCodeGoAuth('﻿{"opencode-go":{"key":"abc"}}'), 'abc')
  assert.equal(parseOpenCodeGoAuth('{oops'), null) // unparseable
  assert.equal(parseOpenCodeGoAuth('{"opencode-go":{}}'), null) // no key
  assert.equal(parseOpenCodeGoAuth('{"opencode-go":{"key":""}}'), null) // empty key
  assert.equal(parseOpenCodeGoAuth('{"other-provider":{"key":"x"}}'), null) // wrong entry
  assert.equal(parseOpenCodeGoAuth(''), null)
})

test('sandbox-unavailable failures map to an actionable hint (shell.run throws)', async () => {
  const msg = 'sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. ... Runner failure: windows-acl-run: Windows ACL temp root must be outside the workspace: workspace=C:\\Users\\x; temp=C:\\Users\\X~1\\AppData\\Local\\Temp'
  const { ctx, routes } = makeCtx(async () => { throw new Error(msg) })
  apply(ctx, {})
  const r = await request(routes[0].handler, 'GET', '/ocg-quota/usage')
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /宿主沙箱不可用/)
  assert.match(r.body.error, /workspaceRoot/)
  assert.ok(!r.body.error.includes('windows-acl-run')) // raw internals hidden
})

test('sandbox-unavailable failures map to an actionable hint (runner stderr)', async () => {
  const { ctx, routes } = makeCtx(async () => ({ exitCode: 127, stdout: { text: '' }, stderr: { text: 'windows-acl-run: Windows ACL temp root must be outside the workspace: workspace=C:\\x; temp=C:\\Temp' } }))
  apply(ctx, {})
  const r = await request(routes[0].handler, 'GET', '/ocg-quota/usage')
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /宿主沙箱不可用/)
})

test('error payloads expire after config.errorCacheTtl instead of cacheTtl', async () => {
  let failing = true
  let calls = 0
  const runImpl = async () => {
    calls++
    if (failing) return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'boom' } }
    return { exitCode: 0, stdout: { text: childOut(OK_BODY) }, stderr: { text: '' } }
  }
  const { ctx, routes } = makeCtx(runImpl)
  apply(ctx, { errorCacheTtl: 0.2 })
  const handler = routes[0].handler
  const r1 = await request(handler, 'GET', '/ocg-quota/usage')
  assert.equal(r1.body.ok, false)
  await request(handler, 'GET', '/ocg-quota/usage') // cached error → still 1 call
  assert.equal(calls, 1)
  await sleep(300) // error TTL (0.2s) expires
  failing = false
  const r2 = await request(handler, 'GET', '/ocg-quota/usage')
  assert.equal(calls, 2)
  assert.equal(r2.body.ok, true)
})
