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

  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at !== -1) this.children.splice(at, 1)
    child.parentNode = null
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

  /**
   * 派发事件并**沿父链冒泡** —— 真实 DOM 就是这个行为。
   *
   * 挂件把拖动/右键监听挂在根节点上（用户要求「所有地方都能拖」），
   * 如果垫片不冒泡，从子节点派发的事件就永远到不了根节点，
   * 测出来的失败是垫片的假象，不是代码的问题。
   */
  dispatch(type, event) {
    const payload = event || {}
    if (payload.target === undefined) payload.target = this
    let node = this
    while (node) {
      for (const handler of node.listeners[type] || []) handler(payload)
      node = node.parentNode
    }
    return payload
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

  /** 真实 DOM 有 contains；右键菜单要靠它判断「点的是不是菜单自己」。 */
  contains(node) {
    if (node === this) return true
    const walk = (current) => {
      if (!current) return false
      if (current === node) return true
      return current.children.some(walk)
    }
    return walk(this)
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
  // 桌面端分支靠这个属性判定（客户端在加载时读一次）。
  if (options && options.desktop) {
    doc.documentElement.setAttribute('data-dsh-eta-desktop', '1')
  }
  const root = new FakeNode('div', doc)
  root.id = 'root'
  doc.byId.set('root', root)

  const storage = new Map()
  // 预置 localStorage：用来测「脏数据 / 上次留下的设置」这类启动路径。
  const seed = (options && options.storage) || {}
  Object.keys(seed).forEach((key) => storage.set(key, String(seed[key])))

  const timers = []
  let pollIndex = 0
  /**
   * 桌面端把拖动位移通过 window 上的 CustomEvent 交给渲染壳，
   * 所以垫片必须真的把事件与 detail 记下来 —— 否则这条路径完全测不到。
   */
  const desktopEvents = []

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
    dispatchEvent(event) {
      // 别写 `event.detail || {}`：false 是合法 detail（busy 释放），会被吞掉。
      desktopEvents.push({
        type: event && event.type,
        detail: event && 'detail' in event ? event.detail : {},
      })
      return true
    },
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
    CustomEvent: class {
      // 同上：detail 可能是 false，不能被 `|| {}` 吃掉。
      constructor(type, init) {
        this.type = type
        this.detail = init && 'detail' in init ? init.detail : {}
      }
    },
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
  return {
    doc, window, widget, storage, timers, desktopEvents,
    poll: () => timers[0] && timers[0](),
  }
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

/* ---------- 进度条：该显示时显示、该藏时藏 ---------- */

/** 取进度条节点。 */
function barOf(ctx) {
  return nodeOf(ctx.widget, 'dsh-eta-bar')
}

test('有进度时进度条显示并填到对应比例', async () => {
  const now = Date.now()
  const ctx = bootClient([{
    ok: true,
    now,
    sessions: [{
      id: 's1', title: '', phase: 'running', elapsedMs: 60_000,
      remainMs: 60_000, etaAt: now + 60_000, confidence: 'medium', source: 'progress',
      progress: 0.57, progressSource: 'todos', total: 7, completed: 4, inProgress: 0, pending: 3,
      currentTask: '', steps: 11, paused: false, pausedMs: 0, updatedAt: now,
    }],
  }])
  await new Promise((resolve) => setImmediate(resolve))

  const bar = barOf(ctx)
  assert.equal(bar.getAttribute('data-on'), '1', 'bar must be visible when progress exists')
  assert.equal(bar.getAttribute('data-source'), 'todos')
  assert.equal(nodeOf(ctx.widget, 'dsh-eta-fill').style.width, '57.0%')
})

test('没有进度时整条隐藏（不留永远填不满的灰条）', async () => {
  const now = Date.now()
  const ctx = bootClient([{
    ok: true,
    now,
    sessions: [{
      id: 's1', title: '', phase: 'running', elapsedMs: 5000,
      remainMs: null, etaAt: null, confidence: 'none', source: 'none',
      progress: null, progressSource: 'none', total: 0, completed: 0, inProgress: 0, pending: 0,
      currentTask: '', steps: 1, paused: false, pausedMs: 0, updatedAt: now,
    }],
  }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(barOf(ctx).getAttribute('data-on'), '0',
    'a progress bar with nothing to show must be hidden, not left as an empty grey strip')
})

test('步数代理的进度标注来源，不冒充清单进度', async () => {
  const now = Date.now()
  const ctx = bootClient([{
    ok: true,
    now,
    sessions: [{
      id: 's1', title: '', phase: 'running', elapsedMs: 60_000,
      remainMs: 60_000, etaAt: now + 60_000, confidence: 'low', source: 'steps',
      progress: 0.33, progressSource: 'steps', total: 0, completed: 0, inProgress: 0, pending: 0,
      currentTask: '', steps: 8, paused: false, pausedMs: 0, updatedAt: now,
    }],
  }])
  await new Promise((resolve) => setImmediate(resolve))

  const bar = barOf(ctx)
  assert.equal(bar.getAttribute('data-on'), '1')
  assert.equal(bar.getAttribute('data-source'), 'steps', 'steps-derived progress must be marked as such')
  assert.ok(bar.title.indexOf('步数') !== -1, 'tooltip should say it is a step estimate, got ' + bar.title)
})

test('空闲（没有会话）时进度条也隐藏', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(barOf(ctx).getAttribute('data-on'), '0')
})

test('收起按钮切换状态并写进 localStorage', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const toggle = headOf(ctx).children[1]
  assert.equal(ctx.widget.classList.contains('dsh-eta-root-collapsed'), false)
  toggle.dispatch('click', { stopPropagation() {} })
  assert.equal(ctx.widget.classList.contains('dsh-eta-root-collapsed'), true)
  const saved = JSON.parse(ctx.storage.get('dsh-eta-forecast:v1'))
  assert.equal(saved.collapsed, true)
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

/**
 * 取标题行。
 *
 * 按 class 找而不是下标 —— 卡片在标题行**上方**多了一行会话切换器
 * （`.dsh-eta-switcher`），`children[0]` 已经不是标题了。
 * 按语义找，以后再加行也不会把这一串测试全打翻。
 */
function headOf(ctx) {
  const head = nodeOf(ctx.widget, 'dsh-eta-head')
  assert.ok(head, 'title row must exist')
  return head
}

/** 标题行里的按钮：[展开/收起, 齿轮]（「隐藏挂件」已按用户要求删除）。 */
function headButtons(ctx) {
  return headOf(ctx).children.filter((child) => child.tagName === 'BUTTON')
}

/** 打开设置面板，返回面板节点。 */
async function openPanel(ctx) {
  const gear = headButtons(ctx)[1]
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

  // 面板是独立的顶层节点，不跟着挂件缩放变小
  assert.equal(panel.id, 'dsh-eta-panel')
  assert.equal(panel.parentNode, ctx.doc.body)

  headButtons(ctx)[1].dispatch('click', CLICK)
  assert.equal(panel.getAttribute('data-hidden'), '1')
})

test('标题行只剩「收起」和「齿轮」两个按钮（隐藏挂件已删除）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const buttons = headButtons(ctx)
  assert.equal(buttons.length, 2, 'expected exactly two title-row buttons, got ' + buttons.length)
  assert.equal(buttons[0].textContent, '−', 'first is collapse')
  assert.equal(buttons[1].textContent, '⚙', 'second is settings')
  // 全页面上不该再有任何「隐藏挂件」入口
  const panel = rightClick(ctx)
  const labels = []
  const walk = (node) => {
    if (node.tagName === 'BUTTON') labels.push(node.textContent)
    for (const child of node.children) walk(child)
  }
  walk(panel)
  assert.equal(labels.indexOf('隐藏挂件'), -1, 'hiding must be gone, got ' + labels)
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
  const head = headOf(ctx)
  const gear = headButtons(ctx)[1]

  // 挂载时会把 right/bottom 折算成 left/top，所以基线不是 undefined。
  const baselineLeft = ctx.widget.style.left
  assert.ok(baselineLeft, 'mount must normalise the position to left/top')

  // 模拟左键 pointerdown 落在齿轮上：target 是 BUTTON
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

test('整张卡片左键都能拖（不只是标题行）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const baselineLeft = ctx.widget.style.left

  // 在 body 区域（时钟/进度条那一块）按下左键**向右下**拖。
  // 方向很重要：垫片里 offsetLeft/Top 恒为 0，往左上拖会被「夹回屏幕内」算成 0，
  // 那样即使代码正确断言也会失败。
  ctx.widget.dispatch('pointerdown', { button: 0, target: ctx.widget, clientX: 500, clientY: 500, pointerId: 11 })
  ctx.widget.dispatch('pointermove', { clientX: 700, clientY: 600, pointerId: 11 })
  assert.notEqual(ctx.widget.style.left, baselineLeft, 'the whole card must be draggable with the left button')
  ctx.widget.dispatch('pointerup', { pointerId: 11 })
})

test('按住右键拖动也能移动卡片', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const baselineLeft = ctx.widget.style.left

  ctx.widget.dispatch('pointerdown', { button: 2, clientX: 600, clientY: 600, pointerId: 12 })
  ctx.widget.dispatch('pointermove', { clientX: 800, clientY: 700, pointerId: 12 })
  assert.notEqual(ctx.widget.style.left, baselineLeft, 'right-button drag must move the card')
  ctx.widget.dispatch('pointerup', { button: 2, clientX: 800, clientY: 700, pointerId: 12 })

  // 拖动之后不该再弹菜单（拖了就不是"点一下"）
  const menu = ctx.doc.getElementById('dsh-eta-ctxmenu')
  if (menu) assert.equal(menu.getAttribute('data-hidden'), '1', 'a right-drag must not open the menu')
})

test('右键原地轻点（不移动）打开设置面板', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const baselineLeft = ctx.widget.style.left

  ctx.widget.dispatch('pointerdown', { button: 2, clientX: 600, clientY: 600, pointerId: 13 })
  ctx.widget.dispatch('pointerup', { button: 2, clientX: 600, clientY: 600, pointerId: 13 })

  assert.equal(ctx.widget.style.left, baselineLeft, 'a right-click must not move the card')
  const panel = ctx.doc.getElementById('dsh-eta-panel')
  assert.ok(panel, 'right-click must build the settings panel')
  assert.equal(panel.getAttribute('data-hidden'), null, 'and show it')
})

test('缩到很小时留一块能点开的逃生热区', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)
  const zoom = inputOf(panel, 'range')

  // 60% 及以上：齿轮还点得到，不需要额外热区
  zoom.value = '100'
  zoom.dispatch('input')
  assert.equal(ctx.doc.getElementById('dsh-eta-hotspot'), null, 'no hotspot at full size')

  // 25%：齿轮只有约 4.5px，必须有逃生门
  zoom.value = '25'
  zoom.dispatch('input')
  const spot = ctx.doc.getElementById('dsh-eta-hotspot')
  assert.ok(spot, 'hotspot must appear at small zoom')
  assert.equal(spot.style.width, '44px', 'hotspot must stay a comfortable size regardless of zoom')

  // 双击热区能把面板叫回来（哪怕面板已经被关掉）
  const close = ctx.doc.getElementById('dsh-eta-panel').children[0].children[1]
  close.dispatch('click', CLICK)
  assert.equal(ctx.doc.getElementById('dsh-eta-panel').getAttribute('data-hidden'), '1')
  spot.dispatch('dblclick', CLICK)
  assert.equal(ctx.doc.getElementById('dsh-eta-panel').getAttribute('data-hidden'), null,
    'double-clicking the hotspot must reopen the settings panel')

  // 放大回去，热区要收掉，不能留一块隐形的点击区在页面上
  zoom.value = '100'
  zoom.dispatch('input')
  assert.equal(ctx.doc.getElementById('dsh-eta-hotspot'), null, 'hotspot must be removed when zooming back up')
})

