/**
 * dsh-eta-forecast — 桌面窗口的启停管理（宿主侧）
 *
 * 「显示位置」三选一（web / desktop / both / none）里只要含 desktop，
 * 就拉一个 Electron helper 起来开浮窗；切走或卸载时把它关掉。
 *
 * 三条设计约束（都是被 dsh-pet 踩过之后写下来的，不是我发明的）：
 *
 * 1. **Electron 运行时复用现成的那份**（$DSH_HOME/electron）。dsh-pet 已经下载过
 *    300MB+，再下一个既慢又占地方。找不到时**不自动下载**——下载 300MB 是个
 *    用户没同意的重操作，改为明确报错，让用户自己决定装不装。
 *
 * 2. **spawn 前必须删掉 ELECTRON_RUN_AS_NODE**。DSH 桌面宿主自己是靠这个变量
 *    以纯 Node 模式跑的（见 dsh.cmd）；子进程继承到它就成了 node 模式，
 *    Electron 模块不注册，helper 起不来还只报一句 MODULE_NOT_FOUND。
 *
 * 3. **helper 的单实例锁**：重复拉起时第二个实例会自己退出，不会叠出两个挂件。
 *
 * @module dsh-eta-forecast/desktop
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 宿主存活探测靠这个 PID；helper 每 2s 检查一次，宿主没了就自己退。 */
const HOST_POLL_MS = 2000
/** 连续崩溃多少次后放弃重启（避免死循环刷日志）。 */
const MAX_RESTARTS = 12
/** 重启退避：从 750ms 起翻倍，封顶 30s。 */
const RESTART_BASE_MS = 750
const RESTART_MAX_MS = 30_000

/** $DSH_HOME —— 与 dsh-pet 用同一个目录约定。 */
export function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv) return fromEnv
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  return path.join(home, '.dsh')
}

/** Electron 可执行文件按平台的落地相对路径。 */
function electronRelativePath() {
  if (process.platform === 'win32') return 'electron.exe'
  if (process.platform === 'darwin') return path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
  return 'electron'
}

/**
 * 找一个能用的 Electron 可执行文件。
 *
 * @param {string} [override] - 显式路径（环境变量 / 配置），优先。
 * @returns {{path: string|null, searched: string[]}}
 */
export function resolveElectron(override) {
  const searched = []
  const candidates = []
  if (override) candidates.push(override)
  if (process.env.DSH_ETA_ELECTRON_PATH) candidates.push(process.env.DSH_ETA_ELECTRON_PATH)
  candidates.push(path.join(dshHomeDir(), 'electron', electronRelativePath()))

  for (const candidate of candidates) {
    if (!candidate) continue
    searched.push(candidate)
    try {
      if (fs.existsSync(candidate)) return { path: candidate, searched }
    } catch (err) {
      /* 权限之类的问题当作不存在，继续找下一个 */
    }
  }
  return { path: null, searched }
}

/** helper 的主进程脚本路径。 */
export function helperMainPath(packageRoot) {
  return path.join(packageRoot, 'runtime', 'electron-helper', 'main.js')
}

/**
 * 桌面窗口管理器：一进一出，可反复启停。
 */
