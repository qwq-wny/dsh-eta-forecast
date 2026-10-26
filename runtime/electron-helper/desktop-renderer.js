/**
 * dsh-eta-forecast — 桌面窗口渲染端
 *
 * 复用**同一份** assets/eta-client.js 画挂件，不在桌面端重写一套 UI。
 * 这里只做桌面特有的事：
 *   1. 从宿主路由取客户端脚本并执行（file:// 下不能直接用 ESM/裸 fetch 拉跨源）。
 *   2. 把窗口尺寸适配到挂件实际大小（窗口比挂件大一圈，留出设置面板的位置）。
 *   3. 光标进/出挂件矩形时翻转整窗点击穿透 —— 否则一个置顶透明窗会挡死下层应用。
 *   4. 拖动：桌面端的拖动要移动**整个窗口**，不是改 DOM 的 left/top。
 *
 * 第 4 点是最容易做错的地方：网页端拖的是元素，桌面端拖的是窗口。所以这里
 * 通过 CSS 变量 `--dsh-eta-desktop` 告诉客户端脚本「你在桌面窗口里」，客户端
 * 脚本据此把拖动交给 etaBridge.setBounds。
 */

'use strict'

const errorEl = document.getElementById('dsh-eta-desktop-error')

/**
 * 调试追踪。
 *
 * 窗口是透明的：出错时用户只看到「什么都没有」，光靠肉眼没法定位。
 * 关键节点打到 console —— 主进程的 console-message 会转发到 stderr。
 */
function trace(step, extra) {
  try {
    console.log('[dsh-eta-renderer] ' + step + (extra === undefined ? '' : ' ' + JSON.stringify(extra)))
  } catch (err) { /* 忽略 */ }
}

function showError(message) {
  trace('ERROR ' + message)
  if (!errorEl) return
  errorEl.textContent = 'ETA 桌面挂件：' + message
  errorEl.setAttribute('data-on', '1')
}

function hideError() {
  if (!errorEl) return
  errorEl.removeAttribute('data-on')
  errorEl.textContent = ''
}

/** 窗口内容尺寸的兜底值（真实值由 geometry.windowSizeFor 按内容算出来）。 */
const FALLBACK_W = 320
const FALLBACK_H = 560

/** 挂件在窗口内的留白（挂件贴右下角，设置面板从上方弹出）。 */
const PAD = 16
/** 卡片与设置面板之间的间隙（必须与 assets/eta-client.js 的 positionPanel 一致）。 */
const PANEL_GAP = 8

/** 几何计算：纯函数，另有单测（test/geometry.test.js）。 */
const geometry = window.DshEtaGeometry || {
  moveWindow: (input) => ({
    x: Math.round(input.baseX + input.dx),
    y: Math.round(input.baseY + input.dy),
    width: input.width,
    height: input.height,
  }),
  hitTestPoint: () => false,
  windowSizeFor: () => ({ width: FALLBACK_W, height: FALLBACK_H }),
}

