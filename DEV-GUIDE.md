# 作业助手开发说明（给 Harness 对话里的 AI 看）

家长在插件页点“让 AI 帮你改”进来时，要做的是**定制和维护**：改功能、接自己的服务、排查连接、改设备设置或刷机。日常管理作业（上传截图、改清单、看用时）请引导家长去家长后台 `http://127.0.0.1:8787`，不要在对话里代劳。

家长不会写代码。先用一两句话说清楚你打算改什么、会影响什么，等家长同意再动手；做完用大白话说明结果和没验证的地方。

## 必须遵守

1. **刷机前必须得到家长明确同意**（“可以刷”）。设备没插好、家长没回复，都不要刷。
2. **密钥和令牌不进对话**：不要让家长把密钥贴进对话，也不要把设备令牌、密钥打印到回复里。密钥填在 Harness 插件设置页（带锁的字段）。
3. **不自动删除文件**。要删先说明是什么、为什么删，等家长同意。
4. 改代码前先看 git 状态，在新分支上改，改完要能退回；不在 git 里的文件，改之前先复制一份备份。
5. 孩子的作业记录和录音属于隐私，只留在这台电脑，不要上传或发到外部服务。
6. 如果插件目录里有 `MAINTAINER.local.md`，说明这是维护者本人的电脑：先读它，里面的路径和流程优先。

## 项目地图

源码仓库：https://github.com/albisjee25/albis-aipassport-homework（插件在仓库根目录，设备固件在 `firmware/`）。

| 部分 | 位置 | 说明 |
|---|---|---|
| Harness 插件（电脑端服务） | 这份说明所在的目录。从插件市场装的在 `~/.dsh/profiles/<配置名>/node_modules/albis-aipassport-homework/` | Node 写的，Harness 启动时自动运行，端口 8787 |
| 设备固件 | 源码仓库的 `firmware/` 目录。插件市场装的包里**不含固件**，需要时把仓库克隆到本机，例如 `git clone https://github.com/albisjee25/albis-aipassport-homework.git ~/albis-aipassport-homework` | ESP-IDF 项目，基于 FoloToy 官方 ai-passport（MIT 协议） |
| 数据目录 | `~/.dsh/homework-helper/` | 作业清单、用时记录、短语库、设备令牌 `device_token`、语音模型 |

插件里的主要文件：

| 文件 | 作用 |
|---|---|
| `index.js` | 入口：读设置、启动服务、注册对话工具；插件设置项（端口、模型、年级、声音）也在这里定义 |
| `client.js` | Harness 侧边栏里的插件页面 |
| `admin.html` | 家长后台网页（今日作业、截图上传、用时记录、短语库）；`/test` 是测试页 |
| `lib/server.js` | 网页和设备用的接口。`/api/device/*` 给设备用，要带令牌 |
| `lib/app.js`、`lib/store.js` | 作业清单的规则（谁能删、改时间、完成） |
| `lib/durations.js` | 用时统计：怎么记录、怎么算平均、新作业时长怎么定 |
| `lib/prompts.js` | 截图识别、语音理解、作业归类的提示词（措辞改动要谨慎；`{grade}` 会换成设置里的年级） |
| `lib/asr.js` | 本机语音识别（SenseVoice） |
| `lib/voice.js`、`voice/` | 机器人的声音：`chirp.js` 哔嘟声（默认）、`azure.js` 微软语音示例；接入方法见 `voice/README.md` |
| `lib/tools.js` | 你在对话里能用的作业工具（`homework_list`、`homework_status`、`homework_dev_guide` 等） |
| `scripts/device-config.mjs` | 生成固件的连接配置 `main/hw_secrets.h`（电脑名、备用 IP、端口、令牌） |
| `test/` | 测试，改完运行 `npm test`（只在源码仓库里有） |

改完插件后：运行 `npm test` 全部通过，再请家长**重启 DeepSeek Harness** 才会生效。从插件市场装的插件，直接改安装目录里的文件会在下次更新时被覆盖；要长期改，请在源码仓库里改。

## 常见任务

### 接入自己的语音合成

1. 先读 `voice/README.md`，照 `voice/azure.js` 的写法新建一个声音文件，导出 `synthesize(text, { mood, config })`。
2. 密钥字段放在插件设置的 `voice` 一组里，由家长自己在插件设置页填，不要写进代码。
3. 在插件设置里把 `voice.provider` 改成 `custom`，`voice.customModule` 填文件的绝对路径。
4. 重启 Harness 后，在测试页 `http://127.0.0.1:8787/test` 让机器人说一句话验证。合成失败时设备只显示文字，不会出错。

### 修改统计报表

- 统计规则在 `lib/durations.js`，接口是 `/api/durations`（`lib/server.js`），后台展示在 `admin.html` 的“用时记录”一节。
- 规则：只记倒计时真正走过的时间，只有标了“做完了”才记；同类作业由 AI 每天统一归类。改规则前先和家长确认，并同步 PRD。

