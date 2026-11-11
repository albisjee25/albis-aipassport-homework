// 中文页码转数字，保留列表边界（对应 relay/cn_numbers.py）。
// “八十二八十三八十四页” -> “82、83、84页”。只转页码类数字：
// 含 十/百/零 的、能拆成两个以上数字的、单个数字后面紧跟“页”的；其他（第四单元、写三遍）保持原样。
const DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const NUM_CHARS = '零〇一二两三四五六七八九十百'
const RUN = new RegExp(`[${NUM_CHARS}]+`, 'g')
const isDigit = (c) => c !== undefined && c in DIGIT

function readOne(s, i) {
  const n = s.length
  let j = i, value = 0
  if (j + 1 < n && isDigit(s[j]) && s[j + 1] === '百') {
    value += DIGIT[s[j]] * 100
    j += 2
    if (j < n && '零〇'.includes(s[j])) {
      j += 1
      if (j < n && isDigit(s[j]) && !(j + 1 < n && '十百'.includes(s[j + 1]))) return [value + DIGIT[s[j]], j + 1]
      return [value, j]
    }
  }
  if (j + 1 < n && isDigit(s[j]) && s[j + 1] === '十') {
    value += DIGIT[s[j]] * 10
    j += 2
  } else if (j < n && s[j] === '十') {
    value += 10
    j += 1
  } else if (j > i) {
    if (j < n && isDigit(s[j]) && !(j + 1 < n && '十百'.includes(s[j + 1]))) return [value + DIGIT[s[j]] * 10, j + 1]
    return [value, j]
  } else {
    if (j < n && isDigit(s[j])) return [DIGIT[s[j]], j + 1]
    return [null, i]
  }
  if (j < n && isDigit(s[j]) && !(j + 1 < n && '十百'.includes(s[j + 1]))) {
    value += DIGIT[s[j]]
    j += 1
  }
  return [value, j]
}

export function splitRun(run) {
  const out = []
  let i = 0
  while (i < run.length) {
    const [v, j] = readOne(run, i)
    if (v === null || j === i) return null
    out.push(v)
    i = j
  }
  return out
}

export function convert(text) {
  return text.replace(RUN, (run, offset) => {
    const after = text.slice(offset + run.length, offset + run.length + 2)
    const nums = splitRun(run)
    if (!nums || nums.length === 0) return run
    const numeric = [...run].some((c) => '十百零〇'.includes(c)) || nums.length > 1 || after.startsWith('页')
    return numeric ? nums.join('、') : run
  })
}

export function numbersIn(text) {
  return String(text ?? '').match(/\d+/g) ?? []
}
