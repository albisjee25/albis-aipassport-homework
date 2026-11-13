// Host UI preview for the homework helper.
//
// Runs the firmware's own main/hw_ui.c with the firmware's LVGL, fonts and robot art,
// drives it through every page and state, and writes each frame as raw RGB565
// (240 x 320, the panel's corners masked exactly like the BSP does). preview.sh turns
// the frames into a numbered gallery for review on the Mac.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp_display_rounding.h"
#include "hw_model.h"
#include "hw_ui.h"
#include "lvgl.h"

#define W 240
#define H 320
#define RADIUS 30

static uint16_t s_fb[W * H];
static uint16_t s_draw[W * H];
static uint32_t s_ms;
static const char *s_out;
static FILE *s_index;
static int s_n;

static uint32_t tick(void) { return s_ms; }

static void flush(lv_display_t *d, const lv_area_t *a, uint8_t *px) {
    const uint16_t *src = (const uint16_t *)px;
    int w = a->x2 - a->x1 + 1;
    for (int y = a->y1; y <= a->y2; y++) {
        memcpy(&s_fb[y * W + a->x1], &src[(y - a->y1) * w], (size_t)w * 2);
    }
    lv_display_flush_ready(d);
}

// Let timers, animations and label scrolling run for `ms` of simulated time.
static void run(uint32_t ms) {
    for (uint32_t t = 0; t < ms; t += 10) {
        s_ms += 10;
        lv_timer_handler();
    }
    lv_refr_now(NULL);
}

static void shot(const char *title, const char *note) {
    run(30);
    uint16_t out[W * H];
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            bool outside = bsp_display_pixel_outside_rounded_rect(x, y, W, H, RADIUS);
            out[y * W + x] = outside ? 0 : s_fb[y * W + x];
        }
    }
    char path[512];
    s_n++;
    snprintf(path, sizeof path, "%s/%02d.rgb565", s_out, s_n);
    FILE *f = fopen(path, "wb");
    fwrite(out, 2, W * H, f);
    fclose(f);
    fprintf(s_index, "%02d\t%s\t%s\n", s_n, title, note ? note : "");
}

// ---- sample data ---------------------------------------------------------------------
static hw_task_t task(const char *id, const char *title, const char *subject, int minutes,
                      hw_status_t st) {
    hw_task_t t = { 0 };
    hw_utf8_copy(t.id, sizeof t.id, id);
    hw_utf8_copy(t.title, sizeof t.title, title);
    hw_utf8_copy(t.subject, sizeof t.subject, subject);
    t.minutes = (uint16_t)minutes;
    t.status = st;
    return t;
}

static hw_list_t sample_list(void) {
    hw_list_t l;
    hw_list_init(&l);
    l.version = 7;
    l.tasks[l.count++] = task("a1", "订正今天的小测卷", "数学", 15, HW_ST_DONE);
    l.tasks[l.count++] = task("a2", "练习册P34-35", "数学", 25, HW_ST_TODO);
    l.tasks[l.count++] = task("a3", "复习83、84、85和第9页的关于月份的单词", "英语", 15, HW_ST_TODO);
    l.tasks[l.count++] = task("a4", "抄写第16课生字词，每个2遍", "语文", 20, HW_ST_TODO);
    l.tasks[l.count++] = task("a5", "活动1、2英译中", "英语", 10, HW_ST_TODO);
    l.tasks[l.count++] = task("a6", "课外阅读30分钟", "其他", 30, HW_ST_TODO);
    return l;
}

static void start_timer(hw_timer_t *t, int minutes, int elapsed_s) {
    hw_timer_start(t, "a2", minutes, 0);
    hw_timer_tick(t, (int64_t)elapsed_s * 1000);
}

