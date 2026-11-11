// 小工具：按“字”截断、本地日期、原子写文件、16kHz 单声道 WAV 读写。
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'

/** 按字（code point）截断，和 Python 的 s[:n] 一致。 */
export function cut(s, n) {
  return Array.from(String(s ?? '')).slice(0, n).join('')
}

export function hex(bytes = 3) {
  return randomBytes(bytes).toString('hex')
}

/** 本地日期 YYYY-MM-DD。 */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function nowSec() {
  return Date.now() / 1000
}

/** 先写临时文件再改名，写到一半断电也不会坏文件。 */
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${hex(4)}.tmp`)
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export function writeJson(path, value) {
  writeFileAtomic(path, JSON.stringify(value, null, 1))
}

export const SR = 16000

/** Int16Array -> 带头的 WAV（16kHz 16bit 单声道）。 */
export function wavFromInt16(samples, sr = SR) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/**
 * 读 WAV（PCM 16bit，任意声道/采样率）-> { samples: Float32Array 单声道, sr }。
 * 其他格式（m4a/mp3 等）返回 null，由调用方决定怎么转。
 */
export function readWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size))
      break
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) return null
  const frames = Math.floor(data.length / 2 / fmt.channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2)
    out[i] = sum / fmt.channels / 32768
  }
  return { samples: out, sr: fmt.sr }
}

/** 线性重采样到 16kHz。 */
export function resample(samples, from, to = SR) {
  if (from === to) return samples
  const n = Math.floor((samples.length * to) / from)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to
    const i0 = Math.floor(x)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * (x - i0)
  }
  return out
}

export function pcm16ToFloat(buf) {
  const n = Math.floor(buf.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

export function floatToInt16(f) {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)))
  return out
}

/** 本机在局域网里的 IPv4 地址（设备要填的服务地址）。 */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  }
  return out
}
