/**
 * AstrBotClient —— 唯一知道「AstrBot 在哪、怎么认证、错误长什么样」的模块。
 *
 * 认证方式（已实测）：dashboard 的 JWT 用 HS256 签名，密钥持久化在
 * `cmd_config.json` 的 `dashboard.jwt_secret`，payload 只需要 `{username, exp}`。
 * 因此本机桥可以自己签票，不需要用户的明文密码。
 *
 * 约定：所有方法都不抛异常，统一返回 { ok, ... }，让调用方永远能降级。
 */

import { createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/** LivingMemory 插件 API 前缀（服务端实际挂载点）。 */
export const PAGE_API = '/api/plug/astrbot_plugin_livingmemory/page'

/**
 * 本地签发 dashboard JWT。
 * @param {{secret: string, username: string, expSeconds: number, now?: number}} options
 * @returns {string} Bearer 用的 token
 */
export function mintDashboardJwt({ secret, username, expSeconds, now = Date.now() }) {
  const b64 = (value) => Buffer.from(value).toString('base64url')
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(
    JSON.stringify({ username, exp: Math.floor(now / 1000) + Math.trunc(expSeconds) })
  )
  const signing = `${header}.${payload}`
  const signature = createHmac('sha256', secret).update(signing).digest('base64url')
  return `${signing}.${signature}`
}

/**
 * 读取 dashboard 凭据，按 mtime 缓存（AstrBot 重启换 secret 时自动跟上）。
 * @param {{configPath: string}} options
 * @returns {() => {username: string, secret: string}}
 */
export function createCredentialReader({ configPath }) {
  let cache = { mtimeMs: Number.NaN, username: '', secret: '' }
  return function read() {
    const stat = statSync(configPath)
    if (stat.mtimeMs === cache.mtimeMs && cache.secret.length > 0) return cache
    const raw = readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, '')
    const json = JSON.parse(raw)
    const dashboard = json?.dashboard ?? {}
    const username = typeof dashboard.username === 'string' ? dashboard.username.trim() : ''
    const secret = typeof dashboard.jwt_secret === 'string' ? dashboard.jwt_secret.trim() : ''
    if (username.length === 0 || secret.length === 0) {
      throw new Error('cmd_config.json 缺少 dashboard.username / dashboard.jwt_secret')
    }
    cache = { mtimeMs: stat.mtimeMs, username, secret }
    return cache
  }
}

/**
 * 把 fetch 的各种失败归类成稳定的错误码，并给一句能直接看懂的人话。
 *
 * 为什么要在插件这一侧做分类：Node 的 fetch 只会抛一个 `TypeError:
 * fetch failed`，真正的病因藏在 `error.cause.code` 里。不拆开的话，用户看到的
 * 永远是「network · fetch failed」，既不知道是端口没开、超时，还是被本机策略挡了。
 *
 * @param {unknown} error fetch 抛出的原始错误
 * @param {{baseUrl?: string}} [context] 当前连的地址，拼进提示里
 * @returns {{code: string, hint: string}} code 稳定、hint 给人看
 */
export function classifyFetchError(error, { baseUrl = '' } = {}) {
  const code = String(error?.code ?? error?.cause?.code ?? '')
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? error ?? '')
  const where = baseUrl.length > 0 ? `（${baseUrl}）` : ''

  if (name === 'AbortError' || code === 'ABORT_ERR' || /aborted|timeout/iu.test(message)) {
    return { code: 'timeout', hint: `请求超时${where}：AstrBot 在忙，或者这个端口上没有 HTTP 服务` }
  }
  if (code === 'ECONNREFUSED') {
    return {
      code: 'connection-refused',
      hint: `连接被拒绝${where}：这个端口没有服务在监听，AstrBot 可能没启动，或者换了端口`
    }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'dns', hint: `主机名解析失败${where}` }
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/iu.test(message)) {
    return { code: 'reset', hint: `连接被对端断开${where}：服务可能在重启` }
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') {
    return { code: 'unreachable', hint: `网络不可达${where}` }
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return { code: 'blocked', hint: `本机策略挡住了这个连接${where}` }
  }
  return { code: 'network', hint: `网络错误${where}：${message.slice(0, 120)}` }
}

