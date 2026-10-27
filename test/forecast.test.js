/**
 * 估算核心的单元测试 —— 全部跑纯函数，不碰宿主、不碰 DOM。
 *
 * 这些用例刻意都在测「会算错的地方」：把挂起时长算进工期、清单一条没勾就
 * 硬报 ETA、子代理会话混进来、换轮不清状态。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptySession, observeEvent, forecastSession, effectiveElapsed,
  isDisplayableSession, sessionIdOf,
} from '../lib/forecast.js'

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0)

/** 造一个「已开轮 + 写过清单」的会话。 */
function startedSession(now = T0) {
  const state = emptySession('s1')
  observeEvent(state, { type: 'turn/start', data: { turn: 1 } }, now)
  return state
}

function writeTodos(state, list, now) {
  observeEvent(state, { type: 'todo/write', data: { todos: list } }, now)
}

test('turn/start 打开一轮，turn/end 关掉它', () => {
  const state = startedSession()
  assert.equal(state.active, true)
  assert.equal(state.turn, 1)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, T0 + 60_000)
  assert.equal(state.active, false)
  assert.equal(state.lastTurnMs, 60_000)
  assert.equal(state.endReason, 'completed')
})

test('没有 todo 也没有历史时，不编造 ETA', () => {
  const state = startedSession()
  observeEvent(state, { type: 'step/start', data: { turn: 1, step: 1 } }, T0 + 1000)
  observeEvent(state, { type: 'step/end', data: { turn: 1, step: 1 } }, T0 + 5000)
  const snap = forecastSession(state, T0 + 6000)
  assert.equal(snap.phase, 'running')
  assert.equal(snap.remainMs, null)
  assert.equal(snap.confidence, 'none')
})

test('清单进度外推：勾掉一半 → 剩余约等于已用时长', () => {
  const state = startedSession()
  writeTodos(state, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'pending' },
    { content: 'd', status: 'pending' },
  ], T0 + 1000)
  const now = T0 + 121_000 // 已跑 2 分钟
  const snap = forecastSession(state, now)
  assert.equal(snap.progress, 0.5)
  assert.equal(snap.total, 4)
  assert.equal(snap.completed, 2)
  // 一半完成、剩一半 → 原始外推就是 2 分钟。显示层会把总时长再乘 1.2
  // （EARLY_CAP_MULTIPLIER，抵消夹取带来的低估），所以这里期望 2.4 分钟：
  // 2min(已用) + 2min(剩余) = 4min 总时长 → ×1.2 = 4.8min → 剩余 2.8min。
  // 断言的是「落在 1.2~1.4 倍之间」，而不是某个具体数字 —— 允许后续微调系数。
  assert.ok(snap.remainMs !== null, 'should have an estimate')
  assert.ok(
    snap.remainMs > 120_000 * 1.15 && snap.remainMs < 120_000 * 1.45,
    'remain should be ~1.2-1.4x of the raw 2min extrapolation, got ' + snap.remainMs
  )
  assert.ok(snap.etaAt !== null)
  assert.equal(snap.source, 'progress')
})

test('等用户的时间不计入工期', () => {
  const state = startedSession()
  writeTodos(state, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'pending' },
  ], T0 + 1000)

  // 第 30 秒发起提问，第 330 秒才回来 —— 中间 5 分钟是等用户。
  observeEvent(state, { type: 'tool/call', data: { name: 'ask_user_question' } }, T0 + 30_000)
  observeEvent(state, { type: 'tool/result', data: { callId: 'x' } }, T0 + 330_000)

  const now = T0 + 331_000
  const elapsed = effectiveElapsed(state, now)
  // 净工期 = 331 秒 - 300 秒挂起 = 31 秒
  assert.ok(Math.abs(elapsed - 31_000) < 1500, 'elapsed should exclude the pause, got ' + elapsed)
  const snap = forecastSession(state, now)
  assert.ok(snap.remainMs !== null)
  // 一半完成、净工期 31 秒 → 剩余也在半分钟左右，绝不该是 5 分钟
  assert.ok(snap.remainMs < 90_000, 'pause must not inflate ETA, got ' + snap.remainMs)
})

