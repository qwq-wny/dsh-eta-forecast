/**
 * 全量真实日志回放：把本机跑过的**每一个会话的每一轮**都喂回 forecastSession，
 * 在每轮的等距观测点上比对「预测总时长」与「真实总时长」。
 *
 * 为什么要有这个脚本：
 *   `test/replay-accuracy.mjs` 只回放**一轮**（97.2 分钟、22 步），适合讲故事，
 *   但不足以支撑「准确率从 X% 提到 Y%」这种结论 —— 单轮样本换个参数就能翻盘。
 *   这个脚本跑全量，任何人在自己机器上都能复现，数字不是从聊天记录里抄的。
 *
 * 用法：
 *   node test/replay-all.mjs                    # 用本机 ~/.dsh/sessions 的日志
 *   node test/replay-all.mjs --before HEAD~1    # 与指定 git 版本对比（需要 git）
 *   node test/replay-all.mjs --dir <另一个目录>
 *
 * 口径（写死在这里，避免每次口头描述口径）：
 *   - 只统计真实时长 ≥ 60 秒的轮次（太短的轮次没有估计价值，且会污染均值）。
 *   - 每轮最多等距取 15 个观测点（只取 `step/start` 之后，也就是有节奏信息的时刻）。
 *   - 误差 = (预测总时长 − 真实总时长) / 真实总时长；MAE 取绝对值均值，偏置取带符号均值。
 *   - 「灾难」= **非超时态**下，显示还剩 ≤30 秒、而实际还剩 >2 分钟。超时态排除在外，
 *     因为那时前端显示的是「已超时 M 分」，倒计时数字根本不出现在屏幕上。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { emptySession, observeEvent, forecastSession } from '../lib/forecast.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SAMPLE_PER_TURN = 15
const MIN_TURN_MS = 60 * 1000

/* ---------- 日志读取 ---------- */

/**
 * 会话日志是**多帧拼接**的 zstd，不是一个 zstd 流。
 * 所以不能直接扔给解压器，得先扫帧头魔数切开，逐帧解。
 */
function decodeSessionFile(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  let at = 0
  while ((at = buf.indexOf(ZSTD_MAGIC, at)) >= 0) {
    starts.push(at)
    at += 4
  }
  if (starts.length === 0) return ''
  starts.push(buf.length)
  const parts = []
  for (let i = 0; i < starts.length - 1; i++) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])))
    } catch {
      // 半截帧（正在写的会话）跳过即可，不影响历史统计。
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function findSessionFiles(root, out = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) findSessionFiles(full, out)
    else if (entry.name === 'session.v4.jsonl.zstd') out.push(full)
  }
  return out
}

function loadEvents(file) {
  const events = []
  for (const line of decodeSessionFile(file).split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (Number.isFinite(Number(event.time))) events.push(event)
    } catch {
      // 坏行直接跳过：日志里偶有被截断的尾行。
    }
  }
  events.sort((a, b) => Number(a.time) - Number(b.time))
  return events
}

/** 从事件流里切出每一轮的 [start, end) 时刻。 */
function turnSpans(events) {
  const spans = new Map()
  let open = null
  for (const event of events) {
    const type = String(event.type || '')
    if (type === 'turn/start') {
      open = { id: String(event.data?.turn), start: Number(event.time), end: 0 }
      spans.set(open.id, open)
    } else if (open && type === 'turn/end') {
      open.end = Number(event.time)
      open = null
    }
  }
  return spans
}

/* ---------- 回放 ---------- */

