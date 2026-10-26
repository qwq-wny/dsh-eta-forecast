/**
 * 宿主半侧的挂载冒烟测试：用一个最小的假 ctx 把 `apply` 真的跑起来，
 * 验证五件事——
 *   1. apply 不抛异常（插件加载失败会让整个 profile 起不来，这是最贵的 bug）；
 *   2. 注入行进了表，且是**内联 script 行**（桌面端唯一通道）；
 *   3. 路由真的注册了，且 handler 返回的东西能 JSON 化；
 *   4. session/event 真的能推动估算状态（从事件到 HTTP 响应打通）；
 *   5. **配置路由的写入口只对回环开放**（这是插件唯一的写接口）。
 *
 * 这里不测 DSH 本身，测的是「我们这半边有没有接错线」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../lib/index.js'

/** 造一个够用的假宿主 ctx。 */
function fakeHost(options) {
  const handlers = new Map()
  const routes = new Map()
  const taps = []
  const effects = []
  let injectTable = []
  // 记忆模式的状态文件目录：**必须**是每个实例独立的临时目录 ——
  // 插件读到 undefined 会回退到真实 ~/.dsh，那正是这次污染用户配置的原因。
  const stateHome = (options && options.stateHome)
    || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eta-host-test-'))

  const webServer = {
    /** 端口 > 0 才会尝试拉起桌面窗口；测试里不拉。 */
    port: 0,
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(transform) {
      taps.push(transform)
      return () => {
        const at = taps.indexOf(transform)
        if (at !== -1) taps.splice(at, 1)
      }
    },
  }

  const ctx = {
    // 记忆模式的状态文件目录：插件从这里读写 dsh-eta-forecast.json。
    // 每个测试实例独立一个临时目录，否则测试之间（以及和真实 ~/.dsh 之间）
    // 会互相读到对方的记忆。
    stateHome,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) || []
        const at = list.indexOf(handler)
        if (at !== -1) list.splice(at, 1)
      }
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback({ webServer, effect: ctx.effect })
    },
  }

  return {
    ctx,
    routes,
    taps,
    emit(event, ...args) {
      for (const handler of handlers.get(event) || []) handler(...args)
    },
    collectInjections() {
      injectTable = []
      for (const handler of handlers.get('webserver/index-inject') || []) handler(injectTable)
      return injectTable
    },
    get injectTable() { return injectTable },
    teardown() {
      for (const fn of effects) {
        try {
          const dispose = fn()
          if (typeof dispose === 'function') dispose()
        } catch (err) { /* 卸载期出错不该让测试挂掉 */ }
      }
    },
  }
}

/** 造一个假的 res，把 handler 写出来的东西收集起来。 */
function fakeResponse() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers || {}
    },
    end(chunk) {
      out.body = chunk == null ? '' : String(chunk)
    },
  }
}

function callRoute(host, path) {
  const route = host.routes.get(path)
  assert.ok(route, 'route ' + path + ' must be registered')
  const res = fakeResponse()
  route.handler({ method: 'GET', headers: { host: '127.0.0.1' }, url: path }, res)
  return res.out
}

/** 造一个可读的假 req（带 socket.remoteAddress），用来测写接口的栅栏。 */
function fakeRequest(options) {
  const opts = options || {}
  const listeners = new Map()
  const req = {
    method: opts.method || 'GET',
    url: opts.url || '/dsh-eta/config',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: opts.remoteAddress === undefined ? '127.0.0.1' : opts.remoteAddress },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return req
    },
    destroy() {},
  }
  // 立刻把请求体推出去（测试里不需要真正的流式时序）。
  setImmediate(() => {
    const body = opts.body
    if (body !== undefined && body !== null) {
      for (const handler of listeners.get('data') || []) handler(Buffer.from(String(body)))
    }
    for (const handler of listeners.get('end') || []) handler()
  })
  return req
}

/** 调配置路由（GET/POST）。 */
async function callConfig(host, options) {
  const route = host.routes.get('/dsh-eta/config')
  assert.ok(route, 'config route must be registered')
  const res = fakeResponse()
  await route.handler(fakeRequest(options), res)
  return res.out
}