test('授权等待同样被扣掉', () => {
  const state = startedSession()
  writeTodos(state, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'pending' },
  ], T0 + 1000)
  observeEvent(state, { type: 'approval/asked', data: { id: 'ap1' } }, T0 + 20_000)
  observeEvent(state, { type: 'approval/decided', data: { id: 'ap1' } }, T0 + 140_000)
  const elapsed = effectiveElapsed(state, T0 + 141_000)
  assert.ok(Math.abs(elapsed - 21_000) < 1500, 'approval wait excluded, got ' + elapsed)
})

test('挂起中标记 paused', () => {
  const state = startedSession()
  observeEvent(state, { type: 'approval/asked', data: { id: 'ap1' } }, T0 + 10_000)
  const snap = forecastSession(state, T0 + 15_000)
  assert.equal(snap.paused, true)
  assert.ok(snap.pausedMs >= 4000)
})

test('换轮清空上一轮状态，不把旧进度带过来', () => {
  const state = startedSession()
  writeTodos(state, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'pending' },
  ], T0 + 1000)
  forecastSession(state, T0 + 60_000)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, T0 + 90_000)
  observeEvent(state, { type: 'turn/start', data: { turn: 2 } }, T0 + 100_000)

  const snap = forecastSession(state, T0 + 101_000)
  assert.equal(snap.phase, 'running')
  assert.equal(snap.turn, 2)
  assert.equal(snap.total, 0)
  assert.equal(snap.remainMs, null, 'a fresh turn must not inherit the previous ETA')
  assert.equal(state.stepDurations.length, 0)
  assert.equal(state.history.length, 1, 'history survives across turns')
})

test('单条耗时样本跨轮保留', () => {
  const state = startedSession()
  writeTodos(state, [{ content: 'a', status: 'pending' }], T0 + 1000)
  writeTodos(state, [{ content: 'a', status: 'completed' }], T0 + 41_000)
  assert.equal(state.unitHistory.length, 1)
  assert.ok(Math.abs(state.unitHistory[0] - 40_000) < 1500, 'unit sample ~40s, got ' + state.unitHistory[0])

  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, T0 + 45_000)
  observeEvent(state, { type: 'turn/start', data: { turn: 2 } }, T0 + 50_000)
  assert.equal(state.unitHistory.length, 1, 'unit samples are cross-turn priors')
})

test('EWMA 平滑：连续两次快照不会跳成随机数', () => {
  const state = startedSession()
  writeTodos(state, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ], T0 + 1000)
  const first = forecastSession(state, T0 + 61_000).remainMs
  const second = forecastSession(state, T0 + 62_000).remainMs
  assert.ok(first !== null && second !== null)
  // 1 秒内不该出现超过 30% 的跳变
  assert.ok(Math.abs(second - first) / first < 0.3, 'smoothed, ' + first + ' → ' + second)
})

test('子代理会话不展示', () => {
  assert.equal(isDisplayableSession({ header: { origin: 'subagent' } }), false)
  assert.equal(isDisplayableSession({ header: { delegationDepth: 2 } }), false)
  assert.equal(isDisplayableSession({ header: { delegationDepth: 0 } }), true)
  assert.equal(isDisplayableSession({ header: {} }), true)
  assert.equal(isDisplayableSession(null), true, 'unreadable session must not silence everything')
})

test('sessionIdOf 兼容 header.id 与顶层 id', () => {
  assert.equal(sessionIdOf({ header: { id: 'abc' }, id: 'zzz' }), 'abc')
  assert.equal(sessionIdOf({ id: 'zzz' }), 'zzz')
  assert.equal(sessionIdOf(null), 'unknown')
})

test('空清单但历史够多时，用整轮均值兜底', () => {
  const state = startedSession()
  state.history.push(200_000, 220_000, 210_000, 205_000)
  const snap = forecastSession(state, T0 + 30_000)
  assert.ok(snap.remainMs !== null, 'history fallback should produce an estimate')
  assert.equal(snap.source, 'history')
  assert.ok(snap.remainMs < 200_000, 'remaining = avg - elapsed, got ' + snap.remainMs)
})

