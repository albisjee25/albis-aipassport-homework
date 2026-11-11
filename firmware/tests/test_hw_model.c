// Host tests for main/hw_model.c (homework helper logic).
#include "hw_model.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define MIN (60 * 1000LL)

static hw_task_t task(const char *id, bool optional, hw_status_t st) {
    hw_task_t t = { 0 };
    strcpy(t.id, id);
    strcpy(t.title, id);
    t.minutes = 10;
    t.optional = optional;
    t.status = st;
    return t;
}

static void test_list_helpers(void) {
    hw_list_t l;
    hw_list_init(&l);
    assert(l.version == -1 && hw_list_next_todo(&l) == -1);
    assert(!hw_list_all_required_done(&l));          // empty list is not "all done"
    l.tasks[l.count++] = task("a1", false, HW_ST_DONE);
    l.tasks[l.count++] = task("b2", true, HW_ST_TODO);
    l.tasks[l.count++] = task("c3", false, HW_ST_TODO);
    assert(hw_list_find(&l, "c3") == 2 && hw_list_find(&l, "zz") == -1 && hw_list_find(&l, NULL) == -1);
    assert(hw_list_required(&l) == 2 && hw_list_required_done(&l) == 1);
    assert(hw_list_next_todo(&l) == 2);               // required before optional
    l.tasks[2].status = HW_ST_DONE;
    assert(hw_list_all_required_done(&l));
    assert(hw_list_next_todo(&l) == 1);               // then the optional one

    hw_list_t in = l;
    assert(!hw_list_has_new_ids(&l, &in));
    in.tasks[in.count++] = task("d4", false, HW_ST_TODO);
    assert(hw_list_has_new_ids(&l, &in));
}

static void test_utf8_copy(void) {
    char buf[8];
    // "数学作业" is 12 bytes; only two characters (6 bytes) fit in 8 with NUL.
    assert(hw_utf8_copy(buf, sizeof buf, "数学作业") == 6);
    assert(strcmp(buf, "数学") == 0);
    assert(hw_utf8_copy(buf, sizeof buf, "abc") == 3 && strcmp(buf, "abc") == 0);
    assert(hw_utf8_copy(buf, sizeof buf, NULL) == 0 && buf[0] == '\0');
}

static void test_reminder_window(void) {
    assert(hw_remind_before_ms(25 * MIN) == 2 * MIN);
    assert(hw_remind_before_ms(5 * MIN) == 1 * MIN);
    assert(hw_remind_before_ms(3 * MIN) == 1 * MIN);
}

static void test_countdown_reminds_once_then_times_up(void) {
    hw_timer_t t;
    hw_timer_start(&t, "m1", 25, 0);
    assert(t.phase == HW_T_RUNNING && hw_timer_seconds_left(&t) == 25 * 60);
    assert(hw_timer_tick(&t, 22 * MIN) == HW_TEV_NONE);
    assert(hw_timer_tick(&t, 23 * MIN) == HW_TEV_REMIND);     // exactly 2 min left
    assert(hw_timer_tick(&t, 23 * MIN + 1000) == HW_TEV_NONE); // only once
    assert(hw_timer_tick(&t, 25 * MIN) == HW_TEV_TIMEUP);
    assert(t.phase == HW_T_ALERT && hw_timer_seconds_left(&t) == 0);
    assert(hw_timer_tick(&t, 26 * MIN) == HW_TEV_NONE);
}

static void test_short_task_reminds_at_one_minute(void) {
    hw_timer_t t;
    hw_timer_start(&t, "s", 5, 0);
    assert(hw_timer_tick(&t, 3 * MIN + 59000) == HW_TEV_NONE);
    assert(hw_timer_tick(&t, 4 * MIN) == HW_TEV_REMIND);
    hw_timer_start(&t, "x", 1, 0);                             // 1-minute task: no reminder
    assert(hw_timer_tick(&t, 30000) == HW_TEV_NONE);
    assert(hw_timer_tick(&t, MIN) == HW_TEV_TIMEUP);
}

static void test_big_jump_reports_timeup_not_remind(void) {
    hw_timer_t t;
    hw_timer_start(&t, "j", 10, 0);
    assert(hw_timer_tick(&t, 11 * MIN) == HW_TEV_TIMEUP);
}

static void test_pause_freezes_time(void) {
    hw_timer_t t;
    hw_timer_start(&t, "p", 10, 0);
    hw_timer_pause(&t, 1 * MIN);
    assert(t.phase == HW_T_PAUSED);
    assert(hw_timer_tick(&t, 9 * MIN) == HW_TEV_NONE);
    assert(hw_timer_seconds_left(&t) == 9 * 60);
    hw_timer_resume(&t, 9 * MIN);
    assert(hw_timer_tick(&t, 10 * MIN) == HW_TEV_NONE);
    assert(hw_timer_seconds_left(&t) == 8 * 60);
}

static void test_extend(void) {
    hw_timer_t t;
    hw_timer_start(&t, "e", 10, 0);
    hw_timer_tick(&t, 10 * MIN);
    assert(t.phase == HW_T_ALERT);
    hw_timer_extend(&t, HW_EXTEND_MIN, 10 * MIN);           // "再来 5 分钟"
    assert(t.phase == HW_T_RUNNING && hw_timer_seconds_left(&t) == 5 * 60);
    assert(hw_timer_tick(&t, 14 * MIN) == HW_TEV_REMIND);   // 5-min window -> remind at 1 min
    assert(hw_timer_tick(&t, 15 * MIN) == HW_TEV_TIMEUP);

    hw_timer_start(&t, "r", 10, 0);                          // extend while running
    hw_timer_tick(&t, 9 * MIN);                              // reminder already passed
    hw_timer_extend(&t, 5, 9 * MIN);
    assert(hw_timer_seconds_left(&t) == 6 * 60);
    assert(hw_timer_tick(&t, 13 * MIN) == HW_TEV_REMIND);    // re-armed: 2 min left again
}

