// 侧边栏页面（client.js）：用假 React 把整页渲染一遍，确认注册了入口和页面、渲染不抛错。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (init) => [init, () => {}],
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useSyncExternalStore: (_sub, snap) => snap(),
}

// client.js 在 vm 里运行，它的 globalThis 不是测试的 globalThis：更新横幅的共享状态要放进 vm 的沙箱里
const HUB = Symbol.for('albis-aipassport-homework/updates')
let pendingHub = null, sandbox = null
function load(fetchImpl = () => Promise.reject(new Error('offline'))) {
  let mod
  const window = { __ModuleLoader__: { load: (m) => { mod = m } }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }
  sandbox = { window, fetch: fetchImpl, setInterval, clearInterval }
  if (pendingHub) sandbox[HUB] = pendingHub
  vm.runInNewContext(SRC, sandbox)
  const api = mod.factory((name) => { assert.equal(name, 'react'); return React })
  return { mod, api }
}

/** 递归展开函数组件，收集所有文字 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((n) => textOf(n, out)); return out }
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }), out)
  node.children.forEach((c) => textOf(c, out))
  return out
}

test('id 与包名一致，声明依赖 slots', () => {
  const { mod, api } = load()
  assert.equal(mod.id, 'albis-aipassport-homework')
  assert.deepEqual(Array.from(api.inject), ['slots'])
})

test('注册侧边栏入口和主页面，且用同一个 id', () => {
  const { api } = load()
  const injected = [], registered = []
  api.apply({ slots: {
    inject: (owner, fn) => { injected.push(owner); fn() },
    register: (opts, comp) => { registered.push({ opts, comp }) },
  } })
  assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])
  const main = registered.find((r) => r.opts.name === 'main')
  const nav = registered.find((r) => r.opts.name === 'sidebar.panellist')
  assert.equal(main.opts.key, nav.opts.id)
  assert.equal(nav.opts.label, '作业助手')
  assert.ok(nav.comp({ size: 18 }))                      // 图标能渲染
})

test('页面渲染不抛错，且包含操作手册的关键内容', () => {
  const { api } = load()
  let Page
  api.apply({ slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp } } })
  const text = textOf(React.createElement(Page, {})).join('')
  for (const s of ['作业助手', '打开家长后台', '让 AI 帮你改', '运行状态', '硬件操作说明', '按住说话', '头灯红色']) assert.ok(text.includes(s), `缺少：${s}`)
  for (const s of ['常见问题', '家长怎么用', '服务地址']) assert.ok(!text.includes(s), `不该出现：${s}`)
})

/** 找到第一个满足条件的元素（展开函数组件） */
function find(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const r = find(n, pred); if (r) return r } return null }
  if (typeof node.type === 'function') return find(node.type({ ...node.props, children: node.children }), pred)
  if (pred(node)) return node
  return find(node.children, pred)
}
const isHero = (n) => n.type === 'button' && String(n.props.className).includes('hwh-hero')

test('对话入口：点“开一个新对话”开新会话并预填文字', () => {
  const { api } = load()
  let Page; const calls = []
  api.apply({
    get: (name) => name === 'uiWorkspace' ? { startSession: (...a) => calls.push(a) } : undefined,
    slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp } },
  })
  const tree = React.createElement(Page, {})
  const hero = find(tree, isHero)
  assert.equal(hero.props.disabled, false)
  hero.props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].whenDraftExists, 'append')
  assert.ok(calls[0][1].prompt.includes('作业助手'))
  const text = textOf(tree).join('')
  for (const s of ['接入自己的语音合成', '修改统计报表', '检查设备连接', '修改设备设置或刷机']) assert.ok(text.includes(s), `缺少：${s}`)
})

test('对话入口：Harness 不支持开会话时变灰，不抛错', () => {
  const { api } = load()
  let Page
  api.apply({ slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp } } })
  const hero = find(React.createElement(Page, {}), isHero)
  assert.equal(hero.props.disabled, true)
  hero.props.onClick()
})

test('运行状态：有数据时显示四格状态，不显示设备地址', () => {
  const info = { asr: { ready: true }, voice: 'chirp', device: { online: true, ip: '1.2.3.4', last_seen_s: 3 }, lan: ['http://1.2.3.4:8787'], tasks: { total: 2, done: 1 } }
  const saved = React.useState
  React.useState = () => [{ status: 'up', info }, () => {}]
  try {
    const { api } = load()
    let Page
    api.apply({ slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp } } })
    const text = textOf(React.createElement(Page, {})).join('')
    for (const s of ['运行中', '在线', '已就绪', '机械哔嘟声']) assert.ok(text.includes(s), `缺少：${s}`)
    assert.ok(!text.includes('1.2.3.4'), '页面上不该出现设备地址')
  } finally { React.useState = saved }
})

test('对话入口预填的话会先让 AI 读开发说明', () => {
  const { api } = load()
  let Page; const calls = []
  api.apply({
    get: (name) => name === 'uiWorkspace' ? { startSession: (...a) => calls.push(a) } : undefined,
    slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp } },
  })
  find(React.createElement(Page, {}), isHero).props.onClick()
  assert.ok(calls[0][1].prompt.includes('homework_dev_guide'))
})