test('未知事件与畸形载荷一律忽略，不抛错', () => {
  const state = startedSession()
  assert.doesNotThrow(() => observeEvent(state, { type: 'something/else', data: {} }, T0))
  assert.doesNotThrow(() => observeEvent(state, null, T0))
  assert.doesNotThrow(() => observeEvent(state, { type: 'todo/write', data: {} }, T0))
  assert.doesNotThrow(() => forecastSession(emptySession('x'), T0))
})

/* ---------- 没有 todo 清单时的兜底（这是线上真实踩到的场景） ---------- */

/** 喂 n 个固定时长的步（start→end 各 stepMs）。 */
function feedSteps(state, n, startAt, stepMs) {
  let t = startAt
  for (let i = 0; i < n; i++) {
    observeEvent(state, { type: 'step/start', data: { turn: state.turn, step: i + 1 } }, t)
    t += stepMs
    observeEvent(state, { type: 'step/end', data: { turn: state.turn, step: i + 1 } }, t)
  }
  return t
}

test('完全没有 todo 清单时，靠步数也能给出 ETA（不再永远「看不出节奏」）', () => {
  const state = startedSession()
  // 一轮 178 步、一条 todo 都没写 —— 这是线上真实发生的情况。
  const now = feedSteps(state, 20, T0 + 1000, 5000)
  const snap = forecastSession(state, now + 1000)
  assert.equal(snap.total, 0, 'no todo list at all')
  assert.notEqual(snap.remainMs, null, 'steps fallback must produce an estimate')
  assert.equal(snap.source, 'steps')
  assert.ok(snap.etaAt !== null, 'ETA clock must be available')
  assert.ok(snap.remainMs > 0 && snap.remainMs < 8 * 3600_000)
})

test('步数不够 2 个样本时仍然诚实地不报 ETA', () => {
  const state = startedSession()
  const now = feedSteps(state, 1, T0 + 1000, 5000)
  const snap = forecastSession(state, now + 1000)
  assert.equal(snap.remainMs, null, 'one sample is not a rhythm')
  assert.equal(snap.confidence, 'none')
})

test('跨轮步数历史让「还剩多少」更准，且离群轮次不污染中位数', () => {
  const state = startedSession()
  // 历史：6 轮分别 23/19/7/7/26/178 步 —— 178 是真实存在的抽风轮次。
  state.stepHistory.push(23, 19, 7, 7, 26, 178)
  const now = feedSteps(state, 5, T0 + 1000, 5000)
  const snap = forecastSession(state, now + 1000)
  assert.equal(snap.source, 'steps')
  // 中位数是 21，不是平均数 43.3；5 步已走 → 还剩约 16 步 × 5s = 80s
  assert.ok(snap.remainMs < 180_000,
    'median must resist the 178-step outlier, got ' + snap.remainMs)
  assert.ok(snap.remainMs > 20_000, 'but still a sane positive estimate, got ' + snap.remainMs)
})

test('中途接管：插件在轮次进行中加载，也能积累步长样本', () => {
  // 模拟 DSH 已经在跑、插件才被加载 —— 这一轮的 turn/start 从未收到。
  const state = emptySession('mid')
  const now = feedSteps(state, 5, T0 + 1000, 4000)
  assert.equal(state.active, true, 'step events must adopt the running turn')
  assert.equal(state.stepDurations.length, 5, 'step samples must accumulate')
  const snap = forecastSession(state, now + 500)
  assert.notEqual(snap.remainMs, null, 'mid-turn adoption must still produce an ETA')
})

test('中途接管的那一轮不写进跨轮历史（时长与步数都不完整）', () => {
  const state = emptySession('mid')
  const now = feedSteps(state, 6, T0 + 1000, 3000)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, now + 1000)
  assert.equal(state.history.length, 0, 'partial turn must not pollute turn-duration history')
  assert.equal(state.stepHistory.length, 0, 'partial turn must not pollute step-count history')

  // 正常轮次（收到 turn/start）仍然要记
  observeEvent(state, { type: 'turn/start', data: { turn: 2 } }, now + 2000)
  const end = feedSteps(state, 4, now + 2500, 3000)
  observeEvent(state, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }, end + 500)
  assert.equal(state.history.length, 1, 'a fully observed turn must be recorded')
  assert.equal(state.stepHistory.length, 1)
  assert.equal(state.stepHistory[0], 4)
})

