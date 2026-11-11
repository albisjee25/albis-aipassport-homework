// 示例声音：微软 Azure 语音合成（云夏 HD）+ 本地“机器人”音效（环形调制 + 金属梳状反馈 + 轻微降比特）。
// 想换成别的语音服务：照这个文件的写法，导出同样的 synthesize()，在设置里把 voice.provider 改成 custom 即可（见 voice/README.md）。
import { readWav, resample } from '../lib/util.js'

const SR = 16000
const VOICE = 'zh-CN-Yunxia:DragonHDFlashLatestNeural'
const FALLBACK_VOICE = 'zh-CN-YunxiaNeural'        // HD 声音不可用时用标准声音
const PITCH = '+18%', RATE = '+15%'

/** 环形调制 + 金属梳状反馈（+ 轻微降比特）。strength 0/1/2。 */
export function robotEffect(a, strength = 2) {
  if (strength <= 0 || a.length === 0) return Float32Array.from(a)
  const [mix, delayS, fb, ringHz] = strength === 1 ? [0.22, 0.004, 0.35, 70] : [0.5, 0.006, 0.55, 55]
  const y = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) y[i] = (1 - mix) * a[i] + mix * a[i] * Math.sin((2 * Math.PI * ringHz * i) / SR)
  const d = Math.floor(SR * delayS)
  const z = Float64Array.from(y)
  for (let start = d; start < z.length; start += d) {
    const end = Math.min(start + d, z.length)
    for (let i = start; i < end; i++) z[i] += fb * z[i - d]
  }
  if (strength >= 2) for (let i = 0; i < z.length; i++) z[i] = Math.round(z[i] * 48) / 48
  let peak = 0
  for (const v of z) peak = Math.max(peak, Math.abs(v))
  peak = peak || 1
  const out = new Float32Array(z.length)
  for (let i = 0; i < z.length; i++) out[i] = (z[i] / peak) * 0.9
  return out
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function request(text, voice, key, region) {
  const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">'
    + `<voice name="${voice}"><prosody pitch="${PITCH}" rate="${RATE}">${esc(text)}</prosody></voice></speak>`
  try {
    const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', body: ssml, signal: AbortSignal.timeout(30000),
      headers: {
        'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm', 'User-Agent': 'aipassport-homework-helper',
      },
    })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    return buf.length < 2000 ? null : buf
  } catch { return null }
}

export async function synthesize(text, { config = {} } = {}) {
  const key = config.azureKey, region = config.azureRegion
  if (!key || !region) throw new Error('还没填 Azure 语音的密钥和区域（插件设置里的 voice.azureKey / voice.azureRegion）')
  let raw = await request(text, config.azureVoice || VOICE, key, region)
  if (!raw && !config.azureVoice) raw = await request(text, FALLBACK_VOICE, key, region)
  if (!raw) throw new Error('微软语音合成失败（检查密钥、区域和网络）')
  const wav = readWav(raw)
  if (!wav) throw new Error('微软语音合成返回了读不了的音频')
  return { samples: robotEffect(resample(wav.samples, wav.sr, SR), 2), sampleRate: SR }
}
