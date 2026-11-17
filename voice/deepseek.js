// 机器人的声音：DeepSeek 语音合成（/v1/tools/tts）。
// 和 voice/azure.js 一样导出 synthesize()：合成器可以返回 WAV Buffer / Float32Array / {samples, sampleRate}，
// lib/voice.js 会统一换成 16kHz 单声道并缓存。
// DeepSeek 只有两个声音：stella（女，默认）、tide（男）；语言按文字自动判断，没有语言参数。
import { robotEffect } from './azure.js'
import { SR, readWav, resample } from '../lib/util.js'

export const ENDPOINT = 'https://api.deepseek.com/v1/tools/tts'
export const VOICES = ['stella', 'tide']

export class TTSError extends Error {}

const explain = (status) => ({
  400: '文字为空或没有通过内容审核',
  401: 'API Key 不对或没有语音权限，请在设置里更新',
  402: '账户余额不足',
  429: '请求太多，稍后再试',
  503: '服务忙，稍后再试',
  504: '合成超时',
}[status] || `HTTP ${status}`)

/**
 * @param text 要说的话
 * @param options.config 插件设置里的 voice 一组（apiKey / deepseekVoiceId / deepseekRobot / endpoint）
 */
export async function synthesize(text, { config = {} } = {}) {
  const key = String(config.apiKey ?? '').trim()
  if (!key) throw new TTSError('没有 DeepSeek API Key，合成不了声音（在插件设置里填，或设置 DEEPSEEK_API_KEY）')
  const voiceId = VOICES.includes(config.deepseekVoiceId) ? config.deepseekVoiceId : 'stella'
  const endpoint = config.endpoint || ENDPOINT
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ text, voice_id: voiceId, format: 'wav' }),
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    throw new TTSError(`连不上 DeepSeek 语音合成：${e.message}`)
  }
  if (!res.ok) throw new TTSError(`DeepSeek 语音合成失败：${explain(res.status)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // 合成中途断掉时响应会被截断：不是 WAV 就当失败，别把半句话播给孩子
  if (buf.length < 1000 || buf.subarray(0, 4).toString('latin1') !== 'RIFF') throw new TTSError('DeepSeek 语音合成没返回完整的音频')
  const robot = config.deepseekRobot ?? true
  const wav = readWav(buf)
  if (!wav) throw new TTSError('DeepSeek 返回的音频读不了（需要 16bit PCM WAV）')
  const samples = resample(wav.samples, wav.sr, SR)
  return robot ? robotEffect(samples, 1) : samples
}
