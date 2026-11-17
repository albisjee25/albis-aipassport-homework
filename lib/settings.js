// 插件页上的开关（目前只有语音识别：本机 / DeepSeek 云端）存在 dataDir/settings.json。
// 优先级高于 Harness 设置页里的默认值：家长在页面上改一次，就是改了以后一直用的选择。
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export const ASR_MODES = ['sensevoice', 'deepseek']

export function settingsStore(file, log = console) {
  const read = () => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn?.(`[homework] 读设置失败（${file}）：${e.message}`)
      return {}
    }
  }

  return {
    get: read,
    /** 只改传进来的字段，其余保持不变。文件是 0600：里面可能有 API Key。 */
    patch(next) {
      const merged = { ...read(), ...next }
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      return merged
    },
  }
}
