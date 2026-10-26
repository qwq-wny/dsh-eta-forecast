/**
 * 桌面浮窗的**真机冒烟测试**（可选，需要 Electron 与一块真实显示器）。
 *
 * 单元测试只能钉住 geometry.js 的算式，钉不住「Electron 里到底发生了什么」——
 * 而透明窗口出错时用户只看到「什么都没有」，肉眼看不出线索。
 * 所以这里真起一个 helper：自建一个假宿主提供 state.json / eta.js，
 * 拉起 Electron，再用 CDP 连进渲染页**真的去点齿轮**，读渲染端的 trace 断言：
 *
 *   1. 窗口开出来多大 —— 必须装得下设置面板（早先固定 300×210，面板只剩一半）；
 *   2. 点开面板后窗口会重新适配，且**右下角不动**（卡片不该跟着跳）；
 *   3. 面板矩形算进可交互区（早先只算卡片，导致面板点不动）；
 *   4. 全程没有 CSP 拦截、加载失败、渲染进程崩溃。
 *
 * 用法：
 *   node test/desktop-smoke.mjs
 * 依赖：本机已安装 Electron（同插件运行时的查找逻辑），以及 playwright（仅用于 CDP 连接）。
 */

import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HELPER = path.join(ROOT, 'runtime', 'electron-helper', 'main.js')
const CLIENT = path.join(ROOT, 'assets', 'eta-client.js')

const CDP_PORT = 9333
/** 测试实例自己的 Electron 配置目录：避开用户正在用的那个实例的单实例锁。 */
const SMOKE_PROFILE = path.join(os.tmpdir(), 'dsh-eta-smoke-profile')

