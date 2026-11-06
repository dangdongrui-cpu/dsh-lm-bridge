/**
 * ContextInjector —— 唯一接触 DSH 提示词注入逻辑的模块（纯函数 + 轻量状态）。
 *
 * 两条通道：
 * 1. 人格正文走 `systemPrompt.section`（稳定、可缓存、位于系统提示）；
 * 2. 每轮召回的记忆块走 `agent/pre-step` 插入一条带 `source.digest` 的 user 消息，
 *    内容不变时不重复插入（去重键 = sha1(全文)）。
 *
 * 若 0.2.0-rc.2 的 `section()` 不接受函数 text 而注册失败，调用方会把人格
 * 前置进记忆块（见 composeInjectedText 的 personaFallback 参数）。
 */

import { clip, sha1 } from './pure.js'

/** 注入消息的生产者标识，用于自识别与去重。 */
export const PLUGIN_SOURCE = 'dsh-lm-bridge'

/**
 * 会话格式 v4 的「生产者自有来源标记」。
 *
 * v4 准入（dsh-session-format-v3-to-v4）明确拒绝 v3 的
 * `{ kind: 'plugin', plugin: '名字' }` 包装，只接受非空且不等于字面量
 * `plugin` 的直接 kind；约定形状是 `plugin:<生产者>`。
 * 用错会得到 `format v4 message requires a producer-owned source kind`，
 * 而且是在**写会话那一刻**失败，整轮直接中断。
 */
export const PRODUCER_KIND = `plugin:${PLUGIN_SOURCE}`

/** 角色消息里取纯文本（DSH 的 content 是 block 数组）。 */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 从会话事件里取文本。
 *
 * DSH 两种消息事件的 data 形状不对称（这是实现坑，不是猜测）：
 * - `user/message`: data 就是消息记录 {content, source, …}
 * - `assistant/message`: data 是 {message: {content, …}, turn, step}
 * @param {string} eventType
 * @param {any} data
 * @returns {string}
 */
export function extractEventText(eventType, data) {
  if (eventType === 'assistant/message') return blocksToText(data?.message?.content)
  return blocksToText(data?.content)
}

/** 是否是插件注入的消息（v4 里是 `plugin:<生产者>`）——这类不能回流进记忆 ring。 */
export function isPluginInjected(data) {
  const kind = data?.source?.kind
  return typeof kind === 'string' && kind.startsWith('plugin:')
}

/**
 * 组装本轮注入文本。
 * @param {{memoryBlock?: string, personaText?: string, personaFallback?: boolean}} args
 * @returns {string}
 */
export function composeInjectedText({ memoryBlock = '', personaText = '', personaFallback = false } = {}) {
  const memory = String(memoryBlock ?? '').trim()
  const persona = String(personaText ?? '').trim()
  if (!personaFallback || persona.length === 0) return memory
  if (memory.length === 0) return persona
  return `${persona}\n\n${memory}`
}

/**
 * 注入去重：记住每个会话最后一次注入的 digest。
 */
export function createDigestTracker() {
  const last = new Map()
  return {
    /** 文本没变则返回 false（不需要再注入）。 */
    shouldInject(sessionId, text) {
      const digest = sha1(text)
      if (last.get(sessionId) === digest) return { inject: false, digest }
      return { inject: true, digest }
    },
    mark(sessionId, digest) {
      last.set(sessionId, digest)
    },
    forget(sessionId) {
      last.delete(sessionId)
    },
    clear() {
      last.clear()
    },
    get size() {
      return last.size
    }
  }
}

/**
 * 每会话的轮次环形缓冲：只活在内存里，用于拼召回 query 与组装写回消息。
 * 不落盘、不跨进程，插件卸载即消失。
 * @param {{maxTurns?: number}} [options]
 */
export function createTurnRings({ maxTurns = 20 } = {}) {
  const rings = new Map()
  const totals = new Map()
  const limit = Math.max(2, Math.trunc(maxTurns))

  function ringOf(sessionId) {
    let ring = rings.get(sessionId)
    if (ring === undefined) {
      ring = []
      rings.set(sessionId, ring)
    }
    return ring
  }

  return {
    push(sessionId, turn) {
      const text = clip(String(turn?.text ?? '').trim(), 2000)
      if (text.length === 0) return
      const ring = ringOf(sessionId)
      ring.push({ ...turn, text })
      while (ring.length > limit) ring.shift()
      // 只增不减的累计条数：环形缓冲会丢旧条目，但游标不能倒退
      totals.set(sessionId, (totals.get(sessionId) ?? 0) + 1)
    },
    /** 该会话累计写入过多少条（只增不减，用作自动提交的游标）。 */
    totalCount(sessionId) {
      return totals.get(sessionId) ?? 0
    },
    /** 最近 n 条用户发言（新→旧取尾，按时间正序返回）。 */
    recentUserTexts(sessionId, n = 2) {
      const ring = rings.get(sessionId) ?? []
      return ring
        .filter((turn) => turn.role === 'user')
        .slice(-Math.max(1, Math.trunc(n)))
        .map((turn) => turn.text)
    },
    /** 最近 n 条（user/assistant 混合，时间正序），用于写回。 */
    recentTurns(sessionId, n = 10) {
      const ring = rings.get(sessionId) ?? []
      return ring.slice(-Math.max(2, Math.trunc(n)))
    },
    forget(sessionId) {
      rings.delete(sessionId)
      totals.delete(sessionId)
    },
    clear() {
      rings.clear()
      totals.clear()
    },
    get sessionCount() {
      return rings.size
    },
    /** 当前有轮次缓冲的会话 id 列表（自动提交巡检用）。 */
    sessionIds() {
      return [...rings.keys()]
    }
  }
}
