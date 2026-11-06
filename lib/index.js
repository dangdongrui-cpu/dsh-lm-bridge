/**
 * dsh-lm-bridge —— DSH ↔ AstrBot LivingMemory 桥（MVP）
 *
 * 目标：AstrBot 与 DSH 是「同一个角色」的两个窗口——
 *   Persona 以 AstrBot 为唯一主源；长期记忆读写走 LivingMemory；
 *   DSH 只保留进程内的短期轮次缓冲，不建第二套长期记忆。
 *
 * 注入通道（DSH 0.2.0-rc.2 的公开 seam）：
 *   - 人格：ctx.systemPrompt.section(...)（稳定、位于系统提示）
 *   - 记忆：ctx.on('agent/pre-step') 插入一条带 source.digest 的 user 消息
 *           （首轮就会执行，超时/失败才降级为 persona-only）
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import { resolveConfig } from './pure.js'
import { createAstrBotClient } from './astrbot.js'
import { createPersonaAdapter } from './persona.js'
import { createRecallAdapter, filterAndRankDetailed, renderDropSummary } from './recall.js'
import { createWriteAdapter } from './write.js'
import { createAutoWriter } from './autowrite.js'
import { createToneReader } from './tone.js'
import { discoverAstrBotBaseUrl } from './discover.js'
import {
  PRODUCER_KIND,
  composeInjectedText,
  createDigestTracker,
  createTurnRings,
  extractEventText,
  isPluginInjected
} from './inject.js'

export const name = 'dsh-lm-bridge'
export { Config }

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {Record<string, unknown>} rawConfig 组合层配置
 */
