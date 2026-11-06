/**
 * 纯函数与默认值：不 import 任何宿主包，可在宿主之外单测。
 *
 * 约定：
 * - 所有模块共享这里的 DEFAULTS，避免 schema 与运行期默认值漂移。
 * - 任何会写盘、发网络请求的逻辑都不放在这里。
 */

import { createHash } from 'node:crypto'

/** AstrBot 实例数据目录。换机器后请用 astrbotConfigPath / personaDbPath 覆盖。 */
export const ASTRBOT_DATA_DIR = '<ASTRBOT_DATA_DIR>'

export const DEFAULTS = {
  enabled: true,

  // AstrBot 连接
  astrbotBaseUrl: 'http://127.0.0.1:16752',
  astrbotConfigPath: `${ASTRBOT_DATA_DIR}/cmd_config.json`,
  jwtExpSeconds: 3600,
  httpTimeoutMs: 8000,

  // 端口自适应发现（Launcher 每次可能换端口，写死会失效）
  discoverEnabled: true,
  // 优先探这些；命中即停，不用扫全机
  discoverCandidates: [16752, 6185, 18387, 11451, 6186],
  discoverMaxPorts: 64,
  discoverTimeoutMs: 900,

  // 连续失败熔断：服务挂掉时别每轮都等超时
  circuitThreshold: 3,
  circuitCooldownMs: 60000,

  // Persona（唯一主源 = AstrBot）
  personaName: 'nicai',
  personaSource: 'sqlite',
  personaDbPath: `${ASTRBOT_DATA_DIR}/data_v4.db`,
  personaRefreshSeconds: 300,
  includeBeginDialogs: true,
  maxBeginDialogs: 6,
  personaSectionOrder: 0,
  // 语气：优先读共享文件（和 AstrBot 的 tone 插件同一份），读不到才用静态 toneSuffix
  toneSuffix: '',
  toneSuffixFile: '<DSH_DATA_DIR>/storages/tone.md',
  toneSuffixOrder: 10200,
  memoryBlockStyle: 'memory',

  // 召回
  recallEnabled: true,
  recallTopK: 20,
  recallInjectCount: 4,
  recallMinSimilarity: 0.55,
  recallMinImportance: 0.3,
  recallTimeoutMs: 8000,
  recallQueryTurns: 2,
  includeDefaultPersonaMemories: false,
  maxInjectChars: 4000,

  // 写入（默认 dry run；自动写回双触发，可关）
  writeEnabled: true,
  automaticWrite: true,
  autoWriteTurns: 20,
  autoWriteIdleMs: 3600000,
  autoWriteCheckMs: 300000,
  autoWriteMaxTurns: 40,
  writeTurns: 10,
  dryRunByDefault: true,
  writeTimeoutMs: 120000,

  // LivingMemory session_id（模板，不硬编码）
  sessionIdTemplate: 'dsh-rp:{persona}',
  storylineName: '',

  // 观测
  debug: false
}

/** 去掉多余空白，压成一行。 */
export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 按字符截断，带上省略号。 */
export function clip(value, max) {
  const text = String(value ?? '')
  if (!(max > 0) || text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** 稳定摘要，用于注入去重。 */
export function sha1(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex')
}

/**
 * 渲染 LivingMemory 的 session_id。
 *
 * 模板支持 {persona} 与 {storyline}；storyline 为空时把多余的冒号收掉，
 * 所以 `dsh-rp:{persona}:{storyline}` 在无剧情线时得到 `dsh-rp:nicai`。
 * @param {string} template 配置里的模板
 * @param {{persona?: string, storyline?: string}} parts 替换值
 * @returns {string} 渲染后的 session_id
 */
export function renderSessionId(template, parts) {
  const persona = String(parts?.persona ?? '').trim()
  const storyline = String(parts?.storyline ?? '').trim()
  // 没有人物名时用 default 占位，避免渲染出 `dsh-rp` 这种半截值
  const personaPart = persona.length > 0 ? persona : 'default'
  let out = String(template ?? '').trim()
  if (out.length === 0) out = 'dsh-rp:{persona}'
  out = out.replaceAll('{persona}', personaPart).replaceAll('{storyline}', storyline)
  // 无剧情线时清掉空的尾部/中部冒号
  out = out.replace(/[:：]\s*$/u, '').replace(/[:：]{2,}/gu, ':')
  return out.length > 0 ? out : `dsh-rp:${personaPart}`
}

/** 把 json 字符串/数组安全解析成字符串数组。 */
export function toStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value !== 'string' || value.trim().length === 0) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * 校验并归一化 AstrBot 的 begin_dialogs。
 *
 * AstrBot 侧要求条数为偶数（user/assistant 配对），奇数时整段丢弃，这里保持一致，
 * 避免同一个角色在两个窗口里「开场示范」不一致。
 * @param {unknown} raw 原始值（JSON 字符串或数组）
 * @returns {{ dialogs: string[], dropped: boolean }}
 */
export function normalizeBeginDialogs(raw) {
  const dialogs = toStringArray(raw).map(oneLine).filter(Boolean)
  if (dialogs.length === 0) return { dialogs: [], dropped: false }
  if (dialogs.length % 2 !== 0) return { dialogs: [], dropped: true }
  return { dialogs, dropped: false }
}

/**
 * 把端口列表规整成干净的整数数组：支持数组、逗号/空格分隔字符串。
 * @param {unknown} value
 * @returns {number[]}
 */
export function toPortList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/u) : []
  const ports = []
  const seen = new Set()
  for (const item of raw) {
    const port = Math.trunc(Number(item))
    if (!Number.isFinite(port) || port < 1 || port > 65535) continue
    if (seen.has(port)) continue
    seen.add(port)
    ports.push(port)
  }
  return ports
}

