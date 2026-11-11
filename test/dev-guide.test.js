// 开发说明：对话工具能读到，且包含官方硬件开发资料链接和刷机规则。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'

test('homework_dev_guide 返回开发说明全文', async () => {
  const tools = {}
  registerTools({ tools: { register: (d) => { tools[d.name] = d } } }, { hw: {}, token: 't', getInfo: () => ({}) })
  const text = await tools.homework_dev_guide.execute({})
  for (const s of ['ai-passport.folotoy.cn/guides/', 'gitee.com/FoloToy/ai-passport', 'AGENTS.md', '刷机前必须得到家长明确同意', 'write_flash 0x10000'])
    assert.ok(text.includes(s), `缺少：${s}`)
})

test('提示词里的年级换成设置值', async () => {
  const { withGrade } = await import('../lib/llm.js')
  const { VOICE_PROMPT, SCREENSHOT_PROMPT } = await import('../lib/prompts.js')
  assert.ok(withGrade(VOICE_PROMPT, '三年级').includes('陪三年级孩子'))
  assert.ok(!withGrade(SCREENSHOT_PROMPT, '三年级').includes('{grade}'))
  assert.ok(withGrade(SCREENSHOT_PROMPT, '').includes('五年级'))   // 没设置时默认五年级
})
