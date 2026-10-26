/**
 * 用真实运行数据回放，量化准确性改进。
 *
 * 数据来自实际观测到的一轮：97.2 分钟（5834 秒）、22 步，没有 todo 清单。
 * 观测点：已跑秒数 → 该时刻的累计步数。
 *
 * 回放必须**同口径**：步长按观测区间均分（贴近真实节奏），不能随手给固定值 ——
 * 否则量出来的是回放脚本的缺陷，不是插件的表现（第一版就栽在这）。
 */

import { emptySession, observeEvent, forecastSession } from '../lib/forecast.js'

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)
const REAL_TOTAL_SEC = 5834
const REAL_TOTAL_MIN = REAL_TOTAL_SEC / 60

const OBSERVED = [
  [101, 3], [233, 4], [426, 5], [678, 6], [990, 7], [1423, 8], [1914, 9],
  [2538, 11], [3099, 13], [3757, 15], [4012, 16], [4634, 18], [4923, 19],
  [5543, 21], [5834, 22],
]

/** 按观测点喂步：区间内新增的步均匀铺开，每步时长 = 区间 / 步数。 */
function feedTurn(state, turn, startAt, observations) {
  let stepNo = 0
  let prevAt = startAt
  const rows = []
  for (const [elapsedSec, targetSteps] of observations) {
    const at = startAt + elapsedSec * 1000
    const want = Math.max(0, targetSteps - stepNo)
    if (want > 0) {
      const per = Math.max(1, Math.floor((at - prevAt) / want))
      for (let i = 0; i < want; i++) {
        const t = prevAt + per * i
        observeEvent(state, { type: 'step/start', data: { turn, step: ++stepNo } }, t)
        observeEvent(state, { type: 'step/end', data: { turn, step: stepNo } }, t + per)
      }
    }
    prevAt = at
    const snap = forecastSession(state, at)
    rows.push({
      elapsedMin: +(elapsedSec / 60).toFixed(1),
      steps: targetSteps,
      source: snap.source,
      remainMin: snap.remainMs === null ? null : +(snap.remainMs / 60000).toFixed(1),
      predictedTotalMin: snap.remainMs === null
        ? null
        : +((elapsedSec * 1000 + snap.remainMs) / 60000).toFixed(1),
      overtime: snap.overtime,
      overtimeMin: snap.overtime ? +(snap.overtimeMs / 60000).toFixed(1) : 0,
    })
  }
  return { rows, lastAt: prevAt }
}

const errPct = (min) => (min === null
  ? '—'
  : Math.round((min - REAL_TOTAL_MIN) / REAL_TOTAL_MIN * 100) + '%')

/* ---------- 第一轮（新会话，无历史） ---------- */

const s = emptySession('t1')
observeEvent(s, { type: 'turn/start', data: { turn: 1 } }, T0)
const t1 = feedTurn(s, 1, T0, OBSERVED)

console.log('=== 第一轮（新会话，无历史）===')
console.log('已跑(分) | 步数 | 来源      | 重估还剩(分) | 预测总时长(分) | 误差  | 超时')
console.log('-'.repeat(84))
for (const r of t1.rows) {
  console.log(
    String(r.elapsedMin).padStart(8), String(r.steps).padStart(4),
    '|', String(r.source).padEnd(9),
    '|', String(r.remainMin === null ? '—' : r.remainMin).padStart(12),
    '|', String(r.predictedTotalMin === null ? '—' : r.predictedTotalMin).padStart(14),
    '|', errPct(r.predictedTotalMin).padStart(6),
    '|', r.overtime ? '超时 ' + r.overtimeMin + ' 分' : '否',
  )
}

const firstOt = t1.rows.find((r) => r.overtime)
const silent = t1.rows.filter((r) => r.overtime && r.remainMin === null).length
console.log('-'.repeat(84))
console.log('真实总时长 97.2 分 ｜ 超时首次出现：', firstOt ? firstOt.elapsedMin + ' 分' : '未超时')
console.log('超时后仍不给时间信息的观测点：', silent, '/', t1.rows.length,
  silent === 0 ? '（修复前是 11 个 —— 那 88 分钟只喊「已超时」，什么都没说）' : '')

/* ---------- 第一轮结束，学到历史 ---------- */

observeEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  T0 + REAL_TOTAL_SEC * 1000)
console.log('\n第一轮结束时学到：整轮时长', s.history.length, '条 | 超时记录',
  s.overtimeHistory.length, '条 | 精度样本', s.accuracyHistory.length, '条'
  + (s.accuracyHistory.length
    ? '（实际/预测 = ' + (s.accuracyHistory[0].actual / s.accuracyHistory[0].predicted).toFixed(2) + '×）'
    : ''))

/* ---------- 第二轮（同一会话，有历史） ---------- */

const start2 = T0 + REAL_TOTAL_SEC * 1000 + 3000
observeEvent(s, { type: 'turn/start', data: { turn: 2 } }, start2)
const t2 = feedTurn(s, 2, start2, OBSERVED.slice(0, 8))

console.log('\n=== 第二轮（已学到上一轮真实时长，节奏相同）===')
console.log('已跑(分) | 来源                | 预测总时长(分) | 误差')
console.log('-'.repeat(64))
for (const r of t2.rows) {
  console.log(
    String(r.elapsedMin).padStart(8), '|', String(r.source).padEnd(19),
    '|', String(r.predictedTotalMin === null ? '—' : r.predictedTotalMin).padStart(14),
    '|', errPct(r.predictedTotalMin).padStart(6),
  )
}

const avgAbsErr = (rows) => {
  const errs = rows.map((r) => (r.predictedTotalMin === null
    ? null
    : Math.abs(r.predictedTotalMin - REAL_TOTAL_MIN) / REAL_TOTAL_MIN)).filter((v) => v !== null)
  return errs.length ? Math.round(errs.reduce((a, b) => a + b, 0) / errs.length * 100) + '%' : '—'
}
console.log('-'.repeat(64))
console.log('同样这几个时刻的预测总时长：')
console.log('  第一轮（无历史）：', t1.rows.slice(0, 8).map((r) => r.predictedTotalMin).join(' / '))
console.log('  第二轮（有历史）：', t2.rows.map((r) => r.predictedTotalMin).join(' / '))
console.log('平均绝对误差：第一轮', avgAbsErr(t1.rows.slice(0, 8)), '→ 第二轮', avgAbsErr(t2.rows))
