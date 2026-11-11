// 给 Harness 助手用的对话工具：家长直接在对话里贴截图、说“数学改成20分钟”，助手调用这些工具。
// 工具走的是和网页后台、设备同一套规则（lib/app.js、lib/store.js）。
import { adminStore } from './admin-ops.js'
import { lanAddresses } from './util.js'
import { readFileSync } from 'node:fs'

const DEV_GUIDE = new URL('../DEV-GUIDE.md', import.meta.url)
const MAINTAINER = new URL('../MAINTAINER.local.md', import.meta.url)

let defineTool = (def) => def
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')) } catch { /* 不在 Harness 里（测试）时用原样返回 */ }

const SUBJECTS = ['语文', '数学', '英语', '其他']
const STATUS_ZH = { todo: '待做', doing: '进行中', done: '已完成' }
const text = (_args, value) => [{ type: 'text', text: value }]
const out = { schema: { type: 'string' }, render: text }

function listText(hw) {
  const s = hw.snapshot()
  if (!s.tasks.length) return `${s.day} 清单是空的。`
  const lines = s.tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.title}（${t.subject}，${t.minutes}分钟，${STATUS_ZH[t.status]}${t.optional ? '，选做' : ''}${t.source === 'screenshot' ? '' : t.source === 'voice' ? '，孩子口述' : '，家长添加'}）`)
  return `${s.day} 的作业清单：\n${lines.join('\n')}`
}

export function registerTools(ctx, { hw, token, getInfo, grade = '五年级' }) {
  const admin = adminStore(hw)
  const reg = (def) => ctx.tools.register(defineTool(def))

  reg({
    name: 'homework_list',
    description: '查看今天的作业清单（作业助手）。每项带 id，修改、删除、排序时用这个 id。',
    parameters: {},
    output: out,
    async execute() { return listText(hw) },
  })

  reg({
    name: 'homework_add_tasks',
    description: [
      '把家长群老师发的作业加进今天的清单，并同步到孩子的设备。家长发来作业截图时：你先看图把作业整理好，再调用本工具，不要让家长手填。',
      '整理规则（很重要）：',
      '- 截图里有序号（1. 2. / ①② / 一、二、 / (1)(2)）时，一个序号就是一项，序号下的页码、遍数、“并背诵”等要求都属于这一项，不能再拆开；没有序号才按“动作+对象”拆。',
      '- name（作业名）照抄老师原文：页码、遍数、要求一个都不能少，只去掉序号本身和“英语作业：”“今日作业”这类前缀与表情；不改写、不总结、不换近义词；最长 32 个字。note 留空。',
      '- “请家长签字”“拍照上传”等家长事务不算作业；标出选做。',
      `- minutes 按${grade}孩子的合理预估给整数分钟；按建议完成顺序排列（动脑的先做，抄写居中，背诵和准备听写靠后，选做最后）。`,
      '- category 是作业类型，用来统计同类作业平时要做多久：优先用 homework_durations 里已有的类型，否则新起一个不超过 8 个字的名字（不含页码、课号、日期）。',
    ].join('\n'),
    parameters: {
      tasks: {
        type: 'array', required: true, description: '按建议完成顺序排列的作业',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: '作业名：老师原文，≤32 字' },
            subject: { type: 'string', enum: SUBJECTS, description: '学科' },
            minutes: { type: 'integer', description: '预估分钟数' },
            optional: { type: 'boolean', description: '是否选做' },
            category: { type: 'string', description: '作业类型，≤8 字' },
          },
        },
      },
    },
    output: out,
    async execute(args) {
      // 参数名不用 title：它是 JSON Schema 的保留关键字，会被模型接口的校验误判
      const made = hw.addScreenshotTasks(args.tasks.map(({ name, ...rest }) => ({ ...rest, title: name })))
      return `已加入 ${made.length} 项作业，设备会在几秒内收到。\n${listText(hw)}`
    },
  })

  reg({
    name: 'homework_edit',
    description: '修改清单里的一项作业：作业名（name）、分钟数、学科、是否选做、状态（todo/doing/done）。只传要改的字段。',
    parameters: {
      id: { type: 'string', required: true, description: '作业 id（来自 homework_list）' },
      name: { type: 'string', description: '新的作业名' }, minutes: { type: 'integer' }, subject: { type: 'string', enum: SUBJECTS },
      optional: { type: 'boolean' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] },
    },
    output: out,
    async execute({ id, name, ...rest }) {
      const r = admin.edit(id, name === undefined ? rest : { ...rest, title: name })
      return r.ok ? `已修改。\n${listText(hw)}` : `没找到 id 为 ${id} 的作业。`
    },
  })

  reg({
    name: 'homework_move',
    description: '调整作业顺序：delta 为 -1 表示上移一位，+1 下移一位。',
    parameters: { id: { type: 'string', required: true }, delta: { type: 'integer', required: true } },
    output: out,
    async execute({ id, delta }) { admin.move(id, { delta }); return listText(hw) },
  })

  reg({
    name: 'homework_delete',
    description: '删除清单里的一项作业（家长可以删任何一项，孩子自己不能删老师布置的）。',
    parameters: { id: { type: 'string', required: true } },
    output: out,
    async execute({ id }) {
      const r = admin.remove(id)
      return r.ok ? `已删除。\n${listText(hw)}` : `没找到 id 为 ${id} 的作业。`
    },
  })

  reg({
    name: 'homework_clear',
    description: '清空今天的全部作业。这个操作不可撤销，调用前必须先向家长确认。',
    parameters: { confirm: { type: 'boolean', required: true, description: '家长已明确同意清空' } },
    output: out,
    async execute({ confirm }) {
      if (!confirm) return '没有清空：需要家长明确同意。'
      admin.clear()
      return '已清空今天的清单。'
    },
  })

  reg({
    name: 'homework_durations',
    description: '查看每类作业平时实际要做多久（从孩子做完的作业里学到的）。',
    parameters: {},
    output: out,
    async execute() {
      const rows = hw.durations.overview()
      if (!rows.length) return '还没有用时记录。孩子做完几次作业后就会有。'
      return rows.map((r) => `${r.category}（${r.subject}）：做过 ${r.count} 次，最近平均 ${r.avg_min} 分钟${r.estimate ? `，新作业会预估 ${r.estimate} 分钟` : '，次数不够，暂不预估'}`).join('\n')
    },
  })

  reg({
    name: 'homework_phrases',
    description: [
      '管理短语库。fix：语音识别常听错的词（要写上常被听成什么，会在 AI 看到前被替换）；term：老师的简写（原样保留，meaning 帮助理解）。',
      'action=list 查看，add 添加，delete 删除（用 id）。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'delete'] },
      kind: { type: 'string', enum: ['fix', 'term'] }, text: { type: 'string', description: '正确写法' },
      heard: { type: 'array', items: { type: 'string' }, description: 'fix 用：常被听成的写法' },
      meaning: { type: 'string', description: 'term 用：含义' }, id: { type: 'string', description: 'delete 用' },
    },
    output: out,
    async execute(a) {
      try {
        if (a.action === 'add') hw.phrases.add(a.kind ?? 'term', a.text ?? '', a.heard ?? [], a.meaning ?? '')
        if (a.action === 'delete') { if (!hw.phrases.delete(a.id)) return `没找到 id 为 ${a.id} 的短语。` }
      } catch (e) { return `没有保存：${e.message}` }
      return hw.phrases.all().map((p) => `[${p.id}] ${p.kind === 'fix' ? `纠错：${(p.heard ?? []).join('/')} → ${p.text}` : `简写：${p.text}${p.meaning ? `（${p.meaning}）` : ''}`}`).join('\n')
    },
  })

  reg({
    name: 'homework_status',
    description: '查看作业助手的运行状态：后台网址、设备要填的地址和令牌、语音识别模型和机器人声音状态。给设备配置或排查问题时用。',
    parameters: {},
    output: out,
    async execute() {
      const i = getInfo()
      const lan = lanAddresses().map((ip) => `http://${ip}:${i.port}`)
      return [
        `家长后台（只能在这台电脑打开）：http://127.0.0.1:${i.port}`,
        `设备要填的服务地址（同一 Wi-Fi）：${lan.join(' 或 ') || '没找到局域网地址'}`,
        `设备令牌：${token}`,
        `语音识别模型：${i.asrReady ? '已就绪' : `未就绪（${i.asrNote}）`}`,
        `机器人声音：${i.voice}`,
      ].join('\n')
    },
  })

  reg({
    name: 'homework_dev_guide',
    description: '读作业助手的开发说明：项目文件在哪、怎么接入语音合成、改统计报表、排查设备连接、改固件和刷机，以及 AI Passport 官方硬件开发资料的链接。家长要定制或维护作业助手（插件或设备固件）时，动手前先调用。',
    parameters: {},
    output: out,
    async execute() {
      let text
      try { text = readFileSync(DEV_GUIDE, 'utf8') } catch (e) { return `没读到开发说明：${e.message}` }
      // 维护者本机的补充说明（不随插件发布）
      try { text += '\n\n---\n\n' + readFileSync(MAINTAINER, 'utf8') } catch { /* 普通用户没有这个文件 */ }
      return text
    },
  })
}
