/**
 * dsh-eta-forecast — 纯估算核心（无 IO、无 DOM，可单独跑 node --test）
 *
 * 输入是一串 DSH 会话事件（`session/event` 里那些 turn/start、step/end、
 * todo/write、tool/call……），输出是「这一轮还剩多久、几点完」。
 *
 * 设计原则（为什么不是拍脑袋的线性外推）：
 *   1. **只信可观测的进度**。模型自己的步数并不等于工作量，所以真正的分母是
 *      todo 清单里的条目（模型被要求「开工前先列清单、做完就勾」）；步数只用来
 *      估「一个条目平均要几步」，是节奏修正项，不是进度本身。
 *   2. **等用户的时间不算工期**。`ask_user_question` 与 `approval/asked` 期间
 *      这一轮是挂起的，把这段挂起时长从 elapsed 里扣掉，否则一次授权等待就能把
 *      ETA 推到几小时之后，而且再也收不回来。
 *   3. **没有样本就承认没有样本**。一轮刚开始、清单一条都没勾时，任何数字都是
 *      编的；这时宁可回「样本不足」也不给一个会立刻打脸的 ETA。
 *   4. **平滑而不是重算**。每次事件都重算会让 ETA 抖动成随机数；用 EWMA 把
 *      剩余时长慢慢挪过去，用户看到的才是「一个在收敛的估计」。
 *
 * @module dsh-eta-forecast/forecast
 */

/** 步长样本上限（只留最近的，节奏会变）。 */
const MAX_STEP_SAMPLES = 24
/** 已完成轮次的时长样本上限。 */
const MAX_HISTORY = 12
/** 「一条 todo 花多久」的样本上限。 */
const MAX_UNIT_SAMPLES = 48
/** 估算下限 / 上限：低于 1 秒没有意义，高于 8 小时一定是模型抽风。 */
const MIN_REMAIN_MS = 1000
const MAX_REMAIN_MS = 8 * 60 * 60 * 1000
/** EWMA 系数：越大越跟手，越小越稳。0.32 在实测里既跟得上换档也不抖。 */
const SMOOTH_ALPHA = 0.32
/**
 * 没有跨轮步数历史时，假设「一轮大约走这么多步」。
 *
 * 实测（本仓库自己的会话日志）：6 轮分别是 23/19/7/7/26/178 步，中位数 21。
 * 取 24 略高于中位数：宁可估长一点再慢慢收敛，也不要早早显示「还剩 1 分钟」
 * 然后一路打脸 —— 这个挂件最容易失去信任的方式就是反复「马上就好」。
 */
const FALLBACK_STEPS_PER_TURN = 24
/**
 * 本轮步数已经超过「通常步数」时，假设还要再走几步收尾。
 * 不报 0，是因为 0 会渲染成「还有 1 秒」，明显是假数字。
 */
const OVERSHOOT_STEPS = 4
/**
 * 超时学习：每次实际用时超过预测，记下「超出比例」（实际 / 预测 − 1），
 * 后续估计按最近记录的**中位比例**放大，上限 OVERTIME_MARGIN_MAX。
 *
 * 为什么用比例而不是绝对毫秒：一轮 2 分钟超 30 秒和一轮 2 小时超 30 秒
 * 完全是两回事，比例才可跨轮比较。为什么封顶：真在抽风的会话不该被一条
 * 离谱的超时记录无限放大 —— 1.6 倍足够宽容又不失控。
 */
const OVERTIME_MARGIN_MAX = 1.6
/** 超时历史样本上限（与轮次历史同量级）。 */
const MAX_OVERTIME_SAMPLES = 8
/**
 * 超时判定的宽容期：跑过预测终点之后，再等 90 秒才算「真超时」。
 *
 * 预测本身带误差，早 30~60 秒结束是常态；没有这个缓冲，每轮最后都会
 * 闪一下「已超时」，比「还有 1 秒」卡住更让人烦。
 */
const OVERTIME_GRACE_MS = 90 * 1000