test('新设备请求连接：配对码和“允许/拒绝”显示在插件页；没有请求时不显示', () => {
  const render = (pairing) => {
    const info = { asr: { ready: true }, voice: 'chirp', device: { online: false, last_seen_s: null }, tasks: { total: 0, done: 0 }, pairing }
    const saved = React.useState
    React.useState = (init) => [typeof init === 'object' && init?.status ? { status: 'up', info } : init, () => {}]
    try {
      const { api } = load()
      let Page
      api.apply({ slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp } } })
      return textOf(React.createElement(Page, {})).join('')
    } finally { React.useState = saved }
  }
  const withReq = render([{ code: '4821', ip: '192.168.1.9', age_s: 3 }])
  for (const s of ['4821', '有一台新设备请求连接', '允许', '拒绝']) assert.ok(withReq.includes(s), `缺少：${s}`)
  assert.ok(!withReq.includes('192.168.1.9'), '不显示设备地址')
  assert.ok(!render([]).includes('有一台新设备请求连接'))
})

// ---- 插件更新横幅 ----
const NOTES = [{ version: '0.3.1', date: '2026-11-20', zh: '### 新功能\n- 新增 **统计报表**', en: '' }]
const UPDATE = { name: 'albis-aipassport-homework', version: '0.3.0', latest: '0.3.1', spec: 'https://x/a.tgz', registry: 'https://registry.npmjs.org/', enabled: true }
const setHub = (state) => { pendingHub = { state: { updates: [], notes: [], phase: 'idle', restart: false, failure: null, dismissed: '', ...state }, listeners: new Set() }; if (sandbox) sandbox[HUB] = pendingHub }
const pageOf = () => {
  const { api } = load()
  let Page, Icon
  api.apply({ slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp; else Icon = comp } } })
  return { Page, Icon }
}
const findNodes = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => findNodes(n, pred, out)); return out }
  if (pred(node)) out.push(node)
  if (typeof node.type === 'function') findNodes(node.type({ ...node.props, children: node.children }), pred, out)
  else node.children.forEach((c) => findNodes(c, pred, out))
  return out
}

test('插件更新：有新版本时顶部显示横幅、更新日志和“稍后/更新”', () => {
  setHub({ updates: [UPDATE], notes: NOTES })
  try {
    const { Page } = pageOf()
    const text = textOf(React.createElement(Page, {})).join('')
    for (const s of ['作业助手 插件有新版本 0.3.1', '当前是 0.3.0', '更新日志', '稍后', '更新', '新功能', '统计报表', '2026-11-20']) assert.ok(text.includes(s), `缺少：${s}`)
  } finally { pendingHub = null }
})

test('插件更新：没有新版本时不显示；点“稍后”后只剩一行提示', () => {
  setHub({})
  try {
    const { Page } = pageOf()
    assert.ok(!textOf(React.createElement(Page, {})).join('').includes('插件有新版本'))
    setHub({ updates: [UPDATE], notes: NOTES, dismissed: '0.3.1' })
    const text = textOf(React.createElement(Page, {})).join('')
    assert.ok(text.includes('作业助手有新版本 0.3.1') && text.includes('查看') && !text.includes('新功能'))
  } finally { pendingHub = null }
})

test('插件更新：侧边栏入口旁有“更新”标签（窄图标显示小圆点）', () => {
  setHub({ updates: [UPDATE], notes: NOTES })
  try {
    const { Icon } = pageOf()
    assert.ok(textOf(React.createElement(Icon, { size: 16 })).join('').includes('更新'))
    const rail = findNodes(React.createElement(Icon, { size: 24 }), (n) => n.props?.className === 'hwu-rail')
    assert.equal(rail.length, 1)
    setHub({})
    assert.ok(!textOf(React.createElement(Icon, { size: 16 })).join('').includes('更新'))
  } finally { pendingHub = null }
})

test('插件更新：点“更新”用插件管理器安装，成功后提示重启；失败给出原因和重试', async () => {
  const calls = []
  const answers = [{ ok: true, value: { application: 'restart-required' } }, { ok: true, value: { application: 'failed', error: { diagnostic: 'x\nERR_NETWORK boom' } } }]
  const manager = { installBundle: async (spec, opts) => { calls.push([spec, opts.registry, opts.enabled]); return answers.shift() }, waitForInstall: async () => ({ ok: false, error: {} }) }
  const fetchImpl = async () => ({ ok: true, json: async () => ({ updates: [UPDATE], notes: NOTES }) })
  setHub({ updates: [UPDATE], notes: NOTES })
  try {
    const { api } = load(fetchImpl)
    let Page
    api.apply({
      slots: { inject: (_o, fn) => fn(), register: (opts, comp) => { if (opts.name === 'main') Page = comp } },
      inject: (_names, fn) => fn({ remote: { pluginManager: manager }, effect: () => {} }),
    })
    const click = () => findNodes(React.createElement(Page, {}), (n) => n.type === 'button' && n.props.className?.includes('hwu-primary'))[0].props.onClick()
    await click()
    assert.deepEqual(calls[0], ['https://x/a.tgz', 'https://registry.npmjs.org/', true])
    let text = textOf(React.createElement(Page, {})).join('')
    assert.ok(text.includes('已更新到 0.3.1') && text.includes('重启 DeepSeek Harness'), text)
    setHub({ updates: [UPDATE], notes: NOTES })
    await click()
    text = textOf(React.createElement(Page, {})).join('')
    assert.ok(text.includes('更新失败') && text.includes('ERR_NETWORK boom') && text.includes('重试'), text)
  } finally { pendingHub = null }
})