test('隐藏挂件时热区一起消失', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)
  const zoom = inputOf(panel, 'range')
  zoom.value = '25'
  zoom.dispatch('input')
  assert.ok(ctx.doc.getElementById('dsh-eta-hotspot'))

  // 挂件再也不能隐藏了：这条用例改成「缩小后热区仍在、放大后消失」的回归保护。
  zoom.value = '100'
  zoom.dispatch('input')
  assert.equal(ctx.doc.getElementById('dsh-eta-hotspot'), null,
    'zooming back to full size must remove the escape hotspot')
})

/* ---------- 隐藏菜单按钮 + 右键菜单 ---------- */

/** 在设置面板里找到「隐藏菜单按钮」那个 checkbox。 */
function menuToggleOf(panel) {
  return inputOf(panel, 'checkbox')
}

/**
 * 右键"点一下"卡片（按下后原地松开，不移动）→ 应直接打开设置面板。
 *
 * 注意：这个动作由拖动的 pointerup 触发，而不是 contextmenu 事件 ——
 * 因为右键同时承担了拖动。所以这里模拟的是真实的按下-松开序列。
 */
function rightClick(ctx) {
  const root = ctx.widget
  root.dispatch('pointerdown', { button: 2, clientX: 300, clientY: 300, pointerId: 90 })
  root.dispatch('pointerup', { button: 2, clientX: 300, clientY: 300, pointerId: 90 })
  return ctx.doc.getElementById('dsh-eta-panel')
}