async function main() {
  trace('boot', { href: location.href, hasBridge: Boolean(window.etaBridge) })
  const bridge = window.etaBridge
  if (!bridge) {
    showError('preload 未加载，无法与窗口通信')
    return
  }

  let config
  try {
    config = await bridge.getConfig()
  } catch (error) {
    showError('拿不到宿主配置：' + (error && error.message ? error.message : String(error)))
    return
  }

  const stateUrl = config && config.stateUrl
  trace('config', { stateUrl: stateUrl || null })
  if (!stateUrl) {
    showError('宿主没有提供快照地址')
    return
  }

  // 桌面端标记：客户端脚本据此走「拖动窗口」而不是「拖动元素」的分支。
  document.documentElement.setAttribute('data-dsh-eta-desktop', '1')
  document.documentElement.style.setProperty('--dsh-eta-desktop', '1')

  // 把宿主 origin 交给客户端脚本：桌面页面是 file://，相对路径 `/dsh-eta/...`
  // 会被解析成 file:///C:/dsh-eta/... —— 既打不到宿主，也被 CSP 拦掉。
  // 客户端脚本用这个 base 拼绝对地址（见 assets/eta-client.js 的 absoluteUrl）。
  try {
    window.__dshEtaBaseUrl = new URL(stateUrl).origin
  } catch (error) {
    window.__dshEtaBaseUrl = ''
  }
  trace('base url', { base: window.__dshEtaBaseUrl })

  // 客户端脚本从宿主路由取。
  //
  // 用 `<script src>` 而不是「取文本再 textContent 塞进去」：CSP 的 script-src 没开
  // 'unsafe-inline'，内联脚本会被**静默拦掉**（不报错、页面空白，极难查）。
  // 走 src 才是被 CSP 允许的加载方式，缓存与错误上报也都正常。
  const scriptUrl = stateUrl.replace(/\/state\.json(\?.*)?$/, '/eta.js')
  trace('loading client', { scriptUrl })
  try {
    await new Promise((resolve, reject) => {
      const tag = document.createElement('script')
      tag.src = scriptUrl
      tag.onload = () => resolve()
      tag.onerror = () => reject(new Error('加载失败：' + scriptUrl))
      document.body.appendChild(tag)
    })
    hideError()
    trace('client loaded', { mounted: Boolean(document.getElementById('dsh-eta-root')) })
    // 客户端脚本的挂载是异步的（要等主聊天界面 / 桌面模式下直接挂）。
    // 这里再确认一次，把「脚本执行了但没画出来」这种情况暴露出来。
    await new Promise((resolve) => setTimeout(resolve, 600))
    const root = document.getElementById('dsh-eta-root')
    trace('mount check', {
      mounted: Boolean(root),
      rect: root ? { w: root.offsetWidth, h: root.offsetHeight } : null,
      bodyChildren: document.body.children.length,
    })
    if (!root) showError('客户端脚本已加载但没有挂出挂件（见 stderr）')
  } catch (error) {
    showError('加载客户端脚本失败：' + (error && error.message ? error.message : String(error)))
    return
  }

  /** 把窗口尺寸/位置同步到挂件的实际大小（挂件是 fixed 定位，自己会贴右下角）。 */
  const work = await bridge.getWorkArea().catch(() => null)
  const area = work && work.width > 0 ? work : { x: 0, y: 0, width: 1280, height: 800 }

  const rootEl = document.getElementById('dsh-eta-root')
  const cardRect = rootEl ? rootEl.getBoundingClientRect() : null

  /** 卡片尺寸：面板开关时用它算窗口该多大。 */
  const cardW = Math.round((cardRect && cardRect.width) || 236)
  const cardH = Math.round((cardRect && cardRect.height) || 170)

  /**
   * 按「卡片 + 面板（可选）」算出窗口要多大。
   *
   * 面板是首次打开才创建的，插件启动时量不到它，所以启动先按默认值开窗，
   * 面板一打开就由 `dsh-eta-desktop-fit` 带着真实尺寸重算一次 ——
   * 早先固定 300×210，面板开出来只看得见一半。
   */
  function boundsFor(panel) {
    const size = geometry.windowSizeFor({
      area,
      cardW,
      cardH,
      panelW: (panel && panel.panelWidth) || 252,
      panelH: (panel && panel.panelHeight) || 320,
      edge: PAD,
      gap: PANEL_GAP,
    })
    const width = Math.max(1, Math.min(size.width, area.width))
    const height = Math.max(1, Math.min(size.height, area.height))
    return {
      width,
      height,
      // 向右下角锚定：卡片贴窗口右下，所以窗口变高只是向上多出一块透明区域，
      // 卡片在屏幕上的位置不变。
      x: area.x + area.width - width,
      y: area.y + area.height - height,
    }
  }

  const initial = boundsFor(null)
  trace('window size', { width: initial.width, height: initial.height })
  const width = initial.width
  const height = initial.height
  const x = initial.x
  const y = initial.y

  /**
   * 窗口**当前**位置。拖动时用「当前值 + 本次位移」，而不是每次回到初始值 ——
   * 否则第二次拖动会跳回原位。落点以主进程回报的 eta:bounds 为准（它还要夹进工作区）。
   */
  let curX = x
  let curY = y
  let curW = width
  let curH = height

  if (typeof bridge.onBounds === 'function') {
    bridge.onBounds((bounds) => {
      if (!bounds) return
      if (Number.isFinite(bounds.x)) curX = bounds.x
      if (Number.isFinite(bounds.y)) curY = bounds.y
      if (Number.isFinite(bounds.width)) curW = bounds.width
      if (Number.isFinite(bounds.height)) curH = bounds.height
    })
  }

  bridge.setBounds(x, y, width, height)

  /* ---------- 点击穿透：只有光标在挂件（或设置面板）上时才可交互 ---------- */

  let interactive = false
  let busy = false

  /**
   * 可交互区域 = 卡片 + （打开着的）设置面板。
   *
   * 早先只算卡片，于是面板一打开，光标移上去就被判成「不在挂件上」→
   * 整窗翻回点击穿透 → **面板点不动**。桌面端的设置面板从来没法用，就是这个原因。
   */
  function hitTest(clientX, clientY) {
    const card = document.getElementById('dsh-eta-root')
    const panel = document.getElementById('dsh-eta-panel')
    const panelOpen = panel && panel.getAttribute('data-hidden') !== '1'
    return geometry.hitTestPoint({
      card: card ? card.getBoundingClientRect() : null,
      panel: panelOpen ? panel.getBoundingClientRect() : null,
    }, clientX, clientY)
  }

  function updateInteractive(clientX, clientY) {
    if (busy) return
    const inside = hitTest(clientX, clientY) === true
    if (inside === interactive) return
    interactive = inside
    bridge.setInteractive(inside)
  }

  document.addEventListener('mousemove', (event) => {
    updateInteractive(event.clientX, event.clientY)
  }, { passive: true })

  // 指针离开窗口：放回穿透，别把下层应用锁死。
  document.addEventListener('mouseleave', () => {
    if (busy) return
    interactive = false
    bridge.setInteractive(false)
  })

  // 拖动/菜单期间告诉主进程「别翻回穿透」，否则 pointerup 收不到。
  // 客户端脚本在拖动开始/结束时派发这两个事件。
  window.addEventListener('dsh-eta-desktop-busy', (event) => {
    busy = !!(event && event.detail)
    bridge.setInputBusy(busy)
    if (busy) {
      interactive = true
      bridge.setInteractive(true)
    }
  })

  // 拖动：客户端脚本不改 left/top，而是把**屏幕坐标**位移发上来，
  // 这里换算成窗口位置。位移是相对按下点的累计值（见 assets/eta-client.js 的 startScreenX）。
  //
  // 关键是基准取 `curX/curY`（窗口当前位置）而不是初始位置 ——
  // 否则拖完一次再拖，窗口会先跳回原位。
  let baseX = x
  let baseY = y

  window.addEventListener('dsh-eta-desktop-drag-start', () => {
    baseX = curX
    baseY = curY
    trace('drag start', { baseX, baseY })
  })

  window.addEventListener('dsh-eta-desktop-move', (event) => {
    const detail = (event && event.detail) || {}
    const dx = Number(detail.dx)
    const dy = Number(detail.dy)
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const next = geometry.moveWindow({
      baseX, baseY, dx, dy, width: curW, height: curH, area,
    })
    bridge.setBounds(next.x, next.y, next.width, next.height)
  })

  /**
   * 设置面板开/关时重算窗口大小。
   *
   * 面板是首次打开才创建的，插件启动时量不到它，所以不能只在启动时定尺寸
   * （早先固定 300×210，面板开出来只看得见一半）。
   *
   * 尺寸变化要**锚住右下角**：卡片贴在窗口右下，只有保持右边缘与下边缘不动，
   * 卡片在屏幕上的位置才不会跟着窗口一起跳。
   */
  window.addEventListener('dsh-eta-desktop-fit', (event) => {
    const detail = (event && event.detail) || {}
    const want = boundsFor(detail.open ? detail : null)
    if (want.width === curW && want.height === curH) return
    const next = geometry.resizeAnchored({
      curX, curY, curW, curH,
      width: want.width,
      height: want.height,
      area,
    })
    trace('fit', { open: Boolean(detail.open), ...next })
    bridge.setBounds(next.x, next.y, next.width, next.height)
  })
}

main().catch((error) => {
  showError(error && error.message ? error.message : String(error))
})
