// main/hw_ui.c - see hw_ui.h.
//
// Layout (240 x 320, corners rounded by the BSP). No status bar and no operating hints:
// the head lamp shows the Mac connection and a small battery sits beside the robot.
//   most pages:  robot y 0..106 (1/3),  page y 107..319 (2/3)
//   timer page:  robot y 0..159 (1/2),  page y 160..319 (1/2)
#include "hw_ui.h"

#include <stdio.h>
#include <string.h>

#include "bsp_display.h"
#include "hw_robot_art.h"
#include "lvgl.h"
#include "esp_timer.h"   // DIAG(keys)
#include "esp_rom_sys.h"   // DIAG(keys)

LV_FONT_DECLARE(hw_font_18);   // smooth font for task names
LV_FONT_DECLARE(hw_font_24);
LV_FONT_DECLARE(hw_font_48);

#define C_BG       0xEAF0F7
#define C_INK      0x1F2A37
#define C_SOFT     0x6B7787
#define C_PANEL    0xFFFFFF
#define C_SEL      0xFFF1B8
#define C_SEL_LINE 0xE0B400
#define C_LAMP     0xE2483D
#define C_OK       0x2F9E6B
#define C_WARN     0xD98A1C

#define ROWS_VISIBLE 5
#define ROW_H        42
#define TITLE_W      128      // task name width: about 7 characters at 18 px
#define ZONE_SMALL   107      // robot area height on most pages
#define ZONE_LARGE   160      // robot area height on the timer page
#define BATT_X       212

static lv_obj_t *s_scr;
static lv_obj_t *s_pages[HW_PAGE_COUNT];
static lv_obj_t *s_toast;
static lv_obj_t *s_batt, *s_batt_cap, *s_batt_fill;
static int s_soc = -1;
static bool s_online;
static int s_zone = ZONE_SMALL;
static int s_edit_minutes = -1;   // list-page duration editor, -1 = off
static lv_obj_t *s_rec, *s_rec_dot, *s_rec_time, *s_rec_bar;
// robot
static lv_obj_t *s_lamp, *s_eye[2], *s_roller, *s_body;
static const hw_robot_art_t *s_art = &hw_robot_art[0][0];
static int s_facing;     // 0: facing right, 1: facing left
static int s_rx, s_ry;   // body top-left on screen
static lv_timer_t *s_robot_timer;
static hw_mood_t s_mood;
static uint32_t s_robot_tick;
// list
static lv_obj_t *s_list_empty, *s_rows[ROWS_VISIBLE], *s_row_badge[ROWS_VISIBLE],
                *s_row_char[ROWS_VISIBLE], *s_row_art[ROWS_VISIBLE], *s_row_title[ROWS_VISIBLE],
                *s_row_min[ROWS_VISIBLE];
// timer
static lv_obj_t *s_t_title, *s_t_clock, *s_t_bar, *s_t_state;
// alert
static lv_obj_t *s_a_title, *s_a_btn[2];
// done / setup / confirm
static lv_obj_t *s_d_text, *s_s_status;

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, uint32_t color) {
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, LV_PART_MAIN | LV_STATE_DEFAULT);
    lv_obj_set_style_text_color(l, lv_color_hex(color), LV_PART_MAIN | LV_STATE_DEFAULT);
    return l;
}

static lv_obj_t *box(lv_obj_t *parent, int x, int y, int w, int h, uint32_t color, int radius) {
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}

