// Host stand-in for components/bsp/include/bsp_display.h: the preview has one thread,
// so the LVGL lock always succeeds.
#pragma once
#include <stdbool.h>
#define BSP_LVGL_SCREEN_RADIUS 30
static inline bool bsp_lvgl_lock(int timeout_ms) { (void)timeout_ms; return true; }
static inline void bsp_lvgl_unlock(void) {}
