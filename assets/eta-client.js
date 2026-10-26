/* dsh-eta-forecast — 浏览器半侧（无框架、无构建）
 *
 * 页面里只做两件事：每 2 秒问宿主要一次快照，然后把数字画出来。
 * 所有推算都在宿主（lib/forecast.js），这里不做任何估算 —— 前后端各写一遍
 * 公式是这类小挂件最常见的坏味道：两边一改就悄悄不一致。
 *
 * 挂载门槛与鲸鱼挂件同源：只在**主聊天界面**出现（认 composer 输入区），
 * 插件市场等 SPA 页面一行 DOM 都不碰。
 */
(function () {
  'use strict'
  if (window.__dshEtaForecast) return
  window.__dshEtaForecast = true

  var STORAGE_KEY = 'dsh-eta-forecast:v1'
  var STATE_URL = '/dsh-eta/state.json'
  var POLL_MS = 2000
  var STYLE_ID = 'dsh-eta-style'
  var ROOT_ID = 'dsh-eta-root'

  /* ---------- 挂载门槛 ---------- */

  function isChatRoot(node) {
    if (!node || !node.querySelector) return false
    return !!(
      node.querySelector('textarea') ||
      node.querySelector('[contenteditable="true"]') ||
      node.querySelector('[data-composer-input]') ||
      node.querySelector('[data-composer-seat],[data-composer-card]') ||
      node.querySelector('[role="textbox"][aria-multiline="true"]')
    )
  }

  /* ---------- 设置持久化 ---------- */

  function readSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return {}
      var parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (err) {
      return {}
    }
  }

  function writeSettings(patch) {
    try {
      var next = Object.assign({}, readSettings(), patch)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch (err) {
      /* 隐私模式下 localStorage 不可写：本次会话仍然可用，只是不记住 */
    }
  }

  /* ---------- 格式化 ---------- */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }

  function clockOf(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return ''
    var d = new Date(ms)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function durationOf(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
    var total = Math.round(ms / 1000)
    if (total < 60) return total + ' 秒'
    var minutes = Math.floor(total / 60)
    var seconds = total % 60
    if (minutes < 60) return seconds > 0 && minutes < 10 ? minutes + ' 分 ' + seconds + ' 秒' : minutes + ' 分'
    var hours = Math.floor(minutes / 60)
    var rest = minutes % 60
    return rest > 0 ? hours + ' 小时 ' + rest + ' 分' : hours + ' 小时'
  }

  var CONFIDENCE_LABEL = {
    none: '样本不足',
    low: '粗略',
    medium: '中等',
    high: '较准',
  }

  /* ---------- 样式 ---------- */

  var CSS = [
    '#dsh-eta-root{position:fixed;z-index:9998;right:16px;bottom:16px;width:236px;',
    'box-sizing:border-box;border-radius:14px;padding:11px 13px 12px;',
    'background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.94));',
    'border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));',
    'box-shadow:0 8px 26px rgba(15,25,60,.14);',
    'font-family:inherit;font-size:12px;line-height:1.45;',
    'color:var(--dsw-alias-label-primary,#1f2430);',
    'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    'user-select:none;-webkit-user-select:none;transition:opacity .18s ease,transform .18s ease}',
    '#dsh-eta-root[data-hidden="1"]{display:none}',
    '#dsh-eta-root[data-dragging="1"]{transition:none}',
    '.dsh-eta-head{display:flex;align-items:center;gap:8px;cursor:grab}',
    '#dsh-eta-root[data-dragging="1"] .dsh-eta-head{cursor:grabbing}',
    '.dsh-eta-title{flex:1;min-width:0;font-weight:600;font-size:12px;',
    'letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    'color:var(--dsw-alias-label-secondary,rgba(60,70,90,.95))}',
    '.dsh-eta-btn{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:5px;',
    'background:transparent;color:inherit;cursor:pointer;opacity:.55;font:inherit;line-height:1;',
    'display:flex;align-items:center;justify-content:center}',
    '.dsh-eta-btn:hover{opacity:1;background:rgba(127,127,127,.16)}',
    '.dsh-eta-clock{display:flex;align-items:baseline;gap:7px;margin-top:7px}',
    '.dsh-eta-clock b{font-size:23px;font-weight:650;line-height:1.15;letter-spacing:-.4px;',
    'font-variant-numeric:tabular-nums}',
    '.dsh-eta-clock span{font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}',
    '.dsh-eta-sub{margin-top:2px;font-size:11.5px;',
    'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}',
    '.dsh-eta-bar{position:relative;height:5px;margin-top:9px;border-radius:99px;',
    'background:rgba(127,127,127,.22);overflow:hidden}',
    '.dsh-eta-fill{position:absolute;left:0;top:0;height:100%;width:0;border-radius:99px;',
    'background:var(--dsw-alias-brand-primary,#4f9dd9);transition:width .45s ease}',
    '.dsh-eta-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;',
    'font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}',
    '.dsh-eta-task{margin-top:7px;font-size:11.5px;line-height:1.4;',
    'color:var(--dsw-alias-label-secondary,rgba(60,70,90,.9));',
    'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.dsh-eta-pause{margin-top:7px;font-size:11px;font-weight:600;color:#b46214}',
    '.dsh-eta-root-collapsed .dsh-eta-body{display:none}',
    '.dsh-eta-badge{font-size:10.5px;padding:1px 6px;border-radius:99px;white-space:nowrap;',
    'background:rgba(127,127,127,.16)}',
    '.dsh-eta-badge[data-confidence="high"]{background:rgba(7,150,90,.16);color:#07974b}',
    '.dsh-eta-badge[data-confidence="medium"]{background:rgba(80,130,200,.16);color:#3d76b8}',
    '.dsh-eta-badge[data-confidence="low"]{background:rgba(210,120,40,.16);color:#b46214}',
    '.dsh-eta-badge[data-confidence="none"]{background:rgba(127,127,127,.14);color:rgba(127,127,127,.95)}',
  ].join('')

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  /* ---------- 视图 ---------- */

  var nodes = null
  var current = null
  var timer = null
  var collapsed = false
  var dragging = false

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function build() {
    ensureStyle()
    var root = el('div')
    root.id = ROOT_ID

    var head = el('div', 'dsh-eta-head')
    var title = el('div', 'dsh-eta-title', '预计完成')
    var toggle = el('button', 'dsh-eta-btn')
    toggle.type = 'button'
    toggle.title = '收起 / 展开'
    toggle.textContent = '−'
    var hide = el('button', 'dsh-eta-btn')
    hide.type = 'button'
    hide.title = '隐藏（设置里可恢复）'
    hide.textContent = '×'
    head.appendChild(title)
    head.appendChild(toggle)
    head.appendChild(hide)

    var body = el('div', 'dsh-eta-body')
    var clock = el('div', 'dsh-eta-clock')
    var clockBig = el('b', '', '—')
    var clockUnit = el('span', '', '')
    clock.appendChild(clockBig)
    clock.appendChild(clockUnit)
    var sub = el('div', 'dsh-eta-sub', '等待这一轮开始…')
    var bar = el('div', 'dsh-eta-bar')
    var fill = el('div', 'dsh-eta-fill')
    bar.appendChild(fill)
    var foot = el('div', 'dsh-eta-foot')
    var footLeft = el('span', '', '')
    var badge = el('span', 'dsh-eta-badge', '样本不足')
    badge.setAttribute('data-confidence', 'none')
    foot.appendChild(footLeft)
    foot.appendChild(badge)
    var task = el('div', 'dsh-eta-task')
    var pause = el('div', 'dsh-eta-pause')

    body.appendChild(clock)
    body.appendChild(sub)
    body.appendChild(bar)
    body.appendChild(foot)
    body.appendChild(task)
    body.appendChild(pause)

    root.appendChild(head)
    root.appendChild(body)
    document.body.appendChild(root)

    nodes = {
      root: root, title: title, toggle: toggle, hide: hide, body: body,
      clockBig: clockBig, clockUnit: clockUnit, sub: sub, fill: fill,
      footLeft: footLeft, badge: badge, task: task, pause: pause,
    }

    var saved = readSettings()
    collapsed = saved.collapsed === true
    applyCollapsed()

    toggle.addEventListener('click', function (event) {
      event.stopPropagation()
      collapsed = !collapsed
      applyCollapsed()
      writeSettings({ collapsed: collapsed })
    })

    hide.addEventListener('click', function (event) {
      event.stopPropagation()
      nodes.root.setAttribute('data-hidden', '1')
      writeSettings({ hidden: true })
      try { window.dispatchEvent(new CustomEvent('dsh-eta-hidden')) } catch (err) { /* 老浏览器忽略 */ }
    })

    installDrag(head)
    installRestore()
    return root
  }

  function applyCollapsed() {
    if (!nodes) return
    if (collapsed) nodes.root.classList.add('dsh-eta-root-collapsed')
    else nodes.root.classList.remove('dsh-eta-root-collapsed')
    nodes.toggle.textContent = collapsed ? '+' : '−'
  }

  /* ---------- 拖动（位置记住） ---------- */

  function installDrag(handle) {
    var startX = 0
    var startY = 0
    var originLeft = 0
    var originTop = 0
    var moved = false

    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      var rect = nodes.root.getBoundingClientRect()
      startX = event.clientX
      startY = event.clientY
      originLeft = rect.left
      originTop = rect.top
      moved = false
      dragging = true
      nodes.root.setAttribute('data-dragging', '1')
      // 拖动期间改为 left/top 定位，否则 right/bottom 会让坐标算反。
      nodes.root.style.left = originLeft + 'px'
      nodes.root.style.top = originTop + 'px'
      nodes.root.style.right = 'auto'
      nodes.root.style.bottom = 'auto'
      try { handle.setPointerCapture(event.pointerId) } catch (err) { /* 忽略 */ }
    })

    handle.addEventListener('pointermove', function (event) {
      if (!dragging) return
      var dx = event.clientX - startX
      var dy = event.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return
      moved = true
      var width = nodes.root.offsetWidth
      var height = nodes.root.offsetHeight
      var left = Math.max(0, Math.min(window.innerWidth - width, originLeft + dx))
      var top = Math.max(0, Math.min(window.innerHeight - height, originTop + dy))
      nodes.root.style.left = left + 'px'
      nodes.root.style.top = top + 'px'
    })

    function finish(event) {
      if (!dragging) return
      dragging = false
      nodes.root.removeAttribute('data-dragging')
      try { handle.releasePointerCapture(event.pointerId) } catch (err) { /* 忽略 */ }
      if (!moved) return
      writeSettings({ left: nodes.root.offsetLeft, top: nodes.root.offsetTop })
    }

    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)

    // 记住的位置在挂载时恢复（窗口变小要夹回来）。
    var saved = readSettings()
    if (typeof saved.left === 'number' && typeof saved.top === 'number') {
      requestAnimationFrame(function () {
        var width = nodes.root.offsetWidth
        var height = nodes.root.offsetHeight
        var left = Math.max(0, Math.min(window.innerWidth - width, saved.left))
        var top = Math.max(0, Math.min(window.innerHeight - height, saved.top))
        nodes.root.style.left = left + 'px'
        nodes.root.style.top = top + 'px'
        nodes.root.style.right = 'auto'
        nodes.root.style.bottom = 'auto'
      })
    }

    window.addEventListener('resize', function () {
      if (!nodes || nodes.root.getAttribute('data-hidden') === '1') return
      if (!nodes.root.style.left) return
      var width = nodes.root.offsetWidth
      var height = nodes.root.offsetHeight
      var left = Math.min(parseFloat(nodes.root.style.left) || 0, Math.max(0, window.innerWidth - width))
      var top = Math.min(parseFloat(nodes.root.style.top) || 0, Math.max(0, window.innerHeight - height))
      nodes.root.style.left = Math.max(0, left) + 'px'
      nodes.root.style.top = Math.max(0, top) + 'px'
    })
  }

  /* ---------- 隐藏后的恢复入口 ---------- */

  function installRestore() {
    // 隐藏之后唯一能回来的路：双击页面右下角一小块热区。
    // 不往页面上加常驻按钮 —— 用户点 × 的意图就是「别碍事」，再放个恢复按钮等于没关。
    if (window.__dshEtaRestoreBound) return
    window.__dshEtaRestoreBound = true
    document.addEventListener('dblclick', function (event) {
      if (!nodes) return
      if (nodes.root.getAttribute('data-hidden') !== '1') return
      var rect = nodes.root.getBoundingClientRect()
      var hotspot = 48
      var nearRight = event.clientX >= window.innerWidth - hotspot
      var nearBottom = event.clientY >= window.innerHeight - hotspot
      var nearSaved = Math.abs(event.clientX - rect.left) < 200 && Math.abs(event.clientY - rect.top) < 200
      if (!nearRight && !nearBottom && !nearSaved) return
      nodes.root.removeAttribute('data-hidden')
      writeSettings({ hidden: false })
    }, true)
  }

  /* ---------- 渲染 ---------- */

  function pickSession(payload) {
    if (!payload || !Array.isArray(payload.sessions) || payload.sessions.length === 0) return null
    return payload.sessions[0]
  }

  function render(snapshot) {
    if (!nodes) return
    current = snapshot

    if (!snapshot) {
      nodes.title.textContent = '预计完成'
      nodes.clockBig.textContent = '—'
      nodes.clockUnit.textContent = ''
      nodes.sub.textContent = '还没有进行中的对话'
      nodes.fill.style.width = '0%'
      nodes.footLeft.textContent = ''
      nodes.badge.textContent = '空闲'
      nodes.badge.setAttribute('data-confidence', 'none')
      nodes.task.textContent = ''
      nodes.pause.textContent = ''
      return
    }

    var running = snapshot.phase === 'running'
    nodes.title.textContent = snapshot.title ? snapshot.title : '预计完成'

    if (!running) {
      nodes.clockBig.textContent = '已完成'
      nodes.clockUnit.textContent = ''
      var endedAt = snapshot.updatedAt
      var reasonText = snapshot.endReason === 'error' ? '（出错结束）'
        : snapshot.endReason === 'aborted' ? '（被中断）'
          : snapshot.endReason === 'max-tokens' ? '（输出截断）' : ''
      nodes.sub.textContent = '上一轮用时 ' + durationOf(snapshot.elapsedMs) + reasonText
      nodes.fill.style.width = '100%'
      nodes.footLeft.textContent = clockOf(endedAt) ? clockOf(endedAt) + ' 结束' : ''
      nodes.badge.textContent = '空闲'
      nodes.badge.setAttribute('data-confidence', 'none')
      nodes.task.textContent = ''
      nodes.pause.textContent = ''
      return
    }

    if (snapshot.remainMs === null) {
      nodes.clockBig.textContent = '—'
      nodes.clockUnit.textContent = ''
      nodes.sub.textContent = '已跑 ' + durationOf(snapshot.elapsedMs) + '，还看不出节奏'
    } else {
      nodes.clockBig.textContent = clockOf(snapshot.etaAt) || '—'
      nodes.clockUnit.textContent = '左右完成 · 还有 ' + durationOf(snapshot.remainMs)
      nodes.sub.textContent = '已跑 ' + durationOf(snapshot.elapsedMs)
    }

    var progress = typeof snapshot.progress === 'number' && isFinite(snapshot.progress) ? snapshot.progress : 0
    nodes.fill.style.width = Math.max(0, Math.min(100, progress * 100)).toFixed(1) + '%'

    if (snapshot.total > 0) {
      nodes.footLeft.textContent = snapshot.completed + '/' + snapshot.total + ' 项'
    } else if (snapshot.steps > 0) {
      nodes.footLeft.textContent = '第 ' + snapshot.steps + ' 步'
    } else {
      nodes.footLeft.textContent = ''
    }

    var confidence = snapshot.confidence || 'none'
    nodes.badge.textContent = CONFIDENCE_LABEL[confidence] || '样本不足'
    nodes.badge.setAttribute('data-confidence', confidence)

    nodes.task.textContent = snapshot.currentTask ? '正在做：' + snapshot.currentTask : ''
    if (snapshot.paused) {
      nodes.pause.textContent = '⏸ 等你操作，这段时间不计入工期'
    } else if (snapshot.pausedMs > 0) {
      nodes.pause.textContent = ''
    } else {
      nodes.pause.textContent = ''
    }
  }

  /* ---------- 轮询 ---------- */

  var failureCount = 0

  function poll() {
    var controller = null
    try {
      if (typeof AbortController === 'function') controller = new AbortController()
    } catch (err) { /* 忽略 */ }

    // 宿主已经重启/卸载时 fetch 会挂住，超时比「一直显示旧数字」诚实。
    var timeout = null
    if (controller) {
      timeout = setTimeout(function () {
        try { controller.abort() } catch (err) { /* 忽略 */ }
      }, POLL_MS * 3)
    }

    var options = { cache: 'no-store' }
    if (controller) options.signal = controller.signal

    window.fetch(STATE_URL, options)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        failureCount = 0
        render(pickSession(payload))
      })
      .catch(function () {
        failureCount++
        // 连续失败才改文案：一次网络抖动不该把 ETA 抹掉。
        if (failureCount >= 3 && current) render(null)
      })
      .then(function () {
        if (timeout !== null) clearTimeout(timeout)
      })
  }

  function start() {
    build()
    poll()
    timer = setInterval(poll, POLL_MS)
    // 页面隐藏时不轮询：后台标签页里每秒一次请求纯属浪费。
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (timer !== null) { clearInterval(timer); timer = null }
      } else if (timer === null) {
        poll()
        timer = setInterval(poll, POLL_MS)
      }
    })
    window.addEventListener('beforeunload', function () {
      if (timer !== null) { clearInterval(timer); timer = null }
    })
  }

  /* ---------- 等主聊天界面出现 ---------- */

  var started = false

  function tryStart() {
    if (started) return true
    try {
      if (!isChatRoot(document.getElementById('root'))) return false
    } catch (err) {
      return false
    }
    started = true
    try { start() } catch (err) {
      started = false
      try { console.warn('[dsh-eta] 挂载失败', err) } catch (inner) { /* 忽略 */ }
    }
    return true
  }

  if (!tryStart()) {
    var lastCheck = 0
    var observer = new MutationObserver(function () {
      var now = Date.now()
      if (now - lastCheck < 200) return
      lastCheck = now
      if (tryStart() && observer) {
        observer.disconnect()
        observer = null
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    // 兜底：某些布局下 MutationObserver 看不到（节点在 shadow root 里），
    // 用一个低频定时器继续试，直到成功为止（不做「N 秒后放弃」—— 慢启动的机器会永远看不到）。
    setInterval(function () {
      if (tryStart() && observer) {
        observer.disconnect()
        observer = null
      }
    }, 1500)
  }
})()
