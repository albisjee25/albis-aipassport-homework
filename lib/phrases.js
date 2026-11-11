// 作业短语库（对应 relay/phrases.py），家长在后台或对话里维护。
//   fix  - 语音识别常听错的词：每个 heard 变体在交给 AI 之前就被替换成 text（确定性替换，不靠 AI）
//   term - 老师的简写：text 原样保留，meaning 只帮助 AI 理解（例：家默 = 回家默写）
import { existsSync, readFileSync } from 'node:fs'
import { cut, hex, writeJson } from './util.js'

export const DEFAULTS = [
  { kind: 'fix', text: '英译中', heard: ['英一中', '音一中', '一一中', '211中', '英意中', '音译中', '因一中'] },
  { kind: 'fix', text: '中译英', heard: ['中一英', '中译音', '中意英', '中一音'] },
  { kind: 'fix', text: '单元', heard: ['第一元', '第二元', '第三元', '第四元', '第五元', '第六元', '第七元', '第八元'], note: '整词替换：第三元 → 第三单元' },
  { kind: 'term', text: '一课一练', meaning: '练习册名称' },
  { kind: 'term', text: '课课练', meaning: '练习册名称' },
  { kind: 'term', text: '家默', meaning: '回家默写，需要家长报听' },
  { kind: 'term', text: '读背', meaning: '朗读并背诵' },
  { kind: 'term', text: '预习单', meaning: '预习作业纸' },
  { kind: 'term', text: '订正', meaning: '改正做错的题' },
  { kind: 'term', text: '口算本', meaning: '数学口算练习本' },
  { kind: 'term', text: '抄写', meaning: '照着写' },
  { kind: 'term', text: '默写', meaning: '不看书写出来' },
  { kind: 'term', text: '听写', meaning: '听别人读，写下来' },
]

export class PhraseBook {
  constructor(path) {
    this.path = path
    if (!existsSync(path)) writeJson(path, DEFAULTS.map((e) => ({ ...e, id: hex(3) })))
  }

  all() {
    try { return JSON.parse(readFileSync(this.path, 'utf8')) } catch { return [] }
  }

  add(kind, text, heard = [], meaning = '') {
    kind = kind === 'fix' ? 'fix' : 'term'
    text = cut(String(text ?? '').trim(), 20)
    if (!text) throw new Error('缺少写法')
    heard = (heard || []).map((h) => cut(String(h).trim(), 20)).filter(Boolean)
    if (kind === 'fix' && !heard.length) throw new Error('纠错要写上常被听成什么')
    const item = { id: hex(3), kind, text, heard, meaning: cut(String(meaning ?? '').trim(), 40) }
    writeJson(this.path, [...this.all(), item])
    return item
  }

  delete(id) {
    const items = this.all()
    const kept = items.filter((i) => i.id !== id)
    writeJson(this.path, kept)
    return kept.length !== items.length
  }

  /** 把已知的听错词换成正确写法。长的变体优先，“第三元”先于“三元”。 */
  correct(text) {
    const pairs = []
    for (const e of this.all()) {
      if (e.kind !== 'fix') continue
      for (const h of e.heard ?? []) {
        if (e.text === '单元' && h.endsWith('元') && h.startsWith('第')) pairs.push([h, h.slice(0, -1) + '单元'])
        else pairs.push([h, e.text])
      }
    }
    pairs.sort((a, b) => b[0].length - a[0].length)
    for (const [wrong, right] of pairs) if (wrong && !right.includes(wrong)) text = text.split(wrong).join(right)
    return text
  }

  promptSection() {
    const all = this.all()
    const terms = all.filter((e) => e.kind === 'term').map((e) => (e.meaning ? `${e.text}（${e.meaning}）` : e.text))
    const fixes = all.filter((e) => e.kind === 'fix').map((e) => e.text)
    const out = []
    if (terms.length) out.push('老师常用的作业说法（照原样保留，不要改写）：' + terms.join('、'))
    if (fixes.length) out.push('这些词常被听错，已经替你纠正过：' + fixes.join('、'))
    return out.join('\n')
  }
}