/**
 * 归一化配置：类型矫正、路径展开、派生 session_id。
 * @param {Record<string, unknown>} raw 插件配置
 * @returns {Record<string, unknown>} 运行期配置
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (key) => (input[key] === undefined ? DEFAULTS[key] : input[key])
  const num = (key, min, max) => {
    const value = Number(pick(key))
    const safe = Number.isFinite(value) ? value : DEFAULTS[key]
    return Math.min(max, Math.max(min, safe))
  }
  const str = (key) => {
    const value = pick(key)
    return typeof value === 'string' ? value.trim() : DEFAULTS[key]
  }
  const bool = (key) => {
    const value = pick(key)
    return value === undefined ? DEFAULTS[key] : Boolean(value)
  }

  const personaName = str('personaName') || DEFAULTS.personaName
  const storylineName = str('storylineName')

  const resolved = {
    enabled: bool('enabled'),
    astrbotBaseUrl: (str('astrbotBaseUrl') || DEFAULTS.astrbotBaseUrl).replace(/\/+$/u, ''),
    astrbotConfigPath: str('astrbotConfigPath') || DEFAULTS.astrbotConfigPath,
    jwtExpSeconds: Math.trunc(num('jwtExpSeconds', 60, 86400)),
    httpTimeoutMs: Math.trunc(num('httpTimeoutMs', 500, 120000)),

    discoverEnabled: bool('discoverEnabled'),
    discoverCandidates: (() => {
      const list = toPortList(pick('discoverCandidates'))
      return list.length > 0 ? list : DEFAULTS.discoverCandidates
    })(),
    discoverMaxPorts: Math.trunc(num('discoverMaxPorts', 1, 512)),
    discoverTimeoutMs: Math.trunc(num('discoverTimeoutMs', 100, 10000)),

    circuitThreshold: Math.trunc(num('circuitThreshold', 1, 20)),
    circuitCooldownMs: Math.trunc(num('circuitCooldownMs', 0, 3600000)),

    personaName,
    personaSource: str('personaSource') === 'http' ? 'http' : 'sqlite',
    personaDbPath: str('personaDbPath') || DEFAULTS.personaDbPath,
    personaRefreshSeconds: Math.trunc(num('personaRefreshSeconds', 0, 86400)),
    includeBeginDialogs: bool('includeBeginDialogs'),
    maxBeginDialogs: Math.trunc(num('maxBeginDialogs', 0, 24)),
    personaSectionOrder: Math.trunc(num('personaSectionOrder', -100000, 100000)),
    toneSuffix: typeof input.toneSuffix === 'string' ? input.toneSuffix.trim() : DEFAULTS.toneSuffix,
    toneSuffixFile: str('toneSuffixFile'),
    toneSuffixOrder: Math.trunc(num('toneSuffixOrder', 0, 100000)),
    memoryBlockStyle: str('memoryBlockStyle') === 'recall' ? 'recall' : 'memory',

    recallEnabled: bool('recallEnabled'),
    recallTopK: Math.trunc(num('recallTopK', 1, 50)),
    recallInjectCount: Math.trunc(num('recallInjectCount', 1, 8)),
    recallMinSimilarity: num('recallMinSimilarity', 0, 1),
    recallMinImportance: num('recallMinImportance', 0, 1),
    recallTimeoutMs: Math.trunc(num('recallTimeoutMs', 500, 60000)),
    recallQueryTurns: Math.trunc(num('recallQueryTurns', 1, 6)),
    includeDefaultPersonaMemories: bool('includeDefaultPersonaMemories'),
    maxInjectChars: Math.trunc(num('maxInjectChars', 200, 20000)),

    writeEnabled: bool('writeEnabled'),
    // 自动写回开关：默认开；关掉后只剩模型手动调用的那条路。
    automaticWrite: bool('automaticWrite'),
    autoWriteTurns: Math.trunc(num('autoWriteTurns', 2, 200)),
    autoWriteIdleMs: Math.trunc(num('autoWriteIdleMs', 60000, 86400000)),
    autoWriteCheckMs: Math.trunc(num('autoWriteCheckMs', 10000, 3600000)),
    autoWriteMaxTurns: Math.trunc(num('autoWriteMaxTurns', 2, 200)),
    writeTurns: Math.trunc(num('writeTurns', 2, 40)),
    dryRunByDefault: bool('dryRunByDefault'),
    writeTimeoutMs: Math.trunc(num('writeTimeoutMs', 5000, 600000)),

    sessionIdTemplate: str('sessionIdTemplate') || DEFAULTS.sessionIdTemplate,
    storylineName,

    debug: bool('debug')
  }

  resolved.sessionId = renderSessionId(resolved.sessionIdTemplate, {
    persona: personaName,
    storyline: storylineName
  })
  return resolved
}
