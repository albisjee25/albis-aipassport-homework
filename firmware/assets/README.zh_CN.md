<p align="right">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

# 资源目录（Assets）

本目录集中存放可复用的资源（字库、图片、音乐、电池参数等），按资源类型分子目录管理。每个资源放在其类型对应的子目录，并记录放置路径、命名方式、集成方式与来源/许可。二进制资源（字体、图片、音频）不属于纯 markdown 文档，请勿与文档混放。涉及版权/授权的资源需注明来源与许可。

## 字库（fonts）

可复用的字库文件与生成的字库源码放在 `fonts/`。

- 命名要能反映字族、字重、字级与格式。
- 记录来源、许可、字符范围、转换命令与目标放置路径。
- 添加字库前评估 Flash 与内部 RAM 影响；ESP32-C3 无 PSRAM。
- 不提交许可不允许分发的字库。

### 作业助手像素字体

| 文件 | 说明 |
| --- | --- |
| [`fonts/homework/hw_font_24.c`](fonts/homework/hw_font_24.c) | 24 px（2 倍）、1 bpp：可打印 ASCII、界面符号和 [`charset_gb2312.txt`](fonts/homework/charset_gb2312.txt) 中的 GB2312 汉字（共 6770 个字形；源字体缺少 116 个 GB2312 生僻字，会显示为占位框） |
| [`fonts/homework/hw_font_48.c`](fonts/homework/hw_font_48.c) | 48 px（4 倍）、1 bpp：倒计时用的数字和冒号 |

来源：[缝合像素字体 Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font) 2026.10.25 版的
`fusion-pixel-12px-proportional-zh_hans.ttf`，SIL Open Font License 1.1
（[`fonts/homework/OFL.txt`](fonts/homework/OFL.txt)）。作业标题来自家长截图，是任意文字，
所以 24 px 字体覆盖全部 GB2312，而不是固定的界面子集。用
[`fonts/homework/gen_fonts.sh`](fonts/homework/gen_fonts.sh)（lv_font_conv 1.5.3）重新生成。
约占 400 KB Flash，由 `main/CMakeLists.txt` 编译。

## 图片（images）

可复用的源图与生成的显示资产放在 `images/`。

| 文件 | 尺寸与格式 | 用途与来源 |
| --- | --- | --- |
| [`images/home.jpg`](images/home.jpg) | 3840 × 2160，JPEG | 嵌入中英文项目 README 的产品主图，突出 AI Passport 产品形象与开放、人人可创作的理念。 |
| [`images/readme-hardware-specs.png`](images/readme-hardware-specs.png) | 2172 × 724，PNG RGBA | 保留为可选技术参考图，不再用于首页主视觉。于 2026-09-17 使用内置图像生成工具为本仓库生成；已根据文档中的硬件能力契约核对图中的六项标签与参数。 |
| [`images/logo-wordmark.png`](images/logo-wordmark.png) | 1648 × 336，PNG RGBA | 从仓库原始 `images/logo.png` 中精确裁切并去除背景的黑色字标；用于中英文项目 README 的浅色主题。 |
| [`images/logo-wordmark-dark.png`](images/logo-wordmark-dark.png) | 1648 × 336，PNG RGBA | 提取字标的白色版本；README 使用 `<picture>` 在 GitHub 深色主题下显示。 |

- 使用描述性命名，并记录尺寸、像素格式、转换步骤与目标路径。
- 优先采用适合 240 × 320 RGB565 显示的格式，并纳入 Flash 与内部 RAM 考量。
- 许可允许时保留可编辑源文件，并记录来源与许可。
- 图片中不得包含设备二维码秘密、凭证或个人数据。

### 作业助手小机器人

[`images/homework/gen_robot_art.py`](images/homework/gen_robot_art.py) 在小网格上把机器人画成零件
（带面罩的机身、8 种眼睛、头灯亮/灭、3 帧滚刷），放大 3 倍，生成 `main/hw_robot_art.c` /
`main/hw_robot_art.h`（LVGL RGB565A8）和预览图 [`images/homework/robot-preview.png`](images/homework/robot-preview.png)。
设备把零件组合成各种表情（待机、专注、思考、开心、着急、聆听、睡着）。这是为本家庭原创的像素画，
灵感来自皮克斯《机器人总动员》中的 M-O；如要发布到玩法社区，需要先换成原创角色。

## 音乐与音效（music）

可复用的音乐与音效源码放在 `music/`。

- 记录来源、许可、采样率、位深、声道、转换命令与目标路径。
- 与当前 BSP 音频路径匹配时优先采用 16 kHz、16 位单声道 PCM。
- 嵌入音频前评估 Flash 与内部 RAM 成本；长录音应流式或分块。
- 无再分发许可不提交媒体文件。

### 作业助手机器人语音

`main/assets/voice/*.pcm` 是 10 句固定提示语（快到时间、时间到、完成等），格式为 16 kHz、16 位单声道原始
PCM，共约 490 KB，通过 `EMBED_FILES` 嵌入固件，Mac 关着也能提醒。由家庭中转服务的
`tools/gen_device_voice.py` 用微软 Azure 语音合成（`zh-CN-Yunxia:DragonHDFlashLatestNeural`，
音调 +18%、语速 +15%）加本地机器人音效生成，同时生成 `main/hw_voice.h`。
使用家长自己的 Azure 账号合成，仅供本家庭使用。

## 电池参数（battery）

[`battery/wanli-500mah-profile2-xil40x-20261020.txt`](battery/wanli-500mah-profile2-xil40x-20261020.txt)
保存万锂新能源 500 mAh 电芯的 CW2017 参数（profile2、XIL40X、2026-10-20）。
该文件是项目提供的 `喜梨_智能工卡_万锂新能源500mAh_profile2_XIL40X_20261020.txt`
的原样副本，按维护者要求保留用于本次固件更新；原文件没有附带单独的许可说明。

格式为 80 行两位十六进制数字，每行一个字节，按寄存器顺序排列。
BSP 在 `components/bsp/src/bsp_battery.c` 中嵌入这 80 字节，主机检查会验证
源文件及数组内容完全一致。文本文件 SHA-256：
`7ea96eba4634f4495a37c25ffacd54c1deaa0693b162c892d671a2ba68460919`。
解码后 80 字节 SHA-256：
`fa7365671093ef449c5bdcfb4adb279e3d275f888109f50b6b2f21e9b96220d5`。
这是电量计参数，不是充电配置，也不能通用于所有 500 mAh 电芯；详见
[硬件指南](../docs/hardware-design/AI_HARDWARE_DEVELOPMENT_GUIDE.zh_CN.md#9-cw2017-电池计)。
