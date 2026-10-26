/**
 * dsh-eta-forecast — 桌面窗口 helper（Electron 主进程）
 *
 * 只在「显示位置」含 desktop 时由宿主拉起。职责很窄：
 *   开一个**无边框、透明、置顶、不进任务栏**的小窗口，里面加载 index.html，
 *   由 index.html 自己轮询 `/dsh-eta/state.json` 并把挂件画出来。
 *
 * 为什么不在宿主里直接画：DSH 的 webServer 只服务浏览器页面，桌面浮窗必须由
 * Electron 起一个真实窗口。Electron 运行时复用 dsh-pet 已经下载好的那份
 * （$DSH_HOME/electron），不再重复下载 300MB。
 *
 * 三条被踩出来的约束（照抄 dsh-pet 的结论，不是猜的）：
 *   1. **不做全屏透明画布**。透明置顶 + 非穿透 + 已聚焦 + 完整盖住视频窗 四项齐备时，
 *      Windows DWM 会让播放中的视频黑屏。小窗口几乎不可能完整遮挡视频窗，天然规避。
 *   2. **默认整窗点击穿透**（setIgnoreMouseEvents(true, {forward:true})），渲染端在光标
 *      进入挂件矩形时经 IPC 翻转可交互。否则一个置顶透明窗会把下层应用全挡住。
 *   3. **宿主没了就自己退**。stdout/stderr 是宿主给的管道，宿主一退下一次写就是 EPIPE，
 *      而 Electron 默认处理器只弹框不退出。所以有「宿主存活」轮询 + 管道守卫。
 */

'use strict'

let electronApi
try {
  electronApi = require('electron')
} catch (error) {
  // 被以纯 Node 模式拉起（透传了 ELECTRON_RUN_AS_NODE）时 electron 模块不会注册。
  process.stderr.write(
    '[dsh-eta helper] 启动失败：本进程被以「纯 Node 模式」拉起'
    + '（ELECTRON_RUN_AS_NODE=' + JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) + '）。'
    + '该变量必须在 spawn 前删除。原始错误：'
    + (error instanceof Error ? error.message.split('\n')[0] : String(error)) + '\n',
  )
  process.exit(3)
}

const { app, BrowserWindow, ipcMain, screen } = electronApi
const path = require('node:path')

/** 宿主注入的环境变量。 */
const STATE_URL = process.env.DSH_ETA_STATE_URL || 'http://127.0.0.1:3080/dsh-eta/state.json'
const HOST_PID = Number.parseInt(String(process.env.DSH_ETA_HOST_PID || ''), 10) || 0
const WIN_W = Number.parseInt(String(process.env.DSH_ETA_WIN_W || ''), 10) || 300
const WIN_H = Number.parseInt(String(process.env.DSH_ETA_WIN_H || ''), 10) || 210
const CROSS_ORIGIN = process.env.DSH_ETA_ALLOW_ORIGIN || ''

/** 宿主存活探测间隔：宿主没了最多 2s 收敛。 */
const HOST_POLL_MS = 2000

let win = null
let hostTimer = null
/** 当前是否整窗穿透（true = 穿透，不挡下层应用）。 */
let ignoring = true
/** 拖动中：渲染端持续捕获指针，主进程绝不能翻回穿透，否则 pointermove/pointerup 会断。 */
let inputBusy = false

/**
 * 宿主进程是否**确定**已经不在了。
 *
 * 只有 ESRCH 才判「没了」：EPERM 说明进程还在（只是不归我们管），pid 读到 0 也不动。
 * 这条判定必须「宁可不退」——误退会把用户正看着的窗口关掉。
 */
function hostIsGone() {
  if (!(HOST_PID > 0)) return false
  try {
    process.kill(HOST_PID, 0)
    return false
  } catch (error) {
    return Boolean(error) && error.code === 'ESRCH'
  }
}

function quitSelf() {
  try { app.quit() } catch (error) { process.exit(0) }
}

/** 管道守卫：宿主退出后下一次写 stdout 会 EPIPE，那是「读端没了 = 宿主已死」。 */
function guardPipes() {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || typeof stream.on !== 'function') continue
    stream.on('error', (error) => {
      const code = error && error.code
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') quitSelf()
    })
  }
}

/** 翻转整窗穿透。所有 setIgnoreMouseEvents 只走这里，避免两处状态打架。 */
function setWindowIgnore(next) {
  if (!win || win.isDestroyed()) return
  const value = next === true
  if (value === ignoring) return
  ignoring = value
  try {
    win.setIgnoreMouseEvents(value, { forward: true })
  } catch (error) {
    /* 少数平台不支持 forward，退化成纯穿透 */
    try { win.setIgnoreMouseEvents(value) } catch (inner) { /* 忽略 */ }
  }
}

/** 把窗口夹进当前显示器工作区（位置记在渲染端，主进程只负责不越界）。 */
function clampToWorkArea(x, y, w, h) {
  const display = screen.getDisplayNearestPoint({ x, y })
  const area = display.workArea
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - w, x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - h, y))),
    width: Math.round(w),
    height: Math.round(h),
  }
}

