/**
 * 桌面窗口 helper 的纯逻辑测试。
 *
 * Electron 起不来也不该挡住「路径解析对不对」这类断言 —— 这里只测不碰 Electron 的部分：
 * 运行时查找顺序、$DSH_HOME 约定、以及「找不到就明确失败而不是静默下载」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  dshHomeDir, resolveElectron, helperMainPath, DesktopWindow,
} from '../lib/desktop.js'

test('dshHomeDir 遵守 DSH_HOME，否则回落 ~/.dsh', () => {
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = path.join(os.tmpdir(), 'eta-home-test')
    assert.equal(dshHomeDir(), path.join(os.tmpdir(), 'eta-home-test'))

    delete process.env.DSH_HOME
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
    assert.equal(dshHomeDir(), path.join(home, '.dsh'))
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})

test('resolveElectron 找不到时返回 null 并给出查找过的路径', () => {
  const original = process.env.DSH_ETA_ELECTRON_PATH
  const originalHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_ETA_ELECTRON_PATH
    process.env.DSH_HOME = path.join(os.tmpdir(), 'eta-no-electron-here')
    const result = resolveElectron()
    assert.equal(result.path, null, 'must not invent a path')
    assert.ok(Array.isArray(result.searched))
    assert.ok(result.searched.length >= 1, 'must report what it looked at')
  } finally {
    if (original === undefined) delete process.env.DSH_ETA_ELECTRON_PATH
    else process.env.DSH_ETA_ELECTRON_PATH = original
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  }
})

test('resolveElectron 优先用显式传入的路径', () => {
  const fake = path.join(os.tmpdir(), 'eta-fake-electron-' + process.pid)
  fs.writeFileSync(fake, '')
  try {
    const result = resolveElectron(fake)
    assert.equal(result.path, fake)
  } finally {
    try { fs.unlinkSync(fake) } catch (err) { /* 忽略 */ }
  }
})

test('helperMainPath 指向包内 runtime 下的 main.js', () => {
  const root = path.join('some', 'package', 'root')
  const resolved = helperMainPath(root)
  assert.equal(path.basename(resolved), 'main.js')
  assert.ok(resolved.indexOf('electron-helper') !== -1)
  assert.ok(resolved.startsWith(root))
})

test('找不到 Electron 时 start 明确失败，且**不**尝试下载', () => {
  const original = process.env.DSH_ETA_ELECTRON_PATH
  const originalHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_ETA_ELECTRON_PATH
    process.env.DSH_HOME = path.join(os.tmpdir(), 'eta-no-electron-2')
    const dw = new DesktopWindow({
      packageRoot: path.join(os.tmpdir(), 'nope'),
      getEndpoint: () => ({ port: 1234, stateUrl: 'http://127.0.0.1:1234/dsh-eta/state.json' }),
      log: () => {},
    })
    const result = dw.start()
    assert.equal(result.ok, false)
    assert.ok(result.error && result.error.indexOf('Electron') !== -1, 'error must name the missing runtime')
    assert.ok(result.error.indexOf('不会替你静默下载') !== -1, 'must state it will not auto-download 300MB')
    assert.equal(dw.isRunning(), false)
    dw.stop()
  } finally {
    if (original === undefined) delete process.env.DSH_ETA_ELECTRON_PATH
    else process.env.DSH_ETA_ELECTRON_PATH = original
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  }
})

test('stop 幂等：没启动过也不会抛', () => {
  const dw = new DesktopWindow({
    packageRoot: os.tmpdir(),
    getEndpoint: () => ({ port: 0, stateUrl: '' }),
    log: () => {},
  })
  assert.doesNotThrow(() => dw.stop())
  assert.doesNotThrow(() => dw.stop())
  assert.equal(dw.isRunning(), false)
})
