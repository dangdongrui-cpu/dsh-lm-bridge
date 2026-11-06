/**
 * PersonaAdapter —— 从 AstrBot 的 `data_v4.db` 只读读取当前人格。
 *
 * 设计要点：
 * - DSH 不保存独立 Persona 副本，只缓存「最近一次读到的正文」，纯内存、进程内；
 * - 只用 `node:sqlite` 的 readOnly 连接，并立刻 `PRAGMA query_only`，从驱动层拒绝写入；
 * - 读失败不抛给调用方，返回上一次缓存（如果有），让人格注入退化成「稍微旧一点」；
 * - `begin_dialogs` 默认不注入（可能含露骨示范），需要时用配置打开。
 */

import { existsSync } from 'node:fs'
import { clip, normalizeBeginDialogs, oneLine } from './pure.js'

/** 只读打开 SQLite；失败时退回普通打开 + query_only。 */
async function openReadOnly(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`persona 数据库不存在：${dbPath}`)
  const sqlite = await import('node:sqlite')
  const DatabaseSync = sqlite.DatabaseSync
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    db = new DatabaseSync(dbPath)
  }
  try {
    db.exec('PRAGMA query_only = 1')
  } catch {
    // 老驱动没有该 pragma 时忽略：我们仍然只执行 SELECT
  }
  return db
}

/**
 * 从 personas 表里按名字取一行。
 * @param {string} dbPath
 * @param {string} personaName
 * @returns {Promise<{personaId: string, systemPrompt: string, beginDialogs: string[], droppedDialogs: boolean, updatedAt: string|null}>}
 */
export async function readPersonaFromDb(dbPath, personaName) {
  const db = await openReadOnly(dbPath)
  try {
    const row = db
      .prepare(
        'SELECT persona_id, system_prompt, begin_dialogs, updated_at FROM personas WHERE persona_id = ?'
      )
      .get(personaName)
    if (row === undefined || row === null) {
      const names = db
        .prepare('SELECT persona_id FROM personas ORDER BY persona_id')
        .all()
        .map((item) => item.persona_id)
      throw new Error(`personas 表里没有「${personaName}」；现有：${names.join(' / ') || '（空）'}`)
    }
    const { dialogs, dropped } = normalizeBeginDialogs(row.begin_dialogs)
    return {
      personaId: String(row.persona_id),
      systemPrompt: String(row.system_prompt ?? '').trim(),
      beginDialogs: dialogs,
      droppedDialogs: dropped,
      updatedAt: row.updated_at ? String(row.updated_at) : null
    }
  } finally {
    try {
      db.close()
    } catch {
      // 关闭失败不影响结果
    }
  }
}

/**
 * 把人设渲染成一段可注入的系统提示文本（纯函数，便于单测）。
 * @param {{personaId: string, systemPrompt: string, beginDialogs?: string[]}} persona
 * @param {{includeBeginDialogs?: boolean, maxBeginDialogs?: number}} [options]
 * @returns {string}
 */
export function renderPersonaSection(persona, options = {}) {
  const body = String(persona?.systemPrompt ?? '').trim()
  if (body.length === 0) return ''
  const lines = [body]
  if (options.includeBeginDialogs) {
    const limit = Math.max(0, Math.trunc(options.maxBeginDialogs ?? 6))
    const samples = (persona.beginDialogs ?? []).slice(0, limit).map((item) => oneLine(item))
    if (samples.length > 0) {
      lines.push('')
      lines.push('【语气示范】（同一角色的说话方式，仅作风格参考）')
      for (const sample of samples) lines.push(`- ${clip(sample, 160)}`)
    }
  }
  return lines.join('\n')
}

/**
 * 创建人格适配器。
 * @param {{
 *   dbPath: string,
 *   personaName: string,
 *   refreshSeconds: number,
 *   includeBeginDialogs: boolean,
 *   maxBeginDialogs: number,
 *   logger?: { warn?: Function, info?: Function }
 * }} options
 */
export function createPersonaAdapter({ dbPath, personaName, refreshSeconds, includeBeginDialogs, maxBeginDialogs, logger }) {
  let cached = null
  let cachedAt = 0
  let lastError = null

  return {
    /** 当前缓存（供 systemPrompt.section 同步读取）。 */
    get text() {
      return cached === null ? '' : renderPersonaSection(cached, { includeBeginDialogs, maxBeginDialogs })
    },

    /** 最近一次读取的元信息，用于日志与诊断。 */
    get info() {
      if (cached === null) return null
      return {
        personaId: cached.personaId,
        chars: cached.systemPrompt.length,
        beginDialogs: cached.beginDialogs.length,
        droppedDialogs: cached.droppedDialogs,
        updatedAt: cached.updatedAt,
        cachedAt
      }
    },

    get lastError() {
      return lastError
    },

    /**
     * 按 TTL 刷新人格；强制刷新用 force=true。
     * @param {boolean} [force]
     * @returns {Promise<string>} 当前可用的注入文本（失败时可能为空或旧值）
     */
    async refresh(force = false) {
      const ttlMs = Math.max(0, refreshSeconds) * 1000
      const fresh = cached !== null && (ttlMs === 0 ? true : Date.now() - cachedAt < ttlMs)
      if (!force && fresh) return this.text
      try {
        cached = await readPersonaFromDb(dbPath, personaName)
        cachedAt = Date.now()
        lastError = null
        logger?.info?.(
          'dsh-lm-bridge: persona loaded: %s (%d chars, %d begin dialogs%s)',
          cached.personaId,
          cached.systemPrompt.length,
          cached.beginDialogs.length,
          cached.droppedDialogs ? ', dialogs dropped: odd count' : ''
        )
      } catch (error) {
        lastError = String(error?.message ?? error)
        logger?.warn?.('dsh-lm-bridge: persona read failed (%s); using %s', lastError, cached === null ? 'empty' : 'cached')
      }
      return this.text
    }
  }
}
