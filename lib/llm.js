// 大模型调用：用 Harness 自己的 ctx.llm（用户在 Harness 里登录的 DeepSeek 账号或 API Key），不再需要单独的密钥。
// 三件事：看截图（深度思考，慢但不漏）、理解孩子的话（快速）、每天给做完的作业归类。
// 孩子的话只在这里直接问模型（不给任何工具），不会进入 Harness 的智能体对话，避免被当成操作电脑的指令。
import { CLASSIFY_PROMPT, SCREENSHOT_PROMPT, VOICE_PROMPT } from './prompts.js'

export class LLMError extends Error {}

/** 把提示词里的 {grade} 换成设置里的年级。 */
export const withGrade = (prompt, grade) => prompt.replaceAll('{grade}', grade || '五年级')

const OFF = /^(none|off|minimal|disabled|low)$/i

/** 从模型回复里取出 JSON（容忍 ```json 围栏和前后多余的话）。 */
export function parseJson(text) {
  const s = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const body = fenced ? fenced[1].trim() : s
  try { return JSON.parse(body) } catch { /* 往下找花括号 */ }
  const a = body.indexOf('{'), b = body.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { return JSON.parse(body.slice(a, b + 1)) } catch { /* 下面报错 */ }
  }
  throw new LLMError('模型返回的内容不是 JSON')
}

export class Brain {
  /** @param ctx Cordis 上下文  @param getModel () => ({ provider, model, timeoutSec, grade }) */
  constructor(ctx, getModel, log = console) {
    this.ctx = ctx
    this.getModel = getModel
    this.log = log
  }

  route() {
    const { provider, model } = this.getModel()
    const llm = this.ctx.llm
    let providers = []
    try { providers = llm.listProviders().map((p) => p.id) } catch { /* 没有 listProviders 就用配置的 */ }
    if (providers.length && !providers.includes(provider)) {
      const alt = providers.find((id) => id === 'deepseek-account') ?? providers.find((id) => /deepseek/i.test(id)) ?? providers[0]
      this.log.warn?.(`[homework] 没有名为 ${provider} 的模型提供方，改用 ${alt}`)
      return { provider: alt, model }
    }
    return { provider, model }
  }

  async chat(system, content, { thinking = false } = {}) {
    const ctx = this.ctx
    if (!ctx.llm) throw new LLMError('Harness 的模型服务还没准备好')
    const timeoutMs = (this.getModel().timeoutSec ?? 90) * 1000
    const signal = AbortSignal.timeout(timeoutMs)
    const t0 = Date.now()
    let call
    try {
      call = await ctx.llm.prepareCall({ ...this.route(), maxTokens: thinking ? 16000 : 2000 }, signal, (controls, model) => {
        const efforts = model.reasoning?.efforts ?? []
        if (!efforts.length) return controls
        const pick = thinking
          ? (efforts.find((e) => e.id === 'high') ?? efforts.find((e) => e.id === model.reasoning.defaultEffort) ?? efforts.at(-1))
          : (efforts.find((e) => OFF.test(e.id)) ?? efforts[0])
        return { ...controls, reasoningEffort: pick.id }
      })
    } catch (e) {
      throw new LLMError(`连不上模型：${e.message}`)
    }
    let text = '', usage = {}
    try {
      const options = { ...call.config, system, messages: [{ role: 'user', content }], signal }
      for await (const chunk of call.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage ?? {}
      }
    } catch (e) {
      throw new LLMError(`模型调用失败：${e.message}`)
    }
    return [parseJson(text), { seconds: Math.round((Date.now() - t0) / 100) / 10, usage }]
  }

  /** images: [{ data: Buffer, mime }]。用深度思考，慢一点但不漏项。 */
  async readScreenshots(images, categories = []) {
    const attachments = this.ctx.get?.('attachments') ?? this.ctx.attachments
    if (!attachments) throw new LLMError('这个 Harness 没有开启图片附件功能，无法读截图（可以直接在对话里贴图）')
    let refs
    try {
      refs = await attachments.saveImages(images.map((im, i) => ({ data: im.data, mediaType: im.mime, name: `screenshot-${i + 1}` })))
    } catch (e) {
      throw new LLMError(`截图不能用：${e.message}`)
    }
    const content = [
      ...refs.map((attachment) => ({ type: 'image', attachment })),
      { type: 'text', text: '请提取作业清单。多张图属于同一天的作业，去掉重复项。\n已有作业类型：' + JSON.stringify(categories) },
    ]
    return this.chat(withGrade(SCREENSHOT_PROMPT, this.getModel().grade), content, { thinking: true })
  }

  async understand(heard, tasks, running, { phrases = '', page = 'list', categories = [], thinking = false } = {}) {
    const state = { 设备页面: page === 'list' ? '清单' : '计时', 作业清单: tasks, 正在计时: running, 已有作业类型: categories }
    const system = withGrade(VOICE_PROMPT, this.getModel().grade) + (phrases ? '\n\n' + phrases : '')
    return this.chat(system, [{ type: 'text', text: `当前状态：${JSON.stringify(state)}\n孩子说的话：${heard}` }], { thinking })
  }

  /** 每天一次：把做完的作业归到类型里（并合并重复类型）。 */
  async classifyDay(tasks, categories) {
    const items = tasks.map((t) => ({ id: t.id, 作业: t.title, 学科: t.subject, 临时类型: t.category ?? '' }))
    const text = `今天做完的作业：${JSON.stringify(items)}\n已有作业类型：${JSON.stringify(categories)}`
    return this.chat(CLASSIFY_PROMPT, [{ type: 'text', text }])
  }
}
