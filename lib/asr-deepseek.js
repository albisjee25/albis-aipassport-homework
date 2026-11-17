// DeepSeek 语音识别（云端）：整段音频上传，整段返回文字。
// 接口：POST https://api.deepseek.com/v1/tools/asr，multipart 的 file 字段，WAV（16bit PCM）或 Ogg Opus，
// 最长 120 秒、最大 8MiB，语言自动识别，没有语言参数。
// 设备送来的是 16kHz 16bit 单声道裸 PCM，包一个 WAV 头就能传。
import { createHash } from 'node:crypto'
import { SR, floatToInt16, readWav, resample, wavFromInt16 } from './util.js'
import { afconvert } from './asr.js'

export const ENDPOINT = 'https://api.deepseek.com/v1/tools/asr'
const MAX_SECONDS = 118          // 官方上限 120 秒，留一点余量
const MIN_SECONDS = 0.2          // 不到 0.2 秒当作没说话，不用为此发一次请求
const CACHE_MS = 60_000

class ASRError extends Error {}

/** 裸 PCM（16k 单声道 16bit）包成 WAV，给接口用。 */
const pcmWav = (pcm) => wavFromInt16(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), SR)

export class DeepSeekASR {
  /**
   * @param getKey async () => string   每次识别前取一次 API Key（可能在设置里改）
   * @param options.endpoint / fetchImpl / timeoutMs / log
   */
  constructor(getKey, { endpoint = ENDPOINT, fetchImpl = (...a) => fetch(...a), timeoutMs = 30000, log = console } = {}) {
    this.getKey = getKey
    this.endpoint = endpoint
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.log = log
    this.last = null          // { hash, text }：同一段音频只花一次钱（调用方会连问两次：带/不带数字转换）
    this.inflight = new Map()
  }

  get provider() { return 'deepseek' }

  ready() { return Boolean(this.getKey.cached?.() ?? true) }

  /** 与本地版接口保持一致：模型在云端，不用加载。 */
  load() {}

  async transcribe(pcm) {
    if (!pcm || pcm.length < SR * 2 * MIN_SECONDS) return ''
    if (pcm.length > SR * 2 * MAX_SECONDS) pcm = pcm.subarray(0, SR * 2 * MAX_SECONDS)
    const hash = createHash('sha1').update(pcm).digest('hex')
    if (this.last?.hash === hash && Date.now() - this.last.at < CACHE_MS) return this.last.text
    if (this.inflight.has(hash)) return this.inflight.get(hash)
    const job = (async () => {
      const text = await this.send(pcmWav(pcm), 'speech.wav', 'audio/wav')
      this.last = { hash, text, at: Date.now() }
      return text
    })().finally(() => this.inflight.delete(hash))
    this.inflight.set(hash, job)
    return job
  }

  /** 设备送来的 16kHz 16bit 单声道 PCM。 */
  transcribePcm16(pcm) { return this.transcribe(pcm) }

  /** 同名方法留给调用方：DeepSeek 不做数字转换，两路结果相同，共用一次请求。 */
  transcribePcm16Raw(pcm) { return this.transcribe(pcm) }

  /** 后台上传的录音：WAV / Ogg 直接传，其他格式借 macOS 的 afconvert 转成 WAV。 */
  async transcribeFile(data, filename = '') {
    const isOgg = data.subarray(0, 4).toString('latin1') === 'OggS'
    if (isOgg) return this.send(data, 'speech.ogg', 'audio/ogg')
    let wav = readWav(data)
    if (!wav) wav = readWav(await afconvert(data, filename))
    if (!wav) throw new ASRError('读不了这个录音文件（要 WAV 或 Ogg Opus）')
    const samples = wav.sr === SR ? wav.samples : resample(wav.samples, wav.sr, SR)
    const i16 = floatToInt16(samples)
    return this.transcribe(Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength))
  }

  async send(bytes, filename, mime) {
    const key = await this.getKey()
    if (!key) throw new ASRError('没有 DeepSeek API Key，语音识别用不了（在插件设置里填，或设置 DEEPSEEK_API_KEY）')
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), filename)
    let res
    try {
      res = await this.fetch(this.endpoint, {
        method: 'POST', body: form, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${key}` },
      })
    } catch (e) {
      throw new ASRError(`连不上 DeepSeek 语音识别：${e.message}`)
    }
    const body = await res.text()
    if (!res.ok) throw new ASRError(`DeepSeek 语音识别失败（${res.status}）：${explain(res.status, body)}`)
    try {
      const j = JSON.parse(body)
      return String(j.text ?? '').trim()
    } catch {
      throw new ASRError('DeepSeek 语音识别返回的内容读不懂')
    }
  }
}

function explain(status, body) {
  const table = {
    400: '音频不是 16bit PCM WAV 或 Ogg Opus，或没有 file 字段',
    401: 'API Key 不对或没有语音权限，请在设置里更新',
    402: '账户余额不足',
    408: '上传超时',
    413: '录音太大（上限 8MiB）',
    429: '请求太多，稍后再试',
    503: '服务忙，稍后再试',
    504: '识别超时',
  }
  return table[status] || String(body || '').slice(0, 120)
}

export { ASRError }
