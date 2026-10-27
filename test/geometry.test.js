/**
 * 桌面浮窗几何计算的测试。
 *
 * 这些算式错一次，表现就是「拖不动」「设置面板只显示一半」——
 * 而窗口是透明的，出错时肉眼几乎看不到线索。所以必须用测试钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  moveWindow, hitTestPoint, windowSizeFor, resizeAnchored,
} = require('../runtime/electron-helper/geometry.js')

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }
const SIZE = { width: 320, height: 640 }

/* ---------- 拖动 ---------- */

test('拖动：窗口位置 = 当前基准 + 位移', () => {
  const next = moveWindow({ baseX: 1600, baseY: 400, dx: -120, dy: -60, ...SIZE, area: AREA })
  assert.equal(next.x, 1480)
  assert.equal(next.y, 340)
  assert.equal(next.width, 320)
  assert.equal(next.height, 640)
})

test('拖动：第二次拖动从**当前**位置接着走，不会跳回原位', () => {
  // 第一次：从 1600 拖到 1400
  const first = moveWindow({ baseX: 1600, baseY: 400, dx: -200, dy: 0, ...SIZE, area: AREA })
  assert.equal(first.x, 1400)
  // 第二次：以 1400 为基准再拖 -100
  const second = moveWindow({ baseX: first.x, baseY: first.y, dx: -100, dy: 0, ...SIZE, area: AREA })
  assert.equal(second.x, 1300, 'second drag must continue from where the first ended')
  // 如果错误地每次都拿初始值当基准，这里会是 1500（= 1600 - 100），跳回一格
  assert.notEqual(second.x, 1500)
})

test('拖动：被夹在工作区内，不会拖出屏幕', () => {
  const right = moveWindow({ baseX: 1600, baseY: 400, dx: 9999, dy: 0, ...SIZE, area: AREA })
  assert.equal(right.x, AREA.x + AREA.width - SIZE.width)
  const left = moveWindow({ baseX: 1600, baseY: 400, dx: -9999, dy: 0, ...SIZE, area: AREA })
  assert.equal(left.x, AREA.x)
  const up = moveWindow({ baseX: 1600, baseY: 400, dx: 0, dy: -9999, ...SIZE, area: AREA })
  assert.equal(up.y, AREA.y)
  const down = moveWindow({ baseX: 1600, baseY: 400, dx: 0, dy: 9999, ...SIZE, area: AREA })
  assert.equal(down.y, AREA.y + AREA.height - SIZE.height)
})

test('拖动：工作区有偏移（副屏）时也按工作区夹取', () => {
  const second = { x: -1920, y: -200, width: 1920, height: 1040 }
  const next = moveWindow({ baseX: -400, baseY: 0, dx: 9999, dy: 9999, ...SIZE, area: second })
  assert.equal(next.x, second.x + second.width - SIZE.width)
  assert.equal(next.y, second.y + second.height - SIZE.height)
})

/* ---------- 点击穿透的可交互区域 ---------- */

const CARD = { left: 100, top: 470, right: 336, bottom: 640, width: 236, height: 170 }
const PANEL = { left: 100, top: 140, right: 352, bottom: 462, width: 252, height: 322 }

test('可交互区域包含卡片', () => {
  assert.equal(hitTestPoint({ card: CARD, panel: null }, 200, 550), true)
})

test('可交互区域也包含**设置面板**（早先漏了，导致桌面端面板点不动）', () => {
  assert.equal(hitTestPoint({ card: CARD, panel: PANEL }, 200, 300), true,
    'a point on the open settings panel must be interactive')
})

test('卡片与面板之间的空隙仍然穿透', () => {
  // 面板底 462、卡片顶 470，中间的 465 是空隙
  assert.equal(hitTestPoint({ card: CARD, panel: PANEL }, 200, 465), false)
})

test('两者之外一律穿透', () => {
  assert.equal(hitTestPoint({ card: CARD, panel: PANEL }, 20, 20), false)
  assert.equal(hitTestPoint({ card: CARD, panel: PANEL }, 900, 550), false)
})

test('尺寸为 0 的矩形不参与命中（面板关着时不吞点击）', () => {
  const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  assert.equal(hitTestPoint({ card: CARD, panel: zero }, 200, 300), false)
})

test('没有卡片时不会误判', () => {
  assert.equal(hitTestPoint({ card: null, panel: null }, 100, 100), false)
  assert.equal(hitTestPoint(null, 100, 100), false)
})

/* ---------- 窗口尺寸 ---------- */

