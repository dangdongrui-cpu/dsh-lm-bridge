import assert from 'node:assert/strict'
import test from 'node:test'

import { createCircuitBreaker } from '../lib/circuit.js'

test('circuit：阈值内放行，到阈值开门', () => {
  let now = 0
  const breaker = createCircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => now })
  assert.equal(breaker.allow(), true)
  breaker.recordFailure()
  assert.equal(breaker.state.open, false)
  assert.equal(breaker.allow(), true)
  breaker.recordFailure()
  assert.equal(breaker.state.open, true)
  assert.equal(breaker.allow(), false)
  assert.equal(breaker.state.failures, 2)
})

test('circuit：冷却到期放行一次，成功即关门', () => {
  let now = 0
  const breaker = createCircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => now })
  breaker.recordFailure()
  breaker.recordFailure()
  now = 999
  assert.equal(breaker.allow(), false)
  now = 1000
  assert.equal(breaker.allow(), true)
  breaker.recordSuccess()
  assert.equal(breaker.state.failures, 0)
  assert.equal(breaker.state.open, false)
})

test('circuit：冷却后再次失败会重新计时', () => {
  let now = 0
  const breaker = createCircuitBreaker({ threshold: 1, cooldownMs: 500, now: () => now })
  breaker.recordFailure()
  now = 500
  assert.equal(breaker.allow(), true)
  breaker.recordFailure()
  assert.equal(breaker.state.open, true)
  assert.equal(breaker.state.remainingMs, 500)
})

test('circuit：remainingMs 随时间递减，归零即半开', () => {
  let now = 0
  const breaker = createCircuitBreaker({ threshold: 1, cooldownMs: 1000, now: () => now })
  breaker.recordFailure()
  now = 400
  assert.equal(breaker.state.remainingMs, 600)
  now = 1000
  assert.equal(breaker.state.remainingMs, 0)
  assert.equal(breaker.state.open, false)
})

test('circuit：threshold 与 cooldownMs 会被钳到合法范围', () => {
  const breaker = createCircuitBreaker({ threshold: 0, cooldownMs: -10, now: () => 0 })
  breaker.recordFailure()
  assert.equal(breaker.state.limit, 1, 'threshold 0 视为 1')
  assert.equal(breaker.state.cooldownMs, 0, '负数冷却视为 0')
  assert.equal(breaker.allow(), true, '零冷却即立刻半开')
})