int main(int argc, char **argv) {
    s_out = argc > 1 ? argv[1] : ".";
    char ipath[512];
    snprintf(ipath, sizeof ipath, "%s/index.tsv", s_out);
    s_index = fopen(ipath, "w");

    lv_init();
    lv_tick_set_cb(tick);
    lv_display_t *d = lv_display_create(W, H);
    lv_display_set_color_format(d, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(d, s_draw, NULL, sizeof s_draw, LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(d, flush);

    hw_ui_init();
    hw_ui_set_battery(87);

    // ---- first-time setup
    hw_ui_set_net(HW_NET_OFF);
    hw_ui_show(HW_PAGE_SETUP);
    hw_ui_robot(HW_MOOD_THINK);
    hw_ui_set_setup("选择设备\nBLUFI_HomeworkBot");
    shot("配网 · 等待手机", "第一次开机，用小程序选这个设备名配网；头灯灭（还没连上）");
    hw_ui_set_setup("连接失败\n检查密码或用2.4G");
    hw_ui_robot(HW_MOOD_WORRIED);
    shot("配网 · 连接失败", "Wi-Fi 密码错或连了 5G");

    // ---- list
    hw_ui_set_net(HW_NET_ONLINE);
    hw_list_t empty;
    hw_list_init(&empty);
    hw_ui_show(HW_PAGE_LIST);
    hw_ui_robot(HW_MOOD_IDLE);
    hw_ui_set_list(&empty, 0);
    shot("清单 · 还没有作业", "");
    hw_ui_set_empty(true);
    hw_ui_set_list(&empty, 0);
    shot("清单 · 今天全部完成", "");
    hw_ui_set_empty(false);

    hw_list_t l = sample_list();
    hw_ui_set_list(&l, 1);
    shot("清单 · 选中第 2 项", "头灯亮红=已连上 Mac；右侧电池 87%；第 1 项已完成（★）");
    hw_ui_set_list(&l, 2);
    run(1500);
    shot("清单 · 选中很长的作业名", "选中后名字会滚动显示（此为滚动 1.5 秒时）");
    hw_ui_set_list(&l, 5);
    shot("清单 · 往下翻到第 6 项", "一屏 5 项，超出时整体往上滚；第 6 项是选做（其他类，调色盘图标）");
    hw_ui_set_edit(30);
    hw_ui_set_list(&l, 1);
    shot("清单 · 改时间", "长按 ▼ 进入：分钟数变橙色，▲▼ 每次加减 5 分钟，确定或 3 秒不按就保存");
    hw_ui_set_edit(-1);
    hw_ui_set_list(&l, 0);
    shot("清单 · 选中已完成的项", "已完成的项：学科图标变淡，右侧 ★");
    hw_ui_set_net(HW_NET_MAC_DOWN);
    hw_ui_set_list(&l, 1);
    shot("清单 · Mac 离线", "头灯变灰；清单和计时照常能用");
    hw_ui_set_net(HW_NET_CONNECTING);
    shot("清单 · 正在连 Wi-Fi", "头灯灰");
    hw_ui_set_net(HW_NET_ONLINE);
    hw_ui_set_battery(15);
    shot("清单 · 电量低", "20% 以下电池变红并闪烁");
    hw_ui_set_battery(87);
    hw_ui_set_net(HW_NET_ONLINE);
    hw_ui_toast("收到新作业啦！", 2500);
    hw_ui_robot(HW_MOOD_HAPPY);
    shot("清单 · 收到新作业", "家长后台上传截图后");
    hw_ui_toast_hide();
    hw_ui_robot(HW_MOOD_SLEEP);
    shot("清单 · 机器人睡着了", "5 分钟没人按键后");

    // ---- timer
    hw_timer_t t;
    hw_ui_show(HW_PAGE_TIMER);
    hw_ui_robot(HW_MOOD_FOCUS);
    start_timer(&t, 25, 79);
    hw_ui_set_timer("练习册P34-35", &t);
    shot("计时 · 进行中", "机器人和信息各占一半；已经过了 1 分 19 秒");
    hw_timer_pause(&t, 79 * 1000);
    hw_ui_set_timer("练习册P34-35", &t);
    hw_ui_robot(HW_MOOD_IDLE);
    shot("计时 · 已暂停", "");
    start_timer(&t, 25, 25 * 60 - 90);
    hw_ui_set_timer("练习册P34-35", &t);
    hw_ui_robot(HW_MOOD_WORRIED);
    shot("计时 · 快到时间", "剩 2 分钟内：数字和计时条变橙色，提醒语音");
    start_timer(&t, 15, 200);
    hw_ui_set_timer("复习83、84、85和第9页的关于月份的单词", &t);
    hw_ui_robot(HW_MOOD_FOCUS);
    run(2000);
    shot("计时 · 很长的作业名", "名字循环滚动");
    run(9000);
    shot("计时 · 长名字滚完", "8 秒后停成一行“…”，不能挤到时钟");
    run(3000);
    shot("计时 · 长名字滚完再过3秒", "必须和上一张完全相同：滚动已停，不再重绘");

    // ---- alert
    hw_ui_show(HW_PAGE_ALERT);
    hw_ui_robot(HW_MOOD_WORRIED);
    hw_ui_set_alert("复习83、84、85和第9页的关于月份的单词", 0);
    run(9000);
    shot("到点 · 长名字滚完", "标题一行，不压按钮");
    hw_ui_set_alert("练习册P34-35", 0);
    shot("到点 · 选中“做完了”", "");
    hw_ui_set_alert("练习册P34-35", 1);
    shot("到点 · 选中“再来 5 分钟”", "");

    // ---- done / confirm
    hw_list_t all = sample_list();
    for (int i = 0; i < all.count; i++) all.tasks[i].status = HW_ST_DONE;
    hw_ui_set_done(&all);
    hw_ui_show(HW_PAGE_DONE);
    hw_ui_robot(HW_MOOD_HAPPY);
    // The sweep: robot drives down in a zig-zag, one card per row, then confetti and the title.
    shot("庆祝 · 0.0 秒", "最后一项做完：5 张已完成的卡片出现，机器人在上方");
    run(700);
    shot("庆祝 · 清扫第 1 行", "机器人开到第 1 行，滚刷向右扫，卡片被推出屏幕，滚刷处飞出彩屑");
    run(900);
    shot("庆祝 · 清扫第 2 行", "到屏幕边缘下一行，掉头向左扫");
    run(1200);
    shot("庆祝 · 清扫第 4 行", "");
    run(1200);
    shot("庆祝 · 扫最后一行", "");
    run(700);
    shot("庆祝 · 回到原位撒彩屑", "卡片全部清空，机器人跳起，标题出现");
    run(1500);
    shot("全部完成", "庆祝结束后停在这里，10 秒后回到清单");
    hw_ui_show(HW_PAGE_CONFIRM);
    hw_ui_robot(HW_MOOD_THINK);
    shot("重新配网确认", "清单页长按 ▲ 进入");

    // ---- talking
    hw_ui_show(HW_PAGE_LIST);
    hw_ui_set_list(&l, 1);
    hw_ui_robot(HW_MOOD_LISTEN);
    hw_ui_rec_show(true);
    hw_ui_rec_update(3400, 70);
    shot("说话 · 录音中", "长按确定键后立即出现；红点闪烁，音量条跟着声音跳");
    hw_ui_rec_update(8600, 35);
    shot("说话 · 快到 10 秒上限", "音量条变橙色");
    hw_ui_rec_show(false);
    hw_ui_toast("想一想…", 0);
    hw_ui_robot(HW_MOOD_THINK);
    shot("说话 · 松手后在想", "");
    hw_ui_toast("听到：复习83、84、85和第9页的关于月份的单词\n好的，记下英语复习单词啦！", 6000);
    hw_ui_robot(HW_MOOD_HAPPY);
    shot("说话 · 显示听到的内容和回复", "回复同时播放云夏的声音");
    hw_ui_toast("Mac没连上", 3000);
    hw_ui_robot(HW_MOOD_WORRIED);
    shot("说话 · Mac 没连上", "");
    hw_ui_toast_hide();

    // ---- robot expressions
    static const struct { hw_mood_t m; const char *name; } MOODS[] = {
        { HW_MOOD_IDLE, "待机（会眨眼、东张西望）" }, { HW_MOOD_FOCUS, "专注（陪写，滚刷在转）" },
        { HW_MOOD_THINK, "思考（眼睛左右扫）" }, { HW_MOOD_HAPPY, "开心" },
        { HW_MOOD_WORRIED, "着急（头灯闪）" }, { HW_MOOD_LISTEN, "聆听（大眼睛）" },
        { HW_MOOD_SLEEP, "睡着" },
    };
    hw_ui_set_list(&l, 1);
    for (size_t i = 0; i < sizeof MOODS / sizeof MOODS[0]; i++) {
        hw_ui_robot(MOODS[i].m);
        char title[64];
        snprintf(title, sizeof title, "表情 · %s", MOODS[i].name);
        shot(title, "");
    }
    hw_ui_robot(HW_MOOD_IDLE);
    run(6100);
    shot("表情 · 待机转身（朝左）", "待机时每 12 秒左右转一次身");
    hw_ui_show(HW_PAGE_TIMER);
    hw_ui_set_timer("练习册P34-35", &t);
    hw_ui_robot(HW_MOOD_FOCUS);   // keeps facing left from the shot above
    shot("计时 · 朝左", "大尺寸的朝左版本");
    fclose(s_index);
    printf("%d screens -> %s\n", s_n, s_out);
    return 0;
}