/** 把数组截到最近 n 个（原地）。 */
function cap(list, n) {
  if (list.length > n) list.splice(0, list.length - n)
  return list
}

/** 算术平均；空数组返回 null。 */
function mean(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  let sum = 0
  for (const v of list) sum += v
  return sum / list.length
}

/**
 * 中位数；空数组返回 null。
 *
 * 先验一律用中位数而不是平均数：一轮抽风跑两小时（真实发生过，178 步 / 1122 秒）
 * 会把平均值整个拽走，之后每一轮都被那个离群值拖着报一个离谱的时长。
 */
function median(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  const sorted = list.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 新建一条会话的估算状态。 */
export function emptySession(id) {
  return {
    id: String(id == null ? 'unknown' : id),
    title: '',
    /** 本轮是否还在跑（turn/start 之后、turn/end 之前）。 */
    active: false,
    /** 当前轮次号（DSH 自己的 turn 计数，从 1 开始）。 */
    turn: 0,
    /** 本轮开始时刻（epoch ms）；0 = 没有进行中的轮。 */
    turnStartedAt: 0,
    /** 最近一次 turn/end 的时刻与原因（`completed` / `aborted` / `error` …）。 */
    turnEndedAt: 0,
    endReason: '',
    /** 最近一轮总时长（含挂起），用于「已完成」展示与历史先验。 */
    lastTurnMs: 0,
    /** 本轮已完成的步数样本（ms）。 */
    stepDurations: [],
    /** 本轮每次 step/start 的时刻，用来算「当前这一步跑了多久」。 */
    stepStarts: [],
    /** 本轮已发出的步数（step/start 次数）。 */
    stepCount: 0,
    /** 挂起（等用户提问 / 等授权）累计时长，以及本次挂起起点。 */
    pausedTotalMs: 0,
    pauseStartedAt: 0,
    pauseKind: '',
    /** 本轮的 todo 清单；null = 这一轮还没写过清单（与宿主投影语义一致）。 */
    todos: null,
    todosAt: 0,
    /** 上一次见到的已完成条数，用来在勾掉一条时记一次「单条耗时」。 */
    completedSeen: 0,
    /** 跨轮历史：整轮时长、单条耗时、单轮步数。 */
    history: [],
    unitHistory: [],
    /**
     * 每轮走了多少步（跨轮保留）。
     *
     * 没有 todo 清单时，这是唯一还能用的进度代理：知道「一轮通常 N 步」，
     * 就能把「已走 k 步」换算成「大概还剩 (N-k) 步」。
     */
    stepHistory: [],
    /**
     * 本轮是不是「中途接管」的（插件在轮次进行中才加载）。
     * 这种轮次只看到后半截，步数/时长都不完整，结束时不能记进历史。
     */
    adoptedMidTurn: false,
    /** 平滑后的剩余时长（ms）；null = 还没有可用估计。 */
    smoothedRemainMs: null,
    smoothedAt: 0,
    /** 最近一次事件时刻，用于挑「当前会话」。 */
    lastEventAt: 0,
    /** 本轮开始以来见过的最大步数，用于「进度按步数回退」的兜底。 */
    peakStep: 0,
    /**
     * 本轮**最近一次**给出的预测剩余时长（平滑后的，epoch ms 时刻）。
     * 轮次结束时拿它和实际总时长比较，就知道这次预测是准还是超了。
     */
    lastPredictedMs: null,
    lastPredictedAt: 0,
    /**
     * 本轮**第一次**给出预测的时刻与数值 —— 超时判定的锚点。
     *
     * 不能用最近一次预测：后续估计会不断把 eta 推后，永远追不上。
     * 锚定轮次开始时给的预测，才能稳定判断「这轮比当初说的久」。
     */
    turnFirstPredictedMs: 0,
    turnFirstPredictedAt: 0,
    /**
     * 超时追踪：本轮是否已经**超过预测时间**还在跑。
     *
     * 之前 ETA 只会往下走（「还有 3 分」→「还有 2 分」），跑过预测点之后
     * 仍然显示一个不断逼近 0 的假数字 —— 用户看到「还有 1 秒」卡了好几分钟，
     * 却不知道这轮已经超时了。开了这个标记，前端改显「已超时 N 分」，
     * 而不是继续演一个倒计时。
     */
    overtime: false,
    /** 超时从哪个时刻开始（epoch ms）；0 = 没超时。 */
    overtimeSince: 0,
    /**
     * 跨轮超时历史（毫秒）：每次轮次结束，若实际用时超出**预测的中点**，
     * 记下「超出多少」。这个差值会回灌进下一轮的估计（见 OVERTIME_MARGIN），
     * 让插件从自己的误差里学习 —— 超时越频繁的会话，后续估计越保守。
     */
    overtimeHistory: [],
  }
}

/** 这一轮已经「算过工期」的毫秒数（扣掉挂起）。 */
export function effectiveElapsed(state, now) {
  if (!state || state.turnStartedAt <= 0) return 0
  const paused = state.pausedTotalMs + (state.pauseStartedAt > 0 ? Math.max(0, now - state.pauseStartedAt) : 0)
  return Math.max(0, now - state.turnStartedAt - paused)
}

/**
 * 中途接管：插件是宿主运行中才加载的，当前这一轮的 turn/start 我们没见过。
 *
 * 这时把状态补成「本轮正在进行」，起点用此刻。代价是 elapsed 偏小（不知道
 * 这一轮真正什么时候开始的），但换来的是步长样本能积累起来 —— 没有样本，
 * 后面的所有估算都是空的。宁可时长估短，也不要整轮一片「样本不足」。
 */
function adoptTurnIfNeeded(state, data, now) {
  if (state.turnStartedAt > 0) return false
  const turn = Number(data && data.turn)
  state.active = true
  state.turn = Number.isFinite(turn) ? turn : (state.turn || 1)
  state.turnStartedAt = now
  state.turnEndedAt = 0
  state.endReason = ''
  state.smoothedRemainMs = null
  state.smoothedAt = 0
  // 标记「这一轮我们只看到了后半截」：结束时步数与时长都不完整，
  // 不能记进跨轮历史，否则「一轮通常几步」会被严重低估。
  state.adoptedMidTurn = true
  return true
}

/** 开始一次挂起（等用户）。重复调用只记第一次。 */
function beginPause(state, now, kind) {
  if (state.pauseStartedAt > 0) return
  state.pauseStartedAt = now
  state.pauseKind = kind
}

/** 结束挂起。 */
function endPause(state, now) {
  if (state.pauseStartedAt <= 0) return
  state.pausedTotalMs += Math.max(0, now - state.pauseStartedAt)
  state.pauseStartedAt = 0
  state.pauseKind = ''
}

/** 统计当前 todo 清单的完成情况。 */
function tallyTodos(todos) {
  const list = Array.isArray(todos) ? todos : []
  let completed = 0
  let inProgress = 0
  let current = ''
  for (const item of list) {
    const status = item && item.status
    if (status === 'completed') completed++
    else if (status === 'in_progress') {
      inProgress++
      if (!current) current = String(item.content || '')
    }
  }
  const pending = list.length - completed - inProgress
  return { total: list.length, completed, inProgress, pending, current }
}

/**
 * 吃进一条会话事件，原地更新估算状态。
 *
 * @param {object} state - {@link emptySession} 造出来的状态对象。
 * @param {{type?: string, data?: object}} event - DSH 的 session/event。
 * @param {number} now - 事件到达时刻（epoch ms）。
 * @returns {object} 同一个 state。
 */
export function observeEvent(state, event, now) {
  if (!state || !event || typeof event.type !== 'string') return state
  const type = event.type
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  state.lastEventAt = now

  switch (type) {
    case 'turn/start': {
      const turn = Number(data.turn)
      state.active = true
      state.turn = Number.isFinite(turn) ? turn : state.turn + 1
      state.turnStartedAt = now
      state.turnEndedAt = 0
      state.endReason = ''
      state.stepDurations = []
      state.stepStarts = []
      state.stepCount = 0
      state.peakStep = 0
      state.pausedTotalMs = 0
      state.pauseStartedAt = 0
      state.pauseKind = ''
      // 宿主侧 todo 投影在 turn/start 时清空，这里保持一致。
      state.todos = null
      state.todosAt = 0
      state.completedSeen = 0
      state.smoothedRemainMs = null
      state.smoothedAt = 0
      state.adoptedMidTurn = false
      // 新一轮：超时锚点与超时状态全部归零。
      state.turnFirstPredictedMs = 0
      state.turnFirstPredictedAt = 0
      state.overtime = false
      state.overtimeSince = 0
      return state
    }

    case 'step/start': {
      // 插件是「中途接管」的：DSH 已经在跑、用户重启宿主后才加载本插件时，
      // 这一轮的 turn/start 我们从来没收到过。早期版本在这里直接 return，
      // 于是整轮一个步长样本都没有 —— 表现就是「一直在跑，一直看不出节奏」。
      // 现在补一条隐式开轮：拿当前时刻当起点（elapsed 会偏小，但样本能积累起来，
      // 而样本才是估算的本体）。
      adoptTurnIfNeeded(state, data, now)
      state.stepStarts.push(now)
      cap(state.stepStarts, MAX_STEP_SAMPLES)
      state.stepCount++
      state.peakStep = Math.max(state.peakStep, Number(data.step) || state.stepCount)
      return state
    }

    case 'step/end': {
      adoptTurnIfNeeded(state, data, now)
      const startedAt = state.stepStarts.length > 0 ? state.stepStarts[state.stepStarts.length - 1] : 0
      if (startedAt > 0) {
        state.stepStarts.pop()
        state.stepDurations.push(Math.max(0, now - startedAt))
        cap(state.stepDurations, MAX_STEP_SAMPLES)
      }
      return state
    }

    case 'todo/write': {
      if (!Array.isArray(data.todos)) return state
      const before = state.completedSeen
      state.todos = data.todos.map((item) => ({
        content: String((item && item.content) || ''),
        status: String((item && item.status) || 'pending'),
      }))
      state.todosAt = now
      const after = state.todos.filter((item) => item.status === 'completed').length
      // 勾掉条目 = 一条真实的工作量单位完成；用「开工到此刻的净工期 / 已完成条数」
      // 记一次单条耗时样本（跨轮保留，换个会话也还有先验）。
      if (after > before && after > 0 && state.turnStartedAt > 0) {
        const perUnit = effectiveElapsed(state, now) / after
        if (perUnit > 0) {
          state.unitHistory.push(perUnit)
          cap(state.unitHistory, MAX_UNIT_SAMPLES)
        }
      }
      state.completedSeen = after
      return state
    }

    case 'tool/call': {
      const name = String(data.name || data.toolName || '')
      if (name === 'ask_user_question') beginPause(state, now, 'question')
      return state
    }

    case 'tool/result': {
      if (state.pauseKind === 'question') endPause(state, now)
      return state
    }

    case 'approval/asked': {
      beginPause(state, now, 'approval')
      return state
    }

    case 'approval/decided':
    case 'approval/resolved': {
      if (state.pauseKind === 'approval') endPause(state, now)
      return state
    }

    case 'turn/end': {
      if (state.turnStartedAt > 0) {
        endPause(state, now)
        const total = Math.max(0, now - state.turnStartedAt)
        state.lastTurnMs = total
        // 中途接管的那一轮只看到后半截：时长与步数都不完整，记进历史会把
        // 「一轮通常多久/几步」系统性拉低，后面每一轮的 ETA 都会跟着偏短。
        if (!state.adoptedMidTurn) {
          state.history.push(total)
          cap(state.history, MAX_HISTORY)
          // 一轮走了几步 —— 没有 todo 清单时，这是唯一能推算「还剩多少」的代理指标。
          // 被中断/出错的轮次不算：它们没走完，步数偏低会把「通常几步」拉下水。
          const reason = String((data.reason && data.reason.kind) || '')
          if (state.stepCount > 0 && (reason === 'completed' || reason === '')) {
            state.stepHistory.push(state.stepCount)
            cap(state.stepHistory, MAX_HISTORY)
          }
          // 超时学习：实际用时 vs **第一次**给出的预测（锚定轮次开始，
          // 而不是被后续估计不断推后的 eta）。超出才记，记的是「超出比例」。
          // 只认完整跑完的轮次：中途接管的预测锚点本身就不可信。
          if (state.turnFirstPredictedMs > 0 && (reason === 'completed' || reason === '')) {
            // 预测是「从做出预测那刻算还剩多少」；换算成「对整轮总时长的预测」
            // 需要 + 预测时刻到轮次开始之间已跑掉的部分。
            const predictedTotal = state.turnFirstPredictedMs
              + Math.max(0, state.turnFirstPredictedAt - state.turnStartedAt)
            if (total > predictedTotal) {
              const ratio = (total - predictedTotal) / predictedTotal
              if (ratio > 0) {
                state.overtimeHistory.push(ratio)
                cap(state.overtimeHistory, MAX_OVERTIME_SAMPLES)
              }
            }
          }
        }
      }
      state.adoptedMidTurn = false
      state.active = false
      state.turnStartedAt = 0
      state.turnEndedAt = now
      state.endReason = String((data.reason && data.reason.kind) || '')
      state.stepStarts = []
      state.pauseStartedAt = 0
      state.pauseKind = ''
      state.smoothedRemainMs = null
      state.smoothedAt = 0
      state.turnFirstPredictedMs = 0
      state.turnFirstPredictedAt = 0
      state.overtime = false
      state.overtimeSince = 0
      return state
    }

    default:
      return state
  }
}

/**
 * 从当前状态算出「还剩多久」。
 *
 * 五个互相独立的估计，谁有样本用谁，最后按样本强度加权：
 *   - `progress`：已用净工期 × 剩余条数 / 已完成条数（最直接）
 *   - `pace`：平均步时 × 预计剩余步数（清单里已有条目被勾掉时）
 *   - `unit`：单条平均耗时 × 剩余条数（跨轮先验，换会话也认）
 *   - `steps`：步数外推 —— 本轮步数 vs 历史「一轮通常几步」（**没有清单时的主力**）
 *   - `history`：整轮历史均值的兜底
 *
 * 为什么要有 `steps`：模型不一定写 todo 清单（实测整整一轮 178 步、
 * 一条 todo/write 都没有）。这时 progress/pace/unit 全部失效，只剩 history
 * 能兜底；而 history 又需要 ≥2 轮历史，插件重启后内存清零 ⇒ 永远「看不出节奏」。
 * 但 `step/start` 事件一直在来，平均步时也算得出来 —— 这些信号之前被白白丢掉了。
 *
 * @returns {{ms: number|null, source: string, samples: number}}
 */
function estimateRemain(state, now, tally) {
  const elapsed = effectiveElapsed(state, now)
  const avgStep = mean(state.stepDurations)
  const medStep = median(state.stepDurations)
  const avgUnit = mean(state.unitHistory)

  const doneUnits = tally.completed + tally.inProgress * 0.5
  const remainUnits = Math.max(0, tally.total - doneUnits)

  const parts = []

  // ① 进度外推：有完成、也还有剩，才有意义。
  if (tally.total > 0 && doneUnits > 0 && remainUnits > 0 && elapsed > 0) {
    parts.push({ ms: (elapsed * remainUnits) / doneUnits, weight: 0.5, source: 'progress' })
  }

  // ② 步长外推：需要「一条目几步」这个换算率。
  if (avgStep !== null && doneUnits > 0 && remainUnits > 0 && state.stepDurations.length >= 2) {
    const stepsPerUnit = state.stepDurations.length / doneUnits
    parts.push({ ms: avgStep * remainUnits * stepsPerUnit, weight: 0.3, source: 'pace' })
  }

  // ③ 单条耗时先验：本轮还没有可外推的进度时，用历史单条耗时顶上。
  if (avgUnit !== null && remainUnits > 0 && parts.length === 0) {
    parts.push({ ms: avgUnit * remainUnits, weight: 0.7, source: 'unit' })
  }

  // ④ 步数外推（没有清单时的主力）。
  //    只要本轮已经走出几个步长样本，就能拿「历史一轮通常几步」当分母：
  //    剩余步数 ≈ 通常步数 − 已走步数，剩余时长 ≈ 剩余步数 × 中位步时。
  //    没有跨轮步数历史时，退化成一个保守的「再走 N 步」假设（见 FALLBACK_STEPS_PER_TURN），
  //    这样插件刚装上、历史为空时也有东西可显示，而不是一片「样本不足」。
  if (parts.length === 0 && state.stepDurations.length >= 2 && medStep !== null && medStep > 0) {
    const typicalSteps = median(state.stepHistory) !== null
      ? median(state.stepHistory)
      : FALLBACK_STEPS_PER_TURN
    const walked = Math.max(1, state.stepCount)
    const stepsLeft = Math.max(0, typicalSteps - walked)
    // 已经走超过「通常步数」了：这一轮比历史更长，按「再走几步收尾」给个下限，
    // 而不是直接报 0（报 0 会显示「还有 1 秒」，明显是假的）。
    const ms = stepsLeft > 0
      ? stepsLeft * medStep
      : OVERSHOOT_STEPS * medStep
    parts.push({ ms, weight: 0.55, source: 'steps' })
  }

  // ⑤ 整轮历史兜底：连清单和步数样本都没有的时候，只能按「这一轮通常多久」猜。
  //    至少要有两轮历史才算「通常」—— 只有上一轮一条记录不构成规律，
  //    拿它当先验等于把上一轮的时长硬套到新一轮上（换轮那一刻尤其明显）。
  if (parts.length === 0 && tally.total === 0 && state.history.length >= 2) {
    const avgTurn = median(state.history)
    if (avgTurn !== null && avgTurn > 0) {
      // 一轮刚开始时别直接报整轮均值 —— 至少等它跑过一小段。
      const already = Math.min(elapsed, avgTurn)
      parts.push({ ms: Math.max(MIN_REMAIN_MS, avgTurn - already), weight: 0.35, source: 'history' })
    }
  }

  if (parts.length === 0) return { ms: null, source: 'none', samples: 0 }

  let weightSum = 0
  let weighted = 0
  for (const part of parts) {
    weightSum += part.weight
    weighted += part.ms * part.weight
  }
  // 样本量：步长样本 + 本轮勾掉的条目（一条算两个样本，它同时证明了节奏与进度）
  // + 跨轮历史（整轮时长、单条耗时、单轮步数各算一份）。
  const samples = state.stepDurations.length + tally.completed * 2
    + state.history.length + state.unitHistory.length + state.stepHistory.length
  return {
    ms: Math.max(MIN_REMAIN_MS, Math.min(MAX_REMAIN_MS, weighted / weightSum)),
    source: parts.map((p) => p.source).join('+'),
    samples,
  }
}

/** 样本强度 → 置信度标签。 */
function confidenceOf(samples, tally, source) {
  if (source === 'none') return 'none'
  // 步数外推只靠步长 + 跨轮步数，没有清单进度做交叉验证，最多「粗略」。
  // 能到「中等」的前提是同时有清单证据（见下面两行）。
  if (source === 'steps') {
    if (samples >= 10 && tally.completed >= 1) return 'medium'
    return samples >= 3 ? 'low' : 'none'
  }
  if (source === 'history') return samples >= 4 ? 'low' : 'none'
  if (samples >= 8 && tally.completed >= 3) return 'high'
  if (samples >= 4 || tally.completed >= 2) return 'medium'
  if (tally.completed >= 1 || samples >= 2) return 'low'
  return 'none'
}

/**
 * 生成给前端的一份快照。前端只渲染，不做任何推算。
 *
 * @param {object} state - {@link emptySession} 状态。
 * @param {number} now - 当前时刻（epoch ms）。
 * @returns {object} 可直接 JSON 化的快照。
 */
export function forecastSession(state, now) {
  const tally = tallyTodos(state.todos)
  const elapsed = effectiveElapsed(state, now)

  if (!state.active) {
    return {
      phase: state.turnEndedAt > 0 ? 'done' : 'idle',
      turn: state.turn,
      endReason: state.endReason,
      elapsedMs: state.lastTurnMs,
      remainMs: null,
      etaAt: null,
      confidence: 'none',
      source: 'none',
      progress: tally.total > 0 ? tally.completed / tally.total : null,
      // 已结束的轮次没有「进度」可言（它已经 100% 了），前端按 phase 处理。
      progressSource: tally.total > 0 ? 'todos' : 'none',
      total: tally.total,
      completed: tally.completed,
      inProgress: tally.inProgress,
      pending: tally.pending,
      currentTask: '',
      steps: 0,
      avgStepMs: null,
      paused: false,
      pausedMs: 0,
      overtime: false,
      overtimeMs: 0,
      updatedAt: now,
    }
  }

  const estimate = estimateRemain(state, now, tally)
  let remainMs = estimate.ms

  // 超时学习：这个会话过去超时过吗？按中位超出比例放大本轮预测。
  // 没有记录 → 1.0（不放大）。乘在**平滑之前**，否则平滑会稀释放大量。
  const overtimeMargin = (() => {
    const ratios = state.overtimeHistory || []
    if (ratios.length === 0) return 1
    const med = median(ratios)
    if (!(med > 0)) return 1
    return Math.min(OVERTIME_MARGIN_MAX, 1 + med)
  })()
  if (remainMs !== null && overtimeMargin > 1) remainMs *= overtimeMargin

  // EWMA 平滑：只在同一轮内、且已有样本时生效。换轮由 turn/start 清空。
  if (remainMs !== null) {
    if (state.smoothedRemainMs === null || state.smoothedAt <= 0) {
      state.smoothedRemainMs = remainMs
      state.smoothedAt = now
    } else {
      state.smoothedRemainMs = state.smoothedRemainMs + (remainMs - state.smoothedRemainMs) * SMOOTH_ALPHA
      state.smoothedAt = now
    }
    remainMs = Math.max(MIN_REMAIN_MS, Math.min(MAX_REMAIN_MS, state.smoothedRemainMs))
    state.lastPredictedMs = remainMs
    state.lastPredictedAt = now
    // 锚定本轮第一次预测（超时判定要用它）。
    if (!(state.turnFirstPredictedMs > 0)) {
      state.turnFirstPredictedMs = remainMs
      state.turnFirstPredictedAt = now
    }
  } else {
    state.smoothedRemainMs = null
  }

  /**
   * 超时检测：这一轮已经**跑过了它自己的预测终点**还在跑。
   *
   * 判据用「turn/start + 预测剩余」而不是简单的 etaAt —— etaAt 随每次预测更新，
   * 会被后续估计不断推后，永远追不上。锚定**轮次开始时**给出的那次预测
   * （见 turnFirstPredictedMs 的记录）才能稳定判断「这轮比当初说的久」。
   *
   * 只标记、不瞎报：超时后 remainMs 归 null，前端改显「已超时 N 分」；
   * 具体超了多久用 now - overtimeSince，连续可读。
   */
  let overtime = state.overtime
  let overtimeSince = state.overtimeSince
  if (!overtime && state.turnFirstPredictedMs > 0 && state.turnFirstPredictedAt > 0) {
    const predictedTotal = state.turnFirstPredictedMs + (state.turnFirstPredictedAt - state.turnStartedAt)
    if (elapsed > predictedTotal + OVERTIME_GRACE_MS) {
      overtime = true
      overtimeSince = state.turnStartedAt + predictedTotal
    }
  }

  const avgStep = mean(state.stepDurations)
  const progress = progressOf(state, tally)

  return {
    phase: 'running',
    turn: state.turn,
    endReason: '',
    elapsedMs: elapsed,
    // 超时了就别再演倒计时 —— null 让前端切到「已超时 N 分」的显示。
    remainMs: overtime ? null : remainMs,
    etaAt: overtime || remainMs === null ? null : now + remainMs,
    confidence: confidenceOf(estimate.samples, tally, estimate.source),
    source: estimate.source,
    overtime,
    overtimeMs: overtime && overtimeSince > 0 ? Math.max(0, now - overtimeSince) : 0,
    progress,
    progressSource: tally.total > 0 ? 'todos' : (progress === null ? 'none' : 'steps'),
    total: tally.total,
    completed: tally.completed,
    inProgress: tally.inProgress,
    pending: tally.pending,
    currentTask: tally.current,
    steps: state.stepCount,
    avgStepMs: avgStep,
    paused: state.pauseStartedAt > 0,
    pausedMs: state.pausedTotalMs + (state.pauseStartedAt > 0 ? Math.max(0, now - state.pauseStartedAt) : 0),
    updatedAt: now,
  }
}

/**
 * 这一轮完成了多少（0~1）；算不出来返回 null。
 *
 * 两个来源，清单优先：
 *   1. **todo 清单**：勾掉的条数 / 总条数。这是真正的进度，有就用。
 *   2. **步数代理**：没有清单时，用「已走步数 / 一轮通常几步」估。
 *      之前这里直接返回 null，于是没写清单的会话进度条永远是灰的 ——
 *      明明已经在用步数估 ETA 了，却不给进度条任何反馈，那根灰条就这么一直空着。
 *
 * 步数代理要**封顶在 0.95**：一轮到底走几步没人知道，报 100% 会让进度条
 * 满格卡在那里（看着像跑完了），留一点余地更诚实。
 * 刚开始（步数样本不足）也返回 null，而不是给一个 2% 的假精确值。
 */
export function progressOf(state, tally) {
  const list = tally || { total: 0, completed: 0, inProgress: 0 }
  if (list.total > 0) {
    return (list.completed + list.inProgress * 0.5) / list.total
  }
  // —— 以下是没有清单时的步数代理 ——
  const walked = state && state.stepCount > 0 ? state.stepCount : 0
  if (walked < 2) return null
  const typical = state.stepHistory && state.stepHistory.length > 0
    ? median(state.stepHistory)
    : FALLBACK_STEPS_PER_TURN
  if (!(typical > 0)) return null
  return Math.max(0.02, Math.min(0.95, walked / typical))
}

/** 这条会话值不值得显示（子代理 / 更深委派一律不看）。 */
export function isDisplayableSession(session) {
  try {
    const header = (session && session.header) || {}
    if (header.origin === 'subagent') return false
    const depth = Number(header.delegationDepth)
    if (Number.isFinite(depth) && depth > 0) return false
    return true
  } catch (err) {
    return true
  }
}

/** 从会话对象里尽量取一个可读名字。 */
export function sessionNameOf(session) {
  try {
    const header = (session && session.header) || {}
    const candidates = [
      header.title, session && session.title, session && session.name,
      session && session.label,
      session && session.summary && session.summary.title,
    ]
    for (const candidate of candidates) {
      const text = String(candidate == null ? '' : candidate).trim()
      if (text) return text.slice(0, 120)
    }
  } catch (err) {
    /* 名字取不到不影响估算 */
  }
  return ''
}

/** 会话 id：header.id 优先，回落顶层 id。 */
export function sessionIdOf(session) {
  try {
    const header = (session && session.header) || {}
    const id = header.id != null ? header.id : (session && session.id)
    if (id != null && String(id) !== '') return String(id)
  } catch (err) {
    /* 落到 unknown */
  }
  return 'unknown'
}
