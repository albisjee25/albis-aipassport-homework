// 在本机保留最近几次设备语音（录音 + 识别结果 + 录音质量），家长可以回听（对应 relay/voicelog.py）。
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SR, pcm16ToFloat, wavFromInt16, writeJson } from './util.js'

export const KEEP = 30
const db = (x) => Math.round(20 * Math.log10(Math.max(x, 1e-6)) * 10) / 10
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))]

export function audioQuality(pcm) {
  const a = pcm16ToFloat(pcm)
  if (!a.length) return { seconds: 0, peak_db: null, rms_db: null, noise_db: null, clipped_pct: 0, verdict: '空录音' }
  const frame = 320
  const rmsList = []
  const n = Math.max(1, Math.floor(a.length / frame))
  for (let f = 0; f < n; f++) {
    const end = a.length >= frame ? (f + 1) * frame : a.length
    let s = 0
    for (let i = f * frame; i < end; i++) s += a[i] * a[i]
    rmsList.push(Math.sqrt(s / (end - f * frame)))
  }
  rmsList.sort((x, y) => x - y)
  let peak = 0, sum = 0, clipped = 0
  for (const v of a) { const m = Math.abs(v); if (m > peak) peak = m; sum += v * v; if (m > 0.98) clipped++ }
  const rms = Math.sqrt(sum / a.length)
  const noise = percentile(rmsList, 10), speech = percentile(rmsList, 90)
  const clippedPct = (clipped / a.length) * 100
  const snr = db(speech) - db(noise)
  let verdict = '录音正常'
  if (db(speech) < -35) verdict = '声音太小（离设备远或说话轻）'
  else if (clippedPct > 0.5) verdict = '有爆音（离得太近或太大声）'
  else if (snr < 15) verdict = '杂音偏大'
  return {
    seconds: Math.round((a.length / SR) * 10) / 10, peak_db: db(peak), rms_db: db(rms), speech_db: db(speech),
    noise_db: db(noise), snr_db: Math.round(snr * 10) / 10, clipped_pct: Math.round(clippedPct * 100) / 100, verdict,
  }
}

const stamp = (d = new Date()) => {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

export class VoiceLog {
  constructor(folder) {
    this.dir = folder
    mkdirSync(folder, { recursive: true })
  }

  add(pcm, info) {
    const d = new Date()
    const id = stamp(d)
    const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length - (pcm.length % 2))))
    writeFileSync(join(this.dir, `${id}.wav`), wavFromInt16(samples))
    const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`
    writeJson(join(this.dir, `${id}.json`), { id, time, quality: audioQuality(pcm), ...info })
    this.trim()
    return id
  }

  jsonFiles() { return readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort() }

  trim() {
    for (const f of this.jsonFiles().slice(0, -KEEP)) {
      unlinkSync(join(this.dir, f))
      try { unlinkSync(join(this.dir, f.replace(/\.json$/, '.wav'))) } catch { /* 已不存在 */ }
    }
  }

  recent(n = KEEP) {
    const out = []
    for (const f of this.jsonFiles().reverse().slice(0, n)) {
      try { out.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8'))) } catch { /* 跳过坏文件 */ }
    }
    return out
  }

  wavPath(id) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return null
    const p = join(this.dir, `${id}.wav`)
    return existsSync(p) ? p : null
  }
}
