// 本地语音识别：SenseVoice-Small（sherpa-onnx）。录音不出这台电脑。
// 首次使用自动下载模型（约 230MB）到数据目录；国内镜像优先。
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SR, pcm16ToFloat, readWav, resample } from './util.js'

const REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const FILES = [
  { name: 'model.int8.onnx', minBytes: 200e6 },
  { name: 'tokens.txt', minBytes: 1e5 },
]
const HOSTS = ['https://hf-mirror.com', 'https://huggingface.co']

export const modelReady = (dir) => FILES.every((f) => existsSync(join(dir, f.name)) && statSync(join(dir, f.name)).size >= f.minBytes)

async function download(url, dest, minBytes, onProgress, signal) {
  const res = await fetch(url, { signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  const part = `${dest}.part`
  let got = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => { got += c.length; onProgress?.(got, total) })
  await pipeline(body, createWriteStream(part))
  if (statSync(part).size < minBytes) { rmSync(part, { force: true }); throw new Error('下载的文件太小，可能不完整') }
  renameSync(part, dest)
}

/** 确保模型文件在 dir；缺了就依次从各镜像下载。 */
export async function ensureModel(dir, { log = console, signal } = {}) {
  if (modelReady(dir)) return
  mkdirSync(dir, { recursive: true })
  for (const f of FILES) {
    const dest = join(dir, f.name)
    if (existsSync(dest) && statSync(dest).size >= f.minBytes) continue
    let lastErr
    for (const host of HOSTS) {
      const url = `${host}/${REPO}/resolve/main/${f.name}`
      try {
        let last = 0
        log.info?.(`[homework] 下载语音模型 ${f.name}：${url}`)
        await download(url, dest, f.minBytes, (got, total) => {
          if (got - last > 20e6) { last = got; log.info?.(`[homework] 已下载 ${(got / 1e6).toFixed(0)}MB${total ? ` / ${(total / 1e6).toFixed(0)}MB` : ''}`) }
        }, signal)
        lastErr = null
        break
      } catch (e) { lastErr = e; log.warn?.(`[homework] ${host} 下载失败：${e.message}`) }
    }
    if (lastErr) throw new Error(`语音模型下载失败（${f.name}）：${lastErr.message}。可手动把 model.int8.onnx 和 tokens.txt 放进 ${dir}`)
  }
}

function afconvert(data, filename) {
  const d = mkdtempSync(join(tmpdir(), 'hw-asr-'))
  const ext = (/\.[A-Za-z0-9]+$/.exec(filename || '') || ['.m4a'])[0]
  const src = join(d, `in${ext}`), dst = join(d, 'out.wav')
  writeFileSync(src, data)
  return new Promise((resolve, reject) => {
    execFile('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SR}`, '-c', '1', src, dst], { timeout: 60000 }, (err) => {
      try {
        if (err) return reject(new Error('读不了这种录音格式，请换成 wav（或在 Mac 上用 m4a）'))
        resolve(readFileSync(dst))
      } finally { rmSync(d, { recursive: true, force: true }) }
    })
  })
}

export class ASR {
  constructor(modelDir) {
    this.modelDir = modelDir
    this.sherpa = null
    this.rec = null
    this.recRaw = null
  }

  load() {
    if (this.rec) return
    if (!modelReady(this.modelDir)) throw new Error('语音模型还没下载好')
    this.sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
    this.rec = this.make(true)
  }

  make(itn) {
    return new this.sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: join(this.modelDir, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: itn ? 1 : 0 },
        tokens: join(this.modelDir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
      },
    })
  }

  decode(rec, samples, sr) {
    if (samples.length < sr * 0.2) return ''            // 不到 0.2 秒：没说话
    const s = rec.createStream()
    s.acceptWaveform({ sampleRate: sr, samples })
    rec.decode(s)
    return String(rec.getResult(s).text || '').trim()
  }

  /** 设备送来的 16kHz 16bit 单声道原始 PCM。 */
  transcribePcm16(pcm) {
    this.load()
    return this.decode(this.rec, pcm16ToFloat(pcm), SR)
  }

  /** 同一段音频，不做数字转换：数字保持中文（用来对比页码“二十六二十七”和“2627”）。 */
  transcribePcm16Raw(pcm) {
    this.load()
    this.recRaw ??= this.make(false)
    return this.decode(this.recRaw, pcm16ToFloat(pcm), SR)
  }

  /** 后台上传的录音文件：wav 直接读，其他格式借 macOS 的 afconvert。 */
  async transcribeFile(data, filename = '') {
    this.load()
    let wav = readWav(data)
    if (!wav) wav = readWav(await afconvert(data, filename))
    if (!wav) throw new Error('读不了这个录音文件')
    return this.decode(this.rec, resample(wav.samples, wav.sr, SR), SR)
  }
}