/**
 * 创建 AstrBot 客户端。
 * @param {{baseUrl: string, configPath: string, jwtExpSeconds: number, timeoutMs: number, logger?: object}} options
 */
export function createAstrBotClient({ baseUrl, configPath, jwtExpSeconds, timeoutMs, logger }) {
  const readCredential = createCredentialReader({ configPath })
  let root = String(baseUrl).replace(/\/+$/u, '')
  let token = ''

  /** 换地址（端口自适应发现命中后调用）。旧 token 仍然有效，不用清。 */
  function setBaseUrl(next) {
    const value = typeof next === 'string' ? next.replace(/\/+$/u, '') : ''
    if (value.length === 0 || value === root) return false
    root = value
    return true
  }

  function issueToken(force = false) {
    if (!force && token.length > 0) return token
    const { username, secret } = readCredential()
    token = mintDashboardJwt({ secret, username, expSeconds: jwtExpSeconds })
    return token
  }

  /**
   * 发一个请求并把响应压成统一结构。
   * @param {string} path 以 / 开头的路径
   * @param {{method?: string, body?: unknown, timeoutMs?: number, retryOn401?: boolean}} [options]
   */
  async function request(path, options = {}) {
    const method = options.method ?? 'GET'
    const wait = options.timeoutMs ?? timeoutMs
    const maxAttempts = options.retryOn401 === false ? 1 : 2
    let last = { ok: false, status: 0, ms: 0, code: 'unknown', message: '未发请求' }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), wait)
      try {
        issueToken(attempt > 0)
        const headers = { Authorization: `Bearer ${token}` }
        if (options.body !== undefined) headers['Content-Type'] = 'application/json'
        const response = await fetch(`${root}${path}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal
        })
        const text = await response.text()
        const ms = Date.now() - started
        if (response.status === 401 || response.status === 403) {
          last = {
            ok: false,
            status: response.status,
            ms,
            code: 'unauthorized',
            message: text.slice(0, 200),
            hint: `认证失败${root}：cmd_config.json 里的 dashboard.jwt_secret 可能变了，或这个账号没权限`
          }
          continue
        }
        let json
        try {
          json = text.length > 0 ? JSON.parse(text) : {}
        } catch {
          last = {
            ok: false,
            status: response.status,
            ms,
            code: 'bad-json',
            message: text.slice(0, 200),
            hint: `返回的不是 JSON${root}${path}：可能被代理页或登录页截了`
          }
          return last
        }
        if (json?.status === 'error') {
          return {
            ok: false,
            status: response.status,
            ms,
            code: 'business',
            message: String(json?.message ?? 'AstrBot 返回 error'),
            hint: `AstrBot 业务错误：${String(json?.message ?? '未给出原因')}`
          }
        }
        if (!response.ok) {
          // 404 / 405 单列，因为 page 接口是内部接口，消失就是版本漂移的信号。
          const missing = response.status === 404 || response.status === 405
          return {
            ok: false,
            status: response.status,
            ms,
            code: missing ? 'endpoint-missing' : `http-${response.status}`,
            message: text.slice(0, 200),
            hint: missing
              ? `AstrBot 上没有 ${path}：LivingMemory 插件版本可能变了，接口不见了`
              : `AstrBot 返回 HTTP ${response.status}${root}${path}`
          }
        }
        const data = json && typeof json === 'object' && 'data' in json ? json.data : json
        return { ok: true, status: response.status, ms, data }
      } catch (error) {
        const ms = Date.now() - started
        const classified = classifyFetchError(error, { baseUrl: root })
        last = {
          ok: false,
          status: 0,
          ms,
          code: classified.code,
          message: classified.hint,
          hint: classified.hint
        }
        if (last.code === 'timeout') return last
      } finally {
        clearTimeout(timer)
      }
    }
    return last
  }

  /**
   * 轻量存活探测：只看根路径是不是 AstrBot 仪表盘，不带 token。
   * @param {number} wait
   */
  async function ping(wait) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(200, Math.trunc(wait)))
    const started = Date.now()
    try {
      const response = await fetch(`${root}/`, { signal: controller.signal })
      const text = await response.text()
      const ms = Date.now() - started
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          ms,
          code: `http-${response.status}`,
          message: `仪表盘根路径返回 HTTP ${response.status}`,
          hint: `仪表盘根路径返回 HTTP ${response.status}（${root}）`
        }
      }
      if (!/AstrBot/iu.test(text)) {
        return {
          ok: false,
          status: response.status,
          ms,
          code: 'not-astrbot',
          message: '这个端口响应了，但不是 AstrBot 仪表盘',
          hint: `这个端口响应了，但页面里没有 AstrBot（${root}）`
        }
      }
      return { ok: true, status: response.status, ms, data: { baseUrl: root } }
    } catch (error) {
      const ms = Date.now() - started
      const classified = classifyFetchError(error, { baseUrl: root })
      return { ok: false, status: 0, ms, code: classified.code, message: classified.hint, hint: classified.hint }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    get baseUrl() {
      return root
    },
    setBaseUrl,
    request,
    ping,

    /**
     * 两段式健康检查：先看仪表盘在不在，再看 LivingMemory 的 page 接口通不通。
     * 结果里带 stage，方便区分「服务没起」和「接口变了」。
     * @param {{timeoutMs?: number}} [options]
     */
    async health(options = {}) {
      const wait = Math.max(300, Math.trunc(options.timeoutMs ?? Math.min(timeoutMs, 3000)))
      const dashboard = await ping(wait)
      if (!dashboard.ok) return { ...dashboard, stage: 'dashboard' }
      const stats = await request(`${PAGE_API}/stats`, { timeoutMs: wait })
      if (!stats.ok) return { ...stats, stage: 'page-api', dashboardMs: dashboard.ms }
      return {
        ok: true,
        stage: 'ok',
        status: 200,
        ms: dashboard.ms + stats.ms,
        dashboardMs: dashboard.ms,
        pageApiMs: stats.ms,
        data: { baseUrl: root, stats: stats.data }
      }
    },

    /** 存活 + 计数（只读）。 */
    async stats(wait) {
      return request(`${PAGE_API}/stats`, { timeoutMs: wait })
    },

    /**
     * 语义召回。服务端不按 persona 过滤，过滤由 recall.js 本地完成。
     * @param {{query: string, k: number, sessionId?: string, timeoutMs?: number}} args
     */
    async recall({ query, k, sessionId, timeoutMs: wait }) {
      const body = { query, k }
      if (typeof sessionId === 'string' && sessionId.length > 0) body.session_id = sessionId
      return request(`${PAGE_API}/recall/test`, {
        method: 'POST',
        body,
        timeoutMs: wait
      })
    },

    /**
     * 导入记忆（dry_run=true 时只预览，不落库）。
     * @param {{content: string, dryRun: boolean, duplicateStrategy?: string, timeoutMs?: number}} args
     */
    async importMemories({ content, dryRun, duplicateStrategy = 'skip', timeoutMs: wait }) {
      return request(`${PAGE_API}/memories/import`, {
        method: 'POST',
        body: {
          format: 'json',
          dry_run: dryRun !== false,
          duplicate_strategy: duplicateStrategy,
          content
        },
        timeoutMs: wait
      })
    },

    /** 仅供调试：记录一次客户端状态。 */
    describe() {
      return { baseUrl: root, configPath, timeoutMs, hasToken: token.length > 0 }
    }
  }
}
