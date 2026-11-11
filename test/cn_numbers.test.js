import test from 'node:test'
import assert from 'node:assert/strict'
import { convert, numbersIn, splitRun } from '../lib/cn_numbers.js'

test('列表数字保持分开', () => {
  assert.deepEqual(splitRun('八十二八十三八十四'), [82, 83, 84])
  assert.deepEqual(splitRun('二十六二十七二十八'), [26, 27, 28])
  assert.deepEqual(splitRun('八十四九'), [84, 9])
  assert.deepEqual(splitRun('十五'), [15])
  assert.deepEqual(splitRun('十'), [10])
  assert.deepEqual(splitRun('一百零五'), [105])
  assert.deepEqual(splitRun('一百二十三'), [123])
  assert.deepEqual(splitRun('二三'), [2, 3])
})

test('真实识别文字', () => {
  assert.equal(convert('复习八十三八十四八十五和第九页的关于月份的单词'), '复习83、84、85和第9页的关于月份的单词')
  assert.equal(convert('书本二十六二十七二十八页写上中文'), '书本26、27、28页写上中文')
  assert.equal(convert('抄写书本二十五页'), '抄写书本25页')
  assert.equal(convert('第四单元练习'), '第四单元练习')
  assert.equal(convert('活动一两英译中'), '活动1、2英译中')
})

test('日常用语不动', () => {
  for (const s of ['读一下', '一起背', '一点点', '看一看', '写三遍']) assert.equal(convert(s), s, s)
})

test('单个页码与 numbersIn', () => {
  assert.equal(convert('第九页'), '第9页')
  assert.deepEqual(numbersIn('复习83、84、85和第9页'), ['83', '84', '85', '9'])
})