test('设置面板里有「隐藏菜单按钮」开关，默认关着', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)

  const toggle = menuToggleOf(panel)
  assert.ok(toggle, 'the panel must offer a 隐藏菜单按钮 checkbox')
  assert.equal(toggle.checked, false, 'defaults to off — new users need the buttons')
  assert.equal(ctx.widget.getAttribute('data-menu-hidden'), null, 'buttons visible by default')
})

test('打开「隐藏菜单按钮」后按钮消失，并记住设置', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))
  const panel = await openPanel(ctx)

  const toggle = menuToggleOf(panel)
  toggle.checked = true
  toggle.dispatch('change')

  assert.equal(ctx.widget.getAttribute('data-menu-hidden'), '1',
    'turning the switch on must hide the title-row buttons')
  const saved = JSON.parse(ctx.storage.get('dsh-eta-forecast:v1'))
  assert.equal(saved.menuHidden, true)
})

test('设置从 localStorage 读回：上次关了按钮，重开页面还是关着', async () => {
  const ctx = bootClient(
    [{ ok: true, now: Date.now(), sessions: [] }],
    { storage: { 'dsh-eta-forecast:v1': JSON.stringify({ menuHidden: true }) } },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ctx.widget.getAttribute('data-menu-hidden'), '1', 'menuHidden must survive a reload')
})

