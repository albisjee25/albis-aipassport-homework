// 作业助手的 Harness 界面：侧边栏入口 + 页面（家长后台主入口、让 AI 帮你改、运行状态、硬件操作说明）。
// 约定（来自 Harness 侧边栏文档）：sidebar.panellist 注册图标，main 注册页面，两者用同一个 id 对应。
// 样式只用 Harness 的主题变量（--dsw-alias-*），不引入任何 Harness 内部包。
window.__ModuleLoader__.load({
  id: 'albis-aipassport-homework',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ID = 'albis-aipassport-homework'
    const DEFAULT_PORT = 8787

    // ---- 手册内容 ----
    const K = (t) => h('span', { className: 'hwh-key' }, t)
    const UP = '▲', DOWN = '▼', OK = '确定'
    const keyTable = [
      { title: '作业清单页', rows: [
        [[K(UP), ' ', K(DOWN)], '选作业'],
        [['按 ', K(OK)], '开始倒计时。标错“完成”的项，也这样重新开始，之前的用时会保留'],
        [['长按 ', K(DOWN)], ['改这项的时间：', K(UP), K(DOWN), ' 每次加减 5 分钟，按 ', K(OK), ' 保存（3 秒不按也会保存）']],
        [['长按 ', K(OK)], '按住说话，松手发送（最长 10 秒）'],
        [['长按 ', K(UP)], ['家长用：重新配网。按 ', K(OK), ' 重启进入配网，按其他键取消']],
        ['按任意键', '叫醒睡着的小机器人（睡着时第一下只是叫醒）'],
      ] },
      { title: '倒计时中', rows: [
        [['按 ', K(OK)], '暂停 / 继续'],
        [['长按 ', K(DOWN)], '提前做完了'],
        [['长按 ', K(UP)], '先不做了，回到清单'],
        [['长按 ', K(OK)], '按住说话，可以说“改成二十分钟”“再加十分钟”'],
        ['时间到', ['按 ', K(UP), K(DOWN), ' 选“做完了”或“再来 5 分钟”，按 ', K(OK), ' 确认']],
      ] },
    ]
    const sayings = [
      '“今天有数学练习册 34 到 35 页，还有英语抄写”——加作业',
      '“背古诗，十分钟”——加作业并指定时间',
      '“现在做数学”——开始倒计时（有两项数学时，小机器人会反问是哪一项）',
      '“数学做完了”——标记完成',
      '倒计时中：“改成二十分钟”“再加十分钟”（清单页不能语音改时间，要用按键）',
    ]
    const robotSigns = [
      ['头灯红色', '连着电脑，可以说话'],
      ['头灯灰色', '没连上电脑（Wi-Fi 断了或电脑关了）。按键和计时照常能用'],
      ['右边电池变红', '电量不多了，请充电'],
      ['语 / 数 / 外', '语文 / 数学 / 英语；调色盘是其他（画报、实践）'],
      ['★', '这项已经做完'],
      ['作业名滚动', '清单页移到这一项时，名字横向滚动显示全文'],
    ]
    // ---- 对话入口：只用于定制和维护（改功能、接服务、排查连接、刷机）。日常管理作业走家长后台 ----
    // 和“作品”页一样，用 Harness 的 uiWorkspace.startSession 开新会话并预填一句话
    const chats = {
      main: { title: '开一个新对话', prompt: '我想调整作业助手：' },
      ideas: [
        { icon: 'voice', title: '接入自己的语音合成', sub: '换成你自己的声音服务，让机器人开口说话', prompt: '我想给小机器人接入自己的语音合成服务，让它能用这个声音说话。请先告诉我需要准备什么。' },
        { icon: 'chart', title: '修改统计报表', sub: '调整家长后台里用时记录的统计和展示', prompt: '我想修改家长后台里作业用时的统计报表：' },
        { icon: 'link', title: '检查设备连接', sub: '设备连不上、头灯变灰时，让 AI 帮你排查', prompt: '帮我检查一下作业助手设备和电脑的连接是否正常，有问题就带我一步步排查。' },
        { icon: 'chip', title: '修改设备设置或刷机', sub: '改设备上的功能、更新固件', prompt: '我想修改作业助手设备端的功能（或给设备刷机）：' },
      ],
    }
    let CTX = null
    const nav = () => { try { return CTX?.get?.('uiWorkspace') } catch { return undefined } }
    const canChat = () => typeof nav()?.startSession === 'function'
    // 这里进来的都是定制和维护，先让 AI 读开发说明（lib/tools.js 的 homework_dev_guide）
    const GUIDE_FIRST = '（先调用 homework_dev_guide 读作业助手开发说明）'
    function startChat(prompt) {
      const n = nav()
      if (typeof n?.startSession !== 'function') return
      n.startSession(undefined, { prompt: GUIDE_FIRST + prompt, whenDraftExists: 'append' })
    }

    // ---- 样式：“今日作业桌面”。底色和文字跟随 Harness 主题变量（深浅色都能用），
    //      点缀色取自设备上的小机器人：头灯红、眼睛黄、滚刷蓝。类名统一 hwh- 前缀 ----
    const css = `
.hwh-page{height:100%;overflow:auto;box-sizing:border-box;padding:36px 40px 72px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;
  --hwh-red:#E2483D;--hwh-yellow:#F6C93C;--hwh-blue:#1F55A0;--hwh-sky:#80C0E0;--hwh-radius:18px;--hwh-accent:var(--dsw-alias-brand-primary,#4d6bfe)}
.hwh-wrap{max-width:760px;margin:0 auto}
.hwh-top{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.hwh-top h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.hwh-pill{display:inline-flex;align-items:center;gap:6px;margin-left:auto;padding:4px 11px;border-radius:99px;font-size:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.hwh-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.hwh-ok .hwh-dot,.hwh-dot.hwh-ok{background:var(--dsw-alias-state-success-primary,#30A46C)}
.hwh-warn .hwh-dot,.hwh-dot.hwh-warn{background:var(--dsw-alias-state-warn-primary,#F5A524)}
.hwh-bad .hwh-dot,.hwh-dot.hwh-bad{background:var(--dsw-alias-state-error-primary,#E5484D)}

/* 插件更新横幅（样式与“作品”页的更新横幅一致） */
.hwu-panel{margin-bottom:24px;padding:16px 20px;border-radius:var(--hwh-radius);background:var(--dsw-alias-bg-layer-1)}
.hwu-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.hwu-head-text{flex:1;min-width:200px}
.hwu-title{font-size:15px;font-weight:500}
.hwu-text{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:13px}
.hwu-text a,.hwu-note a{color:var(--dsw-alias-state-business-primary,var(--hwh-accent));margin-left:4px}
.hwu-actions{display:flex;gap:8px}
.hwu-btn{border:0;border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:inherit}
.hwu-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}
.hwu-notes{margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));max-height:240px;overflow-y:auto}
.hwu-note+.hwu-note{margin-top:16px}
.hwu-note-head{font-weight:500}
.hwu-note-date{margin-left:8px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.hwu-note h4{margin:8px 0 2px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.hwu-note p{margin:4px 0 0}
.hwu-note ul{margin:0;padding-left:18px}
.hwu-note li+li{margin-top:2px}
.hwu-note code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.hwu-line{display:flex;align-items:center;gap:8px;margin:-4px 0 20px;color:var(--dsw-alias-label-secondary);font-size:13px}
.hwu-show{padding:0;border:0;background:none;color:var(--dsw-alias-state-business-primary,var(--hwh-accent));font:inherit;cursor:pointer}
.hwu-rail{position:relative;display:inline-flex}
.hwu-dot{position:absolute;top:-2px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.hwu-dot[data-bad]{background:var(--dsw-alias-state-error-primary,#E5484D)}
button:has(.hwu-pill){position:relative}
.hwu-pill{position:absolute;top:50%;right:8px;transform:translateY(-50%);padding:0 7px;border-radius:9px;font-size:12px;line-height:18px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 12%,transparent);color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.hwu-pill[data-bad]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#E5484D) 12%,transparent);color:var(--dsw-alias-state-error-primary,#E5484D)}

/* 新设备请求连接 */
.hwh-pair{margin-bottom:24px;padding:16px 20px;border-radius:20px;background:color-mix(in srgb,#F5A524 16%,var(--dsw-alias-bg-layer-1));border:1px solid color-mix(in srgb,#F5A524 45%,transparent)}
.hwh-pair-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:4px 0}
.hwh-pair-code{font:700 30px/1 ui-monospace,Menlo,monospace;letter-spacing:6px;padding:10px 16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.hwh-pair-msg{flex:1;min-width:200px;display:flex;flex-direction:column;gap:2px}
.hwh-pair-msg small{opacity:.7}
.hwh-pair button{border:0;border-radius:12px;padding:10px 20px;font-size:15px;cursor:pointer;font-family:inherit}
.hwh-pair-ok{background:#2F9E6B;color:#fff}
.hwh-pair-no{background:transparent;color:inherit;opacity:.65}

/* 主入口：机器人 + 打开家长后台 */
.hwh-stage{position:relative;display:flex;align-items:center;gap:28px;padding:28px 32px;border-radius:24px;overflow:hidden;margin-bottom:40px;
  background:radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--hwh-sky) 22%,transparent),transparent 60%),var(--dsw-alias-bg-layer-1)}
.hwh-bot{flex:none;width:120px;display:flex;flex-direction:column;align-items:center}
.hwh-bot svg{display:block;width:120px;height:auto;image-rendering:pixelated;filter:drop-shadow(0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent));animation:hwh-bob 3.2s ease-in-out infinite}
.hwh-bot::after{content:"";width:76px;height:9px;margin-top:6px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);animation:hwh-shadow 3.2s ease-in-out infinite}
.hwh-sleep svg,.hwh-sleep::after{animation:none}
@keyframes hwh-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes hwh-shadow{0%,100%{transform:scaleX(1);opacity:1}50%{transform:scaleX(.86);opacity:.7}}
.hwh-say{flex:1;min-width:0}
.hwh-big{margin:0 0 6px;font-size:26px;line-height:1.25;font-weight:700;letter-spacing:-.02em}
.hwh-line{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px}
.hwh-main{display:inline-flex;align-items:center;gap:8px;margin-top:20px;padding:12px 22px;border-radius:14px;text-decoration:none;
  background:var(--hwh-blue);color:#fff;font-size:15px;font-weight:600;box-shadow:0 8px 20px -10px var(--hwh-blue);transition:transform .15s,opacity .15s}
.hwh-main:hover{transform:translateY(-1px)}
.hwh-main:active{transform:none;opacity:.85}
.hwh-main.hwh-off{opacity:.45;pointer-events:none;box-shadow:none}
.hwh-hint{margin:10px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}

/* 区块标题 */
.hwh-h2{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin:0 0 12px}
.hwh-h2 b{font-size:17px;font-weight:700;letter-spacing:-.01em}
.hwh-h2 span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.hwh-sec{margin:0 0 40px}

/* 对话入口：定制和维护 */
.hwh-ideas{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.hwh-idea{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:0;border-radius:16px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .15s}
.hwh-idea:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hwh-ic{flex:none;width:32px;height:32px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;color:var(--hwh-accent);background:color-mix(in srgb,var(--hwh-accent) 13%,transparent)}
.hwh-idea b{display:block;font-size:14px;font-weight:600}
.hwh-idea small{display:block;margin-top:2px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.hwh-free{display:flex;align-items:center;gap:8px;width:100%;margin-top:10px;padding:12px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.hwh-free:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
.hwh-idea[disabled],.hwh-free[disabled]{opacity:.4;cursor:default}

/* 运行状态：四格小卡 */
.hwh-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.hwh-stat{padding:12px 14px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.hwh-stat small{display:block;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hwh-stat b{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hwh-alert{display:flex;align-items:center;gap:12px;margin:10px 0 0;padding:10px 14px;border-radius:12px;font-size:13px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#F5A524) 12%,transparent)}
.hwh-alert span{flex:1}
.hwh-alert button{flex:none;border:0;padding:5px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}

/* 硬件操作说明 */
.hwh-manual.hwh-body{padding:16px 22px 20px;border-radius:18px;background:var(--dsw-alias-bg-layer-1)}

/* 操作说明里的表格和按键 */
.hwh-body{padding:0 2px 18px}
.hwh-body h3{margin:16px 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.hwh-body p{margin:0 0 6px;color:var(--dsw-alias-label-secondary)}
.hwh-table{width:100%;border-collapse:collapse}
.hwh-table td{padding:7px 0;vertical-align:top;border-top:.5px solid var(--dsw-alias-border-l2)}
.hwh-table tr:first-child td{border-top:0}
.hwh-table td:first-child{white-space:nowrap;width:140px;padding-right:12px;font-weight:500}
.hwh-key{display:inline-block;min-width:22px;padding:0 6px;margin:0 1px;border:.5px solid var(--dsw-alias-border-l2);border-bottom-width:1.5px;border-radius:6px;text-align:center;font-size:12px;line-height:20px;background:var(--dsw-alias-bg-layer-2)}
.hwh-list{margin:0;padding-left:18px;display:grid;gap:6px}

@media (max-width:640px){.hwh-page{padding:24px 18px 56px}.hwh-stage{flex-direction:column;text-align:center;padding:24px}.hwh-stats,.hwh-ideas{grid-template-columns:1fr 1fr}}
@media (prefers-reduced-motion:reduce){.hwh-bot svg,.hwh-bot::after{animation:none}}
`

    // ---- 图标（线条风格，跟随文字颜色）----
    const svg = (size, ...kids) => h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...kids)
    function RobotIcon({ size = 20 }) {
      return svg(size,
        h('rect', { x: 4, y: 8, width: 16, height: 11, rx: 3 }),
        h('path', { d: 'M12 8V4.5M10.5 4.5h3' }),
        h('circle', { cx: 9, cy: 13, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 13, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M9.5 16.5h5' }))
    }
    const CameraIcon = ({ size = 20 }) => svg(size,
      h('path', { d: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z' }),
      h('circle', { cx: 12, cy: 12.5, r: 3.2 }))

    // ---- 像素小机器人：和设备上同一份像素图（来自固件 gen_robot_art.py），侧身朝右 ----
    const ART = [
      '......KKKKKKKK........', '......KRRRRRRK........', '......KRRRRRRK........', '..KKKKKKKKKKKKKKKKK...',
      '.KWWWWgWWWWWWWWWWWWK..', 'KWWWWWWgWWWWWWWWWWWWK.', 'KWWWWWWgWWWWWWWWWWWWK.', 'KWWWWWWgWWWWWWWWWWWWK.',
      'KWWWWWWgWWWWWWWWWWWWWK', 'KWWWWWWgWWWWWWWWWWWWWK', '.KKKWWWgWWWWWWWWWWWWWK', '....KWWgWWKKKKKKKKKWWK',
      '.....KWgWWKKKKKKKKKWWK', '....KKWgWWKYYYKYYYKWWK', '...K..KgWWKYYYKYYYKWWK', '..KKKKKgWWKKKKKKKKKWWK',
      '..KWWWKKKKKKKKKKKKKKK.', '..KggWWKWWWWWWWWWWWK..', '..KggWWWKWWWWWWWWWWWK.', '..KKWWWWKBBBBBBBBBBBB.',
      '..KWKWWggKbbBbbBbbBbbB', '..KWWKKggKbbBbbBbbBbbB', '..KggggKKBbbBbbBbbBbbB', '...KggggBBBBBBBBBBBBB.',
      '....KWWWWWWWWWWWWK....', '.....KKKKKKKKKKKK.....', '........KggggKK.......', '.........KKKKK........',
    ]
    const INK = { K: '#23272E', W: '#F4F6F8', g: '#A7B2C0', R: '#E2483D', Y: '#111418', B: '#1F55A0', b: '#80C0E0' }
    // 眼睛：3×4 格，左右各一只（open 睁眼 / happy 开心 ^ ^ / sleep 睡着）
    const EYES = {
      open: [[0, 1, '#FFF4B0'], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
      happy: [[0, 2], [1, 1], [2, 2]],
      sleep: [[0, 3, '#B89A1E'], [1, 3, '#B89A1E'], [2, 3, '#B89A1E']],
    }
    function PixelBot({ mood = 'open', lamp = true }) {
      const cells = []
      ART.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.') return
        let fill = INK[ch]
        if (ch === 'R' && !lamp) fill = (y === 1 && (x === 9 || x === 10)) ? '#A9AFB7' : '#8C939C'
        else if (ch === 'R' && y === 1 && (x === 9 || x === 10)) fill = '#FFB347'
        cells.push(h('rect', { key: `${x}-${y}`, x, y, width: 1.02, height: 1.02, fill }))
      }))
      for (const ex of [11, 15]) for (const [dx, dy, c] of EYES[mood] || EYES.open)
        cells.push(h('rect', { key: `e${ex}-${dx}-${dy}`, x: ex + dx, y: 12 + dy, width: 1.02, height: 1.02, fill: c || '#F6D63C' }))
      return h('svg', { viewBox: `0 0 ${ART[0].length} ${ART.length}`, shapeRendering: 'crispEdges', role: 'img', 'aria-label': '小机器人' }, cells)
    }

    // ---- 状态：每 2 秒读一次本机服务（只读，不含令牌）----
    function useInfo() {
      const [state, setState] = React.useState({ status: 'checking' })
      const port = React.useMemo(() => Number(window.localStorage?.getItem('homework-helper.port')) || DEFAULT_PORT, [])
      React.useEffect(() => {
        let stop = false
        const tick = async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/api/info`)
            if (!r.ok) throw new Error(String(r.status))
            const info = await r.json()
            if (!stop) setState({ status: 'up', info })
          } catch { if (!stop) setState({ status: 'down' }) }
        }
        tick()
        const t = setInterval(tick, 2000)
        return () => { stop = true; clearInterval(t) }
      }, [port])
      return { ...state, port }
    }

    const VOICE_NAME = { chirp: '机械哔嘟声', azure: '微软 Azure 语音', custom: '自定义语音' }
    const ago = (s) => s >= 120 ? Math.round(s / 60) + ' 分钟' : s + ' 秒'

    // 对话入口卡片上的小图标
    const IDEA_ICON = {
      voice: () => svg(18, h('path', { d: 'M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2' })),
      chart: () => svg(18, h('path', { d: 'M4 20V10M10 20V4M16 20v-7M3 20h18' })),
      link: () => svg(18, h('path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' })),
      chip: () => svg(18, h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }), h('path', { d: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4' })),
    }

    // ---- 0. 新设备请求连接：设备屏幕上的 4 位码和这里一致，才点“允许”（出现时排在页面最上面） ----
    function PairCard({ info, port, refresh }) {
      const list = info?.pairing || []
      const [err, setErr] = React.useState('')
      if (!list.length) return null
      const act = async (kind, code) => {
        setErr('')
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/pair/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HW-Pair': '1' }, body: JSON.stringify({ code }) })
          if (!r.ok) throw new Error(String(r.status))
          refresh?.()
        } catch { setErr('没能完成操作。请重启一次 Harness 后再试；还不行，就在下面的“检查设备连接”里让 AI 帮你排查。') }
      }
      return h('section', { className: 'hwh-pair', role: 'alert' }, list.map((p) =>
        h('div', { key: p.code, className: 'hwh-pair-row' },
          h('span', { className: 'hwh-pair-code' }, p.code),
          h('div', { className: 'hwh-pair-msg' }, h('b', null, '有一台新设备请求连接'),
            h('small', null, '看看设备屏幕上的 4 位数字，和这里一样才点“允许”；不认识的设备点“拒绝”。')),
          h('button', { type: 'button', className: 'hwh-pair-ok', onClick: () => act('approve', p.code) }, '允许'),
          h('button', { type: 'button', className: 'hwh-pair-no', onClick: () => act('deny', p.code) }, '拒绝'))),
        err ? h('p', { className: 'hwh-hint' }, err) : null)
    }

    // ---- 1. 主入口：机器人 + 打开家长后台（家长日常都在后台里操作） ----
    function Stage({ status, info, port }) {
      const up = status === 'up'
      const online = up && info.device?.online
      const mood = up ? 'open' : 'sleep'
      return h('div', { className: 'hwh-stage' },
        h('div', { className: `hwh-bot${mood === 'sleep' ? ' hwh-sleep' : ''}` }, h(PixelBot, { mood, lamp: online })),
        h('div', { className: 'hwh-say' },
          h('div', { className: 'hwh-big' }, '家长后台'),
          h('p', { className: 'hwh-line' }, '上传作业截图、查看和调整今天的清单、看用时记录，都在这里。'),
          h('a', { className: `hwh-main${up ? '' : ' hwh-off'}`, href: `http://127.0.0.1:${port}`, target: '_blank', rel: 'noreferrer' }, '打开家长后台', h('span', { 'aria-hidden': true }, '↗')),
          up ? null : h('p', { className: 'hwh-hint' }, status === 'checking' ? '正在检查服务…' : '服务没在运行，后台暂时打不开。可以在下面开个对话让 AI 帮你排查。')))
    }

    // ---- 2. 对话入口：定制和维护 ----
    function Chat() {
      const ok = canChat()
      return h('section', { className: 'hwh-sec' },
        h('div', { className: 'hwh-h2' }, h('b', null, '让 AI 帮你改'), h('span', null, '想改功能、接自己的服务、排查连接或刷机时，在对话里说')),
        h('div', { className: 'hwh-ideas' }, chats.ideas.map((c) =>
          h('button', { key: c.title, type: 'button', className: 'hwh-idea', disabled: !ok, onClick: () => startChat(c.prompt) },
            h('span', { className: 'hwh-ic' }, IDEA_ICON[c.icon]()),
            h('span', null, h('b', null, c.title), h('small', null, c.sub))))),
        h('button', { type: 'button', className: 'hwh-free hwh-hero', disabled: !ok, onClick: () => startChat(chats.main.prompt) }, '＋ ', chats.main.title, '，说说你想怎么改'),
        ok ? null : h('p', { className: 'hwh-hint' }, '这个版本的 Harness 不支持从这里开对话，请点左上角“新会话”。'))
    }

    // ---- 3. 运行状态：四格小卡 + 有问题时一条提示（排查交给对话） ----
    const FIX_PROMPT = '作业助手好像出问题了，帮我排查一下：'
    function Status({ status, info, port }) {
      const up = status === 'up'
      const wait = status === 'checking' ? '检测中' : '等服务启动'
      const d = up ? info.device : null
      const device = !up ? ['', wait]
        : info.device === undefined ? ['warn', '看不到', '正在运行的服务是旧版本，重启一次 DeepSeek Harness 后才会显示设备状态。']
        : d?.online ? ['ok', '在线', null, `${d.last_seen_s} 秒前联系过`]
        : d?.last_seen_s != null ? ['bad', `${ago(d.last_seen_s)}没联系`, `设备从 ${d.last_seen_at} 起没再联系电脑，头灯会变灰。`]
        : ['warn', '还没连上过', '给设备通电、连好 Wi-Fi；第一次连接时，设备屏幕会出现 4 位配对码，本页最上方会出现“允许”按钮。']
      const alerts = []
      if (status === 'down') alerts.push('作业助手服务没在运行。')
      if (up && !info.asr.ready) alerts.push(`语音识别${info.asr.note || '启动中'}。第一次使用要下载约 230MB 的模型，下载完才能说话。`)
      if (device[2]) alerts.push(device[2])
      if (up && d?.rejected) alerts.push(`有 ${d.rejected} 次设备请求因令牌不对被拒绝。`)
      const stat = (label, kind, value, tip) => h('div', { key: label, className: 'hwh-stat', title: tip || undefined },
        h('small', null, label), h('b', null, kind != null ? h('i', { className: `hwh-dot${kind ? ` hwh-${kind}` : ''}` }) : null, value))
      const ok = canChat()
      return h('section', { className: 'hwh-sec' },
        h('div', { className: 'hwh-h2' }, h('b', null, '运行状态'), h('span', null, '自动刷新')),
        h('div', { className: 'hwh-stats' },
          stat('服务', up ? 'ok' : status === 'checking' ? '' : 'bad', up ? '运行中' : status === 'checking' ? '检测中' : '没连上', up ? `本机 ${port} 端口` : null),
          stat('设备', device[0], device[1], device[3]),
          stat('语音识别', !up ? '' : info.asr.ready ? 'ok' : 'warn', !up ? wait : info.asr.ready ? '已就绪' : '准备中', up ? '在本机识别，录音不上传' : null),
          stat('机器人声音', null, up ? (VOICE_NAME[info.voice] || info.voice) : wait)),
        alerts.map((a) => h('div', { key: a, className: 'hwh-alert' }, h('span', null, a),
          ok ? h('button', { type: 'button', onClick: () => startChat(FIX_PROMPT + a) }, '让 AI 排查') : null)))
    }

    function Table({ rows }) {
      return h('table', { className: 'hwh-table' }, h('tbody', null, rows.map(([a, b], i) =>
        h('tr', { key: i }, h('td', null, a), h('td', null, b)))))
    }

    // ---- 4. 硬件操作说明 ----
    function Manual() {
      return h('section', { className: 'hwh-sec' },
        h('div', { className: 'hwh-h2' }, h('b', null, '硬件操作说明'), h('span', null, '设备屏幕上没有操作说明，可以打印出来教孩子')),
        h('div', { className: 'hwh-manual hwh-body' },
          h('p', null, '▲ ▼ 是设备上的上下键，确定是中间的键。'),
          keyTable.map((g) => h('div', { key: g.title }, h('h3', null, g.title), h(Table, { rows: g.rows }))),
          h('h3', null, '跟小机器人说话（按住确定键，出现“录音中”再说，说完松手）'),
          h('ul', { className: 'hwh-list' }, sayings.map((s) => h('li', { key: s }, s))),
          h('h3', null, '看懂小机器人'),
          h(Table, { rows: robotSigns })))
    }

    // ---- 插件更新：和“作品”页同一套体验。电脑端服务（/api/update）告诉我们有没有新版本和更新日志，
    //      点“更新”用 Harness 的插件管理器安装新版，装好后重启 Harness 生效 ----
    const UPD_HUB = Symbol.for('albis-aipassport-homework/updates')
    const DISMISSED_KEY = 'albis-aipassport-homework.update.dismissed'
    const CHANGELOG_URL = 'https://github.com/albisjee25/albis-aipassport-homework/releases'
    const portOf = () => Number(window.localStorage?.getItem('homework-helper.port')) || DEFAULT_PORT
    const readDismissed = () => { try { return window.localStorage?.getItem(DISMISSED_KEY) ?? '' } catch { return '' } }
    const hub = () => (globalThis[UPD_HUB] ??= { state: { updates: [], notes: [], phase: 'idle', restart: false, failure: null, dismissed: readDismissed() }, listeners: new Set() })
    const setUpd = (patch) => { const x = hub(); x.state = { ...x.state, ...patch }; for (const l of [...x.listeners]) l() }
    const useUpd = () => {
      const sub = (l) => { hub().listeners.add(l); return () => hub().listeners.delete(l) }
      const snap = () => hub().state
      return React.useSyncExternalStore ? React.useSyncExternalStore(sub, snap) : snap()
    }
    let pluginManager
    async function readUpdates(refresh) {
      try {
        const r = await fetch(`http://127.0.0.1:${portOf()}/api/update${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
        if (!r.ok) return null
        const { updates, notes } = await r.json()
        return Array.isArray(updates) ? { updates, notes: Array.isArray(notes) ? notes : [] } : null
      } catch { return null }
    }
    async function lookForUpdates() {
      const a = await readUpdates(false)
      if (a && hub().state.phase !== 'running') setUpd({ updates: a.updates, notes: a.notes })
    }
    const failReason = (o) => {
      const refused = o.error?.incompatible?.[0]
      if (refused) return `${refused.name}@${refused.version} 要求 ${Object.entries(refused.requirements).map(([k, v]) => `${k} ${v}`).join('、')}`
      const lines = (o.error?.diagnostic ?? '').split('\n').map((x) => x.trim()).filter(Boolean)
      return (lines.find((x) => x.includes('ERR_')) ?? lines.at(-1) ?? o.error?.code ?? o.application ?? '未知原因').slice(0, 240)
    }
    async function installOne(manager, plugin, requestId) {
      const a = await manager.installBundle(plugin.spec, { enabled: plugin.enabled, registry: plugin.registry, requestId })
      if (a.ok) return a.value
      const again = await manager.waitForInstall(requestId)
      if (again.ok && again.value !== null) return again.value
      return { application: 'failed', error: { diagnostic: a.error?.message ?? 'Harness 没有回应' } }
    }
    async function startUpdate() {
      const { phase, updates } = hub().state
      if (phase === 'running' || updates.length === 0) return
      if (!pluginManager) return setUpd({ phase: 'failed', failure: { message: '这个版本的 Harness 不支持在这里更新，请到“插件”里更新。' } })
      setUpd({ phase: 'running', failure: null })
      const fresh = await readUpdates(true)
      const plugin = (fresh?.updates ?? hub().state.updates)[0]
      if (!plugin) return setUpd({ phase: 'idle', updates: [], notes: [] })
      let outcome
      try { outcome = await installOne(pluginManager, plugin, `homework-update-${Date.now()}`) } catch (e) { outcome = { application: 'failed', error: { diagnostic: e.message } } }
      const already = outcome.application === 'failed' && outcome.error?.code === 'already-installed'
      if ((outcome.application === 'failed' || outcome.application === 'cancelled') && !already) {
        return setUpd({ phase: 'failed', failure: { message: failReason(outcome) } })
      }
      setUpd({ phase: 'done', updated: plugin, updates: [], restart: outcome.application === 'restart-required' })
      void lookForUpdates()
    }
    const laterUpd = () => {
      const v = hub().state.updates[0]?.latest ?? ''
      try { window.localStorage?.setItem(DISMISSED_KEY, v) } catch { /* 存不了就算了，下次还会提示 */ }
      setUpd({ dismissed: v })
    }
    const closeUpd = () => setUpd({ phase: 'idle', failure: null, updated: undefined })
    const reopenUpd = () => { try { window.localStorage?.removeItem(DISMISSED_KEY) } catch { /* 同上 */ } setUpd({ dismissed: '' }) }

    // 更新日志里只认这几种写法：### 小标题、- 列表、**粗体**、`代码`、[文字](链接)
    function inlineMd(text) {
      const out = []
      let at = 0
      for (const m of text.matchAll(/\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
        if (m.index > at) out.push(text.slice(at, m.index))
        if (m[1] !== undefined) out.push(h('strong', { key: m.index }, m[1]))
        else if (m[2] !== undefined) out.push(h('code', { key: m.index }, m[2]))
        else out.push(h('a', { key: m.index, href: m[4], target: '_blank', rel: 'noreferrer' }, m[3]))
        at = m.index + m[0].length
      }
      if (at < text.length) out.push(text.slice(at))
      return out
    }
    function noteBlocks(body) {
      const blocks = []
      let items = []
      const flush = () => { if (items.length) blocks.push(h('ul', { key: blocks.length }, items.map((x, i) => h('li', { key: i }, inlineMd(x))))); items = [] }
      for (const line of String(body).split('\n')) {
        const li = /^\s*[-*]\s+(.*)$/.exec(line)
        if (li) { items.push(li[1]); continue }
        flush()
        const hd = /^#{1,6}\s+(.*)$/.exec(line)
        if (hd) blocks.push(h('h4', { key: blocks.length }, inlineMd(hd[1])))
        else if (line.trim()) blocks.push(h('p', { key: blocks.length }, inlineMd(line.trim())))
      }
      flush()
      return blocks
    }

    // 页面最上方的更新横幅
    function UpdatePanel() {
      const { phase, updates, notes, restart, failure, dismissed, updated } = useUpd()
      const u = updates[0]
      if (phase === 'idle' && !u) return null
      if (phase === 'idle' && u.latest === dismissed) {
        return h('div', { className: 'hwu-line' }, h('span', null, `作业助手有新版本 ${u.latest}`), h('button', { type: 'button', className: 'hwu-show', onClick: reopenUpd }, '查看'))
      }
      let title, text = null, actions = null
      if (phase === 'running') title = '正在更新作业助手…'
      else if (phase === 'done') {
        title = `作业助手已更新到 ${updated?.latest ?? ''}`
        text = restart ? '重启 DeepSeek Harness 后生效。' : '新版本已就绪。'
        actions = h('button', { type: 'button', className: 'hwu-btn', onClick: closeUpd }, '关闭')
      } else if (phase === 'failed') {
        title = '作业助手更新失败'
        text = `${failure?.message ?? ''} 原来的版本还能继续用。`
        actions = [h('button', { key: 'c', type: 'button', className: 'hwu-btn', onClick: closeUpd }, '关闭'),
          u ? h('button', { key: 'r', type: 'button', className: 'hwu-btn hwu-primary', onClick: startUpdate }, '重试') : null]
      } else {
        title = `作业助手 插件有新版本 ${u.latest}`
        text = [`当前是 ${u.version}。`, h('a', { key: 'a', href: CHANGELOG_URL, target: '_blank', rel: 'noreferrer' }, '更新日志')]
        actions = [h('button', { key: 'l', type: 'button', className: 'hwu-btn', onClick: laterUpd }, '稍后'),
          h('button', { key: 'u', type: 'button', className: 'hwu-btn hwu-primary', onClick: startUpdate }, '更新')]
      }
      return h('section', { className: 'hwu-panel', role: phase === 'failed' ? 'alert' : 'status', 'data-phase': phase },
        h('div', { className: 'hwu-head' },
          h('div', { className: 'hwu-head-text' }, h('div', { className: 'hwu-title' }, title), text ? h('div', { className: 'hwu-text' }, text) : null),
          actions ? h('div', { className: 'hwu-actions' }, actions) : null),
        phase === 'idle' && notes.length
          ? h('div', { className: 'hwu-notes', tabIndex: 0 }, notes.map((n) => h('div', { key: n.version, className: 'hwu-note' },
              h('div', { className: 'hwu-note-head' }, n.version, n.date ? h('span', { className: 'hwu-note-date' }, n.date) : null),
              noteBlocks(n.zh))))
          : null)
    }

    // 侧边栏入口旁的小标记：宽的（带文字）显示“更新”标签，窄的（只有图标）显示小圆点
    function UpdateMark({ wide, children }) {
      const { phase, updates, restart, dismissed } = useUpd()
      const mark = phase === 'running' ? '更新中' : phase === 'failed' ? '更新失败' : phase === 'done' && restart ? '待重启'
        : updates[0] && updates[0].latest !== dismissed ? '更新' : null
      if (!mark) return children
      const bad = mark === '更新失败' ? '1' : undefined
      if (wide) return h(React.Fragment || 'span', null, children, h('span', { className: 'hwu-pill', 'data-bad': bad }, mark))
      return h('span', { className: 'hwu-rail' }, children, h('span', { className: 'hwu-dot', 'data-bad': bad }))
    }

    function Body() {
      const s = useInfo()
      const pill = s.status === 'checking' ? ['', '检测中…'] : s.status === 'up' ? ['hwh-ok', '运行中'] : ['hwh-bad', '没连上服务']
      return [
        h('div', { key: 'h', className: 'hwh-top' }, h(RobotIcon, { size: 20 }), h('h1', null, '作业助手'),
          h('span', { className: `hwh-pill ${pill[0]}` }, h('i', { className: 'hwh-dot' }), pill[1])),
        h(UpdatePanel, { key: 'upd' }),
        h(PairCard, { key: 'pair', ...s }),
        h(Stage, { key: 'stage', ...s }),
        h(Chat, { key: 'c' }),
        h(Status, { key: 'st', ...s }),
        h(Manual, { key: 'manual' }),
      ]
    }

    function Page() {
      return h('div', { className: 'hwh-page' },
        h('style', null, css),
        h('div', { className: 'hwh-wrap' }, h(Body)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        CTX = ctx
        // 定时看有没有新版本；拿 Harness 的插件管理器用来安装（和“作品”页一样）
        ctx.effect?.(() => {
          const first = setTimeout(() => void lookForUpdates(), 3000)
          const every = setInterval(() => void lookForUpdates(), 6 * 60 * 60 * 1000)
          return () => { clearTimeout(first); clearInterval(every) }
        }, 'albis-aipassport-homework: looking for updates')
        ctx.inject?.(['remote', 'remote.pluginManager'], (sub) => {
          pluginManager = sub.remote.pluginManager
          sub.effect(() => () => { pluginManager = undefined }, 'albis-aipassport-homework: the plugin manager')
        })
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID }, Page))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: ID, order: 30, label: '作业助手' },
          (props) => { const size = typeof props?.size === 'number' ? props.size : 20; return h(UpdateMark, { wide: size <= 16 }, h(RobotIcon, { size })) }))
      },
    }
  },
})