test('被中断的轮次不记进步数历史（步数偏低会拉低后续估计）', () => {
  const state = startedSession()
  feedSteps(state, 3, T0 + 1000, 2000)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }, T0 + 30_000)
  assert.equal(state.stepHistory.length, 0, 'aborted turn is not a typical turn')
  assert.equal(state.history.length, 1, 'but its duration is still a real duration')
})

test('步数外推的置信度不会冒充「较准」', () => {
  const state = startedSession()
  state.stepHistory.push(20, 22, 24)
  const now = feedSteps(state, 12, T0 + 1000, 3000)
  const snap = forecastSession(state, now + 500)
  assert.equal(snap.source, 'steps')
  assert.notEqual(snap.confidence, 'high', 'steps-only estimate must not claim high confidence')
})

/* ---------- 超时：超过预测之后不再演倒计时，并把误差学回来 ---------- */

test('跑过预测终点（含宽容期）后标记超时，且**仍然给重估时间**', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20) // 一轮通常 20 步
  // 先拿一次预测（锚定 turnFirstPredictedMs）
  const t1 = feedSteps(state, 6, T0 + 1000, 3000)
  const first = forecastSession(state, t1 + 500)
  assert.ok(first.remainMs > 0, 'sanity: an early forecast exists')
  assert.equal(first.overtime, false, 'not overtime yet')

  // 一路走到远超「预测的总时长」（预测 ≈ 20-6=14 步 × 3s ≈ 42s）+ 90s 宽容期
  const late = feedSteps(state, 8, t1 + 2000, 60_000) // 每步 60 秒：迅速越过预测
  const snap = forecastSession(state, late + 1000)
  assert.equal(snap.overtime, true, 'must be flagged overtime past the anchor + grace')
  assert.ok(snap.overtimeMs > 0, 'overtimeMs should measure how far past the deadline')
  // 超时后**保留** remainMs：那是「按现有样本重估还要多久」。
  // 之前这里归 null，结果整整一轮只显示「已超时 N 分」、再没有任何时间信息 ——
  // 实测那轮因此连续 88 分钟什么都没告诉用户。
  assert.ok(snap.remainMs > 0,
    'a revised estimate must survive overtime (it is what the UI shows as 重估还要 M 分)')
  assert.ok(snap.etaAt > snap.updatedAt, 'etaAt follows the revised estimate')
})

test('宽容期内不闪「超时」', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20)
  const t1 = feedSteps(state, 6, T0 + 1000, 3000)
  forecastSession(state, t1 + 500) // 锚定预测
  // 略微超出（预测 ~42s + 宽容 90s = 132s；现在只跑到 ~60s）
  const t2 = feedSteps(state, 2, t1 + 2000, 15_000)
  const snap = forecastSession(state, t2 + 1000)
  assert.equal(snap.overtime, false, 'within the grace window must not flash overtime')
})

test('超时过的会话会把「超出比例」学进下一轮（估计变保守）', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20)
  // 第一轮：预测 14 步 × 3s ≈ 42s，实际跑 ~3 分钟（超时 4 倍多）
  const t1 = feedSteps(state, 6, T0 + 1000, 3000)
  forecastSession(state, t1 + 500)
  const end1 = feedSteps(state, 8, t1 + 2000, 60_000)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, end1 + 1000)
  assert.ok(state.overtimeHistory.length > 0, 'an overtime turn must be learned')
  assert.ok(state.overtimeHistory[0] > 1, 'the ratio must be meaningful')

  // 第二轮：同样的步数节奏，预测应当比「没超时过的会话」更长
  observeEvent(state, { type: 'turn/start', data: { turn: 2 } }, end1 + 5000)
  state.stepHistory.push(20, 20, 20)
  const t2 = feedSteps(state, 6, end1 + 6000, 3000)
  const learned = forecastSession(state, t2 + 500)

  const naive = startedSession()
  naive.stepHistory.push(20, 20, 20)
  const t3 = feedSteps(naive, 6, T0 + 1000, 3000)
  const notLearned = forecastSession(naive, t3 + 500)

  assert.ok(learned.remainMs > notLearned.remainMs,
    'a session that overtime-ed before must now estimate longer: '
    + learned.remainMs + ' vs ' + notLearned.remainMs)
})

