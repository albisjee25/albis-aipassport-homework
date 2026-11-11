// 学习每类作业平时要做多久（对应 relay/durations.py）。
// 作业类型由 AI 归类：加作业时先给一个临时类型，每天由 AI 统一整理、合并近似类型后再记录真实用时。
// 某类型至少 MIN_RECORDS 条记录后，新作业的时长 = 最近 RECENT 条的平均值，向上取整到 5 分钟。
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { cut, writeJson } from './util.js'

export const MIN_RECORDS = 2
export const RECENT = 5
export const MIN_ACTUAL_S = 60     // 少于 1 分钟是误按，不算
export const MAX_RECORDS = 30
export const NAME_MAX = 12

export const cleanCategory = (name) => cut(String(name ?? '').split(/\s+/).filter(Boolean).join(' '), NAME_MAX)
export const roundUp5 = (seconds) => Math.max(5, Math.ceil(seconds / 60 / 5) * 5)
const mean = (recs) => recs.reduce((s, r) => s + r.actual_s, 0) / recs.length

export class Durations {
  constructor(path) {
    this.path = path
    this.data = { categories: {}, recorded_ids: [] }
    if (existsSync(path)) {
      try { Object.assign(this.data, JSON.parse(readFileSync(path, 'utf8'))) } catch {
        renameSync(path, path.replace(/\.json$/, '.broken.json'))
      }
    }
  }

  /** 给 AI 看的已有类型。 */
  names() {
    return Object.entries(this.data.categories).map(([n, c]) => ({ 类型: n, 学科: c.subject ?? '其他', 次数: (c.records ?? []).length }))
  }

  estimate(category) {
    const recs = this.data.categories[cleanCategory(category)]?.records ?? []
    if (recs.length < MIN_RECORDS) return null
    return roundUp5(mean(recs.slice(-RECENT)))
  }

  /** 后台“用时记录”页：每类一行，次数多的在前。 */
  overview() {
    const rows = []
    for (const [n, c] of Object.entries(this.data.categories)) {
      const recs = c.records ?? []
      if (!recs.length) continue
      const recent = recs.slice(-RECENT)
      rows.push({
        category: n, subject: c.subject ?? '其他', count: recs.length,
        avg_min: Math.round(mean(recent) / 60 * 10) / 10, estimate: this.estimate(n),
        recent: [...recent].reverse().map((r) => ({ day: r.day, title: r.title, min: Math.round(r.actual_s / 60) })),
      })
    }
    return rows.sort((a, b) => b.count - a.count)
  }

  /** 已完成、有真实用时、还没记录过的作业。 */
  pending(tasks) {
    const done = new Set(this.data.recorded_ids)
    return tasks.filter((t) => t.status === 'done' && (t.actual_s || 0) >= MIN_ACTUAL_S && !done.has(t.id))
  }

  /** plan = {assign:[{id,category}], merge:[{from,into}]}，来自 AI。先合并，再把待记录作业记到各类型下。返回新增条数。 */
  applyClassification(day, tasks, plan = {}) {
    const cats = this.data.categories
    for (const m of plan.merge || []) {
      const src = cleanCategory(m?.from), dst = cleanCategory(m?.into)
      if (src && dst && src !== dst && src in cats) {
        const into = (cats[dst] ??= { subject: cats[src].subject ?? '其他', records: [] })
        const moved = cats[src].records ?? []
        delete cats[src]
        into.records = [...into.records, ...moved].slice(-MAX_RECORDS)
      }
    }
    const chosen = new Map()
    for (const a of plan.assign || []) if (a && typeof a === 'object') chosen.set(a.id, cleanCategory(a.category))
    let added = 0
    for (const t of this.pending(tasks)) {
      const name = chosen.get(t.id) || cleanCategory(t.category)
      if (!name) continue
      const c = (cats[name] ??= { subject: t.subject ?? '其他', records: [] })
      c.records = [...c.records, { day, title: t.title, actual_s: Math.trunc(t.actual_s) }].slice(-MAX_RECORDS)
      this.data.recorded_ids = [...this.data.recorded_ids, t.id].slice(-500)
      added += 1
    }
    this.save()
    return added
  }

  save() { writeJson(this.path, this.data) }
}