test('窗口高度能同时放下面板和卡片（否则面板只显示一半）', () => {
  const size = windowSizeFor({
    area: AREA, cardW: 236, cardH: 170, panelW: 252, panelH: 322, edge: 16, gap: 8,
  })
  // 面板高 322 + 间隙 8 + 卡片高 170 + 上下留白 32 = 532
  assert.ok(size.height >= 322 + 8 + 170,
    'window must fit panel + card, got ' + size.height)
  assert.equal(size.height, 532)
  assert.ok(size.width >= 252 + 32, 'window must fit the wider of card/panel, got ' + size.width)
  assert.equal(size.width, 284)
})

test('窗口尺寸不会超过工作区（小屏幕上退让）', () => {
  // 工作区比需要的还窄/矮：两个方向都夹到工作区，绝不超过。
  const narrow = { x: 0, y: 0, width: 250, height: 300 }
  const size = windowSizeFor({
    area: narrow, cardW: 236, cardH: 170, panelW: 252, panelH: 322, edge: 16, gap: 8,
  })
  assert.equal(size.width, 250, 'must clamp to the work area width, not overflow it')
  assert.equal(size.height, 300, 'must clamp to the work area height')
})

test('工作区够大时不无谓地撑满屏幕', () => {
  const size = windowSizeFor({
    area: AREA, cardW: 236, cardH: 170, panelW: 252, panelH: 322, edge: 16, gap: 8,
  })
  assert.ok(size.width < AREA.width && size.height < AREA.height,
    'window should be sized to the content, not to the whole screen')
})

test('面板比预期更高时，窗口跟着变高', () => {
  const size = windowSizeFor({
    area: AREA, cardW: 236, cardH: 170, panelW: 252, panelH: 500, edge: 16, gap: 8,
  })
  assert.equal(size.height, 500 + 8 + 170 + 32)
})

/* ---------- 改尺寸时锚住右下角 ---------- */

test('面板打开、窗口变高：右边缘与下边缘不动，卡片才不会跳', () => {
  // 当前：右下角贴在工作区右下（1920x1040），窗口 284x202（只放卡片）
  const cur = { curX: 1920 - 284, curY: 1040 - 202, curW: 284, curH: 202, area: AREA }
  const next = resizeAnchored({ ...cur, width: 284, height: 532 })
  assert.equal(next.width, 284)
  assert.equal(next.height, 532)
  // 右边缘与下边缘保持在工作区边界
  assert.equal(next.x + next.width, 1920, 'right edge must stay put')
  assert.equal(next.y + next.height, 1040, 'bottom edge must stay put')
  // 于是窗口只是向上长高
  assert.equal(next.x, cur.curX)
  assert.equal(next.y, 1040 - 532)
})

test('面板打开时窗口变高变宽，右边缘与下边缘同样不动', () => {
  const cur = { curX: 900, curY: 500, curW: 284, curH: 202, area: AREA }
  const next = resizeAnchored({ ...cur, width: 340, height: 560 })
  assert.equal(next.x + next.width, 900 + 284, 'right edge must stay put')
  assert.equal(next.y + next.height, 500 + 202, 'bottom edge must stay put')
})

test('面板收起、窗口缩回去：右下角依然不动', () => {
  const cur = { curX: 1636, curY: 508, curW: 284, curH: 532, area: AREA }
  const next = resizeAnchored({ ...cur, width: 284, height: 202 })
  assert.equal(next.x + next.width, cur.curX + cur.curW)
  assert.equal(next.y + next.height, cur.curY + cur.curH)
})

test('窗口贴着工作区左上角时，锚定不会把它推出边界', () => {
  // 窗口就在工作区左上角，还要变大 —— 右/下边缘锚定会要求负坐标，必须被夹回 0
  const cur = { curX: 0, curY: 0, curW: 284, curH: 202, area: AREA }
  const next = resizeAnchored({ ...cur, width: 340, height: 560 })
  assert.ok(next.x >= AREA.x && next.y >= AREA.y, 'must stay inside the work area')
  assert.ok(next.x + next.width <= AREA.x + AREA.width)
  assert.ok(next.y + next.height <= AREA.y + AREA.height)
})
test('锁定态：卡片不参与命中，但那颗小锁必须能点', () => {
  // 锁定时渲染壳把 card 传成 null —— 卡片那一整块都该穿透给下层的应用。
  assert.equal(hitTestPoint({ card: null, panel: null, chip: null }, 200, 550), false,
    'a locked card must let clicks through')

  const CHIP = { left: 310, top: 472, right: 332, bottom: 494, width: 22, height: 22 }
  assert.equal(hitTestPoint({ card: null, panel: null, chip: CHIP }, 320, 482), true,
    'the unlock chip is the only way back in — it must stay clickable')
  // 小锁之外仍然穿透（否则整窗又变成一堵墙）
  assert.equal(hitTestPoint({ card: null, panel: null, chip: CHIP }, 200, 550), false)
})

test('不传 chip 时行为不变（老调用点不需要改）', () => {
  assert.equal(hitTestPoint({ card: CARD, panel: null }, 200, 550), true)
})
