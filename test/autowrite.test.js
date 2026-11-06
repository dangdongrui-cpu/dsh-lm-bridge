import assert from 'node:assert/strict'
import test from 'node:test'

import { createAutoWriter } from '../lib/autowrite.js'

/** 最小可用的 rings 假体：只实现 autowrite 用到的那几个方法。 */
function makeRings() {
  const totals = new Map()
  const turns = new Map()
  return {
    push(sessionId, turn) {
      const list = turns.get(sessionId) ?? []
      list.push(turn)
      turns.set(sessionId, list)
      totals.set(sessionId, (totals.get(sessionId) ?? 0) + 1)
    },
    totalCount(sessionId) {
      return totals.get(sessionId) ?? 0
    },
    recentTurns(sessionId, n) {
      return (turns.get(sessionId) ?? []).slice(-n)
    },
    sessionIds() {
      return [...turns.keys()]
    }
  }
}

function makeConfig(overrides = {}) {
  return {
    automaticWrite: true,
    autoWriteTurns: 4,
    autoWriteIdleMs: 3600000,
    autoWriteCheckMs: 300000,
    autoWriteMaxTurns: 40,
    writeTimeoutMs: 1000,
    writeEnabled: true,
    ...overrides
  }
}

function makeWrite(result = { ok: true }) {
  const calls = []
  return {
    calls,
    async submit(args) {
      calls.push(args)
      return { ok: true, dryRun: false, report: 'ok', ...result }
    }
  }
}

test('autowrite：不满阈值不提交', async () => {
  const rings = makeRings()
  const write = makeWrite()
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => 0 })
  for (let i = 0; i < 3; i += 1) rings.push('s1', { role: 'user', text: `第${i}条` })
  const result = await writer.checkThreshold('s1')
  assert.equal(result.code, 'below-threshold')
  assert.equal(write.calls.length, 0)
})

test('autowrite：到阈值提交，并走双闸门', async () => {
  const rings = makeRings()
  const write = makeWrite()
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => 0 })
  for (let i = 0; i < 4; i += 1) rings.push('s1', { role: i % 2 === 0 ? 'user' : 'assistant', text: `第${i}条` })
  const result = await writer.checkThreshold('s1')
  assert.equal(result.ok, true)
  assert.equal(write.calls.length, 1)
  assert.equal(write.calls[0].dryRun, false, '自动路径内部必须显式 false')
  assert.equal(write.calls[0].confirm, true, '自动路径内部必须显式 true')
})

test('autowrite：提交成功后游标推进，不会重复提交同一段', async () => {
  const rings = makeRings()
  const write = makeWrite()
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => 0 })
  for (let i = 0; i < 4; i += 1) rings.push('s1', { role: 'user', text: `第${i}条` })
  await writer.checkThreshold('s1')
  assert.equal(writer.pending('s1'), 0)
  const again = await writer.checkThreshold('s1')
  assert.equal(again.code, 'below-threshold')
  assert.equal(write.calls.length, 1, '不该重复提交')
})

test('autowrite：空闲超时才提交（不满阈值也写）', async () => {
  let clock = 0
  const rings = makeRings()
  const write = makeWrite()
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => clock })
  rings.push('s1', { role: 'user', text: '只说了两句' })
  rings.push('s1', { role: 'assistant', text: '我回了一句' })
  writer.note('s1')

  clock = 1000
  assert.equal((await writer.checkIdle()).length, 0, '刚说完不该提交')

  clock = 3600000
  const results = await writer.checkIdle()
  assert.equal(results.length, 1)
  assert.equal(write.calls.length, 1)
  assert.equal(results[0].ok, true)
})

test('autowrite：提交失败不推进游标，下轮还能重试', async () => {
  const rings = makeRings()
  const write = makeWrite({ ok: false, code: 'network' })
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => 0 })
  for (let i = 0; i < 4; i += 1) rings.push('s1', { role: 'user', text: `第${i}条` })
  const result = await writer.checkThreshold('s1')
  assert.equal(result.ok, false)
  assert.equal(writer.pending('s1'), 4, '失败后 pending 应保持不变')
})

test('autowrite：inflight 时拒绝并发提交', async () => {
  const rings = makeRings()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const write = {
    calls: 0,
    async submit() {
      write.calls += 1
      await gate
      return { ok: true }
    }
  }
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => 0 })
  for (let i = 0; i < 8; i += 1) rings.push('s1', { role: 'user', text: `第${i}条` })
  const first = writer.checkThreshold('s1')
  const second = await writer.checkThreshold('s1')
  assert.equal(second.code, 'inflight')
  release()
  await first
  assert.equal(write.calls, 1)
})

test('autowrite：automaticWrite 关闭时全部短路', async () => {
  const rings = makeRings()
  const write = makeWrite()
  const writer = createAutoWriter({ write, rings, config: makeConfig({ automaticWrite: false }), now: () => 0 })
  for (let i = 0; i < 8; i += 1) rings.push('s1', { role: 'user', text: `第${i}条` })
  const result = await writer.checkThreshold('s1')
  assert.equal(result.code, 'disabled')
  assert.equal((await writer.checkIdle()).length, 0)
  assert.equal(write.calls.length, 0)
})

test('autowrite：markSubmitted 让自动通道跳过手动已写的段', async () => {
  const rings = makeRings()
  const write = makeWrite()
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => 0 })
  for (let i = 0; i < 4; i += 1) rings.push('s1', { role: 'user', text: `第${i}条` })
  writer.markSubmitted('s1')
  assert.equal(writer.pending('s1'), 0)
  const result = await writer.checkThreshold('s1')
  assert.equal(result.code, 'below-threshold')
})

test('autowrite：定时器 start/stop 只装一次', () => {
  const rings = makeRings()
  const write = makeWrite()
  let installed = 0
  let cleared = 0
  const writer = createAutoWriter({
    write,
    rings,
    config: makeConfig(),
    now: () => 0,
    setIntervalFn: () => {
      installed += 1
      return { unref() {}, id: installed }
    },
    clearIntervalFn: () => {
      cleared += 1
    }
  })
  writer.start()
  writer.start()
  assert.equal(installed, 1, '重复 start 不该装第二个定时器')
  assert.equal(writer.running, true)
  writer.stop()
  assert.equal(cleared, 1)
  assert.equal(writer.running, false)
})

test('autowrite：snapshot 反映 pending 与上次结果', async () => {
  const rings = makeRings()
  const write = makeWrite()
  const writer = createAutoWriter({ write, rings, config: makeConfig(), now: () => 42 })
  for (let i = 0; i < 4; i += 1) rings.push('s1', { role: 'user', text: `第${i}条` })
  await writer.checkThreshold('s1')
  const snap = writer.snapshot()
  assert.equal(snap.s1.pending, 0)
  assert.equal(snap.s1.submittedCount, 4)
  assert.equal(snap.s1.lastResult.ok, true)
  assert.equal(snap.s1.lastResult.reason, 'threshold')
})
