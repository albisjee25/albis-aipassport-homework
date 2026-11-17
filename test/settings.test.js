// 插件页上的开关存在 dataDir/settings.json：只改传进来的字段，文件对本人是 0600。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsStore } from '../lib/settings.js'

const quiet = { warn: () => {} }

test('还没存过就是空的，不会抛错', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hw-set-')), 'settings.json')
  assert.deepEqual(settingsStore(file, quiet).get(), {})
})

test('只改传入的字段，其它保留', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hw-set-')), 'settings.json')
  const store = settingsStore(file, quiet)
  store.patch({ asrProvider: 'deepseek' })
  store.patch({ speechKey: 'sk-test' })
  assert.deepEqual(store.get(), { asrProvider: 'deepseek', speechKey: 'sk-test' })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { asrProvider: 'deepseek', speechKey: 'sk-test' })
})

test('文件权限是 0600（里面可能有 API Key）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hw-set-')), 'settings.json')
  settingsStore(file, quiet).patch({ speechKey: 'sk-secret' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('文件坏了当没设过，不炸启动', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hw-set-')), 'settings.json')
  writeFileSync(file, '{ 不是 json')
  const store = settingsStore(file, quiet)
  assert.deepEqual(store.get(), {})
  store.patch({ asrProvider: 'sensevoice' })
  assert.deepEqual(store.get(), { asrProvider: 'sensevoice' })
})

test('清空 Key 就是清空（不做 “假装保留”）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hw-set-')), 'settings.json')
  const store = settingsStore(file, quiet)
  store.patch({ speechKey: 'sk-old' })
  store.patch({ speechKey: '' })
  assert.equal(store.get().speechKey, '')
})
