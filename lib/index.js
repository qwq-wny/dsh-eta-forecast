/**
 * dsh-eta-forecast — 宿主半侧
 *
 * 职责只有三件：
 *   1. 订阅 `session/event`，把事件喂给纯函数核心（./forecast.js）算出 ETA；
 *   2. 用 `webserver/index-inject` 把浏览器半侧脚本注入页面（桌面端唯一可用通道）；
 *   3. 提供两个只读路由：`/dsh-eta/eta.js`（脚本本体）与 `/dsh-eta/state.json`（快照）。
 *
 * 刻意不做的事：
 *   - 不注册任何写接口（没有配置、没有凭据、没有文件写入）⇒ 没有攻击面，也不需要
 *     那套「写请求必须来自回环」的栅栏。只读接口在局域网里看也安全。
 *   - 不 import 任何宿主服务（webServer 除外，且用 `ctx.inject` 动态等待）——
 *     老宿主没有某个服务时插件不该整个不 apply。
 *
 * @module dsh-eta-forecast
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  emptySession, observeEvent, forecastSession,
  isDisplayableSession, sessionIdOf, sessionNameOf,
} from './forecast.js'
import { DesktopWindow } from './desktop.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 浏览器半侧脚本：包内 assets 优先，其次 lib 旁边（方便本地改）。 */
const CLIENT_FILE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'eta-client.js'),
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'eta-client.js'),
]

/** 会话状态上限：超出就按 lastEventAt 淘汰最旧的，避免长期运行内存膨胀。 */
const MAX_SESSIONS = 64

/**
 * 「显示位置」的四个取值 —— 与 dsh-pet 保持同一套语义，用户不用记两套词。
 *   web     仅网页
 *   desktop 仅桌面
 *   both    两者都显示
 *   none    都不显示
 */
const DISPLAY_MODES = ['web', 'desktop', 'both', 'none']
const DISPLAY_DEFAULT = 'both'

/** 配置持久化文件（记忆模式，见下）。路径 = DSH 配置目录 / dsh-eta-forecast.json。 */
const CONFIG_ROUTE = '/dsh-eta/config'

/**
 * 「记忆模式」：上一次的设置下次启动原样保留。
 *
 * 分两层：
 *   - **外观**（缩放/壁纸/折叠等）本来就存在浏览器 localStorage，重启天然保留 ——
 *     这是网页的天然行为，不算这个功能。
 *   - **宿主级**的设置原来只活在内存里：显示位置改一次，重启就回到 patch 默认值；
 *     桌面浮窗每次都从右下角重新出现。记忆模式把它们落盘到一个 JSON 文件，
 *     启动时读回来。写盘只在「设置真的变了」时发生（fire-and-forget，不阻塞路由）。
 *
 * 默认**开**：用户的直觉是「我上次怎么调的这次就该是那样」，不是「每次都归零」。
 * 关掉它就回到旧行为（只在 patch 层写的值生效）。
 */

/**
 * 桌面端的注入行是**内联 script**，不是 `script-src`。
 *
 * 原因（这是被踩出来的，不是猜的）：桌面壳的 index.html 从安装包静态 dist 直出，
 * `tapIndex` 永远不经过；唯一通道是 `webserver/index-inject` 的结构化行。而页面侧
 * 解释器对两种 script 行的处理**不对称**：`script` 是 createElement + textContent
 * + append（没有 await，不可能失败），`script-src` 是 `await loadScript(src)`
 * —— 一旦加载失败就会 reject 掉 `__DSH_BOOT_READY__`，整个应用起不来。
 * 所以这里自己建 `<script src>` 并**吞掉 onerror**：路由在就正常加载，路由不在就
 * 静默失败，宿主永远不会因为本插件起不来。
 */
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="/dsh-eta/eta.js";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

/**
 * 写接口只在**回环地址**上放行。
 *
 * 这是本插件第一次引入写接口（改变显示位置），所以必须自己加栅栏：
 * 只读的 state.json 在局域网里看无所谓，但「谁能改我的显示设置」不能随便放开。
 * 判据取 socket 的 remoteAddress —— 不信任任何请求头（Host / X-Forwarded-For 都能伪造）。
 */
