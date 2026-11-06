import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PLUGIN_SOURCE,
  PRODUCER_KIND,
  composeInjectedText,
  createDigestTracker,
  createTurnRings,
  extractEventText,
  isPluginInjected
} from '../lib/inject.js'

test('extractEventText：user/message 的 data 就是消息记录', () => {
  const text = extractEventText('user/message', { content: [{ type: 'text', text: '你好' }] })
  assert.equal(text, '你好')
})

test('extractEventText：assistant/message 的 data.message 才是记录', () => {
  const text = extractEventText('assistant/message', {
    message: { content: [{ type: 'text', text: '在的' }] },
    turn: 1,
    step: 2
  })
  assert.equal(text, '在的')
})

test('extractEventText：非文本块被忽略', () => {
  const text = extractEventText('user/message', {
    content: [{ type: 'image', url: 'x' }, { type: 'text', text: '看图' }]
  })
  assert.equal(text, '看图')
})

test('isPluginInjected：v4 认 plugin:<生产者>，且拒绝字面量 plugin', () => {
  assert.equal(isPluginInjected({ source: { kind: PRODUCER_KIND } }), true)
  assert.equal(isPluginInjected({ source: { kind: 'plugin:other' } }), true)
  assert.equal(isPluginInjected({ source: { kind: 'plugin' } }), false, 'v3 包装形状在 v4 里不是合法注入')
  assert.equal(isPluginInjected({ source: { kind: 'user' } }), false)
  assert.equal(isPluginInjected(undefined), false)
})

test('PRODUCER_KIND：必须是 v4 允许的生产者自有 kind', () => {
  // 回归测试：这一条曾让整轮在写会话时失败
  assert.equal(PRODUCER_KIND, 'plugin:dsh-lm-bridge')
  assert.notEqual(PRODUCER_KIND, 'plugin', 'v4 准入拒绝字面量 plugin')
  assert.ok(PRODUCER_KIND.startsWith('plugin:'))
})

test('composeInjectedText：默认只回记忆块', () => {
  assert.equal(composeInjectedText({ memoryBlock: '记忆', personaText: '人格' }), '记忆')
})

test('composeInjectedText：section 注册失败时人格前置', () => {
  const text = composeInjectedText({ memoryBlock: '记忆', personaText: '人格', personaFallback: true })
  assert.equal(text, '人格\n\n记忆')
  assert.equal(composeInjectedText({ memoryBlock: '', personaText: '人格', personaFallback: true }), '人格')
  assert.equal(composeInjectedText({ memoryBlock: '记忆', personaText: '', personaFallback: true }), '记忆')
})

test('createDigestTracker：同会话同文本只注入一次，跨会话互不影响', () => {
  const tracker = createDigestTracker()
  const first = tracker.shouldInject('s1', '同样的内容')
  assert.equal(first.inject, true)
  tracker.mark('s1', first.digest)

  assert.equal(tracker.shouldInject('s1', '同样的内容').inject, false)
  assert.equal(tracker.shouldInject('s1', '换了内容').inject, true)
  assert.equal(tracker.shouldInject('s2', '同样的内容').inject, true)

  tracker.forget('s1')
  assert.equal(tracker.shouldInject('s1', '同样的内容').inject, true)
  tracker.clear()
  assert.equal(tracker.size, 0)
})

test('createTurnRings：只取用户发言、按时间正序、超限丢弃最旧', () => {
  const rings = createTurnRings({ maxTurns: 4 })
  rings.push('s1', { role: 'user', text: '第一句' })
  rings.push('s1', { role: 'assistant', text: '回应' })
  rings.push('s1', { role: 'user', text: '第二句' })
  rings.push('s1', { role: 'user', text: '第三句' })

  assert.deepEqual(rings.recentUserTexts('s1', 2), ['第二句', '第三句'])
  assert.equal(rings.recentTurns('s1', 10).length, 4)
  assert.equal(rings.recentTurns('s1', 2).at(-1).text, '第三句')

  rings.push('s1', { role: 'user', text: '第四句' })
  assert.equal(rings.recentTurns('s1', 10).length, 4, '上限 4')
  assert.equal(rings.recentTurns('s1', 10).at(-1).text, '第四句')
})

test('createTurnRings：空白不记录，forget/clear 生效', () => {
  const rings = createTurnRings({ maxTurns: 4 })
  rings.push('s1', { role: 'user', text: '   ' })
  assert.equal(rings.recentTurns('s1', 4).length, 0)
  rings.push('s1', { role: 'user', text: '有内容' })
  assert.equal(rings.sessionCount, 1)
  rings.forget('s1')
  assert.equal(rings.sessionCount, 0)
  rings.push('s2', { role: 'user', text: 'x' })
  rings.clear()
  assert.equal(rings.sessionCount, 0)
})

test('PLUGIN_SOURCE 常量与 README 一致', () => {
  assert.equal(PLUGIN_SOURCE, 'dsh-lm-bridge')
})
