import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Presence } from '../lib/presence.js'

function make() {
  const file = join(mkdtempSync(join(tmpdir(), 'hw-pres-')), 'device.log')
  let t = new Date('2026-11-11T17:00:00').getTime()
  const p = new Presence({ file, log: {}, staleMs: 12000, now: () => t })
  return { p, file, advance: (ms) => { t += ms } }
}

test('第一次请求算连上；超过 12 秒没动静算断开；恢复后再记一条', () => {
  const { p, file, advance } = make()
  assert.equal(p.info().last_seen_s, null)
  p.record('::ffff:192.168.1.80', 200, '/api/device/list')
  assert.equal(p.info().online, true)
  advance(10000); assert.equal(p.info().online, true)
  advance(5000)
  const i = p.info()
  assert.equal(i.online, false)
  assert.equal(i.last_seen_s, 15)
  assert.equal(i.ip, '192.168.1.80')
  p.record('192.168.1.80', 200)
  assert.equal(p.info().online, true)
  const log = readFileSync(file, 'utf8')
  assert.match(log, /设备已连上（192\.168\.1\.80）/)
  assert.match(log, /设备断开：最后一次联系是 17:00:00，来自 192\.168\.1\.80/)
  assert.equal((log.match(/设备已连上/g) || []).length, 2)
})

test('令牌不对：不算在线，计数并每分钟最多记一次', () => {
  const { p, file, advance } = make()
  p.record('192.168.1.80', 401, '/api/device/list')
  p.record('192.168.1.80', 401, '/api/device/list')
  assert.equal(p.info().online, false)
  assert.equal(p.info().rejected, 2)
  advance(61000); p.record('192.168.1.80', 401, '/api/device/list')
  assert.equal((readFileSync(file, 'utf8').match(/令牌不对/g) || []).length, 2)
})
