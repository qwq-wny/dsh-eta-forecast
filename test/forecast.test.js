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
