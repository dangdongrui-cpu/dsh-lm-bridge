/**
 * 插件配置 schema（Schemastery）与推荐默认值。
 *
 * 注意：schema 只负责「让宿主生成设置表单并校验类型」；真正的归一化
 * （路径展开、session_id 渲染、边界钳制）在 pure.js 的 resolveConfig 里，
 * 因此单测不需要宿主包。
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from './pure.js'

export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),

  // —— AstrBot 连接 ——
  astrbotBaseUrl: z.string().default(DEFAULTS.astrbotBaseUrl),
  astrbotConfigPath: z.string().default(DEFAULTS.astrbotConfigPath),
  jwtExpSeconds: z.number().step(1).min(60).max(86400).default(DEFAULTS.jwtExpSeconds),
  httpTimeoutMs: z.number().step(1).min(500).max(120000).default(DEFAULTS.httpTimeoutMs),

  // —— 端口自适应发现（Launcher 换端口时自动找回） ——
  discoverEnabled: z.boolean().default(DEFAULTS.discoverEnabled),
  discoverCandidates: z.array(z.number()).default(DEFAULTS.discoverCandidates),
  discoverMaxPorts: z.number().step(1).min(1).max(512).default(DEFAULTS.discoverMaxPorts),
  discoverTimeoutMs: z.number().step(1).min(100).max(10000).default(DEFAULTS.discoverTimeoutMs),

  // —— 失败熔断（服务挂掉时不要每轮等超时） ——
  circuitThreshold: z.number().step(1).min(1).max(20).default(DEFAULTS.circuitThreshold),
  circuitCooldownMs: z.number().step(1000).min(0).max(3600000).default(DEFAULTS.circuitCooldownMs),

  // —— Persona（唯一主源） ——
  personaName: z.string().default(DEFAULTS.personaName),
  personaSource: z.string().default(DEFAULTS.personaSource),
  personaDbPath: z.string().default(DEFAULTS.personaDbPath),
  personaRefreshSeconds: z.number().step(1).min(0).max(86400).default(DEFAULTS.personaRefreshSeconds),
  includeBeginDialogs: z.boolean().default(DEFAULTS.includeBeginDialogs),
  maxBeginDialogs: z.number().step(1).min(0).max(24).default(DEFAULTS.maxBeginDialogs),
  personaSectionOrder: z.number().step(1).default(DEFAULTS.personaSectionOrder),
  toneSuffix: z.string().default(DEFAULTS.toneSuffix),
  toneSuffixFile: z.string().default(DEFAULTS.toneSuffixFile),
  toneSuffixOrder: z.number().step(1).min(0).max(100000).default(DEFAULTS.toneSuffixOrder),
  memoryBlockStyle: z.string().default(DEFAULTS.memoryBlockStyle),

  // —— 召回 ——
  recallEnabled: z.boolean().default(DEFAULTS.recallEnabled),
  recallTopK: z.number().step(1).min(1).max(50).default(DEFAULTS.recallTopK),
  recallInjectCount: z.number().step(1).min(1).max(8).default(DEFAULTS.recallInjectCount),
  recallMinSimilarity: z.number().min(0).max(1).default(DEFAULTS.recallMinSimilarity),
  recallMinImportance: z.number().min(0).max(1).default(DEFAULTS.recallMinImportance),
  recallTimeoutMs: z.number().step(1).min(500).max(60000).default(DEFAULTS.recallTimeoutMs),
  recallQueryTurns: z.number().step(1).min(1).max(6).default(DEFAULTS.recallQueryTurns),
  includeDefaultPersonaMemories: z.boolean().default(DEFAULTS.includeDefaultPersonaMemories),
  maxInjectChars: z.number().step(1).min(200).max(20000).default(DEFAULTS.maxInjectChars),

  // —— 写入（默认 dry run；自动写回双触发） ——
  writeEnabled: z.boolean().default(DEFAULTS.writeEnabled),
  automaticWrite: z.boolean().default(DEFAULTS.automaticWrite),
  autoWriteTurns: z.number().step(1).min(2).max(200).default(DEFAULTS.autoWriteTurns),
  autoWriteIdleMs: z.number().step(60000).min(60000).max(86400000).default(DEFAULTS.autoWriteIdleMs),
  autoWriteCheckMs: z.number().step(10000).min(10000).max(3600000).default(DEFAULTS.autoWriteCheckMs),
  autoWriteMaxTurns: z.number().step(1).min(2).max(200).default(DEFAULTS.autoWriteMaxTurns),
  writeTurns: z.number().step(1).min(2).max(40).default(DEFAULTS.writeTurns),
  dryRunByDefault: z.boolean().default(DEFAULTS.dryRunByDefault),
  writeTimeoutMs: z.number().step(1).min(5000).max(600000).default(DEFAULTS.writeTimeoutMs),

  // —— LivingMemory session_id（模板） ——
  sessionIdTemplate: z.string().default(DEFAULTS.sessionIdTemplate),
  storylineName: z.string().default(DEFAULTS.storylineName),

  // —— 观测 ——
  debug: z.boolean().default(DEFAULTS.debug)
})

export { DEFAULTS, resolveConfig } from './pure.js'
