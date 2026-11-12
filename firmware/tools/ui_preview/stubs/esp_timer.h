// Host stand-in for the ESP-IDF timer header (hw_ui.c only logs timings with it).
#pragma once
#include <stdint.h>
static inline int64_t esp_timer_get_time(void) { return 0; }
