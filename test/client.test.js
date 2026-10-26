/**
 * 浏览器半侧的冒烟测试 —— 用一套最小的 DOM 垫片把 assets/eta-client.js 真的跑起来。
 *
 * 为什么值得写：客户端脚本是唯一「宿主测试覆盖不到」的部分，而它最典型的 bug
 * 都是静默的（属性名打错、字段读错、渲染分支写反），表现是「挂件不出现」或者
 * 「数字一直是 —」，光看代码很难发现。这里把快照喂进去，断言画出来的文字。
 *
 * 垫片刻意只实现脚本真正用到的那几个 API：多实现的每一行都可能掩盖真实问题。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'eta-client.js')

/* ---------- 最小 DOM 垫片 ---------- */

class FakeClassList {
  constructor() { this.set = new Set() }
  add(name) { this.set.add(name) }
  remove(name) { this.set.delete(name) }
  contains(name) { return this.set.has(name) }
}

class FakeNode {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.attributes = {}
    this.style = {}
    this.classList = new FakeClassList()
    this._text = ''
    this.listeners = {}
    this.offsetWidth = 236
    this.offsetHeight = 150
    this.offsetLeft = 0
    this.offsetTop = 0
  }

  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this._text = String(value == null ? '' : value)
    this.children = []
  }

  appendChild(child) {
    this.children.push(child)
    child.parentNode = this
    return child
  }

  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null }
  removeAttribute(name) { delete this.attributes[name] }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(handler)
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type] || []
    const at = list.indexOf(handler)
    if (at !== -1) list.splice(at, 1)
  }

  dispatch(type, event) {
    for (const handler of this.listeners[type] || []) handler(event || {})
  }

  getBoundingClientRect() {
    return { left: this.offsetLeft, top: this.offsetTop, width: this.offsetWidth, height: this.offsetHeight }
  }

  setPointerCapture() {}
  releasePointerCapture() {}

  querySelector(selector) {
    // 只回答主聊天界面的判定用到的那个选择器。
    if (selector === '[data-composer-input]') return { tag: 'composer' }
    return null
  }
}

function makeDocument() {
  const doc = {
    hidden: false,
    head: null,
    body: null,
    documentElement: null,
    listeners: {},
    byId: new Map(),
    createElement(tag) { return new FakeNode(tag, doc) },
    getElementById(id) {
      // 真实 DOM 里 appendChild 之后立刻就能查到；垫片必须一样，
      // 否则「挂件自己建完节点再查自己」这一步永远失败。
      const walk = (node) => {
        if (!node) return null
        if (node.id === id) return node
        for (const child of node.children) {
          const found = walk(child)
          if (found) return found
        }
        return null
      }
      if (doc.byId.has(id)) return doc.byId.get(id)
      return walk(doc.documentElement)
    },
    addEventListener(type, handler) {
      if (!doc.listeners[type]) doc.listeners[type] = []
      doc.listeners[type].push(handler)
    },
    dispatch(type, event) {
      for (const handler of doc.listeners[type] || []) handler(event || {})
    },
  }
  doc.documentElement = new FakeNode('html', doc)
  doc.head = new FakeNode('head', doc)
  doc.body = new FakeNode('body', doc)
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  return doc
}

