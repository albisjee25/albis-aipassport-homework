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
import { ASR_MODES, settingsStore } from './lib/settings.js'
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
  asrProvider: 'sensevoice',
  speechKey: '',
  voice: { provider: 'chirp', azureKey: '', azureRegion: '', azureVoice: '', customModule: '' },
}

// 设置页的字段说明。在 Harness 外（单元测试）取不到 schemastery 时没有 Config，不影响运行。
export let Config
let configError = ''
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
    asrProvider: z.union([z.const('sensevoice'), z.const('deepseek')]).default('sensevoice')
      .description('语音识别用哪家：sensevoice = 本机模型（默认，孩子的录音不出这台电脑，第一次要下约 230MB）；deepseek = DeepSeek 云端（识别快、不用下模型，但要填下面的 API Key，录音会上传）'),
    speechKey: z.string().default('').role('secret')
      .description('DeepSeek API Key。只有语音识别选了 deepseek 云端才需要：到 platform.deepseek.com 建一个 API Key 填在这里。留空会找 Harness 凭据 DEEPSEEK_API_KEY 或环境变量'),
    voice: z.object({
      provider: z.union([z.const('chirp'), z.const('azure'), z.const('custom')]).default('chirp').description('机器人的声音：chirp = 机械哔嘟声（默认，不要密钥）；azure = 微软语音（示例）；custom = 自己的文件'),
      azureKey: z.string().default('').role('secret').description('Azure 语音密钥（provider 为 azure 时）'),
      azureRegion: z.string().default('').description('Azure 区域，如 eastasia'),
      azureVoice: z.string().default('').description('Azure 声音名，留空用云夏 HD'),
      customModule: z.string().default('').description('自定义声音文件的绝对路径，写法见 voice/README.md'),
    }).description('机器人声音'),
  })
} catch (e) { Config = undefined; configError = e.message }

const logger = {
  info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m),
}

// 设置表单是 Harness 拿 Config 生成的：没有它，设置页里这个插件就是一片空白。
if (!Config) logger.warn(`[homework] 没能载入设置项（@deepseek-ai/schemastery：${configError}），设置页里将看不到端口、年级、语音识别这些选项`)

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

  // 插件页上的选择（dataDir/settings.json）优先于 Harness 设置页里的默认值 —— 家长在页面上改一次就生效
  const store = settingsStore(join(dataDir, 'settings.json'), logger)
  const asrMode = () => {
    const v = store.get().asrProvider
    return ASR_MODES.includes(v) ? v : cfg.asrProvider
  }
  // 云端语音识别用的 DeepSeek API Key（插件页/设置页填的 → Harness 凭据 → 环境变量）
  // 页面上清空 Key 就是清空，不能又悄悄回落到 Harness 设置里的那个：所以分“没设过”和“设成空”两种
  const speechKey = createSpeechKey(ctx, () => {
    const saved = store.get().speechKey
    return typeof saved === 'string' ? saved : cfg.speechKey
  }, { log: logger })
  await speechKey.refresh()

  const voiceCfg = () => {
    const v = { ...cfg.voice }
    if (v.provider === 'azure' && (!v.azureKey || !v.azureRegion)) {
      const old = legacyAzure()
      v.azureKey ||= old.azureKey
      v.azureRegion ||= old.azureRegion
    }
    return v
  }

  // 语音识别：默认走本机模型（录音不出这台电脑）；只有选了 deepseek 云端且确实有 Key 时才联网
  const modelDir = join(dataDir, 'models', 'sense-voice')
  const localAsr = new ASR(modelDir)
  const remoteAsr = new DeepSeekASR(() => speechKey.get(), { log: logger })
  const asr = new RoutingASR({
    local: localAsr, remote: remoteAsr,
    getMode: () => asrMode(), getKey: () => speechKey.current(), log: logger,
  })
  const state = { asrNote: '', localLoading: false }
  const abort = new AbortController()
  const useLocal = () => asrMode() === 'sensevoice' || !speechKey.current()

  /** 下好/加载好本机模型。启动时调一次，家长在页面上切回本机时再调一次（下载不阻塞请求）。 */
  async function ensureLocal() {
    if (localAsr.rec || state.localLoading) return
    if (!modelReady(modelDir) && cfg.migrateFrom) {
      const old = join(cfg.migrateFrom, '..', 'models', 'sense-voice')
      if (modelReady(old)) {
        const { cpSync } = await import('node:fs')
        cpSync(old, modelDir, { recursive: true })
        logger.info('[homework] 已复制旧版的语音识别模型')
      }
    }
    state.localLoading = true
    state.asrNote = modelReady(modelDir) ? '正在加载本机语音模型' : '正在下载语音模型'
    try {
      await ensureModel(modelDir, { log: logger, signal: abort.signal })
      localAsr.load()
      state.asrNote = ''
      logger.info('[homework] 语音识别已就绪（本机模型）')
    } catch (e) {
      state.asrNote = e.message
      logger.error(`[homework] ${e.message}`)
    } finally {
      state.localLoading = false
    }
  }

  if (useLocal()) void ensureLocal()
  else logger.info('[homework] 语音识别用 DeepSeek 云端（录音会上传）')

  const brain = new Brain(ctx, () => cfg, logger)
  const voice = new Voice(dataDir, voiceCfg, logger)
  const hw = new Homework({ dataDir, brain, voice, asr, log: logger })

  const getInfo = () => ({
    port: cfg.port,
    voice: voice.provider,
    asr: asr.provider,
    asrReady: asr.ready(),
    asrNote: state.asrNote || asr.note() || (asr.ready() ? '' : '启动中'),
    asrMissingKey: asr.missingKey(),
    asrMode: asrMode(),
    asrHasKey: Boolean(speechKey.current()),
  })
  // 插件有没有新版本：从 Harness 的插件管理器看本机装的版本，再去 npm 查最新（只有从插件市场装的才会提示）
  const pkgName = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
  const checkUpdates = updateChecker({ name: pkgName, getManager: () => { try { return ctx.get?.('pluginManager') } catch { return undefined } } })
  const pairing = new Pairing({ file: join(dataDir, 'devices.json'), legacyToken: token, log: logger }).startDiscovery(cfg.port)
  /** 插件页上改语音识别：写 settings.json、立刻刷新 Key、需要本机模型时后台开始下载。 */
  async function saveAsr({ provider, key } = {}) {
    const next = {}
    if (ASR_MODES.includes(provider)) next.asrProvider = provider
    if (typeof key === 'string') next.speechKey = key.trim()
    if (Object.keys(next).length) store.patch(next)
    speechKey.invalidate()
    await speechKey.refresh()
    if (useLocal()) void ensureLocal()
    logger.info(`[homework] 语音识别现在用：${asr.provider === 'deepseek' ? 'DeepSeek 云端' : '本机模型'}`)
    return getInfo()
  }

  const server = await startServer({
    hw, token, pairing, checkUpdates, port: cfg.port, host: cfg.host, log: logger,
    getVoiceName: () => voice.provider, getInfo, saveAsr,
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
