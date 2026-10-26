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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  emptySession, observeEvent, forecastSession,
  isDisplayableSession, sessionIdOf, sessionNameOf,
} from './forecast.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 浏览器半侧脚本：包内 assets 优先，其次 lib 旁边（方便本地改）。 */
const CLIENT_FILE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'eta-client.js'),
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'eta-client.js'),
]

/** 会话状态上限：超出就按 lastEventAt 淘汰最旧的，避免长期运行内存膨胀。 */
const MAX_SESSIONS = 64

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

/** 读一次浏览器半侧脚本（按 mtime 缓存，改文件后硬刷新即生效）。 */
let clientCache = null
function loadClientJs() {
  for (const file of CLIENT_FILE_CANDIDATES) {
    try {
      const stat = fs.statSync(file)
      if (clientCache && clientCache.mtimeMs === stat.mtimeMs) return clientCache.text
      const text = fs.readFileSync(file, 'utf8')
      clientCache = { text, mtimeMs: stat.mtimeMs }
      return text
    } catch (err) {
      /* 换下一个候选 */
    }
  }
  return clientCache ? clientCache.text : ''
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

    const disposeRows = []
    root.effect(() => () => {
      for (const dispose of disposeRows) {
        try { dispose() } catch (err) { /* 卸载期出错不影响其余 */ }
      }
    })

    // ① 结构化注入行：桌面端唯一能生效的通道。
    disposeRows.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
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

    // ③ 只读路由 + 页面注入（需要 webServer）。
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      try {
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
              res.end(JSON.stringify({ ok: true, now, sessions: rows.slice(0, 8) }))
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
