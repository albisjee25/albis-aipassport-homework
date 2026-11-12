// 端到端：用假的 Harness 上下文启动整个插件，走一遍后台接口、设备接口和对话工具。
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { readWav, floatToInt16, resample } from '../lib/util.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OLD = join(HERE, '..', '..', 'homework-helper')
const PORT = 18787
const base = `http://127.0.0.1:${PORT}`
let tools = {}, cleanup = [], dataDir, token
const sent = []

// 假模型：按提示词判断是哪个任务，返回固定 JSON
function fakeLlm() {
  return {
    listProviders: () => [{ id: 'deepseek-account' }],
    async prepareCall(cfg) {
      return {
        config: cfg,
        async *stream(opts) {
          sent.push(opts)
          let reply
          if (opts.system.includes('作业规划助手')) reply = { tasks: [{ title: '抄写单词4遍', subject: '英语', minutes: 15, optional: false, note: '', category: '英语抄写' }], summary: '一项' }
          else if (opts.system.includes('陪五年级孩子')) reply = { actions: [{ type: 'add', quote: '背古诗', subject: '语文', minutes: 10, minutes_said: false, category: '古诗' }], reply: '记好啦', mood: 'happy' }
          else reply = { assign: [], merge: [] }
          yield { type: 'text-delta', index: 0, text: '```json\n' + JSON.stringify(reply) + '\n```' }
          yield { type: 'finish', reason: 'stop' }
        },
      }
    },
  }
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hw-e2e-'))
  // 用旧版已下载的模型，免得测试时下载 230MB
  const old = join(OLD, 'models', 'sense-voice')
  if (existsSync(old)) { mkdirSync(join(dataDir, 'models'), { recursive: true }); symlinkSync(old, join(dataDir, 'models', 'sense-voice')) }
  const ctx = {
    llm: fakeLlm(),
    tools: { register: (def) => { tools[def.name] = def } },
    effect: (fn) => { const g = fn(); const r = g.next(); cleanup.push(r.value) },
  }
  await apply(ctx, { port: PORT, host: '127.0.0.1', dataDir })
  token = readFileSync(join(dataDir, 'device_token'), 'utf8').trim()
  await new Promise((r) => setTimeout(r, 800))   // 等语音模型加载
})

after(() => { for (const fn of cleanup) fn() })

const api = async (path, opts = {}) => {
  const r = await fetch(base + path, opts)
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer()
  return { status: r.status, body }
}
const post = (path, data, headers = {}) => api(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })

test('后台页面和健康检查', async () => {
  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /作业助手/)
  const h = await api('/api/health')
  assert.equal(h.body.ok, true)
  assert.equal(h.body.voice, 'chirp')
})

test('家长手动加、改、移动、删除', async () => {
  let r = await post('/api/tasks', { title: '数学练习册', subject: '数学', minutes: 25 })
  assert.equal(r.body.tasks.length, 1)
  const id = r.body.tasks[0].id
  r = await api(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 30, evil: 1 }) })
  assert.equal(r.body.tasks[0].minutes, 30)
  r = await api('/api/tasks/nope', { method: 'DELETE' })
  assert.equal(r.status, 404)
  r = await api(`/api/tasks/${id}`, { method: 'DELETE' })
  assert.equal(r.body.tasks.length, 0)
})

test('设备接口必须带令牌', async () => {
  assert.equal((await api('/api/device/list')).status, 401)
  assert.equal((await api('/api/device/list', { headers: { 'X-Device-Token': 'x' } })).status, 401)
  const ok = await api('/api/device/list', { headers: { 'X-Device-Token': token } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.changed, true)
  const same = await api(`/api/device/list?since=${ok.body.version}`, { headers: { 'X-Device-Token': token } })
  assert.equal(same.body.changed, false)
})

test('截图 -> 清单（假模型）', async () => {
  const form = new FormData()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHp0lXwAAAABJRU5ErkJggg==', 'base64')
  form.append('files', new Blob([png], { type: 'image/png' }), 's.png')
  // 假的 ctx 没有 attachments 服务，应该给出清楚的错误而不是崩溃
  const r = await api('/api/screenshots', { method: 'POST', body: form })
  assert.equal(r.status, 502)
  assert.match(r.body.detail, /图片附件/)
})

test('对话工具：加作业、列清单、改、删', async () => {
  const add = await tools.homework_add_tasks.execute({ tasks: [{ name: '抄写单词4遍英1遍中，并背诵', subject: '英语', minutes: 15, category: '英语抄写' }, { name: '预习P28', subject: '语文', minutes: 10 }] })
  assert.match(add, /已加入 2 项/)
  const list = await api('/api/state')
  assert.equal(list.body.tasks[0].source, 'screenshot')
  const id = list.body.tasks[1].id
  assert.match(await tools.homework_edit.execute({ id, minutes: 20 }), /已修改/)
  assert.match(await tools.homework_move.execute({ id, delta: -1 }), /预习P28/)
  assert.match(await tools.homework_list.execute({}), /预习P28/)
  assert.match(await tools.homework_clear.execute({ confirm: false }), /没有清空/)
  assert.match(await tools.homework_status.execute({}), /设备令牌/)
  assert.match(await tools.homework_phrases.execute({ action: 'add', kind: 'term', text: '快乐读书吧', meaning: '课外阅读' }), /快乐读书吧/)
})

test('模拟说话：理解 -> 改清单 -> 机械音', async () => {
  const r = await post('/api/simulate/text', { text: '背古诗' })
  assert.equal(r.body.reply, '记好啦')
  assert.equal(r.body.applied.length, 1)
  assert.ok(r.body.audio)
  const wav = await api(`/api/audio/${r.body.audio}.wav`)
  assert.equal(wav.status, 200)
  assert.ok(readWav(Buffer.from(wav.body)).samples.length > 1000)
  const pcm = await api(`/api/device/audio/${r.body.audio}.pcm`, { headers: { 'X-Device-Token': token } })
  assert.equal(pcm.status, 200)
  assert.ok(pcm.body.byteLength > 2000)
  assert.ok(sent.at(-1).messages[0].content[0].text.includes('孩子说的话：背古诗'))
})

test('设备按住说话：真实录音 -> 本地识别 -> 回复', { skip: !existsSync(join(OLD, 'voice-samples', 'boy', '云希-HD-1原声.wav')) }, async () => {
  const w = readWav(readFileSync(join(OLD, 'voice-samples', 'boy', '云希-HD-1原声.wav')))
  const i16 = floatToInt16(resample(w.samples, w.sr, 16000))
  const r = await api('/api/device/voice', { method: 'POST', headers: { 'X-Device-Token': token, 'X-HW-Page': 'list' }, body: Buffer.from(i16.buffer) })
  assert.equal(r.status, 200)
  assert.match(r.body.transcript, /作业小助手/)
  // 假模型回的“背古诗”不在录音里 -> 规则强制按孩子原话记，回复也换成规则的话
  assert.equal(r.body.reply, '我照你的原话记下啦！')
  assert.ok(r.body.tasks.some((t) => t.title.includes('作业小助手')))
  const turns = await api('/api/voicelog')
  assert.equal(turns.body.turns.length, 1)
})

test('工具参数里不能有 JSON Schema 保留字 title（否则模型接口拒绝）', () => {
  const bad = []
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'title' || k === 'default' || k === 'format') bad.push(`${path}.${k}`)
      walk(v, `${path}.${k}`)
    }
  }
  for (const [n, d] of Object.entries(tools)) walk(d.parameters, n)
  assert.deepEqual(bad, [])
})