function createWindow() {
  // 初始位置：主屏右下角（与网页端一致的锚点）。
  const area = screen.getPrimaryDisplay().workArea
  const start = clampToWorkArea(
    area.x + area.width - WIN_W - 16,
    area.y + area.height - WIN_H - 16,
    WIN_W,
    WIN_H,
  )

  win = new BrowserWindow({
    width: start.width,
    height: start.height,
    x: start.x,
    y: start.y,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 可聚焦：设置面板里的输入框（壁纸链接）需要焦点才能打字。
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 被其它置顶窗遮挡时 Chromium 默认暂停渲染，会导致挂件「看不见但活着」。
  win.webContents.setBackgroundThrottling(false)
  // 屏蔽 Electron 默认右键菜单：右键是拖动/应用菜单，见 index.html。
  win.webContents.on('context-menu', (event) => event.preventDefault())

  // 渲染端的报错打到 stderr：窗口是透明的，出问题时用户只看到"什么都没有"，
  // 没有这条转发就只能靠猜（CSP 拦截内联脚本就是这么被找到的）。
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    try {
      process.stderr.write('[renderer] ' + String(message)
        + ' (' + String(sourceId || '') + ':' + String(line || 0) + ')\n')
    } catch (err) { /* 管道断了就让存活守卫处理 */ }
  })
  win.webContents.on('render-process-gone', (event, details) => {
    try { process.stderr.write('[renderer gone] ' + JSON.stringify(details) + '\n') } catch (err) { /* 忽略 */ }
  })
  win.webContents.on('did-fail-load', (event, code, desc, url) => {
    try { process.stderr.write('[load failed] ' + code + ' ' + desc + ' ' + url + '\n') } catch (err) { /* 忽略 */ }
  })

  // 默认整窗穿透，渲染端在命中区翻转。
  setWindowIgnore(true)

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.showInactive()
  })
  // 兜底显示：paintWhenInitiallyHidden / 首帧异常时 ready-to-show 可能不触发。
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive()
    }, 400)
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  win.on('closed', () => { win = null })
}

/* ---------- IPC：渲染端 → 主进程 ---------- */

// 命中断言：光标进/出挂件矩形时翻转穿透。
ipcMain.on('eta:set-interactive', (event, interactive) => {
  if (inputBusy && !interactive) return
  setWindowIgnore(!interactive)
})

// 拖动/菜单期间锁住可交互状态。
ipcMain.on('eta:input-busy', (event, busy) => {
  inputBusy = busy === true
  if (inputBusy) setWindowIgnore(false)
})

// 窗口跟随拖动（渲染端把目标屏幕坐标发上来）。
//
// 落点还要夹进当前显示器工作区，所以**结果要以回报为准**：把实际生效的 bounds
// 发回渲染端，它据此更新「窗口当前位置」。少了这一步，渲染端只能记住自己请求的值，
// 一旦被夹取，下一次拖动的基准就是错的（表现为拖到屏幕边缘后再拖会跳）。
ipcMain.on('eta:set-bounds', (event, payload) => {
  if (!win || win.isDestroyed() || !payload) return
  const x = Number(payload.x)
  const y = Number(payload.y)
  const w = Number(payload.width) || WIN_W
  const h = Number(payload.height) || WIN_H
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const applied = clampToWorkArea(x, y, w, h)
  try {
    win.setBounds(applied)
  } catch (error) {
    return // 越界/正在关闭时忽略，也不回报
  }
  try {
    event.sender.send('eta:bounds', applied)
  } catch (error) { /* 窗口正在销毁，忽略 */ }
})

// 渲染端想知道工作区，用于把卡片夹在屏幕内。
ipcMain.handle('eta:get-work-area', () => {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  return { x: area.x, y: area.y, width: area.width, height: area.height }
})

/** 允许访问的源：本地 HTTP + 宿主明确放行的源（跨源只在回环下才需要）。 */
ipcMain.handle('eta:get-config', () => ({
  stateUrl: STATE_URL,
  allowOrigin: CROSS_ORIGIN,
}))

/* ---------- 生命周期 ---------- */

/**
 * 单实例锁：避免叠出两个挂件。
 *
 * 但**拿不到锁不等于该默默退出**：如果占着锁的那个实例是上一次崩溃残留的僵尸
 * （进程还在、窗口早没了），新进程直接退出就会变成「宿主反复重启 helper、
 * helper 反复秒退」的死循环 —— 表现就是桌面浮窗永远不出现。
 * 所以拿不到锁时把原因写清楚，宿主侧的退避重试会兜住。
 */
if (!app.requestSingleInstanceLock()) {
  try {
    process.stderr.write('[dsh-eta helper] 已有实例持有单实例锁，本进程退出\n')
  } catch (err) { /* 忽略 */ }
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive()
  })

  guardPipes()

  /** 窗口是否已经真正创建过（用于区分「还没建」和「建完又被关了」）。 */
  let everCreated = false

  app.whenReady().then(() => {
    createWindow()
    everCreated = true
    if (HOST_PID > 0) {
      hostTimer = setInterval(() => {
        if (hostIsGone()) quitSelf()
      }, HOST_POLL_MS)
      hostTimer.unref?.()
    }
    app.on('activate', () => {
      if (!win || win.isDestroyed()) {
        createWindow()
        everCreated = true
      }
    })
  })

  /**
   * 关掉所有窗口就退：这个 helper 只为那一个窗口活着。
   *
   * 必须加 everCreated 判断 —— Electron 启动早期内部也会关掉一些临时 webContents，
   * 在窗口还没建出来时就触发 window-all-closed，导致进程**秒退**，
   * 然后被宿主当成「崩溃」反复重启。那是查了很久才定位到的死循环。
   */
  app.on('window-all-closed', () => {
    if (!everCreated) return
    quitSelf()
  })

  app.on('before-quit', () => {
    if (hostTimer) { clearInterval(hostTimer); hostTimer = null }
  })
}