### 检查设备连接

1. 先调用 `homework_status` 看服务、语音识别、声音状态（注意：它的结果里有设备令牌，不要把令牌复述给家长）。
2. 读 `http://127.0.0.1:8787/api/info` 的 `device` 一项：`online` 是否在线、`last_seen_s` 多久没联系、`rejected` 是否有令牌不对被拒绝。
3. 常见原因：设备和电脑不在同一个 2.4G Wi-Fi；电脑换了 IP 或改了电脑名（重新生成连接配置并刷机）；固件里的令牌和 `~/.dsh/homework-helper/device_token` 不一致；端口 8787 被别的程序占用（`lsof -i :8787` 可查）。
4. 设备没配过网：开机后长按 ▲ 进入配网，用“蓝牙配网-FoloToy AI PASSPORT”小程序配网。

### 修改设备设置或功能、刷机

1. **先读官方资料**（见下一节），尤其是固件目录里的 `AGENTS.md`、`docs/README.md`、`docs/development/ai-guide.zh_CN.md`，以及 `skills/` 下的 `passport-*` Skill（环境、开发、构建、调试、设备测试），按官方说明安装这些 Skill。
2. **生成连接配置**（第一次编译前必须做，电脑换了网络或名字后也要重做）：
   `node <插件目录>/scripts/device-config.mjs <固件目录>`
   它把电脑名、备用 IP、端口和设备令牌写进 `main/hw_secrets.h`。这个文件不进 git，里面有令牌，不要打印内容。
3. 作业助手相关代码都是 `main/hw_*.c`；界面在 `hw_ui.c`，机器人像素图由 `assets/images/homework/gen_robot_art.py` 生成（不要手改 `hw_robot_art.c`）。
4. 改界面可以先用电脑预览，不用刷机：`bash tools/ui_preview/preview.sh`，结果在 `build/ui_preview/frames/index.html`。
5. 构建环境：ESP-IDF v5.5.3（官方说明见 `docs/`）。没有时按官方文档安装；国内网络可用乐鑫的国内镜像。
   ```
   . <ESP-IDF 目录>/export.sh
   idf.py build
   ```
   macOS 上运行 `tools/validate.sh` 时，主机测试可能提示链接器不支持 `--gc-sections`，这是已知差异，不影响固件构建。
6. 刷机（**先得到家长同意**）。设备串口用 `ls /dev/cu.usbmodem*`（macOS）查：
   - **已经装过作业助手、只是更新**：只刷程序区，保留设备里的 Wi-Fi 设置，刷完不用重新配网：
     `python -m esptool --chip esp32c3 -p <串口> -b 460800 write_flash 0x10000 build/FoloToy-AI-Passport.bin`
   - **第一次装作业助手**：从 0x0 写入整个合并固件 `build/FoloToy-AI-Passport-full.bin`（也可以用官方网页刷机工具），会覆盖设备全部内容。刷完设备会进入配网，用“蓝牙配网-FoloToy AI PASSPORT”小程序配网（只支持 2.4G Wi-Fi）。
7. 已知问题：清单页 ▲ 键偶尔不灵（按键电压判断的问题，原因待确认）。

## 官方硬件开发资料（AI Passport / FoloToy）

需要了解硬件能力、开发规范、刷机和恢复方法时，先查这些（可以联网阅读）：

| 资料 | 地址 |
|---|---|
| 全部教程 | https://ai-passport.folotoy.cn/guides/ |
| 快速上手 | https://ai-passport.folotoy.cn/guides/getting-started/ |
| 用 DeepSeek Harness 开发玩法 | https://ai-passport.folotoy.cn/guides/create-a-play-with-deepseek-harness/ |
| 创造自己的玩法 | https://ai-passport.folotoy.cn/guides/create-your-own-play/ |
| 恢复默认固件 | https://ai-passport.folotoy.cn/guides/restore-factory-firmware/ |
| 网页刷机工具（本地玩法安装） | https://ai-passport.folotoy.cn/tools/web-flasher/ |
| 固件源码（国内镜像） | https://gitee.com/FoloToy/ai-passport |
| 固件源码（GitHub） | https://github.com/FoloToy/ai-passport |
| ESP-IDF v5.5 ESP32-C3 文档 | https://docs.espressif.com/projects/esp-idf/en/release-v5.5/esp32c3/ |

官方给 AI 的开发要求（摘自教程）：先读 `AGENTS.md` 和 `docs/README.md`，按需查阅硬件接口和示例；保留已有修改，新建分支开发；复用 BSP；中文界面检查字体覆盖；运行项目验证并说明未验证项；**未经确认不烧录**。

## 设备硬件速记

ESP32-C3，2 寸屏，3 个按键（▲、确定、▼，共用一根 ADC 线按电压区分），喇叭和麦克风，电池。设备通过 Wi-Fi 访问这台电脑的 8787 端口，请求头带 `X-Device-Token`。
