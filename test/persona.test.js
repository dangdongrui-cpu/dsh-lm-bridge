import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readPersonaFromDb, renderPersonaSection } from '../lib/persona.js'

test('renderPersonaSection：默认只给正文', () => {
  const text = renderPersonaSection({ personaId: 'nicai', systemPrompt: '你是nicai。', beginDialogs: ['a', 'b'] })
  assert.equal(text, '你是nicai。')
})

test('renderPersonaSection：打开示例时附语气示范并限量', () => {
  const text = renderPersonaSection(
    { personaId: 'nicai', systemPrompt: '你是nicai。', beginDialogs: ['一', '二', '三', '四'] },
    { includeBeginDialogs: true, maxBeginDialogs: 2 }
  )
  assert.ok(text.includes('语气示范'))
  assert.ok(text.includes('- 一'))
  assert.ok(!text.includes('- 三'))
})

test('renderPersonaSection：空正文返回空串', () => {
  assert.equal(renderPersonaSection({ personaId: 'x', systemPrompt: '   ' }), '')
})

test('readPersonaFromDb：按名字读取，奇数 begin_dialogs 被丢弃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-bridge-'))
  const dbPath = join(dir, 'data_v4.db')
  try {
    const sqlite = await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath)
    db.exec(`CREATE TABLE personas (
      id INTEGER PRIMARY KEY,
      persona_id TEXT,
      system_prompt TEXT,
      begin_dialogs TEXT,
      updated_at TEXT
    )`)
    const insert = db.prepare('INSERT INTO personas (id, persona_id, system_prompt, begin_dialogs, updated_at) VALUES (?,?,?,?,?)')
    insert.run(1, 'nicai', '你是nicai。', JSON.stringify(['a', 'b']), '2026-09-30 13:04:01')
    insert.run(2, '萝莉工人', '标签式', JSON.stringify(['x', 'y', 'z']), '2026-08-16 15:51:26')
    db.close()

    const miaobai = await readPersonaFromDb(dbPath, 'nicai')
    assert.equal(miaobai.personaId, 'nicai')
    assert.equal(miaobai.systemPrompt, '你是nicai。')
    assert.deepEqual(miaobai.beginDialogs, ['a', 'b'])
    assert.equal(miaobai.droppedDialogs, false)
    assert.equal(miaobai.updatedAt, '2026-09-30 13:04:01')

    const worker = await readPersonaFromDb(dbPath, '萝莉工人')
    assert.deepEqual(worker.beginDialogs, [])
    assert.equal(worker.droppedDialogs, true)

    await assert.rejects(() => readPersonaFromDb(dbPath, '不存在'), /没有「不存在」/)
    await assert.rejects(() => readPersonaFromDb(join(dir, 'missing.db'), 'nicai'), /不存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readPersonaFromDb：只读打开时对数据库无副作用（行数不变）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-bridge-ro-'))
  const dbPath = join(dir, 'data_v4.db')
  try {
    const sqlite = await import('node:sqlite')
    const writer = new sqlite.DatabaseSync(dbPath)
    writer.exec('CREATE TABLE personas (id INTEGER PRIMARY KEY, persona_id TEXT, system_prompt TEXT, begin_dialogs TEXT, updated_at TEXT)')
    writer.prepare('INSERT INTO personas VALUES (?,?,?,?,?)').run(1, 'nicai', '正文', '[]', null)
    writer.close()

    await readPersonaFromDb(dbPath, 'nicai')

    const reader = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    const count = reader.prepare('SELECT COUNT(*) AS c FROM personas').get().c
    reader.close()
    assert.equal(count, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