static lv_obj_t *page(int top) {
    lv_obj_t *p = lv_obj_create(s_scr);
    lv_obj_remove_style_all(p);
    lv_obj_set_pos(p, 0, top);
    lv_obj_set_size(p, 240, 320 - top);
    lv_obj_remove_flag(p, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(p, LV_OBJ_FLAG_HIDDEN);
    return p;
}

static lv_obj_t *centered(lv_obj_t *parent, int y, const lv_font_t *font, uint32_t color) {
    lv_obj_t *l = label(parent, font, color);
    lv_obj_set_width(l, 216);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(l, LV_ALIGN_TOP_MID, 0, y);
    return l;
}

// ---- robot -------------------------------------------------------------------------
// Pixel-art parts from hw_robot_art.c (gen_robot_art.py), combined per expression.
// Eye offsets below are in "small steps" of 1/3 grid cell, so they scale with the robot.
static int step(int d) { return d * s_art->scale / 3; }

static void set_eyes(hw_eye_t l, hw_eye_t r, int dx, int dy) {
    lv_image_set_src(s_eye[0], s_art->eye[l]);
    lv_image_set_src(s_eye[1], s_art->eye[r]);
    lv_obj_set_pos(s_eye[0], s_rx + s_art->eye_l_x + step(dx), s_ry + s_art->eye_y + step(dy));
    lv_obj_set_pos(s_eye[1], s_rx + s_art->eye_r_x + step(dx), s_ry + s_art->eye_y + step(dy));
}

static void battery_draw(bool blink_phase);
static void robot_place(void);

static void robot_tick(lv_timer_t *t) {
    (void)t;
    s_robot_tick++;
    uint32_t k = s_robot_tick;
    bool lamp_on = true;
    int roller = 0;
    switch (s_mood) {
    case HW_MOOD_IDLE: {
        static const int8_t look[] = { 0, 0, 0, 0, -3, -3, 0, 0, 0, 0, 3, 3 };
        bool blink = (k % 40) == 0 || (k % 40) == 1;        // blink every 4 s
        hw_eye_t e = blink ? HW_EYE_BLINK : HW_EYE_OPEN;
        if (k % 120 == 60) {                                 // turns around every 12 s
            s_facing ^= 1;
            robot_place();
        }
        set_eyes(e, e, look[(k / 10) % sizeof look], 0);
        break;
    }
    case HW_MOOD_FOCUS:
        set_eyes(HW_EYE_DOWN, HW_EYE_DOWN, 0, 0);
        roller = (k / 2) % 3;                                // the brush keeps turning
        break;
    case HW_MOOD_THINK:
        set_eyes(HW_EYE_OPEN, HW_EYE_OPEN, ((k / 3) % 2) ? 3 : -3, -2);
        break;
    case HW_MOOD_HAPPY:
        set_eyes(HW_EYE_HAPPY, HW_EYE_HAPPY, 0, 0);
        roller = (k / 3) % 3;
        break;
    case HW_MOOD_WORRIED:
        set_eyes(HW_EYE_WORRIED_L, HW_EYE_WORRIED_R, ((k / 2) % 2) ? 1 : -1, 0);
        lamp_on = (k / 3) % 2;
        break;
    case HW_MOOD_SLEEP:
        // Asleep only closes the eyes. The lamp keeps showing the real Mac connection, so a
        // sleeping robot (eyes shut, lamp lit) looks different from a disconnected one (lamp grey).
        set_eyes(HW_EYE_SLEEP, HW_EYE_SLEEP, 0, 0);
        break;
    case HW_MOOD_LISTEN:
        set_eyes(HW_EYE_BIG, HW_EYE_BIG, 0, -1);
        lamp_on = (k / 5) % 2;                               // slow pulse: "recording"
        break;
    }
    // The head lamp is the connection light: it only glows while the Mac answers.
    lv_image_set_src(s_lamp, lamp_on && s_online ? s_art->lamp_on : s_art->lamp_off);
    lv_image_set_src(s_roller, s_art->roller[roller]);
    battery_draw((k / 5) % 2);
}

static lv_obj_t *image_at(const lv_image_dsc_t *src) {
    lv_obj_t *img = lv_image_create(s_scr);
    lv_image_set_src(img, src);
    return img;
}

// Centres the robot (lamp included) in the robot area and picks the matching size.
static void robot_place(void) {
    s_art = &hw_robot_art[s_zone == ZONE_LARGE ? 1 : 0][s_facing];
    int above = s_art->lamp_y < 0 ? -s_art->lamp_y : 0;   // lamp sticking out above the body
    s_rx = (240 - s_art->w) / 2;
    s_ry = (s_zone - (s_art->h + above)) / 2 + above;
    lv_image_set_src(s_body, s_art->body);
    lv_obj_set_pos(s_body, s_rx, s_ry);
    lv_obj_set_pos(s_roller, s_rx + s_art->roller_x, s_ry + s_art->roller_y);
    lv_obj_set_pos(s_lamp, s_rx + s_art->lamp_x, s_ry + s_art->lamp_y);
    // Battery: a small upright cell beside the robot, vertically centred.
    lv_obj_set_pos(s_batt_cap, BATT_X + 4, s_zone / 2 - 17);
    lv_obj_set_pos(s_batt, BATT_X, s_zone / 2 - 14);
}

static void robot_create(void) {
    s_body = image_at(hw_robot_art[0][0].body);
    s_roller = image_at(hw_robot_art[0][0].roller[0]);   // held in front of the torso
    s_lamp = image_at(hw_robot_art[0][0].lamp_on);
    s_eye[0] = image_at(hw_robot_art[0][0].eye[HW_EYE_OPEN]);
    s_eye[1] = image_at(hw_robot_art[0][0].eye[HW_EYE_OPEN]);

    s_batt_cap = box(s_scr, 0, 0, 6, 3, C_SOFT, 1);
    s_batt = box(s_scr, 0, 0, 14, 28, C_BG, 3);
    lv_obj_set_style_border_color(s_batt, lv_color_hex(C_SOFT), 0);
    lv_obj_set_style_border_width(s_batt, 2, 0);
    s_batt_fill = box(s_batt, 0, 0, 8, 22, C_OK, 1);
    lv_obj_add_flag(s_batt, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_batt_cap, LV_OBJ_FLAG_HIDDEN);

    robot_place();
    s_robot_timer = lv_timer_create(robot_tick, 100, NULL);
}

// Fill height follows the charge; at 20 % or less it turns red and blinks.
static void battery_draw(bool blink_phase) {
    if (s_soc < 0) return;
    int inner = 28 - 6, fill = (s_soc * inner + 50) / 100;
    if (fill < 2) fill = 2;
    bool low = s_soc <= 20;
    lv_obj_set_size(s_batt_fill, 8, fill);
    lv_obj_set_pos(s_batt_fill, 1, 1 + inner - fill);
    lv_obj_set_style_bg_color(s_batt_fill, lv_color_hex(low ? C_LAMP : C_OK), 0);
    lv_obj_set_style_bg_opa(s_batt_fill, low && blink_phase ? LV_OPA_30 : LV_OPA_COVER, 0);
}

// ---- pages ---------------------------------------------------------------------------
// Subject badge: a coloured rounded square with one character (语 / 数 / 外). "其他" is
// mostly posters and hands-on tasks, so it gets a tiny painter's palette instead.
static uint32_t subject_color(const char *s) {
    if (strcmp(s, "语文") == 0) return 0xD9534F;
    if (strcmp(s, "数学") == 0) return 0x3D7BE0;
    if (strcmp(s, "英语") == 0) return 0x8A5CD6;
    return 0xE08A1E;
}

static const char *subject_char(const char *s) {
    if (strcmp(s, "语文") == 0) return "语";
    if (strcmp(s, "数学") == 0) return "数";
    if (strcmp(s, "英语") == 0) return "外";
    return NULL;
}

static lv_obj_t *palette_create(lv_obj_t *parent) {
    lv_obj_t *p = box(parent, 5, 6, 20, 18, C_PANEL, 9);
    static const struct { int x, y; uint32_t c; } DOT[] = {
        { 4, 4, 0xD9534F }, { 10, 3, 0xF2C230 }, { 14, 8, 0x3D7BE0 }, { 5, 10, 0x2F9E6B },
    };
    for (unsigned i = 0; i < sizeof DOT / sizeof DOT[0]; i++) box(p, DOT[i].x, DOT[i].y, 4, 4, DOT[i].c, 2);
    box(p, 11, 11, 5, 5, 0xE08A1E, 3);   // thumb hole shows the badge colour
    return p;
}

// Task name: always one line, centred in the row. Too long: ends in "..." and, while the
// row is selected, scrolls sideways to show the whole name.
static void title_set(lv_obj_t *l, const char *text, bool selected) {
    lv_label_set_long_mode(l, selected ? LV_LABEL_LONG_SCROLL_CIRCULAR : LV_LABEL_LONG_DOT);
    lv_label_set_text(l, text);
}

static void list_create(lv_obj_t *p) {
    for (int i = 0; i < ROWS_VISIBLE; i++) {
        lv_obj_t *r = box(p, 8, 2 + i * ROW_H, 224, ROW_H - 2, C_PANEL, 8);
        lv_obj_set_style_border_color(r, lv_color_hex(C_SEL_LINE), 0);
        s_rows[i] = r;
        s_row_badge[i] = box(r, 5, 5, 30, 30, 0x7A8594, 7);
        s_row_char[i] = label(s_row_badge[i], &hw_font_24, C_PANEL);
        lv_obj_center(s_row_char[i]);
        s_row_art[i] = palette_create(s_row_badge[i]);
        s_row_title[i] = label(r, &hw_font_18, C_INK);
        lv_obj_set_pos(s_row_title[i], 42, (ROW_H - 2 - lv_font_get_line_height(&hw_font_18)) / 2);
        // Fixed one-line box: long names end in "…" and scroll only when selected.
        lv_obj_set_size(s_row_title[i], TITLE_W, lv_font_get_line_height(&hw_font_18));
        lv_label_set_long_mode(s_row_title[i], LV_LABEL_LONG_DOT);
        s_row_min[i] = label(r, &hw_font_18, C_SOFT);
        lv_obj_align(s_row_min[i], LV_ALIGN_RIGHT_MID, -6, 0);
    }
    s_list_empty = centered(p, 70, &hw_font_24, C_SOFT);
    lv_label_set_text(s_list_empty, "还没有作业\n等爸爸妈妈上传");
}

static void timer_create(lv_obj_t *p) {
    s_t_title = centered(p, 6, &hw_font_24, C_INK);
    lv_label_set_long_mode(s_t_title, LV_LABEL_LONG_SCROLL_CIRCULAR);
    s_t_clock = centered(p, 34, &hw_font_48, C_INK);
    s_t_bar = lv_bar_create(p);
    lv_obj_set_size(s_t_bar, 180, 12);
    lv_obj_align(s_t_bar, LV_ALIGN_TOP_MID, 0, 96);
    lv_bar_set_range(s_t_bar, 0, 1000);
    lv_obj_set_style_bg_color(s_t_bar, lv_color_hex(0xD3DCE7), LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_t_bar, lv_color_hex(C_OK), LV_PART_INDICATOR);
    lv_obj_set_style_radius(s_t_bar, 3, LV_PART_MAIN);
    lv_obj_set_style_radius(s_t_bar, 3, LV_PART_INDICATOR);
    s_t_state = centered(p, 118, &hw_font_24, C_SOFT);
}

static void alert_create(lv_obj_t *p) {
    lv_obj_t *t = centered(p, 2, &hw_font_24, C_LAMP);
    lv_label_set_text(t, "时间到啦！");
    s_a_title = centered(p, 32, &hw_font_24, C_INK);
    lv_label_set_long_mode(s_a_title, LV_LABEL_LONG_SCROLL_CIRCULAR);
    static const char *TEXT[2] = { "★ 做完了", "再来 5 分钟" };
    for (int i = 0; i < 2; i++) {
        s_a_btn[i] = box(p, 30, 72 + i * 52, 180, 42, C_PANEL, 10);
        lv_obj_set_style_border_color(s_a_btn[i], lv_color_hex(C_SEL_LINE), 0);
        lv_obj_t *l = label(s_a_btn[i], &hw_font_24, C_INK);
        lv_label_set_text(l, TEXT[i]);
        lv_obj_center(l);
    }
}

static void done_create(lv_obj_t *p) {
    lv_obj_t *t = centered(p, 30, &hw_font_24, C_OK);
    lv_label_set_text(t, "★ 全部完成！★");
    s_d_text = centered(p, 70, &hw_font_24, C_INK);
}

static void setup_create(lv_obj_t *p) {
    lv_obj_t *t = centered(p, 0, &hw_font_24, C_INK);
    lv_label_set_text(t, "第一次使用\n先连网");
    s_s_status = centered(p, 80, &hw_font_24, C_WARN);
}

static void confirm_create(lv_obj_t *p) {
    lv_obj_t *t = centered(p, 30, &hw_font_24, C_INK);
    lv_label_set_text(t, "重新设置 Wi-Fi？\n\n设备会重启并进入\n配网模式");
}

void hw_ui_init(void) {
    if (!bsp_lvgl_lock(1000)) return;
    s_scr = lv_obj_create(NULL);
    lv_obj_remove_flag(s_scr, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(C_BG), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);

    robot_create();

    for (int i = 0; i < HW_PAGE_COUNT; i++) s_pages[i] = page(i == HW_PAGE_TIMER ? ZONE_LARGE : ZONE_SMALL);
    setup_create(s_pages[HW_PAGE_SETUP]);
    list_create(s_pages[HW_PAGE_LIST]);
    timer_create(s_pages[HW_PAGE_TIMER]);
    alert_create(s_pages[HW_PAGE_ALERT]);
    done_create(s_pages[HW_PAGE_DONE]);
    confirm_create(s_pages[HW_PAGE_CONFIRM]);

    s_toast = label(s_scr, &hw_font_24, C_INK);
    lv_obj_set_style_bg_color(s_toast, lv_color_hex(C_SEL), 0);
    lv_obj_set_style_bg_opa(s_toast, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(s_toast, lv_color_hex(C_SEL_LINE), 0);
    lv_obj_set_style_border_width(s_toast, 2, 0);
    lv_obj_set_style_radius(s_toast, 8, 0);
    lv_obj_set_style_pad_hor(s_toast, 10, 0);
    lv_obj_set_style_pad_ver(s_toast, 4, 0);
    lv_obj_set_style_text_align(s_toast, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s_toast, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s_toast, 216);
    lv_obj_align(s_toast, LV_ALIGN_TOP_MID, 0, ZONE_SMALL + 6);
    lv_obj_add_flag(s_toast, LV_OBJ_FLAG_HIDDEN);

    // Recording panel: covers the page while OK is held, so it is impossible to miss.
    s_rec = box(s_scr, 14, ZONE_SMALL + 4, 212, 100, C_PANEL, 14);
    lv_obj_set_style_border_color(s_rec, lv_color_hex(C_LAMP), 0);
    lv_obj_set_style_border_width(s_rec, 3, 0);
    s_rec_dot = box(s_rec, 22, 22, 18, 18, C_LAMP, 9);
    lv_obj_t *t = label(s_rec, &hw_font_24, C_LAMP);
    lv_label_set_text(t, "录音中");
    lv_obj_set_pos(t, 50, 18);
    s_rec_time = label(s_rec, &hw_font_24, C_INK);
    lv_obj_align(s_rec_time, LV_ALIGN_TOP_RIGHT, -18, 18);
    s_rec_bar = lv_bar_create(s_rec);
    lv_obj_set_size(s_rec_bar, 172, 14);
    lv_obj_align(s_rec_bar, LV_ALIGN_TOP_MID, 0, 62);
    lv_bar_set_range(s_rec_bar, 0, 100);
    lv_obj_set_style_bg_color(s_rec_bar, lv_color_hex(0xD3DCE7), LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_rec_bar, lv_color_hex(C_OK), LV_PART_INDICATOR);
    lv_obj_set_style_anim_duration(s_rec_bar, 80, LV_PART_MAIN);
    lv_obj_add_flag(s_rec, LV_OBJ_FLAG_HIDDEN);

    lv_screen_load(s_scr);
    bsp_lvgl_unlock();
}

void hw_ui_rec_show(bool show) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    if (show) {
        lv_obj_remove_flag(s_rec, LV_OBJ_FLAG_HIDDEN);
        lv_obj_move_foreground(s_rec);
        lv_label_set_text(s_rec_time, "0秒");
        lv_bar_set_value(s_rec_bar, 0, LV_ANIM_OFF);
    } else {
        lv_obj_add_flag(s_rec, LV_OBJ_FLAG_HIDDEN);
    }
    bsp_lvgl_unlock();
}

void hw_ui_rec_update(int elapsed_ms, int level) {
    if (!s_scr || !bsp_lvgl_lock(100)) return;
    lv_label_set_text_fmt(s_rec_time, "%d秒", elapsed_ms / 1000);
    lv_bar_set_value(s_rec_bar, level, LV_ANIM_ON);
    // The dot blinks twice a second; the bar turns orange near the 10 s limit.
    lv_obj_set_style_bg_opa(s_rec_dot, (elapsed_ms / 250) % 2 ? LV_OPA_40 : LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s_rec_bar, lv_color_hex(elapsed_ms > 8000 ? C_WARN : C_OK), LV_PART_INDICATOR);
    bsp_lvgl_unlock();
}

void hw_ui_show(hw_page_t pg) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    for (int i = 0; i < HW_PAGE_COUNT; i++) {
        if (i == (int)pg) lv_obj_remove_flag(s_pages[i], LV_OBJ_FLAG_HIDDEN);
        else lv_obj_add_flag(s_pages[i], LV_OBJ_FLAG_HIDDEN);
    }
    s_zone = pg == HW_PAGE_TIMER ? ZONE_LARGE : ZONE_SMALL;
    robot_place();
    robot_tick(NULL);
    // Overlays sit at the top of the information area.
    lv_obj_align(s_toast, LV_ALIGN_TOP_MID, 0, s_zone + 6);
    lv_obj_set_y(s_rec, s_zone + 4);
    bsp_lvgl_unlock();
}

