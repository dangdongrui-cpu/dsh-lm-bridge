/**
 * 联调自检：探测 → 健康检查 → 真实召回 → 过滤报告。
 *
 * 不依赖 DSH 宿主，直接 import lib 里的模块跑，用来确认「端口自适应 + 错误分类
 * + 丢弃可见」在真机上真的工作。只读，不写任何记忆。
 */

import { createAstrBotClient } from '../lib/astrbot.js'
import { discoverAstrBotBaseUrl } from '../lib/discover.js'
import { DEFAULTS } from '../lib/pure.js'
import { filterAndRankDetailed, renderDropSummary } from '../lib/recall.js'

const logger = { info: () => {}, warn: (...args) => console.warn('[warn]', ...args) }

const found = await discoverAstrBotBaseUrl({
  candidates: DEFAULTS.discoverCandidates,
  maxPorts: DEFAULTS.discoverMaxPorts,
  timeoutMs: DEFAULTS.discoverTimeoutMs
})
console.log('discover:', JSON.stringify(found))

const client = createAstrBotClient({
  baseUrl: found.ok ? found.baseUrl : DEFAULTS.astrbotBaseUrl,
  configPath: DEFAULTS.astrbotConfigPath,
  jwtExpSeconds: DEFAULTS.jwtExpSeconds,
  timeoutMs: DEFAULTS.httpTimeoutMs,
  logger
})
console.log('client.baseUrl:', client.baseUrl)

const health = await client.health({ timeoutMs: 3000 })
console.log(
  'health:',
  JSON.stringify({
    ok: health.ok,
    stage: health.stage,
    code: health.code ?? null,
    hint: health.hint ?? null,
    ms: health.ms ?? null
  })
)

const recalled = await client.recall({ query: `${DEFAULTS.personaName} 插件 记忆`, k: 20, timeoutMs: 8000 })
console.log(
  'recall:',
  JSON.stringify({
    ok: recalled.ok,
    code: recalled.code ?? null,
    hint: recalled.hint ?? null,
    status: recalled.status,
    ms: recalled.ms
  })
)
if (recalled.ok) {
  const results = recalled.data?.results ?? []
  const detailed = filterAndRankDetailed(results, {
    persona: DEFAULTS.personaName,
    minSimilarity: DEFAULTS.recallMinSimilarity,
    minImportance: DEFAULTS.recallMinImportance,
    limit: 4
  })
  console.log('过滤:', `服务端 ${results.length} 条 → 命中 ${detailed.entries.length} 条`, renderDropSummary(detailed.summary))
  for (const entry of detailed.entries) {
    console.log(`  - ${(entry.similarity * 100).toFixed(0)}% · 重要性 ${entry.importance.toFixed(2)} · ${entry.personaId} · ${entry.text.slice(0, 60)}`)
  }
}
