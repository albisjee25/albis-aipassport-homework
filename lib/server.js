// HTTP 接口（对应 relay/app.py 的路由，路径和返回格式不变，设备固件无需改动）。
//   /、/test、/api/*          只接受这台电脑自己的访问（家长后台）
//   /api/device/*             设备用，必须带 X-Device-Token
//   /api/pair/request|poll    新设备配对用，不带令牌（家长在后台点“允许”后才发令牌）
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminStore } from './admin-ops.js'
import { lanAddresses } from './util.js'
import { Presence } from './presence.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_IMAGE = 8 * 1024 * 1024
const MAX_AUDIO = 4 * 1024 * 1024
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status }
}

const json = (res, status, body) => {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length })
  res.end(data)
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new HttpError(413, 'too long')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024)
  if (!buf.length) return {}
  try { return JSON.parse(buf.toString('utf8')) } catch { throw new HttpError(400, '请求内容不是 JSON') }
}

/** 用 Web 标准的 Request 解析 multipart 上传。 */
async function readForm(req, limit) {
  const buf = await readBody(req, limit)
  const headers = new Headers()
  headers.set('content-type', req.headers['content-type'] || '')
  return new Request('http://local/upload', { method: 'POST', headers, body: buf }).formData()
}

export function startServer({ hw, token, pairing, getVoiceName, getInfo, port, host, log = console }) {
  const admin = adminStore(hw)
  const presence = new Presence({ file: join(hw.dataDir, 'device.log'), log }).start()

  const localOnly = (req) => {
    if (!LOCAL.has(req.socket.remoteAddress ?? '')) throw new HttpError(403, '后台只能在这台电脑上打开')
  }
  const deviceOnly = (req) => {
    if (!pairing.isValidToken(req.headers['x-device-token'])) throw new HttpError(401, 'bad device token')
  }

  const sendWav = (res, path) => {
    const data = readFileSync(path)
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length })
    res.end(data)
  }
  const audioId = (id) => { if (!/^[a-z0-9]+$/i.test(id)) throw new HttpError(400, 'bad id'); return id }

  async function route(req, res, url) {
    const m = req.method
    const p = url.pathname
    let g

    // ---- 给 Harness 侧边栏页面看的状态：不含令牌，允许跨域读取（页面和服务不同源） ----
    if (p === '/api/info') {
      localOnly(req)
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' }
      if (m === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
      if (m === 'GET') {
        const s = hw.snapshot()
        const i = getInfo()
        const body = Buffer.from(JSON.stringify({
          ok: true, port: i.port, voice: i.voice, asr: { ready: i.asrReady, note: i.asrNote },
          day: s.day, tasks: { total: s.tasks.length, done: s.tasks.filter((t) => t.status === 'done').length },
          lan: lanAddresses().map((ip) => `http://${ip}:${i.port}`), device: presence.info(), pairing: pairing.list().length,
        }))
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
        return res.end(body)
      }
    }

    // ---- 新设备配对：设备还没有令牌，所以这两个不要令牌（安全靠家长在后台点“允许”）----
    if (m === 'POST' && p === '/api/pair/request') {
      const b = await readJson(req)
      const r = pairing.request({ code: b.code, nonce: b.nonce, ip: req.socket.remoteAddress })
      return json(res, r.error ? 400 : 200, r.error ? { detail: r.error } : r)
    }
    if (m === 'POST' && p === '/api/pair/poll') return json(res, 200, pairing.poll((await readJson(req)).nonce))

    // ---- 页面 ----
    if (m === 'GET' && (p === '/' || p === '/test')) {
      localOnly(req)
      const html = readFileSync(join(HERE, '..', 'admin.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length })
      return res.end(html)
    }

    // ---- 家长后台 ----
    if (p.startsWith('/api/') && !p.startsWith('/api/device/')) {
      localOnly(req)
      if (m === 'GET' && p === '/api/state') return json(res, 200, hw.snapshot())
      if (m === 'GET' && p === '/api/setup') {
        const port = getInfo().port
        return json(res, 200, { token, port, local: `http://127.0.0.1:${port}`, lan: lanAddresses().map((ip) => `http://${ip}:${port}`) })
      }
      if (m === 'GET' && p === '/api/pair/pending') return json(res, 200, { pending: pairing.list(), paired: pairing.count() })
      if (m === 'POST' && p === '/api/pair/approve') return json(res, 200, { ok: pairing.approve((await readJson(req)).code) })
      if (m === 'POST' && p === '/api/pair/deny') return json(res, 200, { ok: pairing.deny((await readJson(req)).code) })
      if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true, voice: getVoiceName(), day: hw.store.state.day, device_token_set: Boolean(token) })

      if (m === 'POST' && p === '/api/screenshots') {
        const form = await readForm(req, 6 * MAX_IMAGE + 1024 * 1024)
        const images = []
        for (const f of form.getAll('files').slice(0, 6)) {
          if (typeof f === 'string') continue
          const data = Buffer.from(await f.arrayBuffer())
          if (data.length > MAX_IMAGE) throw new HttpError(413, `${f.name} 太大了（超过 8MB）`)
          images.push({ data, mime: (f.type || '').startsWith('image/') ? f.type : 'image/png' })
        }
        if (!images.length) throw new HttpError(400, '没有收到图片')
        try { return json(res, 200, await hw.tasksFromScreenshots(images)) } catch (e) { throw new HttpError(502, e.message) }
      }
      if (m === 'POST' && p === '/api/tasks') return json(res, 200, admin.add(await readJson(req)))
      if ((g = /^\/api\/tasks\/([^/]+)$/.exec(p))) {
        if (m === 'PATCH') return admin.respond(res, json, admin.edit(g[1], await readJson(req)))
        if (m === 'DELETE') return admin.respond(res, json, admin.remove(g[1]))
      }
      if (m === 'POST' && (g = /^\/api\/tasks\/([^/]+)\/move$/.exec(p))) return json(res, 200, admin.move(g[1], await readJson(req)))
      if (m === 'POST' && p === '/api/clear') return json(res, 200, admin.clear())

      if (m === 'POST' && p === '/api/simulate/text') {
        const body = await readJson(req)
        return json(res, 200, await hw.handleUtterance(String(body.text ?? '').trim().slice(0, 200)))
      }
      if (m === 'POST' && p === '/api/simulate/audio') {
        const form = await readForm(req, MAX_AUDIO * 4 + 1024 * 1024)
        const f = form.get('file')
        if (!f || typeof f === 'string') throw new HttpError(400, '没有收到录音')
        const t = Date.now()
        let text
        try { text = await hw.asr.transcribeFile(Buffer.from(await f.arrayBuffer()), f.name || '') } catch (e) {
          throw new HttpError(400, `读不了这个录音文件：${e.message}`)
        }
        const out = await hw.handleUtterance(text)
        out.timing.asr = Math.round((Date.now() - t) / 10) / 100 - out.timing.total
        return json(res, 200, out)
      }
      if (m === 'POST' && p === '/api/speak') {
        const body = await readJson(req)
        const text = String(body.text ?? '').trim().slice(0, 60)
        if (!text) throw new HttpError(400, '没有文字')
        return json(res, 200, { audio: await hw.voice.speak(text, body.mood || 'happy') })
      }
      if (m === 'GET' && (g = /^\/api\/audio\/([^/]+)\.wav$/.exec(p))) {
        const id = audioId(g[1])
        if (!hw.voice.has(id)) throw new HttpError(404, 'no audio')
        return sendWav(res, hw.voice.pathFor(id))
      }

      if (m === 'GET' && p === '/api/phrases') return json(res, 200, { items: hw.phrases.all() })
      if (m === 'POST' && p === '/api/phrases') {
        const body = await readJson(req)
        let heard = body.heard || []
        if (typeof heard === 'string') heard = heard.replace(/[，、]/g, ',').split(',')
        try { hw.phrases.add(body.kind ?? 'term', String(body.text ?? ''), heard, String(body.meaning ?? '')) } catch (e) { throw new HttpError(400, e.message) }
        return json(res, 200, { items: hw.phrases.all() })
      }
      if (m === 'DELETE' && (g = /^\/api\/phrases\/([^/]+)$/.exec(p))) {
        hw.phrases.delete(g[1])
        return json(res, 200, { items: hw.phrases.all() })
      }

      if (m === 'GET' && p === '/api/voicelog') return json(res, 200, { turns: hw.voicelog.recent() })
      if (m === 'GET' && (g = /^\/api\/voicelog\/([^/]+)\.wav$/.exec(p))) {
        const wav = hw.voicelog.wavPath(g[1])
        if (!wav) throw new HttpError(404, 'no recording')
        return sendWav(res, wav)
      }
      if (m === 'GET' && p === '/api/durations') return json(res, 200, { categories: hw.durations.overview() })
    }

    // ---- 设备 ----
    if (p.startsWith('/api/device/')) {
      deviceOnly(req)
      if (m === 'GET' && p === '/api/device/list') {
        const s = hw.snapshot()
        const since = url.searchParams.get('since')
        if (since !== null && Number(since) === s.version) return json(res, 200, { version: s.version, changed: false })
        return json(res, 200, { day: s.day, version: s.version, changed: true, tasks: hw.deviceTasks(s) })
      }
      if (m === 'POST' && p === '/api/device/voice') return deviceVoice(req, res)
      if (m === 'POST' && p === '/api/device/event') {
        const r = hw.deviceEvent(await readJson(req))
        if (r.status !== 200) throw new HttpError(r.status, r.error)
        return json(res, 200, { version: r.version })
      }
      if (m === 'GET' && (g = /^\/api\/device\/audio\/([^/]+)\.wav$/.exec(p))) {
        const id = audioId(g[1])
        if (!hw.voice.has(id)) throw new HttpError(404, 'no audio')
        return sendWav(res, hw.voice.pathFor(id))
      }
      if (m === 'GET' && (g = /^\/api\/device\/audio\/([^/]+)\.pcm$/.exec(p))) {
        const id = audioId(g[1])
        if (!hw.voice.has(id)) throw new HttpError(404, 'no audio')
        const pcm = hw.voice.pcm(id)
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': pcm.length })
        return res.end(pcm)
      }
    }
    throw new HttpError(404, 'not found')
  }

  /** 设备按住说话：原始 16kHz 16bit 单声道 PCM（边说边传）。返回回复、设备动作和最新清单。 */
  async function deviceVoice(req, res) {
    const pcm = await readBody(req, MAX_AUDIO)
    const t = Date.now()
    let text, raw
    try {
      text = hw.asr.transcribePcm16(pcm)
      raw = hw.asr.transcribePcm16Raw(pcm)
    } catch (e) {
      log.warn?.(`[homework] 识别失败：${e.message}`)
      throw new HttpError(503, `语音识别还没准备好：${e.message}`)
    }
    const asrS = Math.round((Date.now() - t) / 10) / 100
    const page = String(req.headers['x-hw-page'] ?? 'list')
    const out = await hw.handleUtterance(text, raw, ['list', 'timer', 'alert'].includes(page) ? page : 'list')
    out.timing.asr = asrS
    out.tasks = hw.deviceTasks()
    try {
      hw.voicelog.add(pcm, {
        transcript: text, transcript_raw: raw, heard: out.heard, verbatim: out.verbatim, reply: out.reply,
        applied: out.applied, refused: out.refused, timing: out.timing,
      })
    } catch (e) { log.warn?.(`[homework] 语音记录失败：${e.message}`) }
    log.info?.(`[homework] 设备说话 ${(pcm.length / 32000).toFixed(1)}s：${JSON.stringify(text)} -> ${JSON.stringify(out.reply)} ${JSON.stringify(out.timing)}`)
    // 设备只用到这些，保持 JSON 很小
    const resp = {}
    for (const k of ['transcript', 'reply', 'mood', 'audio', 'device_actions', 'version', 'tasks']) resp[k] = out[k]
    resp.transcript = out.heard || text
    return json(res, 200, resp)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local')
    if (url.pathname.startsWith('/api/device/')) res.on('finish', () => presence.record(req.socket.remoteAddress, res.statusCode, url.pathname))
    route(req, res, url).catch((e) => {
      if (res.headersSent) return res.destroy()
      if (e instanceof HttpError) return json(res, e.status, { detail: e.message })
      log.error?.(`[homework] ${req.method} ${url.pathname} 出错：${e.stack || e.message}`)
      json(res, 500, { detail: `服务出错：${e.message}` })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`端口 ${port} 被占用了。如果旧的 Python 作业助手还开着，先双击“停止作业助手.command”`) : e))
    server.on('close', () => { presence.stop(); pairing.stop() })
    server.listen(port, host, () => resolve(server))
  })
}

