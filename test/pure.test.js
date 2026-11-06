import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULTS,
  clip,
  normalizeBeginDialogs,
  oneLine,
  renderSessionId,
  resolveConfig,
  toStringArray
} from '../lib/pure.js'

test('resolveConfig：空配置回落到默认值，并派生 sessionId', () => {
  const config = resolveConfig({})
  assert.equal(config.personaName, 'nicai')
  assert.equal(config.sessionId, 'dsh-rp:nicai')
  assert.equal(config.automaticWrite, true, '自动写回默认开（双触发）')
  assert.equal(config.autoWriteTurns, 20)
  assert.equal(config.autoWriteIdleMs, 3600000)
  assert.equal(config.dryRunByDefault, true)
  assert.equal(config.recallMinSimilarity, DEFAULTS.recallMinSimilarity)
})

test('L3/L4 默认值：开场示范默认开、语气后缀默认空、记忆块用「我想起的事」', () => {
  const config = resolveConfig({})
  assert.equal(config.includeBeginDialogs, true, 'L3：默认注入语气示范')
  assert.equal(config.maxBeginDialogs, 6)
  assert.equal(config.toneSuffix, '')
  assert.equal(config.toneSuffixOrder, 10200, '默认排在工具指导之后')
  assert.equal(config.memoryBlockStyle, 'memory')
})

test('toneSuffix：保留原文换行，顺序被钳制，未知样式退回 memory', () => {
  const suffix = '你是nicai，第一人称。\n技术结论可以结构化，但语气不切回工单。'
  const config = resolveConfig({ toneSuffix: `  ${suffix}  `, toneSuffixOrder: 999999, memoryBlockStyle: 'magic' })
  assert.equal(config.toneSuffix, suffix)
  assert.equal(config.toneSuffixOrder, 100000)
  assert.equal(config.memoryBlockStyle, 'memory')
  assert.equal(resolveConfig({ memoryBlockStyle: 'recall' }).memoryBlockStyle, 'recall')
})

test('resolveConfig：数值被钳制、布尔被强制、automaticWrite 可配置', () => {
  const config = resolveConfig({
    recallTopK: 999,
    recallInjectCount: 0,
    recallMinSimilarity: 2,
    recallMinImportance: -1,
    writeTurns: 1,
    automaticWrite: false,
    autoWriteTurns: 999,
    autoWriteIdleMs: 1,
    personaName: '  nicai  '
  })
  assert.equal(config.recallTopK, 50)
  assert.equal(config.recallInjectCount, 1)
  assert.equal(config.recallMinSimilarity, 1)
  assert.equal(config.recallMinImportance, 0)
  assert.equal(config.writeTurns, 2)
  assert.equal(config.automaticWrite, false, '关掉自动写回要生效')
  assert.equal(config.autoWriteTurns, 200, '阈值被钳到上限')
  assert.equal(config.autoWriteIdleMs, 60000, '空闲超时被钳到下限')
  assert.equal(config.personaName, 'nicai')
})

test('resolveConfig：未知 personaSource 退回 sqlite；URL 去掉尾斜杠', () => {
  const config = resolveConfig({ personaSource: 'magic', astrbotBaseUrl: 'http://127.0.0.1:16752///' })
  assert.equal(config.personaSource, 'sqlite')
  assert.equal(config.astrbotBaseUrl, 'http://127.0.0.1:16752')
})

test('renderSessionId：无剧情线时收掉多余冒号', () => {
  assert.equal(renderSessionId('dsh-rp:{persona}', { persona: 'nicai' }), 'dsh-rp:nicai')
  assert.equal(renderSessionId('dsh-rp:{persona}:{storyline}', { persona: 'nicai', storyline: '' }), 'dsh-rp:nicai')
  assert.equal(
    renderSessionId('dsh-rp:{persona}:{storyline}', { persona: 'nicai', storyline: '冰神湖' }),
    'dsh-rp:nicai:冰神湖'
  )
  assert.equal(renderSessionId('', { persona: 'nicai' }), 'dsh-rp:nicai')
})

test('renderSessionId：空模板/空 persona 时仍给出可用值', () => {
  assert.equal(renderSessionId('   ', { persona: 'nicai' }), 'dsh-rp:nicai')
  assert.equal(renderSessionId('dsh-rp:{persona}', { persona: '' }), 'dsh-rp:default')
})

test('normalizeBeginDialogs：偶数保留、奇数整段丢弃（与 AstrBot 行为一致）', () => {
  assert.deepEqual(normalizeBeginDialogs('["a","b"]').dialogs, ['a', 'b'])
  const odd = normalizeBeginDialogs('["a","b","c"]')
  assert.deepEqual(odd.dialogs, [])
  assert.equal(odd.dropped, true)
  assert.deepEqual(normalizeBeginDialogs('not-json').dialogs, [])
  assert.deepEqual(normalizeBeginDialogs([]).dialogs, [])
})

test('toStringArray：非法输入安全返回空数组', () => {
  assert.deepEqual(toStringArray('{"a":1}'), [])
  assert.deepEqual(toStringArray(42), [])
  assert.deepEqual(toStringArray(['x', 1, 'y']), ['x', 'y'])
})

test('oneLine / clip：压空白与截断', () => {
  assert.equal(oneLine('  a \n b  '), 'a b')
  assert.equal(clip('abcdef', 3), 'abc…')
  assert.equal(clip('abc', 10), 'abc')
  assert.equal(clip('abc', 0), 'abc')
})