void hw_ui_robot(hw_mood_t mood) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    s_mood = mood;
    s_robot_tick = 0;
    robot_tick(NULL);
    bsp_lvgl_unlock();
}

void hw_ui_set_list(const hw_list_t *l, int selected) {
    if (!s_scr) return;
    int64_t t0 = esp_timer_get_time();   // DIAG(keys)
    if (!bsp_lvgl_lock(200)) {
        esp_rom_printf("[ui] set_list LOCK TIMEOUT\n");   // DIAG(keys)
        return;
    }
    esp_rom_printf("[ui] set_list sel %d lock %lldms\n", selected, (long long)((esp_timer_get_time() - t0) / 1000));   // DIAG(keys)
    if (l->count == 0) lv_obj_remove_flag(s_list_empty, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(s_list_empty, LV_OBJ_FLAG_HIDDEN);

    // Scroll so the selected row is visible.
    int first = 0;
    if (selected >= ROWS_VISIBLE) first = selected - ROWS_VISIBLE + 1;
    for (int i = 0; i < ROWS_VISIBLE; i++) {
        int idx = first + i;
        lv_obj_t *r = s_rows[i];
        if (idx >= l->count) {
            lv_obj_add_flag(r, LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        const hw_task_t *t = &l->tasks[idx];
        bool sel = idx == selected, fin = t->status == HW_ST_DONE;
        lv_obj_remove_flag(r, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_bg_color(r, lv_color_hex(sel ? C_SEL : C_PANEL), 0);
        lv_obj_set_style_border_width(r, sel ? 2 : 0, 0);
        const char *ch = subject_char(t->subject);
        lv_obj_set_style_bg_color(s_row_badge[i], lv_color_hex(subject_color(t->subject)), 0);
        lv_obj_set_style_bg_opa(s_row_badge[i], fin ? LV_OPA_40 : LV_OPA_COVER, 0);
        if (ch) {
            lv_label_set_text(s_row_char[i], ch);
            lv_obj_remove_flag(s_row_char[i], LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s_row_art[i], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_row_char[i], LV_OBJ_FLAG_HIDDEN);
            lv_obj_remove_flag(s_row_art[i], LV_OBJ_FLAG_HIDDEN);
        }
        title_set(s_row_title[i], t->title, sel);
        lv_obj_set_style_text_color(s_row_title[i], lv_color_hex(fin ? C_SOFT : C_INK), 0);
        bool editing = sel && s_edit_minutes >= 0 && !fin;
        if (fin) lv_label_set_text(s_row_min[i], "★");
        else if (editing) lv_label_set_text_fmt(s_row_min[i], "%d分", s_edit_minutes);
        else if (t->optional) lv_label_set_text_fmt(s_row_min[i], "选%d", t->minutes);
        else lv_label_set_text_fmt(s_row_min[i], "%d分", t->minutes);
        lv_obj_set_style_text_color(s_row_min[i], lv_color_hex(editing ? C_PANEL : fin ? C_OK : C_SOFT), 0);
        // Editing: the minutes sit on an orange pill so it is obvious what the keys change.
        lv_obj_set_style_bg_color(s_row_min[i], lv_color_hex(C_WARN), 0);
        lv_obj_set_style_bg_opa(s_row_min[i], editing ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
        lv_obj_set_style_radius(s_row_min[i], 6, 0);
        lv_obj_set_style_pad_hor(s_row_min[i], editing ? 5 : 0, 0);
        lv_obj_set_style_pad_ver(s_row_min[i], editing ? 2 : 0, 0);
        lv_obj_align(s_row_min[i], LV_ALIGN_RIGHT_MID, -6, 0);
    }
    bsp_lvgl_unlock();
}

void hw_ui_set_edit(int minutes) {
    s_edit_minutes = minutes;
}

void hw_ui_set_timer(const char *title, const hw_timer_t *t) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    if (strcmp(lv_label_get_text(s_t_title), title) != 0) lv_label_set_text(s_t_title, title);
    char clock[12];
    hw_format_clock(hw_timer_seconds_left(t), clock, sizeof clock);
    lv_label_set_text(s_t_clock, clock);
    lv_bar_set_value(s_t_bar, hw_timer_permille(t), LV_ANIM_OFF);
    int left = hw_timer_seconds_left(t);
    bool near = left <= hw_remind_before_ms(t->total_ms) / 1000;
    lv_obj_set_style_text_color(s_t_clock, lv_color_hex(near ? C_WARN : C_INK), 0);
    lv_obj_set_style_bg_color(s_t_bar, lv_color_hex(near ? C_WARN : C_OK), LV_PART_INDICATOR);
    lv_label_set_text(s_t_state, t->phase == HW_T_PAUSED ? "已暂停" : near ? "快到时间啦" : "专心写作业…");
    bsp_lvgl_unlock();
}

void hw_ui_set_alert(const char *title, int choice) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    lv_label_set_text(s_a_title, title);
    for (int i = 0; i < 2; i++) {
        lv_obj_set_style_bg_color(s_a_btn[i], lv_color_hex(i == choice ? C_SEL : C_PANEL), 0);
        lv_obj_set_style_border_width(s_a_btn[i], i == choice ? 3 : 0, 0);
    }
    bsp_lvgl_unlock();
}

void hw_ui_set_done(int finished) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    lv_label_set_text_fmt(s_d_text, "今天 %d 项作业\n都做完了\n你真厉害！", finished);
    bsp_lvgl_unlock();
}

void hw_ui_set_setup(const char *status) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    lv_label_set_text(s_s_status, status);
    bsp_lvgl_unlock();
}

void hw_ui_set_net(hw_net_state_t st) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    s_online = st == HW_NET_ONLINE;
    robot_tick(NULL);
    bsp_lvgl_unlock();
}