/** 找 Electron：和插件运行时同一套候选路径。 */
function findElectron() {
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
  const candidates = [
    process.env.DSH_ETA_ELECTRON_PATH,
    path.join(home, 'electron', 'electron.exe'),
    path.join(home, 'electron', 'electron'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 假宿主：只提供桌面端需要的三个东西（客户端脚本、快照、配置）。 */
function startFakeHost() {
  const now = Date.now()
  const state = {
    ok: true,
    now,
    display: 'both',
    sessions: [{
      id: 'smoke-1', title: '冒烟测试会话', phase: 'running',
      elapsedMs: 60_000, remainMs: 120_000, etaAt: now + 120_000,
      confidence: 'medium', source: 'steps',
      // 没有 todo 清单：进度走步数代理 —— 顺便验证桌面端也能看到进度条
      progress: 0.42, progressSource: 'steps',
      total: 0, completed: 0, inProgress: 0, pending: 0,
      currentTask: '', steps: 42, paused: false, pausedMs: 0, updatedAt: now,
    }],
  }

  const server = http.createServer((req, res) => {
    const url = String(req.url || '')
    if (url.startsWith('/dsh-eta/eta.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(fs.readFileSync(CLIENT))
      return
    }
    if (url.startsWith('/dsh-eta/state.json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(state))
      return
    }
    if (url.startsWith('/dsh-eta/config')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, display: 'both', modes: ['web', 'desktop', 'both', 'none'], desktopRunning: true, error: '' }))
      return
    }
    res.writeHead(404).end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function main() {
  const electron = findElectron()
  if (!electron) {
    console.log('SKIP: 没找到 Electron（可用 DSH_ETA_ELECTRON_PATH 指定）')
    return
  }
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch (error) {
    console.log('SKIP: 没装 playwright（npm i -D playwright）')
    return
  }

  const { server, port } = await startFakeHost()
  console.log('fake host on', port)

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 不清掉的话 Electron 会以纯 Node 模式启动
  env.DSH_ETA_STATE_URL = `http://127.0.0.1:${port}/dsh-eta/state.json`
  env.DSH_ETA_ALLOW_ORIGIN = `http://127.0.0.1:${port}`
  env.DSH_ETA_HOST_PID = String(process.pid) // 本进程一退，helper 自己就退

  const child = spawn(electron, [
    HELPER,
    `--remote-debugging-port=${CDP_PORT}`,
    // 单实例锁是按 userData 目录算的。用户**真实的**挂件多半正在跑，
    // 共用默认 userData 的话测试实例会因「已有实例持有锁」直接退出；
    // 换个临时 userData，两边互不干扰，也就不会误杀用户那个窗口。
    `--user-data-dir=${SMOKE_PROFILE}`,
  ], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))

  const cleanup = () => {
    try { child.kill() } catch (err) { /* 忽略 */ }
    try { server.close() } catch (err) { /* 忽略 */ }
  }

  try {
    // 等 CDP 起来
    let browser = null
    for (let i = 0; i < 40 && !browser; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`) } catch (err) { /* 还没起来 */ }
    }
    assert.ok(browser, 'CDP 未能连上 Electron（日志：' + logs.join('').slice(-500) + '）')

    const contexts = browser.contexts()
    const pages = contexts.flatMap((c) => c.pages())
    const page = pages.find((p) => p.url().includes('electron-helper')) || pages[0]
    assert.ok(page, '没找到渲染页')

    await page.waitForSelector('#dsh-eta-root', { timeout: 15_000 })
    console.log('✓ 挂件在桌面窗口里挂载成功')

    // 等渲染端把窗口尺寸 trace 打出来
    await page.waitForTimeout(1200)
    const allLogs = logs.join('')
    const sizeMatch = /\[dsh-eta-renderer\] window size (\{[^}]*\})/.exec(allLogs)
    assert.ok(sizeMatch, '渲染端没有报出窗口尺寸')
    const size = JSON.parse(sizeMatch[1])
    console.log('  窗口尺寸:', size)
    assert.ok(size.height >= 400,
      '窗口必须装得下设置面板（早先固定 210 高，面板只剩一半），实际 ' + size.height)

    // 卡片与面板尺寸
    const card = await page.evaluate(() => {
      const r = document.getElementById('dsh-eta-root').getBoundingClientRect()
      return { width: Math.round(r.width), height: Math.round(r.height) }
    })
    console.log('  卡片:', card)

    // 进度条（顺带验证桌面端能看到）
    const bar = await page.evaluate(() => {
      const el = document.querySelector('.dsh-eta-bar')
      return el ? { on: el.getAttribute('data-on'), source: el.getAttribute('data-source') } : null
    })
    console.log('  进度条:', bar)
    assert.equal(bar && bar.on, '1', '桌面端应当显示进度条')
    assert.equal(bar.source, 'steps', '没有清单时进度来自步数代理')

    // 真的点齿轮开面板
    await page.locator('.dsh-eta-head .dsh-eta-btn').nth(1).click()
    await page.waitForSelector('#dsh-eta-panel:not([data-hidden])', { timeout: 5000 })
    const panel = await page.evaluate(() => {
      const r = document.getElementById('dsh-eta-panel').getBoundingClientRect()
      return { width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top) }
    })
    console.log('  面板:', panel)

    // 面板必须完整落在窗口内 —— 这正是「只显示一半」的判据
    const viewport = page.viewportSize()
    console.log('  视口:', viewport)

    await page.waitForTimeout(900)
    const fitLogs = logs.join('')
    const fitMatch = /\[dsh-eta-renderer\] fit (\{[^}]*\})/.exec(fitLogs)
    assert.ok(fitMatch, '开面板后渲染端没有重算窗口尺寸（dsh-eta-desktop-fit 没生效）')
    const fit = JSON.parse(fitMatch[1])
    console.log('  适配后的窗口:', fit)
    assert.ok(fit.height > size.height,
      '开面板后窗口应当变高（' + size.height + ' → ' + fit.height + '）')
    assert.equal(fit.y + fit.height, size.y + size.height,
      '变高时下边缘必须不动（卡片不该跟着跳）')

    // 出错信息
    const bad = allLogs.split('\n').filter((line) =>
      /ERROR|load failed|renderer gone|Refused to|CSP/i.test(line))
    assert.equal(bad.length, 0, '渲染端出现错误：\n' + bad.join('\n'))

    console.log('✓ 全部断言通过')
  } finally {
    cleanup()
    await new Promise((r) => setTimeout(r, 500))
  }
}

main().catch((error) => {
  console.error('FAIL:', error && error.message ? error.message : error)
  process.exitCode = 1
})