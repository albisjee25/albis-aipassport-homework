// 手动加作业时的学科兜底判断。
// 正常情况学科和作业类型都由模型判断（prompts.js 的 TASK_CLASSIFY_PROMPT）；
// 模型没登录、超时或回了个不合法值时，用这里的关键词规则判断学科，保证家长随手加的一项总能加上。
import { cleanSubject } from './store.js'

// 顺序有意义：英语先判（"英语课文朗读"里有"课文"），再数学，最后语文。
const RULES = [
  ['英语', /(单词|词组|短语|英译中|中译英|英语|english|unit\s*\d|音标|字母|听力|口语)/i],
  ['数学', /(口算|笔算|竖式|脱式|计算|算式|应用题|数学|几何|奥数|乘法|除法|加减|分数|图形)/],
  ['语文', /(生字|生词|词语|组词|古诗|课文|预习|复习|背诵|默写|听写|作文|日记|周记|阅读|拼音|练字|字帖|摘抄|语文)/],
]

const IN_SUBJECTS = new Set(['语文', '数学', '英语'])

/** 只看作业名，粗判学科；三科都不是就是"其他"。 */
export function guessSubject(title) {
  const t = String(title ?? '')
  for (const [subject, re] of RULES) if (re.test(t)) return subject
  return '其他'
}

/** 模型的答案优先：给了三科之一就用它，否则（或说了"其他"、给了乱七八糟的值）按关键词判。 */
export function pickSubject(value, title) {
  const s = String(value ?? '').trim()
  return IN_SUBJECTS.has(s) ? cleanSubject(s) : guessSubject(title)
}
