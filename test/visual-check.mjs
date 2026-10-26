/**
 * 用真实浏览器（Edge）跑 demo.html，验证新加的外观功能确实画得出来。
 *
 * 为什么不用测试垫片就够了：垫片只能证明「属性被赋值了」，证明不了
 * 「壁纸真的铺上去了、缩到 25% 还看得见、面板没被裁出屏幕」。这里截图 + 读
 * 真实计算样式，两件事一起验。
 */

import { chromium } from 'playwright'
import fs from 'node:fs'

const URL = process.env.DEMO_URL || 'http://127.0.0.1:8731/demo.html'
const OUT = 'shots'

fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const errors = []
page.on('pageerror', (err) => errors.push(String(err)))
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()) })

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForSelector('#dsh-eta-root', { timeout: 10_000 })
await page.waitForTimeout(2400) // 等第一轮轮询落地

const widget = page.locator('#dsh-eta-root')
const report = {}

report.mounted = await widget.count() === 1
report.clockText = (await page.locator('.dsh-eta-clock').innerText()).replace(/\n/g, ' | ')

// ---- 1. 设置面板能打开（标题行现在只有「收起」「齿轮」两个按钮） ----
await page.locator('.dsh-eta-head .dsh-eta-btn').nth(1).click()
await page.waitForSelector('#dsh-eta-panel:not([data-hidden])', { timeout: 3000 })
report.panelVisible = await page.locator('#dsh-eta-panel').isVisible()
report.panelSliders = await page.locator('#dsh-eta-panel input[type="range"]').count()

const panelBox = await page.locator('#dsh-eta-panel').boundingBox()
report.panelInsideViewport = panelBox.x >= 0 && panelBox.y >= 0
  && panelBox.x + panelBox.width <= 1280 && panelBox.y + panelBox.height <= 800
await page.screenshot({ path: `${OUT}/1-panel-open.png` })

// ---- 2. 缩放：拖到 25% ----
const zoomSlider = page.locator('#dsh-eta-panel input[type="range"]').first()
await zoomSlider.fill('25')
await zoomSlider.dispatchEvent('input')
await page.waitForTimeout(300)

const scaled = await widget.boundingBox()
report.zoom25Box = { w: Math.round(scaled.width), h: Math.round(scaled.height) }
report.zoom25ExpectedWidth = Math.round(236 * 0.25)
report.zoom25TextReadable = await page.locator('.dsh-eta-clock b').evaluate((el) => {
  const s = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  // 字号乘上实际缩放比例后，至少要有 5px 才可能读
  return parseFloat(s.fontSize) * (box.width / el.offsetWidth) >= 5
})

// 25% 时齿轮只有约 4.5px，必须有一块够大的逃生热区，而且真的能点开设置。
report.hotspotExists = await page.locator('#dsh-eta-hotspot').count() === 1
if (report.hotspotExists) {
  const spotBox = await page.locator('#dsh-eta-hotspot').boundingBox()
  report.hotspotSize = spotBox ? { w: Math.round(spotBox.width), h: Math.round(spotBox.height) } : null
  report.hotspotBigEnough = spotBox ? spotBox.width >= 40 && spotBox.height >= 40 : false

  // 先把面板关掉，再靠双击热区把它叫回来 —— 这才是用户真实的操作路径。
  await page.locator('#dsh-eta-panel .dsh-eta-btn').first().click()
  await page.waitForTimeout(150)
  report.panelClosedBeforeHotspot = await page.locator('#dsh-eta-panel').getAttribute('data-hidden')
  await page.locator('#dsh-eta-hotspot').dblclick()
  await page.waitForTimeout(250)
  report.hotspotReopensPanel = await page.locator('#dsh-eta-panel').getAttribute('data-hidden') === null
}
await page.screenshot({ path: `${OUT}/2-zoom-25.png` })

// ---- 3. 壁纸：用一个内联 SVG 当图源，避免依赖网络 ----
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#1b3b6f"/><stop offset="55%" stop-color="#2f7fbf"/>
    <stop offset="100%" stop-color="#8fd3f4"/></linearGradient></defs>
  <rect width="400" height="300" fill="url(#g)"/>
  <circle cx="90" cy="80" r="42" fill="#ffe9a8" opacity="0.85"/>
  <path d="M0 250 Q100 200 200 245 T400 235 V300 H0Z" fill="#0d2440" opacity="0.55"/>
