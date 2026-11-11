#!/usr/bin/env python3
"""Pixel-art parts of the homework robot (inspired by M-O from WALL-E).

The robot is assembled on the device from parts so expressions can be combined:
  body (head shell, visor, neck)  +  2 eyes  +  head lamp  +  roller brush
Every part is drawn on a small grid and scaled 3x and 5x with nearest-neighbour sampling.

Outputs (paths relative to the repository root):
  main/hw_robot_art.c                     LVGL 9 RGB565A8 image descriptors
  assets/images/homework/robot-preview.png  assembled expressions for review

Usage: python3 assets/images/homework/gen_robot_art.py
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
# Two sizes: the list page gives the robot 1/3 of the screen, the timer page 1/2.
SIZES = (("small", 3), ("large", 5))

OUT = 0x23272E        # outline
SHELL = 0xF4F6F8      # white shell
SHELL_MID = 0xD6DDE6  # soft shade
SHELL_DARK = 0xA7B2C0 # hands, seams
VISOR = 0x111418
VISOR_EDGE = 0x2A2F37
EYE = 0xF6D63C
EYE_HI = 0xFFF4B0
EYE_DIM = 0xB89A1E
LAMP = 0xE2483D
LAMP_HI = 0xFFB347    # glowing centre
LAMP_OFF = 0x8C939C   # grey: not connected / asleep
LAMP_OFF_HI = 0xA9AFB7
ROLL = 0x80C0E0       # light blue roller (reference colour)
ROLL_DARK = 0x1F55A0
ROLL_HI = 0xA8DDF7
COMB = 0x1E2228
BAND = 0x2B2F36       # dark base band
WHEEL = 0x3A3F47
WHEEL_HI = 0x5D646E


class Grid:
    def __init__(self, w: int, h: int) -> None:
        self.w, self.h = w, h
        self.px: list[list[int | None]] = [[None] * w for _ in range(h)]

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.w and 0 <= y < self.h else None

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def outline(self, c):
        add = []
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x] is None and any(
                        self.get(x + dx, y + dy) not in (None, c) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    add.append((x, y))
        for x, y in add:
            self.set(x, y, c)


# ---- body: traced cell by cell from the parent's pixel reference ----------------------
# Three-quarter view facing right. K outline, W shell, g grey (seams, arm, wheel),
# R lamp, Y eyes, B / b dark / light blue roller, "." transparent. The lamp, eyes and
# roller are also cut out as separate parts so they can change at run time; the
# left-facing version is a mirror image made at encode time.
ART = [
    "......KKKKKKKK........",
    "......KRRRRRRK........",
    "......KRRRRRRK........",
    "..KKKKKKKKKKKKKKKKK...",
    ".KWWWWgWWWWWWWWWWWWK..",
    "KWWWWWWgWWWWWWWWWWWWK.",
    "KWWWWWWgWWWWWWWWWWWWK.",
    "KWWWWWWgWWWWWWWWWWWWK.",
    "KWWWWWWgWWWWWWWWWWWWWK",
    "KWWWWWWgWWWWWWWWWWWWWK",
    ".KKKWWWgWWWWWWWWWWWWWK",
    "....KWWgWWKKKKKKKKKWWK",
    ".....KWgWWKKKKKKKKKWWK",
    "....KKWgWWKYYYKYYYKWWK",
    "...K..KgWWKYYYKYYYKWWK",
    "..KKKKKgWWKKKKKKKKKWWK",
    "..KWWWKKKKKKKKKKKKKKK.",
    "..KggWWKWWWWWWWWWWWK..",
    "..KggWWWKWWWWWWWWWWWK.",
    "..KKWWWWKBBBBBBBBBBBB.",
    "..KWKWWggKbbBbbBbbBbbB",
    "..KWWKKggKbbBbbBbbBbbB",
    "..KggggKKBbbBbbBbbBbbB",
    "...KggggBBBBBBBBBBBBB.",
    "....KWWWWWWWWWWWWK....",
    ".....KKKKKKKKKKKK.....",
    "........KggggKK.......",
    ".........KKKKK........",
]
INK = {"K": OUT, "W": SHELL, "g": SHELL_DARK, "R": LAMP, "Y": VISOR, "B": ROLL_DARK, "b": ROLL}
BODY_W, BODY_H = len(ART[0]), len(ART)
LAMP_BOX = (7, 1, 6, 2)          # x, y, w, h of the lamp glass
ROLLER_BOX = (8, 19, 14, 5)      # x, y, w, h around the roller
STRIPE0 = 12                     # a dark stripe column of the roller at phase 0


def draw_body() -> Grid:
    g = Grid(BODY_W, BODY_H)
    for y, row in enumerate(ART):
        for x, ch in enumerate(row):
            if ch != ".":
                g.set(x, y, INK[ch])
    return g


def draw_lamp(on: bool) -> Grid:
    x0, y0, w, h = LAMP_BOX
    g = Grid(w, h)
    g.rect(0, 0, w - 1, h - 1, LAMP if on else LAMP_OFF)
    g.rect(2, 0, 3, 0, LAMP_HI if on else LAMP_OFF_HI)
    return g


def draw_roller(phase: int) -> Grid:
    # Copy the roller cells; on the striped rows the dark stripes move with the phase
    # (the last blue cell of each row is the end cap and stays dark).
    x0, y0, w, h = ROLLER_BOX
    g = Grid(w, h)
    for y in range(h):
        row = ART[y0 + y]
        striped = "b" in row
        last = max(i for i, ch in enumerate(row) if ch in "Bb")
        for x in range(w):
            ch = row[x0 + x]
            if ch not in "Bb":
                continue
            if striped and x0 + x < last:
                ch = "B" if (x0 + x - STRIPE0 - phase) % 3 == 0 else "b"
            g.set(x, y, INK[ch])
    return g


# ---- eyes: 3 x 4 cells inside the visor (the reference eyes are 3 x 2 yellow blocks) ---
def eye(kind: str) -> Grid:
    g = Grid(3, 4)
    if kind == "open":
        g.rect(0, 1, 2, 2, EYE); g.set(0, 1, EYE_HI)
    elif kind == "blink":
        g.rect(0, 2, 2, 2, EYE_DIM)
    elif kind == "happy":                                    # ^
        g.set(0, 2, EYE); g.set(1, 1, EYE); g.set(2, 2, EYE)
    elif kind == "big":
        g.rect(0, 0, 2, 2, EYE); g.set(0, 0, EYE_HI)
    elif kind == "down":
        g.rect(0, 2, 2, 3, EYE)
    elif kind == "worried_l":                                # inner corner raised
        g.rect(0, 2, 2, 3, EYE); g.set(2, 1, EYE)
    elif kind == "worried_r":
        g.rect(0, 2, 2, 3, EYE); g.set(0, 1, EYE)
    elif kind == "sleep":
        g.rect(0, 3, 2, 3, EYE_DIM)
    return g


EYES = ("open", "blink", "happy", "big", "down", "worried_l", "worried_r", "sleep")

PARTS = [
    ("hw_img_body", draw_body),
    ("hw_img_lamp_on", lambda: draw_lamp(True)),
    ("hw_img_lamp_off", lambda: draw_lamp(False)),
    ("hw_img_roller_a", lambda: draw_roller(0)),
    ("hw_img_roller_b", lambda: draw_roller(1)),
    ("hw_img_roller_c", lambda: draw_roller(2)),
] + [(f"hw_img_eye_{k}", (lambda k=k: eye(k)))
     for k in EYES]

# Where parts go relative to the body's top-left corner, in grid cells (x, y).
EYE_POS = ((11, 12), (15, 12))   # left and right eye cells (3x4 each) inside the visor
EYE_W = 3
LAMP_POS = (LAMP_BOX[0], LAMP_BOX[1])
ROLLER_POS = (ROLLER_BOX[0], ROLLER_BOX[1])


# ---- encoding ------------------------------------------------------------------------


def scaled(g: Grid, k: int):
    w, h = g.w * k, g.h * k
    return w, h, [g.px[y // k][x // k] for y in range(h) for x in range(w)]


def rgb565(c: int) -> int:
    return ((c >> 19) << 11) | (((c >> 10) & 0x3F) << 5) | ((c >> 3) & 0x1F)


def mirrored(g: Grid) -> Grid:
    m = Grid(g.w, g.h)
    m.px = [row[::-1] for row in g.px]
    return m


def facing_parts(facing: str):
    """Part grids and offsets (in cells) for one facing; "l" mirrors the right-facing art."""
    grids = {name: make() for name, make in PARTS}
    if facing == "r":
        return grids, EYE_POS[0][0], EYE_POS[1][0], LAMP_POS[0], ROLLER_POS[0]
    grids = {n: mirrored(g) for n, g in grids.items()}
    # Mirroring swaps the eyes, so the left slot shows the mirrored right-eye art.
    grids["hw_img_eye_worried_l"], grids["hw_img_eye_worried_r"] = (
        grids["hw_img_eye_worried_r"], grids["hw_img_eye_worried_l"])
    flip = lambda x, w: BODY_W - x - w
    return (grids, flip(EYE_POS[1][0], EYE_W), flip(EYE_POS[0][0], EYE_W),
            flip(LAMP_POS[0], grids["hw_img_lamp_on"].w), flip(ROLLER_POS[0], grids["hw_img_roller_a"].w))


def c_source() -> str:
    out = ["// Generated by assets/images/homework/gen_robot_art.py. Do not edit by hand.",
           "// Robot parts in LVGL RGB565A8 format (RGB565 plane, then alpha plane).",
           '#include "hw_robot_art.h"', ""]
    table = []
    for size, k in SIZES:
        row = []
        for facing in ("r", "l"):
            grids, eye_l_x, eye_r_x, lamp_x, roller_x = facing_parts(facing)
            for name, _ in PARTS:
                sym = f"{name}_{size}_{facing}"
                w, h, px = scaled(grids[name], k)
                data = bytearray()
                for c in px:
                    data += struct.pack("<H", rgb565(c) if c is not None else 0)
                data += bytes(0xFF if c is not None else 0 for c in px)
                out.append(f"static const uint8_t {sym}_map[{len(data)}] = {{")
                out += [f"    {', '.join(f'0x{b:02X}' for b in data[i:i + 24])}," for i in range(0, len(data), 24)]
                out += ["};", "", f"static const lv_image_dsc_t {sym} = {{",
                        "    .header = { .magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RGB565A8,",
                        f"                .w = {w}, .h = {h}, .stride = {w * 2} }},",
                        f"    .data_size = sizeof({sym}_map),", f"    .data = {sym}_map,", "};", ""]
            e = lambda n: f"&hw_img_{n}_{size}_{facing}"
            row.append("\n".join([
                "        {",
                f"            .scale = {k}, .w = {BODY_W * k}, .h = {BODY_H * k},",
                f"            .eye_l_x = {eye_l_x * k}, .eye_r_x = {eye_r_x * k}, .eye_y = {EYE_POS[0][1] * k},",
                f"            .lamp_x = {lamp_x * k}, .lamp_y = {LAMP_POS[1] * k},",
                f"            .roller_x = {roller_x * k}, .roller_y = {ROLLER_POS[1] * k},",
                f"            .body = {e('body')}, .lamp_on = {e('lamp_on')}, .lamp_off = {e('lamp_off')},",
                f"            .roller = {{ {e('roller_a')}, {e('roller_b')}, {e('roller_c')} }},",
                f"            .eye = {{ {', '.join(e('eye_' + n) for n in EYES)} }},",
                "        }"]))
        table.append("    {\n" + ",\n".join(row) + ",\n    }")
    out += ["const hw_robot_art_t hw_robot_art[HW_ROBOT_SIZES][HW_ROBOT_FACINGS] = {",
            ",\n".join(table) + ",", "};", ""]
    return "\n".join(out)


def header() -> str:
    enum = ", ".join(f"HW_EYE_{n.upper()}" for n in EYES)
    return "\n".join([
        "// Generated by assets/images/homework/gen_robot_art.py. Do not edit by hand.",
        "#pragma once", '#include "lvgl.h"', "",
        f"typedef enum {{ {enum}, HW_EYE_COUNT }} hw_eye_t;", "",
        "// One size and facing of the robot. Offsets are relative to the body's top-left corner.",
        "typedef struct {",
        "    int scale, w, h, eye_l_x, eye_r_x, eye_y, lamp_x, lamp_y, roller_x, roller_y;",
        "    const lv_image_dsc_t *body, *lamp_on, *lamp_off, *roller[3], *eye[HW_EYE_COUNT];",
        "} hw_robot_art_t;", "",
        "#define HW_ROBOT_SIZES   2   // 0: small (1/3 of the screen), 1: large (timer page, 1/2)",
        "#define HW_ROBOT_FACINGS 2   // 0: facing right, 1: facing left (mirror image)",
        "extern const hw_robot_art_t hw_robot_art[HW_ROBOT_SIZES][HW_ROBOT_FACINGS];", ""])


# ---- preview -----------------------------------------------------------------------------
def compose(eyes: tuple[str, str], lamp_on: bool, roller: int, facing: str = "r") -> Grid:
    top = max(0, -LAMP_POS[1])
    g = Grid(BODY_W, BODY_H + top)
    def paste(part: Grid, ox: int, oy: int):
        for y in range(part.h):
            for x in range(part.w):
                if part.px[y][x] is not None:
                    g.set(ox + x, oy + y + top, part.px[y][x])
    paste(draw_body(), 0, 0)
    paste(draw_roller(roller), *ROLLER_POS)
    paste(draw_lamp(lamp_on), *LAMP_POS)
    paste(eye(eyes[0]), *EYE_POS[0])
    paste(eye(eyes[1]), *EYE_POS[1])
    return g


def png(path: Path, w: int, h: int, rgb: list[int]):
    raw = b"".join(b"\x00" + b"".join(bytes(((c >> 16) & 255, (c >> 8) & 255, c & 255)) for c in rgb[y * w:(y + 1) * w])
                   for y in range(h))
    chunk = lambda t, b: struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def preview(path: Path):
    moods = [(("open", "open"), True, 0), (("blink", "blink"), True, 0), (("down", "down"), True, 1),
             (("big", "big"), False, 0), (("happy", "happy"), True, 0), (("worried_l", "worried_r"), True, 2),
             (("sleep", "sleep"), False, 0)]
    S, pad = 4, 8
    frames = [compose(*m) for m in moods]
    frames += [mirrored(compose(*moods[0])), mirrored(compose(*moods[4]))]   # left-facing
    fw, fh = frames[0].w * S, frames[0].h * S
    W, H = len(frames) * (fw + pad) + pad, fh + 2 * pad
    canvas = [0xEAF0F7] * (W * H)
    for i, g in enumerate(frames):
        for y in range(fh):
            for x in range(fw):
                c = g.px[y // S][x // S]
                if c is not None:
                    canvas[(y + pad) * W + pad + i * (fw + pad) + x] = c
    png(path, W, H, canvas)


def main() -> int:
    (ROOT / "main" / "hw_robot_art.c").write_text(c_source(), encoding="utf-8")
    (ROOT / "main" / "hw_robot_art.h").write_text(header(), encoding="utf-8")
    preview(ROOT / "assets" / "images" / "homework" / "robot-preview.png")
    print("wrote main/hw_robot_art.c, main/hw_robot_art.h, assets/images/homework/robot-preview.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
