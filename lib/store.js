// 清单状态和修改规则（对应 relay/store.py）。
// 产品规则写在这里，不靠 AI 提示词：
// * 来自家长截图（source="screenshot"）的作业，孩子只能改时间、标完成；改名、删除都会被拒绝。
// * 孩子口述加的作业（source="voice"）可以改、可以删。
// * minutes_from 记录时长的来源：ai（AI 估的）/ history（按历史学的）/ set（有人指定的）。
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { cut, hex, nowSec, today, writeJson } from './util.js'

export const MIN_MINUTES = 1
export const MAX_MINUTES = 180
export const TITLE_MAX = 32
export const SUBJECTS = ['语文', '数学', '英语', '其他']
export const SOURCES = ['screenshot', 'voice', 'admin']
export const STATUSES = ['todo', 'doing', 'done']
export const MINUTES_FROM = ['ai', 'history', 'set']

export function clampMinutes(value) {
  let m = (value === null || value === undefined || value === '' || typeof value === 'object') ? NaN : Number(value)
  if (!Number.isFinite(m)) m = 20
  m = Math.round(m)
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, m))
}

export function cleanTitle(value) {
  const t = String(value ?? '').split(/\s+/).filter(Boolean).join(' ')
  return cut(t, TITLE_MAX) || '作业'
}

export function cleanSubject(value) {
  const s = String(value ?? '').trim()
  return SUBJECTS.includes(s) ? s : '其他'
}

export function newTask({ title, subject = '其他', minutes = 20, note = '', source = 'admin', category = '', minutes_from = 'ai' } = {}) {
  if (!SOURCES.includes(source)) throw new Error(`bad source ${source}`)
  return {
    id: hex(3), title: cleanTitle(title), subject: cleanSubject(subject), minutes: clampMinutes(minutes),
    note: cut(note, 40), source, status: 'todo', created_at: nowSec(), done_at: null,
    category: cut(category, 12), actual_s: null, minutes_from: MINUTES_FROM.includes(minutes_from) ? minutes_from : 'ai',
  }
}

const ok = (device_action = null) => ({ ok: true, reason: '', device_action })
const fail = (reason) => ({ ok: false, reason, device_action: null })

export class ListState {
  constructor(day, tasks = [], version = 0) {
    this.day = day || today()
    this.tasks = tasks
    this.version = version
  }

  find(id) { return this.tasks.find((t) => t.id === id) ?? null }
  current() { return this.tasks.find((t) => t.status === 'doing') ?? null }
  touch() { this.version += 1 }

  // ---- 通用修改 ----
  add(task) { this.tasks.push(task); this.touch(); return ok() }
  addMany(tasks) { this.tasks.push(...tasks); if (tasks.length) this.touch(); return tasks.length }

  setStatus(id, status) {
    const t = this.find(id)
    if (!t) return fail('没找到这项作业')
    if (!STATUSES.includes(status)) return fail('状态不对')
    if (status === 'doing') for (const o of this.tasks) if (o.status === 'doing' && o !== t) o.status = 'todo'
    t.status = status
    // actual_s 在重新打开后保留：再次完成时累加，已做的时间不会丢。
    t.done_at = status === 'done' ? nowSec() : null
    this.touch()
    return ok()
  }

  /** 设备上点完成，带真实用时（不含暂停）。 */
  finish(id, actualS = null) {
    const r = this.setStatus(id, 'done')
    if (r.ok && typeof actualS === 'number' && actualS > 0) {
      const t = this.find(id)
      t.actual_s = (t.actual_s || 0) + Math.trunc(actualS)
    }
    return r
  }

  allDone() {
    return this.tasks.length > 0 && this.tasks.every((t) => t.status === 'done')
  }

  // ---- 孩子（语音/设备）的修改：规则在这里强制执行 ----
  childUpdate(id, { minutes = null, title = null } = {}) {
    const t = this.find(id)
    if (!t) return fail('没找到这项作业')
    if (title !== null && cleanTitle(title) !== t.title) {
      if (t.source === 'screenshot') return fail('老师布置的作业名字不能改哦')
      t.title = cleanTitle(title)
    }
    if (minutes !== null) { t.minutes = clampMinutes(minutes); t.minutes_from = 'set' }
    this.touch()
    return ok()
  }

  /** 倒计时中说“改成20分钟”：整段倒计时变成这么长。 */
  childSetTimer(minutes) {
    const t = this.current()
    if (!t) return fail('现在没有在计时哦')
    t.minutes = clampMinutes(minutes); t.minutes_from = 'set'
    this.touch()
    return ok({ type: 'set', id: t.id, minutes: t.minutes })
  }

  childDelete(id) {
    const t = this.find(id)
    if (!t) return fail('没找到这项作业')
    if (t.source !== 'voice') return fail('这项要爸爸妈妈在后台删哦')
    this.tasks.splice(this.tasks.indexOf(t), 1)
    this.touch()
    return ok()
  }

  childStart(id) {
    const r = this.setStatus(id, 'doing')
    if (r.ok) { const t = this.find(id); r.device_action = { type: 'start', id: t.id, minutes: t.minutes } }
    return r
  }

  childDone(id) { return this.setStatus(id, 'done') }

  childExtend(minutes) {
    const t = this.current()
    if (!t) return fail('现在没有在计时哦')
    return ok({ type: 'extend', id: t.id, minutes: clampMinutes(minutes) })
  }

