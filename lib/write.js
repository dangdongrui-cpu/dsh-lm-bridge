/**
 * LivingMemoryWriteAdapter —— 把一段 RP 提交给 LivingMemory。
 *
 * 关键约束（第一版）：
 * - 只走 `messages` 形态，让 LivingMemory 自己调 `process_conversation()` 做
 *   总结 + 重要性判断，DSH 不重复实现筛选算法；
 * - 默认 `dryRun=true`，只拿报告；`dryRun=false` 必须额外带 `confirm=true`，
 *   且**不会**因为前一次 dry run 成功而自动继续；
 * - 不带 `importance`：messages 模式下该值会被 LLM 判断结果覆盖，传了也只是噪声。
 */

import { oneLine } from './pure.js'

/** 平台标记，便于以后在 AstrBot 侧按来源过滤/清理。 */
export const BRIDGE_PLATFORM = 'dsh'

/**
 * 把内存里的轮次转成 LivingMemory 要求的 source_messages。
 *
 * `Message.from_dict` 强制要求 session_id / role / content / sender_id 四个键存在。
 * @param {Array<{role: string, text: string, ts?: number, senderId?: string, senderName?: string}>} turns
 * @param {{sessionId: string, limit?: number}} options
 * @returns {Array<Record<string, unknown>>}
 */
export function buildSourceMessages(turns, options) {
  const sessionId = String(options?.sessionId ?? '')
  const limit = Math.max(2, Math.trunc(options?.limit ?? 10))
  const picked = (Array.isArray(turns) ? turns : []).slice(-limit)
  const messages = []
  for (const turn of picked) {
    const content = oneLine(turn?.text)
    if (content.length === 0) continue
    const isBot = turn?.role === 'assistant'
    messages.push({
      session_id: sessionId,
      role: isBot ? 'assistant' : 'user',
      content,
      sender_id: String(turn?.senderId ?? (isBot ? 'dsh-assistant' : 'dsh-user')),
      sender_name: turn?.senderName ?? (isBot ? '助手' : '用户'),
      group_id: null,
      platform: BRIDGE_PLATFORM,
      timestamp: Number.isFinite(turn?.ts) ? Math.trunc(turn.ts / 1000) : Math.trunc(Date.now() / 1000),
      metadata: { is_bot_message: isBot }
    })
  }
  return messages
}

/**
 * 组装 import 接口要求的 `content` 字符串（接口要的是 JSON 的字符串形式）。
 * @param {{messages: Array<object>, personaName: string, sessionId: string, storyId?: string}} args
 * @returns {string}
 */
export function buildImportContent({ messages, personaName, sessionId, storyId }) {
  const metadata = { source: 'dsh-lm-bridge' }
  if (typeof storyId === 'string' && storyId.length > 0) metadata.story_id = storyId
  const payload = {
    format: 'livingmemory',
    schema_version: 1,
    memories: [
      {
        messages,
        persona_id: personaName,
        session_id: sessionId,
        metadata
      }
    ]
  }
  return JSON.stringify(payload)
}

/**
 * 把 dry_run / 正式导入的返回渲染成人类可读报告。
 * @param {object} data 接口的 data 字段
 * @param {boolean} dryRun
 * @returns {string}
 */
export function formatImportReport(data, dryRun) {
  if (data === null || typeof data !== 'object') return '（AstrBot 未返回数据）'
  const lines = []
  if (dryRun) {
    lines.push('【dry run · 未落库】')
    lines.push(`解析条目：${data.total ?? 0}（有效 ${data.valid_count ?? 0}，无效 ${data.invalid_count ?? 0}）`)
    lines.push(`其中需要 LLM 总结：${data.summary_required_count ?? 0}`)
    lines.push(`查重命中：${data.duplicate_count ?? 0}，按当前策略计划写入：${data.planned_import_count ?? 0}`)
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      lines.push(`解析错误：${data.errors.slice(0, 5).map((item) => JSON.stringify(item)).join('; ')}`)
    }
    lines.push('要真正写入，需要再显式调用一次并同时传 dryRun:false 与 confirm:true。')
    return lines.join('\n')
  }
  lines.push('【已写入 LivingMemory】')
  lines.push(`成功：${data.imported_count ?? 0}，重复跳过：${data.skipped_duplicate_count ?? 0}，失败：${data.failed_count ?? 0}`)
  if (Array.isArray(data.imported_ids) && data.imported_ids.length > 0) {
    lines.push(`新记忆 id：${data.imported_ids.join(', ')}`)
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    lines.push(`错误：${data.errors.slice(0, 5).map((item) => JSON.stringify(item)).join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * 创建写回适配器。
 * @param {{client: object, config: Record<string, any>, sessionId: string, logger?: object}} options
 */
export function createWriteAdapter({ client, config, sessionId, logger }) {
  let lastReport = null

  return {
    get lastReport() {
      return lastReport
    },

    /**
     * 提交最近若干轮。
     * @param {{turns: Array<object>, dryRun?: boolean, confirm?: boolean, timeoutMs?: number}} args
     * @returns {Promise<{ok: boolean, dryRun: boolean, report?: string, code?: string, message: string, count?: number}>}
     */
    async submit({ turns, dryRun, confirm, timeoutMs }) {
      if (!config.writeEnabled) {
        return { ok: false, dryRun: true, code: 'disabled', message: '写回已关闭（writeEnabled=false）' }
      }

      // 双重闸门：任何非 false 的 dryRun 都按 dry run 处理；
      // 只有 dryRun === false 且 confirm === true 才真正写入。
      const wantWrite = dryRun === false
      if (wantWrite && confirm !== true) {
        return {
          ok: false,
          dryRun: true,
          code: 'confirm-required',
          message: '已拒绝：dryRun=false 需要同时传 confirm=true。本轮没有写入任何内容。'
        }
      }
      const effectiveDryRun = !wantWrite

      const messages = buildSourceMessages(turns, { sessionId, limit: config.writeTurns })
      if (messages.length < 2) {
        return {
          ok: false,
          dryRun: effectiveDryRun,
          code: 'too-few-messages',
          message: `可提交的消息不足（${messages.length} 条），至少需要 2 条。`
        }
      }

      const content = buildImportContent({
        messages,
        personaName: config.personaName,
        sessionId,
        storyId: config.storylineName
      })

      const response = await client.importMemories({
        content,
        dryRun: effectiveDryRun,
        timeoutMs: timeoutMs ?? config.writeTimeoutMs
      })
      const report = response.ok ? formatImportReport(response.data, effectiveDryRun) : ''
      lastReport = report || null

      if (!response.ok) {
        logger?.warn?.('dsh-lm-bridge: import failed (%s: %s)', response.code, response.message)
        return {
          ok: false,
          dryRun: effectiveDryRun,
          code: response.code,
          message: `提交失败：${response.code} · ${response.message}`,
          count: messages.length
        }
      }

      logger?.info?.(
        'dsh-lm-bridge: import %s ok, %d messages, %dms',
        effectiveDryRun ? 'dry-run' : 'WRITE',
        messages.length,
        response.ms
      )
      return {
        ok: true,
        dryRun: effectiveDryRun,
        report,
        message: effectiveDryRun ? '已完成 dry run（未写入）。' : '已写入 LivingMemory。',
        count: messages.length
      }
    }
  }
}
