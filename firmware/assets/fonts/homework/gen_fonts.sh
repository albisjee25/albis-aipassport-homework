#!/usr/bin/env bash
# Regenerate the homework helper's pixel fonts from Fusion Pixel Font (OFL-1.1).
#   FONT=/path/to/fusion-pixel-12px-proportional-zh_hans.ttf LV_FONT_CONV=/path/to/lv_font_conv \
#   assets/fonts/homework/gen_fonts.sh
# Release: https://github.com/TakWolf/fusion-pixel-font/releases/tag/2026.10.25 · lv_font_conv 1.5.3
# 24 px = 2x the 12 px design, 1 bpp, so pixels stay square. Task titles are arbitrary
# Chinese, so hw_font_24 covers ASCII + all GB2312 hanzi (charset_gb2312.txt).
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${FONT:?set FONT}"
conv="${LV_FONT_CONV:-lv_font_conv}"
"${conv}" --font "${FONT}" --range 0x20-0x7E --symbols "$(cat "${here}/charset_gb2312.txt")" \
    --size 24 --bpp 1 --format lvgl --no-compress \
    --lv-font-name hw_font_24 --lv-include lvgl.h --output "${here}/hw_font_24.c"
# Countdown digits at 4x.
"${conv}" --font "${FONT}" --range 0x30-0x3A \
    --size 48 --bpp 1 --format lvgl --no-compress \
    --lv-font-name hw_font_48 --lv-include lvgl.h --output "${here}/hw_font_48.c"
# Task names: Source Han Sans CN Regular (OFL-1.1, SourceHanSans-OFL.txt), 18 px, 4 bpp
# anti-aliased, one line per row; long names scroll sideways when selected.
#   https://github.com/adobe-fonts/source-han-sans/raw/release/SubsetOTF/CN/SourceHanSansCN-Regular.otf
if [ -n "${SANS_FONT:-}" ]; then
  "${conv}" --font "${SANS_FONT}" --range 0x20-0x7E --symbols "$(cat "${here}/charset_gb2312.txt")" \
      --size 18 --bpp 4 --format lvgl --no-compress \
      --lv-font-name hw_font_18 --lv-include lvgl.h --output "${here}/hw_font_18.c"
fi