test('没超时的轮次不记超时样本（预测基本准时就不放大）', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20)
  const t1 = feedSteps(state, 6, T0 + 1000, 3000)
  forecastSession(state, t1 + 500)
  // 实际用时 ≈ 预测（42s 内收尾）
  const end = feedSteps(state, 14, t1 + 2000, 2800)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, end + 500)
  assert.equal(state.overtimeHistory.length, 0,
    'an on-time turn must not poison the overtime history')
})

test('被中断/出错的轮次不进超时历史（预测锚点不可信）', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20)
  const t1 = feedSteps(state, 6, T0 + 1000, 3000)
  forecastSession(state, t1 + 500)
  const end = feedSteps(state, 4, t1 + 2000, 60_000)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }, end + 1000)
  assert.equal(state.overtimeHistory.length, 0,
    'an aborted turn says nothing about prediction quality')
})

test('放大量有上限（离谱的超时记录不会把估计放大到失控）', () => {
  const state = startedSession()
  // 直接塞满极端超时记录
  for (let i = 0; i < 8; i++) state.overtimeHistory.push(50) // 超出 50 倍
  state.stepHistory.push(20, 20, 20)
  const now = feedSteps(state, 6, T0 + 1000, 3000)
  const snap = forecastSession(state, now + 500)
  const naive = startedSession()
  naive.stepHistory.push(20, 20, 20)
  const now2 = feedSteps(naive, 6, T0 + 1000, 3000)
  const naiveSnap = forecastSession(naive, now2 + 500)
  assert.ok(snap.remainMs <= naiveSnap.remainMs * 1.6 + 1,
    'the amplification must cap at OVERTIME_MARGIN_MAX, got '
    + snap.remainMs + ' vs ' + naiveSnap.remainMs)
})

/* ---------- 进度条：没有清单时也不能永远空着 ---------- */

test('有清单时进度来自清单，来源标记为 todos', () => {
  const state = startedSession()
  writeTodos(state, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'pending' },
    { content: 'd', status: 'pending' },
  ], T0 + 1000)
  const snap = forecastSession(state, T0 + 60_000)
  assert.equal(snap.progress, 0.5)
  assert.equal(snap.progressSource, 'todos')
})

test('没有清单时进度用步数代理，不再是 null（这就是那根空灰条的成因）', () => {
  const state = startedSession()
  // 一条 todo 都没写，但走了 8 步
  const now = feedSteps(state, 8, T0 + 1000, 5000)
  const snap = forecastSession(state, now + 500)
  assert.equal(snap.total, 0, 'no todo list')
  assert.notEqual(snap.progress, null, 'progress must not stay null when steps are flowing')
  assert.equal(snap.progressSource, 'steps')
  assert.ok(snap.progress > 0 && snap.progress <= 0.95, 'progress in (0, 0.95], got ' + snap.progress)
})

test('步数代理的进度用历史「通常几步」当分母', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20) // 一轮通常 20 步
  const now = feedSteps(state, 10, T0 + 1000, 4000)
  const snap = forecastSession(state, now + 500)
  assert.equal(snap.progressSource, 'steps')
  // 10/20 = 0.5
  assert.ok(Math.abs(snap.progress - 0.5) < 0.06, 'expected ~0.5, got ' + snap.progress)
})

test('步数代理的进度不会满格（走超了也留余地）', () => {
  const state = startedSession()
  state.stepHistory.push(10, 10, 10) // 通常 10 步
  const now = feedSteps(state, 40, T0 + 1000, 1000) // 已经走了 40 步
  const snap = forecastSession(state, now + 500)
  assert.equal(snap.progressSource, 'steps')
  assert.ok(snap.progress <= 0.95,
    'progress must cap below 100% — a full bar looks finished, got ' + snap.progress)
})

