// DeepSeek 语音合成：请求形状、机器人音效开关、失败提示。
import test from 'node:test'
import assert from 'node:assert/strict'
import { synthesize, ENDPOINT, VOICES } from '../voice/deepseek.js'
import { readWav, wavFromInt16 } from '../lib/util.js'

const SR_TTS = 24000   // DeepSeek 合成返回 24kHz

/** 24k 的 0.4 秒正弦波 WAV，冒充 DeepSeek 的返回。 */
function fakeWav(seconds = 0.4) {
  const n = Math.round(SR_TTS * seconds)
  const i16 = new Int16Array(n)
  for (let i = 0; i < n; i++) i16[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR_TTS) * 7000)
  return wavFromInt16(i16, SR_TTS)
}

async function withFetch(handler, fn) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts) }
  try { return await fn(calls) } finally { globalThis.fetch = real }
}

const wavResponse = () => new Response(fakeWav(), { status: 200, headers: { 'content-type': 'audio/wav' } })

test('把文字发给 DeepSeek，拿回 16k 样本', async () => {
  await withFetch(wavResponse, async (calls) => {
    const out = await synthesize('作业写完了吗', { config: { apiKey: 'sk-test' } })
    assert.ok(out instanceof Float32Array)
    assert.ok(out.length > 4000)                       // 0.4 秒 24k → 16k，样本数明显大于 0
    assert.equal(calls[0].url, ENDPOINT)
    const body = JSON.parse(calls[0].opts.body)
    assert.equal(body.text, '作业写完了吗')
    assert.equal(body.format, 'wav')
    assert.equal(body.voice_id, 'stella')
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-test')
  })
})

test('可选 tide 男声', async () => {
  await withFetch(wavResponse, async (calls) => {
    await synthesize('你好', { config: { apiKey: 'sk-test', deepseekVoiceId: 'tide' } })
    assert.equal(JSON.parse(calls[0].opts.body).voice_id, 'tide')
    assert.deepEqual(VOICES, ['stella', 'tide'])
  })
})

test('robot 开关真的改变了波形', async () => {
  const withRobot = await withFetch(wavResponse, () => synthesize('测试', { config: { apiKey: 'sk-test', deepseekRobot: true } }))
  const plain = await withFetch(wavResponse, () => synthesize('测试', { config: { apiKey: 'sk-test', deepseekRobot: false } }))
  assert.equal(withRobot.length, plain.length)
  let diff = 0
  for (let i = 0; i < plain.length; i++) diff += Math.abs(withRobot[i] - plain[i])
  assert.ok(diff > 100, '开机器人音效后波形应该不一样')
})

test('没有 Key 时不会去请求', async () => {
  await withFetch(wavResponse, async (calls) => {
    await assert.rejects(() => synthesize('你好', { config: {} }), /API Key/)
    assert.equal(calls.length, 0)
  })
})

test('返回的不是完整 WAV 就算失败', async () => {
  const bad = new Response(Buffer.from('half of an audio file'), { status: 200 })
  await withFetch(() => bad, async () => {
    await assert.rejects(() => synthesize('你好', { config: { apiKey: 'sk-test' } }), /音频/)
  })
})

test('400 / 429 翻成人话', async () => {
  for (const [status, word] of [[400, /内容审核/], [429, /稍后再试/]]) {
    await withFetch(() => new Response('{}', { status }), async () => {
      await assert.rejects(() => synthesize('你好', { config: { apiKey: 'sk-test' } }), word)
    })
  }
})

test('返回的 WAV 能被 readWav 读成 16k', async () => {
  await withFetch(wavResponse, async () => {
    const out = await synthesize('你好', { config: { apiKey: 'sk-test', deepseekRobot: false } })
    const wav = readWav(wavFromInt16(Int16Array.from(out, (v) => Math.round(v * 32767))))
    assert.equal(wav.sr, 16000)
  })
})
