import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../lib/migrate.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'hw-mig-'))

test('搬旧数据：设备令牌沿用旧的，即使新目录已经自动生成了新令牌', () => {
  const from = tmp(), to = tmp()
  writeFileSync(join(from, 'state.json'), '{"day":"2026-11-09","version":3,"tasks":[]}')
  writeFileSync(join(from, 'device_token'), 'OLD-TOKEN')
  mkdirSync(join(from, 'history'))
  writeFileSync(join(to, 'device_token'), 'NEW-TOKEN')
  const moved = migrate(from, to)
  assert.ok(moved.includes('state.json') && moved.includes('device_token') && moved.includes('history'))
  assert.equal(readFileSync(join(to, 'device_token'), 'utf8'), 'OLD-TOKEN')
})

test('新目录已有清单就不动；没填来源也不动', () => {
  const from = tmp(), to = tmp()
  writeFileSync(join(from, 'state.json'), 'old'); writeFileSync(join(from, 'device_token'), 'OLD')
  writeFileSync(join(to, 'state.json'), 'new'); writeFileSync(join(to, 'device_token'), 'NEW')
  assert.deepEqual(migrate(from, to), [])
  assert.equal(readFileSync(join(to, 'device_token'), 'utf8'), 'NEW')
  assert.deepEqual(migrate('', to), [])
})
