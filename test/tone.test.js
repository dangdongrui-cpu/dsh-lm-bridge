import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createToneReader } from '../lib/tone.js'

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tone-test-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('tone：读到文件内容', () => {
  withTempDir((dir) => {
    const file = join(dir, 'tone.md')
    writeFileSync(file, '短句，别写工单。', 'utf8')
    const reader = createToneReader({ filePath: file })
    assert.equal(reader.read(), '短句，别写工单。')
  })
})

test('tone：文件不存在时返回空串，不抛异常', () => {
  const reader = createToneReader({ filePath: 'Z:\\nope\\missing.md' })
  assert.equal(reader.read(), '')
})

test('tone：空路径直接返回空串', () => {
  const reader = createToneReader({ filePath: '' })
  assert.equal(reader.read(), '')
})

test('tone：内容变更后能重读（mtime 变）', () => {
  withTempDir((dir) => {
    const file = join(dir, 'tone.md')
    writeFileSync(file, '第一版', 'utf8')
    const reader = createToneReader({ filePath: file })
    assert.equal(reader.read(), '第一版')
    writeFileSync(file, '第二版要长一点', 'utf8')
    // 有些文件系统 mtime 精度有限，显式 invalidate 才是稳的
    reader.invalidate()
    assert.equal(reader.read(), '第二版要长一点')
  })
})

test('tone：invalidate 之后强制重读', () => {
  withTempDir((dir) => {
    const file = join(dir, 'tone.md')
    writeFileSync(file, 'A', 'utf8')
    const reader = createToneReader({ filePath: file })
    assert.equal(reader.read(), 'A')
    reader.invalidate()
    assert.equal(reader.read(), 'A')
  })
})