static void test_permille_and_clock(void) {
    hw_timer_t t;
    hw_timer_start(&t, "c", 10, 0);
    hw_timer_tick(&t, 5 * MIN);
    assert(hw_timer_permille(&t) == 500);
    char buf[12];
    hw_format_clock(25 * 60, buf, sizeof buf); assert(strcmp(buf, "25:00") == 0);
    hw_format_clock(59, buf, sizeof buf);      assert(strcmp(buf, "00:59") == 0);
    hw_format_clock(3725, buf, sizeof buf);    assert(strcmp(buf, "1:02:05") == 0);
    hw_format_clock(-3, buf, sizeof buf);      assert(strcmp(buf, "00:00") == 0);
}

static void test_idle_rhythm(void) {
    hw_idle_t s;
    hw_idle_init(&s, 0, 42);
    assert(s.next_ms >= HW_IDLE_MIN_MS && s.next_ms <= HW_IDLE_MAX_MS);
    assert(!hw_idle_due(&s, HW_IDLE_MIN_MS - 1, true));
    int chirps = 0;
    for (int64_t now = 0; now < HW_IDLE_SLEEP_MS + 10 * MIN; now += 1000) {
        if (hw_idle_due(&s, now, true)) {
            chirps++;
            assert(now < HW_IDLE_SLEEP_MS);                  // never after falling asleep
        }
    }
    assert(chirps >= 3 && chirps <= 10);                     // 5 min / 30-90 s
    assert(s.asleep);
    hw_idle_activity(&s, 20 * MIN);                          // key press wakes it
    assert(!s.asleep);
    assert(!hw_idle_due(&s, 20 * MIN + 1000, true));
}

static void test_idle_quiet_screens(void) {
    hw_idle_t s;
    hw_idle_init(&s, 0, 7);
    for (int64_t now = 0; now < 4 * MIN; now += 1000) assert(!hw_idle_due(&s, now, false));
    // Back on the list: no burst of saved-up chirps.
    int burst = 0;
    for (int64_t now = 4 * MIN; now < 4 * MIN + 5000; now += 1000) burst += hw_idle_due(&s, now, true);
    assert(burst <= 1);
    int v = hw_idle_pick(&s, 3);
    assert(v >= 0 && v < 3 && hw_idle_pick(&s, 0) == 0);
}

static void test_worked_time_skips_pauses_counts_alert(void) {
    hw_timer_t t;
    hw_timer_start(&t, "a", 10, 0);
    hw_timer_tick(&t, 3 * MIN);
    hw_timer_pause(&t, 4 * MIN);               // 4 min worked
    hw_timer_resume(&t, 9 * MIN);              // 5 min break: not counted
    assert(hw_timer_tick(&t, 15 * MIN) == HW_TEV_TIMEUP);   // 6 more: time up after 10
    hw_timer_tick(&t, 17 * MIN);               // still writing on the alert screen
    assert(hw_timer_worked_s(&t) == 12 * 60);
    hw_timer_tick(&t, 120 * MIN);              // walked away: alert time is capped
    assert(hw_timer_worked_s(&t) == 10 * 60 + 30 * 60);
}

static void test_set_minutes(void) {
    hw_timer_t t;
    hw_timer_start(&t, "a", 25, 0);
    hw_timer_tick(&t, 10 * MIN);
    hw_timer_set_minutes(&t, 20, 10 * MIN);     // "make it 20": 10 spent, 10 left
    assert(hw_timer_seconds_left(&t) == 10 * 60 && t.total_ms == 20 * MIN);
    hw_timer_set_minutes(&t, 5, 10 * MIN);      // shorter than already spent: 1 min left
    assert(hw_timer_seconds_left(&t) == 60 && t.reminded);
    hw_timer_tick(&t, 12 * MIN);                // time up
    assert(t.phase == HW_T_ALERT);
    hw_timer_set_minutes(&t, 30, 12 * MIN);     // from the alert: runs again
    assert(t.phase == HW_T_RUNNING && hw_timer_seconds_left(&t) == 19 * 60);
    hw_timer_t idle;
    hw_timer_reset(&idle);
    hw_timer_set_minutes(&idle, 20, 0);
    assert(idle.phase == HW_T_IDLE);
}

static void test_edit_step(void) {
    assert(hw_edit_step(25, true) == 30 && hw_edit_step(25, false) == 20);
    assert(hw_edit_step(12, true) == 15 && hw_edit_step(12, false) == 10);   // snaps to 5s
    assert(hw_edit_step(5, false) == HW_EDIT_MIN && hw_edit_step(120, true) == HW_EDIT_MAX);
    assert(hw_edit_step(3, false) == HW_EDIT_MIN && hw_edit_step(150, false) == HW_EDIT_MAX);
}

int main(void) {
    test_worked_time_skips_pauses_counts_alert();
    test_set_minutes();
    test_edit_step();
    test_list_helpers();
    test_utf8_copy();
    test_reminder_window();
    test_countdown_reminds_once_then_times_up();
    test_short_task_reminds_at_one_minute();
    test_big_jump_reports_timeup_not_remind();
    test_pause_freezes_time();
    test_extend();
    test_permille_and_clock();
    test_idle_rhythm();
    test_idle_quiet_screens();
    puts("test_hw_model: PASS");
    return 0;
}