test('刚开始（步数样本不足）时进度仍为 null，让前端隐藏进度条', () => {
  const state = startedSession()
  const now = feedSteps(state, 1, T0 + 1000, 5000)
  const snap = forecastSession(state, now + 500)
  assert.equal(snap.progress, null, 'one step is not enough to claim progress')
  assert.equal(snap.progressSource, 'none')
})

test('已结束的轮次不把步数代理当进度（它已经 100% 了）', () => {
  const state = startedSession()
  feedSteps(state, 5, T0 + 1000, 2000)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, T0 + 30_000)
  const snap = forecastSession(state, T0 + 31_000)
  assert.equal(snap.phase, 'done')
  assert.equal(snap.progressSource, 'none', 'a finished turn has no partial progress')
})

/* ---------- 准确性：成熟锚点 + 长先验参与 + 精度可度量 ---------- */

test('超时锚点用「成熟预测」，不被最早那次乐观预测带偏', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20)
  // 早期只有 1~2 个样本时给一次预测（最乐观）
  const t1 = feedSteps(state, 2, T0 + 1000, 1000)
  const early = forecastSession(state, t1 + 200)
  assert.ok(early.remainMs > 0)

  // 样本攒够之前，把步时拉长 —— 估计会显著变大
  const t2 = feedSteps(state, 6, t1 + 500, 20_000)
  const matured = forecastSession(state, t2 + 200)
  assert.ok(matured.remainMs > early.remainMs,
    'the mature estimate must be larger than the early optimistic one')

  // 现在停在「早期预测的终点之后、成熟预测终点之前」：
  // 老逻辑（锚定首次预测）会误报超时；新逻辑不该报。
  const betweenEarlyAndMature = T0 + 1000 + (early.remainMs + 60_000)
  const snap = forecastSession(state, betweenEarlyAndMature)
  assert.equal(snap.overtime, false,
    'must not declare overtime based on the fragile first prediction '
    + '(the mature estimate still says there is time)')
})

test('没有 todo 清单时，整轮时长先验与步数一起参与（不再排在最后）', () => {
  const state = startedSession()
  // 两轮历史：这类一轮通常 10 分钟
  state.history.push(600_000, 620_000)
  state.stepHistory.push(20, 20)
  const now = feedSteps(state, 4, T0 + 1000, 3000)
  const snap = forecastSession(state, now + 500)
  // 两条来源都进了加权 —— 历史先验不再只是「什么都没有时的兜底」
  assert.ok(snap.source.indexOf('history') !== -1,
    'the whole-turn duration prior must participate alongside steps, got ' + snap.source)
})

test('只有一轮历史时它只做微调，不能盖过步数证据', () => {
  const state = startedSession()
  state.history.push(600_000) // 上一轮 10 分钟
  state.stepHistory.push(20)
  const now = feedSteps(state, 4, T0 + 1000, 3000)
  const snap = forecastSession(state, now + 500)
  // 单样本参与（约束 a 低权重），但步数先验仍主导 —— 来源里两者都在，
  // 且结果不该被「上一轮 10 分钟」整个拽走。
  assert.ok(snap.source.indexOf('steps') !== -1,
    'the step evidence must still be present, got ' + snap.source)
  const soloSteps = startedSession()
  soloSteps.stepHistory.push(20)
  const t2 = feedSteps(soloSteps, 4, T0 + 1000, 3000)
  const soloSnap = forecastSession(soloSteps, t2 + 500)
  assert.ok(snap.remainMs > soloSnap.remainMs,
    'one learned turn should pull the estimate up, but only modestly: '
    + snap.remainMs + ' vs ' + soloSnap.remainMs)
  assert.ok(snap.remainMs < 600_000,
    'it must not be dominated by the previous turn duration')
})

test('刚开局、只有一轮历史、还没有步数样本时**不报数字**', () => {
  const state = startedSession()
  state.history.push(600_000) // 上一轮 10 分钟
  // 一个步长样本都没有，只有上一轮那条记录 —— 这不是估计，是把上一轮硬套过来
  const snap = forecastSession(state, T0 + 2000)
  assert.equal(snap.remainMs, null,
    'a lone history sample with no other evidence must not produce an ETA')
})

