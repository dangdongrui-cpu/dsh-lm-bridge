/**
 * AutoWriter —— 自动把 DSH 会话轮次提交给 LivingMemory。
 *
 * 双触发（用户要的两条同时满足才叫"不漏"）：
 *   1. 阈值：自上次提交以来累计达到 `autoWriteTurns` 轮 → 立刻提交；
 *   2. 空闲：不满阈值，但最后一条消息已经安静超过 `autoWriteIdleMs` → 也提交。
 *
 * 第二条必须靠定时器巡检，因为"沉默"本身不会产生事件。所以这里带一个
 * 轻量 interval，由调用方在插件卸载时 stop()。
 *
 * 状态全在内存：
 * - `submittedCount` 用 ring 的累计条数做游标（只增不减，环形缓冲丢旧条目也不影响）；
 * - 进程重启后 ring 清空、游标归零，因此不会重复提交已写过的内容。
 *
 * 去重靠两层：本地游标（不重复提交同一段）；LivingMemory 自己的查重（跨会话兜底）。
 */

/**
 * @param {{
 *   write: { submit: Function },
 *   rings: { totalCount: Function, recentTurns: Function, sessionIds: Function },
 *   config: Record<string, any>,
 *   logger?: object,
 *   now?: () => number,
 *   setIntervalFn?: Function,
 *   clearIntervalFn?: Function
 * }} options
 */
export function createAutoWriter({ write, rings, config, logger, now = () => Date.now(), setIntervalFn, clearIntervalFn }) {
  /** sessionId → { submittedCount, lastActivityAt, inflight, lastResult } */
  const states = new Map()
  let timer = null

  function stateOf(sessionId) {
    let state = states.get(sessionId)
    if (state === undefined) {
      // lastActivityAt 用 null 作哨兵：0 是合法时钟值，不能拿来表示「还没活动」
      state = { submittedCount: 0, lastActivityAt: null, inflight: false, lastResult: null }
      states.set(sessionId, state)
    }
    return state
  }

  /** 该会话还有多少条没提交。 */
  function pending(sessionId) {
    const state = stateOf(sessionId)
    return Math.max(0, rings.totalCount(sessionId) - state.submittedCount)
  }

  /** 有新消息时调用：只更新活跃时间，不提交。 */
  function note(sessionId) {
    if (!config.automaticWrite) return
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    stateOf(sessionId).lastActivityAt = now()
  }

  /**
   * 真正提交一段轮次。
   * @param {string} sessionId
   * @param {number} count 提交多少条
   * @param {string} reason 'threshold' | 'idle' | 'manual'
   */
  async function submit(sessionId, count, reason) {
    const state = stateOf(sessionId)
    if (state.inflight) return { ok: false, code: 'inflight' }
    const take = Math.min(Math.max(2, Math.trunc(count)), Math.max(2, Math.trunc(config.autoWriteMaxTurns)))
    const turns = rings.recentTurns(sessionId, take)
    if (turns.length < 2) {
      return { ok: false, code: 'too-few-messages' }
    }

    state.inflight = true
    try {
      // 自动路径内部直接满足双闸门；模型侧的手动工具仍然要显式传 confirm。
      const result = await write.submit({ turns, dryRun: false, confirm: true, timeoutMs: config.writeTimeoutMs })
      state.lastResult = { at: now(), ok: result.ok, code: result.code ?? null, reason }
      if (result.ok) {
        state.submittedCount = rings.totalCount(sessionId)
        logger?.info?.(
          'dsh-lm-bridge: 自动写回成功（%s，%d 条，%s）',
          sessionId,
          turns.length,
          reason
        )
      } else {
        logger?.warn?.(
          'dsh-lm-bridge: 自动写回失败（%s，%s：%s）',
          sessionId,
          result.code ?? 'error',
          result.message ?? ''
        )
      }
      return result
    } catch (error) {
      state.lastResult = { at: now(), ok: false, code: 'exception', reason }
      logger?.warn?.('dsh-lm-bridge: 自动写回异常：%s', error?.message ?? error)
      return { ok: false, code: 'exception', message: String(error?.message ?? error) }
    } finally {
      state.inflight = false
    }
  }

  /** 阈值检查：满了就提交。每轮结束时调用。 */
  async function checkThreshold(sessionId) {
    if (!config.automaticWrite) return { ok: false, code: 'disabled' }
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, code: 'no-session' }
    const count = pending(sessionId)
    if (count < config.autoWriteTurns) return { ok: false, code: 'below-threshold', pending: count }
    return submit(sessionId, count, 'threshold')
  }

  /**
   * 空闲巡检：不满阈值、但安静够久了，也提交。
   * @returns {Promise<Array<object>>} 本轮巡检的提交结果
   */
  async function checkIdle() {
    if (!config.automaticWrite) return []
    const nowMs = now()
    const results = []
    for (const sessionId of rings.sessionIds()) {
      const state = stateOf(sessionId)
      const count = pending(sessionId)
      if (count < 2) continue
      if (state.inflight) continue
      if (state.lastActivityAt === null) continue
      if (nowMs - state.lastActivityAt < config.autoWriteIdleMs) continue
      results.push(await submit(sessionId, count, 'idle'))
    }
    return results
  }

  /** 启动定时巡检（沉默触发只能靠它）。 */
  function start() {
    if (!config.automaticWrite) return
    if (timer !== null) return
    if (!(config.autoWriteCheckMs > 0)) return
    const interval = setIntervalFn ?? setInterval
    timer = interval(() => {
      void checkIdle().catch((error) => {
        logger?.warn?.('dsh-lm-bridge: 空闲巡检失败：%s', error?.message ?? error)
      })
    }, config.autoWriteCheckMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  function stop() {
    if (timer === null) return
    const clear = clearIntervalFn ?? clearInterval
    clear(timer)
    timer = null
  }

  return {
    note,
    checkThreshold,
    checkIdle,
    start,
    stop,
    pending,
    /** 手动工具写完之后同步游标，别让自动路径重复提交同一段。 */
    markSubmitted(sessionId) {
      stateOf(sessionId).submittedCount = rings.totalCount(sessionId)
    },
    /** 只读快照，给设置页和日志用。 */
    snapshot() {
      const out = {}
      for (const [sessionId, state] of states) {
        out[sessionId] = {
          pending: pending(sessionId),
          submittedCount: state.submittedCount,
          lastActivityAt: state.lastActivityAt,
          inflight: state.inflight,
          lastResult: state.lastResult
        }
      }
      return out
    },
    get running() {
      return timer !== null
    }
  }
}
