import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Durations, roundUp5 } from '../lib/durations.js'
import { applyVoiceActions } from '../lib/intents.js'
import { ListState, newTask } from '../lib/store.js'

const fresh = () => new Durations(join(mkdtempSync(join(tmpdir(), 'hw-')), 'durations.json'))
function doneTask(title, category, seconds, subject = '数学') {
  const t = newTask({ title, subject, minutes: 20, source: 'screenshot', category })
  t.status = 'done'; t.actual_s = seconds
  return t
}

test('需要两条记录，并向上取整到 5 分钟', () => {
  const d = fresh()
  d.applyClassification('2026-11-03', [doneTask('练习册P34-35', '数学练习册', 22 * 60)], {})
  assert.equal(d.estimate('数学练习册'), null)
  d.applyClassification('2026-11-04', [doneTask('练习册P36-37', '数学练习册', 27 * 60)], {})
  assert.equal(d.estimate('数学练习册'), 25)
  assert.equal(roundUp5(26 * 60), 30)
})

test('AI 的归类和合并优先于临时类型', () => {
  const d = fresh()
  d.applyClassification('2026-11-03', [doneTask('抄生字', '抄生字', 600, '语文')], {})
  const t = doneTask('抄写第17课生字词', '抄写词语', 900, '语文')
  d.applyClassification('2026-11-04', [t], { assign: [{ id: t.id, category: '抄写生字词' }], merge: [{ from: '抄生字', into: '抄写生字词' }] })
  assert.equal(d.estimate('抄写生字词'), 15)
  assert.ok(!('抄生字' in d.data.categories))
})

test('每项只记一次，太短的忽略', () => {
  const d = fresh()
  const t = doneTask('口算', '口算', 300), short = doneTask('口算2', '口算', 20)
  d.applyClassification('d', [t, short], {})
  d.applyClassification('d', [t, short], {})
  assert.equal(d.data.categories['口算'].records.length, 1)
})

test('重新读取后仍在', () => {
  const d = fresh()
  d.applyClassification('d', [doneTask('a', '口算', 300), doneTask('b', '口算', 420)], {})
  assert.equal(new Durations(d.path).estimate('口算'), 10)
})

function timerState() {
  const s = new ListState('2026-11-05')
  const math = newTask({ title: '练习册P34-35', subject: '数学', minutes: 25, source: 'screenshot' })
  s.addMany([math])
  return [s, math]
}

test('清单页不能用语音改时间', () => {
  const [s, math] = timerState()
  const out = applyVoiceActions(s, { actions: [{ type: 'update', id: math.id, minutes: 40 }] }, { page: 'list' })
  assert.equal(math.minutes, 25)
  assert.match(out.reply, /按键/)
})

test('计时页可以改正在计时的作业', () => {
  const [s, math] = timerState()
  s.setStatus(math.id, 'doing')
  const out = applyVoiceActions(s, { actions: [{ type: 'set', minutes: 30 }] }, { page: 'timer' })
  assert.deepEqual(out.device_actions, [{ type: 'set', id: math.id, minutes: 30 }])
  assert.deepEqual([math.minutes, math.minutes_from], [30, 'set'])
})

test('update 正在计时的作业会同步倒计时', () => {
  const [s, math] = timerState()
  s.setStatus(math.id, 'doing')
  const out = applyVoiceActions(s, { actions: [{ type: 'update', id: math.id, minutes: 20 }] }, { page: 'timer' })
  assert.equal(out.device_actions[0].type, 'set')
})

test('孩子说的时长优先于历史', () => {
  const [s] = timerState()
  const out = applyVoiceActions(s, { actions: [{ type: 'add', quote: '背古诗', subject: '语文', minutes: 10, minutes_said: true, category: '古诗背诵' }] }, { heard: '背古诗十分钟', estimate: () => 25 })
  const t = s.tasks.at(-1)
  assert.deepEqual([t.minutes, t.minutes_from], [10, 'set'])
  assert.equal(out.applied[0].minutes, 10)
})

test('历史时长替换 AI 的估计', () => {
  const [s] = timerState()
  applyVoiceActions(s, { actions: [{ type: 'add', quote: '背古诗', subject: '语文', minutes: 10, minutes_said: false, category: '古诗背诵' }] }, { heard: '背古诗', estimate: (c) => (c === '古诗背诵' ? 15 : null) })
  const t = s.tasks.at(-1)
  assert.deepEqual([t.minutes, t.minutes_from, t.category], [15, 'history', '古诗背诵'])
})

test('完成保留真实用时，重新打开后累加', () => {
  const [s, math] = timerState()
  s.finish(math.id, 1234)
  assert.equal(math.actual_s, 1234)
  assert.ok(s.allRequiredDone())
  s.setStatus(math.id, 'doing')
  assert.equal(math.actual_s, 1234)
  assert.equal(s.allRequiredDone(), false)
  s.finish(math.id, 300)
  assert.equal(math.actual_s, 1534)
})
