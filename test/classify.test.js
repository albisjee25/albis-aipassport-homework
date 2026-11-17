// 手动加作业时学科兜底判断：模型不可用或回复不合法时，靠关键词也要分得对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { guessSubject, pickSubject } from '../lib/classify.js'

test('关键词判学科', () => {
  assert.equal(guessSubject('语文课后预习'), '语文')
  assert.equal(guessSubject('抄写生字词'), '语文')
  assert.equal(guessSubject('背古诗'), '语文')
  assert.equal(guessSubject('练字一页'), '语文')
  assert.equal(guessSubject('口算一页'), '数学')
  assert.equal(guessSubject('数学练习册P34-35'), '数学')
  assert.equal(guessSubject('抄写单词4遍英1遍中'), '英语')
  assert.equal(guessSubject('Unit 3 课文朗读'), '英语')
  assert.equal(guessSubject('整理书包'), '其他')
  assert.equal(guessSubject(''), '其他')
})

test('学科判断先判英语再判数学最后语文', () => {
  assert.equal(guessSubject('英语课文朗读'), '英语')
  assert.equal(guessSubject('数学预习'), '数学')
})

test('模型给了三科就用模型，其余按关键词', () => {
  assert.equal(pickSubject('数学', '语文课后预习'), '数学')
  assert.equal(pickSubject(' 英语 ', '口算'), '英语')
  assert.equal(pickSubject('其他', '语文课后预习'), '语文')
  assert.equal(pickSubject('', '背古诗'), '语文')
  assert.equal(pickSubject(undefined, '整理书包'), '其他')
  assert.equal(pickSubject('语文课', '口算'), '数学')
})
