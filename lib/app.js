// 作业助手的核心流程（对应 relay/app.py 里和网络无关的部分）：
// 清单、语音一句话的完整处理、截图转清单、用时学习。HTTP 接口（server.js）和对话工具（tools.js）都调用这里，
// 所以网页、设备、对话三条路改清单走的是同一套规则。
import { join } from 'node:path'
import { applyVoiceActions } from './intents.js'
import { convert as cnConvert } from './cn_numbers.js'
import { Durations } from './durations.js'
import { PhraseBook } from './phrases.js'
import { Store, newTask } from './store.js'
import { VoiceLog } from './voicelog.js'

export const DEVICE_TASK_KEYS = ['id', 'title', 'subject', 'minutes', 'optional', 'status']

export class Homework {
  constructor({ dataDir, brain, voice, asr, log = console }) {
    this.dataDir = dataDir
    this.brain = brain
    this.voice = voice
    this.asr = asr
    this.log = log
    this.store = new Store(dataDir)
    this.durations = new Durations(join(dataDir, 'durations.json'))
    this.phrases = new PhraseBook(join(dataDir, 'phrases.json'))
    this.voicelog = new VoiceLog(join(dataDir, 'voice-log'))
    this.classifyChain = Promise.resolve()
    this.store.onArchive = (old) => this.classifyLater(old.day, old.tasks.map((t) => ({ ...t })))
  }

  // ---- 清单 ----
  snapshot() {
    this.store.rollDay()
    return this.store.state.toDict()
  }

  deviceTasks(s = this.snapshot()) {
    return s.tasks.map((t) => Object.fromEntries(DEVICE_TASK_KEYS.map((k) => [k, t[k]])))
  }

  /** 改清单的统一入口：先翻日，改完保存，返回最新快照。 */
  mutate(fn) {
    this.store.rollDay()
    const r = fn(this.store.state)
    this.store.save()
    return r
  }

  // ---- 学习每类作业要做多久 ----
  /** 所有必做作业做完时、以及跨天归档时调用：让 AI 给当天作业归类，再记录真实用时。没有 AI 时用临时类型。 */
  classifyAndRecord(day, tasks) {
    this.classifyChain = this.classifyChain.then(async () => {
      const pending = this.durations.pending(tasks)
      if (!pending.length) return
      let plan = {}
      try { [plan] = await this.brain.classifyDay(pending, this.durations.names()) } catch (e) {
        this.log.warn?.(`[homework] 归类失败，用临时类型：${e.message}`)
      }
      const n = this.durations.applyClassification(day, tasks, plan)
      this.log.info?.(`[homework] 记录了 ${n} 项用时（${day}）`)
    }).catch((e) => this.log.warn?.(`[homework] 用时记录出错：${e.message}`))
    return this.classifyChain
  }

  classifyLater(day, tasks) { void this.classifyAndRecord(day, tasks) }
  learnedMinutes(category) { return this.durations.estimate(category) }
  categories() { return this.durations.names() }

  // ---- 说话 ----
  /** AI 读到的话：不做数字转换的识别文本（页码列表不会粘在一起），先纠错，再把页码转成数字。 */
  prepareHeard(transcript, raw = null) {
    const base = raw || transcript
    return base ? cnConvert(this.phrases.correct(base)) : ''
  }

  /** page 是设备当前页面（list/timer/alert）。后台模拟说话没有页面，正在计时就当计时页。 */
  async handleUtterance(transcript, raw = null, page = null) {
    const t0 = Date.now()
    const heard = this.prepareHeard(transcript, raw)
    let reply, mood, out, llmS = 0
    if (!heard) {
      reply = '没听清，再说一次吧？'; mood = 'confused'
      out = { applied: [], refused: [], device_actions: [], verbatim: false }
    } else {
      this.store.rollDay()
      const state = this.store.state
      const tasks = state.summaryForAi(), cur = state.current()
      const running = cur ? { id: cur.id, title: cur.title } : null
      page ||= cur ? 'timer' : 'list'
      let plan
      try {
        let meta
        ;[plan, meta] = await this.brain.understand(heard, tasks, running, { phrases: this.phrases.promptSection(), page, categories: this.categories() })
        llmS = meta.seconds
      } catch (e) {
        this.log.warn?.(`[homework] understand 失败：${e.message}`)
        plan = { actions: [], reply: '我的大脑连不上网啦，等一下再试', mood: 'worried' }
      }
      out = applyVoiceActions(this.store.state, plan, { heard, page, estimate: (c) => this.learnedMinutes(c) })
      this.store.save()
      reply = out.reply; mood = out.mood
    }
    const t1 = Date.now()
    let audio = null
    try { audio = await this.voice.speak(reply, mood) } catch (e) { this.log.warn?.(`[homework] 合成声音失败：${e.message}`) }
    const snap = this.snapshot()
    return {
      transcript, heard, verbatim: out.verbatim ?? false, reply, mood, audio,
      applied: out.applied, refused: out.refused, device_actions: out.device_actions, version: snap.version,
      timing: { llm: llmS, tts: Math.round((Date.now() - t1) / 10) / 100, total: Math.round((Date.now() - t0) / 10) / 100 },
    }
  }

  // ---- 截图 / 对话里整理好的作业 ----
  /** 把 {title, subject, minutes, optional, note, category} 列表变成清单里的新作业（来源按家长截图算：孩子不能删、不能改名）。 */
  addScreenshotTasks(list, source = 'screenshot') {
    const made = []
    for (const t of list || []) {
      if (!t || typeof t !== 'object' || !t.title) continue
      const learned = this.learnedMinutes(t.category || '')
      // 设备只显示作业名，AI 写进 note 的要求要并回作业名，页码和遍数才到得了孩子那里。
      let title = String(t.title ?? '').trim()
      const note = String(t.note ?? '').trim()
      if (note && !title.includes(note)) title = `${title}，${note}`
      made.push(newTask({
        title, subject: t.subject, minutes: learned || t.minutes || 20, optional: t.optional ?? false, note: '', source,
        category: t.category ?? '', minutes_from: learned ? 'history' : 'ai',
      }))
    }
    this.mutate((s) => s.addMany(made))
    return made
  }

  /** 后台上传的截图：AI 读图 -> 加进清单。 */
  async tasksFromScreenshots(images) {
    const [result, meta] = await this.brain.readScreenshots(images, this.categories())
    const made = this.addScreenshotTasks(result.tasks)
    this.log.info?.(`[homework] 截图：${made.length} 项，${meta.seconds}s`)
    return { added: made.length, summary: result.summary ?? '', seconds: meta.seconds, state: this.snapshot() }
  }

  // ---- 设备事件 ----
  deviceEvent({ event, id, value }) {
    const state = this.store.state
    let r = null
    if (event === 'done') r = state.finish(id, value)
    else if (event === 'minutes') r = Number.isInteger(value) && value > 0 ? state.childUpdate(id, { minutes: value }) : null
    else if (event === 'start' || event === 'stop') r = state.setStatus(id, event === 'start' ? 'doing' : 'todo')
    if (r === null) return { status: 400, error: 'unknown event' }
    this.store.save()
    if (!r.ok) return { status: 404, error: r.reason }
    if (event === 'done' && state.allRequiredDone()) this.classifyLater(state.day, state.tasks.map((t) => ({ ...t })))
    return { status: 200, version: state.version }
  }
}
