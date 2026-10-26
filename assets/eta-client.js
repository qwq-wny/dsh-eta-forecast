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
  /** 显示位置配置（GET 查 / POST 改；写操作宿主只接受回环请求）。 */
  var CONFIG_URL = '/dsh-eta/config'
  var POLL_MS = 2000
  var STYLE_ID = 'dsh-eta-style'
  var ROOT_ID = 'dsh-eta-root'
  var PANEL_ID = 'dsh-eta-panel'
  var CONTEXT_MENU_ID = 'dsh-eta-ctxmenu'

  /**
   * 当前跑在**桌面浮窗**里还是浏览器页面里？
   *
   * 判据是桌面渲染壳在 html 上打的标记（见 runtime/electron-helper/desktop-renderer.js）。
   * 两种情况的差别只有一处但很关键：**拖动的对象不同** ——
   * 网页里拖的是 DOM 元素，桌面里拖的是整个窗口。其余逻辑（渲染、缩放、壁纸、
   * 右键菜单、设置面板）完全共用，不做第二套。
   */
  var IS_DESKTOP = (function () {
    try {
      return document.documentElement.getAttribute('data-dsh-eta-desktop') === '1'
    } catch (err) {
      return false
    }
  })()

  /** 桌面端事件通道：把拖动位移交给渲染壳换算成窗口坐标。网页端是空操作。 */
  function emitDesktop(type, detail) {
    if (!IS_DESKTOP) return
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: detail || {} }))
    } catch (err) {
      /* 老浏览器 / 测试垫片没有 CustomEvent，忽略即可 */
    }
  }

  /**
   * 把相对路径解析成**绝对 URL**。
   *
   * 网页端不需要（页面 origin 就是宿主，`/dsh-eta/...` 天然正确）；
   * 但桌面浮窗的页面是 `file://`，相对路径会被解析成 `file:///C:/dsh-eta/...`，
   * 既打不到宿主、也会被 CSP 的 connect-src 拦掉 —— 表现就是「窗口开着、
   * 数据永远是空白」。所以桌面端必须走绝对地址。
   */
  function absoluteUrl(relative) {
    if (!IS_DESKTOP) return relative
    try {
      var base = window.__dshEtaBaseUrl
      if (typeof base === 'string' && base) return new URL(relative, base).toString()
    } catch (err) { /* 落到下面原样返回 */ }
    return relative
  }

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
    // 隐藏标题行按钮，改由右键唤出菜单。默认关：新用户先看到按钮更好上手，
    // 等嫌碍事了再打开 —— 这个开关的意义是「我要一张干净的卡片」。
    menuHidden: false,
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
      menuHidden: saved.menuHidden === true,
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
    '#dsh-eta-root[data-dragging="1"]{transition:none}',
    // 「仅桌面 / 都不」时网页里的挂件整体消失（宿主已经不注入了，这里兜住已打开的页面）。
    '#dsh-eta-root[data-display-off="1"]{display:none}',
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
    // 「隐藏菜单按钮」：整组按钮消失，卡片只剩标题与数据，改由右键唤出菜单。
    // 用 display:none 而不是 visibility —— 否则会留一块看不见但吃点击的空位。
    '#dsh-eta-root[data-menu-hidden="1"] .dsh-eta-btn{display:none}',
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

    /* 小尺寸逃生门：透明、不挡内容，只是给「双击开设置」一个够大的落点。 */
    '.dsh-eta-hotspot{position:fixed;z-index:9997;background:transparent;cursor:pointer}',

    /* 右键菜单：同样挂在 body 上，不跟着卡片缩放。 */
    '#dsh-eta-ctxmenu{position:fixed;z-index:10000;min-width:112px;box-sizing:border-box;',
    'padding:4px;border-radius:9px;',
    'background:var(--dsw-alias-bg-layer-3,#fff);',
    'border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));',
    'box-shadow:0 10px 28px rgba(15,25,60,.2);',
    'font-family:inherit;font-size:12px;line-height:1.4;',
    'color:var(--dsw-alias-label-primary,#1f2430);',
    'user-select:none;-webkit-user-select:none}',
    '#dsh-eta-ctxmenu[data-hidden="1"]{display:none}',
    '.dsh-eta-ctxitem{display:block;width:100%;box-sizing:border-box;padding:5px 9px;',
    'border:0;border-radius:6px;background:transparent;color:inherit;',
    'font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}',
    '.dsh-eta-ctxitem:hover{background:rgba(127,127,127,.16)}',

    /* 复选框跟着文字排，不撑高整行。 */
    '.dsh-eta-check{flex:none;width:14px;height:14px;margin:0;cursor:pointer;',
    'accent-color:var(--dsw-alias-brand-primary,#4f9dd9)}',
    /* 下拉选择：与输入框同一套观感，宽度收窄以免挤掉标签。 */
    '.dsh-eta-select{flex:none;width:88px;box-sizing:border-box;font:inherit;font-size:11.5px;',
    'padding:3px 4px;border-radius:6px;cursor:pointer;',
    'border:.5px solid rgba(127,127,127,.4);background:transparent;color:inherit}',
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
  var contextMenu = null
  var contexts = null
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
    // 齿轮放在最后：标题行的前两个子节点位置保持不变，旧代码/旧测试不用改。
    var gear = el('button', 'dsh-eta-btn')
    gear.type = 'button'
    gear.title = '外观设置'
    gear.textContent = '⚙'
    head.appendChild(title)
    head.appendChild(toggle)
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
      root: root, title: title, toggle: toggle, gear: gear, body: body,
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
      toggleCollapsed()
    })

    gear.addEventListener('click', function (event) {
      event.stopPropagation()
      togglePanel()
    })

    installDrag(root)
    installDoubleClickSettings(title)
    installContextMenu()
    applyAppearance()
    applyCollapsed()
    applyMenuHidden()
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
    updateHotspot()
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
    // 显示位置是宿主级设置，每次打开面板都问一次（别人可能刚在别处改过）。
    refreshDisplayMode()
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

    /* --- 界面 --- */
    var uiGroup = el('div', 'dsh-eta-group')
    var menuRow = el('div', 'dsh-eta-row')
    var menuLabel = el('label', '', '隐藏菜单按钮')
    menuLabel.title = '打开后标题行的按钮全部隐藏，右键卡片唤出菜单'
    var menuToggle = el('input')
    menuToggle.type = 'checkbox'
    menuToggle.className = 'dsh-eta-check'
    menuToggle.addEventListener('change', function () {
      appearance.menuHidden = menuToggle.checked === true
      applyMenuHidden()
      writeSettings({ menuHidden: appearance.menuHidden })
      setHint(
        appearance.menuHidden
          ? '按钮已隐藏，右键卡片可唤出菜单'
          : '按钮已恢复显示',
        'ok',
      )
    })
    menuRow.appendChild(menuLabel)
    menuRow.appendChild(menuToggle)
    uiGroup.appendChild(menuRow)

    /* --- 显示位置：仅网页 / 仅桌面 / 两者 / 都不 --- */
    var whereGroup = el('div', 'dsh-eta-group')
    var whereRow = el('div', 'dsh-eta-row')
    var whereLabel = el('label', '', '显示位置')
    whereLabel.title = '桌面 = 桌面上的浮窗；网页 = DSH 页面里的挂件'
    var whereSelect = el('select')
    whereSelect.className = 'dsh-eta-select'
    var WHERE_OPTIONS = [
      { value: 'web', label: '仅网页' },
      { value: 'desktop', label: '仅桌面' },
      { value: 'both', label: '两者' },
      { value: 'none', label: '都不' },
    ]
    for (var wi = 0; wi < WHERE_OPTIONS.length; wi++) {
      var option = el('option', '', WHERE_OPTIONS[wi].label)
      option.value = WHERE_OPTIONS[wi].value
      whereSelect.appendChild(option)
    }
    whereSelect.addEventListener('change', function () {
      setDisplayMode(whereSelect.value)
    })
    whereRow.appendChild(whereLabel)
    whereRow.appendChild(whereSelect)
    whereGroup.appendChild(whereRow)
    var whereHint = el('div', 'dsh-eta-hint', '')
    whereHint.setAttribute('data-role', 'display-hint')
    whereGroup.appendChild(whereHint)

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
    root.appendChild(uiGroup)
    root.appendChild(whereGroup)
    root.appendChild(resetGroup)
    root.appendChild(hint)
    document.body.appendChild(root)

    panel = root
    panelNodes = {
      zoom: zoomRow, blur: blurRow, dim: dimRow, alpha: alphaRow,
      urlInput: urlInput, fileInput: fileInput, hint: hint, menuToggle: menuToggle,
      whereSelect: whereSelect, whereHint: whereHint,
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
    if (panelNodes.menuToggle) panelNodes.menuToggle.checked = appearance.menuHidden === true
    if (panelNodes.whereSelect && displayMode) panelNodes.whereSelect.value = displayMode
  }

  /* ---------- 显示位置（web / desktop / both / none） ---------- */

  /** 当前显示位置。'both' 是默认值，与宿主的默认一致。 */
  var displayMode = 'both'

  /**
   * 拉一次配置并同步到设置面板。
   *
   * 为什么不从这个值推 UI 而是每次去问：显示位置是**宿主级**设置（桌面窗口也读它），
   * 存在宿主内存里而不是浏览器 localStorage —— 换浏览器也该一致。
   */
  function refreshDisplayMode() {
    return window.fetch(absoluteUrl(CONFIG_URL), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        if (!payload || !payload.ok) return
        displayMode = String(payload.display || displayMode)
        if (panelNodes && panelNodes.whereSelect) panelNodes.whereSelect.value = displayMode
        if (panelNodes && panelNodes.whereHint) {
          var extra = payload.desktopRunning ? '（桌面浮窗运行中）' : ''
          if (payload.error) {
            panelNodes.whereHint.textContent = payload.error
            panelNodes.whereHint.setAttribute('data-tone', 'warn')
          } else {
            panelNodes.whereHint.textContent = extra
            panelNodes.whereHint.removeAttribute('data-tone')
          }
        }
      })
      .catch(function () {
        /* 拿不到配置就保持现状：这个面板不该因为配置接口抽风而坏掉 */
      })
  }

  /**
   * 改显示位置。
   *
   * 写接口只在回环放行（见宿主侧 isLoopback）。这里失败要**说清楚原因**，
   * 不能静默 —— 用户点了「仅桌面」却没反应，会以为功能坏了。
   */
  function setDisplayMode(next) {
    var value = String(next || '')
    if (['web', 'desktop', 'both', 'none'].indexOf(value) === -1) return
    window.fetch(absoluteUrl(CONFIG_URL), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display: value }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload }
        })
      })
      .then(function (result) {
        if (result.status === 200 && result.payload && result.payload.ok) {
          displayMode = String(result.payload.display || value)
          if (IS_DESKTOP) {
            // 桌面浮窗里改完，自己可能就该关掉了（切到 web/none）。
            // 宿主会停掉窗口，这里只给个提示，不跟它抢关闭权。
            setHint('已切到「' + labelOfMode(displayMode) + '」', 'ok')
          } else {
            // 网页端：切到不含 web 的模式时，把自己藏起来（刷新后注入也会消失）。
            applyLocalDisplayMode(displayMode)
            setHint('已切到「' + labelOfMode(displayMode) + '」', 'ok')
          }
          refreshDisplayMode()
          return
        }
        var message = (result.payload && result.payload.error) || ('HTTP ' + result.status)
        setHint('改显示位置失败：' + message, 'warn')
      })
      .catch(function (error) {
        setHint('改显示位置失败：' + (error && error.message ? error.message : String(error)), 'warn')
      })
  }

  function labelOfMode(mode) {
    if (mode === 'web') return '仅网页'
    if (mode === 'desktop') return '仅桌面'
    if (mode === 'both') return '两者'
    if (mode === 'none') return '都不'
    return String(mode)
  }

  /** 网页端本地应用显示位置（桌面窗口由宿主负责启停）。 */
  function applyLocalDisplayMode(mode) {
    if (IS_DESKTOP || !nodes) return
    var shouldShow = mode === 'web' || mode === 'both'
    if (shouldShow) nodes.root.removeAttribute('data-display-off')
    else {
      nodes.root.setAttribute('data-display-off', '1')
      hidePanel()
      hideContextMenu()
    }
  }

  function resetAll() {
    appearance = {
      zoom: DEFAULTS.zoom,
      blur: DEFAULTS.blur,
      dim: DEFAULTS.dim,
      cardAlpha: DEFAULTS.cardAlpha,
      menuHidden: DEFAULTS.menuHidden,
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
      menuHidden: DEFAULTS.menuHidden,
      left: null,
      top: null,
      collapsed: false,
    })
    collapsed = false
    appearance.menuHidden = DEFAULTS.menuHidden
    applyCollapsed()
    applyMenuHidden()
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

  /* ---------- 小尺寸下的逃生门 ---------- */

  /**
   * 缩到 25% 时卡片只有 59px 宽，齿轮按钮的命中区约 4.5px —— 点不到。
   * 用户会把自己锁在一个点不开设置的小卡片里，唯一的出路是手改 localStorage。
   * 所以：缩放小于 60% 时，在卡片旁边贴一块 44px 的透明热区，双击打开设置。
   * 它是 fixed 定位、不参与缩放，所以 25% 时依然好点。
   */
  function updateHotspot() {
    if (!nodes) return
    var needHotspot = appearance.zoom < 60
    if (!needHotspot) {
      if (nodes.hotspot && nodes.hotspot.parentNode) {
        nodes.hotspot.parentNode.removeChild(nodes.hotspot)
      }
      nodes.hotspot = null
      return
    }
    if (!nodes.hotspot) {
      var spot = el('div', 'dsh-eta-hotspot')
      // 单例元素给个 id，和 root / panel 一致：调试和测试都能直接定位。
      spot.id = 'dsh-eta-hotspot'
      spot.title = '双击打开外观设置'
      spot.addEventListener('dblclick', function (event) {
        event.stopPropagation()
        showPanel()
      })
      document.body.appendChild(spot)
      nodes.hotspot = spot
    }
    var rect = nodes.root.getBoundingClientRect()
    var size = 44
    // 贴在卡片右下角外侧：不盖住卡片本体，也不会被缩放影响大小。
    nodes.hotspot.style.width = size + 'px'
    nodes.hotspot.style.height = size + 'px'
    nodes.hotspot.style.left = Math.round(rect.left + rect.width - size / 2) + 'px'
    nodes.hotspot.style.top = Math.round(rect.top + rect.height - size / 2) + 'px'
  }

  /* ---------- 右键菜单（「隐藏菜单按钮」后的唯一入口） ---------- */

  /**
   * 右键唤出的小菜单。
   *
   * 为什么用自绘而不是 `window` 上的原生菜单：这是页面里的挂件，没有原生菜单可用；
   * 而且自绘才能跟着卡片的缩放/位置走，25% 时也不会跑出屏幕。
   *
   * 菜单挂在 body 上（和设置面板一样）—— 挂在 root 里会跟着 transform 一起缩，
   * 25% 时字只有 3px，点不中。
   */
  function buildContextMenu() {
    if (contextMenu) return contextMenu
    var menu = el('div', 'dsh-eta-ctxmenu')
    menu.id = CONTEXT_MENU_ID
    menu.setAttribute('data-hidden', '1')

    // 注意：这里没有「隐藏挂件」。那个功能已经按用户要求删掉了 ——
    // 隐藏后只能靠双击热区找回，既难发现又容易把自己锁在外面；
    // 现在想让它不碍事，收起（只剩标题行）或者直接拖到角落即可。
    var items = [
      { label: '收起 / 展开', run: function () { toggleCollapsed() } },
      { label: '外观设置', run: function () { showPanel() } },
      { label: '回到右下角', run: function () { resetPosition() } },
    ]
    contexts = items.map(function (item) {
      var button = el('button', 'dsh-eta-ctxitem', item.label)
      button.type = 'button'
      button.addEventListener('click', function (event) {
        event.stopPropagation()
        hideContextMenu()
        item.run()
      })
      menu.appendChild(button)
      return { node: button, label: item.label }
    })

    document.body.appendChild(menu)
    contextMenu = menu
    return menu
  }

  function showContextMenu(clientX, clientY) {
    var menu = buildContextMenu()
    if (!menu) return
    // 每打开一次就同步一次文案（收起/展开两个方向标签不同）。
    if (contexts && contexts[0]) {
      contexts[0].node.textContent = collapsed ? '展开' : '收起'
    }
    menu.removeAttribute('data-hidden')
    var rect = menu.getBoundingClientRect()
    var width = rect.width || 120
    var height = rect.height || 108
    var left = Math.max(4, Math.min(window.innerWidth - width - 4, clientX))
    var top = Math.max(4, Math.min(window.innerHeight - height - 4, clientY))
    menu.style.left = Math.round(left) + 'px'
    menu.style.top = Math.round(top) + 'px'
  }

  function hideContextMenu() {
    if (!contextMenu) return
    contextMenu.setAttribute('data-hidden', '1')
  }

  /**
   * 右键菜单的「右键」入口。
   *
   * 注意：真正的触发在拖动的 pointerup 里（右键原地松开 = 菜单），这里只负责
   * 吞掉浏览器自带的上下文菜单，避免「拖动时弹出系统菜单」。
   */
  function installContextMenu() {
    nodes.root.addEventListener('contextmenu', function (event) {
      event.preventDefault()
      event.stopPropagation()
    })
    // 点别处 / 按 Esc 收起来。捕获阶段监听，免得被其它插件的 stopPropagation 吃掉。
    document.addEventListener('pointerdown', function (event) {
      if (!contextMenu || contextMenu.getAttribute('data-hidden') === '1') return
      var target = event.target
      if (target && contextMenu.contains && contextMenu.contains(target)) return
      hideContextMenu()
    }, true)
    document.addEventListener('keydown', function (event) {
      if (!event || event.key !== 'Escape') return
      hideContextMenu()
    }, true)
    window.addEventListener('resize', hideContextMenu)
    window.addEventListener('blur', hideContextMenu)
  }

  /** 收起/展开，按钮与右键菜单共用同一份逻辑。 */
  function toggleCollapsed() {
    collapsed = !collapsed
    applyCollapsed()
    writeSettings({ collapsed: collapsed })
  }

  /** 回到右下角默认位置（位置丢了或拖到看不见的地方时的兜底）。 */
  function resetPosition() {
    if (!nodes) return
    nodes.root.style.left = ''
    nodes.root.style.top = ''
    nodes.root.style.right = ''
    nodes.root.style.bottom = ''
    writeSettings({ left: null, top: null })
    requestAnimationFrame(function () {
      if (!nodes) return
      var rect = nodes.root.getBoundingClientRect()
      nodes.root.style.left = Math.max(0, window.innerWidth - rect.width - 16) + 'px'
      nodes.root.style.top = Math.max(0, window.innerHeight - rect.height - 16) + 'px'
      nodes.root.style.right = 'auto'
      nodes.root.style.bottom = 'auto'
      applyZoom(appearance.zoom, 'bottom-right')
    })
  }

  /** 应用「隐藏菜单按钮」：整组按钮显示/隐藏。 */
  function applyMenuHidden() {
    if (!nodes) return
    if (appearance.menuHidden) nodes.root.setAttribute('data-menu-hidden', '1')
    else nodes.root.removeAttribute('data-menu-hidden')
    if (appearance.menuHidden) hideContextMenu()
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

  /* ---------- 拖动（位置记住） ---------- */

  /**
   * 整张卡片都能拖：**左键按住**拖，或者**右键按住**拖。
   *
   * 右键在这里身兼两职，判定规则是「按下后有没有真的移动」：
   *   - 右键按下 → 移动超过阈值 → 拖动卡片；
   *   - 右键按下 → 原地松开   → 弹菜单。
   * 这样「整卡右键都能拖」和「右键唤出菜单」可以共存。如果直接让右键等同左键，
   * 按钮藏起来后就再也没有菜单入口了（那正是上一版刚修过的坑）。
   *
   * 左键仍然保留「按钮上不拖」的例外：点齿轮/收起不该顺手把卡片拖走。
   * 右键没有这个例外 —— 用户明确要求「所有地方都可以右键拖动」。
   */
  function installDrag(handle) {
    var startX = 0
    var startY = 0
    var originLeft = 0
    var originTop = 0
    var moved = false
    /** 本次按下是右键（松开时若没移动就弹菜单）。 */
    var fromRight = false
    var active = false
    var DRAG_THRESHOLD = 3

    handle.addEventListener('contextmenu', function (event) {
      // 拖动过程中不弹系统菜单；菜单由下面的 pointerup 分支负责。
      event.preventDefault()
      event.stopPropagation()
    })

    handle.addEventListener('pointerdown', function (event) {
      var isLeft = event.button === 0
      var isRight = event.button === 2
      if (!isLeft && !isRight) return
      // 左键点在按钮上时不开始拖动，否则点齿轮会顺手把卡片拖走。
      if (isLeft) {
        var target = event.target
        if (target && target.tagName === 'BUTTON') return
      }
      var rect = nodes.root.getBoundingClientRect()
      startX = event.clientX
      startY = event.clientY
      originLeft = rect.left
      originTop = rect.top
      moved = false
      fromRight = isRight
      active = true
      dragging = false
      nodes.root.setAttribute('data-dragging', '1')
      // 桌面窗口里拖的是**窗口**，不是元素：先告诉渲染壳"开始拖了"，
      // 并把可交互状态锁住（否则中途翻回穿透会收不到 pointerup）。
      if (IS_DESKTOP) {
        emitDesktop('dsh-eta-desktop-drag-start', {})
        emitDesktop('dsh-eta-desktop-busy', true)
      } else {
        // 拖动期间改为 left/top 定位，否则 right/bottom 会让坐标算反。
        nodes.root.style.left = originLeft + 'px'
        nodes.root.style.top = originTop + 'px'
        nodes.root.style.right = 'auto'
        nodes.root.style.bottom = 'auto'
      }
      if (isRight) hideContextMenu()
      try { handle.setPointerCapture(event.pointerId) } catch (err) { /* 忽略 */ }
    })

    handle.addEventListener('pointermove', function (event) {
      if (!active) return
      var dx = event.clientX - startX
      var dy = event.clientY - startY
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
        moved = true
        dragging = true
      }
      if (IS_DESKTOP) {
        // 桌面端：把位移交给壳换算成窗口坐标。
        emitDesktop('dsh-eta-desktop-move', { dx: dx, dy: dy })
        return
      }
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
      updateHotspot()
    })

    function finish(event, shouldOfferMenu) {
      if (!active) return
      var wasRight = fromRight
      var wasMoved = moved
      active = false
      dragging = false
      fromRight = false
      nodes.root.removeAttribute('data-dragging')
      try { handle.releasePointerCapture(event.pointerId) } catch (err) { /* 忽略 */ }
      if (IS_DESKTOP) emitDesktop('dsh-eta-desktop-busy', false)
      if (wasMoved) {
        if (!IS_DESKTOP) writeSettings({ left: nodes.root.offsetLeft, top: nodes.root.offsetTop })
        if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
        return
      }
      // 右键原地松开 = 唤出菜单（这是按钮藏起来后唯一的入口）。
      // 判据是「按的是右键」+「没移动」，与事件类型无关 —— 不要依赖 event.type。
      if (wasRight && shouldOfferMenu) {
        showContextMenu(event.clientX, event.clientY)
      }
    }

    handle.addEventListener('pointerup', function (event) {
      finish(event, true)
    })
    handle.addEventListener('pointercancel', function (event) {
      // 取消不当成「点击」：不弹菜单。
      finish(event, false)
    })
    // 右键的 pointerup 之后浏览器还会补一个 contextmenu，交给上面的 contextmenu
    // 监听统一吞掉（它已 preventDefault），所以这里不需要额外处理。

    // 桌面窗口里不恢复 left/top：窗口位置由壳控制，挂件永远贴窗口右下角。
    if (!IS_DESKTOP) {
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
    }

    window.addEventListener('resize', function () {
      if (!nodes) return
      if (IS_DESKTOP) return
      if (!nodes.root.style.left) return
      var rect = nodes.root.getBoundingClientRect()
      var width = rect.width || nodes.root.offsetWidth
      var height = rect.height || nodes.root.offsetHeight
      var left = Math.min(parseFloat(nodes.root.style.left) || 0, Math.max(0, window.innerWidth - width))
      var top = Math.min(parseFloat(nodes.root.style.top) || 0, Math.max(0, window.innerHeight - height))
      nodes.root.style.left = Math.max(0, left) + 'px'
      nodes.root.style.top = Math.max(0, top) + 'px'
      if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
      updateHotspot()
    })
  }


  /* ---------- 渲染 ---------- */

  function pickSession(payload) {
    if (!payload || !Array.isArray(payload.sessions) || payload.sessions.length === 0) return null
    return payload.sessions[0]
  }

  /**
   * 「显示位置」里的 web / both 才在网页里画。
   *
   * 宿主在「仅桌面」时已经不再注入脚本了，但已经打开的页面不会因此消失
   * （脚本早在页面加载时就跑起来了）。所以这里再按快照里的 display 兜一层，
   * 让用户切到「仅桌面」后网页里那个挂件自己藏起来。
   */
  function applyDisplayMode(payload) {
    if (IS_DESKTOP) return
    var mode = payload && typeof payload.display === 'string' ? payload.display : ''
    if (!mode) return
    var shouldShow = mode === 'web' || mode === 'both'
    if (!nodes) return
    if (shouldShow) {
      nodes.root.removeAttribute('data-display-off')
    } else {
      nodes.root.setAttribute('data-display-off', '1')
      hidePanel()
      hideContextMenu()
    }
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

    // 卡片高度会随文案变化，面板和小尺寸热区都得跟着它走。
    if (panel && panel.getAttribute('data-hidden') !== '1') positionPanel()
    updateHotspot()
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

    window.fetch(absoluteUrl(STATE_URL), options)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        failureCount = 0
        // 先按显示位置决定要不要露脸，再渲染内容。
        applyDisplayMode(payload)
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
    // 桌面浮窗里没有聊天输入区（那是独立的一个空页面），所以这条门槛要跳过：
    // 否则桌面端永远不会挂载 —— 表现就是「窗口开了但里面什么都没有」。
    if (!IS_DESKTOP) {
      try {
        if (!isChatRoot(document.getElementById('root'))) return false
      } catch (err) {
        return false
      }
    }
    started = true
    try { start() } catch (err) {
      started = false
      // 用 console.log 而不是 console.warn：桌面渲染壳只转发 console.log
      // （见 runtime/electron-helper/main.js 的 console-message）。
      // 挂载失败在透明窗口里就是「什么都没有」，必须留下线索。
      try { console.log('[dsh-eta] 挂载失败：' + ((err && err.stack) || String(err))) } catch (inner) { /* 忽略 */ }
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
