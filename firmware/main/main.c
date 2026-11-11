// main/main.c - 作业助手 (homework helper) for FoloToy AI Passport.
//
// Pages and keys (OK long press on list / timer / alert = push-to-talk, see hw_talk.h):
//   list    UP/DOWN click: select · OK click: start the countdown (a done task starts
//           again) · UP long: Wi-Fi setup
//           DOWN long: edit the selected task's minutes (UP/DOWN ±5, OK or 3 s idle: save)
//   timer   OK click: pause/resume · DOWN long: done · UP long: stop, back to the list
//   alert   UP/DOWN click: choose "done" / "five more minutes" · OK click: confirm
//   done    any key: back to the list
//   confirm OK click: forget Wi-Fi and restart into setup · other keys: cancel
//
// Threads:
//   key callback (esp_timer task)  enqueue only
//   app task                       owns all state below, drives the UI and sounds
//   net task (hw_net.c)            Wi-Fi, finds the Mac, syncs the list
//   sound task (hw_sound.c)        chirps and phrases
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp_battery.h"
#include "bsp_button.h"
#include "bsp_display.h"
#include "bsp_i2c.h"
#include "bsp_pins.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"   // DIAG(keys)
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hw_model.h"
#include "hw_net.h"
#include "hw_provision.h"
#include "hw_sound.h"
#include "hw_talk.h"
#include "hw_ui.h"
#include "key_guard.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "homework";

#define TICK_MS            200
#define BATTERY_EVERY_MS   (30 * 1000)
#define ALERT_REPEAT_MS    (60 * 1000)
#define ALERT_REPEATS      3
#define DONE_PAGE_MS       (8 * 1000)
#define NVS_NS             "homework"
#define NVS_KEY_LIST       "list"

typedef enum { MSG_KEY = 0, MSG_LIST, MSG_TALK } msg_kind_t;
typedef struct {
    msg_kind_t kind;
    bsp_btn_t btn;
    bsp_btn_ev_t ev;
} msg_t;

static QueueHandle_t s_queue;
static volatile bool s_input_ready;

// ---- app state (app task only, except s_pending which the net task fills) ----------
static hw_list_t s_list;
static hw_list_t *s_pending;            // heap: normal mode only (Wi-Fi setup needs the RAM)
static hw_list_t *s_scratch;
static SemaphoreHandle_t s_pending_lock;
static hw_timer_t s_timer;
static hw_idle_t s_idle;
static hw_page_t s_page = HW_PAGE_LIST;
static int s_sel;
static int s_alert_choice;
static int s_alert_repeats;
static int64_t s_alert_last_ms;
static int64_t s_done_since_ms;
static bool s_synced_once;
static hw_talk_result_t *s_talk_pending;     // filled by the talk task
static hw_talk_result_t *s_talk_scratch;
static hw_talk_state_t s_talk_shown;
static int64_t s_calm_at_ms;
// List-page duration editor (keys only; voice cannot change durations on the list page).
#define EDIT_IDLE_SAVE_MS 3000
static char s_edit_id[HW_ID_LEN];       // empty = not editing
static int s_edit_min;
static int64_t s_edit_last_ms;

// A key that woke the chip from deep sleep is still held during boot; ignore it
// until it is released (see key_guard.h).
#define KEY_GUARD_MAX_US (10LL * 1000 * 1000)
static key_guard_t s_key_guard;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