/** 跑一遍客户端脚本，返回它用的 window/document 与「渲染后的挂件根节点」。 */
function bootClient(snapshotResponses, options) {
  const doc = makeDocument()
  const root = new FakeNode('div', doc)
  root.id = 'root'
  doc.byId.set('root', root)

  const storage = new Map()
  // 预置 localStorage：用来测「脏数据 / 上次留下的设置」这类启动路径。
  const seed = (options && options.storage) || {}
  Object.keys(seed).forEach((key) => storage.set(key, String(seed[key])))

  const timers = []
  let pollIndex = 0

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null },
      setItem(key, value) { storage.set(key, String(value)) },
      removeItem(key) { storage.delete(key) },
    },
    getComputedStyle() { return { backgroundColor: 'rgb(255, 255, 255)' } },
    fetch() {
      const payload = snapshotResponses[Math.min(pollIndex, snapshotResponses.length - 1)]
      pollIndex++
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
      })
    },
    addEventListener() {},
    dispatchEvent() {},
    requestAnimationFrame(handler) { handler(0) },
    setInterval(handler) { timers.push(handler); return timers.length },
    clearInterval() {},
    setTimeout(handler) { return 0 },
    clearTimeout() {},
    AbortController: class { constructor() { this.signal = {} } abort() {} },
    MutationObserver: class {
      constructor(handler) { this.handler = handler }
      observe() {}
      disconnect() {}
    },
    CustomEvent: class { constructor(type) { this.type = type } },
  }

  const sandbox = {
    window,
    document: doc,
    localStorage: window.localStorage,
    fetch: window.fetch,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    requestAnimationFrame: window.requestAnimationFrame,
    MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent,
    console,
    Date,
    Math,
    JSON,
    isFinite,
    parseFloat,
  }

  const source = fs.readFileSync(CLIENT, 'utf8')
  // 客户端脚本是一个 IIFE，靠 window/document 两个全局；用 with 把垫片塞进作用域。
  const runner = new Function('sandbox', 'with (sandbox) {' + source + '\n}')
  runner(sandbox)

  const widget = doc.getElementById('dsh-eta-root')
  assert.ok(widget, 'client must mount #dsh-eta-root once the chat root exists')
  return { doc, window, widget, storage, timers, poll: () => timers[0] && timers[0]() }
}

/** 取挂件里第一个 class 匹配的节点。 */
function nodeOf(widget, className) {
  const walk = (node) => {
    if (node.className === className) return node
    for (const child of node.children) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(widget)
}

/** 取挂件里第一个 class 匹配的节点的文字。 */
function textOf(widget, className) {
  const found = nodeOf(widget, className)
  return found === null ? null : found.textContent
}

/* ---------- 用例 ---------- */

test('客户端脚本语法正确、可执行，并挂出根节点', () => {
  const { widget } = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  assert.ok(widget)
  assert.equal(widget.id, 'dsh-eta-root')
})

test('空闲快照渲染成「还没有进行中的对话」', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textOf(ctx.widget, 'dsh-eta-sub'), '还没有进行中的对话')
  assert.equal(textOf(ctx.widget, 'dsh-eta-clock').indexOf('—') !== -1, true)
})

test('运行中快照把 ETA 时钟、剩余时长、进度条都画出来', async () => {
  const now = Date.now()
  const etaAt = now + 5 * 60_000
  const ctx = bootClient([{
    ok: true,
    now,
    sessions: [{
      id: 's1',
      title: '写个插件',
      phase: 'running',
      elapsedMs: 300_000,
      remainMs: 300_000,
      etaAt,
      confidence: 'medium',
      source: 'progress',
      progress: 0.5,
      total: 4,
      completed: 2,
      inProgress: 0,
      pending: 2,
      currentTask: '实现估算核心',
      steps: 6,
      paused: false,
      pausedMs: 0,
      updatedAt: now,
    }],
  }])
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '写个插件')
  const clockText = textOf(ctx.widget, 'dsh-eta-clock')
  assert.ok(/^\d{2}:\d{2}/.test(clockText), 'clock should start with HH:MM, got ' + clockText)
  assert.ok(clockText.indexOf('还有 5 分') !== -1, 'remaining shown, got ' + clockText)
  assert.equal(textOf(ctx.widget, 'dsh-eta-foot').indexOf('2/4 项') !== -1, true)
  assert.equal(textOf(ctx.widget, 'dsh-eta-badge'), '中等')
  assert.equal(textOf(ctx.widget, 'dsh-eta-task'), '正在做：实现估算核心')
})

