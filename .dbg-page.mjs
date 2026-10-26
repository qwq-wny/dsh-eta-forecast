/**
 * 用原生 WebSocket 直接说 CDP，查 DSH 页面里挂件的注入状态。
 * （playwright 的 connectOverCDP 依赖宿主不支持的 Browser 域，绕开它。）
 */

const wsUrl = process.argv[2]
if (!wsUrl) { console.log('usage: node .dbg-page.mjs <ws://...>'); process.exit(1) }

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
    setTimeout(() => {
      if (pending.has(msgId)) { pending.delete(msgId); reject(new Error('timeout: ' + method)) }
    }, 8000)
  })
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
}

ws.onerror = () => { console.log('ws error'); process.exit(1) }

ws.onopen = async () => {
  try {
    // 先列出所有 target，找 UI 页面（URL 不是 dsh://host 的那个）
    const targets = await send('Target.getTargets')
    console.log('TARGETS:', JSON.stringify(targets.targetInfos.map((t) => ({
      type: t.type, url: String(t.url || '').slice(0, 80), attached: t.attached,
    })), null, 2))

    const uiTarget = targets.targetInfos.find((t) => t.type === 'page' && String(t.url || '').indexOf('dsh://host') === -1)
    if (!uiTarget) {
      console.log('NO UI PAGE TARGET（inspector 只能看到 host realm）')
      process.exit(0)
    }
    // attach 到 UI 页面再评估
    const { sessionId } = await send('Target.attachToTarget', { targetId: uiTarget.targetId, flatten: true })

    const evalIn = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, sessionId })
      return r.result.value
    }

    const info = await evalIn(`(() => {
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src || ('inline:' + (s.textContent||'').slice(0,60)))
      const eta = scripts.filter(s => s.indexOf('dsh-eta') !== -1)
      const root = document.getElementById('dsh-eta-root')
      return {
        url: location.href.slice(0, 90),
        scriptCount: scripts.length,
        etaScripts: eta,
        etaRootExists: !!root,
        etaDisplayOff: root ? root.getAttribute('data-display-off') : null,
        etaHidden: root ? getComputedStyle(root).display === 'none' : null,
      }
    })()`)
    console.log('UI PAGE:', JSON.stringify(info, null, 2))

    const state = await evalIn(`(async () => {
      try {
        const r = await fetch('/dsh-eta/state.json', { cache: 'no-store' })
        const j = await r.json()
        return { display: j.display, memory: j.memory, version: j.version, sessions: (j.sessions||[]).length }
      } catch (e) { return { err: String(e) } }
    })()`)
    console.log('STATE-FROM-UI:', JSON.stringify(state))
  } catch (e) {
    console.log('ERR:', e.message)
  } finally {
    ws.close()
    process.exit(0)
  }
}
