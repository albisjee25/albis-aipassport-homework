// 默认声音：机器人“哔嘟”语，不需要任何密钥、不联网。
// 每个字发一个短音，音高由这个字决定（同一句话每次听起来一样）；标点是停顿；
// 开心往上扬，担心往下沉，疑惑结尾上扬，思考更慢更低。屏幕上照常显示文字。
const SR = 16000
const BLIP = 0.06, GAP = 0.012, PAUSE = 0.12, MAX_CHARS = 36

const MOODS = {
  hello:    { base: 520, slope: +0.5, tempo: 1.0 },
  happy:    { base: 480, slope: +0.35, tempo: 1.0 },
  worried:  { base: 360, slope: -0.45, tempo: 1.12 },
  thinking: { base: 400, slope: 0.0, tempo: 1.25 },
  confused: { base: 430, slope: 0.0, tempo: 1.05, question: true },
}

function blip(out, start, freq, dur, vol = 0.5) {
  const n = Math.floor(dur * SR)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const f = freq * (1 + 0.012 * Math.sin(2 * Math.PI * 28 * t))      // 轻微颤音
    phase += (2 * Math.PI * f) / SR
    const tri = (2 / Math.PI) * Math.asin(Math.sin(phase))
    const sq = Math.sign(Math.sin(phase))
    const env = Math.min(1, i / (0.006 * SR), (n - i) / (0.014 * SR))
    if (start + i < out.length) out[start + i] += (0.65 * tri + 0.35 * sq) * env * vol
  }
}

export async function synthesize(text, { mood = 'happy' } = {}) {
  const m = MOODS[mood] ?? MOODS.happy
  const chars = Array.from(String(text ?? '')).slice(0, MAX_CHARS)
  const events = []
  let voiced = 0
  for (const ch of chars) {
    if (/[\s，,。.、；;：:！!？?…]/.test(ch)) events.push({ pause: true })
    else { events.push({ ch, i: voiced }); voiced += 1 }
  }
  const total = events.reduce((s, e) => s + (e.pause ? PAUSE : (BLIP + GAP) * m.tempo), 0) + 0.15
  const out = new Float32Array(Math.ceil(total * SR))
  let pos = 0
  for (const e of events) {
    if (e.pause) { pos += Math.floor(PAUSE * SR); continue }
    const code = e.ch.codePointAt(0)
    const step = ((code * 7) % 9) / 8                               // 0..1，由字决定
    const progress = voiced > 1 ? e.i / (voiced - 1) : 0
    let semis = step * 7 + m.slope * 12 * (progress - 0.5)
    if (m.question && progress > 0.8) semis += 5
    blip(out, pos, m.base * Math.pow(2, semis / 12), BLIP * m.tempo)
    pos += Math.floor((BLIP + GAP) * m.tempo * SR)
  }
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.8
  return { samples: out, sampleRate: SR }
}