void hw_ui_set_battery(int soc) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    s_soc = soc >= 0 && soc <= 100 ? soc : -1;
    if (s_soc < 0) {
        lv_obj_add_flag(s_batt, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_batt_cap, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_remove_flag(s_batt, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(s_batt_cap, LV_OBJ_FLAG_HIDDEN);
        battery_draw(false);
    }
    bsp_lvgl_unlock();
}

static lv_timer_t *s_toast_timer;

static void toast_hide(lv_timer_t *t) {
    lv_obj_add_flag(s_toast, LV_OBJ_FLAG_HIDDEN);
    lv_timer_pause(t);
}

void hw_ui_toast(const char *text, int ms) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    lv_label_set_text(s_toast, text);
    lv_obj_remove_flag(s_toast, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_toast);
    // One reusable timer: a newer toast restarts (or cancels) the countdown.
    if (!s_toast_timer) s_toast_timer = lv_timer_create(toast_hide, 2500, NULL);
    if (ms > 0) {
        lv_timer_set_period(s_toast_timer, (uint32_t)ms);
        lv_timer_reset(s_toast_timer);
        lv_timer_resume(s_toast_timer);
    } else {
        lv_timer_pause(s_toast_timer);
    }
    bsp_lvgl_unlock();
}

void hw_ui_toast_hide(void) {
    if (!s_scr || !bsp_lvgl_lock(200)) return;
    lv_obj_add_flag(s_toast, LV_OBJ_FLAG_HIDDEN);
    if (s_toast_timer) lv_timer_pause(s_toast_timer);
    bsp_lvgl_unlock();
}
