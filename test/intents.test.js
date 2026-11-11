import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyVoiceActions, cleanQuote } from '../lib/intents.js'
import { ListState, newTask } from '../lib/store.js'
import { PhraseBook } from '../lib/phrases.js'

function state() {
  const s = new ListState('2026-11-04')
  const math = newTask({ title: '数学练习册', subject: '数学', minutes: 25, source: 'screenshot' })
  const read = newTask({ title: '读绘本', subject: '其他', minutes: 15, source: 'voice' })
  s.addMany([math, read])
  return [s, math, read]
}

test('模型绕不过删除规则', () => {
  const [s, math] = state()
  const out = applyVoiceActions(s, { actions: [{ type: 'delete', id: math.id }], reply: '好的，删掉啦', mood: 'happy' })
  assert.ok(s.find(math.id))
  assert.deepEqual(out.applied, [])
  assert.match(out.reply, /后台/)
  assert.equal(out.mood, 'worried')
})

test('添加并开始', () => {
  const [s, math] = state()
  const out = applyVoiceActions(s, { actions: [{ type: 'add', title: '背古诗', subject: '语文', minutes: 10 }, { type: 'start', id: math.id }], reply: '开始做数学！', mood: 'happy' })
  assert.equal(s.tasks.length, 3)
  assert.equal(s.tasks.at(-1).source, 'voice')
  assert.deepEqual(out.device_actions, [{ type: 'start', id: math.id, minutes: 25 }])
  assert.equal(out.reply, '开始做数学！')
})

test('没在计时就加时间会被拒绝', () => {
  const [s] = state()
  const out = applyVoiceActions(s, { actions: [{ type: 'extend', minutes: 5 }] }, { page: 'timer' })
  assert.deepEqual(out.device_actions, [])
  assert.match(out.reply, /没有在计时/)
})

test('乱七八糟的计划无害', () => {
  const [s] = state()
  const before = s.version
  for (const plan of [{}, { actions: 'x' }, { actions: [1, null, { type: 'hack' }] }, { mood: 'evil' }]) {
    const out = applyVoiceActions(s, plan)
    assert.deepEqual(out.applied, [])
    assert.ok(['confused', 'happy'].includes(out.mood))
  }
  assert.equal(s.version, before)
})

test('回复会被截断到 30 字', () => {
  const [s] = state()
  assert.equal(Array.from(applyVoiceActions(s, { actions: [], reply: '啊'.repeat(100), mood: 'hello' }).reply).length, 30)
})

const HEARD = '复习83、84、85和第9页的关于月份的单词'

test('模型改写原话时按孩子原话记', () => {
  const s = new ListState('2026-11-05')
  const out = applyVoiceActions(s, { actions: [{ type: 'add', quote: '背83-85页的单词', subject: '英语', minutes: 15 }], reply: '记好啦', mood: 'happy' }, { heard: HEARD })
  assert.ok(out.verbatim)
  assert.equal(s.tasks[0].title, HEARD)
  assert.equal(s.tasks[0].subject, '英语')
})

test('丢了页码也回退到原话', () => {
  const s = new ListState('2026-11-05')
  const out = applyVoiceActions(s, { actions: [{ type: 'add', quote: '复习83、84、85', subject: '英语' }] }, { heard: HEARD })
  assert.ok(out.verbatim)
  assert.ok(s.tasks[0].title.includes('第9页'))
})

test('忠实的拆分保持不变', () => {
  const s = new ListState('2026-11-05')
  const out = applyVoiceActions(s, { actions: [{ type: 'add', quote: '抄写书本25页', subject: '英语', minutes: 10 }, { type: 'add', quote: '活动1、2英译中', subject: '英语', minutes: 10 }], reply: '好' }, { heard: '英语作业抄写书本25页，活动1、2英译中' })
  assert.equal(out.verbatim, false)
  assert.deepEqual(s.tasks.map((t) => t.title), ['抄写书本25页', '活动1、2英译中'])
})

test('只去引导语，不改中间的字', () => {
  assert.equal(cleanQuote('今天的作业有第三单元练习。'), '第三单元练习')
  assert.equal(cleanQuote('英语作业抄写书本25页'), '抄写书本25页')
  assert.equal(cleanQuote('复习第9页吧'), '复习第9页')
})

test('短语库：纠错与术语', () => {
  const book = new PhraseBook(join(mkdtempSync(join(tmpdir(), 'hw-')), 'p.json'))
  assert.equal(book.correct('活动一两音一中'), '活动一两英译中')
  assert.equal(book.correct('今天的作业有第三元练习'), '今天的作业有第三单元练习')
  assert.equal(book.correct('写单元练习'), '写单元练习')
  book.add('fix', '课课练', ['可可练', '颗颗练'])
  assert.equal(book.correct('做可可练第五页'), '做课课练第五页')
  assert.ok(book.promptSection().includes('家默'))
  assert.throws(() => book.add('fix', '听写', []))
})