/** 对一轮做回放，返回等距抽样后的观测点（多个实现同时喂同一串事件）。 */
function replayTurn(events, span, impls) {
  const states = impls.map((impl) => impl.emptySession('replay'))
  const samples = []
  let started = false

  for (const event of events) {
    const at = Number(event.time)
    if (String(event.type) === 'turn/start' && String(event.data?.turn) === span.id) started = true
    if (!started) continue

    impls.forEach((impl, i) => impl.observeEvent(states[i], event, at))
    if (at > span.end) break
    if (String(event.type) !== 'step/start') continue

    // elapsed 是「本轮已跑多久」，at 只是日志里的绝对时刻 —— 别混用。
    const elapsed = at - span.start
    const point = { elapsed }
    for (let i = 0; i < impls.length; i++) {
      let snap = null
      try {
        snap = impls[i].forecastSession(states[i], at)
      } catch {
        // 单个实现的异常不能让整次回放中断。
      }
      point[i] = snap && snap.remainMs !== null
        ? { total: elapsed + snap.remainMs, overtime: snap.overtime === true }
        : null
    }
    samples.push(point)
  }
  return samples
}

function sampleEvenly(samples, wanted) {
  if (samples.length <= wanted) return samples
  const picked = []
  for (let i = 0; i < wanted; i++) {
    picked.push(samples[Math.round((i * (samples.length - 1)) / (wanted - 1))])
  }
  return picked
}

/* ---------- 指标 ---------- */

const BUCKETS = [
  [60_000, 120_000, '1–2 分钟'],
  [120_000, 300_000, '2–5 分钟'],
  [300_000, 900_000, '5–15 分钟'],
  [900_000, 1_800_000, '15–30 分钟'],
  [1_800_000, 3_600_000, '30–60 分钟'],
  [3_600_000, Infinity, '60 分钟以上'],
]

function metrics(rows, implIndex, filter = () => true) {
  let n = 0
  let absSum = 0
  let signedSum = 0
  let within2x = 0
  let overtime = 0
  let missedEnd = 0
  let disaster = 0

  for (const row of rows) {
    if (!filter(row)) continue
    for (const point of row.points) {
      const cell = point[implIndex]
      if (!cell) continue
      const err = (cell.total - row.duration) / row.duration
      n++
      absSum += Math.abs(err)
      signedSum += err
      if (Math.abs(err) <= 1) within2x++
      if (cell.overtime) overtime++

      const realRemain = row.duration - point.elapsed
      if (realRemain > 120_000) {
        missedEnd++
        if (!cell.overtime && cell.total - point.elapsed <= 30_000) disaster++
      }
    }
  }

  if (n === 0) return null
  return {
    n,
    mae: absSum / n,
    bias: signedSum / n,
    within2x: within2x / n,
    overtime: overtime / n,
    disaster: missedEnd > 0 ? disaster / missedEnd : null,
  }
}

const pct = (x) => `${Math.round(x * 100)}%`
const signedPct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`

/* ---------- 主流程 ---------- */

function loadBefore(ref) {
  const source = execFileSync('git', ['show', `${ref}:lib/forecast.js`], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const tmp = path.join(os.tmpdir(), `dsh-eta-replay-before-${process.pid}.mjs`)
  fs.writeFileSync(tmp, source, 'utf8')
  return import(`file://${tmp.replace(/\\/g, '/')}`).finally(() => {
    try { fs.unlinkSync(tmp) } catch {}
  })
}

/**
 * 加载一份实验副本（通常是 `.dbg-*.mjs`）。
 * 存在的意义：调超时/夹取这类参数时，必须能**并排**看两组数字，
 * 否则每次都要改文件、跑一遍、再改回来，中间任何一次忘记还原都会污染结论。
 */
