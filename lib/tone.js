/**
 * 共享语气规则读取器。
 *
 * 唯一数据源：一份 markdown 文件，AstrBot 的 tone 插件和本桥插件读的是同一个路径。
 * 这样两个窗口的语气不会跑偏，改一处两边同步。
 *
 * 按 mtime 缓存，改完下一轮就生效；读不到就退回配置里的静态 toneSuffix。
 */

import { statSync, readFileSync } from 'node:fs'

/**
 * @param {{filePath: string, logger?: object, warnOnce?: boolean}} options
 */
export function createToneReader({ filePath, logger, warnOnce = true }) {
  let cacheText = ''
  let cacheMtime = -1
  let warned = false

  /**
   * 读语气规则。文件不存在或读失败时返回空串，绝不抛给调用方。
   * @returns {string}
   */
  function read() {
    const path = String(filePath ?? '').trim()
    if (path.length === 0) return ''
    let stat
    try {
      stat = statSync(path)
    } catch {
      if (warnOnce && !warned) {
        logger?.warn?.('dsh-lm-bridge: 语气文件不存在，退回配置值：%s', path)
        warned = true
      }
      return ''
    }
    if (stat.mtimeMs === cacheMtime) return cacheText
    try {
      const text = readFileSync(path, 'utf8').trim()
      cacheText = text
      cacheMtime = stat.mtimeMs
      warned = false
      logger?.info?.('dsh-lm-bridge: 语气规则已加载（%d 字）', text.length)
      return text
    } catch (error) {
      logger?.warn?.('dsh-lm-bridge: 读语气文件失败：%s', error?.message ?? error)
      return cacheText
    }
  }

  return {
    read,
    get filePath() {
      return filePath
    },
    /** 清缓存，强制下次重读。 */
    invalidate() {
      cacheMtime = -1
    }
  }
}