test('apply 不抛异常，且注册了三个路由（两个只读 + 一个回环写）', () => {
  const host = fakeHost()
  assert.doesNotThrow(() => plugin.apply(host.ctx))
  assert.equal(plugin.name, 'dsh-eta-forecast')

  assert.ok(host.routes.has('/dsh-eta/eta.js'), 'client script route')
  assert.ok(host.routes.has('/dsh-eta/state.json'), 'state route')
  assert.ok(host.routes.has('/dsh-eta/config'), 'config route (display mode)')
  assert.equal(host.routes.size, 3, 'two read-only routes + one loopback-only config route')
  host.teardown()
})

/* ---------- 显示位置配置（唯一的写接口，栅栏必须测） ---------- */

test('配置路由 GET 返回当前显示位置与可选值', async () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  const out = await callConfig(host, { method: 'GET' })
  assert.equal(out.status, 200)
  const body = JSON.parse(out.body)
  assert.equal(body.ok, true)
  assert.deepEqual(body.modes, ['web', 'desktop', 'both', 'none'])
  assert.ok(body.modes.indexOf(body.display) !== -1, 'current display must be one of the modes')
  assert.equal(body.display, 'both', 'default is both, same as dsh-pet')
  host.teardown()
})

test('POST 能从回环改显示位置', async () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  const out = await callConfig(host, {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    body: JSON.stringify({ display: 'desktop' }),
  })
  assert.equal(out.status, 200)
  assert.equal(JSON.parse(out.body).display, 'desktop')

  // 再读一次确认持久在内存里
  const after = JSON.parse((await callConfig(host, { method: 'GET' })).body)
  assert.equal(after.display, 'desktop')
  host.teardown()
})

test('POST 从非回环地址被拒绝（局域网不能改显示设置）', async () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  const out = await callConfig(host, {
    method: 'POST',
    remoteAddress: '192.168.1.50',
    body: JSON.stringify({ display: 'none' }),
  })
  assert.equal(out.status, 403, 'non-loopback writes must be rejected')

  // 并且状态没被改
  const after = JSON.parse((await callConfig(host, { method: 'GET' })).body)
  assert.equal(after.display, 'both', 'a rejected write must not change anything')
  host.teardown()
})

test('POST 拒绝非法 display 值，不会写入奇怪内容', async () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  // 缺省 display（'' / null / undefined）现在是合法的：它表示「只改 memory」，
  // display 沿用当前值 —— 记忆模式开关就是这么切的。其余非法值仍然拒绝。
  for (const bad of ['DESKTOP', 'everywhere', '<script>', 42]) {
    const out = await callConfig(host, {
      method: 'POST',
      remoteAddress: '127.0.0.1',
      body: JSON.stringify({ display: bad }),
    })
    assert.equal(out.status, 400, 'display=' + JSON.stringify(bad) + ' must be rejected')
  }
  const after = JSON.parse((await callConfig(host, { method: 'GET' })).body)
  assert.equal(after.display, 'both')
  host.teardown()
})

test('记忆模式：POST 只改 memory 不传 display，display 保持不变并落盘', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eta-mem-'))
  const host = fakeHost({ stateHome: home })
  plugin.apply(host.ctx)

  // 先把 display 改成 desktop（此时记忆开着，应当写盘）
  await callConfig(host, {
    method: 'POST', remoteAddress: '127.0.0.1',
    body: JSON.stringify({ display: 'desktop' }),
  })

  // 只切 memory=false：display 不变
  const off = JSON.parse((await callConfig(host, {
    method: 'POST', remoteAddress: '127.0.0.1',
    body: JSON.stringify({ memory: false }),
  })).body)
  assert.equal(off.memory, false)
  assert.equal(off.display, 'desktop')

  // 记忆关掉后再改 display：**不写盘**。文件里只剩 {memory:false} 一条 ——
  // 「关掉记忆」这个事实本身要存，但 display / 窗口位置的一概不跟。
  await callConfig(host, {
    method: 'POST', remoteAddress: '127.0.0.1',
    body: JSON.stringify({ display: 'none' }),
  })
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'dsh-eta-forecast.json'), 'utf8'))
  assert.deepEqual(saved, { memory: false },
    'memory off → the display change must not be persisted')

  // 重新开：再改一次，这次要写盘
  await callConfig(host, {
    method: 'POST', remoteAddress: '127.0.0.1',
    body: JSON.stringify({ memory: true, display: 'both' }),
  })
  const saved2 = JSON.parse(fs.readFileSync(path.join(home, 'dsh-eta-forecast.json'), 'utf8'))
  assert.equal(saved2.display, 'both', 'memory on → the change must be persisted')
  assert.equal(saved2.memory, true)
  host.teardown()
})

