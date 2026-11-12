import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ListState, Store, clampMinutes, cleanTitle, newTask } from '../lib/store.js'

function sample() {
  const s = new ListState('2026-11-04')
  const a = newTask({ title: '数学练习册', subject: '数学', minutes: 25, source: 'screenshot' })
  const b = newTask({ title: '读绘本', subject: '其他', minutes: 15, source: 'voice' })
  s.addMany([a, b])
  return [s, a, b]
}

test('孩子不能删截图作业', () => {
  const [s, a] = sample()
  const r = s.childDelete(a.id)
  assert.equal(r.ok, false)
  assert.match(r.reason, /后台/)
  assert.ok(s.find(a.id))
})

test('孩子可以删自己口述的作业', () => {
  const [s, , b] = sample()
  assert.ok(s.childDelete(b.id).ok)
  assert.equal(s.find(b.id), null)
})

test('截图作业只能改时间不能改名', () => {
  const [s, a] = sample()
  assert.ok(s.childUpdate(a.id, { minutes: 15 }).ok)
  assert.equal(s.find(a.id).minutes, 15)
  assert.equal(s.childUpdate(a.id, { title: '不做了' }).ok, false)
  assert.equal(s.find(a.id).title, '数学练习册')
  assert.ok(s.childUpdate(a.id, { title: '数学练习册', minutes: 20 }).ok)
})

test('孩子可以改自己作业的名字', () => {
  const [s, , b] = sample()
  assert.ok(s.childUpdate(b.id, { title: '读科普书' }).ok)
  assert.equal(s.find(b.id).title, '读科普书')
})

test('家长可以删任何作业', () => {
  const [s, a] = sample()
  assert.ok(s.adminDelete(a.id).ok)
  assert.equal(s.find(a.id), null)
})

test('开始是互斥的，并返回设备动作', () => {
  const [s, a, b] = sample()
  assert.deepEqual(s.childStart(a.id).device_action, { type: 'start', id: a.id, minutes: 25 })
  s.childStart(b.id)
  assert.equal(s.find(a.id).status, 'todo')
  assert.equal(s.current().id, b.id)
})

test('加时间需要有正在计时的作业', () => {
  const [s, a] = sample()
  assert.equal(s.childExtend(5).ok, false)
  s.childStart(a.id)
  assert.deepEqual(s.childExtend(5).device_action, { type: 'extend', id: a.id, minutes: 5 })
})

test('完成会记录时间', () => {
  const [s, a] = sample()
  s.childDone(a.id)
  assert.equal(s.find(a.id).status, 'done')
  assert.notEqual(s.find(a.id).done_at, null)
})

test('未知 id 被拒绝', () => {
  const [s] = sample()
  for (const r of [s.childDelete('nope'), s.childUpdate('nope', { minutes: 3 }), s.childStart('nope')]) assert.equal(r.ok, false)
})

test('修改会增加版本号；家长可调整顺序', () => {
  const [s, a, b] = sample()
  const v = s.version
  s.childUpdate(a.id, { minutes: 10 })
  assert.equal(s.version, v + 1)
  s.adminMove(b.id, -1)
  assert.deepEqual(s.tasks.map((t) => t.id), [b.id, a.id])
})

test('数据清洗', () => {
  assert.equal(clampMinutes(0), 1)
  assert.equal(clampMinutes(999), 180)
  assert.equal(clampMinutes('12.6'), 13)
  assert.equal(clampMinutes(null), 20)
  assert.equal(cleanTitle('  a   b '), 'a b')
  assert.equal(Array.from(cleanTitle('一'.repeat(50))).length, 32)
  assert.equal(cleanTitle(''), '作业')
  assert.equal(newTask({ title: 'x', subject: '体育' }).subject, '其他')
})

test('保存、重新读取与跨天归档', () => {
  const d = mkdtempSync(join(tmpdir(), 'hw-'))
  const st = new Store(d)
  st.state.day = '2026-11-03'
  st.state.add(newTask({ title: '旧作业', source: 'screenshot' }))
  st.save()
  const st2 = new Store(d)
  assert.equal(st2.state.tasks[0].title, '旧作业')
  assert.ok(st2.rollDay('2026-11-04'))
  assert.deepEqual(st2.state.tasks, [])
  const hist = JSON.parse(readFileSync(join(d, 'history', '2026-11-03.json'), 'utf8'))
  assert.equal(hist.tasks[0].title, '旧作业')
  assert.equal(st2.rollDay('2026-11-04'), false)
})

test('损坏的状态文件会被放到一边', () => {
  const d = mkdtempSync(join(tmpdir(), 'hw-'))
  writeFileSync(join(d, 'state.json'), '{not json')
  const st = new Store(d)
  assert.deepEqual(st.state.tasks, [])
  assert.ok(readdirSync(d).some((n) => n.startsWith('state.broken')))
})

test('清空：已完成的作业存档并清掉，同一天再做完是追加，今日汇总合计两轮', () => {
  const d = mkdtempSync(join(tmpdir(), 'hw-'))
  const st = new Store(d)
  const a = newTask({ title: '数学', minutes: 20 }), c = newTask({ title: '英语', minutes: 10 })
  st.state.add(a)
  st.state.finish(a.id, 1500)
  assert.ok(st.state.allDone())
  st.archive(st.state.day, st.state.tasks.filter((t) => t.status === 'done'))
  assert.deepEqual(st.state.clearDone().map((t) => t.title), ['数学'])
  assert.deepEqual(st.state.tasks, [])
  st.state.add(c)
  st.state.finish(c.id, 300)
  st.archive(st.state.day, st.state.tasks.filter((t) => t.status === 'done'))
  assert.deepEqual(st.archivedToday(), { count: 2, planned_min: 30, actual_min: 30, timed_count: 2 })
})