test('右键直接打开设置面板（不再经过中间菜单）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))

  const panel = rightClick(ctx)
  assert.ok(panel, 'right-click must build the settings panel')
  assert.equal(panel.getAttribute('data-hidden'), null, 'and show it')
  assert.equal(panel.parentNode, ctx.doc.body, 'panel lives on body so it does not scale with the card')

  // 面板里该有的东西都在，包括从菜单挪进来的「回到右下角」
  assert.ok(inputOf(panel, 'range'), 'has sliders')
  assert.ok(inputOf(panel, 'checkbox'), 'has the menu-hidden toggle')
  assert.ok(buttonOf(panel, '回到右下角'), 'reposition fallback must move into the panel')
  assert.ok(buttonOf(panel, '恢复默认'), 'has reset')

  // 中间菜单那层已经不存在了
  assert.equal(ctx.doc.getElementById('dsh-eta-ctxmenu'), null, 'no intermediate context menu any more')
})

test('按钮隐藏后，右键一样能打开设置面板', async () => {
  const ctx = bootClient(
    [{ ok: true, now: Date.now(), sessions: [] }],
    { storage: { 'dsh-eta-forecast:v1': JSON.stringify({ menuHidden: true }) } },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ctx.widget.getAttribute('data-menu-hidden'), '1')

  const panel = rightClick(ctx)
  assert.equal(panel.getAttribute('data-hidden'), null,
    'right-click is the only entry once the buttons are hidden — it must open settings')
})

test('设置面板里的「回到右下角」能把卡片挪回去', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))

  const panel = rightClick(ctx)
  assert.ok(ctx.widget.style.left, 'card has a normalised position')

  buttonOf(panel, '回到右下角').dispatch('click', CLICK)
  // 挪动是异步的（等一帧算尺寸），等它落地
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(ctx.widget.style.left, 'card must still have an explicit position after repositioning')
})