export function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger ?? console
  const config = resolveConfig(rawConfig)

  if (!config.enabled) {
    logger.info('dsh-lm-bridge: disabled by config')
    return
  }

  const client = createAstrBotClient({
    baseUrl: config.astrbotBaseUrl,
    configPath: config.astrbotConfigPath,
    jwtExpSeconds: config.jwtExpSeconds,
    timeoutMs: config.httpTimeoutMs,
    logger
  })
  const persona = createPersonaAdapter({
    dbPath: config.personaDbPath,
    personaName: config.personaName,
    refreshSeconds: config.personaRefreshSeconds,
    includeBeginDialogs: config.includeBeginDialogs,
    maxBeginDialogs: config.maxBeginDialogs,
    logger
  })
  const recall = createRecallAdapter({ client, config, logger })
  const write = createWriteAdapter({ client, config, sessionId: config.sessionId, logger })
  // 环容量要能装下自动提交的阈值条数，否则提交时已经被挤掉了
  const rings = createTurnRings({ maxTurns: Math.max(40, config.autoWriteTurns + 10, config.writeTurns + 10) })
  const digests = createDigestTracker()
  const autoWriter = createAutoWriter({ write, rings, config, logger })

  // ── 0. 连接：端口自适应发现 + 健康检查（内存态，不落盘） ────────────────
  /** 当前连接快照：给日志、设置页和工具输出用。 */
  const link = { baseUrl: client.baseUrl, health: null, discoveredAt: 0 }
  let lastRefreshAt = 0

  /**
   * 重新定位 AstrBot 并做一次健康检查。
   *
   * 为什么要自己找：AstrBot Launcher 每次启动都可能给实例换空闲端口，
   * 配置里那个写死的 baseUrl 迟早失效，不找就是永远的 fetch failed。
   * @param {boolean} [force] 跳过 60 秒节流
   */
  async function refreshLink(force = false) {
    const nowMs = Date.now()
    if (!force && nowMs - lastRefreshAt < 60000) return
    lastRefreshAt = nowMs
    try {
      if (config.discoverEnabled) {
        const found = await discoverAstrBotBaseUrl({
          candidates: config.discoverCandidates,
          maxPorts: config.discoverMaxPorts,
          timeoutMs: config.discoverTimeoutMs
        })
        if (found.ok) {
          const changed = client.setBaseUrl(found.baseUrl)
          link.baseUrl = found.baseUrl
          link.discoveredAt = Date.now()
          logger.info(
            'dsh-lm-bridge: AstrBot 仪表盘已定位 %s（探测 %d 个端口%s）',
            found.baseUrl,
            found.probed,
            changed ? '，已切换' : ''
          )
        } else {
          logger.warn(
            'dsh-lm-bridge: 没探到 AstrBot 仪表盘（探了 %d 个端口），先用配置里的 %s',
            found.probed,
            client.baseUrl
          )
        }
      }
      const health = await client.health({ timeoutMs: Math.min(config.httpTimeoutMs, 3000) })
      link.health = health
      if (health.ok) {
        logger.info(
          'dsh-lm-bridge: 健康检查通过（%s，dashboard %dms + page-api %dms）',
          client.baseUrl,
          health.dashboardMs ?? 0,
          health.pageApiMs ?? 0
        )
      } else {
        logger.warn(
          'dsh-lm-bridge: 健康检查失败（stage=%s, code=%s）：%s',
          health.stage,
          health.code,
          health.hint ?? health.message
        )
      }
    } catch (error) {
      logger.warn('dsh-lm-bridge: 连接初始化失败：%s', error?.message ?? error)
    }
  }

  void refreshLink(true)

  /** 人格是否由 systemPrompt.section 承载；注册失败时改走记忆块前置。 */
  let sectionRegistered = false

  /**
   * 运行期开关（设置页那颗按钮控制的位）。
   * 只活在进程内存里：重启回到配置默认，不写任何文件——符合「桥不持有状态」的约定。
   */
  const runtime = { on: true }

  // ── 1. 人格：系统提示段 ────────────────────────────────────────────────
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    try {
      systemPrompt.section({
        name: 'lm-bridge:persona',
        order: config.personaSectionOrder,
        interpolate: false,
        text: () => (runtime.on ? persona.text : '')
      })
      sectionRegistered = true
      logger.info('dsh-lm-bridge: persona section registered (order=%d, persona=%s)', config.personaSectionOrder, config.personaName)
    } catch (error) {
      logger.warn(
        'dsh-lm-bridge: systemPrompt.section 注册失败（%s）；人格将随记忆块一起注入',
        error?.message ?? error
      )
    }

    // 语气：优先读共享文件（和 AstrBot 那边的 tone 插件读同一份），
    // 读不到才退回配置里写死的 toneSuffix。默认 10200，排在工具指导之后。
    const toneReader = createToneReader({ filePath: config.toneSuffixFile, logger })
    const readTone = () => {
      const fromFile = toneReader.read()
      return fromFile.length > 0 ? fromFile : config.toneSuffix
    }
    if (config.toneSuffix.length > 0 || config.toneSuffixFile.length > 0) {
      try {
        systemPrompt.section({
          name: 'lm-bridge:tone',
          order: config.toneSuffixOrder,
          interpolate: false,
          text: () => (runtime.on ? readTone() : '')
        })
        logger.info(
          'dsh-lm-bridge: tone section registered (order=%d, file=%s, fallback=%d chars)',
          config.toneSuffixOrder,
          config.toneSuffixFile || '(none)',
          config.toneSuffix.length
        )
      } catch (error) {
        logger.warn('dsh-lm-bridge: tone suffix 注册失败（%s）', error?.message ?? error)
      }
    }
  } else {
    logger.warn('dsh-lm-bridge: 没有 systemPrompt 服务；人格将随记忆块一起注入')
  }

  // ── 2. 会话事件：维护轮次环形缓冲（纯内存） ─────────────────────────────
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        if (typeof sessionId !== 'string') return
        if (event?.type === 'user/message' || event?.type === 'assistant/message') {
          if (isPluginInjected(event.data)) return
          const text = extractEventText(event.type, event.data)
          if (text.length === 0) return
          rings.push(sessionId, {
            role: event.type === 'user/message' ? 'user' : 'assistant',
            text,
            ts: Date.now()
          })
          // 自动写回：记活跃时间；到阈值就异步提交（不阻塞事件处理）
          autoWriter.note(sessionId)
          void autoWriter.checkThreshold(sessionId).catch((error) => {
            logger.warn('dsh-lm-bridge: 阈值自动写回失败：%s', error?.message ?? error)
          })
          return
        }
        if (event?.type === 'session/disposed' || event?.type === 'session/closed') {
          rings.forget(sessionId)
          digests.forget(sessionId)
        }
      } catch (error) {
        logger.warn('dsh-lm-bridge: session/event 处理失败：%s', error?.message ?? error)
      }
    })

    // ── 3. 每步之前：人格刷新 + 召回 + 注入 ──────────────────────────────
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const agent = payload?.agent
        const sessionId = agent?.session?.id
        if (typeof sessionId !== 'string') return decision

        // 设置页那颗开关关掉时：不读人格、不召回、不注入
        if (!runtime.on) return decision

        // 人格：TTL 内不重复读库；失败保留旧缓存
        await persona.refresh(false)

        // 召回：首轮也走；只有超时/接口失败才降级
        const userTexts = collectUserTexts(payload, sessionId)
        const recalled = config.recallEnabled
          ? await recall.recall({ userTexts })
          : { ok: true, entries: [], block: '', code: 'disabled' }

        // 召回失败时顺手重新找一次 AstrBot（内部有 60 秒节流，不会打爆）
        if (!recalled.ok && recalled.code !== 'disabled') {
          if (config.debug) logger.info('dsh-lm-bridge: 召回失败（%s），触发重新定位', recalled.code)
          void refreshLink()
        }

        const text = composeInjectedText({
          memoryBlock: recalled.block,
          personaText: persona.text,
          personaFallback: !sectionRegistered
        })
        if (text.length === 0) return decision

        const { inject, digest } = digests.shouldInject(sessionId, text)
        if (!inject) return decision

        const message = createUserMessage({
          content: [{ type: 'text', text }],
          // v4 会话格式只认生产者自有的直接 kind（plugin:<生产者>）；
          // v3 的 { kind: 'plugin', plugin: … } 会被准入拒绝并让整轮失败。
          source: { kind: PRODUCER_KIND, digest }
        })

        if (decision?.kind === 'enter' && Array.isArray(decision.messages)) {
          const pending = Array.isArray(payload?.messages) ? payload.messages : []
          const lastClaimed = decision.messages.findLastIndex((item) => pending.includes(item))
          const index = lastClaimed >= 0 ? lastClaimed + 1 : decision.messages.length
          digests.mark(sessionId, digest)
          return { ...decision, messages: decision.messages.toSpliced(index, 0, message) }
        }

        // 步骤被拒 / 空：排队到下一步，替换掉上一轮的旧副本
        if (agent?.inbox?.prepend) {
          const stale = (agent.inbox.nextStep ?? []).filter(
            (item) => item?.source?.kind === PRODUCER_KIND
          )
          for (const item of stale) {
            try {
              agent.inbox.remove?.(item.id)
            } catch {
              // 忽略单条移除失败
            }
          }
          agent.inbox.prepend('next-step', message)
          digests.mark(sessionId, digest)
        }
      } catch (error) {
        // 记忆/人格注入失败绝不影响回合
        logger.warn('dsh-lm-bridge: pre-step 注入失败：%s', error?.message ?? error)
      }
      return decision
    })

    ctx.on('agent/created', ({ agent } = {}) => {
      void persona.refresh(false).catch(() => {})
      if (config.debug) logger.info('dsh-lm-bridge: agent created (%s)', agent?.session?.id ?? 'unknown')
    })
  }

  // ── 4. 设置页开关的宿主侧：两个回环 HTTP 路由 ──────────────────────────
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.webServer
      if (server === undefined || typeof server.register !== 'function') {
        logger.warn('dsh-lm-bridge: 没有 webServer 服务；设置页开关不可用')
        return
      }
      const isLoopback = (req) => {
        const address = req.socket?.remoteAddress ?? ''
        return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
      }
      const reply = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const snapshot = () => ({
        enabled: runtime.on,
        personaName: config.personaName,
        personaLoaded: persona.text.length > 0,
        recallEnabled: config.recallEnabled && runtime.on,
        sessionId: config.sessionId,
        astrbotBaseUrl: link.baseUrl,
        discoveredAt: link.discoveredAt > 0 ? new Date(link.discoveredAt).toISOString() : null,
        health:
          link.health === null
            ? { ok: false, stage: 'pending' }
            : {
                ok: link.health.ok,
                stage: link.health.stage ?? 'unknown',
                code: link.health.code ?? null,
                hint: link.health.hint ?? link.health.message ?? null,
                ms: link.health.ms ?? null
              },
        recall: {
          lastError: recall.lastError,
          lastSummary: recall.lastSummary,
          circuit: recall.circuit
        },
        autoWrite: {
          enabled: config.automaticWrite,
          running: autoWriter.running,
          turns: config.autoWriteTurns,
          idleMs: config.autoWriteIdleMs,
          checkMs: config.autoWriteCheckMs,
          sessions: autoWriter.snapshot()
        }
      })
      try {
        server.register({
          kind: 'exact',
          path: '/api/dsh-lm-bridge/state',
          handler: (req, res) => {
            if (!isLoopback(req)) return reply(res, 403, { error: 'loopback only' })
            return reply(res, 200, snapshot())
          }
        })
        server.register({
          kind: 'exact',
          path: '/api/dsh-lm-bridge/toggle',
          handler: (req, res) => {
            if (!isLoopback(req)) return reply(res, 403, { error: 'loopback only' })
            if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' })
            runtime.on = !runtime.on
            // 重新打开时清掉注入去重，让下一轮立刻重新注入
            if (runtime.on) digests.clear()
            logger.info('dsh-lm-bridge: persona injection %s (settings toggle)', runtime.on ? 'ON' : 'OFF')
            return reply(res, 200, snapshot())
          }
        })
        logger.info('dsh-lm-bridge: toggle routes registered (/api/dsh-lm-bridge/{state,toggle})')
      } catch (error) {
        logger.warn('dsh-lm-bridge: 注册开关路由失败（%s）', error?.message ?? error)
      }
    })
  }

  // ── 5. 模型工具：手动召回 / 手动写回（默认 dry run） ────────────────────
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.tools
      if (tools === undefined || typeof tools.register !== 'function') return

      tools.register(
        defineTool({
          name: 'livingmemory_recall',
          description: [
            `从 AstrBot LivingMemory 检索「${config.personaName}」的长期记忆（只读）。`,
            '结果已按 persona 硬过滤并过相似度/重要性阈值。',
            '不传 query 时，用当前会话最近的用户发言做检索词。'
          ].join(' '),
          parameters: {
            query: { type: 'string', description: '检索词；省略则用最近用户发言' },
            k: { type: 'integer', description: `向服务端要多少条（1-50，默认 ${config.recallTopK}）` }
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }]
          },
          async execute(args, exec) {
            const sessionId = exec?.agent?.session?.id
            const userTexts =
              typeof args?.query === 'string' && args.query.trim().length > 0
                ? [args.query]
                : collectUserTexts({ messages: [] }, sessionId)
            const k = Number.isFinite(args?.k) ? Math.min(50, Math.max(1, Math.trunc(args.k))) : config.recallTopK
            const response = await client.recall({
              query: userTexts.join(' ') || config.personaName,
              k,
              timeoutMs: config.recallTimeoutMs
            })
            if (!response.ok) {
              const lines = [
                `召回失败：${response.code}`,
                response.hint ?? response.message,
                `当前连接：${client.baseUrl}`
              ]
              if (recall.circuit.failures > 0) {
                lines.push(`连续失败 ${recall.circuit.failures} 次，达到 ${recall.circuit.limit} 次后进入冷却`)
              }
              return { text: lines.join('\n') }
            }
            const results = response.data?.results ?? []
            const detailed = filterAndRankDetailed(results, {
              persona: config.personaName,
              includeDefault: config.includeDefaultPersonaMemories,
              minSimilarity: config.recallMinSimilarity,
              minImportance: config.recallMinImportance,
              limit: Math.max(config.recallInjectCount, 8)
            })
            const dropLine = renderDropSummary(detailed.summary)
            if (detailed.entries.length === 0) {
              const head = `未命中「${config.personaName}」的记忆（服务端返回 ${results.length} 条）`
              return { text: dropLine.length > 0 ? `${head}\n${dropLine}` : head }
            }
            const lines = detailed.entries.map(
              (entry, index) =>
                `${index + 1}. (${(entry.similarity * 100).toFixed(0)}% · 重要性 ${entry.importance.toFixed(2)}${entry.personaId ? ` · ${entry.personaId}` : ''}) ${entry.text}`
            )
            const head = `命中 ${detailed.entries.length} 条（persona=${config.personaName}）`
            return { text: `${head}\n${lines.join('\n')}${dropLine.length > 0 ? `\n${dropLine}` : ''}` }
          }
        })
      )

      tools.register(
        defineTool({
          name: 'livingmemory_write',
          description: [
            '把当前 RP 会话最近若干轮提交给 AstrBot LivingMemory。',
            '默认 dryRun=true：只返回预演报告，不落库、不调 LLM 总结。',
            '真正写入必须同时传 dryRun:false 与 confirm:true —— 这是两道闸门，',
            '不会因为上一次 dry run 成功而自动继续。'
          ].join(' '),
          parameters: {
            turns: { type: 'integer', description: `提交最近几轮（2-40，默认 ${config.writeTurns}）` },
            dryRun: { type: 'boolean', description: '默认 true；false 表示要真正写入（还需 confirm:true）' },
            confirm: { type: 'boolean', description: 'dryRun:false 时必须同时为 true，否则拒绝写入' }
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }]
          },
          async execute(args, exec) {
            const sessionId = exec?.agent?.session?.id
            if (typeof sessionId !== 'string') {
              return { text: '无法确定当前会话，已取消。' }
            }
            const turns = Number.isFinite(args?.turns) ? Math.trunc(args.turns) : config.writeTurns
            const result = await write.submit({
              turns: rings.recentTurns(sessionId, Math.min(40, Math.max(2, turns))),
              dryRun: args?.dryRun,
              confirm: args?.confirm
            })
            // 手动写成功也推进游标，免得自动通道把同一段再提交一次
            if (result.ok && args?.dryRun === false) autoWriter.markSubmitted(sessionId)
            const head = result.ok ? '' : `${result.message}\n\n`
            return {
              text: `${head}${result.report ?? ''}`.trim() || result.message
            }
          }
        })
      )

      logger.info('dsh-lm-bridge: tools registered (livingmemory_recall, livingmemory_write)')
    })
  }

  // ── 5. 卸载清理：只释放内存，不写任何持久状态 ──────────────────────────
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      autoWriter.stop()
      rings.clear()
      digests.clear()
    })
  }

  // 自动写回的空闲巡检：沉默不会产生事件，只能靠定时器。
  autoWriter.start()

  // SessionSummary / SceneState 预留给第二版：届时在此处注册自己的
  // prompt section 与工具，本版不实现，也不引入任何持久化。
  logger.info(
    'dsh-lm-bridge ready (persona=%s, sessionId=%s, recall=%s k=%d→%d, write=%s dryRunDefault=%s, autoWrite=%s/%d轮或%d分钟空闲)',
    config.personaName,
    config.sessionId,
    config.recallEnabled ? 'on' : 'off',
    config.recallTopK,
    config.recallInjectCount,
    config.writeEnabled ? 'manual' : 'off',
    config.dryRunByDefault,
    config.automaticWrite ? 'on' : 'off',
    config.autoWriteTurns,
    Math.round(config.autoWriteIdleMs / 60000)
  )

  /**
   * 收集最近用户发言：优先内存环形缓冲，其次本次 pre-step 的待进入消息。
   * @param {{messages?: Array<object>}} payload pre-step 载荷
   * @param {string} sessionId
   * @returns {string[]}
   */
  function collectUserTexts(payload, sessionId) {
    const fromRing = typeof sessionId === 'string' ? rings.recentUserTexts(sessionId, config.recallQueryTurns) : []
    if (fromRing.length > 0) return fromRing
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    return messages
      .filter((message) => message?.role === 'user' || message?.source?.kind === 'user')
      .map((message) => extractEventText('user/message', message))
      .filter((text) => text.length > 0)
      .slice(-config.recallQueryTurns)
  }
}