function isLoopback(req) {
  try {
    const addr = (req && req.socket && req.socket.remoteAddress) || ''
    const normalized = String(addr).replace(/^::ffff:/, '')
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
  } catch (err) {
    return false
  }
}

/**
 * 记忆模式的状态文件：`<DSH 配置目录>/dsh-eta-forecast.json`。
 *
 * 与 DSH 配置目录同层（不是插件安装目录）：安装/更新插件会换目录，
 * 用户的设置不该跟着丢。
 */
export function stateFilePath(homeDir) {
  const base = homeDir
    || process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh')
  return path.join(base, 'dsh-eta-forecast.json')
}

/**
 * 从宿主 root 上安全地读 stateHome。
 *
 * 真实宿主的 root 是受控代理：**未通过 inject 声明的属性连读都会抛错**
 * （实测报「cannot get property "stateHome" without inject」，插件整个起不来）。
 * 这个注入点只服务于测试隔离，线上永远走默认目录，所以读不到就吞掉。
 */
function safeStateHome(root) {
  try {
    const value = root && root.stateHome
    return typeof value === 'string' && value ? value : undefined
  } catch (err) {
    return undefined
  }
}

/** 读状态文件；损坏 / 不存在一律回退到空对象（绝不因此起不来）。 */
export function readPersisted(homeDir) {
  try {
    const raw = fs.readFileSync(stateFilePath(homeDir), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    return {}
  }
}

/**
 * 写状态文件（fire-and-forget）。
 *
 * 写失败静默吞掉：保存不了设置是「退化成旧行为」，不是「插件坏掉」；
 * 为一个 json 文件把路由搞挂不划算。写之前先落临时文件再 rename，
 * 断电/并发写也不会留下半个文件。
 */
export function writePersisted(value, homeDir) {
  try {
    const file = stateFilePath(homeDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    return false
  }
}

/** 记忆模式实际记录的字段（现在只有显示位置与桌面窗口位置）。 */
function sanitizePersisted(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  out.display = DISPLAY_MODES.indexOf(src.display) !== -1 ? src.display : fallback.display
  const win = src.desktopWindow
  out.desktopWindow = win && typeof win === 'object'
    && Number.isFinite(Number(win.x)) && Number.isFinite(Number(win.y))
    && Number(win.width) > 0 && Number(win.height) > 0
    ? { x: Math.round(Number(win.x)), y: Math.round(Number(win.y)), width: Math.round(Number(win.width)), height: Math.round(Number(win.height)) }
    : null
  return out
}

/** 读 JSON 请求体（带上限，避免被塞爆内存）。 */
function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        finish(null)
        try { req.destroy() } catch (err) { /* 忽略 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return finish({})
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = JSON.parse(text)
        finish(parsed && typeof parsed === 'object' ? parsed : null)
      } catch (err) {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/** 插件版本（package.json 的 version；读一次缓存住）。 */
let cachedVersion = null
function pluginVersion() {
  if (cachedVersion) return cachedVersion
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    cachedVersion = String(pkg.version || '0.0.0')
  } catch (err) {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

/**
 * 读浏览器半侧脚本（按 mtime 缓存，改文件后硬刷新即生效）。
 *
 * 返回前把 `__DSH_ETA_VERSION__` 占位符替换成 package.json 的版本号 ——
 * 客户端把版本号画在设置面板上，用户截图求助时一眼能看到「现在跑的是哪版」。
 * 这里的字符串替换发生在 mtime 缓存之后（缓存原文、每次返回时注入），
 * 版本号在装包时固定，不需要每次替换。
 */
let clientCache = null
let clientCacheInjected = null
function loadClientJs() {
  for (const file of CLIENT_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(file)
      if (clientCache && clientCache.mtimeMs === stat.mtimeMs) return clientCacheInjected
      const text = fs.readFileSync(file, 'utf8')
      clientCache = { text, mtimeMs: stat.mtimeMs }
      clientCacheInjected = text.replace(/__DSH_ETA_VERSION__/g, pluginVersion())
      return clientCacheInjected
    } catch (err) {
      /* 换下一个候选 */
    }
  }
  return clientCache ? clientCacheInjected : ''
}

export default {
  name: 'dsh-eta-forecast',

  /**
   * `apply` 立刻执行、第一件事就是注册注入行（它不依赖任何服务）。
   *
   * 不能用对象级 `inject: ['webServer']`：桌面端的注入表是**宿主启动时一次性收集**
   * 的（collectIndexInjections → IPC → 渲染层），订阅一旦晚于那次收集，这一行就
   * 永远进不了表 —— 表现就是「宿主活着、页面里什么都没有」，而且完全无法复现。
   * 这里用局部 `root.inject([...], cb)` 等待服务，语义等价但不推迟行的注册。
   */
  apply(root) {
    /** 会话 id → 估算状态。 */
    const sessions = new Map()
    /** 会话 id → 最近一次快照（前端轮询直接读，不再重算）。 */
    const snapshots = new Map()

    /**
     * 显示位置。
     *
     * 记忆模式（默认开）：启动时从状态文件读回上一次的值；
     * 关闭记忆模式时用 patch 里的默认值。运行期通过 POST /dsh-eta/config 改。
     *
     * stateHome 允许 ctx 注入（测试用它指向临时目录），缺省 = 真实 DSH 配置目录。
     * 状态文件必须能与真实环境隔离 —— 不然测试一跑就写了用户的 ~/.dsh。
     *
     * 注意读取必须 try/catch：真实宿主的 root 是受控代理，**未通过 inject 声明
     * 的属性连读都会抛错**（实测「启用失败：cannot get property "stateHome"
     * without inject」整个插件起不来）。读不到 = 用默认目录，这正是线上语义。
     */
    const stateHome = safeStateHome(root)
    let persisted = readPersisted(stateHome)
    let memory = persisted.memory !== false // 缺省 = 开
    let display = memory && persisted.display
      ? persisted.display
      : DISPLAY_DEFAULT
    /** 桌面窗口管理器（懒创建：只有真的要用桌面模式才碰 Electron）。 */
    let desktop = null
    /** 桌面浮窗最近一次的实际位置（记忆模式用，null = 没存过）。 */
    let desktopWindowPos = memory && persisted.desktopWindow ? persisted.desktopWindow : null
    /** 宿主 webServer 端点，供桌面 helper 连回本机取快照。 */
    let endpoint = { port: 0, stateUrl: '' }

    const disposeRows = []
    root.effect(() => () => {
      for (const dispose of disposeRows) {
        try { dispose() } catch (err) { /* 卸载期出错不影响其余 */ }
      }
      if (desktop) {
        try { desktop.stop() } catch (err) { /* 忽略 */ }
        desktop = null
      }
    })

    /** 当前是否该显示网页挂件。 */
    const wantWeb = () => display === 'web' || display === 'both'
    /** 当前是否该显示桌面浮窗。 */
    const wantDesktop = () => display === 'desktop' || display === 'both'

    /**
     * 保存记忆。fire-and-forget（写失败静默，见 writePersisted）。
     *
     * 注意 memory=false 时**也要写**：不然「关掉记忆」这件事本身记不住，
     * 重启后又默认开 —— 用户明确选择过的行为不能静默丢掉。
     * 关着的时候只写这一个事实，display / desktopWindow 的一概不跟。
     */
    const saveMemory = () => {
      if (!memory) {
        writePersisted({ memory: false }, stateHome)
        return
      }
      writePersisted({
        memory: true,
        display,
        desktopWindow: desktopWindowPos,
      }, stateHome)
    }

    /** 按当前 display 值启停桌面窗口。幂等，可以反复调用。 */
    function syncDesktop() {
      if (!wantDesktop()) {
        if (desktop) {
          try { desktop.stop() } catch (err) { /* 忽略 */ }
          desktop = null
        }
        return
      }
      if (!endpoint.port) return // webServer 还没就绪，等注入回调里再唤一次
      if (!desktop) {
        desktop = new DesktopWindow({
          packageRoot: PACKAGE_ROOT,
          getEndpoint: () => endpoint,
          // 记忆模式：把上次的窗口位置带给 helper（null = 没存过，用默认右下角）。
          initialBounds: memory ? desktopWindowPos : null,
          onBounds: (bounds) => {
            // 每次窗口真实落点变化都记下来；真正写盘在退出/变更时统一做。
            desktopWindowPos = bounds
            saveMemory()
          },
          log: (message) => {
            try { console.warn(message) } catch (err) { /* 忽略 */ }
          },
        })
      }
      const result = desktop.start()
      if (!result.ok && result.error) {
        try { console.warn('[dsh-eta] 桌面模式未启动：' + result.error) } catch (err) { /* 忽略 */ }
      }
    }

    // ① 结构化注入行：桌面端唯一能生效的通道。
    disposeRows.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        // 「仅桌面」时不往网页里注入 —— 否则网页端也会出现一个挂件，
        // 用户选的「仅桌面」就名不副实了。
        if (!wantWeb()) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === '/dsh-eta/eta.js') return
          if (row.kind === 'script' && typeof row.text === 'string'
            && row.text.indexOf('/dsh-eta/eta.js') >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
      } catch (err) {
        /* 注入失败不该影响宿主启动 */
      }
    }))

    /** 淘汰最久没动静的会话。 */
    function trimSessions() {
      if (sessions.size <= MAX_SESSIONS) return
      const ordered = Array.from(sessions.values()).sort((a, b) => a.lastEventAt - b.lastEventAt)
      const drop = sessions.size - MAX_SESSIONS
      for (let i = 0; i < drop; i++) {
        sessions.delete(ordered[i].id)
        snapshots.delete(ordered[i].id)
      }
    }

    /** 会话销毁时清掉它的状态。 */
    disposeRows.push(root.on('session/disposed', (session) => {
      try {
        const id = sessionIdOf(session)
        sessions.delete(id)
        snapshots.delete(id)
      } catch (err) { /* 清理失败不影响其它会话 */ }
    }))

    // ② 会话事件 → 估算状态。
    disposeRows.push(root.on('session/event', (session, event) => {
      try {
        if (!isDisplayableSession(session)) return
        const type = event && event.type
        if (typeof type !== 'string') return
        // 只关心这几类；其余事件连 Map 都不用碰。
        if (type !== 'turn/start' && type !== 'turn/end' && type !== 'step/start'
          && type !== 'step/end' && type !== 'todo/write' && type !== 'tool/call'
          && type !== 'tool/result' && type !== 'approval/asked'
          && type !== 'approval/decided' && type !== 'session/title') return

        const id = sessionIdOf(session)
        let state = sessions.get(id)
        if (!state) {
          state = emptySession(id)
          sessions.set(id, state)
        }
        const now = Date.now()
        const name = sessionNameOf(session)
        if (name) state.title = name

        if (type === 'session/title') {
          const title = String((event.data && event.data.title) || '').trim()
          if (title) state.title = title.slice(0, 120)
        }

        observeEvent(state, event, now)
        snapshots.set(id, forecastSession(state, now))
        trimSessions()
      } catch (err) {
        // 单个事件算错不能拖垮事件流；下一次事件会重新对齐。
      }
    }))

    // ③ 路由 + 页面注入（需要 webServer）。
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      try {
        // 记下端点：桌面 helper 要连回本机取快照。
        try {
          const port = ctx.webServer.port | 0
          if (port > 0) {
            endpoint = { port, stateUrl: `http://127.0.0.1:${port}/dsh-eta/state.json` }
            // 端点就绪后按当前配置把桌面窗口拉起来（之前想开但没端口的，这里补上）。
            syncDesktop()
          }
        } catch (err) {
          /* 拿不到端口就只能是网页模式 */
        }

        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: '/dsh-eta/eta.js',
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(loadClientJs())
          },
        }))

        /**
         * 显示位置配置：GET 查、POST 改。
         *
         * 这是本插件唯一的写接口。两道保护：
         *   1. 只接受回环请求（isLoopback），局域网改不了；
         *   2. POST 只认 display 字段、只认四个白名单值，其余一律忽略/拒绝。
         */
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: CONFIG_ROUTE,
          handler: async (req, res) => {
            const method = String((req && req.method) || 'GET').toUpperCase()
            if (method === 'OPTIONS') {
              res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
              })
              res.end()
              return
            }
            if (method === 'GET') {
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({
                ok: true,
                display,
                modes: DISPLAY_MODES,
                // 记忆模式：面板用它画出开关的当前状态
                memory,
                desktopRunning: Boolean(desktop && desktop.isRunning()),
                error: desktop ? desktop.lastError : '',
              }))
              return
            }
            if (method !== 'POST') {
              res.writeHead(405, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
              return
            }
            if (!isLoopback(req)) {
              res.writeHead(403, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: '配置只能从本机修改' }))
              return
            }
            const body = await readJsonBody(req)
            if (!body) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
              return
            }
            // 两个可写字段：display（可选，缺省沿用当前值）与 memory（可选布尔）。
            // 传了 memory 就先更新它 —— 关掉记忆模式意味着「之后不再保存」，
            // 必须赶在写盘之前生效。
            if (typeof body.memory === 'boolean') memory = body.memory

            let next = String(body.display || '')
            if (!next) next = display
            if (DISPLAY_MODES.indexOf(next) === -1) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({
                ok: false,
                error: 'display 只能是 ' + DISPLAY_MODES.join(' / '),
              }))
              return
            }
            display = next
            saveMemory()
            // 网页端不注入时无法即时移除已注入的脚本 —— 用户刷新页面即生效。
            // 桌面端可以立刻启停，所以这里同步做。
            syncDesktop()
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({
              ok: true,
              display,
              memory,
              desktopRunning: Boolean(desktop && desktop.isRunning()),
              error: desktop ? desktop.lastError : '',
              note: '网页端刷新页面后生效；桌面端已即时应用',
            }))
          },
        }))

        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: '/dsh-eta/state.json',
          handler: (req, res) => {
            try {
              const now = Date.now()
              const rows = []
              for (const state of sessions.values()) {
                // 运行中的会话实时重算（剩余时长在走），已结束的直接给最后一份。
                const snap = state.active
                  ? forecastSession(state, now)
                  : (snapshots.get(state.id) || forecastSession(state, now))
                rows.push({
                  id: state.id,
                  title: state.title,
                  ...snap,
                })
              }
              // 挑「当前」会话：优先运行中的、最近有事件的；没有运行中的就给最近一条已结束的。
              rows.sort((a, b) => {
                if ((a.phase === 'running') !== (b.phase === 'running')) return a.phase === 'running' ? -1 : 1
                return (b.updatedAt || 0) - (a.updatedAt || 0)
              })
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({
                ok: true,
                now,
                // 插件版本：排查问题时对得上「用户截图里面板显示的版本」。
                version: pluginVersion(),
                // 前端据此决定要不要把自己藏起来（「仅桌面」时网页里不该出现挂件）。
                display,
                // 记忆模式状态也一并给出去：桌面端的「恢复默认」要用它决定
                // 要不要顺带清掉宿主级的记忆。
                memory,
                sessions: rows.slice(0, 8),
              }))
            } catch (err) {
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, now: Date.now(), sessions: [], error: String((err && err.message) || err) }))
            }
          },
        }))

        // Web 形态（非桌面）走 tapIndex；两条通道并存、各自去重。
        if (typeof ctx.webServer.tapIndex === 'function') {
          disposers.push(ctx.webServer.tapIndex((html) => {
            try {
              if (typeof html !== 'string') return html
              // 「仅桌面」时不注入网页脚本。
              if (!wantWeb()) return html
              if (html.indexOf('/dsh-eta/eta.js') !== -1) return html
              const tag = '<script defer src="/dsh-eta/eta.js"></script>'
              if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
              return html + tag
            } catch (err) {
              return html
            }
          }))
        }
      } catch (err) {
        // 路由冲突（例如插件被加载了两次）只该让本插件降级，不该让宿主失败。
        try {
          console.warn('[dsh-eta] 路由注册失败：' + String((err && err.message) || err))
        } catch (inner) { /* console 不可用也不影响 */ }
      }

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch (err) { /* 卸载期出错不影响其余 */ }
        }
      })
    })
  },
}