</svg>`
const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')

await zoomSlider.fill('100')
await zoomSlider.dispatchEvent('input')
await page.locator('#dsh-eta-panel input[type="text"]').fill(dataUrl)
await page.locator('#dsh-eta-panel .dsh-eta-action', { hasText: '用链接' }).click()
await page.waitForTimeout(300)

report.wallpaperAttr = await widget.getAttribute('data-wallpaper')
report.wallpaperBackground = await page.locator('.dsh-eta-bg').evaluate(
  (el) => getComputedStyle(el).backgroundImage.slice(0, 42),
)
report.wallpaperLayerVisible = await page.locator('.dsh-eta-bg').isVisible()

// ---- 4. 模糊 + 暗化 ----
const ranges = page.locator('#dsh-eta-panel input[type="range"]')
await ranges.nth(1).fill('6')
await ranges.nth(1).dispatchEvent('input')
await ranges.nth(2).fill('0.45')
await ranges.nth(2).dispatchEvent('input')
await page.waitForTimeout(300)

report.blurApplied = await page.locator('.dsh-eta-bg').evaluate((el) => getComputedStyle(el).filter)
report.dimApplied = await page.locator('.dsh-eta-dim').evaluate((el) => getComputedStyle(el).backgroundColor)
await page.screenshot({ path: `${OUT}/3-wallpaper-blur.png` })

// ---- 5. 文字在壁纸上仍然可读（对比度粗查）----
report.clockColorOnWallpaper = await page.locator('.dsh-eta-clock b').evaluate(
  (el) => getComputedStyle(el).color,
)

// ---- 6. 「隐藏挂件」已删除；标题行只剩两个按钮 ----
report.titleButtons = await page.locator('.dsh-eta-head .dsh-eta-btn:visible').count()
report.noHideButton = report.titleButtons === 2 // 收起 + 齿轮

// ---- 7. 右键轻点 = 菜单 ----
await widget.click({ button: 'right' })
await page.waitForSelector('#dsh-eta-ctxmenu:not([data-hidden])', { timeout: 3000 })
report.contextMenuVisible = await page.locator('#dsh-eta-ctxmenu').isVisible()
report.contextMenuItems = await page.locator('#dsh-eta-ctxmenu .dsh-eta-ctxitem').allInnerTexts()
report.menuHasNoHide = !(await page.locator('#dsh-eta-ctxmenu .dsh-eta-ctxitem').allInnerTexts()).includes('隐藏挂件')

// 从菜单里开设置
await page.locator('#dsh-eta-ctxmenu .dsh-eta-ctxitem', { hasText: '外观设置' }).click()
await page.waitForTimeout(300)
report.menuOpensPanel = await page.locator('#dsh-eta-panel').getAttribute('data-hidden') === null
await page.locator('#dsh-eta-panel .dsh-eta-btn').first().click()
await page.waitForTimeout(200)

// ---- 8. 右键按住拖动 = 移动卡片（这是本次新增的核心诉求） ----
const posBefore = await widget.boundingBox()
const box = posBefore
// 在卡片中部按住右键，往左上拖 120px
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down({ button: 'right' })
await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 120, { steps: 12 })
await page.mouse.up({ button: 'right' })
await page.waitForTimeout(300)

const posAfter = await widget.boundingBox()
report.rightDragMovedCard = Math.abs(posAfter.x - posBefore.x) > 60 || Math.abs(posAfter.y - posBefore.y) > 60
report.rightDragDelta = { dx: Math.round(posAfter.x - posBefore.x), dy: Math.round(posAfter.y - posBefore.y) }
// 拖完不该弹菜单
report.rightDragDidNotOpenMenu = await page.locator('#dsh-eta-ctxmenu').getAttribute('data-hidden') === '1'

// ---- 9. 整卡左键也能拖（不限于标题行） ----
const posBeforeLeft = await widget.boundingBox()
await page.mouse.move(posBeforeLeft.x + posBeforeLeft.width / 2, posBeforeLeft.y + posBeforeLeft.height - 20)
await page.mouse.down()
await page.mouse.move(posBeforeLeft.x + posBeforeLeft.width / 2 + 100, posBeforeLeft.y + posBeforeLeft.height - 40, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(300)
const posAfterLeft = await widget.boundingBox()
report.leftDragFromBodyMovedCard =
  Math.abs(posAfterLeft.x - posBeforeLeft.x) > 50 || Math.abs(posAfterLeft.y - posBeforeLeft.y) > 50
await page.screenshot({ path: `${OUT}/5-drag-and-menu.png` })

// ---- 10. 恢复默认 ----
await widget.click({ button: 'right' })
await page.waitForSelector('#dsh-eta-ctxmenu:not([data-hidden])')
await page.locator('#dsh-eta-ctxmenu .dsh-eta-ctxitem', { hasText: '外观设置' }).click()
await page.waitForTimeout(300)
await page.locator('#dsh-eta-panel .dsh-eta-action', { hasText: '恢复默认' }).click()
await page.waitForTimeout(400)
report.afterResetWallpaper = await widget.getAttribute('data-wallpaper')
report.afterResetTransform = await widget.evaluate((el) => el.style.transform || '(none)')
await page.screenshot({ path: `${OUT}/4-after-reset.png` })

report.pageErrors = errors
console.log(JSON.stringify(report, null, 2))

await browser.close()
