/**
 * 连续失败熔断器 —— 纯内存、无持久化、无 IO。
 *
 * 作用：AstrBot 挂掉或端口漂走时，不要每一轮都苦等 8 秒超时。
 * 连续失败到阈值后开门，冷却期内直接短路返回；冷却后放行一次探测，
 * 成功即关门，失败则重新计时。
 *
 * 这条逻辑刻意做成纯状态机，`now` 可注入，方便单测覆盖时间推进。
 */

/**
 * @param {{threshold?: number, cooldownMs?: number, now?: () => number}} [options]
 */
export function createCircuitBreaker({ threshold = 3, cooldownMs = 60000, now = () => Date.now() } = {}) {
  const limit = Math.max(1, Math.trunc(threshold))
  const cooldown = Math.max(0, Math.trunc(cooldownMs))
  let failures = 0
  let openedAt = 0

  const isOpen = () => failures >= limit && now() - openedAt < cooldown

  return {
    /** 现在允许尝试吗。冷却到期后放行一次，用来探测服务是否回来。 */
    allow() {
      return !isOpen()
    },

    /** 一次成功：立刻关门。 */
    recordSuccess() {
      failures = 0
      openedAt = 0
    },

    /** 一次失败：累计；到阈值或冷却后再次失败都重新计冷却起点。 */
    recordFailure() {
      failures += 1
      if (failures >= limit) openedAt = now()
    },

    /** 只读快照，给报告和日志用。 */
    get state() {
      const open = isOpen()
      return {
        open,
        failures,
        limit,
        cooldownMs: cooldown,
        remainingMs: open ? Math.max(0, cooldown - (now() - openedAt)) : 0
      }
    },

    reset() {
      failures = 0
      openedAt = 0
    }
  }
}
