// main/hw_ui.h - homework helper screens on the 240 x 320 panel.
//
// One LVGL screen; each page is a container that is shown or hidden. Every function
// takes bsp_lvgl_lock() itself, so call them from the app task, never from a key
// callback.
#pragma once

#include <stdbool.h>

#include "hw_model.h"
#include "hw_net.h"

typedef enum {
    HW_PAGE_SETUP = 0,   // first-time Wi-Fi setup instructions
    HW_PAGE_LIST,
    HW_PAGE_TIMER,
    HW_PAGE_ALERT,       // time is up: done / five more minutes
    HW_PAGE_DONE,        // everything finished
    HW_PAGE_CONFIRM,     // re-run Wi-Fi setup?
    HW_PAGE_COUNT,
} hw_page_t;

typedef enum {
    HW_MOOD_IDLE = 0,    // blinking, looking around
    HW_MOOD_FOCUS,       // eyes down, keeping the child company
    HW_MOOD_THINK,       // eyes scanning left-right
    HW_MOOD_HAPPY,       // ^ ^
    HW_MOOD_WORRIED,     // head lamp flashing
    HW_MOOD_SLEEP,       // eyes almost closed
    HW_MOOD_LISTEN,      // eyes wide open
} hw_mood_t;

void hw_ui_init(void);
void hw_ui_show(hw_page_t page);
void hw_ui_robot(hw_mood_t mood);

void hw_ui_set_list(const hw_list_t *list, int selected);
// Duration editor on the list page: the selected row shows `minutes` highlighted.
// -1 turns it off. Takes effect on the next hw_ui_set_list().
void hw_ui_set_edit(int minutes);
void hw_ui_set_timer(const char *title, const hw_timer_t *timer);
void hw_ui_set_alert(const char *title, int choice);   // 0 = done, 1 = five more minutes
// Everything finished: the robot sweeps the done tasks off the screen, then the title shows.
// Call before hw_ui_show(HW_PAGE_DONE), which starts the animation.
void hw_ui_set_done(const hw_list_t *list);
// What the empty list page says: "no homework yet" or "all of today's homework is done".
void hw_ui_set_empty(bool all_done);
void hw_ui_set_setup(const char *status);

void hw_ui_set_net(hw_net_state_t state);
void hw_ui_set_battery(int soc);                       // -1 hides the indicator
// Shows a message over the page for `ms` milliseconds; ms = 0 keeps it until the next toast
// or hw_ui_toast_hide(). Long text wraps.
void hw_ui_toast(const char *text, int ms);
void hw_ui_toast_hide(void);
// Recording indicator shown while the child holds OK: red dot, seconds, input level.
void hw_ui_rec_show(bool show);
void hw_ui_rec_update(int elapsed_ms, int level);
