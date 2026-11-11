// AI Passport 作业助手 —— DeepSeek Harness 插件入口。
// 启动一个本机 HTTP 服务（设备和家长网页后台用），并给 Harness 助手注册对话工具。
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Homework } from './lib/app.js'
import { ASR, ensureModel, modelReady } from './lib/asr.js'
import { Brain } from './lib/llm.js'
import { migrate } from './lib/migrate.js'
import { startServer } from './lib/server.js'
import { registerTools } from './lib/tools.js'
import { Voice } from './lib/voice.js'

export const name = 'homework-helper'
export const inject = ['llm', 'tools']

export const DEFAULTS = {
  port: 8787,
  host: '0.0.0.0',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  timeoutSec: 90,
  grade: '五年级',
  dataDir: '',
  migrateFrom: '',
  voice: { provider: 'chirp', azureKey: '', azureRegion: '', azureVoice: '', customModule: '' },
}

// 设置页的字段说明。在 Harness 外（单元测试）取不到 schemastery 时没有 Config，不影响运行。
export let Config
try {
  const { default: z } = await import('@deepseek-ai/schemastery')
  Config = z.object({
    port: z.number().default(DEFAULTS.port).description('服务端口。设备固件里写的是 8787，一般不用改'),
    host: z.string().default(DEFAULTS.host).description('监听地址。0.0.0.0 让同一 Wi-Fi 下的设备能连；只在本机用可填 127.0.0.1'),
    provider: z.string().default(DEFAULTS.provider).description('模型提供方，默认用 Harness 里登录的 DeepSeek 账号'),
    model: z.string().default(DEFAULTS.model).description('模型。要看截图，必须选支持图片的模型'),
    grade: z.string().default(DEFAULTS.grade).description('孩子的年级，如“三年级”。用来估作业时长、调整机器人说话的方式'),
    timeoutSec: z.number().default(DEFAULTS.timeoutSec).description('一次模型调用最多等多少秒'),
    dataDir: z.string().default('').description('数据目录，留空用 ~/.dsh/homework-helper'),
    migrateFrom: z.string().default('').description('从旧版 Python 作业助手搬数据：填它的 data 目录。只在新目录还没有数据时搬一次'),
    voice: z.object({
      provider: z.union([z.const('chirp'), z.const('azure'), z.const('custom')]).default('chirp').description('机器人的声音：chirp = 机械哔嘟声（默认，不要密钥）；azure = 微软语音（示例）；custom = 自己的文件'),
      azureKey: z.string().default('').role('secret').description('Azure 语音密钥（provider 为 azure 时）'),
      azureRegion: z.string().default('').description('Azure 区域，如 eastasia'),
      azureVoice: z.string().default('').description('Azure 声音名，留空用云夏 HD'),
      customModule: z.string().default('').description('自定义声音文件的绝对路径，写法见 voice/README.md'),
    }).description('机器人声音'),
  })
} catch { Config = undefined }

const logger = {
  info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m),
}

function deviceToken(dataDir) {
  const p = join(dataDir, 'device_token')
  if (!existsSync(p)) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(p, randomBytes(18).toString('base64url'))
    chmodSync(p, 0o600)
  }
  return readFileSync(p, 'utf8').trim()
}

/** 老用户把 Azure 密钥存在 ~/.config/homework-helper/ 里，设置里没填时顺手读一下。 */
function legacyAzure() {
  const read = (n) => { try { return readFileSync(join(homedir(), '.config', 'homework-helper', n), 'utf8').trim() } catch { return '' } }
  return { azureKey: read('azure.key'), azureRegion: read('azure.region') }
}

export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config, voice: { ...DEFAULTS.voice, ...(config.voice ?? {}) } }
  const dataDir = cfg.dataDir || join(homedir(), '.dsh', 'homework-helper')
  mkdirSync(dataDir, { recursive: true })

  const moved = migrate(cfg.migrateFrom, dataDir)
  if (moved.length) logger.info(`[homework] 已从旧版搬来：${moved.join('、')}`)
  const token = deviceToken(dataDir)

  const voiceCfg = () => {
    const v = { ...cfg.voice }
    if (v.provider === 'azure' && (!v.azureKey || !v.azureRegion)) {
      const old = legacyAzure()
      v.azureKey ||= old.azureKey
      v.azureRegion ||= old.azureRegion
    }
    return v
  }

  // 语音识别模型：旧版目录里有就直接复制过来，没有就后台下载（约 230MB，下载期间设备说话会提示稍等）
  const modelDir = join(dataDir, 'models', 'sense-voice')
  const asr = new ASR(modelDir)
  const state = { asrNote: '' }
  const abort = new AbortController()
  ;(async () => {
    if (!modelReady(modelDir) && cfg.migrateFrom) {
      const old = join(cfg.migrateFrom, '..', 'models', 'sense-voice')
      if (modelReady(old)) {
        const { cpSync } = await import('node:fs')
        cpSync(old, modelDir, { recursive: true })
        logger.info('[homework] 已复制旧版的语音识别模型')
      }
    }
    state.asrNote = '正在下载语音模型'
    await ensureModel(modelDir, { log: logger, signal: abort.signal })
    asr.load()
    state.asrNote = ''
    logger.info('[homework] 语音识别已就绪')
  })().catch((e) => { state.asrNote = e.message; logger.error(`[homework] ${e.message}`) })

  const brain = new Brain(ctx, () => cfg, logger)
  const voice = new Voice(dataDir, voiceCfg, logger)
  const hw = new Homework({ dataDir, brain, voice, asr, log: logger })

  const getInfo = () => ({ port: cfg.port, voice: voice.provider, asrReady: modelReady(modelDir) && Boolean(asr.rec), asrNote: state.asrNote || '启动中' })
  const server = await startServer({
    hw, token, port: cfg.port, host: cfg.host, log: logger, getVoiceName: () => voice.provider, getInfo,
  })
  logger.info(`[homework] 作业助手已启动：http://127.0.0.1:${cfg.port}（设备令牌见 ${join(dataDir, 'device_token')}）`)

  registerTools(ctx, { hw, token, getInfo, grade: cfg.grade })

  // 插件被停用或重载时关掉服务、停掉下载
  ctx.effect(function* () {
    yield () => {
      abort.abort()
      server.closeAllConnections?.()
      server.close()
    }
  }, 'homework-helper.server')
}