export class DesktopWindow {
  /**
   * @param {object} options
   * @param {string} options.packageRoot - 包根（用于定位 helper 脚本）
   * @param {() => {port: number, stateUrl: string}} options.getEndpoint - 取宿主地址
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    this.options = options
    this.log = options.log || ((msg) => { try { console.warn(msg) } catch (err) { /* 忽略 */ } })
    this.child = null
    this.stopping = false
    this.restartTimer = null
    this.restartFailures = 0
    /** 最近一次失败原因，供诊断用。 */
    this.lastError = ''
    this.stderrTail = ''
  }

  isRunning() {
    return this.child !== null
  }

  /**
   * 启动桌面窗口。
   *
   * @returns {{ok: boolean, error?: string, searched?: string[]}}
   */
  start() {
    if (this.child) return { ok: true }
    this.stopping = false

    const electron = resolveElectron(this.options.electronPath)
    if (!electron.path) {
      const message = '没找到 Electron 运行时。桌面显示需要它（约 300MB），'
        + '本插件不会替你静默下载。可用 DSH_ETA_ELECTRON_PATH 指定已有路径，'
        + '或安装 dsh-pet 让它把运行时下到 ~/.dsh/electron。'
        + '查找过：' + electron.searched.join(' | ')
      this.lastError = message
      this.log('[dsh-eta] ' + message)
      return { ok: false, error: message, searched: electron.searched }
    }

    const endpoint = this.options.getEndpoint()
    if (!endpoint || !(endpoint.port > 0)) {
      const message = '宿主 webServer 还没就绪，稍后重试'
      this.lastError = message
      this.scheduleRestart()
      return { ok: false, error: message }
    }

    const helperPath = helperMainPath(this.options.packageRoot)
    if (!fs.existsSync(helperPath)) {
      const message = 'helper 脚本缺失：' + helperPath
      this.lastError = message
      this.log('[dsh-eta] ' + message)
      return { ok: false, error: message }
    }

    // 关键：清掉 ELECTRON_RUN_AS_NODE，否则 Electron 以纯 Node 模式跑，模块不注册。
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.DSH_ETA_HOST_PID = String(process.pid)
    env.DSH_ETA_STATE_URL = endpoint.stateUrl
    env.DSH_ETA_ALLOW_ORIGIN = `http://127.0.0.1:${endpoint.port}`
    // 记忆模式：把上次的窗口位置带给 helper（JSON 塞环境变量最省事，
    // helper 那边 JSON.parse 一次就行；null = 没存过，用默认右下角）。
    env.DSH_ETA_WIN_BOUNDS = this.options.initialBounds
      ? JSON.stringify(this.options.initialBounds)
      : ''

    let child
    try {
      child = spawn(electron.path, [helperPath], {
        cwd: dshHomeDir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      const message = '拉起 Electron 失败：' + (error && error.message ? error.message : String(error))
      this.lastError = message
      this.log('[dsh-eta] ' + message)
      this.scheduleRestart()
      return { ok: false, error: message }
    }

    this.child = child
    child.once('error', (error) => {
      if (this.child !== child) return
      this.lastError = error && error.message ? error.message : String(error)
      this.log('[dsh-eta] 桌面窗口启动失败：' + this.lastError)
      this.child = null
      this.scheduleRestart()
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return
      this.log('[dsh-eta] 桌面窗口退出（code=' + String(code) + ', signal=' + String(signal) + '），稍后重启')
      this.scheduleRestart()
    })

    // helper 的日志只留最后一段：正常情况下它很安静，出问题时有尾部就够定位。
    const keepTail = (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000)
    }
    // stdout 是**结构化通道**：helper 用 `dsh-eta:bounds {...json}` 行回报窗口
    // 的实际落点（记忆模式要用它保存位置）。行式协议，坏行直接忽略。
    if (child.stdout) {
      let buffered = ''
      child.stdout.on('data', (chunk) => {
        buffered += String(chunk)
        let nl = buffered.indexOf('\n')
        while (nl !== -1) {
          const line = buffered.slice(0, nl).trim()
          buffered = buffered.slice(nl + 1)
          if (line.startsWith('dsh-eta:bounds ')) {
            try {
              const bounds = JSON.parse(line.slice('dsh-eta:bounds '.length))
              if (typeof this.options.onBounds === 'function') this.options.onBounds(bounds)
            } catch (err) { /* 坏行忽略 */ }
          }
          nl = buffered.indexOf('\n')
        }
      })
    }
    if (child.stderr) child.stderr.on('data', keepTail)

    this.restartFailures = 0
    this.lastError = ''
    return { ok: true }
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return
    if (this.restartFailures >= MAX_RESTARTS) {
      this.lastError = '连续启动失败 ' + this.restartFailures + ' 次，已放弃自动重启'
      this.log('[dsh-eta] ' + this.lastError)
      return
    }
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * Math.pow(2, this.restartFailures))
    this.restartFailures++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  /** 关掉桌面窗口。同步返回，不等待进程真正退出（宿主卸载不能卡住）。 */
  stop() {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    if (!child) return
    try { child.kill() } catch (err) { /* 已经没了 */ }
    // 给 1.5s 体面退出，之后强杀（Electron 主进程有时会赖着）。
    const timer = setTimeout(() => {
      try { if (child.exitCode === null) child.kill('SIGKILL') } catch (err) { /* 忽略 */ }
    }, 1500)
    timer.unref?.()
  }
}

export { HOST_POLL_MS, MAX_RESTARTS }