test('remainMs 为 null 时不硬报时间点', async () => {
  const now = Date.now()
  const ctx = bootClient([{
    ok: true,
    now,
    sessions: [{
      id: 's2', title: '', phase: 'running', elapsedMs: 12_000,
      remainMs: null, etaAt: null, confidence: 'none', source: 'none',
      progress: 0, total: 0, completed: 0, inProgress: 0, pending: 0,
      currentTask: '', steps: 1, paused: false, pausedMs: 0, updatedAt: now,
    }],
  }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textOf(ctx.widget, 'dsh-eta-clock'), '—')
  assert.ok(textOf(ctx.widget, 'dsh-eta-sub').indexOf('还看不出节奏') !== -1)
  assert.equal(textOf(ctx.widget, 'dsh-eta-badge'), '样本不足')
})

test('挂起中显示「等你操作」，且不把等待算进工期', async () => {
  const now = Date.now()
  const ctx = bootClient([{
    ok: true,
    now,
    sessions: [{
      id: 's3', title: '', phase: 'running', elapsedMs: 60_000,
      remainMs: 60_000, etaAt: now + 60_000, confidence: 'low', source: 'progress',
      progress: 0.5, total: 2, completed: 1, inProgress: 0, pending: 1,
      currentTask: '', steps: 3, paused: true, pausedMs: 90_000, updatedAt: now,
    }],
  }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(textOf(ctx.widget, 'dsh-eta-pause').indexOf('不计入工期') !== -1)
})

test('已完成快照显示「已完成」与上一轮用时', async () => {
  const now = Date.now()
  const ctx = bootClient([{
    ok: true,
    now,
    sessions: [{
      id: 's4', title: '', phase: 'done', endReason: 'completed',
      elapsedMs: 125_000, remainMs: null, etaAt: null, confidence: 'none', source: 'none',
      progress: 1, total: 3, completed: 3, inProgress: 0, pending: 0,
      currentTask: '', steps: 9, paused: false, pausedMs: 0, updatedAt: now,
    }],
  }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textOf(ctx.widget, 'dsh-eta-clock'), '已完成')
  assert.ok(textOf(ctx.widget, 'dsh-eta-sub').indexOf('上一轮用时') !== -1)
})

test('收起按钮切换状态并写进 localStorage', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const head = ctx.widget.children[0]
  const toggle = head.children[1]
  assert.equal(ctx.widget.classList.contains('dsh-eta-root-collapsed'), false)
  toggle.dispatch('click', { stopPropagation() {} })
  assert.equal(ctx.widget.classList.contains('dsh-eta-root-collapsed'), true)
  const saved = JSON.parse(ctx.storage.get('dsh-eta-forecast:v1'))
  assert.equal(saved.collapsed, true)
})

test('隐藏按钮把挂件藏起来，并能靠双击热区叫回来', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const head = ctx.widget.children[0]
  const hide = head.children[2]
  hide.dispatch('click', { stopPropagation() {} })
  assert.equal(ctx.widget.getAttribute('data-hidden'), '1')

  // 右下角双击
  ctx.doc.dispatch('dblclick', { clientX: ctx.window.innerWidth - 10, clientY: ctx.window.innerHeight - 10 })
  assert.equal(ctx.widget.getAttribute('data-hidden'), null)
})

test('宿主返回 3 次失败才清空显示（一次抖动不该抹掉 ETA）', async () => {
  const now = Date.now()
  const good = {
    ok: true, now, sessions: [{
      id: 's5', title: '任务', phase: 'running', elapsedMs: 60_000,
      remainMs: 60_000, etaAt: now + 60_000, confidence: 'medium', source: 'progress',
      progress: 0.5, total: 2, completed: 1, inProgress: 0, pending: 1,
      currentTask: '', steps: 3, paused: false, pausedMs: 0, updatedAt: now,
    }],
  }
  const ctx = bootClient([good])
  await new Promise((resolve) => setImmediate(resolve))
  const before = textOf(ctx.widget, 'dsh-eta-title')
  assert.equal(before, '任务')

  // 把 fetch 换成失败，连拉 2 次 —— 仍应保留旧内容
  ctx.window.fetch = () => Promise.reject(new Error('boom'))
  ctx.poll(); ctx.poll()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '任务', 'one or two failures must not wipe the panel')

  // 第 3 次失败才清
  ctx.poll()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textOf(ctx.widget, 'dsh-eta-sub'), '还没有进行中的对话')
})

/* ---------- 缩放与壁纸 ---------- */

