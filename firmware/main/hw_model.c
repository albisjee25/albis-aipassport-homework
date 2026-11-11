// main/hw_model.c - see hw_model.h.
#include "hw_model.h"

#include <stdio.h>
#include <string.h>

void hw_list_init(hw_list_t *l) {
    memset(l, 0, sizeof(*l));
    l->version = -1;
}

int hw_list_find(const hw_list_t *l, const char *id) {
    if (!id) return -1;
    for (int i = 0; i < l->count; i++) {
        if (strncmp(l->tasks[i].id, id, HW_ID_LEN) == 0) return i;
    }
    return -1;
}

int hw_list_required(const hw_list_t *l) {
    int n = 0;
    for (int i = 0; i < l->count; i++) n += !l->tasks[i].optional;
    return n;
}

int hw_list_required_done(const hw_list_t *l) {
    int n = 0;
    for (int i = 0; i < l->count; i++) {
        n += !l->tasks[i].optional && l->tasks[i].status == HW_ST_DONE;
    }
    return n;
}

bool hw_list_all_required_done(const hw_list_t *l) {
    int req = hw_list_required(l);
    return req > 0 && hw_list_required_done(l) == req;
}

int hw_list_next_todo(const hw_list_t *l) {
    for (int i = 0; i < l->count; i++) {
        if (!l->tasks[i].optional && l->tasks[i].status != HW_ST_DONE) return i;
    }
    for (int i = 0; i < l->count; i++) {
        if (l->tasks[i].status != HW_ST_DONE) return i;
    }
    return -1;
}

bool hw_list_has_new_ids(const hw_list_t *old, const hw_list_t *incoming) {
    for (int i = 0; i < incoming->count; i++) {
        if (hw_list_find(old, incoming->tasks[i].id) < 0) return true;
    }
    return false;
}

size_t hw_utf8_copy(char *dst, size_t size, const char *src) {
    if (!dst || size == 0) return 0;
    size_t n = 0;
    if (src) {
        while (src[n] && n + 1 < size) n++;
        // Step back over continuation bytes so a character is never cut in half.
        if (src[n]) {
            while (n > 0 && ((unsigned char)src[n] & 0xC0) == 0x80) n--;
        }
        memcpy(dst, src, n);
    }
    dst[n] = '\0';
    return n;
}

// ---- countdown -------------------------------------------------------------------
int64_t hw_remind_before_ms(int64_t total_ms) {
    return total_ms <= 5 * 60 * 1000 ? 60 * 1000 : 2 * 60 * 1000;
}

void hw_timer_reset(hw_timer_t *t) {
    memset(t, 0, sizeof(*t));
}

void hw_timer_start(hw_timer_t *t, const char *task_id, int minutes, int64_t now_ms) {
    hw_timer_reset(t);
    if (minutes < 1) minutes = 1;
    hw_utf8_copy(t->task_id, sizeof(t->task_id), task_id);
    t->total_ms = (int64_t)minutes * 60 * 1000;
    t->remaining_ms = t->total_ms;
    t->last_ms = now_ms;
    t->phase = HW_T_RUNNING;
    // A countdown shorter than its reminder window never reminds.
    t->reminded = t->total_ms <= hw_remind_before_ms(t->total_ms);
}

void hw_timer_pause(hw_timer_t *t, int64_t now_ms) {
    if (t->phase != HW_T_RUNNING) return;
    hw_timer_tick(t, now_ms);
    if (t->phase == HW_T_RUNNING) t->phase = HW_T_PAUSED;
}

void hw_timer_resume(hw_timer_t *t, int64_t now_ms) {
    if (t->phase != HW_T_PAUSED) return;
    t->last_ms = now_ms;
    t->phase = HW_T_RUNNING;
}

void hw_timer_extend(hw_timer_t *t, int minutes, int64_t now_ms) {
    if (t->phase == HW_T_IDLE || minutes < 1) return;
    int64_t add = (int64_t)minutes * 60 * 1000;
    if (t->phase == HW_T_ALERT) {
        hw_timer_tick(t, now_ms);              // counts the time spent on the alert
        t->total_ms = add;
        t->remaining_ms = add;
        t->phase = HW_T_RUNNING;
    } else {
        hw_timer_tick(t, now_ms);
        t->total_ms += add;
        t->remaining_ms += add;
    }
    t->last_ms = now_ms;
    t->reminded = t->remaining_ms <= hw_remind_before_ms(t->total_ms);
}

