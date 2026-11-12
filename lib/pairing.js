// 设备配对：让社区固件不用写死电脑名和令牌。
//   1. 设备在局域网里广播 "HWH?"，本模块用 UDP 回 "HWH! <端口>"，设备就知道电脑在哪。
//   2. 设备屏幕显示 4 位配对码，并 POST /api/pair/request（带一个只有它自己知道的 nonce）。
//   3. 家长在后台核对配对码后点“允许”。只有这时才给这台设备生成专属令牌。
//   4. 设备用 nonce 来领令牌（只能领一次），之后每次请求带 X-Device-Token。
// 令牌存在数据目录的 devices.json（只有本机能读）。老设备用的 device_token 文件继续有效。
import { createSocket } from 'node:dgram'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DISCOVERY_PORT = 8788
const TTL_MS = 5 * 60 * 1000
const MAX_PENDING = 5

const same = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export class Pairing {
  /** legacyToken：老设备（编译时写死的）令牌；file：devices.json 的路径。 */
  constructor({ file, legacyToken = '', now = Date.now, log = console } = {}) {
    this.file = file
    this.legacy = legacyToken
    this.now = now
    this.log = log
    this.pending = []          // { code, nonce, ip, at, approved?: token }
    this.devices = []          // { id, token, paired_at, ip }
    this.udp = null
    if (file && existsSync(file)) {
      try { this.devices = JSON.parse(readFileSync(file, 'utf8')).devices ?? [] } catch { this.devices = [] }
    }
  }

  save() {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ devices: this.devices }, null, 2))
    try { chmodSync(this.file, 0o600) } catch { /* 非 POSIX 系统 */ }
  }

  /** 请求头里的令牌是不是认识的：老令牌或者配对发过的。 */
  isValidToken(token) {
    const t = String(token ?? '')
    if (!t) return false
    if (this.legacy && same(t, this.legacy)) return true
    return this.devices.some((d) => same(t, d.token))
  }

  prune() {
    const t = this.now()
    this.pending = this.pending.filter((p) => t - p.at < TTL_MS)
  }

  /** 设备发起配对。返回 { ok } 或 { error }。同一个 nonce 重复请求只是刷新。 */
  request({ code, nonce, ip }) {
    if (!/^\d{4}$/.test(String(code))) return { error: 'bad code' }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce))) return { error: 'bad nonce' }
    this.prune()
    const old = this.pending.find((p) => same(p.nonce, nonce))
    if (old) { old.at = this.now(); return { ok: true } }
    if (this.pending.some((p) => p.code === code)) return { error: 'code in use' }   // 让设备换一个码重来
    if (this.pending.length >= MAX_PENDING) return { error: 'too many requests' }
    this.pending.push({ code, nonce, ip: String(ip ?? '').replace(/^::ffff:/, ''), at: this.now() })
    this.log.info?.(`[homework] 有设备请求配对：配对码 ${code}（${ip}）`)
    return { ok: true }
  }

  /** 后台显示用：不含 nonce。 */
  list() {
    this.prune()
    return this.pending.filter((p) => !p.approved).map((p) => ({ code: p.code, ip: p.ip, age_s: Math.round((this.now() - p.at) / 1000) }))
  }

  /** 家长点“允许”：生成这台设备的专属令牌，等设备来领。 */
  approve(code) {
    this.prune()
    const p = this.pending.find((x) => x.code === String(code) && !x.approved)
    if (!p) return false
    p.approved = randomBytes(24).toString('base64url')
    this.devices.push({ id: randomBytes(4).toString('hex'), token: p.approved, paired_at: new Date(this.now()).toISOString(), ip: p.ip })
    this.save()
    this.log.info?.(`[homework] 已允许配对码 ${code} 的设备（${p.ip}）`)
    return true
  }

  deny(code) {
    const n = this.pending.length
    this.pending = this.pending.filter((p) => p.code !== String(code))
    return this.pending.length < n
  }

  /** 设备来领令牌：返回 { status: 'waiting' | 'approved' | 'gone', token? }。令牌只给一次。 */
  poll(nonce) {
    this.prune()
    const i = this.pending.findIndex((p) => same(p.nonce, String(nonce ?? '')))
    if (i < 0) return { status: 'gone' }
    const p = this.pending[i]
    if (!p.approved) return { status: 'waiting' }
    this.pending.splice(i, 1)
    return { status: 'approved', token: p.approved }
  }

  /** 已配对设备的数量（后台展示用；令牌不外露）。 */
  count() { return this.devices.length + (this.legacy ? 1 : 0) }

  /** 监听局域网广播，告诉设备电脑的 HTTP 端口。 */
  startDiscovery(httpPort) {
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    sock.on('message', (msg, rinfo) => {
      if (msg.toString('utf8').trim() !== 'HWH?') return
      sock.send(`HWH! ${httpPort}`, rinfo.port, rinfo.address)
    })
    sock.on('error', (e) => { this.log.warn?.(`[homework] 设备发现没能启动（${e.message}）。新设备配对会找不到电脑`); try { sock.close() } catch { /* 已关 */ } })
    sock.bind(DISCOVERY_PORT, '0.0.0.0')
    sock.unref?.()
    this.udp = sock
    return this
  }

  stop() { try { this.udp?.close() } catch { /* 已关 */ } this.udp = null }
}
