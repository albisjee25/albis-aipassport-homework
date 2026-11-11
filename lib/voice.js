// 机器人的声音：按设置选一个“合成器”（chirp / azure / custom），结果按文字缓存成 16kHz 单声道 WAV。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SR, floatToInt16, readWav, resample, wavFromInt16 } from './util.js'
import * as chirp from '../voice/chirp.js'
import * as azure from '../voice/azure.js'

const CACHE_VERSION = 'v1'

export class Voice {
  /** @param getConfig () => 插件设置里的 voice 那一组 */
  constructor(dataDir, getConfig, log = console) {
    this.dir = join(dataDir, 'tts-cache')
    mkdirSync(this.dir, { recursive: true })
    this.getConfig = getConfig
    this.log = log
    this.inflight = new Map()
  }

  get provider() { return this.getConfig().provider || 'chirp' }

  async module(cfg) {
    if (cfg.provider === 'azure') return azure
    if (cfg.provider === 'custom') {
      if (!cfg.customModule || !existsSync(cfg.customModule)) throw new Error('voice.customModule 没填，或文件不存在')
      return import(`${pathToFileURL(cfg.customModule).href}?v=${statSync(cfg.customModule).mtimeMs}`)
    }
    return chirp
  }

  audioId(text, mood, cfg) {
    const parts = [CACHE_VERSION, cfg.provider, cfg.provider === 'azure' ? `${cfg.azureRegion}|${cfg.azureVoice ?? ''}` : mood,
      cfg.provider === 'custom' ? `${cfg.customModule}|${statSync(cfg.customModule).mtimeMs}` : '', text]
    return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
  }

  pathFor(id) { return join(this.dir, `${id}.wav`) }

  /** 返回音频 id；WAV 在 pathFor(id)。合成失败会抛错，调用方决定怎么办（设备照样显示文字）。 */
  async speak(text, mood = 'happy') {
    text = String(text ?? '').trim()
    const cfg = { ...this.getConfig(), provider: this.provider }
    const id = this.audioId(text, mood, cfg)
    if (existsSync(this.pathFor(id))) return id
    if (this.inflight.has(id)) return this.inflight.get(id)
    const job = (async () => {
      const mod = await this.module(cfg)
      const out = await mod.synthesize(text, { mood, config: cfg })
      writeFileSync(this.pathFor(id), wavFromInt16(floatToInt16(toSamples(out))))
      return id
    })().finally(() => this.inflight.delete(id))
    this.inflight.set(id, job)
    return job
  }

  /** 设备用的无头 16bit PCM。 */
  pcm(id) {
    const wav = readWav(readFileSync(this.pathFor(id)))
    return Buffer.from(floatToInt16(wav.samples).buffer)
  }

  has(id) { return /^[a-z0-9]+$/.test(id) && existsSync(this.pathFor(id)) }
}

/** 合成器可以返回 Float32Array / {samples, sampleRate} / WAV Buffer，统一成 16kHz 单声道。 */
function toSamples(out) {
  if (Buffer.isBuffer(out)) {
    const w = readWav(out)
    if (!w) throw new Error('合成器返回的 WAV 读不了（需要 16bit PCM）')
    return resample(w.samples, w.sr, SR)
  }
  if (out instanceof Float32Array) return out
  if (out?.samples) return resample(Float32Array.from(out.samples), out.sampleRate || SR, SR)
  throw new Error('合成器要返回 Float32Array、{samples, sampleRate} 或 WAV Buffer')
}