test('精度可度量：轮次结束时记下「预测 vs 实际」', () => {
  const state = startedSession()
  state.stepHistory.push(20, 20, 20)
  const t1 = feedSteps(state, 6, T0 + 1000, 3000)
  forecastSession(state, t1 + 500)
  // 预测总时长约 42s，实际跑到 ~300s —— 明显估短
  const end = feedSteps(state, 4, t1 + 2000, 70_000)
  observeEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, end + 500)

  assert.ok(state.accuracyHistory.length === 1, 'one completed turn → one accuracy sample')
  const rec = state.accuracyHistory[0]
  assert.ok(rec.actual > 0 && rec.predicted > 0)
  assert.ok(rec.errorRatio < 0, 'we under-estimated, so the signed error must be negative')

  const snap = forecastSession(state, end + 1000)
  assert.equal(snap.accuracy.samples, 1)
  assert.ok(snap.accuracy.mape >= 0, 'mape is an absolute error')
})

test('精度摘要样本不足时返回 null，不编数字', () => {
  const state = startedSession()
  const now = feedSteps(state, 3, T0 + 1000, 2000)
  const snap = forecastSession(state, now + 500)
  assert.equal(snap.accuracy.samples, 0)
  assert.equal(snap.accuracy.mape, null)
  assert.equal(snap.accuracy.bias, null)
})

/* ---------------- 早期上界：把「刚跑两步就报 70 分钟」压回去 ---------------- */

test('早期慢步骤不再报出天文数字（这一条是本插件的坏名声来源）', () => {
  const state = startedSession()
  // 三步各 200 秒。老逻辑会拿 200s 当步时 × 24 步兜底 → 报「还有 70 分钟」。
  feedSteps(state, 3, T0, 200_000)
  const elapsed = 200_000
  const snap = forecastSession(state, T0 + elapsed)

  assert.equal(snap.source, 'steps')
  assert.ok(snap.remainMs !== null, 'should have an estimate')
  // 上界 ≈ elapsed × k + 120s，k(200s)≈2.69 → 上限 ~660s。必须落在界内。
  assert.ok(snap.remainMs < elapsed * 4, 'early estimate must stay near elapsed, got ' + snap.remainMs)
})

test('早期上界随 elapsed 放松：跑得越久，允许的剩余越长', () => {
  const state = startedSession()
  feedSteps(state, 3, T0, 200_000)
  const early = forecastSession(state, T0 + 200_000).remainMs
  const later = forecastSession(state, T0 + 600_000).remainMs
  assert.ok(later > early, 'ceiling must relax with elapsed (' + early + ' → ' + later + ')')
})

test('长轮基本不受上界影响（夹的是早期高估，不是长期估计）', () => {
  const state = startedSession()
  // 100 步 × 30s = 3000s 已跑，步时稳定 → 估计本就合理，不该被压。
  feedSteps(state, 100, T0, 30_000)
  const elapsed = 3_000_000
  const snap = forecastSession(state, T0 + elapsed)
  assert.ok(snap.remainMs !== null)
  // 未夹时约 24 步 × 30s ≈ 720s（该处接近步数兜底）；夹取后仍应在同一量级。
  assert.ok(snap.remainMs > 300_000, 'long turns must not be crushed, got ' + snap.remainMs)
})

test('上界只改显示值，不推进超时判定', () => {
  const state = startedSession()
  feedSteps(state, 3, T0, 200_000)
  const snap = forecastSession(state, T0 + 200_000)
  // 超时判定用的是未夹的锚点；此刻绝不该已经判超时。
  assert.equal(snap.overtime, false, 'a 200s-old turn must not be marked overtime')
  // 而显示值确实被压过了（这就是「只在显示层」的意义）。
  const anchorTotal = state.maturePredictedMs > 0
    ? state.maturePredictedMs + Math.max(0, state.maturePredictedAt - state.turnStartedAt)
    : null
  if (anchorTotal !== null) {
    assert.ok(anchorTotal >= 200_000, 'anchor must be the raw (uncapped) prediction')
  }
})