void hw_timer_set_minutes(hw_timer_t *t, int minutes, int64_t now_ms) {
    if (t->phase == HW_T_IDLE || minutes < 1) return;
    hw_timer_tick(t, now_ms);
    int64_t spent = t->total_ms - t->remaining_ms;
    int64_t total = (int64_t)minutes * 60 * 1000;
    if (total < spent + 60 * 1000) total = spent + 60 * 1000;
    t->total_ms = total;
    t->remaining_ms = total - spent;
    if (t->phase == HW_T_ALERT) t->phase = HW_T_RUNNING;
    t->last_ms = now_ms;
    t->reminded = t->remaining_ms <= hw_remind_before_ms(t->total_ms);
}

int hw_timer_worked_s(const hw_timer_t *t) {
    return (int)((t->worked_ms + 500) / 1000);
}

int hw_edit_step(int minutes, bool up) {
    int m = up ? (minutes / HW_EDIT_STEP + 1) * HW_EDIT_STEP
               : ((minutes + HW_EDIT_STEP - 1) / HW_EDIT_STEP - 1) * HW_EDIT_STEP;
    if (m < HW_EDIT_MIN) m = HW_EDIT_MIN;
    if (m > HW_EDIT_MAX) m = HW_EDIT_MAX;
    return m;
}

hw_timer_event_t hw_timer_tick(hw_timer_t *t, int64_t now_ms) {
    if (t->phase == HW_T_ALERT) {
        int64_t dt = now_ms - t->last_ms;
        if (dt < 0) dt = 0;
        t->last_ms = now_ms;
        if (t->alert_ms + dt > HW_ALERT_COUNT_MS) dt = HW_ALERT_COUNT_MS - t->alert_ms;
        if (dt > 0) {
            t->alert_ms += dt;
            t->worked_ms += dt;
        }
        return HW_TEV_NONE;
    }
    if (t->phase != HW_T_RUNNING) return HW_TEV_NONE;
    int64_t dt = now_ms - t->last_ms;
    if (dt < 0) dt = 0;
    t->last_ms = now_ms;
    t->worked_ms += dt;
    t->remaining_ms -= dt;
    if (t->remaining_ms <= 0) {
        t->remaining_ms = 0;
        t->phase = HW_T_ALERT;
        t->reminded = true;
        return HW_TEV_TIMEUP;
    }
    if (!t->reminded && t->remaining_ms <= hw_remind_before_ms(t->total_ms)) {
        t->reminded = true;
        return HW_TEV_REMIND;
    }
    return HW_TEV_NONE;
}

int hw_timer_seconds_left(const hw_timer_t *t) {
    if (t->remaining_ms <= 0) return 0;
    return (int)((t->remaining_ms + 999) / 1000);
}

int hw_timer_permille(const hw_timer_t *t) {
    if (t->total_ms <= 0) return 0;
    int64_t done = t->total_ms - t->remaining_ms;
    if (done < 0) done = 0;
    return (int)(done * 1000 / t->total_ms);
}

void hw_format_clock(int seconds, char *buf, size_t size) {
    if (seconds < 0) seconds = 0;
    int h = seconds / 3600, m = (seconds / 60) % 60, s = seconds % 60;
    if (h > 0) snprintf(buf, size, "%d:%02d:%02d", h, m, s);
    else snprintf(buf, size, "%02d:%02d", m, s);
}

// ---- idle chirps -------------------------------------------------------------------
static uint32_t next_rand(hw_idle_t *s) {
    // xorshift32: tiny, deterministic for tests.
    uint32_t x = s->rng ? s->rng : 0x9E3779B9u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    s->rng = x;
    return x;
}

static void schedule(hw_idle_t *s, int64_t now_ms) {
    s->next_ms = now_ms + HW_IDLE_MIN_MS + (int64_t)(next_rand(s) % (HW_IDLE_MAX_MS - HW_IDLE_MIN_MS + 1));
}

void hw_idle_init(hw_idle_t *s, int64_t now_ms, uint32_t seed) {
    memset(s, 0, sizeof(*s));
    s->rng = seed;
    s->last_activity_ms = now_ms;
    schedule(s, now_ms);
}

void hw_idle_activity(hw_idle_t *s, int64_t now_ms) {
    s->last_activity_ms = now_ms;
    s->asleep = false;
    schedule(s, now_ms);
}

bool hw_idle_due(hw_idle_t *s, int64_t now_ms, bool allowed) {
    if (now_ms - s->last_activity_ms >= HW_IDLE_SLEEP_MS) s->asleep = true;
    if (s->asleep) return false;
    if (!allowed) {
        // Quiet screens push the rhythm back instead of saving up chirps.
        if (now_ms >= s->next_ms) schedule(s, now_ms);
        return false;
    }
    if (now_ms < s->next_ms) return false;
    schedule(s, now_ms);
    return true;
}

int hw_idle_pick(hw_idle_t *s, int n) {
    return n > 0 ? (int)(next_rand(s) % (uint32_t)n) : 0;
}
