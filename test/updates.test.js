import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNewer, updateChecker } from '../lib/updates.js'

const NAME = 'albis-aipassport-homework'
const NOTES = [
  { version: '0.3.1', date: '2026-11-20', zh: '### 新功能\n- 新增 A', en: '### New\n- A' },
  { version: '0.3.0', date: '2026-11-12', zh: '- 旧', en: '- old' },
  { version: '0.2.0', date: '2026-11-01', zh: '- 更旧', en: '- older' },
]
const registryDoc = (latest) => ({ 'dist-tags': { latest }, versions: { [latest]: { dist: { tarball: `https://registry.npmjs.org/${NAME}/-/${NAME}-${latest}.tgz` } } } })
const fakeFetch = (latest, calls = []) => async (url) => {
  calls.push(url)
  const body = url.endsWith(`/${NAME}`) ? registryDoc(latest) : { homeworkHelper: { releaseNotes: [...NOTES, { bad: true }] } }
  return { ok: true, json: async () => body }
}
const manager = (bundle) => ({ listBundles: async () => [bundle], registries: async () => ({ registry: 'https://registry.npmjs.org' }) })

test('版本比较', () => {
  assert.equal(isNewer('0.3.1', '0.3.0'), true)
  assert.equal(isNewer('0.10.0', '0.9.9'), true)
  assert.equal(isNewer('0.3.0', '0.3.0'), false)
  assert.equal(isNewer('1.0.0', '1.0.0-beta.1'), true)
})

test('有新版本：给出更新信息和夹在当前版本之后的更新日志', async () => {
  const check = updateChecker({ name: NAME, fetchImpl: fakeFetch('0.3.1'), getManager: () => manager({ name: NAME, version: '0.3.0', installed: true, source: `${NAME}@0.3.0` }) })
  const r = await check()
  assert.equal(r.updates.length, 1)
  assert.deepEqual([r.updates[0].version, r.updates[0].latest], ['0.3.0', '0.3.1'])
  assert.match(r.updates[0].spec, /\.tgz$/)
  assert.deepEqual(r.notes.map((n) => n.version), ['0.3.1'], '只显示比当前新的，不含当前和更旧的，也过滤掉格式不对的')
})

test('已是最新、链接到源码文件夹、没有插件管理器：都不提示更新', async () => {
  const mk = (bundle, latest = '0.3.0', mgr = true) => updateChecker({ name: NAME, fetchImpl: fakeFetch(latest), getManager: () => (mgr ? manager(bundle) : undefined) })
  assert.deepEqual((await mk({ name: NAME, version: '0.3.0', installed: true, source: `${NAME}@0.3.0` })()).updates, [])
  assert.deepEqual((await mk({ name: NAME, version: '0.2.0', installed: true, source: '/Users/x/homework-harness-plugin' }, '0.3.1')()).updates, [])
  assert.deepEqual((await mk({ name: NAME, version: '0.2.0', installed: true, source: `${NAME}@0.2.0` }, '0.3.1', false)()).updates, [])
  assert.deepEqual((await mk({ name: 'other', version: '0.2.0', installed: true, source: 'other@0.2.0' }, '0.3.1')()).updates, [])
})

test('查询结果缓存 30 分钟，refresh 强制重查；网络失败不抛错', async () => {
  const calls = []
  let t = 0
  const check = updateChecker({ name: NAME, now: () => t, fetchImpl: fakeFetch('0.3.1', calls), getManager: () => manager({ name: NAME, version: '0.3.0', installed: true, source: `${NAME}@0.3.0` }) })
  await check(); const first = calls.filter((u) => u.endsWith(`/${NAME}`)).length
  t += 60000; await check()
  assert.equal(calls.filter((u) => u.endsWith(`/${NAME}`)).length, first, '30 分钟内不重查')
  await check({ refresh: true })
  assert.equal(calls.filter((u) => u.endsWith(`/${NAME}`)).length, first + 1)
  const down = updateChecker({ name: NAME, fetchImpl: async () => { throw new Error('offline') }, getManager: () => manager({ name: NAME, version: '0.3.0', installed: true, source: `${NAME}@0.3.0` }) })
  assert.deepEqual(await down(), { updates: [], notes: [] })
})