async function loadVariant(filePath) {
  const abs = path.resolve(REPO, filePath)
  const source = fs.readFileSync(abs, 'utf8')
  const tmp = path.join(os.tmpdir(), `dsh-eta-replay-variant-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(tmp, source, 'utf8')
  return import(`file://${tmp.replace(/\\/g, '/')}`).finally(() => {
    try { fs.unlinkSync(tmp) } catch {}
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const argOf = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : null
  }

  const sessionsRoot = argOf('--dir')
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
  const beforeRef = argOf('--before')

  const impls = [await import('../lib/forecast.js')]
  const labels = ['当前代码']
  if (beforeRef) {
    impls.unshift(await loadBefore(beforeRef))
    labels.unshift(`${beforeRef}（对比基线）`)
  }
  // --variant 可重复，每个文件并排多一组列。
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--variant') continue
    const file = argv[i + 1]
    if (!file) continue
    impls.push(await loadVariant(file))
    labels.push(path.basename(file).replace(/^\.dbg-|\.mjs$/g, ''))
  }

  const files = findSessionFiles(sessionsRoot)
  if (files.length === 0) {
    console.error(`没有在 ${sessionsRoot} 找到会话日志，用 --dir 指定目录。`)
    process.exitCode = 1
    return
  }

  const rows = []
  let allTurns = 0
  for (const file of files) {
    const events = loadEvents(file)
    for (const span of turnSpans(events).values()) {
      allTurns++
      const duration = span.end - span.start
      if (!(duration >= MIN_TURN_MS)) continue
      const points = sampleEvenly(replayTurn(events, span, impls), SAMPLE_PER_TURN)
      // 只保留所有实现都给出数字的观测点，保证对比是同一批样本。
      const usable = points.filter((p) => impls.every((_, i) => p[i]))
      if (usable.length === 0) continue
      rows.push({ duration, points: usable })
    }
  }

  const observations = rows.reduce((sum, row) => sum + row.points.length, 0)
  console.log(`日志目录：${sessionsRoot}`)
  console.log(`样本：${files.length} 个会话 / ${allTurns} 轮，其中 ${rows.length} 轮（≥60 秒）纳入统计 / ${observations} 个观测点\n`)

  const groups = [
    ['全部', () => true],
    ['2 分钟以上', (r) => r.duration >= 120_000],
    ['2 分钟以内', (r) => r.duration < 120_000],
    ['5–30 分钟', (r) => r.duration >= 300_000 && r.duration < 1_800_000],
    ['30 分钟以上', (r) => r.duration >= 1_800_000],
    ['60 分钟以上', (r) => r.duration >= 3_600_000],
  ]

  const render = (cells, widths) => cells.map((c, i) => String(c).padEnd(widths[i])).join('')

  const printTable = (rowsSpec) => {
    const header = ['分组', '样本']
    // 每个实现独占一组列：MAE / 偏置 / ±2倍 / 灾难率。
    // 灾难率必须按实现分开列，否则只能看到最后一个实现的数字。
    for (const label of labels) header.push(`${label} MAE`, '偏置', '±2倍', '灾难率')
    header.push('超时率')
    const widths = [13, 7, ...labels.flatMap(() => [20, 9, 7, 8]), 9]

    console.log(render(header, widths))
    console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)))
    for (const [name, filter] of rowsSpec) {
      const cells = [name]
      let sample = 0
      let overtimeRate = null
      for (let i = 0; i < impls.length; i++) {
        const m = metrics(rows, i, filter)
        if (!m) {
          cells.push('—', '—', '—', '—')
          continue
        }
        sample = m.n
        overtimeRate = m.overtime
        cells.push(pct(m.mae), signedPct(m.bias), pct(m.within2x),
          m.disaster === null ? '—' : pct(m.disaster))
      }
      cells.splice(1, 0, String(sample))
      cells.push(overtimeRate === null ? '—' : pct(overtimeRate))
      console.log(render(cells, widths))
    }
  }

  printTable(groups)

  console.log('\n分桶明细（按真实轮次时长）：')
  const bucketRows = BUCKETS.map(([lo, hi, name]) => [
    name,
    (r) => r.duration >= lo && r.duration < hi,
  ])
  printTable(bucketRows)

  console.log('\n灾难率 = 非超时态下「显示还剩 ≤30 秒、但实际还剩 2 分钟以上」的观测点占比。')
  console.log('超时态不计入：那时卡片显示的是「已超时 M 分」，倒计时数字不在屏幕上。')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
