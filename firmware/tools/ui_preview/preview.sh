#!/bin/bash
# Build the host UI preview from the current firmware sources and render every screen.
#   bash tools/ui_preview/preview.sh          # build + render, open the gallery
#   NO_OPEN=1 bash tools/ui_preview/preview.sh
# Needs a firmware build once (for build/config/sdkconfig.h: the exact LVGL options).
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd -- "$here/../.." && pwd)"
out="$fw/build/ui_preview"
bld="$out/host-build"
mkdir -p "$bld" "$out/frames"
[ -f "$fw/build/config/sdkconfig.h" ] || { echo "先编译一次固件（idf.py build）"; exit 1; }
python3 "$here/gen_host_config.py" "$fw/build/config/sdkconfig.h" "$bld/host_sdkconfig.h" >/dev/null
# cmake/ninja come with ESP-IDF; load it quietly if they are not on PATH.
if ! command -v cmake >/dev/null; then
  for e in "${IDF_PATH:-}/export.sh" "$HOME"/esp/esp-idf-*/export.sh; do
    [ -f "$e" ] && { set +u; . "$e" >/dev/null 2>&1; set -u; break; }
  done
fi
command -v cmake >/dev/null || { echo "找不到 cmake（需要 ESP-IDF 环境）"; exit 1; }
gen=(); command -v ninja >/dev/null && gen=(-G Ninja)
cmake -S "$here" -B "$bld" ${gen[@]+"${gen[@]}"} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=/usr/bin/cc >/dev/null
cmake --build "$bld" -j 8 >/dev/null
rm -f "$out/frames"/*.rgb565
"$bld/hw_ui_preview" "$out/frames"
python3 "$here/render.py" "$out/frames"
[ -n "${NO_OPEN:-}" ] || open "$out/frames/index.html"