test('右键拖动之后不会打开设置面板（拖了就不是点击）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }])
  await new Promise((resolve) => setImmediate(resolve))

  ctx.widget.dispatch('pointerdown', { button: 2, clientX: 600, clientY: 600, pointerId: 91 })
  ctx.widget.dispatch('pointermove', { clientX: 800, clientY: 700, pointerId: 91 })
  ctx.widget.dispatch('pointerup', { button: 2, clientX: 800, clientY: 700, pointerId: 91 })

  const panel = ctx.doc.getElementById('dsh-eta-panel')
  if (panel) assert.equal(panel.getAttribute('data-hidden'), '1', 'a right-drag must not open settings')
})

test('恢复默认也把「隐藏菜单按钮」还原成显示状态', async () => {
  const ctx = bootClient(
    [{ ok: true, now: Date.now(), sessions: [] }],
    { storage: { 'dsh-eta-forecast:v1': JSON.stringify({ menuHidden: true }) } },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ctx.widget.getAttribute('data-menu-hidden'), '1')

  const panel = await openPanel(ctx)
  buttonOf(panel, '恢复默认').dispatch('click', CLICK)

  assert.equal(ctx.widget.getAttribute('data-menu-hidden'), null, 'reset must bring the buttons back')
  const saved = JSON.parse(ctx.storage.get('dsh-eta-forecast:v1'))
  assert.equal(saved.menuHidden, false)
})

/* ---------- 会话切换（左上角胶囊） ---------- */

/** 造一条运行中的会话快照。 */
function sessionSnap(id, title, extra) {
  const now = Date.now()
  return Object.assign({
    id, title, phase: 'running', elapsedMs: 60_000, remainMs: 60_000,
    etaAt: now + 60_000, confidence: 'medium', source: 'steps',
    progress: 0.5, total: 2, completed: 1, inProgress: 0, pending: 1,
    currentTask: '', steps: 5, paused: false, pausedMs: 0, updatedAt: now,
  }, extra || {})
}

/** 取切换行里的所有胶囊。 */
function chipsOf(ctx) {
  const bar = nodeOf(ctx.widget, 'dsh-eta-switcher')
  if (!bar) return []
  return bar.children.filter((child) => child.className === 'dsh-eta-chip')
}

test('只有一条会话时不显示切换行（没得切）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [sessionSnap('s1', '唯一会话')] }])
  await new Promise((resolve) => setImmediate(resolve))
  const bar = nodeOf(ctx.widget, 'dsh-eta-switcher')
  assert.ok(bar, 'switcher row must exist in the DOM')
  assert.equal(bar.getAttribute('data-visible'), '0', 'a single session must not show the switcher')
  assert.equal(chipsOf(ctx).length, 0)
})

test('两条以上会话时显示切换行，并标出当前那条', async () => {
  const ctx = bootClient([{
    ok: true,
    now: Date.now(),
    sessions: [sessionSnap('s1', '第一条'), sessionSnap('s2', '第二条'), sessionSnap('s3', '第三条')],
  }])
  await new Promise((resolve) => setImmediate(resolve))

  const bar = nodeOf(ctx.widget, 'dsh-eta-switcher')
  assert.equal(bar.getAttribute('data-visible'), '1')
  const chips = chipsOf(ctx)
  assert.equal(chips.length, 3, 'one chip per session, got ' + chips.length)
  assert.equal(chips[0].getAttribute('data-active'), '1', 'first is active by default')
  assert.equal(chips[1].getAttribute('data-active'), '0')
  // 标题就是胶囊文案
  assert.equal(chips[1].textContent, '第二条')
  // 运行中的会有标记
  assert.equal(chips[0].getAttribute('data-running'), '1')
})

test('点另一个胶囊立刻切换卡片内容（不等下一轮轮询）', async () => {
  const ctx = bootClient([{
    ok: true,
    now: Date.now(),
    sessions: [
      // steps 不同、清单也不同：用清单区分，因为底部优先显示「x/y 项」
      sessionSnap('s1', '第一条', { total: 0, steps: 5 }),
      sessionSnap('s2', '第二条', { total: 0, steps: 42 }),
    ],
  }])
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '第一条')
  assert.equal(textOf(ctx.widget, 'dsh-eta-foot').indexOf('第 5 步') !== -1, true)

  chipsOf(ctx)[1].dispatch('click', CLICK)

  // 立刻变成第二条的内容 —— 这是「点了就要有反应」的关键
  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '第二条')
  assert.equal(textOf(ctx.widget, 'dsh-eta-foot').indexOf('第 42 步') !== -1, true,
    'switching must re-render immediately, got ' + textOf(ctx.widget, 'dsh-eta-foot'))
  assert.equal(chipsOf(ctx)[1].getAttribute('data-active'), '1')
  assert.equal(chipsOf(ctx)[0].getAttribute('data-active'), '0')
})

