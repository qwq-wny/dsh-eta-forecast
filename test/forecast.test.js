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
  // 一半完成、剩一半 → 约 2 分钟（平滑前就是这个数，允许 20% 误差）
  assert.ok(snap.remainMs !== null, 'should have an estimate')
  assert.ok(Math.abs(snap.remainMs - 120_000) < 24_000, 'remain ~2min, got ' + snap.remainMs)
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
