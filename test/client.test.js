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
function bootClient(snapshotResponses) {
  const doc = makeDocument()
  const root = new FakeNode('div', doc)
  root.id = 'root'
  doc.byId.set('root', root)

  const storage = new Map()
  const timers = []
  let pollIndex = 0

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null },
      setItem(key, value) { storage.set(key, String(value)) },
    },
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

/** 取挂件里第一个 class 匹配的节点的文字。 */
function textOf(widget, className) {
  const walk = (node) => {
    if (node.className === className) return node
    for (const child of node.children) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  const found = walk(widget)
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
