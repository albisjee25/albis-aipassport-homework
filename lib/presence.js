// 设备在线记录：设备每 3 秒来问一次清单，超过 staleMs 没动静就算断开。
// 状态变化（第一次连上 / 断开 / 恢复 / 令牌不对）写进数据目录的 device.log，事后能查“什么时候断的、最后一次来自哪个地址”。
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8)
const stamp = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hhmmss(ms)}` }

export class Presence {
  constructor({ file, log = console, staleMs = 12000, now = Date.now } = {}) {
    this.file = file
    this.log = log
    this.staleMs = staleMs
    this.now = now
    this.online = false
    this.lastAt = null
    this.lastIp = ''
    this.okCount = 0
    this.rejected = 0
    this.lastRejectLog = 0
    this.timer = null
    if (file) mkdirSync(dirname(file), { recursive: true })
  }

  line(msg) {
    const text = `${stamp(this.now())} ${msg}`
    this.log.info?.(`[homework] ${msg}`)
    if (this.file) { try { appendFileSync(this.file, text + '\n') } catch { /* 记录失败不影响服务 */ } }
  }

  /** 设备的一次请求完成后调用：status 是返回给设备的 HTTP 状态码。 */
  record(ip, status, path = '') {
    const t = this.now()
    ip = String(ip ?? '').replace(/^::ffff:/, '')
    if (status === 401) {
      this.rejected += 1
      if (t - this.lastRejectLog > 60000) { this.lastRejectLog = t; this.line(`设备 ${ip} 的令牌不对，被拒绝（${path}）`) }
      return
    }
    if (status >= 400) return
    this.okCount += 1
    this.lastAt = t
    this.lastIp = ip
    if (!this.online) { this.online = true; this.line(`设备已连上（${ip}）`) }
  }

  /** 定时检查：在线但太久没动静 -> 记一条断开。 */
  check() {
    if (this.online && this.now() - this.lastAt > this.staleMs) {
      this.online = false
      this.line(`设备断开：最后一次联系是 ${hhmmss(this.lastAt)}，来自 ${this.lastIp}`)
    }
  }

  start() { this.timer = setInterval(() => this.check(), 3000); this.timer.unref?.(); return this }
  stop() { clearInterval(this.timer) }

  info() {
    this.check()
    return {
      online: this.online,
      last_seen_s: this.lastAt === null ? null : Math.round((this.now() - this.lastAt) / 1000),
      last_seen_at: this.lastAt === null ? null : hhmmss(this.lastAt),
      ip: this.lastIp, requests: this.okCount, rejected: this.rejected,
    }
  }
}
