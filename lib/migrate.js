// 第一次启动时，把旧的 Python 版作业助手的数据搬过来（设备令牌不变，设备不用重新烧录）。
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ITEMS = ['state.json', 'history', 'durations.json', 'phrases.json', 'device_token', 'voice-log']

/**
 * from 是旧版的 data 目录（里面有 state.json 等）。新目录已经有清单（state.json）就不动。
 * 搬的时候会覆盖新目录里自动生成的 device_token / phrases.json：设备固件里烧的是旧令牌，必须沿用。返回搬了哪些。
 */
export function migrate(from, to) {
  if (!from || !existsSync(from)) return []
  if (existsSync(join(to, 'state.json'))) return []
  mkdirSync(to, { recursive: true })
  const moved = []
  for (const name of ITEMS) {
    const src = join(from, name)
    if (!existsSync(src)) continue
    cpSync(src, join(to, name), { recursive: true })
    moved.push(name)
  }
  return moved
}
