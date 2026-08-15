// dsh-opencode-go-quota — Client half (web bundle).
// Registered via window.__ModuleLoader__.load; the factory materializes the
// cordis plugin object { apply, inject }. The quota ring polls the host
// /ocg-quota/usage route (same-origin fetch) and renders at the right end of
// the composer tool row, left of the model selector.
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const TAG_ID = 'dsh-opencode-go-quota/ring.css'
    const CSS = [
      '.dsh-ocg-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; cursor: pointer; border-radius: 50%; }',
      '.dsh-ocg-wrap:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.dsh-ocg-ring { width: 22px; height: 22px; }',
      '.dsh-ocg-letter { position: absolute; font-size: 9px; font-weight: 600; color: var(--dsw-alias-label-secondary); pointer-events: none; }',
      '.dsh-ocg-tip { position: absolute; bottom: calc(100% + 6px); right: 0; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 8px; font-size: 11px; line-height: 1.5; white-space: nowrap; z-index: 50; box-shadow: 0 2px 8px rgba(0,0,0,.25); pointer-events: none; }',
      '.dsh-ocg-tip-warn { color: var(--dsw-alias-state-error-primary); font-weight: 600; }',
      '@keyframes dsh-ocg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }',
      '.dsh-ocg-wrap.critical .dsh-ocg-ring { animation: dsh-ocg-pulse 1.6s ease-in-out infinite; }',
    ].join('\n')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-opencode-go-quota'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function countdown(iso) {
      const ms = new Date(iso).getTime() - Date.now()
      if (!(ms > 0)) return '即将重置'
      const m = Math.floor(ms / 60000)
      if (m < 60) return m + ' 分钟'
      const h = Math.floor(m / 60)
      if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分'
      const d = Math.floor(h / 24)
      return d + ' 天 ' + (h % 24) + ' 小时'
    }

    function ringColor(percent) {
      if (percent == null) return 'var(--dsw-alias-border-l1)'
      if (percent < 30) return 'var(--dsw-alias-state-success-primary)'
      if (percent < 60) return 'var(--dsw-static-blue-450)'
      if (percent < 80) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-error-primary)'
    }

    function loadUsage(force) {
      return fetch('/ocg-quota/usage', force
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: true }) }
        : undefined)
        .then((r) => r.json())
    }

    function QuotaRing() {
      const [state, setState] = React.useState({ data: null, error: null, idx: 0, hover: false })

      React.useEffect(() => {
        let alive = true
        const load = () => {
          loadUsage(false).then((r) => {
            if (!alive) return
            if (r && r.ok === true) setState((s) => ({ data: r, error: null, idx: s.idx, hover: s.hover }))
            else {
              console.debug('[dsh-opencode-go-quota] usage error:', (r && r.error) || 'unknown error')
              setState((s) => ({ data: s.data, error: (r && r.error) || 'unknown error', idx: s.idx, hover: s.hover }))
            }
          }).catch((e) => {
            if (!alive) return
            console.debug('[dsh-opencode-go-quota] usage load failed:', e)
            setState((s) => ({ data: s.data, error: String((e && e.message) || e), idx: s.idx, hover: s.hover }))
          })
        }
        load()
        const timer = setInterval(load, 5 * 60 * 1000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const windows = (state.data && state.data.windows) || []
      const current = windows[state.idx % 3] || null
      const percent = current ? current.percent : null
      const color = ringColor(percent)
      const letter = current ? current.letter : (state.error ? '!' : '\u2013')
      // Per-window alert thresholds from the host (cordis.yml configurable):
      // 5h alerts at criticalAt (80) — the only window that also injects the
      // prompt warning; weekly at 90%; monthly at 95%. The alert line follows
      // the CURRENT window, so cycling 5/W/M re-evaluates threshold and text.
      const thresholds = (state.data && state.data.thresholds)
        || { warnAt: 60, criticalAt: 80, weeklyWarnAt: 90, monthlyWarnAt: 95 }
      const alertAt = current && current.key === 'weekly' ? thresholds.weeklyWarnAt
        : current && current.key === 'monthly' ? thresholds.monthlyWarnAt
          : thresholds.criticalAt
      const alerted = current && percent != null && percent >= alertAt
      const alertLabel = current && current.key === 'weekly' ? '周'
        : current && current.key === 'monthly' ? '月' : '5小时'

      const onCycle = () => {
        const next = (state.idx + 1) % 3
        setState((s) => ({ data: s.data, error: s.error, idx: next, hover: s.hover }))
        const data = state.data
        if (!data || Date.now() - (data.fetchedAt || 0) > 60 * 1000) {
          loadUsage(true).then((r) => {
            if (r && r.ok === true) setState((s) => ({ data: r, error: null, idx: s.idx, hover: s.hover }))
            else {
              console.debug('[dsh-opencode-go-quota] usage refresh error:', (r && r.error) || 'unknown error')
              setState((s) => ({ data: s.data, error: (r && r.error) || 'unknown error', idx: s.idx, hover: s.hover }))
            }
          }).catch((e) => {
            console.debug('[dsh-opencode-go-quota] usage refresh failed:', e)
            setState((s) => ({ data: s.data, error: String((e && e.message) || e), idx: s.idx, hover: s.hover }))
          })
        }
      }

      const C = 2 * Math.PI * 9
      const dash = percent == null ? 0 : (C * percent) / 100

      const tipLines = []
      if (state.error) tipLines.push(state.error)
      if (alerted) tipLines.push({ warn: true, text: '\u26a0 ' + alertLabel + '额度即将用尽（' + Math.round(percent) + '%），建议暂停等重置' })
      if (current) {
        tipLines.push((current.label || '') + ' 已用 ' + (percent == null ? '\u2013' : Math.round(percent) + '%'))
        if (current.resetsAt) tipLines.push(countdown(current.resetsAt) + ' 后重置')
      }
      if (!state.error && !current) tipLines.push('加载中\u2026')

      return React.createElement('div', {
        className: 'dsh-ocg-wrap' + (alerted ? ' critical' : ''),
        onClick: onCycle,
        onMouseEnter: () => setState((s) => ({ data: s.data, error: s.error, idx: s.idx, hover: true })),
        onMouseLeave: () => setState((s) => ({ data: s.data, error: s.error, idx: s.idx, hover: false })),
        title: tipLines.map((l) => (typeof l === 'string' ? l : l.text)).join(' \u00b7 '),
      },
        React.createElement('svg', { className: 'dsh-ocg-ring', width: 22, height: 22, viewBox: '0 0 22 22' },
          React.createElement('circle', { cx: 11, cy: 11, r: 9, fill: 'none', stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 3 }),
          React.createElement('circle', { cx: 11, cy: 11, r: 9, fill: 'none', stroke: color, strokeWidth: 3, strokeLinecap: 'round', strokeDasharray: C + ' ' + C, strokeDashoffset: C - dash, transform: 'rotate(-90 11 11)' }),
        ),
        React.createElement('span', { className: 'dsh-ocg-letter' }, letter),
        state.hover && tipLines.length > 0
          ? React.createElement('div', { className: 'dsh-ocg-tip' }, tipLines.map((l, i) => {
            const text = typeof l === 'string' ? l : l.text
            const cls = typeof l === 'string' ? null : (l.warn ? ' dsh-ocg-tip-warn' : null)
            return React.createElement('div', { key: i, className: cls }, text)
          }))
          : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
        { name: 'conversation.input.right', id: 'ocg-quota-ring', order: 100, label: 'OpenCode Go 额度' },
        () => React.createElement(QuotaRing),
      )), 'dsh-opencode-go-quota: quota ring')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
