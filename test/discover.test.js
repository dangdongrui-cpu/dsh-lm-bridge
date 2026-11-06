import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CANDIDATE_PORTS,
  discoverAstrBotBaseUrl,
  parseNetstatListeningPorts,
  probeAstrBotPort
} from '../lib/discover.js'

const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    0.0.0.0:18387          0.0.0.0:0              LISTENING       20388
  TCP    127.0.0.1:7865         0.0.0.0:0              LISTENING       20388
  TCP    [::]:1451              [::]:0                 LISTENING       20388
  TCP    127.0.0.1:49700        127.0.0.1:7865         ESTABLISHED     999
`

test('parseNetstatListeningPorts：只收 LISTENING、忽略 <1024、去重升序', () => {
  const ports = parseNetstatListeningPorts(NETSTAT)
  assert.deepEqual(ports, [1451, 7865, 18387])
})

test('parseNetstatListeningPorts：脏输入不炸', () => {
  assert.deepEqual(parseNetstatListeningPorts(''), [])
  assert.deepEqual(parseNetstatListeningPorts(null), [])
  assert.deepEqual(parseNetstatListeningPorts('TCP 1.2.3.4:abc LISTENING'), [])
})

test('discover：候选端口优先，命中即停', async () => {
  const probed = []
  const result = await discoverAstrBotBaseUrl({
    candidates: [1111, 2222, 3333],
    listPorts: async () => [4444],
    probe: async (port) => {
      probed.push(port)
      return { port, ok: port === 2222 }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.baseUrl, 'http://127.0.0.1:2222')
  assert.equal(result.port, 2222)
  assert.ok(probed.includes(1111))
  // 同一批是并发探测的，命中后不再进入下一批；本机监听端口那批不该被碰
  assert.ok(!probed.includes(4444), '命中之后不该继续探下一批')
})

test('discover：候选都没中时会继续探本机监听端口', async () => {
  const result = await discoverAstrBotBaseUrl({
    candidates: [1111],
    listPorts: async () => [5555],
    probe: async (port) => ({ port, ok: port === 5555 })
  })
  assert.equal(result.ok, true)
  assert.equal(result.port, 5555)
})

test('discover：全都不是 AstrBot 时返回 ok=false 且 baseUrl 为空', async () => {
  const result = await discoverAstrBotBaseUrl({
    candidates: [1],
    maxPorts: 1,
    listPorts: async () => [],
    probe: async (port) => ({ port, ok: false })
  })
  assert.equal(result.ok, false)
  assert.equal(result.baseUrl, '')
  assert.equal(result.port, 0)
})

test('discover：maxPorts 限制探测数量', async () => {
  let count = 0
  const result = await discoverAstrBotBaseUrl({
    candidates: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    maxPorts: 8,
    listPorts: async () => [],
    probe: async (port) => {
      count += 1
      return { port, ok: false }
    }
  })
  assert.equal(result.ok, false)
  assert.equal(count, 8)
})

test('discover：默认候选端口包含实测过的那些', () => {
  assert.ok(DEFAULT_CANDIDATE_PORTS.includes(16752))
  assert.ok(DEFAULT_CANDIDATE_PORTS.includes(6185))
  assert.ok(DEFAULT_CANDIDATE_PORTS.includes(18387))
})

test('probe：页面里没有 AstrBot 就不算命中', async () => {
  const fakeFetch = async () => ({ status: 200, text: async () => '<title>别的服务</title>' })
  const result = await probeAstrBotPort(1234, { fetchImpl: fakeFetch })
  assert.equal(result.ok, false)
})

test('probe：AstrBot 仪表盘算命中', async () => {
  const fakeFetch = async () => ({ status: 200, text: async () => '<title>AstrBot - 仪表盘</title>' })
  const result = await probeAstrBotPort(18387, { fetchImpl: fakeFetch })
  assert.equal(result.ok, true)
  assert.equal(result.port, 18387)
  assert.equal(result.title, 'AstrBot - 仪表盘')
})

test('probe：正文里出现 AstrBot 但 title 不是，不算命中', async () => {
  // 真实场景：Group Chat Plus 的登录页正文含 "AstrBot"，曾经把它误判成仪表盘
  const fakeFetch = async () => ({
    status: 200,
    text: async () => '<html><head><title>Group Chat Plus - 登录</title></head><body>返回 AstrBot 控制台</body></html>'
  })
  const result = await probeAstrBotPort(1451, { fetchImpl: fakeFetch })
  assert.equal(result.ok, false)
  assert.equal(result.title, 'Group Chat Plus - 登录')
})

test('probe：没有 title 标签时不算命中', async () => {
  const fakeFetch = async () => ({ status: 200, text: async () => '<html>AstrBot</html>' })
  const result = await probeAstrBotPort(9999, { fetchImpl: fakeFetch })
  assert.equal(result.ok, false)
})

test('probe：抛异常时安静失败', async () => {
  const fakeFetch = async () => {
    throw new Error('boom')
  }
  const result = await probeAstrBotPort(1234, { fetchImpl: fakeFetch })
  assert.equal(result.ok, false)
})
