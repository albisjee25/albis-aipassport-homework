// main/hw_model.h - homework helper state that does not depend on ESP-IDF or LVGL:
// the task list, the countdown timer with its reminders, and the idle chirp rhythm.
// Times are milliseconds from a monotonic clock supplied by the caller.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define HW_MAX_TASKS     12
#define HW_ID_LEN        8      // relay ids are 6 hex chars
#define HW_TITLE_LEN     100    // 32 Chinese characters in UTF-8 plus NUL (titles are verbatim)
#define HW_SUBJECT_LEN   12
#define HW_EXTEND_MIN    5
#define HW_EDIT_STEP     5      // list page: one key press changes the duration this much
#define HW_EDIT_MIN      5
#define HW_EDIT_MAX      120

typedef enum { HW_ST_TODO = 0, HW_ST_DOING, HW_ST_DONE } hw_status_t;

typedef struct {
    char id[HW_ID_LEN];
    char title[HW_TITLE_LEN];
    char subject[HW_SUBJECT_LEN];
    uint16_t minutes;
    hw_status_t status;
} hw_task_t;

typedef struct {
    hw_task_t tasks[HW_MAX_TASKS];
    int count;
    int32_t version;     // relay list version; -1 = never synced
} hw_list_t;

void hw_list_init(hw_list_t *l);
int hw_list_find(const hw_list_t *l, const char *id);
// Every task of the day has to be done: there is no optional homework.
int hw_list_done_count(const hw_list_t *l);
bool hw_list_all_done(const hw_list_t *l);
// First task that is not done; -1 if none.
int hw_list_next_todo(const hw_list_t *l);
// True when `incoming` contains an id that `old` does not (a new assignment arrived).
bool hw_list_has_new_ids(const hw_list_t *old, const hw_list_t *incoming);
// One key step of the duration editor: up/down to the next multiple of HW_EDIT_STEP,
// kept within HW_EDIT_MIN..HW_EDIT_MAX.
int hw_edit_step(int minutes, bool up);
// Copy a UTF-8 string into dst without splitting a multi-byte character.
size_t hw_utf8_copy(char *dst, size_t size, const char *src);

// ---- countdown -------------------------------------------------------------------
typedef enum { HW_T_IDLE = 0, HW_T_RUNNING, HW_T_PAUSED, HW_T_ALERT } hw_timer_phase_t;
typedef enum { HW_TEV_NONE = 0, HW_TEV_REMIND, HW_TEV_TIMEUP } hw_timer_event_t;

typedef struct {
    hw_timer_phase_t phase;
    char task_id[HW_ID_LEN];
    int64_t total_ms;
    int64_t remaining_ms;
    int64_t last_ms;
    bool reminded;
    int64_t worked_ms;   // real working time: running, plus up to HW_ALERT_COUNT_MS after time-up
    int64_t alert_ms;    // time spent on the time-up screen so far
} hw_timer_t;

// After time is up the child often keeps writing until they press "done"; count that
// too, but at most this long (they may simply have walked away).
#define HW_ALERT_COUNT_MS (30LL * 60 * 1000)

// Remind 2 minutes before the end; for tasks of 5 minutes or less, 1 minute before.
int64_t hw_remind_before_ms(int64_t total_ms);
void hw_timer_reset(hw_timer_t *t);
void hw_timer_start(hw_timer_t *t, const char *task_id, int minutes, int64_t now_ms);
void hw_timer_pause(hw_timer_t *t, int64_t now_ms);
void hw_timer_resume(hw_timer_t *t, int64_t now_ms);
// Add minutes. From ALERT this restarts the countdown with just the extra time.
void hw_timer_extend(hw_timer_t *t, int minutes, int64_t now_ms);
// "Make it N minutes": the whole countdown becomes N minutes long (time already spent
// counts towards it). At least one minute is always left. From ALERT it runs again.
void hw_timer_set_minutes(hw_timer_t *t, int minutes, int64_t now_ms);
// Real working seconds so far (pauses excluded), for the done report.
int hw_timer_worked_s(const hw_timer_t *t);
// Advance the clock; returns each reminder / time-up event exactly once.
hw_timer_event_t hw_timer_tick(hw_timer_t *t, int64_t now_ms);
// Whole seconds left, rounded up (so 0 appears only when time is really up).
int hw_timer_seconds_left(const hw_timer_t *t);
// 0..1000 of the countdown elapsed, for the progress bar.
int hw_timer_permille(const hw_timer_t *t);
// "MM:SS" (or "H:MM:SS" for an hour or more).
void hw_format_clock(int seconds, char *buf, size_t size);

// ---- idle chirps -------------------------------------------------------------------
// While waiting on the list screen the robot chirps every 30-90 s; after 5 minutes
// without any key it falls asleep (quiet) until the next key press.
#define HW_IDLE_MIN_MS   (30 * 1000)
#define HW_IDLE_MAX_MS   (90 * 1000)
#define HW_IDLE_SLEEP_MS (5 * 60 * 1000)

typedef struct {
    int64_t next_ms;
    int64_t last_activity_ms;
    bool asleep;
    uint32_t rng;
} hw_idle_t;

void hw_idle_init(hw_idle_t *s, int64_t now_ms, uint32_t seed);
// A key press: wakes the robot and restarts the rhythm.
void hw_idle_activity(hw_idle_t *s, int64_t now_ms);
// `allowed` is false on screens that must stay quiet (countdown, alert, setup).
// Returns true when a chirp should play now; schedules the next one.
bool hw_idle_due(hw_idle_t *s, int64_t now_ms, bool allowed);
// Which chirp variant to use (0..n-1), drawn from the same generator.
int hw_idle_pick(hw_idle_t *s, int n);
