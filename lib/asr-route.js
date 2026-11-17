// 语音识别选谁：默认本机 SenseVoice 模型（录音不出这台电脑）。
// 家长可以显式选 DeepSeek 云端（要 API Key）；选了云端但没填 Key 时退回本机，并在状态里说明原因。
// 两边的接口不一样（本地是同步、云端是异步），这里统一成异步，调用方只认 transcribePcm16 / transcribeFile。
export class RoutingASR {
  /**
   * @param local 本机 ASR（lib/asr.js）
   * @param remote DeepSeek ASR（lib/asr-deepseek.js）
   * @param getMode () => 'deepseek' | 'sensevoice'
   * @param getKey () => string  DeepSeek API Key 的当前值（同步）
   */
  constructor({ local, remote, getMode, getKey, log = console }) {
    this.local = local
    this.remote = remote
    this.getMode = getMode
    this.getKey = getKey
    this.log = log
    this.fallbackNoted = false
  }

  get provider() {
    if (this.getMode() === 'sensevoice') return 'sensevoice'
    return this.getKey() ? 'deepseek' : 'sensevoice'
  }

  /** 云端只要 Key；本地要模型下好。 */
  ready() {
    return this.provider === 'deepseek' ? Boolean(this.getKey()) : Boolean(this.local.rec)
  }

  note() {
    if (this.provider === 'deepseek') return ''
    if (this.getMode() === 'sensevoice') return '用本机语音模型'
    return '选了云端识别但没填 DeepSeek API Key，先用本机模型'
  }

  /** 家长选了云端、但 Key 还没填：界面要指路。 */
  missingKey() { return this.getMode() === 'deepseek' && !this.getKey() }

  load() { return this.local.load() }   // 云端不需要，本地用；没下模型时这里会抛错

  async transcribePcm16(pcm) { return this.run((model) => model.transcribePcm16(pcm)) }

  async transcribePcm16Raw(pcm) { return this.run((model) => model.transcribePcm16Raw(pcm)) }

  async transcribeFile(data, filename) { return this.run((model) => model.transcribeFile(data, filename)) }

  /** 云端失败时，如果本机模型在，就悄悄退回本地识别。 */
  async run(fn) {
    if (this.provider === 'deepseek') {
      try {
        return await fn(this.remote)
      } catch (e) {
        if (!this.local.rec) throw e
        if (!this.fallbackNoted) { this.fallbackNoted = true; this.log.warn?.(`[homework] 云端识别失败，改用本机模型：${e.message}`) }
        return fn(this.local)
      }
    }
    return fn(this.local)
  }
}