/** 在子树里收集所有 className 匹配的节点。 */
function allOf(node, className) {
  const out = []
  const walk = (current) => {
    if (current.className === className) out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

/** 在子树里找第一个 type 匹配的 input。 */
function inputOf(node, type) {
  const walk = (current) => {
    if (current.tagName === 'INPUT' && current.type === type) return current
    for (const child of current.children) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(node)
}

/** 在子树里按文字找按钮。 */
function buttonOf(node, label) {
  const walk = (current) => {
    if (current.tagName === 'BUTTON' && current.textContent === label) return current
    for (const child of current.children) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(node)
}

const CLICK = { stopPropagation() {} }

/** 打开设置面板，返回面板节点。 */
async function openPanel(ctx) {
  const head = ctx.widget.children[0]
  const gear = head.children[3]
  assert.ok(gear, 'gear button must exist in the title row')
  gear.dispatch('click', CLICK)
  const panel = ctx.doc.getElementById('dsh-eta-panel')
  assert.ok(panel, 'panel must be mounted after clicking the gear')
  assert.equal(panel.getAttribute('data-hidden'), null)
  return panel
}

test('齿轮按钮打开设置面板，再点一次收起', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))

  const panel = await openPanel(ctx)
  assert.equal(ctx.widget.getAttribute('data-hidden'), null, 'opening settings must not hide the widget')

  // 面板是独立的顶层节点，不跟着挂件缩放变小
  assert.equal(panel.id, 'dsh-eta-panel')
  assert.equal(panel.parentNode, ctx.doc.body)

  ctx.widget.children[0].children[3].dispatch('click', CLICK)
  assert.equal(panel.getAttribute('data-hidden'), '1')
})

test('缩放滑块按比例缩卡片，并把值记进 localStorage', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)

  const zoom = inputOf(panel, 'range')
  assert.ok(zoom, 'zoom range input must exist')
  assert.equal(zoom.min, '25')
  assert.equal(zoom.max, '100')

  zoom.value = '50'
  zoom.dispatch('input')
  assert.equal(ctx.widget.style.transform, 'scale(0.5)')

  const saved = JSON.parse(ctx.storage.get('dsh-eta-forecast:v1'))
  assert.equal(saved.zoom, 50)

  // 100% 时不该留一个恒等变换（省掉无谓的合成层）
  zoom.value = '100'
  zoom.dispatch('input')
  assert.equal(ctx.widget.style.transform, '')
})

test('缩放值超出范围时被夹回 25%~100%', async () => {
  // 手改过 localStorage 的脏数据不该让卡片缩成看不见的一点。
  // 必须在启动前就写好：设置是在 build() 时读一次，之后再改 storage 不会重读。
  const ctx = bootClient(
    [{ ok: true, now: Date.now(), sessions: [] }],
    { storage: { 'dsh-eta-forecast:v1': JSON.stringify({ zoom: 3 }) } },
  )
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)
  const zoom = inputOf(panel, 'range')
  assert.equal(zoom.value, '25', 'below-min stored zoom must clamp to 25')
  assert.equal(ctx.widget.style.transform, 'scale(0.25)', 'and the card itself must be clamped too')
})

test('壁纸链接生效、清除后复原，且存在独立键里', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)

  const url = inputOf(panel, 'text')
  assert.ok(url, 'wallpaper url input must exist')
  url.value = 'https://example.com/sky.jpg'
  buttonOf(panel, '用链接').dispatch('click', CLICK)

  assert.equal(ctx.widget.getAttribute('data-wallpaper'), '1')
  const bg = allOf(ctx.widget, 'dsh-eta-bg')[0]
  assert.ok(bg, 'wallpaper layer must exist')
  assert.ok(bg.style.backgroundImage.indexOf('https://example.com/sky.jpg') !== -1,
    'wallpaper url applied, got ' + bg.style.backgroundImage)

  // 壁纸必须存在单独的键里 —— 否则每拖一次滑块都要重写几百 KB
  assert.equal(ctx.storage.get('dsh-eta-forecast:wallpaper'), 'https://example.com/sky.jpg')
  const settings = JSON.parse(ctx.storage.get('dsh-eta-forecast:v1') || '{}')
  assert.equal(settings.wallpaper, undefined, 'wallpaper must NOT be inside the settings blob')

  buttonOf(panel, '清除壁纸').dispatch('click', CLICK)
  assert.equal(ctx.widget.getAttribute('data-wallpaper'), null)
  assert.equal(ctx.storage.has('dsh-eta-forecast:wallpaper'), false)
})

test('空链接不会把壁纸清掉（避免误触）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)

  const url = inputOf(panel, 'text')
  url.value = 'https://example.com/a.jpg'
  buttonOf(panel, '用链接').dispatch('click', CLICK)
  assert.equal(ctx.widget.getAttribute('data-wallpaper'), '1')

  url.value = '   '
  buttonOf(panel, '用链接').dispatch('click', CLICK)
  assert.equal(ctx.widget.getAttribute('data-wallpaper'), '1', 'blank url must be a no-op, not a clear')
})