test('切换后的选择下一轮轮询仍然保持（不被自动排序拉回）', async () => {
  const now = Date.now()
  // 宿主把运行中的排在前面；用户手动选了「已结束」那条，轮询不该把选择抢回去。
  const running = sessionSnap('s1', '在跑的', { phase: 'running' })
  const done = sessionSnap('s2', '已完成的', {
    phase: 'done', endReason: 'completed', elapsedMs: 120_000, remainMs: null, etaAt: null,
    progress: 1, total: 2, completed: 2, inProgress: 0, pending: 0, updatedAt: now - 1000,
  })
  const ctx = bootClient([{ ok: true, now, sessions: [running, done] }])
  await new Promise((resolve) => setImmediate(resolve))

  chipsOf(ctx)[1].dispatch('click', CLICK)
  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '已完成的')

  // 触发下一次轮询（同一个 payload）
  ctx.poll()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '已完成的',
    'polling must not steal the user choice back to the default session')
  assert.equal(chipsOf(ctx)[1].getAttribute('data-active'), '1')
})

test('钉住的会话消失后自动回落到默认会话', async () => {
  const payloadTwo = {
    ok: true,
    now: Date.now(),
    sessions: [sessionSnap('s1', '第一条'), sessionSnap('s2', '第二条')],
  }
  const ctx = bootClient([payloadTwo])
  await new Promise((resolve) => setImmediate(resolve))

  chipsOf(ctx)[1].dispatch('click', CLICK)
  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '第二条')

  // 下一条快照里「第二条」不见了（会话被清理）
  ctx.window.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({
      ok: true, now: Date.now(), sessions: [sessionSnap('s1', '第一条')],
    }),
  })
  ctx.poll()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(textOf(ctx.widget, 'dsh-eta-title'), '第一条',
    'a vanished session must fall back to the default instead of going blank')
  assert.equal(nodeOf(ctx.widget, 'dsh-eta-switcher').getAttribute('data-visible'), '0',
    'back to one session → switcher hides itself')
})

test('没有标题的会话用 id 尾巴当胶囊文案（而不是全叫「未命名」）', async () => {
  const ctx = bootClient([{
    ok: true,
    now: Date.now(),
    sessions: [
      sessionSnap('session-abcdef12-3456', ''),
      sessionSnap('session-99ff00aa-bbbb', ''),
    ],
  }])
  await new Promise((resolve) => setImmediate(resolve))
  const chips = chipsOf(ctx)
  assert.equal(chips.length, 2)
  assert.notEqual(chips[0].textContent, chips[1].textContent, 'two untitled sessions must be distinguishable')
  assert.ok(chips[0].textContent.indexOf('abcd') !== -1, 'label should use the id tail, got ' + chips[0].textContent)
})

test('点胶囊不会顺手把卡片拖走', async () => {
  const ctx = bootClient([{
    ok: true,
    now: Date.now(),
    sessions: [sessionSnap('s1', '第一条'), sessionSnap('s2', '第二条')],
  }])
  await new Promise((resolve) => setImmediate(resolve))
  const baselineLeft = ctx.widget.style.left

  const chip = chipsOf(ctx)[1]
  // 胶囊自己 stopPropagation，所以卡片的拖动逻辑收不到这个按下。
  // 事件对象必须带 stopPropagation —— 真实的事件永远有它。
  chip.dispatch('pointerdown', {
    button: 0, clientX: 100, clientY: 100, pointerId: 77, stopPropagation() {},
  })
  chip.dispatch('pointermove', { clientX: 300, clientY: 300, pointerId: 77 })
  chip.dispatch('pointerup', { pointerId: 77 })

  assert.equal(ctx.widget.style.left, baselineLeft, 'clicking a chip must not drag the card')
})

/* ---------- 桌面端：拖的是窗口，不是元素 ---------- */

/** 取某类桌面事件的全部 detail。 */
function desktopEventsOf(ctx, type) {
  return ctx.desktopEvents.filter((e) => e.type === type).map((e) => e.detail)
}

