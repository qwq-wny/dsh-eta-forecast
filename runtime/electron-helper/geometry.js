/**
 * dsh-eta-forecast — 桌面浮窗的几何计算（纯函数，方便单测）
 *
 * 从 desktop-renderer.js 里抽出来，是因为这些算式**错一次就表现为「拖不动」**
 * 这类没法靠肉眼定位的问题：窗口是透明的，出错时用户只看到「什么都没有」。
 * 抽成纯函数后，Node 测试就能把它们钉住。
 *
 * 同时给主进程用（CommonJS require）和给渲染页用（挂到 window 上）。
 */

'use strict'

/**
 * 拖动时算窗口的新位置。
 *
 * @param {object} input
 * @param {number} input.baseX  本次拖动开始时窗口的左边界（屏幕坐标）
 * @param {number} input.baseY  本次拖动开始时窗口的上边界
 * @param {number} input.dx     光标相对按下点的位移（**屏幕坐标**，不是 client 坐标）
 * @param {number} input.dy
 * @param {number} input.width  窗口宽
 * @param {number} input.height 窗口高
 * @param {object} input.area   工作区 {x, y, width, height}
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function moveWindow(input) {
  const baseX = Number(input.baseX) || 0
  const baseY = Number(input.baseY) || 0
  const dx = Number(input.dx) || 0
  const dy = Number(input.dy) || 0
  const width = Math.max(1, Math.round(Number(input.width) || 0))
  const height = Math.max(1, Math.round(Number(input.height) || 0))
  const area = input.area || { x: 0, y: 0, width: 1280, height: 800 }

  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height
  return {
    x: Math.round(Math.max(area.x, Math.min(maxX, baseX + dx))),
    y: Math.round(Math.max(area.y, Math.min(maxY, baseY + dy))),
    width,
    height,
  }
}

/**
 * 光标是否落在「可交互区域」里。
 *
 * 必须同时看**卡片**和**设置面板**。早先只看卡片，于是面板打开后光标一移上去
 * 就被判成「不在挂件上」→ 整窗翻回点击穿透 → 面板点不动。
 * 面板在桌面端从来点不了，就是这个原因。
 *
 * 第三个矩形 chip 是「锁定」时才会出现的那颗小锁：锁定态下卡片本身不再可交互
 * （渲染壳会把 card 传成 null），但小锁必须能点 —— 它是唯一的解锁入口，
 * 漏了就等于把用户永久锁在外面。
 *
 * @param {object} rects {card: DOMRect|null, panel: DOMRect|null, chip?: DOMRect|null}
 * @param {number} x 窗口内坐标
 * @param {number} y
 * @returns {boolean}
 */
function hitTestPoint(rects, x, y) {
  const inside = (rect) => Boolean(rect)
    && rect.width > 0 && rect.height > 0
    && x >= rect.left && x <= rect.right
    && y >= rect.top && y <= rect.bottom
  return inside(rects && rects.card)
    || inside(rects && rects.panel)
    || inside(rects && rects.chip)
}

/**
 * 窗口该开多大。
 *
 * 早先固定 300×210 —— 设置面板高三百多像素，开出来只看得见一半
 * （面板是 `position: fixed` 挂在 body 上，超出窗口的部分直接被裁掉）。
 * 现在按「卡片 + 面板都要放得下」来算：面板默认弹在卡片**上方**，
 * 所以高度要留出 cardH + panelH + 两段间隙。
 *
 * 窗口向右下角锚定（卡片在窗口内贴右下），所以窗口变高只是向上多出一块
 * 透明区域 —— 卡片在屏幕上的位置不变。
 *
 * @param {object} input
 * @param {object} input.area 工作区
 * @param {number} input.cardW 卡片宽
 * @param {number} input.cardH 卡片高
 * @param {number} input.panelW 面板宽
 * @param {number} input.panelH 面板高
 * @param {number} input.edge 卡片距窗口边的留白
 * @param {number} input.gap 卡片与面板之间的间隙
 */
function windowSizeFor(input) {
  const area = input.area || { x: 0, y: 0, width: 1280, height: 800 }
  const cardW = Number(input.cardW) || 236
  const cardH = Number(input.cardH) || 170
  const panelW = Number(input.panelW) || 252
  const panelH = Number(input.panelH) || 320
  const edge = Number(input.edge) || 16
  const gap = Number(input.gap) || 8

  // 宽度：卡片与面板取宽的；面板可能比卡片宽一点。
  const wantW = Math.max(cardW, panelW) + edge * 2
  // 高度：面板在上、卡片在下，再加两条留白。
  const wantH = panelH + gap + cardH + edge * 2

  return {
    width: Math.min(Math.round(wantW), Math.round(area.width)),
    height: Math.min(Math.round(wantH), Math.round(area.height)),
  }
}

/**
 * 改变窗口大小，但**锚住右下角**。
 *
 * 卡片贴在窗口的右下角，所以只有保持右边缘与下边缘不动，卡片在屏幕上的位置
 * 才不会跟着窗口一起跳。设置面板开/关时走这条路径。
 *
 * @param {object} input
 * @param {number} input.curX 当前左边界
 * @param {number} input.curY 当前上边界
 * @param {number} input.curW 当前宽
 * @param {number} input.curH 当前高
 * @param {number} input.width 目标宽
 * @param {number} input.height 目标高
 * @param {object} input.area 工作区
 */
function resizeAnchored(input) {
  const right = (Number(input.curX) || 0) + (Number(input.curW) || 0)
  const bottom = (Number(input.curY) || 0) + (Number(input.curH) || 0)
  return moveWindow({
    baseX: right - input.width,
    baseY: bottom - input.height,
    dx: 0,
    dy: 0,
    width: input.width,
    height: input.height,
    area: input.area,
  })
}

const api = { moveWindow, hitTestPoint, windowSizeFor, resizeAnchored }

// 渲染页：<script src> 加载后从这里取
if (typeof window !== 'undefined') window.DshEtaGeometry = api
// 主进程 / Node 测试
if (typeof module !== 'undefined' && module.exports) module.exports = api