test('记忆模式：重启（重新 apply）后读回上次的 display', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eta-mem-'))

  const first = fakeHost({ stateHome: home })
  plugin.apply(first.ctx)
  await callConfig(first, {
    method: 'POST', remoteAddress: '127.0.0.1',
    body: JSON.stringify({ display: 'web' }),
  })
  first.teardown()

  // 「重启」：同一个 stateHome 再 apply 一次
  const second = fakeHost({ stateHome: home })
  plugin.apply(second.ctx)
  const got = JSON.parse((await callConfig(second, { method: 'GET' })).body)
  assert.equal(got.display, 'web',
    'the display chosen last run must survive a restart when memory is on')
  assert.equal(got.memory, true)
  second.teardown()
})

test('记忆模式关闭时重启回默认值（旧行为）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eta-mem-'))

  const first = fakeHost({ stateHome: home })
  plugin.apply(first.ctx)
  await callConfig(first, {
    method: 'POST', remoteAddress: '127.0.0.1',
    body: JSON.stringify({ display: 'web', memory: false }),
  })
  first.teardown()

  const second = fakeHost({ stateHome: home })
  plugin.apply(second.ctx)
  const got = JSON.parse((await callConfig(second, { method: 'GET' })).body)
  assert.equal(got.display, 'both',
    'memory off → a restart must fall back to the default, like before')
  assert.equal(got.memory, false)
  second.teardown()
})

test('POST 拒绝畸形 JSON 与不支持的方法', async () => {
  const host = fakeHost()
  plugin.apply(host.ctx)

  const bad = await callConfig(host, { method: 'POST', remoteAddress: '127.0.0.1', body: '{ not json' })
  assert.equal(bad.status, 400)

  const put = await callConfig(host, { method: 'PUT', remoteAddress: '127.0.0.1' })
  assert.equal(put.status, 405)

  // OPTIONS 预检要能过（否则浏览器里跨源写会被挡）
  const options = await callConfig(host, { method: 'OPTIONS' })
  assert.equal(options.status, 204)
  host.teardown()
})

test('state.json 带上 display，网页端据此把自己藏起来', async () => {
  const host = fakeHost()
  plugin.apply(host.ctx)

  const before = JSON.parse(callRoute(host, '/dsh-eta/state.json').body)
  assert.equal(before.display, 'both')

  await callConfig(host, { method: 'POST', remoteAddress: '127.0.0.1', body: JSON.stringify({ display: 'desktop' }) })

  const after = JSON.parse(callRoute(host, '/dsh-eta/state.json').body)
  assert.equal(after.display, 'desktop', 'state must expose the mode so the client can hide itself')
  host.teardown()
})

test('「仅桌面」时不往网页注入脚本', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)

  // 默认 both：注入
  assert.equal(host.collectInjections().length, 1, 'both mode injects into the web page')

  // 切到 desktop 后不再注入
  return callConfig(host, {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    body: JSON.stringify({ display: 'desktop' }),
  }).then(() => {
    assert.equal(host.collectInjections().length, 0, 'desktop-only must not inject into the web page')
    return callConfig(host, {
      method: 'POST',
      remoteAddress: '127.0.0.1',
      body: JSON.stringify({ display: 'none' }),
    })
  }).then(() => {
    assert.equal(host.collectInjections().length, 0, 'none must not inject either')
    return callConfig(host, {
      method: 'POST',
      remoteAddress: '127.0.0.1',
      body: JSON.stringify({ display: 'web' }),
    })
  }).then(() => {
    assert.equal(host.collectInjections().length, 1, 'web mode injects again')
    host.teardown()
  })
})

test('注入行是内联 script（不是 script-src），且重复 emit 不重复推', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)

  const first = host.collectInjections()
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'script', 'must be inline: script-src rejects boot on load failure')
  assert.equal(first[0].placement, 'body')
  assert.ok(first[0].text.indexOf('/dsh-eta/eta.js') !== -1)

  const second = host.collectInjections()
  assert.equal(second.length, 1, 'idempotent across repeated emits')
  host.teardown()
})

