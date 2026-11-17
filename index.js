// AI Passport 作业助手 —— DeepSeek Harness 插件入口。
// 启动一个本机 HTTP 服务（设备和家长网页后台用），并给 Harness 助手注册对话工具。
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Homework } from './lib/app.js'
import { ASR, ensureModel, modelReady } from './lib/asr.js'
import { DeepSeekASR } from './lib/asr-deepseek.js'
import { RoutingASR } from './lib/asr-route.js'
import { createSpeechKey } from './lib/speech-key.js'
import { Brain } from './lib/llm.js'
import { migrate } from './lib/migrate.js'
import { Pairing } from './lib/pairing.js'
import { updateChecker } from './lib/updates.js'
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
  asrProvider: 'deepseek',
  speechKey: '',
  voice: {
    provider: 'deepseek', deepseekVoiceId: 'stella', deepseekRobot: true,
    azureKey: '', azureRegion: '', azureVoice: '', customModule: '',
  },
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
    asrProvider: z.union([z.const('deepseek'), z.const('sensevoice')]).default('deepseek')
      .description('语音识别用哪家：deepseek = DeepSeek 云端（要 API Key，不用下模型）；sensevoice = 本机模型（约 230MB，录音不出这台电脑）'),
    speechKey: z.string().default('').role('secret')
      .description('DeepSeek API Key，语音识别和合成用。留空会依次找 Harness 凭据 DEEPSEEK_API_KEY、环境变量、~/.config/homework-helper/deepseek.key'),
    voice: z.object({
      provider: z.union([z.const('deepseek'), z.const('chirp'), z.const('azure'), z.const('custom')]).default('deepseek').description('机器人的声音：deepseek = DeepSeek 语音合成（默认，要 API Key）；chirp = 机械哔嘟声（不要密钥）；azure = 微软语音（示例）；custom = 自己的文件'),
      deepseekVoiceId: z.union([z.const('stella'), z.const('tide')]).default('stella').description('DeepSeek 声音：stella 是女声，tide 是男声'),
      deepseekRobot: z.boolean().default(true).description('给 DeepSeek 的声音叠加机器人音效，更像小机器人；关掉就是自然语音'),
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

  // 语音识别和合成的 DeepSeek API Key（设置里填的 → Harness 凭据 → 环境变量 → 老 Python 助手留下的文件）
  const speechKey = createSpeechKey(ctx, () => cfg.speechKey, { log: logger })
  await speechKey.refresh()

  const voiceCfg = () => {
    const v = { ...cfg.voice, apiKey: speechKey.current() }
    if (v.provider === 'azure' && (!v.azureKey || !v.azureRegion)) {
      const old = legacyAzure()
      v.azureKey ||= old.azureKey
      v.azureRegion ||= old.azureRegion
    }
    return v
  }

  // 语音识别：默认走 DeepSeek 云端，不用下模型；只有选了 sensevoice 或没有 Key 时才下载本机模型（约 230MB）
  const modelDir = join(dataDir, 'models', 'sense-voice')
  const localAsr = new ASR(modelDir)
  const remoteAsr = new DeepSeekASR(() => speechKey.get(), { log: logger })
  const asr = new RoutingASR({
    local: localAsr, remote: remoteAsr,
    getMode: () => cfg.asrProvider, getKey: () => speechKey.current(), log: logger,
  })
  const state = { asrNote: '' }
  const abort = new AbortController()
  const useLocal = () => cfg.asrProvider === 'sensevoice' || !speechKey.current()
  ;(async () => {
    if (!useLocal()) { logger.info('[homework] 语音识别用 DeepSeek 云端'); return }
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
    localAsr.load()
    state.asrNote = ''
    logger.info('[homework] 语音识别已就绪（本机模型）')
  })().catch((e) => { state.asrNote = e.message; logger.error(`[homework] ${e.message}`) })

  const brain = new Brain(ctx, () => cfg, logger)
  const voice = new Voice(dataDir, voiceCfg, logger)
  const hw = new Homework({ dataDir, brain, voice, asr, log: logger })

  const getInfo = () => ({ port: cfg.port, voice: voice.provider, asr: asr.provider, asrReady: asr.ready(), asrNote: state.asrNote || asr.note() || (asr.ready() ? '' : '启动中') })
  // 插件有没有新版本：从 Harness 的插件管理器看本机装的版本，再去 npm 查最新（只有从插件市场装的才会提示）
  const pkgName = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
  const checkUpdates = updateChecker({ name: pkgName, getManager: () => { try { return ctx.get?.('pluginManager') } catch { return undefined } } })
  const pairing = new Pairing({ file: join(dataDir, 'devices.json'), legacyToken: token, log: logger }).startDiscovery(cfg.port)
  const server = await startServer({
    hw, token, pairing, checkUpdates, port: cfg.port, host: cfg.host, log: logger, getVoiceName: () => voice.provider, getInfo,
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