  // ---- 家长（后台/对话）的修改 ----
  adminUpdate(id, fields = {}) {
    const t = this.find(id)
    if (!t) return fail('not found')
    if ('title' in fields) t.title = cleanTitle(fields.title)
    if ('minutes' in fields) { t.minutes = clampMinutes(fields.minutes); t.minutes_from = 'set' }
    if ('subject' in fields) t.subject = cleanSubject(fields.subject)
    if ('status' in fields) return this.setStatus(id, fields.status)
    this.touch()
    return ok()
  }

  adminDelete(id) {
    const t = this.find(id)
    if (!t) return fail('not found')
    this.tasks.splice(this.tasks.indexOf(t), 1)
    this.touch()
    return ok()
  }

  adminMove(id, delta) {
    const t = this.find(id)
    if (!t) return fail('not found')
    const i = this.tasks.indexOf(t)
    const j = Math.max(0, Math.min(this.tasks.length - 1, i + delta))
    if (i !== j) { this.tasks.splice(i, 1); this.tasks.splice(j, 0, t); this.touch() }
    return ok()
  }

  /** 设备庆祝完发来“清空”：去掉已完成的作业，期间新加的还没做的留着。返回被去掉的作业。 */
  clearDone() {
    const gone = this.tasks.filter((t) => t.status === 'done')
    this.tasks = this.tasks.filter((t) => t.status !== 'done')
    if (gone.length) this.touch()
    return gone
  }

  adminClear() { this.tasks = []; this.touch(); return ok() }

  // ---- 序列化 ----
  toDict() { return { day: this.day, version: this.version, tasks: this.tasks.map((t) => ({ ...t })) } }

  static fromDict(d) {
    const tasks = (d.tasks || []).map((t) => ({
      id: t.id, title: t.title, subject: t.subject ?? '其他', minutes: t.minutes ?? 20,
      note: t.note ?? '', source: t.source ?? 'admin', status: t.status ?? 'todo', created_at: t.created_at ?? nowSec(),
      done_at: t.done_at ?? null, category: t.category ?? '', actual_s: t.actual_s ?? null, minutes_from: t.minutes_from ?? 'ai',
    }))
    return new ListState(d.day, tasks, Number(d.version || 0))
  }

  /** 大模型能看到的清单（不含时间戳）。 */
  summaryForAi() {
    return this.tasks.map((t) => ({
      id: t.id, title: t.title, subject: t.subject, minutes: t.minutes, status: t.status,
      from: t.source === 'screenshot' ? '老师截图' : t.source === 'voice' ? '孩子口述' : '家长添加',
    }))
  }
}

/** 一批已完成作业的用时汇总（分钟）：计划 = 设定的时长，实际 = 倒计时真正走过的时间。 */
export function summarize(tasks) {
  const timed = tasks.filter((t) => (t.actual_s || 0) > 0)
  return {
    count: tasks.length,
    planned_min: tasks.reduce((a, t) => a + (t.minutes || 0), 0),
    actual_min: Math.round(timed.reduce((a, t) => a + t.actual_s, 0) / 60 * 10) / 10,
    timed_count: timed.length,
  }
}

/** 保存当天清单；日期变了就归档到 history/。 */
export class Store {
  constructor(dataDir) {
    this.dir = dataDir
    mkdirSync(join(dataDir, 'history'), { recursive: true })
    this.path = join(dataDir, 'state.json')
    this.state = this.load()
    this.onArchive = null
  }

  load() {
    if (existsSync(this.path)) {
      try { return ListState.fromDict(JSON.parse(readFileSync(this.path, 'utf8'))) } catch {
        renameSync(this.path, this.path.replace(/\.json$/, `.broken-${Math.floor(nowSec())}.json`))
      }
    }
    return new ListState()
  }

  rollDay(day = today()) {
    if (this.state.day === day) return false
    const old = this.state
    this.archive(old.day, old.tasks)
    this.state = new ListState(day, [], old.version + 1)
    if (old.tasks.length && this.onArchive) this.onArchive(old)
    this.save()
    return true
  }

  /** 追加到当天的历史文件（同一天可以多次做完、多次归档）。 */
  archive(day, tasks) {
    if (!tasks.length) return
    const path = join(this.dir, 'history', `${day}.json`)
    let prev = []
    if (existsSync(path)) { try { prev = JSON.parse(readFileSync(path, 'utf8')).tasks || [] } catch { /* 坏文件当作没有 */ } }
    const ids = new Set(tasks.map((t) => t.id))
    const all = [...prev.filter((t) => !ids.has(t.id)), ...tasks.map((t) => ({ ...t }))]
    writeJson(path, { day, tasks: all, summary: summarize(all.filter((t) => t.status === 'done')) })
  }

  /** 今天已经做完并清空的作业的用时汇总（后台“今日作业”要把它和清单里的合起来看）。 */
  archivedToday() {
    const path = join(this.dir, 'history', `${this.state.day}.json`)
    if (!existsSync(path)) return summarize([])
    try { return summarize((JSON.parse(readFileSync(path, 'utf8')).tasks || []).filter((t) => t.status === 'done')) } catch { return summarize([]) }
  }

  save() { writeJson(this.path, this.state.toDict()) }
}
