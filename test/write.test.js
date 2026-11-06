import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildImportContent,
  buildSourceMessages,
  createWriteAdapter,
  formatImportReport
} from '../lib/write.js'

const turns = [
  { role: 'user', text: '  我们  到了冰神湖 ', ts: 1_792_000_000_000 },
  { role: 'assistant', text: '嗯，记下了。', ts: 1_792_000_001_000 },
  { role: 'user', text: '   ', ts: 1_792_000_002_000 }
]

test('buildSourceMessages：角色映射、空白丢弃、session_id 补齐', () => {
  const messages = buildSourceMessages(turns, { sessionId: 'dsh-rp:nicai' })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content, '我们 到了冰神湖')
  assert.equal(messages[0].session_id, 'dsh-rp:nicai')
  assert.equal(messages[0].metadata.is_bot_message, false)
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].metadata.is_bot_message, true)
  assert.equal(messages[0].platform, 'dsh')
  assert.ok(Number.isInteger(messages[0].timestamp))
})

test('buildSourceMessages：limit 从尾部截取，且至少 2 条', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ role: 'user', text: `第${index}条` }))
  const messages = buildSourceMessages(many, { sessionId: 's', limit: 3 })
  assert.equal(messages.length, 3)
  assert.equal(messages.at(-1).content, '第9条')
})

test('buildImportContent：可被 JSON.parse 回读，persona/session 正确', () => {
  const messages = buildSourceMessages(turns, { sessionId: 'dsh-rp:nicai' })
  const content = buildImportContent({
    messages,
    personaName: 'nicai',
    sessionId: 'dsh-rp:nicai',
    storyId: '冰神湖'
  })
  const parsed = JSON.parse(content)
  assert.equal(parsed.format, 'livingmemory')
  assert.equal(parsed.schema_version, 1)
  assert.equal(parsed.memories.length, 1)
  assert.equal(parsed.memories[0].persona_id, 'nicai')
  assert.equal(parsed.memories[0].session_id, 'dsh-rp:nicai')
  assert.equal(parsed.memories[0].metadata.source, 'dsh-lm-bridge')
  assert.equal(parsed.memories[0].metadata.story_id, '冰神湖')
  assert.equal(parsed.memories[0].messages.length, 2)
})

test('formatImportReport：dry run 明确说“未落库”并给出两道闸门提示', () => {
  const report = formatImportReport(
    { dry_run: true, total: 1, valid_count: 1, invalid_count: 0, summary_required_count: 1, duplicate_count: 0, planned_import_count: 1 },
    true
  )
  assert.ok(report.includes('未落库'))
  assert.ok(report.includes('confirm'))
  assert.ok(report.includes('需要 LLM 总结：1'))
})

test('formatImportReport：正式写入报告含新 id', () => {
  const report = formatImportReport({ imported_count: 1, skipped_duplicate_count: 0, failed_count: 0, imported_ids: [321] }, false)
  assert.ok(report.includes('已写入'))
  assert.ok(report.includes('321'))
})

function fakeClient(impl) {
  const calls = []
  return {
    calls,
    async importMemories(args) {
      calls.push(args)
      return impl ? impl(args) : { ok: true, status: 200, ms: 10, data: { dry_run: args.dryRun, total: 1, valid_count: 1, summary_required_count: 1 } }
    }
  }
}

const baseConfig = {
  writeEnabled: true,
  writeTurns: 10,
  personaName: 'nicai',
  storylineName: '',
  writeTimeoutMs: 1000
}

test('createWriteAdapter：默认走 dry run', async () => {
  const client = fakeClient()
  const adapter = createWriteAdapter({ client, config: baseConfig, sessionId: 'dsh-rp:nicai' })
  const result = await adapter.submit({ turns })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(client.calls[0].dryRun, true, '必须以后端 dry_run 调用')
  assert.ok(result.report.includes('未落库'))
})

test('createWriteAdapter：dryRun=false 缺 confirm 时拒绝且不发请求', async () => {
  const client = fakeClient()
  const adapter = createWriteAdapter({ client, config: baseConfig, sessionId: 'dsh-rp:nicai' })
  const result = await adapter.submit({ turns, dryRun: false })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'confirm-required')
  assert.equal(client.calls.length, 0, '拒绝时绝不能碰接口')
})

test('createWriteAdapter：dryRun=false + confirm=true 才真正写入', async () => {
  const client = fakeClient(() => ({ ok: true, status: 200, ms: 30, data: { imported_count: 1, imported_ids: [9] } }))
  const adapter = createWriteAdapter({ client, config: baseConfig, sessionId: 'dsh-rp:nicai' })
  const result = await adapter.submit({ turns, dryRun: false, confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, false)
  assert.equal(client.calls[0].dryRun, false)
  assert.ok(result.report.includes('已写入'))
})

test('createWriteAdapter：消息不足 2 条时不提交', async () => {
  const client = fakeClient()
  const adapter = createWriteAdapter({ client, config: baseConfig, sessionId: 's' })
  const result = await adapter.submit({ turns: [{ role: 'user', text: '只有一句' }] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'too-few-messages')
  assert.equal(client.calls.length, 0)
})

test('createWriteAdapter：writeEnabled=false 时直接拒绝', async () => {
  const client = fakeClient()
  const adapter = createWriteAdapter({ client, config: { ...baseConfig, writeEnabled: false }, sessionId: 's' })
  const result = await adapter.submit({ turns })
  assert.equal(result.code, 'disabled')
  assert.equal(client.calls.length, 0)
})

test('createWriteAdapter：接口失败会归一成 ok=false', async () => {
  const client = fakeClient(() => ({ ok: false, status: 502, ms: 5, code: 'http-502', message: 'bad gateway' }))
  const adapter = createWriteAdapter({ client, config: baseConfig, sessionId: 's' })
  const result = await adapter.submit({ turns })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'http-502')
})