static void log_heap(const char *when) {
    ESP_LOGI(TAG, "heap %s: free %u, min %u, largest block %u", when,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

// Runs on the shared esp_timer task: enqueue and return immediately.
static void on_key(bsp_btn_t btn, bsp_btn_ev_t ev, void *user) {
    (void)user;
    // Consume the guard first so an early release still disarms it.
    if (key_guard_consume(&s_key_guard, ev == BSP_BTN_RELEASE, esp_timer_get_time())) return;
    esp_rom_printf("[key] %lld b%d e%d\n", (long long)(esp_timer_get_time() / 1000), btn, ev);   // DIAG(keys)
    if (!s_input_ready || !s_queue) return;
    // UP / DOWN: a short press counts the moment it is released. The button component's
    // own CLICK waits 180 ms for a possible second press and merges quick presses into a
    // DOUBLE (or nothing at all when the second press is held a little), so fast presses
    // were lost. Long presses keep their own meaning and never count as a click.
    static bool s_long_seen[BSP_BTN_COUNT];
    if (btn == BSP_BTN_UP || btn == BSP_BTN_DOWN) {
        if (ev == BSP_BTN_PRESS) {
            s_long_seen[btn] = false;
            return;
        }
        if (ev == BSP_BTN_LONG) {
            s_long_seen[btn] = true;
        } else if (ev == BSP_BTN_RELEASE && !s_long_seen[btn]) {
            ev = BSP_BTN_CLICK;
        } else {
            return;                            // CLICK / DOUBLE / long release: already handled
        }
    }
    if (ev != BSP_BTN_CLICK && ev != BSP_BTN_LONG && ev != BSP_BTN_RELEASE &&
        !(ev == BSP_BTN_PRESS && btn == BSP_BTN_OK)) return;
    msg_t m = { .kind = MSG_KEY, .btn = btn, .ev = ev };
    (void)xQueueSend(s_queue, &m, 0);
}

// Net task: keep the newest list and wake the app task.
static void on_list(const hw_list_t *list) {
    if (xSemaphoreTake(s_pending_lock, pdMS_TO_TICKS(500)) != pdTRUE) return;
    *s_pending = *list;
    xSemaphoreGive(s_pending_lock);
    msg_t m = { .kind = MSG_LIST };
    (void)xQueueSend(s_queue, &m, 0);
}

// Talk task: keep the answer and wake the app task.
static void on_talk(const hw_talk_result_t *r) {
    if (xSemaphoreTake(s_pending_lock, pdMS_TO_TICKS(500)) != pdTRUE) return;
    *s_talk_pending = *r;
    xSemaphoreGive(s_pending_lock);
    msg_t m = { .kind = MSG_TALK };
    (void)xQueueSend(s_queue, &m, 0);
}

// ---- list cache: the last list survives power-off and a Mac that is switched off ----
static void cache_save(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    if (nvs_set_blob(h, NVS_KEY_LIST, &s_list, sizeof s_list) == ESP_OK) nvs_commit(h);
    nvs_close(h);
}

static void cache_load(void) {
    hw_list_init(&s_list);
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    size_t len = sizeof s_list;
    if (nvs_get_blob(h, NVS_KEY_LIST, &s_list, &len) != ESP_OK || len != sizeof s_list ||
        s_list.count < 0 || s_list.count > HW_MAX_TASKS) {
        hw_list_init(&s_list);
    }
    nvs_close(h);
}

// ---- helpers ---------------------------------------------------------------------------
static const hw_task_t *selected_task(void) {
    return s_sel >= 0 && s_sel < s_list.count ? &s_list.tasks[s_sel] : NULL;
}

static const char *timer_title(void) {
    int i = hw_list_find(&s_list, s_timer.task_id);
    return i >= 0 ? s_list.tasks[i].title : "";
}

static void show_list(void) {
    if (s_sel >= s_list.count) s_sel = s_list.count ? s_list.count - 1 : 0;
    s_page = HW_PAGE_LIST;
    hw_ui_set_list(&s_list, s_sel);
    hw_ui_show(HW_PAGE_LIST);
    hw_ui_robot(s_idle.asleep ? HW_MOOD_SLEEP : HW_MOOD_IDLE);
}

static void set_local_status(const char *id, hw_status_t st) {
    int i = hw_list_find(&s_list, id);
    if (i < 0) return;
    for (int k = 0; st == HW_ST_DOING && k < s_list.count; k++) {
        if (s_list.tasks[k].status == HW_ST_DOING) s_list.tasks[k].status = HW_ST_TODO;
    }
    s_list.tasks[i].status = st;
    cache_save();
}

static void start_selected(void) {
    const hw_task_t *t = selected_task();
    if (!t) return;
    // A done task starts again: it was marked done by mistake. The Mac keeps the time
    // already worked and adds this session to it. Pressed by mistake? DOWN long puts
    // it straight back to done.
    bool reopen = t->status == HW_ST_DONE;
    hw_timer_start(&s_timer, t->id, t->minutes, now_ms());
    set_local_status(t->id, HW_ST_DOING);
    hw_net_post_event(t->id, "start", -1);
    s_page = HW_PAGE_TIMER;
    hw_ui_set_timer(t->title, &s_timer);
    hw_ui_show(HW_PAGE_TIMER);
    hw_ui_robot(HW_MOOD_FOCUS);
    if (reopen) hw_ui_toast("这项重新开始啦", 2000);
    hw_sound_play(HW_CHIRP_HAPPY, HW_VOICE_START);
}

static void finish_current(void) {
    char id[HW_ID_LEN];
    hw_utf8_copy(id, sizeof id, s_timer.task_id);
    hw_timer_tick(&s_timer, now_ms());
    int worked_s = hw_timer_worked_s(&s_timer);     // the Mac learns durations from this
    hw_timer_reset(&s_timer);
    set_local_status(id, HW_ST_DONE);
    hw_net_post_event(id, "done", worked_s);
    if (hw_list_all_required_done(&s_list)) {
        s_page = HW_PAGE_DONE;
        s_done_since_ms = now_ms();
        hw_ui_set_done(hw_list_required_done(&s_list));
        hw_ui_show(HW_PAGE_DONE);
        hw_ui_robot(HW_MOOD_HAPPY);
        hw_sound_play(HW_CHIRP_HAPPY, HW_VOICE_ALLDONE);
        return;
    }
    int next = hw_list_next_todo(&s_list);
    if (next >= 0) s_sel = next;
    show_list();
    hw_ui_robot(HW_MOOD_HAPPY);
    hw_sound_play(HW_CHIRP_HAPPY, HW_VOICE_DONE);
}

static void stop_current(void) {
    char id[HW_ID_LEN];
    hw_utf8_copy(id, sizeof id, s_timer.task_id);
    hw_timer_reset(&s_timer);
    set_local_status(id, HW_ST_TODO);
    hw_net_post_event(id, "stop", -1);
    show_list();
}

// ---- list-page duration editor ------------------------------------------------------
static void edit_begin(void) {
    const hw_task_t *t = selected_task();
    if (!t || t->status == HW_ST_DONE) {
        hw_sound_play(HW_CHIRP_IDLE_B, HW_NO_VOICE);
        return;
    }
    hw_utf8_copy(s_edit_id, sizeof s_edit_id, t->id);
    s_edit_min = t->minutes;
    s_edit_last_ms = now_ms();
    hw_ui_set_edit(s_edit_min);
    hw_ui_set_list(&s_list, s_sel);
    hw_sound_play(HW_CHIRP_HELLO, HW_NO_VOICE);
}

// Saves on OK, on any long press, or after EDIT_IDLE_SAVE_MS without a key.
static void edit_save(void) {
    if (!s_edit_id[0]) return;
    int i = hw_list_find(&s_list, s_edit_id);
    if (i >= 0 && s_list.tasks[i].minutes != s_edit_min) {
        s_list.tasks[i].minutes = (uint16_t)s_edit_min;
        cache_save();
        hw_net_post_event(s_edit_id, "minutes", s_edit_min);
    }
    s_edit_id[0] = '\0';
    hw_ui_set_edit(-1);
    if (s_page == HW_PAGE_LIST) hw_ui_set_list(&s_list, s_sel);
    hw_sound_play(HW_CHIRP_HAPPY, HW_NO_VOICE);
}

// `src` may be s_scratch; it is not used after being copied into s_list.
static void merge_list(const hw_list_t *src, bool announce) {
    const hw_list_t *in = src;
    bool fresh = announce && s_synced_once && hw_list_has_new_ids(&s_list, in);
    char keep_id[HW_ID_LEN] = "";
    if (selected_task()) hw_utf8_copy(keep_id, sizeof keep_id, selected_task()->id);

    // The device owns the running countdown: keep its task "doing" locally.
    if (s_timer.phase != HW_T_IDLE) {
        int i = hw_list_find(in, s_timer.task_id);
        if (i < 0 || in->tasks[i].status == HW_ST_DONE) {
            hw_timer_reset(&s_timer);           // deleted or finished from the parent's Mac
            if (s_page == HW_PAGE_TIMER || s_page == HW_PAGE_ALERT) s_page = HW_PAGE_LIST;
        }
    }
    s_list = *in;
    s_synced_once = true;
    cache_save();

    int keep = hw_list_find(&s_list, keep_id);
    s_sel = keep >= 0 ? keep : (hw_list_next_todo(&s_list) >= 0 ? hw_list_next_todo(&s_list) : 0);
    if (s_page == HW_PAGE_LIST) show_list();
    if (s_page == HW_PAGE_LIST || s_page == HW_PAGE_DONE) {
        if (fresh) {
            if (s_page == HW_PAGE_DONE) show_list();
            hw_ui_toast("收到新作业啦！", 2500);
            hw_idle_activity(&s_idle, now_ms());
            hw_ui_robot(HW_MOOD_HAPPY);
            hw_sound_play(HW_CHIRP_HAPPY, HW_VOICE_NEWLIST);
        }
    } else if (s_page == HW_PAGE_TIMER || s_page == HW_PAGE_ALERT) {
        if (s_timer.phase == HW_T_IDLE) show_list();
    }
}

static void apply_new_list(void) {
    if (xSemaphoreTake(s_pending_lock, pdMS_TO_TICKS(500)) != pdTRUE) return;
    *s_scratch = *s_pending;
    xSemaphoreGive(s_pending_lock);
    merge_list(s_scratch, true);
}

static hw_mood_t page_mood(void) {
    switch (s_page) {
    case HW_PAGE_TIMER: return s_timer.phase == HW_T_PAUSED ? HW_MOOD_IDLE : HW_MOOD_FOCUS;
    case HW_PAGE_ALERT: return HW_MOOD_WORRIED;
    case HW_PAGE_DONE: return HW_MOOD_HAPPY;
    case HW_PAGE_CONFIRM: return HW_MOOD_THINK;
    default: return s_idle.asleep ? HW_MOOD_SLEEP : HW_MOOD_IDLE;
    }
}

static hw_mood_t mood_of(const char *m) {
    if (strcmp(m, "worried") == 0) return HW_MOOD_WORRIED;
    if (strcmp(m, "thinking") == 0 || strcmp(m, "confused") == 0) return HW_MOOD_THINK;
    return HW_MOOD_HAPPY;
}

// The Mac answered what the child said: show it, sync the list, run the actions.
static void apply_talk(void) {
    if (xSemaphoreTake(s_pending_lock, pdMS_TO_TICKS(500)) != pdTRUE) return;
    *s_talk_scratch = *s_talk_pending;
    xSemaphoreGive(s_pending_lock);
    const hw_talk_result_t *rp = s_talk_scratch;
    if (!rp->ok) {
        if (rp->error[0]) {
            hw_ui_toast(rp->error, 3000);
            hw_ui_robot(HW_MOOD_WORRIED);
        } else {
            hw_ui_toast_hide();
            hw_ui_robot(page_mood());
        }
        return;
    }
    if (rp->has_list) merge_list(&rp->list, false);   // the reply already says what changed
    for (int i = 0; i < rp->action_count; i++) {
        const hw_talk_action_t *a = &rp->actions[i];
        if (strcmp(a->type, "start") == 0) {
            int idx = hw_list_find(&s_list, a->id);
            if (idx < 0) continue;
            s_sel = idx;
            hw_timer_start(&s_timer, a->id, a->minutes > 0 ? a->minutes : s_list.tasks[idx].minutes, now_ms());
            set_local_status(a->id, HW_ST_DOING);  // the Mac already marked it
            s_page = HW_PAGE_TIMER;
            hw_ui_set_timer(s_list.tasks[idx].title, &s_timer);
            hw_ui_show(HW_PAGE_TIMER);
        } else if (strcmp(a->type, "set") == 0 && s_timer.phase != HW_T_IDLE && a->minutes > 0) {
            hw_timer_set_minutes(&s_timer, a->minutes, now_ms());
            int idx = hw_list_find(&s_list, s_timer.task_id);
            if (idx >= 0) {
                s_list.tasks[idx].minutes = (uint16_t)a->minutes;
                cache_save();
            }
            s_page = HW_PAGE_TIMER;
            hw_ui_set_timer(timer_title(), &s_timer);
            hw_ui_show(HW_PAGE_TIMER);
        } else if (strcmp(a->type, "extend") == 0 && s_timer.phase != HW_T_IDLE) {
            hw_timer_extend(&s_timer, a->minutes > 0 ? a->minutes : HW_EXTEND_MIN, now_ms());
            s_page = HW_PAGE_TIMER;
            hw_ui_set_timer(timer_title(), &s_timer);
            hw_ui_show(HW_PAGE_TIMER);
        }
    }
    if (s_page == HW_PAGE_LIST) hw_ui_set_list(&s_list, s_sel);
    static char shown[HW_TALK_TEXT_LEN * 2 + 16];
    if (rp->transcript[0]) snprintf(shown, sizeof shown, "听到：%s\n%s", rp->transcript, rp->reply);
    else snprintf(shown, sizeof shown, "%s", rp->reply);
    hw_ui_toast(shown, 6000);
    hw_ui_robot(mood_of(rp->mood));
}

// ---- keys ------------------------------------------------------------------------------
static void on_key_event(bsp_btn_t btn, bsp_btn_ev_t ev) {
    ESP_LOGI(TAG, "DIAG key handled b%d e%d page %d sel %d", btn, ev, s_page, s_sel);   // DIAG(keys)
    bool click = ev == BSP_BTN_CLICK, lng = ev == BSP_BTN_LONG;
    // Push-to-talk: hold OK on the list, timer or alert page; release to send.
    // Recording starts on PRESS (pre-roll) so the first words are not lost.
    bool talk_page = (s_page == HW_PAGE_LIST && !s_edit_id[0]) || s_page == HW_PAGE_TIMER ||
                     s_page == HW_PAGE_ALERT;
    hw_talk_state_t ts = hw_talk_state();
    if (ev == BSP_BTN_PRESS) {
        if (talk_page && ts == HW_TALK_IDLE) hw_talk_arm();
        return;
    }
    if (ev == BSP_BTN_RELEASE) {
        if (btn != BSP_BTN_OK) return;
        if (ts == HW_TALK_LISTENING) {
            hw_talk_end();
            hw_ui_rec_show(false);
            hw_ui_toast("想一想…", 0);
            hw_ui_robot(HW_MOOD_THINK);
        } else if (ts == HW_TALK_ARMED) {
            hw_talk_end();                         // a short press: drop the pre-roll
        }
        return;
    }
    // While armed a click is still an ordinary key; later stages wait for the answer.
    if (ts != HW_TALK_IDLE && ts != HW_TALK_ARMED) return;
    bool was_asleep = s_idle.asleep;
    hw_idle_activity(&s_idle, now_ms());
    if (lng && btn == BSP_BTN_OK && talk_page) {
        if (ts == HW_TALK_ARMED) {
            hw_talk_begin(s_page == HW_PAGE_TIMER ? "timer" : s_page == HW_PAGE_ALERT ? "alert" : "list");
            hw_ui_toast_hide();
            hw_ui_rec_show(true);
            hw_ui_robot(HW_MOOD_LISTEN);
        } else {
            hw_ui_toast("Mac没连上", 3000);
            hw_ui_robot(HW_MOOD_WORRIED);
        }
        return;
    }

    switch (s_page) {
    case HW_PAGE_LIST:
        if (s_edit_id[0]) {                     // editing a duration: keys belong to the editor
            if (click && (btn == BSP_BTN_UP || btn == BSP_BTN_DOWN)) {
                s_edit_min = hw_edit_step(s_edit_min, btn == BSP_BTN_UP);
                s_edit_last_ms = now_ms();
                hw_ui_set_edit(s_edit_min);
                hw_ui_set_list(&s_list, s_sel);
                hw_sound_play(HW_CHIRP_IDLE_A, HW_NO_VOICE);
            } else if (click || lng) {
                edit_save();
            }
            return;
        }
        if (was_asleep) {                       // the first key just wakes the robot up
            show_list();
            hw_sound_play(HW_CHIRP_HELLO, HW_NO_VOICE);
            return;
        }
        if (click && btn == BSP_BTN_UP && s_list.count) {
            s_sel = (s_sel + s_list.count - 1) % s_list.count;
            hw_ui_set_list(&s_list, s_sel);
        } else if (click && btn == BSP_BTN_DOWN && s_list.count) {
            s_sel = (s_sel + 1) % s_list.count;
            hw_ui_set_list(&s_list, s_sel);
        } else if (click && btn == BSP_BTN_OK) {
            start_selected();
        } else if (lng && btn == BSP_BTN_DOWN) {
            edit_begin();
        } else if (lng && btn == BSP_BTN_UP) {
            s_page = HW_PAGE_CONFIRM;
            hw_ui_show(HW_PAGE_CONFIRM);
            hw_ui_robot(HW_MOOD_THINK);
        }
        break;
    case HW_PAGE_TIMER:
        if (click && btn == BSP_BTN_OK) {
            if (s_timer.phase == HW_T_RUNNING) {
                hw_timer_pause(&s_timer, now_ms());
                hw_ui_robot(HW_MOOD_IDLE);
            } else {
                hw_timer_resume(&s_timer, now_ms());
                hw_ui_robot(HW_MOOD_FOCUS);
            }
            hw_ui_set_timer(timer_title(), &s_timer);
        } else if (lng && btn == BSP_BTN_DOWN) {
            finish_current();
        } else if (lng && btn == BSP_BTN_UP) {
            stop_current();
        }
        break;
    case HW_PAGE_ALERT:
        if (click && (btn == BSP_BTN_UP || btn == BSP_BTN_DOWN)) {
            s_alert_choice ^= 1;
            hw_ui_set_alert(timer_title(), s_alert_choice);
        } else if (click && btn == BSP_BTN_OK) {
            if (s_alert_choice == 0) {
                finish_current();
            } else {
                hw_timer_extend(&s_timer, HW_EXTEND_MIN, now_ms());
                s_page = HW_PAGE_TIMER;
                hw_ui_set_timer(timer_title(), &s_timer);
                hw_ui_show(HW_PAGE_TIMER);
                hw_ui_robot(HW_MOOD_FOCUS);
                hw_sound_play(HW_CHIRP_HAPPY, HW_VOICE_EXTEND);
            }
        }
        break;
    case HW_PAGE_DONE:
        if (click || lng) show_list();
        break;
    case HW_PAGE_CONFIRM:
        if (click && btn == BSP_BTN_OK) {
            hw_ui_set_setup("正在重启…");
            hw_net_forget_wifi();
            vTaskDelay(pdMS_TO_TICKS(300));
            esp_restart();
        } else if (click || lng) {
            show_list();
        }
        break;
    default:
        break;
    }
}

// ---- periodic work ---------------------------------------------------------------------
static void on_tick(int64_t now) {
    if (s_page == HW_PAGE_TIMER) {
        hw_timer_event_t ev = hw_timer_tick(&s_timer, now);
        if (ev == HW_TEV_REMIND) {
            hw_ui_robot(HW_MOOD_WORRIED);
            bool short_task = s_timer.total_ms <= 5 * 60 * 1000;
            hw_sound_play(HW_CHIRP_WORRIED, short_task ? HW_VOICE_REMIND1 : HW_VOICE_REMIND2);
        } else if (ev == HW_TEV_TIMEUP) {
            s_page = HW_PAGE_ALERT;
            s_alert_choice = 0;
            s_alert_repeats = 0;
            s_alert_last_ms = now;
            hw_ui_set_alert(timer_title(), s_alert_choice);
            hw_ui_show(HW_PAGE_ALERT);
            hw_ui_robot(HW_MOOD_WORRIED);
            hw_sound_play(HW_CHIRP_WORRIED, HW_VOICE_TIMEUP);
            return;
        }
        if (ev == HW_TEV_REMIND) s_calm_at_ms = now + 4000;
        if (s_calm_at_ms && now >= s_calm_at_ms) {
            s_calm_at_ms = 0;
            if (s_timer.phase == HW_T_RUNNING) hw_ui_robot(HW_MOOD_FOCUS);   // calm down after the reminder
        }
        hw_ui_set_timer(timer_title(), &s_timer);
    } else if (s_page == HW_PAGE_ALERT) {
        if (s_alert_repeats < ALERT_REPEATS && now - s_alert_last_ms >= ALERT_REPEAT_MS) {
            s_alert_repeats++;
            s_alert_last_ms = now;
            hw_sound_play(HW_CHIRP_WORRIED, HW_VOICE_TIMEUP);
        }
    } else if (s_page == HW_PAGE_DONE) {
        if (now - s_done_since_ms >= DONE_PAGE_MS) show_list();
    }
    if (s_edit_id[0] && now - s_edit_last_ms >= EDIT_IDLE_SAVE_MS) edit_save();

    bool was_asleep = s_idle.asleep;
    hw_talk_state_t ts = hw_talk_state();
    if (ts == HW_TALK_LISTENING) hw_ui_rec_update(hw_talk_elapsed_ms(), hw_talk_level());
    if (s_talk_shown == HW_TALK_LISTENING && ts != HW_TALK_LISTENING) hw_ui_rec_show(false);   // 10 s limit
    if (s_talk_shown == HW_TALK_SPEAKING && ts == HW_TALK_IDLE) hw_ui_robot(page_mood());
    s_talk_shown = ts;
    if (hw_idle_due(&s_idle, now, s_page == HW_PAGE_LIST && ts == HW_TALK_IDLE && !hw_sound_busy())) {
        static const hw_chirp_t IDLE[] = { HW_CHIRP_IDLE_A, HW_CHIRP_IDLE_B, HW_CHIRP_IDLE_C };
        hw_sound_play(IDLE[hw_idle_pick(&s_idle, 3)], HW_NO_VOICE);
    }
    if (!was_asleep && s_idle.asleep && s_page == HW_PAGE_LIST) hw_ui_robot(HW_MOOD_SLEEP);
}

static void app_task(void *arg) {
    (void)arg;
    int64_t next_battery = 0;
    hw_net_state_t shown_net = (hw_net_state_t)-1;
    msg_t m;
    for (;;) {
        int wait = hw_talk_state() == HW_TALK_LISTENING ? 80 : TICK_MS;   // smoother level meter
        if (xQueueReceive(s_queue, &m, pdMS_TO_TICKS(wait)) == pdTRUE) {
            if (m.kind == MSG_KEY) on_key_event(m.btn, m.ev);
            else if (m.kind == MSG_LIST) apply_new_list();
            else apply_talk();
        }
        int64_t now = now_ms();
        on_tick(now);
        hw_net_state_t st = hw_net_state();
        if (st != shown_net) {
            if (st == HW_NET_ONLINE && shown_net != HW_NET_ONLINE && shown_net != (hw_net_state_t)-1 &&
                s_page == HW_PAGE_LIST) {
                hw_sound_play(HW_CHIRP_HELLO, HW_NO_VOICE);
            }
            shown_net = st;
            hw_ui_set_net(st);
        }
        if (now >= next_battery) {
            hw_ui_set_battery(bsp_battery_soc());
            next_battery = now + BATTERY_EVERY_MS;
            log_heap("periodic");
        }
    }
}

// ---- first-time Wi-Fi setup ------------------------------------------------------------
static void run_setup(void) {
    hw_ui_show(HW_PAGE_SETUP);
    hw_ui_robot(HW_MOOD_THINK);
    esp_err_t err = hw_provision_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "provisioning failed to start: %s", esp_err_to_name(err));
        hw_ui_set_setup("蓝牙启动失败\n请重启设备");
        return;
    }
    log_heap("setup started (Wi-Fi + Bluetooth)");
    hw_prov_state_t shown = (hw_prov_state_t)-1;
    for (;;) {
        hw_prov_state_t st = hw_provision_state();
        if (st != shown) {
            shown = st;
            switch (st) {
            case HW_PROV_STARTING: hw_ui_set_setup("准备中…"); break;
            case HW_PROV_WAITING: hw_ui_set_setup("选择设备\nBLUFI_HomeworkBot"); break;
            case HW_PROV_PHONE:
                hw_ui_set_setup("手机已连接\n请输入 Wi-Fi 密码");
                log_heap("phone connected");
                break;
            case HW_PROV_JOINING: hw_ui_set_setup("正在连接 Wi-Fi…"); break;
            case HW_PROV_JOIN_FAILED:
                hw_ui_set_setup("连接失败\n检查密码或用2.4G");
                hw_ui_robot(HW_MOOD_WORRIED);
                break;
            case HW_PROV_DONE:
                hw_ui_set_setup("连好啦！马上重启");
                hw_ui_robot(HW_MOOD_HAPPY);
                vTaskDelay(pdMS_TO_TICKS(2500));
                esp_restart();
                break;
            case HW_PROV_ERROR: hw_ui_set_setup("蓝牙出错了\n请重启设备"); break;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

void app_main(void) {
    ESP_LOGI(TAG, "作业助手 starting");
    if (esp_sleep_get_wakeup_causes() & (1u << ESP_SLEEP_WAKEUP_GPIO)) {
        key_guard_arm(&s_key_guard, esp_timer_get_time(), KEY_GUARD_MAX_US);
    }

    bsp_i2c_init();
    if (bsp_display_init() != ESP_OK || !bsp_lvgl_init()) {
        ESP_LOGE(TAG, "display init failed (MOSI=%d SCLK=%d CS=%d DC=%d BL=%d)",
                 BSP_LCD_MOSI, BSP_LCD_SCLK, BSP_LCD_CS, BSP_LCD_DC, BSP_LCD_BL);
        return;
    }
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) {
        // Do not erase: the partition may hold the family's saved Wi-Fi network.
        ESP_LOGE(TAG, "NVS init failed: %s", esp_err_to_name(err));
    }
    hw_ui_init();
    bsp_display_backlight(100);
    bsp_battery_init();

    if (!hw_net_has_wifi_config()) {
        // Wi-Fi setup runs Wi-Fi and Bluetooth together and needs every free byte,
        // so the sound module (task + I2S buffers) stays off in this mode.
        hw_ui_set_battery(bsp_battery_soc());
        run_setup();
        return;
    }

    hw_sound_init();
    cache_load();
    hw_idle_init(&s_idle, now_ms(), esp_random());
    s_sel = hw_list_next_todo(&s_list) >= 0 ? hw_list_next_todo(&s_list) : 0;
    // A countdown never survives a restart: drop a stale "doing" mark.
    for (int i = 0; i < s_list.count; i++) {
        if (s_list.tasks[i].status == HW_ST_DOING) s_list.tasks[i].status = HW_ST_TODO;
    }
    show_list();
    hw_sound_play(HW_CHIRP_HELLO, HW_VOICE_HELLO);

    s_queue = xQueueCreate(12, sizeof(msg_t));
    s_pending_lock = xSemaphoreCreateMutex();
    s_pending = malloc(sizeof *s_pending);
    s_scratch = malloc(sizeof *s_scratch);
    s_talk_pending = malloc(sizeof *s_talk_pending);
    s_talk_scratch = malloc(sizeof *s_talk_scratch);
    if (!s_queue || !s_pending_lock || !s_pending || !s_scratch || !s_talk_pending || !s_talk_scratch ||
        xTaskCreate(app_task, "hw_app", 6144, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "app task creation failed");
        return;
    }
    err = hw_net_start(on_list, s_list.version);
    if (err != ESP_OK) ESP_LOGE(TAG, "network start failed: %s", esp_err_to_name(err));
    if (hw_talk_init(on_talk) != ESP_OK) ESP_LOGE(TAG, "talk task creation failed");

    if (bsp_button_init(on_key, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "button init failed");
        return;
    }
    if (s_key_guard.armed) {
        key_guard_sync_released(&s_key_guard, bsp_button_read_mv() >= BSP_BTN_MV_RELEASED_MIN);
    }
    s_input_ready = true;
    log_heap("ready");
    ESP_LOGI(TAG, "ready: %d cached tasks, version %d", s_list.count, (int)s_list.version);
}
