// DeepSeek 云端语音识别：请求形状、缓存（一次音频只花一次钱）、各种失败的提示。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeepSeekASR, ENDPOINT } from '../lib/asr-deepseek.js'
import { SR, readWav, wavFromInt16 } from '../lib/util.js'

/** 造一段 16k 单声道 PCM（一段正弦波，0.5 秒）。 */
function pcm(seconds = 0.5, hz = 440) {
  const n = Math.round(SR * seconds)
  const i16 = new Int16Array(n)
  for (let i = 0; i < n; i++) i16[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / SR) * 8000)
  return Buffer.from(i16.buffer)
}

function stubFetch(handler) {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts, calls.length) }
  return { fetchImpl, calls }
}

const okBody = (text) => new Response(JSON.stringify({ request_id: 'r', text, duration_ms: 500 }), { status: 200, headers: { 'content-type': 'application/json' } })

test('把设备 PCM 包成 WAV 传到 DeepSeek，取回文字', async () => {
  const { fetchImpl, calls } = stubFetch(() => okBody('数学还剩两分钟'))
  const asr = new DeepSeekASR(async () => 'sk-test', { fetchImpl })
  assert.equal(await asr.transcribePcm16(pcm()), '数学还剩两分钟')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, ENDPOINT)
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-test')
  const file = calls[0].opts.body.get('file')
  const buf = Buffer.from(await file.arrayBuffer())
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF')   // 是 WAV
  const wav = readWav(buf)
  assert.equal(wav.sr, SR)
  assert.ok(wav.samples.length > 1000)
})

test('同一段音频问两次只发一次请求', async () => {
  const { fetchImpl, calls } = stubFetch(() => okBody('背古诗'))
  const asr = new DeepSeekASR(async () => 'sk-test', { fetchImpl })
  const a = pcm()
  const [x, y] = await Promise.all([asr.transcribePcm16(a), asr.transcribePcm16Raw(a)])
  assert.equal(x, '背古诗')
  assert.equal(y, '背古诗')
  assert.equal(calls.length, 1)
  // 换一段音频要重新请求
  await asr.transcribePcm16(pcm(0.5, 660))
  assert.equal(calls.length, 2)
})

test('太短的音频不发请求', async () => {
  const { fetchImpl, calls } = stubFetch(() => okBody('不该被调用'))
  const asr = new DeepSeekASR(async () => 'sk-test', { fetchImpl })
  assert.equal(await asr.transcribePcm16(pcm(0.05)), '')
  assert.equal(calls.length, 0)
})

test('没有 Key 时给出可操作的提示', async () => {
  const { fetchImpl, calls } = stubFetch(() => okBody('不会到这里'))
  const asr = new DeepSeekASR(async () => '', { fetchImpl })
  await assert.rejects(() => asr.transcribePcm16(pcm()), /API Key/)
  assert.equal(calls.length, 0)
})

test('401 / 429 / 503 翻成人话', async () => {
  for (const [status, word] of [[401, /API Key/], [429, /稍后再试/], [503, /服务忙/]]) {
    const { fetchImpl } = stubFetch(() => new Response('{"error":"x"}', { status }))
    const asr = new DeepSeekASR(async () => 'sk-test', { fetchImpl })
    await assert.rejects(() => asr.transcribePcm16(pcm()), word)
  }
})

test('后台传 44.1k WAV 会先重采样成 16k', async () => {
  const samples = new Float32Array(44100 * 0.5)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 300 * i) / 44100) * 0.3
  const i16 = Int16Array.from(samples, (v) => Math.round(v * 32767))
  const big = wavFromInt16(i16, 44100)
  const { fetchImpl, calls } = stubFetch(() => okBody('一段录音'))
  const asr = new DeepSeekASR(async () => 'sk-test', { fetchImpl })
  assert.equal(await asr.transcribeFile(big, 'a.wav'), '一段录音')
  const sent = readWav(Buffer.from(await calls[0].opts.body.get('file').arrayBuffer()))
  assert.equal(sent.sr, SR)
})

test('Ogg 音频原样上传，不当成 WAV 去解析', async () => {
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(400, 1)])
  const { fetchImpl, calls } = stubFetch(() => okBody('ogg 也能识别'))
  const asr = new DeepSeekASR(async () => 'sk-test', { fetchImpl })
  assert.equal(await asr.transcribeFile(ogg, 'a.ogg'), 'ogg 也能识别')
  const mime = calls[0].opts.body.get('file').type
  assert.equal(mime, 'audio/ogg')
})
