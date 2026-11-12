// 检查本插件有没有新版本（和“作品”页的更新横幅同一套做法）：
//   - 本机装了哪个版本：Harness 的插件管理器 listBundles()；只有从 npm 装的才提示更新（链接到源码文件夹的不提示）。
//   - 最新版本和更新日志：npm 源。日志写在包里 package.json 的 homeworkHelper.releaseNotes。
//   - 真正更新：插件页用 Harness 的插件管理器 installBundle()，这里只负责告诉页面“有什么可更新”。
const NPM = 'https://registry.npmjs.org/'
const LOOKUP_MS = 8000
const FRESH_MS = 30 * 60 * 1000
const TARBALL = /^https?:\/\/.+\.tgz$/i

const slash = (u) => (u.endsWith('/') ? u : `${u}/`)

export function isNewer(a, b) {
  const parts = (v) => {
    const [core = '', pre] = String(v).split('+')[0].split(/-(.*)/s)
    return { n: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre }
  }
  const l = parts(a), r = parts(b)
  for (let i = 0; i < 3; i++) { const d = (l.n[i] ?? 0) - (r.n[i] ?? 0); if (d !== 0) return d > 0 }
  if (l.pre === undefined || r.pre === undefined) return l.pre === undefined && r.pre !== undefined
  return l.pre.localeCompare(r.pre, 'en', { numeric: true }) > 0
}

const isNote = (n) => typeof n?.version === 'string' && typeof n.date === 'string' && typeof n.zh === 'string' && typeof n.en === 'string'
const fromRegistry = (name, source) => source !== undefined && (source.startsWith(`${name}@`) || TARBALL.test(source))

export function updateChecker({ name, getManager, fetchImpl = fetch, now = Date.now }) {
  let kept // { at, release }
  const get = async (url, accept) => {
    try {
      const r = await fetchImpl(url, { headers: accept ? { accept } : {}, signal: AbortSignal.timeout(LOOKUP_MS) })
      return r.ok ? await r.json() : null
    } catch { return null }
  }
  const releaseOn = async (registry) => {
    const doc = await get(`${registry}${name}`, 'application/vnd.npm.install-v1+json')
    const version = doc?.['dist-tags']?.latest
    const tarball = doc?.versions?.[version]?.dist?.tarball
    return typeof tarball === 'string' && TARBALL.test(tarball) ? { version, tarball, registry } : null
  }
  const latestRelease = async (manager, refresh) => {
    if (!refresh && kept && now() - kept.at < FRESH_MS) return kept.release
    let registries = [NPM]
    try {
      const { registry, fallbackRegistries, resolved } = await manager.registries()
      registries = [...new Set([registry ?? resolved ?? NPM, ...(fallbackRegistries ?? [])].map(slash))]
    } catch { /* 取不到配置就用官方源 */ }
    for (const registry of registries) {
      const release = await releaseOn(registry)
      if (release) { kept = { at: now(), release }; return release }
    }
    return null
  }
  const notesFor = async (release, current) => {
    const doc = await get(`${release.registry}${name}/${release.version}`)
    const all = doc?.homeworkHelper?.releaseNotes
    if (!Array.isArray(all)) return []
    return all.filter(isNote).filter((n) => isNewer(n.version, current) && !isNewer(n.version, release.version))
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1))
  }

  /** 返回 { updates: [...], notes: [...] }，格式和“作品”页一致；没有更新时 updates 为空。 */
  return async ({ refresh = false } = {}) => {
    const manager = getManager()
    if (!manager) return { updates: [], notes: [] }
    let bundle
    try { bundle = (await manager.listBundles()).find((b) => b.name === name && b.installed === true) } catch { return { updates: [], notes: [] } }
    if (!bundle || typeof bundle.version !== 'string' || !fromRegistry(name, bundle.source)) return { updates: [], notes: [] }
    const release = await latestRelease(manager, refresh)
    if (!release || !isNewer(release.version, bundle.version)) return { updates: [], notes: [] }
    return {
      updates: [{ name, version: bundle.version, latest: release.version, spec: release.tarball, registry: release.registry, enabled: bundle.enabled !== false, native: bundle.updatable === true }],
      notes: await notesFor(release, bundle.version),
    }
  }
}
