<p align="right">
  <a href="README.zh_CN.md">简体中文</a> · <strong>English</strong>
</p>

# Assets

This directory stores reusable fonts, images, music, sound effects, and battery profiles, organized by asset type.

Keep each asset in the matching subdirectory and document its destination, naming, integration method, and source/license. Do not mix binary assets with Markdown documentation.

## Fonts

Store reusable font files and generated font sources in `fonts/`.

- Use descriptive names that include the family, weight, size, and format when relevant.
- Document the source, license, character range, conversion command, and expected destination.
- Check Flash and internal-RAM impact before adding a font; the ESP32-C3 has no PSRAM.
- Do not commit fonts whose license does not permit redistribution.

### Homework helper pixel fonts

| File | Details |
| --- | --- |
| [`fonts/homework/hw_font_24.c`](fonts/homework/hw_font_24.c) | 24 px (2x), 1 bpp: printable ASCII, UI symbols and the GB2312 hanzi in [`charset_gb2312.txt`](fonts/homework/charset_gb2312.txt) (6,770 glyphs; 116 rare GB2312 characters are absent from the source font and show as placeholders) |
| [`fonts/homework/hw_font_48.c`](fonts/homework/hw_font_48.c) | 48 px (4x), 1 bpp: digits and colon for the countdown |

Source: [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font) release 2026.10.25,
`fusion-pixel-12px-proportional-zh_hans.ttf`, SIL Open Font License 1.1
([`fonts/homework/OFL.txt`](fonts/homework/OFL.txt)). Task titles are arbitrary text from the
parent's screenshots, so the 24 px font covers all of GB2312 rather than a fixed UI subset.
Regenerate with [`fonts/homework/gen_fonts.sh`](fonts/homework/gen_fonts.sh) (lv_font_conv 1.5.3).
About 400 KB of Flash; compiled from `main/CMakeLists.txt`.

## Images

Store reusable source images and generated display assets in `images/`.

| File | Dimensions and format | Use and source |
| --- | --- | --- |
| [`images/home.jpg`](images/home.jpg) | 3840 × 2160, JPEG | Product hero image embedded in both project README files to foreground AI Passport and its open, maker-oriented identity. |
| [`images/readme-hardware-specs.png`](images/readme-hardware-specs.png) | 2172 × 724, PNG RGBA | Optional technical infographic retained as a reference asset; it is no longer used as the homepage hero. Generated for this repository with the built-in image generation tool on 2026-09-17; the six labels and values were checked against the documented hardware contract. |
| [`images/logo-wordmark.png`](images/logo-wordmark.png) | 1648 × 336, PNG RGBA | Transparent black wordmark extracted from the repository's original `images/logo.png`; embedded in both project README files for light backgrounds. |
| [`images/logo-wordmark-dark.png`](images/logo-wordmark-dark.png) | 1648 × 336, PNG RGBA | White version of the extracted wordmark, used by the README `<picture>` element when GitHub is in dark mode. |

- Use descriptive names and document dimensions, pixel format, conversion steps, and destination.
- Prefer formats suitable for the 240 × 320 RGB565 display and account for Flash and internal RAM.
- Preserve editable sources where licensing permits, and record the source and license.
- Never commit device QR secrets, credentials, or personal data in images.

### Homework helper robot

[`images/homework/gen_robot_art.py`](images/homework/gen_robot_art.py) draws the robot as parts on
small grids (body with visor, eight eye shapes, head lamp on/off, three roller-brush frames), scales
them 3x and writes `main/hw_robot_art.c` / `main/hw_robot_art.h` (LVGL RGB565A8) plus the review
sheet [`images/homework/robot-preview.png`](images/homework/robot-preview.png). The device combines
the parts into expressions (idle, focus, think, happy, worried, listen, sleep). Original pixel art
for this household, inspired by M-O from Pixar's WALL-E; do not publish it as a community play
without replacing the character with an original design.

## Music and sound effects

Store reusable music and sound-effect sources in `music/`.

- Document the source, license, sample rate, bit depth, channels, conversion command, and destination.
- Prefer 16 kHz, 16-bit mono PCM when it matches the current BSP audio path.
- Check Flash and internal-RAM cost before embedding audio; stream or chunk long recordings.
- Do not commit media without redistribution permission.

### Homework helper robot phrases

`main/assets/voice/*.pcm` holds ten fixed phrases (reminders, time up, done, and so on) as raw
16 kHz 16-bit mono PCM, about 490 KB in total, embedded with `EMBED_FILES` so reminders work
without the parent's Mac. They are synthesized with Microsoft Azure Speech
(`zh-CN-Yunxia:DragonHDFlashLatestNeural`, pitch +18 %, rate +15 %) and a local robot effect, by
the household relay's `tools/gen_device_voice.py`, which also writes `main/hw_voice.h`.
Synthesized for this household's personal use under the parent's own Azure account.

## Battery profiles

[`battery/wanli-500mah-profile2-xil40x-20261020.txt`](battery/wanli-500mah-profile2-xil40x-20261020.txt)
contains the supplied CW2017 profile for the Wanli New Energy 500 mAh cell
(profile2, XIL40X, 2026-10-20). It is an unchanged copy of the project-supplied
file, retained at the maintainer's request for this firmware update. Its
original filename is recorded in the paired Chinese document. No separate
license was included in the supplied file.

The format is 80 lines of two hexadecimal digits, one byte per line in register
order. The BSP embeds those bytes in `components/bsp/src/bsp_battery.c`; the
host gate checks the source file and initializer for an exact match. Text-file
SHA-256: `7ea96eba4634f4495a37c25ffacd54c1deaa0693b162c892d671a2ba68460919`.
Decoded 80-byte SHA-256:
`fa7365671093ef449c5bdcfb4adb279e3d275f888109f50b6b2f21e9b96220d5`.
This is a fuel-gauge profile, not a charging configuration or a generic profile
for every 500 mAh cell; see the [hardware guide](../docs/hardware-design/AI_HARDWARE_DEVELOPMENT_GUIDE.md#9-cw2017-fuel-gauge).
