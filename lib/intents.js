// 把大模型“建议”的动作变成经过规则检查的清单修改（对应 relay/intents.py）。
// 模型只负责建议，每个动作都要经过 ListState 的 child* 方法；被拒绝时，用规则自己的解释替换回复，孩子能听到原因。
import { numbersIn } from './cn_numbers.js'
import { TITLE_MAX, newTask } from './store.js'
import { cut } from './util.js'

export const MOODS = ['hello', 'happy', 'worried', 'thinking', 'confused']
export const REPLY_MAX = 30
const LEAD = /^(今天的?作业(有|是)?|作业(有|是)?|还有|然后|另外|(语文|数学|英语)作业(有|是)?)[，,：:、 ]*/
const TAIL = /[。！？!?，,、；;\s]*(吧|啦|了|呀|哦|嗯)?[。！？!?，,、；;\s]*$/
const PUNCT = /[\s，,。.、；;：:！!？?“”"'（）()]/g

const norm = (t) => String(t ?? '').replace(PUNCT, '')

/** 去掉开头的引导语和结尾的语气词，中间的字一个不动。 */
export function cleanQuote(q) {
  q = String(q ?? '').trim()
  for (let i = 0; i < 3; i++) {
    const q2 = q.replace(LEAD, '')
    if (q2 === q) break
    q = q2
  }
  return q.replace(TAIL, '').trim()
}

/** 每条 quote 必须出自孩子说的话，而且不能丢页码。 */
export function checkAdds(adds, heard) {
  const h = norm(heard)
  for (const a of adds) {
    const q = norm(a.quote || a.title || '')
    if (!q || !h.includes(q)) return false
  }
  const said = new Set(numbersIn(heard))
  const kept = new Set(adds.flatMap((a) => numbersIn(a.quote || a.title || '')))
  for (const n of said) if (!kept.has(n)) return false
  return true
}

const TIME_KINDS = ['update', 'extend', 'set']
export const LIST_TIME_REASON = '改时间要用按键哦'
const isObj = (a) => a !== null && typeof a === 'object' && !Array.isArray(a)

/**
 * page 是孩子说话时设备所在的页面：清单页不能用语音改时间（分不清改哪项，要用按键），
 * 计时页/到点页可以。estimate(category) 返回学到的分钟数或 null。
 */
export function applyVoiceActions(state, plan, { heard = null, page = 'list', estimate = null } = {}) {
  let actions = Array.isArray(plan.actions) ? plan.actions : []
  const applied = [], refused = [], deviceActions = []
  let verbatim = false
  const adds = actions.filter((a) => isObj(a) && a.type === 'add')
  if (heard && adds.length && !checkAdds(adds, heard)) {
    // 模型改写或漏掉了内容：按孩子的原话记。
    const subject = adds.find((a) => a.subject)?.subject ?? '其他'
    const minutes = Math.max(0, ...adds.map((a) => a.minutes || 0)) || 20
    const others = actions.filter((a) => !(isObj(a) && a.type === 'add'))
    actions = [{
      type: 'add', quote: cut(cleanQuote(heard), TITLE_MAX), subject, minutes, category: adds[0].category ?? '',
      minutes_said: adds.some((a) => a.minutes_said),
    }, ...others]
    verbatim = true
  }

  for (let a of actions.slice(0, 6)) {
    if (!isObj(a)) continue
    const kind = a.type
    if (TIME_KINDS.includes(kind) && page === 'list') { refused.push({ ...a, reason: LIST_TIME_REASON }); continue }
    let r = null
    if (kind === 'add') {
      const title = cleanQuote(a.quote || a.title || '')
      if (!title) continue
      let minutes = a.minutes ?? 20, source = 'ai'
      let learned
      if (a.minutes_said) source = 'set'
      else if (estimate && (learned = estimate(a.category || ''))) { minutes = learned; source = 'history' }
      const t = newTask({ title, subject: a.subject, minutes, source: 'voice', category: a.category ?? '', minutes_from: source })
      state.add(t)
      a = { ...a, id: t.id, minutes: t.minutes, minutes_from: source }
    } else if (kind === 'update') {
      const cur = state.current()
      if (cur && a.id === cur.id && a.minutes && !a.title) r = state.childSetTimer(a.minutes)
      else r = state.childUpdate(a.id, { minutes: a.minutes ?? null, title: a.title ?? null })
    } else if (kind === 'start') r = state.childStart(a.id)
    else if (kind === 'extend') r = state.childExtend(a.minutes ?? 5)
    else if (kind === 'set') r = state.childSetTimer(a.minutes)
    else if (kind === 'done') r = state.childDone(a.id)
    else if (kind === 'delete') r = state.childDelete(a.id)
    else continue
    if (r === null || r.ok) {
      applied.push(a)
      if (r && r.device_action) deviceActions.push(r.device_action)
    } else refused.push({ ...a, reason: r.reason })
  }

  let reply = String(plan.reply ?? '').trim()
  let mood = MOODS.includes(plan.mood) ? plan.mood : 'happy'
  if (refused.length) { reply = refused[0].reason; mood = 'worried' }
  if (verbatim && !refused.length) { reply = '我照你的原话记下啦！'; mood = 'happy' }
  if (!reply) {
    reply = applied.length ? '收到啦！' : '没听懂，再说一次吧？'
    mood = applied.length ? 'happy' : 'confused'
  }
  return { applied, refused, device_actions: deviceActions, verbatim, reply: cut(reply, REPLY_MAX), mood }
}