test('模糊与暗化只作用于壁纸层，不污染卡片本身', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)

  const url = inputOf(panel, 'text')
  url.value = 'https://example.com/b.jpg'
  buttonOf(panel, '用链接').dispatch('click', CLICK)

  const ranges = allOf(panel, 'dsh-eta-row')
    .map((row) => inputOf(row, 'range'))
    .filter(Boolean)
  // [缩放, 模糊, 暗化, 卡片不透明度]
  assert.equal(ranges.length, 4, 'expected zoom + blur + dim + alpha sliders')

  ranges[1].value = '8'
  ranges[1].dispatch('input')
  ranges[2].value = '0.5'
  ranges[2].dispatch('input')

  const bg = allOf(ctx.widget, 'dsh-eta-bg')[0]
  const dim = allOf(ctx.widget, 'dsh-eta-dim')[0]
  const wash = allOf(ctx.widget, 'dsh-eta-wash')[0]
  assert.equal(bg.style.filter, 'blur(8px)')
  assert.equal(dim.style.background, 'rgba(0,0,0,0.5)')
  // 卡片本身不该被模糊：模糊只属于壁纸层，卡片只有底色透明度。
  assert.ok(!ctx.widget.style.filter, 'card itself must not be blurred')
  // 卡片底色必须画在壁纸**上面**（wash 层），否则「卡片不透明度」是个死滑块，
  // 深色壁纸上的深色文字也会糊成一片。
  assert.ok(wash, 'wash layer must exist')
  // 只断言「底色是半透明白」，不断言具体数值 —— 默认值会随观感调整，
  // 写死在测试里只会让每次调参都得改测试。
  assert.ok(/^rgba\(255,255,255,0\.\d+\)$/.test(wash.style.background),
    'wash must be a semi-transparent theme colour, got ' + wash.style.background)
  assert.equal(ctx.widget.style.background, 'transparent', 'root bg must not sit under the wallpaper')
})

test('恢复默认把缩放、壁纸、位置、折叠全部还原', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)

  const zoom = inputOf(panel, 'range')
  zoom.value = '40'
  zoom.dispatch('input')
  const url = inputOf(panel, 'text')
  url.value = 'https://example.com/c.jpg'
  buttonOf(panel, '用链接').dispatch('click', CLICK)
  assert.equal(ctx.widget.getAttribute('data-wallpaper'), '1')

  buttonOf(panel, '恢复默认').dispatch('click', CLICK)

  assert.equal(ctx.widget.style.transform, '')
  assert.equal(ctx.widget.getAttribute('data-wallpaper'), null)
  assert.equal(ctx.storage.has('dsh-eta-forecast:wallpaper'), false)
  const saved = JSON.parse(ctx.storage.get('dsh-eta-forecast:v1'))
  assert.equal(saved.zoom, 100)
  assert.equal(saved.collapsed, false)
})

test('点标题行上的按钮不会顺手把卡片拖走', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const head = ctx.widget.children[0]
  const gear = head.children[3]

  // 挂载时会把 right/bottom 折算成 left/top，所以基线不是 undefined。
  const baselineLeft = ctx.widget.style.left
  assert.ok(baselineLeft, 'mount must normalise the position to left/top')

  // 模拟 pointerdown 落在齿轮上：target 是 BUTTON
  head.dispatch('pointerdown', { button: 0, target: gear, clientX: 10, clientY: 10, pointerId: 1 })
  head.dispatch('pointermove', { clientX: 400, clientY: 400, pointerId: 1 })
  head.dispatch('pointerup', { pointerId: 1 })
  assert.equal(ctx.widget.style.left, baselineLeft, 'button click must not start a drag')

  // 落在标题文字上才应该拖
  head.dispatch('pointerdown', { button: 0, target: head.children[0], clientX: 10, clientY: 10, pointerId: 2 })
  head.dispatch('pointermove', { clientX: 300, clientY: 200, pointerId: 2 })
  assert.notEqual(ctx.widget.style.left, baselineLeft, 'dragging from the title must move the card')
  head.dispatch('pointerup', { pointerId: 2 })
})
