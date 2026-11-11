// 家长对清单的修改（网页后台和对话工具共用同一份，对应 app.py 里 /api/tasks 那几个接口）。
import { newTask } from './store.js'

const EDITABLE = ['title', 'minutes', 'subject', 'optional', 'status']

export function adminStore(hw) {
  return {
    add(body) {
      hw.mutate((s) => s.add(newTask({ title: body.title, subject: body.subject, minutes: body.minutes ?? 20, optional: body.optional ?? false, source: 'admin', minutes_from: 'set' })))
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