test('客户端脚本路由返回 JS 且非空', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  const out = callRoute(host, '/dsh-eta/eta.js')
  assert.equal(out.status, 200)
  assert.match(out.headers['Content-Type'], /javascript/)
  assert.ok(out.body.length > 1000, 'client bundle should be non-trivial')
  assert.ok(out.body.indexOf('__dshEtaForecast') !== -1)
  host.teardown()
})

test('session/event → state.json 打通', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)

  const session = { header: { id: 'sess-1', title: '写个插件' } }
  const now = Date.now()
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  host.emit('session/event', session, {
    type: 'todo/write',
    data: {
      todos: [
        { content: '设计', status: 'completed' },
        { content: '实现', status: 'in_progress' },
        { content: '测试', status: 'pending' },
      ],
    },
  })
  host.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } })
  host.emit('session/event', session, { type: 'step/end', data: { turn: 1, step: 1 } })

  const out = callRoute(host, '/dsh-eta/state.json')
  assert.equal(out.status, 200)
  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 1)

  const snap = payload.sessions[0]
  assert.equal(snap.id, 'sess-1')
  assert.equal(snap.title, '写个插件')
  assert.equal(snap.phase, 'running')
  assert.equal(snap.total, 3)
  assert.equal(snap.completed, 1)
  assert.equal(snap.inProgress, 1)
  assert.equal(snap.currentTask, '实现')
  assert.ok(snap.elapsedMs >= 0)
  // 只有一个完成、还没步长样本 → 不该硬报一个精确值，但来源不该是 none
  assert.ok(['progress', 'pace', 'unit', 'history', 'none'].indexOf(snap.source) !== -1)
  assert.ok(now > 0)
  host.teardown()
})

test('子代理会话不进入快照', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)

  host.emit('session/event', { header: { id: 'sub-1', origin: 'subagent' } }, { type: 'turn/start', data: { turn: 1 } })
  host.emit('session/event', { header: { id: 'main-1' } }, { type: 'turn/start', data: { turn: 1 } })

  const payload = JSON.parse(callRoute(host, '/dsh-eta/state.json').body)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].id, 'main-1')
  host.teardown()
})

test('turn/end 之后快照变成 done，且仍然返回得出来', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  const session = { header: { id: 'sess-2' } }
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const payload = JSON.parse(callRoute(host, '/dsh-eta/state.json').body)
  assert.equal(payload.sessions[0].phase, 'done')
  assert.equal(payload.sessions[0].endReason, 'completed')
  host.teardown()
})

test('session/disposed 清掉状态', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  const session = { header: { id: 'sess-3' } }
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  host.emit('session/disposed', session)

  const payload = JSON.parse(callRoute(host, '/dsh-eta/state.json').body)
  assert.equal(payload.sessions.length, 0)
  host.teardown()
})

test('webServer 缺席时 apply 仍然成功（降级而不是整个不挂）', () => {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    effect() { return () => {} },
    // 服务永远等不到 —— 模拟老宿主
    inject() {},
    // 记忆模式的状态目录也要隔离：这个 ctx 没有 webServer，但记忆读取照常发生
    stateHome: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eta-host-noinj-')),
  }
  assert.doesNotThrow(() => plugin.apply(ctx))
  // 注入行照旧注册（它不依赖 webServer）
  const table = []
  for (const handler of handlers.get('webserver/index-inject') || []) handler(table)
  assert.equal(table.length, 1)
})

test('畸形事件不会让 apply 后的处理链抛异常', () => {
  const host = fakeHost()
  plugin.apply(host.ctx)
  const session = { header: { id: 'sess-4' } }
  assert.doesNotThrow(() => host.emit('session/event', session, null))
  assert.doesNotThrow(() => host.emit('session/event', session, { type: 'turn/start' }))
  assert.doesNotThrow(() => host.emit('session/event', null, { type: 'todo/write', data: { todos: 'nope' } }))
  assert.doesNotThrow(() => host.emit('session/event', session, { type: 'approval/asked' }))
  const out = callRoute(host, '/dsh-eta/state.json')
  assert.equal(out.status, 200)
  host.teardown()
})
