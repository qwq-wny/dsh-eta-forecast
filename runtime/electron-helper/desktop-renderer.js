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

/** 窗口内容尺寸：挂件最大 236px 宽，加上设置面板可能弹出的空间。 */
const WIN_W = 300
const WIN_H = 210

/** 挂件在窗口内的留白（挂件靠右下角摆放，设置面板从左上弹出）。 */
const PAD = 12

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

  const width = Math.min(WIN_W, area.width)
  const height = Math.min(WIN_H, area.height)
  const x = area.x + area.width - width
  const y = area.y + area.height - height
  bridge.setBounds(x, y, width, height)

  /* ---------- 点击穿透：只有光标在挂件上时才可交互 ---------- */

  let interactive = false
  let busy = false

  function hitTest(clientX, clientY) {
    const root = document.getElementById('dsh-eta-root')
    if (!root) return null
    const rect = root.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
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

  // 拖动：客户端脚本不改 left/top，而是把目标屏幕坐标发上来。
  // 它通过 dispatchEvent 把位移交给我们换算成窗口坐标。
  window.addEventListener('dsh-eta-desktop-move', (event) => {
    const detail = (event && event.detail) || {}
    const dx = Number(detail.dx)
    const dy = Number(detail.dy)
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    const nextX = Math.max(area.x, Math.min(area.x + area.width - width, baseX + dx))
    const nextY = Math.max(area.y, Math.min(area.y + area.height - height, baseY + dy))
    bridge.setBounds(Math.round(nextX), Math.round(nextY), width, height)
  })

  let baseX = x
  let baseY = y
  window.addEventListener('dsh-eta-desktop-drag-start', () => {
    baseX = x
    baseY = y
  })
}

main().catch((error) => {
  showError(error && error.message ? error.message : String(error))
})
