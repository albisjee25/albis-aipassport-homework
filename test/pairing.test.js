import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSocket } from 'node:dgram'
import { Pairing, DISCOVERY_PORT } from '../lib/pairing.js'

const NONCE = 'abcdefghijklmnop1234'
const mk = (o = {}) => new Pairing({ file: join(mkdtempSync(join(tmpdir(), 'hw-pair-')), 'devices.json'), legacyToken: 'old-token', log: {}, ...o })

test('配对：家长允许前领不到令牌，允许后只能领一次', () => {
  const p = mk()
  assert.deepEqual(p.request({ code: '1234', nonce: NONCE, ip: '::ffff:192.168.1.9' }), { ok: true })
  assert.deepEqual(p.list(), [{ code: '1234', ip: '192.168.1.9', age_s: 0 }])
  assert.equal(p.poll(NONCE).status, 'waiting')
  assert.equal(p.approve('9999'), false)
  assert.equal(p.approve('1234'), true)
  const got = p.poll(NONCE)
  assert.equal(got.status, 'approved')
  assert.ok(got.token.length >= 20)
  assert.equal(p.isValidToken(got.token), true)
  assert.equal(p.poll(NONCE).status, 'gone', '令牌只给一次')
  assert.equal(p.list().length, 0)
})

test('配对：别人猜不到 nonce 就领不到；拒绝后设备拿到 gone', () => {
  const p = mk()
  p.request({ code: '1111', nonce: NONCE, ip: '10.0.0.2' })
  p.approve('1111')
  assert.equal(p.poll('zzzzzzzzzzzzzzzz9999').status, 'gone')
  const q = mk()
  q.request({ code: '2222', nonce: NONCE, ip: '10.0.0.2' })
  assert.equal(q.deny('2222'), true)
  assert.equal(q.poll(NONCE).status, 'gone')
})

test('配对：参数不合法、码重复、请求太多、5 分钟过期', () => {
  let t = 1000
  const p = mk({ now: () => t })
  assert.ok(p.request({ code: '12', nonce: NONCE }).error)
  assert.ok(p.request({ code: '1234', nonce: 'short' }).error)
  assert.deepEqual(p.request({ code: '1234', nonce: NONCE }), { ok: true })
  assert.deepEqual(p.request({ code: '1234', nonce: NONCE }), { ok: true }, '同一设备重发只是刷新')
  assert.equal(p.request({ code: '1234', nonce: 'other-nonce-123456' }).error, 'code in use')
  for (let i = 0; i < 4; i++) p.request({ code: String(2000 + i), nonce: `n-${i}-abcdefghijklmn` })
  assert.equal(p.request({ code: '3000', nonce: 'n-x-abcdefghijklmnopq' }).error, 'too many requests')
  t += 5 * 60 * 1000 + 1
  assert.equal(p.list().length, 0)
  assert.equal(p.poll(NONCE).status, 'gone')
})

test('令牌：老令牌继续有效，空的和错的被拒；配对过的设备重启后仍有效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-pair-'))
  const file = join(dir, 'devices.json')
  const p = new Pairing({ file, legacyToken: 'old-token', log: {} })
  assert.equal(p.isValidToken('old-token'), true)
  assert.equal(p.isValidToken(''), false)
  assert.equal(p.isValidToken(undefined), false)
  assert.equal(p.isValidToken('wrong'), false)
  p.request({ code: '4321', nonce: NONCE }); p.approve('4321')
  const token = p.poll(NONCE).token
  const again = new Pairing({ file, legacyToken: 'old-token', log: {} })
  assert.equal(again.isValidToken(token), true)
})

test('设备发现：回应 HWH? 广播并告诉设备 HTTP 端口', async () => {
  const p = mk().startDiscovery(8787)
  await new Promise((r) => setTimeout(r, 100))
  let bound = true; try { p.udp.address() } catch { bound = false }
  if (!bound) return p.stop()   // 端口被占用（本机正在跑真实服务）时跳过
  const c = createSocket('udp4')
  const reply = await new Promise((resolve) => {
    c.on('message', (m) => resolve(m.toString()))
    c.send('HWH?', DISCOVERY_PORT, '127.0.0.1')
    setTimeout(() => resolve(''), 1500)
  })
  c.close(); p.stop()
  assert.equal(reply, 'HWH! 8787')
})