test('侧边栏页面用的 /api/info：可跨域读取，不含令牌；/api/setup 才有令牌', async () => {
  const pre = await fetch(base + '/api/info', { method: 'OPTIONS' })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true')
  const r = await fetch(base + '/api/info', { headers: { Origin: 'http://127.0.0.1:3000' } })
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  const raw = await r.text()
  assert.ok(!raw.includes(token), '/api/info 不能泄露设备令牌')
  const info = JSON.parse(raw)
  assert.equal(info.ok, true)
  assert.equal(info.port, PORT)
  assert.ok('asr' in info && 'tasks' in info && Array.isArray(info.lan))
  // 前面的测试里设备请求过（有成功的，也有一次令牌错误的）
  assert.equal(info.device.online, true)
  assert.ok(info.device.requests >= 1 && info.device.rejected >= 1)
  assert.ok(!JSON.stringify(info.device).includes(token))
  const setup = await api('/api/setup')
  assert.equal(setup.body.token, token)
  const other = await fetch(base + '/api/setup')
  assert.equal(other.headers.get('access-control-allow-origin'), null)   // 令牌接口不开放跨域
})

test('后台只接受本机访问的判断依据存在；坏路径返回 404', async () => {
  assert.equal((await api('/api/nope')).status, 404)
  assert.equal((await api('/api/audio/../../etc/passwd.wav')).status, 404)
})

test('新设备配对：没有令牌被拒 → 申请 → 后台允许 → 领到令牌 → 能同步清单', async () => {
  assert.equal((await api('/api/device/list')).status, 401)
  const nonce = 'e2e-nonce-0123456789abc'
  assert.equal((await api('/api/pair/request', { method: 'POST', body: JSON.stringify({ code: '7788', nonce }) })).status, 200)
  const pend = await api('/api/pair/pending')
  assert.deepEqual(pend.body.pending.map((x) => x.code), ['7788'])
  assert.ok(!JSON.stringify(pend.body).includes(nonce), '后台看不到 nonce')
  assert.deepEqual((await api('/api/info')).body.pairing.map((x) => x.code), ['7788'])
  const wait = await api('/api/pair/poll', { method: 'POST', body: JSON.stringify({ nonce }) })
  assert.equal(wait.body.status, 'waiting')
  const H = { 'X-HW-Pair': '1', 'Content-Type': 'application/json' }
  assert.equal((await api('/api/pair/approve', { method: 'POST', body: JSON.stringify({ code: '7788' }) })).status, 403, '没有 X-HW-Pair 不行')
  assert.equal((await api('/api/pair/approve', { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: JSON.stringify({ code: '7788' }) })).status, 403, '普通网站不行')
  const pre = await fetch(base + '/api/pair/approve', { method: 'OPTIONS', headers: { Origin: 'app://harness' } })
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'app://harness')
  assert.equal((await api('/api/pair/approve', { method: 'POST', headers: { ...H, Origin: 'app://harness' }, body: JSON.stringify({ code: '7788' }) })).body.ok, true)
  const got = await api('/api/pair/poll', { method: 'POST', body: JSON.stringify({ nonce }) })
  assert.equal(got.body.status, 'approved')
  const list = await api('/api/device/list', { headers: { 'X-Device-Token': got.body.token } })
  assert.equal(list.status, 200)
})
