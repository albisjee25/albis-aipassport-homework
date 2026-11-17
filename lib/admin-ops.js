// 家长对清单的修改（网页后台和对话工具共用同一份，对应 app.py 里 /api/tasks 那几个接口）。
import { newTask } from './store.js'

const EDITABLE = ['title', 'minutes', 'subject', 'status']
const NO_MINUTES = (v) => v === undefined || v === null || v === '' || typeof v === 'object'

/** 家长没自己写学科时，让 AI 判一下学科和作业类型；再顺手用这类作业的历史用时。 */
function resolved(hw, title, body) {
  return (async () => {
    const givenSubject = body.subject
    const needsSubject = !givenSubject || String(givenSubject).trim() === '' || String(givenSubject).trim() === '其他'
    const judged = needsSubject ? await hw.classifyTask(title) : { subject: givenSubject, category: body.category ?? '' }
    const learned = hw.learnedMinutes(judged.category)
    const givenMinutes = NO_MINUTES(body.minutes) ? null : body.minutes
    return {
      subject: judged.subject, category: judged.category,
      minutes: givenMinutes ?? learned ?? 15,
      minutes_from: givenMinutes !== null ? 'set' : learned ? 'history' : 'ai',
    }
  })()
}

export function adminStore(hw) {
  return {
    /** 手动加一项。AI 判学科需要等一下，所以是异步的。 */
    async add(body = {}) {
      const title = String(body.title ?? '').trim()
      const r = await resolved(hw, title, body)
      hw.mutate((s) => s.add(newTask({ title, ...r, source: 'admin' })))
      return hw.snapshot()
    },
    edit(id, body) {
      const fields = Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k)))
      const r = hw.mutate((s) => s.adminUpdate(id, fields))
      return r.ok ? { ok: true, state: hw.snapshot() } : { ok: false, status: 404, reason: r.reason }
    },
    remove(id) {
      const r = hw.mutate((s) => s.adminDelete(id))
      return r.ok ? { ok: true, state: hw.snapshot() } : { ok: false, status: 404, reason: r.reason }
    },
    move(id, body) {
      hw.mutate((s) => s.adminMove(id, Math.trunc(Number(body.delta ?? 0)) || 0))
      return hw.snapshot()
    },
    clear() {
      hw.mutate((s) => s.adminClear())
      return hw.snapshot()
    },
    /** edit/remove 的结果 -> HTTP 响应 */
    respond(res, json, r) {
      if (r.ok) return json(res, 200, r.state)
      return json(res, r.status, { detail: r.reason })
    },
  }
}
