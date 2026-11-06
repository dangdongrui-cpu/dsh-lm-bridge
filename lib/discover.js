/**
 * AstrBot 仪表盘端口自适应发现。
 *
 * 背景：AstrBot Launcher 每次启动都可能给实例换一个空闲端口（实测从 16752
 * 变成了 18387），把 baseUrl 写死迟早失效。这里不去猜配置文件，而是
 * 「枚举本机监听端口 → 逐个探根路径 → 看页面是不是 AstrBot 仪表盘」，
 * 端口怎么变都能自己找回来。
 *
 * 两个可注入点（run / fetchImpl）是为了单测不碰真实进程与网络。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 常见候选端口：优先探这些，命中就地停，省得每次全扫。 */
export const DEFAULT_CANDIDATE_PORTS = [16752, 6185, 18387, 11451, 6186]

/** 一次扫描最多探多少个端口（防止本机监听端口过多时拖慢启动）。 */
export const DEFAULT_MAX_PORTS = 64

/**
 * 从 `netstat -ano` 输出里解析出本地监听端口。
 *
 * Windows 的样例行：
 *   TCP    0.0.0.0:18387    0.0.0.0:0    LISTENING    20388
 *   TCP    [::]:1451         [::]:0       LISTENING    20388
 * @param {string} text netstat 原始输出
 * @returns {number[]} 去重、升序、只保留 >=1024 的端口
 */
export function parseNetstatListeningPorts(text) {
  const ports = new Set()
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (!/\bLISTENING\b/iu.test(line)) continue
    const cols = line.trim().split(/\s+/u)
    const local = cols[1] ?? ''
    const match = /:(\d{2,5})$/u.exec(local)
    if (match === null) continue
    const port = Number(match[1])
    if (Number.isFinite(port) && port >= 1024 && port <= 65535) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * 枚举本机监听端口。非 Windows 或 netstat 不可用时安静地返回空数组，
 * 让发现流程退化到「只探候选端口」。
 * @param {{run?: Function, platform?: string}} [options]
 * @returns {Promise<number[]>}
 */
export async function listListeningPorts({ run = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'win32') return []
  try {
    const { stdout } = await run('netstat', ['-ano'], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return parseNetstatListeningPorts(stdout)
  } catch {
    return []
  }
}

/**
 * 探测某个端口是不是 AstrBot 仪表盘。
 *
 * 判定必须看 <title>，不能看全文：AstrBot 的很多插件页面（比如 Group Chat Plus
 * 的登录页）正文里也会出现 "AstrBot" 字样，全文匹配会把它们全算成命中，
 * 结果连到插件面板上，page-api 直接 404。
 *
 * @param {number} port
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{port: number, ok: boolean, status?: number, title?: string}>}
 */
export async function probeAstrBotPort(port, { fetchImpl = fetch, timeoutMs = 900 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(100, Math.trunc(timeoutMs)))
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: controller.signal })
    const text = await response.text()
    const titleMatch = /<title[^>]*>([^<]*)<\/title>/iu.exec(text)
    const title = titleMatch === null ? '' : titleMatch[1].trim()
    const ok = response.status >= 200 && response.status < 400 && /AstrBot/iu.test(title)
    return { port, ok, status: response.status, title }
  } catch {
    return { port, ok: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 找到 AstrBot 仪表盘地址。
 *
 * 顺序：候选端口 → 本机监听端口；分批并发探测，命中即停。
 * @param {{
 *   candidates?: number[],
 *   maxPorts?: number,
 *   timeoutMs?: number,
 *   listPorts?: Function,
 *   probe?: Function
 * }} [options]
 * @returns {Promise<{ok: boolean, baseUrl: string, port: number, probed: number}>}
 */
export async function discoverAstrBotBaseUrl(options = {}) {
  const candidates = Array.isArray(options.candidates) && options.candidates.length > 0
    ? options.candidates
    : DEFAULT_CANDIDATE_PORTS
  const maxPorts = Math.max(1, Math.trunc(options.maxPorts ?? DEFAULT_MAX_PORTS))
  const timeoutMs = Math.max(100, Math.trunc(options.timeoutMs ?? 900))
  const listPorts = options.listPorts ?? listListeningPorts
  const probe = options.probe ?? probeAstrBotPort

  const seen = new Set()
  const unique = (list) => {
    const out = []
    for (const item of Array.isArray(list) ? list : []) {
      const port = Math.trunc(Number(item))
      if (!Number.isFinite(port) || port < 1 || port > 65535) continue
      if (seen.has(port)) continue
      seen.add(port)
      out.push(port)
    }
    return out
  }

  const batchSize = 8
  let probed = 0

  /** 分批并发探测一组端口，命中即返回；预算用完返回 null。 */
  async function scan(ports) {
    for (let index = 0; index < ports.length; index += batchSize) {
      const budget = Math.max(0, maxPorts - probed)
      if (budget === 0) return null
      const batch = ports.slice(index, index + Math.min(batchSize, budget))
      if (batch.length === 0) return null
      probed += batch.length
      const results = await Promise.all(batch.map((port) => probe(port, { timeoutMs })))
      const hit = results.find((result) => result?.ok === true)
      if (hit !== undefined) return hit
    }
    return null
  }

  // 阶段一：候选端口（实测过的常见端口），命中就完全不碰本机端口列表
  let hit = await scan(unique(candidates))
  // 阶段二：还没中，才去扫本机监听端口
  if (hit === null && probed < maxPorts) {
    hit = await scan(unique(await listPorts()))
  }

  if (hit === null) return { ok: false, baseUrl: '', port: 0, probed }
  return { ok: true, baseUrl: `http://127.0.0.1:${hit.port}`, port: hit.port, probed }
}
