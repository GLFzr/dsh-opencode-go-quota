// dsh-opencode-go-quota — Host half (persistent profile plugin).
// Runs in the DSH host process: GET/POST /ocg-quota/usage resolves the
// OpenCode Go API key from ~/.local/share/opencode/auth.json (the same key
// the model provider uses), calls the official usage endpoint
// https://opencode.ai/zen/go/v1/usage through a `node -` child (Node's own
// fetch/TLS, script on stdin so no shell quoting is involved), and returns
// the 5-hour / weekly / monthly windows with percent and reset time.
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

const MIN_INTERVAL = 60 * 1000

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
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx) {
  const shell = ctx.shell
  let cache = null
  let cacheAt = 0

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
    }
  }

  async function getUsage(force) {
    if (!force && cache && Date.now() - cacheAt < MIN_INTERVAL) return cache
    const fresh = await fetchUsage()
    const payload = Object.assign({ fetchedAt: Date.now() }, fresh)
    cache = payload
    cacheAt = Date.now()
    return payload
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

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:ocg-quota',
    order: 210,
    text: '本机已安装 dsh-opencode-go-quota 插件（OpenCode Go 额度圆环）：聊天输入框模型选择器左侧有一个进度圆环，显示 OpenCode Go 订阅的 5 小时/每周/每月用量（中央字母 5/W/M，点击切换，悬停显示百分比与重置倒计时；绿<30% 蓝30-60% 橙60-80% 红≥80%）。数据来自官方 GET https://opencode.ai/zen/go/v1/usage，key 读取自 ~/.local/share/opencode/auth.json 的 opencode-go 条目。',
  }), 'dsh-opencode-go-quota: prompt section')
}
