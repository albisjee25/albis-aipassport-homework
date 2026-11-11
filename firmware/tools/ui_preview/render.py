#!/usr/bin/env python3
"""Turn the preview's raw frames into PNGs and a numbered gallery page.

Usage: render.py <frames dir>   (writes NN.png + index.html into the same folder)
"""
import html
import struct
import sys
import time
import zlib
from pathlib import Path

W, H, SCALE = 240, 320, 2


def png(path: Path, rgb: bytes, w: int, h: int):
    raw = b"".join(b"\x00" + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))
    chunk = lambda t, b: struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def to_png(src: Path, dst: Path):
    px = struct.unpack(f"<{W * H}H", src.read_bytes())
    rows = []
    for y in range(H):
        line = bytearray()
        for x in range(W):
            v = px[y * W + x]
            r, g, b = (v >> 11) << 3, ((v >> 5) & 0x3F) << 2, (v & 0x1F) << 3
            line += bytes((r | r >> 5, g | g >> 6, b | b >> 5)) * SCALE
        rows += [bytes(line)] * SCALE
    png(dst, b"".join(rows), W * SCALE, H * SCALE)


def main():
    d = Path(sys.argv[1])
    items = [l.rstrip("\n").split("\t") for l in (d / "index.tsv").read_text(encoding="utf-8").splitlines() if l]
    for n, _, _ in items:
        to_png(d / f"{n}.rgb565", d / f"{n}.png")
    stamp = str(int(time.time()))
    (d / "version.txt").write_text(stamp)
    cards = "\n".join(
        f'<figure id="s{n}"><img src="{n}.png?v={stamp}" width="{W * SCALE // 2 * 3 // 2}" alt="">'
        f'<figcaption><b>{n}</b> {html.escape(t)}<small>{html.escape(note)}</small></figcaption></figure>'
        for n, t, note in items)
    (d / "index.html").write_text(f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>作业助手 · 界面预览</title><style>
body{{margin:0;background:#20242b;color:#e8ecf2;font:14px -apple-system,"PingFang SC",sans-serif}}
header{{padding:16px 24px;border-bottom:1px solid #333a44}} header h1{{margin:0;font-size:18px}}
header p{{margin:4px 0 0;color:#97a2b0}}
main{{display:flex;flex-wrap:wrap;gap:22px;padding:22px 24px}}
figure{{margin:0;width:360px}} img{{display:block;border-radius:6px;image-rendering:pixelated;background:#000}}
figcaption{{margin-top:8px;line-height:1.4}} figcaption b{{display:inline-block;min-width:26px;padding:1px 6px;margin-right:6px;
border-radius:6px;background:#f5d33f;color:#18202b;text-align:center}}
small{{display:block;color:#97a2b0;margin-top:2px}}
</style></head><body><header><h1>作业助手 · 界面预览（与设备像素一致）</h1>
<p>用设备上同一份界面代码、字体和图形库生成，1 个屏幕像素放大为 3×3 显示。提意见时说编号即可，例如“05：……”。
本页会在我更新后自动刷新。生成时间：{time.strftime('%H:%M:%S')}</p></header><main>
{cards}
</main><script>
const v="{stamp}";setInterval(async()=>{{try{{const r=await fetch("version.txt?"+Date.now());
if((await r.text()).trim()!==v)location.reload();}}catch(e){{}}}},2000);
</script></body></html>""", encoding="utf-8")
    print(f"{len(items)} screens -> {d / 'index.html'}")


if __name__ == "__main__":
    main()
