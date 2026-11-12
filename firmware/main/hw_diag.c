// main/hw_diag.c - see hw_diag.h.  DIAG(power)
#include "hw_diag.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp_battery.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hw_net.h"
#include "hw_sound.h"
#include "hw_talk.h"

#define REPORT_S 30
#define MAX_TASKS 24

static const char *TAG = "pwr";

static volatile uint32_t s_req, s_req_fail, s_req_ms, s_bcast, s_flush, s_px;

void hw_diag_net_request(int ms, bool ok) {
    s_req++;
    if (!ok) s_req_fail++;
    s_req_ms += (uint32_t)ms;
}
void hw_diag_net_broadcast(void) { s_bcast++; }
void hw_diag_ui_flush(int pixels) {
    s_flush++;
    s_px += (uint32_t)pixels;
}

#if configGENERATE_RUN_TIME_STATS && configUSE_TRACE_FACILITY
typedef struct { char name[configMAX_TASK_NAME_LEN]; uint32_t run; } cpu_t;
static cpu_t s_prev[MAX_TASKS];
static int s_prev_n;
static uint32_t s_prev_total;

// Share of CPU time per task since the last report. "IDLE" is time the CPU had nothing to do.
static void report_cpu(void) {
    TaskStatus_t st[MAX_TASKS];
    uint32_t total;
    int n = (int)uxTaskGetSystemState(st, MAX_TASKS, &total);
    uint32_t dt = total - s_prev_total;
    if (dt > 0 && s_prev_n > 0) {
        char line[200];
        int len = snprintf(line, sizeof line, "cpu:");
        for (int i = 0; i < n; i++) {
            uint32_t before = 0;
            for (int j = 0; j < s_prev_n; j++) {
                if (strcmp(s_prev[j].name, st[i].pcTaskName) == 0) { before = s_prev[j].run; break; }
            }
            int pct10 = (int)((uint64_t)(st[i].ulRunTimeCounter - before) * 1000 / dt);
            if (pct10 >= 5 && len < (int)sizeof line - 24) {   // 0.5 % and up
                len += snprintf(line + len, sizeof line - len, " %s %d.%d%%", st[i].pcTaskName, pct10 / 10, pct10 % 10);
            }
        }
        ESP_LOGI(TAG, "%s", line);
    }
    s_prev_n = n < MAX_TASKS ? n : MAX_TASKS;
    for (int i = 0; i < s_prev_n; i++) {
        snprintf(s_prev[i].name, sizeof s_prev[i].name, "%s", st[i].pcTaskName);
        s_prev[i].run = st[i].ulRunTimeCounter;
    }
    s_prev_total = total;
}
#else
static void report_cpu(void) { ESP_LOGW(TAG, "cpu: run-time stats are off in this build"); }
#endif

static void diag_task(void *arg) {
    (void)arg;
    int first_mv = -1;
    int64_t first_us = 0;
    int sound_s = 0, talk_s = 0, online_s = 0;
    int s = 0;
    report_cpu();                                   // first call only stores the baseline
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (hw_sound_busy()) sound_s++;
        if (hw_talk_state() != HW_TALK_IDLE) talk_s++;
        if (hw_net_state() == HW_NET_ONLINE) online_s++;
        if (++s < REPORT_S) continue;

        int mv = bsp_battery_mv(), soc = bsp_battery_soc();
        int64_t now = esp_timer_get_time();
        if (first_mv < 0 && mv > 0) { first_mv = mv; first_us = now; }
        // A positive number is a falling battery. Only meaningful on battery power, not USB.
        int min_run = (int)((now - first_us) / 60000000);
        int drain = (mv > 0 && first_mv > 0 && min_run >= 2) ? (first_mv - mv) * 60 / min_run : 0;

        wifi_ps_type_t ps = WIFI_PS_NONE;
        esp_wifi_get_ps(&ps);
        wifi_ap_record_t ap = { 0 };
        int rssi = esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : 0;

        ESP_LOGI(TAG, "up %dm | batt %dmV %d%% (%+d mV since start, %d mV/h) | wifi ps=%d rssi=%d online %ds/%ds",
                 (int)(now / 60000000), mv, soc, mv > 0 && first_mv > 0 ? mv - first_mv : 0, drain,
                 (int)ps, rssi, online_s, s);
        ESP_LOGI(TAG, "net: %u requests (%u failed, %u ms in flight), %u broadcasts | screen: %u redraws, %u px | "
                 "sound %ds, talk %ds | heap free %u",
                 (unsigned)s_req, (unsigned)s_req_fail, (unsigned)s_req_ms, (unsigned)s_bcast,
                 (unsigned)s_flush, (unsigned)s_px, sound_s, talk_s,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT));
        report_cpu();
        s_req = s_req_fail = s_req_ms = s_bcast = s_flush = s_px = 0;
        sound_s = talk_s = online_s = 0;
        s = 0;
    }
}

void hw_diag_start(void) {
    if (xTaskCreate(diag_task, "hw_diag", 3072, NULL, 1, NULL) != pdPASS) ESP_LOGW(TAG, "diag task not started");
}