test('桌面端按下拖动时会通知渲染壳「开始拖」并锁住可交互状态', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }], { desktop: true })
  await new Promise((resolve) => setImmediate(resolve))

  ctx.widget.dispatch('pointerdown', {
    button: 0, clientX: 100, clientY: 100, screenX: 900, screenY: 500,
    pointerId: 1, target: null, stopPropagation() {},
  })
  assert.equal(desktopEventsOf(ctx, 'dsh-eta-desktop-drag-start').length, 1)
  assert.deepEqual(desktopEventsOf(ctx, 'dsh-eta-desktop-busy'), [true])
})

test('桌面端的位移用**屏幕坐标**（clientX 会被窗口自己的移动抵消掉）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }], { desktop: true })
  await new Promise((resolve) => setImmediate(resolve))

  ctx.widget.dispatch('pointerdown', {
    button: 0, clientX: 100, clientY: 100, screenX: 900, screenY: 500,
    pointerId: 1, target: null, stopPropagation() {},
  })
  // 窗口已经跟着光标走了：client 坐标几乎没变，屏幕坐标却移了 -150/-80。
  ctx.widget.dispatch('pointermove', {
    clientX: 98, clientY: 97, screenX: 750, screenY: 420, pointerId: 1,
  })

  const moves = desktopEventsOf(ctx, 'dsh-eta-desktop-move')
  assert.equal(moves.length, 1, 'one pointermove → one desktop-move')
  assert.equal(moves[0].dx, -150, 'dx must come from screenX, not clientX')
  assert.equal(moves[0].dy, -80, 'dy must come from screenY, not clientY')
})

test('桌面端不写 left/top（那是网页端的做法，会把卡片挪出窗口）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }], { desktop: true })
  await new Promise((resolve) => setImmediate(resolve))
  const baselineLeft = ctx.widget.style.left
  const baselineTop = ctx.widget.style.top

  ctx.widget.dispatch('pointerdown', {
    button: 0, clientX: 100, clientY: 100, screenX: 900, screenY: 500,
    pointerId: 1, target: null, stopPropagation() {},
  })
  ctx.widget.dispatch('pointermove', {
    clientX: 98, clientY: 97, screenX: 750, screenY: 420, pointerId: 1,
  })
  ctx.widget.dispatch('pointerup', { pointerId: 1, clientX: 98, clientY: 97 })

  assert.equal(ctx.widget.style.left, baselineLeft, 'desktop must move the window, not the element')
  assert.equal(ctx.widget.style.top, baselineTop)
  assert.deepEqual(desktopEventsOf(ctx, 'dsh-eta-desktop-busy'), [true, false],
    'busy must be released on pointerup')
})

test('桌面端位移小于阈值时不算拖动（右键原地松开仍然开设置）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }], { desktop: true })
  await new Promise((resolve) => setImmediate(resolve))

  ctx.widget.dispatch('pointerdown', {
    button: 2, clientX: 100, clientY: 100, screenX: 900, screenY: 500,
    pointerId: 1, target: null, stopPropagation() {},
  })
  // 屏幕坐标只动了 1px：低于 3px 阈值，应当既不移动窗口、也不弹菜单
  ctx.widget.dispatch('pointermove', {
    clientX: 100, clientY: 100, screenX: 901, screenY: 500, pointerId: 1,
  })
  assert.equal(desktopEventsOf(ctx, 'dsh-eta-desktop-move').length, 0,
    'a 1px jitter must not be treated as a drag')
})

test('没有 screenX 时退回 client 坐标（老浏览器/垫片）', async () => {
  const ctx = bootClient([{ ok: true, now: Date.now(), sessions: [] }], { desktop: true })
  await new Promise((resolve) => setImmediate(resolve))

  ctx.widget.dispatch('pointerdown', {
    button: 0, clientX: 100, clientY: 100, pointerId: 1, target: null, stopPropagation() {},
  })
  ctx.widget.dispatch('pointermove', { clientX: 40, clientY: 70, pointerId: 1 })

  const moves = desktopEventsOf(ctx, 'dsh-eta-desktop-move')
  assert.equal(moves.length, 1)
  assert.equal(moves[0].dx, -60, 'fallback must use clientX when screenX is absent')
  assert.equal(moves[0].dy, -30)
})
