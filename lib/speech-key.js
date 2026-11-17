// DeepSeek 语音（识别 / 合成）用的 API Key。
// 取值顺序：插件设置里填的 → Harness 凭据 DEEPSEEK_API_KEY → 环境变量 →
// 老版 Python 助手留下的 ~/.config/homework-helper/deepseek.key（让老用户不用重填，Python 版已废弃）。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LEGACY_FILE = join(homedir(), '.config', 'homework-helper', 'deepseek.key')
const TTL_MS = 60_000

const legacyKey = (file) => {
  if (!file) return ''
  try { return readFileSync(file, 'utf8').trim() } catch { return '' }
}

/**
 * @param ctx Harness 上下文（可能没有 credentials 服务，比如单元测试）
 * @param getSetting () => string  插件设置里的 apiKey
 * @param options.env / legacyFile / log
 */
export function createSpeechKey(ctx, getSetting, { env = process.env, legacyFile = LEGACY_FILE, log = console } = {}) {
  let value = ''
  let at = 0

  async function resolve() {
    const set = String(getSetting?.() ?? '').trim()
    if (set) return set
    try {
      const hit = await ctx?.credentials?.resolve?.('DEEPSEEK_API_KEY')
      const v = String(hit?.value ?? '').trim()
      if (v) return v
    } catch (e) {
      log.warn?.(`[homework] 读不到 Harness 里的 DEEPSEEK_API_KEY：${e.message}`)
    }
    const fromEnv = String(env.DEEPSEEK_API_KEY ?? '').trim()
    if (fromEnv) return fromEnv
    return legacyKey(legacyFile)
  }

  const api = {
    /** 同步读缓存值：设置页、声音合成拿它。 */
    current: () => value,
    /** 异步解析（带 60 秒缓存）：语音识别每次请求前用。 */
    async get() {
      if (Date.now() - at > TTL_MS) await api.refresh()
      return value
    },
    async refresh() {
      value = await resolve()
      at = Date.now()
      return value
    },
    /** 401/403 后清掉，下次重新解析（可能刚在设置里换了 key）。 */
    invalidate() { value = ''; at = 0 },
  }
  return api
}
