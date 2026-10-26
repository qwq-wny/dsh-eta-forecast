/* dsh-eta-forecast — 浏览器半侧（无框架、无构建）
 *
 * 页面里只做两件事：每 2 秒问宿主要一次快照，然后把数字画出来。
 * 所有推算都在宿主（lib/forecast.js），这里不做任何估算 —— 前后端各写一遍
 * 公式是这类小挂件最常见的坏味道：两边一改就悄悄不一致。
 *
 * 挂载门槛与鲸鱼挂件同源：只在**主聊天界面**出现（认 composer 输入区），
 * 插件市场等 SPA 页面一行 DOM 都不碰。
 *
 * 外观（缩放 / 壁纸）也全部在这一侧完成：宿主既不知道也不关心你把它画多大。
 */
(function () {
  'use strict'
  if (window.__dshEtaForecast) return
  window.__dshEtaForecast = true

  var STORAGE_KEY = 'dsh-eta-forecast:v1'
  /* 壁纸单独一个键：base64 图片动辄几百 KB，跟滑块值混在同一个 JSON 里，
   * 每拖一下滑块就要重写整坨大字符串 —— 主线程会卡，也更容易撞配额。 */
  var WALLPAPER_KEY = 'dsh-eta-forecast:wallpaper'
  var STATE_URL = '/dsh-eta/state.json'
  var POLL_MS = 2000
  var STYLE_ID = 'dsh-eta-style'
  var ROOT_ID = 'dsh-eta-root'
  var PANEL_ID = 'dsh-eta-panel'

  /* 缩放范围：25% ~ 100%。下限不是拍脑袋 —— 再小字就彻底读不出来了，
   * 与其给一个「能拖到 5%」的假自由度，不如把边界钉在还有意义的地方。 */
  var ZOOM_MIN = 25
  var ZOOM_MAX = 100
  var ZOOM_DEFAULT = 100

  /* 默认值不是拍脑袋定的：把 0.3 / 0.6 / 0.7 / 0.85 / 0.95 分别渲染出来比对过。
   * 0.3 时深色文字压在深蓝壁纸上糊成一片；0.95 时壁纸几乎看不见（等于没换）。
   * 0.65 + 0.28 暗化是「既看得出壁纸、字又清楚」的折中，用户可以自己再调。 */
  var DEFAULTS = {
    zoom: ZOOM_DEFAULT,
    blur: 0,
    dim: 0.28,
    cardAlpha: 0.65,
  }

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

  function readWallpaper() {
    try {
      return window.localStorage.getItem(WALLPAPER_KEY) || ''
    } catch (err) {
      return ''
    }
  }

  function writeWallpaper(value) {
    try {
      var store = window.localStorage
      if (value) {
        store.setItem(WALLPAPER_KEY, value)
      } else if (typeof store.removeItem === 'function') {
        store.removeItem(WALLPAPER_KEY)
      } else {
        store.setItem(WALLPAPER_KEY, '')
      }
      return true
    } catch (err) {
      // 配额爆了：图片太大。调用方负责把这句话显示给用户。
      return false
    }
  }

  function clampNumber(value, min, max, fallback) {
    var n = Number(value)
    if (!isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
  }

  function readAppearance() {
    var saved = readSettings()
    return {
      zoom: clampNumber(saved.zoom, ZOOM_MIN, ZOOM_MAX, DEFAULTS.zoom),
      blur: clampNumber(saved.blur, 0, 24, DEFAULTS.blur),
      dim: clampNumber(saved.dim, 0, 0.85, DEFAULTS.dim),
      cardAlpha: clampNumber(saved.cardAlpha, 0.15, 1, DEFAULTS.cardAlpha),
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

  /** 把 `rgb(r, g, b)` / `rgba(...)` 换成带指定透明度的写法；认不出来就原样返回。 */
  function withAlpha(color, alpha) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(String(color || ''))
    if (!m) return color || ''
    return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + alpha + ')'
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
    'user-select:none;-webkit-user-select:none;transition:opacity .18s ease,transform .18s ease;',
    // 缩放靠 transform：只影响绘制，不触发重排，拖动时也不会掉帧。
    'transform-origin:top left;overflow:hidden}',
    '#dsh-eta-root[data-hidden="1"]{display:none}',
    '#dsh-eta-root[data-dragging="1"]{transition:none}',
    // 壁纸三层都铺在内容下面；用 DOM 末尾 + z-index 而不是插到最前面，
    // 这样既有子节点的索引（标题行仍是 children[0]）保持不变。
    // 同一 z-index 下 DOM 越靠后画得越上层，所以顺序是：图 → 暗化 → 底色 → 内容。
    '.dsh-eta-bg,.dsh-eta-dim,.dsh-eta-wash{position:absolute;left:0;top:0;right:0;bottom:0;',
    'border-radius:inherit;pointer-events:none;z-index:0;display:none}',
    '.dsh-eta-bg{background-position:center;background-size:cover;background-repeat:no-repeat}',
    '#dsh-eta-root[data-wallpaper="1"] .dsh-eta-bg,',
    '#dsh-eta-root[data-wallpaper="1"] .dsh-eta-dim,',
    '#dsh-eta-root[data-wallpaper="1"] .dsh-eta-wash{display:block}',
    '.dsh-eta-head,.dsh-eta-body{position:relative;z-index:1}',
    '.dsh-eta-head{display:flex;align-items:center;gap:8px;cursor:grab}',
    '#dsh-eta-root[data-dragging="1"] .dsh-eta-head{cursor:grabbing}',
    '.dsh-eta-title{flex:1;min-width:0;font-weight:600;font-size:12px;',
    'letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    'color:var(--dsw-alias-label-secondary,rgba(60,70,90,.95))}',
    '.dsh-eta-btn{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:5px;',
    'background:transparent;color:inherit;cursor:pointer;opacity:.55;font:inherit;line-height:1;',
    'display:flex;align-items:center;justify-content:center}',
    '.dsh-eta-btn:hover{opacity:1;background:rgba(127,127,127,.16)}',
    '.dsh-eta-btn[data-active="1"]{opacity:1;background:rgba(127,127,127,.2)}',
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

    /* ---- 设置面板：独立于挂件根节点，所以不跟着缩放变小 ----
     * 25% 缩放时挂件只有 59px 宽，把面板塞进去就没法用了。 */
    '#dsh-eta-panel{position:fixed;z-index:9999;width:252px;box-sizing:border-box;',
    'border-radius:12px;padding:11px 12px 12px;',
    'background:var(--dsw-alias-bg-layer-3,#fff);',
    'border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));',
    'box-shadow:0 12px 34px rgba(15,25,60,.22);',
    'font-family:inherit;font-size:12px;line-height:1.45;',
    'color:var(--dsw-alias-label-primary,#1f2430);',
    'user-select:none;-webkit-user-select:none}',
    '#dsh-eta-panel[data-hidden="1"]{display:none}',
    '.dsh-eta-panel-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}',
    '.dsh-eta-panel-head b{flex:1;font-size:12px;font-weight:600}',
    '.dsh-eta-group{margin:9px 0 0;padding-top:9px;',
    'border-top:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.22))}',
    '.dsh-eta-group:first-of-type{margin-top:0;padding-top:0;border-top:0}',
    '.dsh-eta-row{display:flex;align-items:center;gap:8px;margin:6px 0}',
    '.dsh-eta-row label{flex:1;font-size:11.5px;',
    'color:var(--dsw-alias-label-secondary,rgba(60,70,90,.9))}',
    '.dsh-eta-row output{flex:none;width:44px;text-align:right;font-size:11px;',
    'font-variant-numeric:tabular-nums;',
    'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}',
    '.dsh-eta-row input[type="range"]{flex:1;min-width:0;height:16px;margin:0;cursor:pointer;',
    'accent-color:var(--dsw-alias-brand-primary,#4f9dd9)}',
    '.dsh-eta-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}',
    '.dsh-eta-action{flex:1 1 auto;min-width:64px;border:.5px solid rgba(127,127,127,.4);',
    'background:transparent;color:inherit;border-radius:7px;padding:5px 8px;',
    'font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}',
    '.dsh-eta-action:hover{background:rgba(127,127,127,.14)}',
    '.dsh-eta-action[data-danger="1"]{color:#b46214;border-color:rgba(180,98,20,.45)}',
    '.dsh-eta-url{display:flex;gap:6px;margin-top:6px}',
    '.dsh-eta-url input[type="text"]{flex:1;min-width:0;box-sizing:border-box;',
    'border:.5px solid rgba(127,127,127,.4);background:transparent;color:inherit;',
    'border-radius:7px;padding:4px 7px;font:inherit;font-size:11px}',
    '.dsh-eta-hint{margin-top:7px;font-size:10.5px;line-height:1.5;',
    'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95));min-height:14px}',
    '.dsh-eta-hint[data-tone="warn"]{color:#b46214}',
    '.dsh-eta-hint[data-tone="ok"]{color:#07974b}',
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
  var panel = null
  var panelNodes = null
  var current = null
  var timer = null
  var collapsed = false
  var dragging = false
  var appearance = null
  /** 主题底色（在壁纸接管之前抓一次），用来给卡片算半透明底色。 */
  var themeBg = ''
  var wallpaper = ''

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
    // 齿轮放在最后：标题行的前三个子节点位置保持不变，旧代码/旧测试不用改。
    var gear = el('button', 'dsh-eta-btn')
    gear.type = 'button'
    gear.title = '外观设置'
    gear.textContent = '⚙'
    head.appendChild(title)
    head.appendChild(toggle)
    head.appendChild(hide)
    head.appendChild(gear)

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

    // 壁纸三层都追加在最后：靠 z-index 压到内容下面，子节点索引不受影响。
    // 顺序很关键 —— 同一 z-index 下 DOM 越靠后画得越上层：
    //   壁纸图 → 暗化 → 卡片底色（wash）→ 内容。
    // 少了 wash 这一层，「卡片不透明度」就完全没用（底色会被壁纸盖住），
    // 深色壁纸上的深色文字也就彻底读不出来。
    var bg = el('div', 'dsh-eta-bg')
    var dim = el('div', 'dsh-eta-dim')
    var wash = el('div', 'dsh-eta-wash')

    root.appendChild(head)
    root.appendChild(body)
    root.appendChild(bg)
    root.appendChild(dim)
    root.appendChild(wash)
    document.body.appendChild(root)

    nodes = {
      root: root, title: title, toggle: toggle, hide: hide, gear: gear, body: body,
      clockBig: clockBig, clockUnit: clockUnit, sub: sub, fill: fill,
      footLeft: footLeft, badge: badge, task: task, pause: pause,
      bg: bg, dim: dim, wash: wash,
    }

    // 主题底色要在被壁纸覆盖之前读出来。
    try {
      if (typeof window.getComputedStyle === 'function') {
        themeBg = window.getComputedStyle(root).backgroundColor || ''
      }
    } catch (err) {
      themeBg = ''
    }

    var saved = readSettings()
    collapsed = saved.collapsed === true
    applyCollapsed()

    appearance = readAppearance()
    wallpaper = readWallpaper()

    toggle.addEventListener('click', function (event) {
      event.stopPropagation()
      collapsed = !collapsed
      applyCollapsed()
      writeSettings({ collapsed: collapsed })
    })

    hide.addEventListener('click', function (event) {
      event.stopPropagation()
      nodes.root.setAttribute('data-hidden', '1')
      hidePanel()
      writeSettings({ hidden: true })
      try { window.dispatchEvent(new CustomEvent('dsh-eta-hidden')) } catch (err) { /* 老浏览器忽略 */ }
    })

    gear.addEventListener('click', function (event) {
      event.stopPropagation()
      togglePanel()
    })

    installDrag(head)
    installRestore()
    installDoubleClickSettings(title)
    applyAppearance()
    return root
  }

  /* ---------- 缩放与壁纸 ---------- */

  /**
   * 应用缩放。`anchor` 为 'bottom-right' 时保持右下角不动 ——
   * 挂件住在右下角，缩小后如果还从左上角开始缩，会突然飘到屏幕中间去。
   */
  function applyZoom(percent, anchor) {
    if (!nodes) return
    var zoom = clampNumber(percent, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT)
    var before = null
    if (anchor === 'bottom-right' && typeof nodes.root.getBoundingClientRect === 'function') {
      before = nodes.root.getBoundingClientRect()
    }
    nodes.root.style.transformOrigin = 'top left'
    nodes.root.style.transform = zoom === 100 ? '' : 'scale(' + (zoom / 100) + ')'
    if (before && before.width > 0 && before.height > 0) {
      var after = nodes.root.getBoundingClientRect()
      if (after.width > 0 && after.height > 0) {
        // 不直接读 before.right/bottom：老浏览器与测试垫片不一定带这两个派生字段。
        var beforeRight = typeof before.right === 'number' ? before.right : before.left + before.width
        var beforeBottom = typeof before.bottom === 'number' ? before.bottom : before.top + before.height
        var nextLeft = beforeRight - after.width
        var nextTop = beforeBottom - after.height
        nodes.root.style.left = Math.max(0, nextLeft) + 'px'
        nodes.root.style.top = Math.max(0, nextTop) + 'px'
        nodes.root.style.right = 'auto'
        nodes.root.style.bottom = 'auto'
      }
    }
    if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
  }

  function applyAppearance() {
    if (!nodes || !appearance) return
    applyZoom(appearance.zoom, null)

    var hasWallpaper = !!wallpaper
    if (hasWallpaper) {
      nodes.root.setAttribute('data-wallpaper', '1')
      nodes.bg.style.backgroundImage = 'url("' + wallpaper.replace(/"/g, '\\"') + '")'
      // 模糊会把图层边缘也糊掉，露出发白的缝；放大一点点把缝推出可视区。
      nodes.bg.style.filter = appearance.blur > 0 ? 'blur(' + appearance.blur + 'px)' : ''
      nodes.bg.style.transform = appearance.blur > 0 ? 'scale(' + (1 + appearance.blur / 60) + ')' : ''
      nodes.dim.style.background = 'rgba(0,0,0,' + appearance.dim + ')'
      // 卡片底色必须画在**壁纸之上**（wash 层），不能设在 root 的 background 上：
      // root 的底色在壁纸图层下面，会被壁纸整块盖住 —— 那样「卡片不透明度」
      // 就是个死滑块，深色壁纸上的深色文字也会糊成一片。
      var base = themeBg || 'rgb(255,255,255)'
      nodes.wash.style.background = withAlpha(base, appearance.cardAlpha)
      nodes.root.style.background = 'transparent'
    } else {
      nodes.root.removeAttribute('data-wallpaper')
      nodes.bg.style.backgroundImage = ''
      nodes.bg.style.filter = ''
      nodes.bg.style.transform = ''
      nodes.dim.style.background = ''
      nodes.wash.style.background = ''
      nodes.root.style.background = ''
    }
  }

  function setWallpaper(value) {
    var next = typeof value === 'string' ? value : ''
    if (!writeWallpaper(next)) {
      setHint('这张图太大了，浏览器存不下。换张小一点的，或者用图片链接。', 'warn')
      return false
    }
    wallpaper = next
    applyAppearance()
    syncPanelValues()
    return true
  }

  /* ---------- 设置面板 ---------- */

  function togglePanel() {
    if (panel && panel.getAttribute('data-hidden') !== '1') hidePanel()
    else showPanel()
  }

  function showPanel() {
    if (!nodes) return
    if (!panel) buildPanel()
    if (!panel) return
    panel.removeAttribute('data-hidden')
    if (nodes.gear) nodes.gear.setAttribute('data-active', '1')
    syncPanelValues()
    positionPanel()
  }

  function hidePanel() {
    if (!panel) return
    panel.setAttribute('data-hidden', '1')
    if (nodes && nodes.gear) nodes.gear.removeAttribute('data-active')
  }

  function positionPanel() {
    if (!panel || !nodes) return
    if (panel.getAttribute('data-hidden') === '1') return
    var rect = nodes.root.getBoundingClientRect()
    var pw = panel.offsetWidth || 252
    var ph = panel.offsetHeight || 320
    var gap = 8
    var left = rect.left
    var top = rect.top - ph - gap
    // 卡片缩放后 getBoundingClientRect 才是真实视觉盒子，但 right/bottom 不一定有。
    var rectBottom = typeof rect.bottom === 'number' ? rect.bottom : rect.top + (rect.height || 0)
    if (top < gap) top = rectBottom + gap
    if (top + ph > window.innerHeight - gap) top = Math.max(gap, window.innerHeight - ph - gap)
    left = Math.max(gap, Math.min(window.innerWidth - pw - gap, left))
    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(top) + 'px'
  }

  function setHint(text, tone) {
    if (!panelNodes) return
    panelNodes.hint.textContent = text || ''
    if (tone) panelNodes.hint.setAttribute('data-tone', tone)
    else panelNodes.hint.removeAttribute('data-tone')
  }

  function makeRangeRow(labelText, min, max, step, format, onInput) {
    var row = el('div', 'dsh-eta-row')
    var label = el('label', '', labelText)
    var input = el('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    var output = el('output', '')
    row.appendChild(label)
    row.appendChild(input)
    row.appendChild(output)
    input.addEventListener('input', function () {
      var value = Number(input.value)
      output.textContent = format(value)
      onInput(value)
    })
    return { row: row, input: input, output: output, format: format }
  }

  function buildPanel() {
    if (panel) return
    var root = el('div')
    root.id = PANEL_ID
    root.setAttribute('data-hidden', '1')

    var head = el('div', 'dsh-eta-panel-head')
    var heading = el('b', '', '外观设置')
    var close = el('button', 'dsh-eta-btn')
    close.type = 'button'
    close.title = '关闭'
    close.textContent = '×'
    head.appendChild(heading)
    head.appendChild(close)

    /* --- 缩放 --- */
    var zoomGroup = el('div', 'dsh-eta-group')
    var zoomRow = makeRangeRow('缩放', ZOOM_MIN, ZOOM_MAX, 5, function (v) { return v + '%' }, function (value) {
      appearance.zoom = value
      applyZoom(value, 'bottom-right')
      writeSettings({ zoom: value })
    })
    zoomGroup.appendChild(zoomRow.row)

    /* --- 壁纸 --- */
    var wallGroup = el('div', 'dsh-eta-group')
    var wallLabel = el('div', 'dsh-eta-row')
    var wallTitle = el('label', '', '壁纸')
    wallLabel.appendChild(wallTitle)
    wallGroup.appendChild(wallLabel)

    var actions = el('div', 'dsh-eta-actions')
    var pick = el('button', 'dsh-eta-action', '选本地图片')
    pick.type = 'button'
    var fileInput = el('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/*'
    fileInput.style.display = 'none'
    var clear = el('button', 'dsh-eta-action', '清除壁纸')
    clear.type = 'button'
    clear.setAttribute('data-danger', '1')
    actions.appendChild(pick)
    actions.appendChild(clear)
    wallGroup.appendChild(actions)
    wallGroup.appendChild(fileInput)

    var urlRow = el('div', 'dsh-eta-url')
    var urlInput = el('input')
    urlInput.type = 'text'
    urlInput.placeholder = '粘贴图片链接…'
    var urlApply = el('button', 'dsh-eta-action', '用链接')
    urlApply.type = 'button'
    urlApply.style.flex = '0 0 auto'
    urlRow.appendChild(urlInput)
    urlRow.appendChild(urlApply)
    wallGroup.appendChild(urlRow)

    var blurRow = makeRangeRow('模糊', 0, 24, 1, function (v) { return v + 'px' }, function (value) {
      appearance.blur = value
      applyAppearance()
      writeSettings({ blur: value })
    })
    var dimRow = makeRangeRow('暗化', 0, 0.85, 0.05, function (v) { return Math.round(v * 100) + '%' }, function (value) {
      appearance.dim = value
      applyAppearance()
      writeSettings({ dim: value })
    })
    var alphaRow = makeRangeRow('卡片不透明度', 0.15, 1, 0.05, function (v) { return Math.round(v * 100) + '%' }, function (value) {
      appearance.cardAlpha = value
      applyAppearance()
      writeSettings({ cardAlpha: value })
    })
    wallGroup.appendChild(blurRow.row)
    wallGroup.appendChild(dimRow.row)
    wallGroup.appendChild(alphaRow.row)

    /* --- 恢复默认 --- */
    var resetGroup = el('div', 'dsh-eta-group')
    var resetRow = el('div', 'dsh-eta-actions')
    var reset = el('button', 'dsh-eta-action', '恢复默认')
    reset.type = 'button'
    reset.setAttribute('data-danger', '1')
    resetRow.appendChild(reset)
    resetGroup.appendChild(resetRow)

    var hint = el('div', 'dsh-eta-hint', '')

    root.appendChild(head)
    root.appendChild(zoomGroup)
    root.appendChild(wallGroup)
    root.appendChild(resetGroup)
    root.appendChild(hint)
    document.body.appendChild(root)

    panel = root
    panelNodes = {
      zoom: zoomRow, blur: blurRow, dim: dimRow, alpha: alphaRow,
      urlInput: urlInput, fileInput: fileInput, hint: hint,
    }

    close.addEventListener('click', function (event) {
      event.stopPropagation()
      hidePanel()
    })

    pick.addEventListener('click', function (event) {
      event.stopPropagation()
      try { fileInput.click() } catch (err) { setHint('这个环境不支持选文件，用下面的链接吧。', 'warn') }
    })

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0]
      if (!file) return
      setHint('正在处理图片…', null)
      readImageFile(file, function (dataUrl) {
        if (!dataUrl) {
          setHint('这张图读不出来，换一张试试。', 'warn')
          return
        }
        if (setWallpaper(dataUrl)) setHint('壁纸已更新', 'ok')
      })
    })

    function applyUrl() {
      var value = String(urlInput.value || '').trim()
      if (!value) {
        setHint('先粘一个图片链接。', 'warn')
        return
      }
      if (setWallpaper(value)) setHint('壁纸已更新', 'ok')
    }

    urlApply.addEventListener('click', function (event) {
      event.stopPropagation()
      applyUrl()
    })

    urlInput.addEventListener('keydown', function (event) {
      if (!event || event.key !== 'Enter') return
      event.stopPropagation()
      applyUrl()
    })

    clear.addEventListener('click', function (event) {
      event.stopPropagation()
      if (setWallpaper('')) setHint('壁纸已清除', 'ok')
    })

    reset.addEventListener('click', function (event) {
      event.stopPropagation()
      resetAll()
    })
  }

  function syncPanelValues() {
    if (!panelNodes) return
    var rows = [
      [panelNodes.zoom, appearance.zoom],
      [panelNodes.blur, appearance.blur],
      [panelNodes.dim, appearance.dim],
      [panelNodes.alpha, appearance.cardAlpha],
    ]
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i][0]
      var value = rows[i][1]
      row.input.value = String(value)
      row.output.textContent = row.format(value)
    }
  }

  function resetAll() {
    appearance = {
      zoom: DEFAULTS.zoom,
      blur: DEFAULTS.blur,
      dim: DEFAULTS.dim,
      cardAlpha: DEFAULTS.cardAlpha,
    }
    writeWallpaper('')
    wallpaper = ''
    // 位置也一起清掉：用户点「恢复默认」时想的是「回到刚装上的样子」，
    // 留着上次拖到屏幕中间的位置就不算默认。
    writeSettings({
      zoom: DEFAULTS.zoom,
      blur: DEFAULTS.blur,
      dim: DEFAULTS.dim,
      cardAlpha: DEFAULTS.cardAlpha,
      left: null,
      top: null,
      collapsed: false,
    })
    collapsed = false
    applyCollapsed()
    nodes.root.style.left = ''
    nodes.root.style.top = ''
    nodes.root.style.right = ''
    nodes.root.style.bottom = ''
    applyAppearance()
    syncPanelValues()
    positionPanel()
    setHint('已恢复默认外观', 'ok')
  }

  /* ---------- 图片处理 ---------- */

  /** 读本地图片 → 缩到最长边 1024 → JPEG 0.82，尽量塞进 localStorage。 */
  function readImageFile(file, done) {
    if (typeof FileReader !== 'function') return done(null)
    var reader = new FileReader()
    reader.onerror = function () { done(null) }
    reader.onload = function () {
      var raw = reader.result
      if (typeof raw !== 'string') return done(null)
      compressImage(raw, done)
    }
    try { reader.readAsDataURL(file) } catch (err) { done(null) }
  }

  function compressImage(raw, done) {
    if (typeof Image !== 'function' || !document.createElement) return done(raw)
    var img = new Image()
    // 压缩失败就直接存原图：能显示出来总比「点了没反应」强。
    img.onerror = function () { done(raw) }
    img.onload = function () {
      try {
        var max = 1024
        var w0 = img.width || img.naturalWidth || 0
        var h0 = img.height || img.naturalHeight || 0
        if (!w0 || !h0) return done(raw)
        var scale = Math.min(1, max / Math.max(w0, h0))
        var w = Math.max(1, Math.round(w0 * scale))
        var h = Math.max(1, Math.round(h0 * scale))
        var canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        var ctx2d = canvas.getContext ? canvas.getContext('2d') : null
        if (!ctx2d) return done(raw)
        ctx2d.drawImage(img, 0, 0, w, h)
        var out = canvas.toDataURL('image/jpeg', 0.82)
        done(typeof out === 'string' && out.length > 0 ? out : raw)
      } catch (err) {
        done(raw)
      }
    }
    img.src = raw
  }

  /* ---------- 双击标题行也能开设置 ---------- */

  function installDoubleClickSettings(handle) {
    handle.addEventListener('dblclick', function (event) {
      event.stopPropagation()
      showPanel()
    })
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
      // 点在按钮上时不要开始拖动，否则点齿轮会顺手把卡片拖走。
      var target = event.target
      if (target && target.tagName === 'BUTTON') return
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
      // 用可视尺寸（getBoundingClientRect）而不是 offsetWidth：
      // 缩放后布局宽度仍是 236，只有视觉盒子才是真大小。
      var rect = nodes.root.getBoundingClientRect()
      var width = rect.width || nodes.root.offsetWidth
      var height = rect.height || nodes.root.offsetHeight
      var left = Math.max(0, Math.min(window.innerWidth - width, originLeft + dx))
      var top = Math.max(0, Math.min(window.innerHeight - height, originTop + dy))
      nodes.root.style.left = left + 'px'
      nodes.root.style.top = top + 'px'
      if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
    })

    function finish(event) {
      if (!dragging) return
      dragging = false
      nodes.root.removeAttribute('data-dragging')
      try { handle.releasePointerCapture(event.pointerId) } catch (err) { /* 忽略 */ }
      if (!moved) return
      writeSettings({ left: nodes.root.offsetLeft, top: nodes.root.offsetTop })
      if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
    }

    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)

    // 记住的位置在挂载时恢复；先把默认的 right/bottom 折算成 left/top，
    // 之后缩放、拖动、夹回屏幕都在同一套坐标系里算。
    requestAnimationFrame(function () {
      if (!nodes) return
      var rect = nodes.root.getBoundingClientRect()
      var saved = readSettings()
      var left = rect.left
      var top = rect.top
      if (typeof saved.left === 'number' && typeof saved.top === 'number') {
        left = Math.max(0, Math.min(window.innerWidth - rect.width, saved.left))
        top = Math.max(0, Math.min(window.innerHeight - rect.height, saved.top))
      }
      nodes.root.style.left = left + 'px'
      nodes.root.style.top = top + 'px'
      nodes.root.style.right = 'auto'
      nodes.root.style.bottom = 'auto'
      // 缩放要在定位之后应用，否则「保持右下角」的锚点算的是还没定位的盒子。
      applyZoom(appearance.zoom, 'bottom-right')
    })

    window.addEventListener('resize', function () {
      if (!nodes || nodes.root.getAttribute('data-hidden') === '1') return
      if (!nodes.root.style.left) return
      var rect = nodes.root.getBoundingClientRect()
      var width = rect.width || nodes.root.offsetWidth
      var height = rect.height || nodes.root.offsetHeight
      var left = Math.min(parseFloat(nodes.root.style.left) || 0, Math.max(0, window.innerWidth - width))
      var top = Math.min(parseFloat(nodes.root.style.top) || 0, Math.max(0, window.innerHeight - height))
      nodes.root.style.left = Math.max(0, left) + 'px'
      nodes.root.style.top = Math.max(0, top) + 'px'
      if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
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

    // 卡片高度会随文案变化，面板贴着它走。
    if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
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
