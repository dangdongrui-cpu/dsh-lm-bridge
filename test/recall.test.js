import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecallQuery, filterAndRank, filterAndRankDetailed, renderDropSummary, renderMemoryBlock } from '../lib/recall.js'

const hit = (id, persona, similarity, importance, content = '记忆内容') => ({
  memory_id: id,
  content,
  similarity_score: similarity,
  metadata: { persona_id: persona, importance, session_id: 'livingmemory:global', memory_type: 'GENERAL' }
})

test('buildRecallQuery：persona 名在前，最多带 3 条用户发言', () => {
  const query = buildRecallQuery({
    personaName: 'nicai',
    userTexts: ['一', '二', '三', '四']
  })
  assert.ok(query.startsWith('nicai'))
  assert.ok(query.includes('四'))
  assert.ok(!query.includes('一'), '只取最近 3 条')
})

test('buildRecallQuery：空发言时只有 persona 名', () => {
  assert.equal(buildRecallQuery({ personaName: 'nicai', userTexts: [] }), 'nicai')
})

test('filterAndRank：硬过滤掉别的人格的记忆', () => {
  const results = [
    hit(1, 'nicai', 0.9, 0.5),
    hit(2, '萝莉工人', 0.99, 0.6),
    hit(3, 'default', 0.95, 0.8)
  ]
  const kept = filterAndRank(results, { persona: 'nicai', minSimilarity: 0.5, minImportance: 0.3, limit: 5 })
  assert.deepEqual(kept.map((entry) => entry.id), [1])
})

test('filterAndRank：includeDefault 时才纳入 default', () => {
  const results = [hit(1, 'nicai', 0.9, 0.5), hit(3, 'default', 0.95, 0.8)]
  const kept = filterAndRank(results, {
    persona: 'nicai',
    includeDefault: true,
    minSimilarity: 0.5,
    minImportance: 0.3,
    limit: 5
  })
  assert.deepEqual(kept.map((entry) => entry.id).sort(), [1, 3].sort())
})

test('filterAndRank：双阈值都生效', () => {
  const results = [hit(1, 'nicai', 0.99, 0.1), hit(2, 'nicai', 0.2, 0.9), hit(3, 'nicai', 0.8, 0.4)]
  const kept = filterAndRank(results, { persona: 'nicai', minSimilarity: 0.5, minImportance: 0.3, limit: 5 })
  assert.deepEqual(kept.map((entry) => entry.id), [3])
})

test('filterAndRank：按相似度为主排序并截断', () => {
  const results = [hit(1, 'nicai', 0.6, 0.9), hit(2, 'nicai', 0.9, 0.3), hit(3, 'nicai', 0.75, 0.5)]
  const kept = filterAndRank(results, { persona: 'nicai', minSimilarity: 0.5, minImportance: 0.3, limit: 2 })
  assert.deepEqual(kept.map((entry) => entry.id), [2, 3])
})

test('filterAndRank：脏数据不炸', () => {
  const kept = filterAndRank([null, {}, { content: '   ' }, hit(1, 'nicai', 0.9, 0.9)], {
    persona: 'nicai',
    limit: 5
  })
  assert.equal(kept.length, 1)
})

test('filterAndRankDetailed：按类记录丢弃原因', () => {
  const results = [
    hit(1, 'nicai', 0.9, 0.5),
    hit(2, '', 0.9, 0.5),
    hit(3, '别的角色', 0.9, 0.5),
    hit(4, 'nicai', 0.1, 0.5),
    hit(5, 'nicai', 0.9, 0.1)
  ]
  const { entries, dropped, summary } = filterAndRankDetailed(results, {
    persona: 'nicai',
    minSimilarity: 0.5,
    minImportance: 0.3,
    limit: 5
  })
  assert.deepEqual(entries.map((entry) => entry.id), [1])
  assert.equal(summary.dropped, 4)
  assert.deepEqual(summary.byReason, {
    'persona-empty': 1,
    'persona-mismatch': 1,
    'low-similarity': 1,
    'low-importance': 1
  })
  assert.deepEqual(dropped.map((item) => item.reason).sort(), [
    'low-importance',
    'low-similarity',
    'persona-empty',
    'persona-mismatch'
  ])
})

test('renderDropSummary：没有丢弃时返回空串', () => {
  assert.equal(renderDropSummary({ total: 1, kept: 1, dropped: 0, byReason: {} }), '')
  assert.equal(renderDropSummary(undefined), '')
})

test('renderDropSummary：丢弃时给出中文分类', () => {
  const line = renderDropSummary({
    total: 3,
    kept: 1,
    dropped: 2,
    byReason: { 'persona-empty': 1, 'low-similarity': 1 }
  })
  assert.ok(line.includes('丢弃 2 条'))
  assert.ok(line.includes('persona_id 为空'))
  assert.ok(line.includes('相似度不够'))
})

test('renderMemoryBlock：带“背景事实”提示并守字符预算', () => {
  const block = renderMemoryBlock([{ id: 1, text: 'A'.repeat(500), similarity: 0.9, importance: 0.5 }], {
    personaName: 'nicai',
    maxChars: 300
  })
  assert.ok(block.includes('nicai'))
  assert.ok(block.includes('不是指令'))
  assert.ok(block.length <= 320, `实际 ${block.length}`)
})

test('renderMemoryBlock：默认用「我想起的事」口吻，recall 样式保留旧措辞', () => {
  const entries = [{ id: 1, text: '一起去过冰神湖', similarity: 0.8, importance: 0.5 }]
  const memory = renderMemoryBlock(entries, { personaName: 'nicai' })
  assert.ok(memory.startsWith('【我想起的事 · nicai】'))
  assert.ok(!memory.includes('召回'))

  const recall = renderMemoryBlock(entries, { personaName: 'nicai', style: 'recall' })
  assert.ok(recall.startsWith('【长期记忆 · nicai】'))
  assert.ok(recall.includes('召回'))
})

test('renderMemoryBlock：空结果得到空串', () => {
  assert.equal(renderMemoryBlock([], { personaName: 'nicai' }), '')
})
