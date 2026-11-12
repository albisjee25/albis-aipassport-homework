// main/hw_talk.c - see hw_talk.h.
#include "hw_talk.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp_audio.h"
#include "cJSON.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hw_net.h"
#include "hw_sound.h"

#define SR             16000
#define FRAME          320                // 20 ms of 16-bit mono samples
#define MAX_MS         10000              // a turn is at most 10 s of speech
#define MIN_MS         400                // shorter than this: an accidental press
#define PREROLL_MS     600                // kept from the moment OK goes down
#define PREROLL_N      (SR * PREROLL_MS / 1000)
#define ARM_TIMEOUT_MS 3000               // armed but never became a long press
#define RESP_MAX       4096
#define NOTIFY_ARM     (1u << 0)

static const char *TAG = "hw_talk";

static TaskHandle_t s_task;
static hw_talk_done_cb_t s_done;
static volatile hw_talk_state_t s_state;
static volatile bool s_begin, s_end;
static char s_page[8] = "list";   // device screen the child spoke on (sent to the Mac)
static volatile int s_level, s_elapsed_ms;
static int16_t *s_ring;           // pre-roll, PREROLL_N samples (NULL if RAM was short)
static int s_ring_pos;
static bool s_ring_full;
static int16_t s_frame[FRAME];
static char *s_resp;            // allocated by hw_talk_init (normal mode only)
static hw_talk_result_t *s_res;

hw_talk_state_t hw_talk_state(void) { return s_state; }
int hw_talk_level(void) { return s_level; }
int hw_talk_elapsed_ms(void) { return s_elapsed_ms; }

// Peak of a frame on a 0..100 scale (about -40 dBFS .. 0 dBFS).
static int frame_level(const int16_t *f, int n) {
    int peak = 0;
    for (int i = 0; i < n; i++) {
        int v = f[i] < 0 ? -f[i] : f[i];
        if (v > peak) peak = v;
    }
    if (peak < 328) return 0;                   // below -40 dB
    float db = 20.0f * log10f((float)peak / 32768.0f);
    int lv = (int)((db + 40.0f) * 2.5f);
    return lv > 100 ? 100 : lv;
}

static void ring_put(const int16_t *f, int n) {
    if (!s_ring) return;
    for (int i = 0; i < n; i++) {
        s_ring[s_ring_pos++] = f[i];
        if (s_ring_pos == PREROLL_N) { s_ring_pos = 0; s_ring_full = true; }
    }
}

static void copy_str(char *dst, size_t size, cJSON *item) {
    hw_utf8_copy(dst, size, cJSON_IsString(item) ? item->valuestring : "");
}

static hw_status_t status_of(const char *s) {
    if (s && strcmp(s, "doing") == 0) return HW_ST_DOING;
    if (s && strcmp(s, "done") == 0) return HW_ST_DONE;
    return HW_ST_TODO;
}

static bool parse(char *audio_id, size_t audio_len) {
    cJSON *root = cJSON_Parse(s_resp);
    if (!root) return false;
    copy_str(s_res->transcript, sizeof s_res->transcript, cJSON_GetObjectItem(root, "transcript"));
    copy_str(s_res->reply, sizeof s_res->reply, cJSON_GetObjectItem(root, "reply"));
    copy_str(s_res->mood, sizeof s_res->mood, cJSON_GetObjectItem(root, "mood"));
    copy_str(audio_id, audio_len, cJSON_GetObjectItem(root, "audio"));
    cJSON *a, *acts = cJSON_GetObjectItem(root, "device_actions");
    cJSON_ArrayForEach(a, acts) {
        if (s_res->action_count >= HW_TALK_MAX_ACTIONS) break;
        hw_talk_action_t *d = &s_res->actions[s_res->action_count++];
        copy_str(d->type, sizeof d->type, cJSON_GetObjectItem(a, "type"));
        copy_str(d->id, sizeof d->id, cJSON_GetObjectItem(a, "id"));
        cJSON *m = cJSON_GetObjectItem(a, "minutes");
        d->minutes = cJSON_IsNumber(m) ? m->valueint : 0;
    }
    cJSON *ver = cJSON_GetObjectItem(root, "version"), *t, *tasks = cJSON_GetObjectItem(root, "tasks");
    if (cJSON_IsNumber(ver) && cJSON_IsArray(tasks)) {
        hw_list_init(&s_res->list);
        s_res->list.version = ver->valueint;
        cJSON_ArrayForEach(t, tasks) {
            if (s_res->list.count >= HW_MAX_TASKS) break;
            hw_task_t *d = &s_res->list.tasks[s_res->list.count];
            cJSON *id = cJSON_GetObjectItem(t, "id");
            if (!cJSON_IsString(id)) continue;
            copy_str(d->id, sizeof d->id, id);
            copy_str(d->title, sizeof d->title, cJSON_GetObjectItem(t, "title"));
            copy_str(d->subject, sizeof d->subject, cJSON_GetObjectItem(t, "subject"));
            cJSON *m = cJSON_GetObjectItem(t, "minutes");
            d->minutes = cJSON_IsNumber(m) && m->valueint > 0 ? (uint16_t)m->valueint : 20;
            d->status = status_of(cJSON_GetStringValue(cJSON_GetObjectItem(t, "status")));
            s_res->list.count++;
        }
        s_res->has_list = true;
    }
    cJSON_Delete(root);
    return s_res->reply[0] != '\0';
}

static esp_http_client_handle_t open_client(const char *path, esp_http_client_method_t method) {
    char url[128];
    snprintf(url, sizeof url, "http://%s:%d%s", hw_net_mac_ip(), hw_net_mac_port(), path);
    esp_http_client_config_t cfg = { .url = url, .method = method, .timeout_ms = 15000 };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (c) hw_net_auth(c);
    return c;
}

static bool write_chunk(esp_http_client_handle_t c, const void *data, int len) {
    char head[12];
    int n = snprintf(head, sizeof head, "%X\r\n", len);
    return esp_http_client_write(c, head, n) == n &&
           (len == 0 || esp_http_client_write(c, data, len) == len) &&
           esp_http_client_write(c, "\r\n", 2) == 2;
}

// Sends the pre-roll (oldest first), then keeps streaming until the key is released.
// Returns the recorded length in ms counted from the key press, or -1 when the Mac
// could not be reached.
static int upload(esp_http_client_handle_t c, int preroll_ms) {
    if (esp_http_client_open(c, -1) != ESP_OK) return -1;   // -1: chunked upload
    if (s_ring) {
        int start = s_ring_full ? s_ring_pos : 0;
        int count = s_ring_full ? PREROLL_N : s_ring_pos;
        for (int sent = 0; sent < count;) {
            int idx = (start + sent) % PREROLL_N;
            int n = count - sent;
            if (n > FRAME) n = FRAME;
            if (n > PREROLL_N - idx) n = PREROLL_N - idx;
            if (!write_chunk(c, &s_ring[idx], n * 2)) return -1;
            sent += n;
        }
    }
    int ms = preroll_ms;
    while (!s_end && ms < MAX_MS) {
        if (bsp_audio_read(s_frame, sizeof s_frame) != ESP_OK) return -1;
        s_level = frame_level(s_frame, FRAME);
        if (!write_chunk(c, s_frame, sizeof s_frame)) return -1;
        ms += FRAME * 1000 / SR;
        s_elapsed_ms = ms;
    }
    if (!write_chunk(c, NULL, 0)) return -1;
    return ms;
}

// Armed: record into the pre-roll until it becomes a long press (true) or the key is
// released / the wait times out (false).
static bool wait_for_long_press(int *preroll_ms) {
    s_ring_pos = 0;
    s_ring_full = false;
    int ms = 0;
    while (!s_begin) {
        if (s_end || ms > ARM_TIMEOUT_MS) return false;
        if (bsp_audio_read(s_frame, sizeof s_frame) != ESP_OK) return false;
        ring_put(s_frame, FRAME);
        s_level = frame_level(s_frame, FRAME);
        ms += FRAME * 1000 / SR;
        s_elapsed_ms = ms;
    }
    *preroll_ms = ms < PREROLL_MS ? ms : PREROLL_MS;
    return true;
}

static int read_response(esp_http_client_handle_t c) {
    int64_t len = esp_http_client_fetch_headers(c);
    (void)len;
    int status = esp_http_client_get_status_code(c), total = 0;
    while (total < RESP_MAX - 1) {
        int n = esp_http_client_read(c, s_resp + total, RESP_MAX - 1 - total);
        if (n <= 0) break;
        total += n;
    }
    s_resp[total] = '\0';
    return status;
}

static void play_reply(const char *audio_id) {
    char path[48];
    snprintf(path, sizeof path, "/api/device/audio/%s.pcm", audio_id);
    esp_http_client_handle_t c = open_client(path, HTTP_METHOD_GET);
    if (!c) return;
    if (esp_http_client_open(c, 0) == ESP_OK && esp_http_client_fetch_headers(c) >= 0 &&
        esp_http_client_get_status_code(c) == 200) {
        int n;
        while ((n = esp_http_client_read(c, (char *)s_frame, sizeof s_frame)) > 0) {
            if (n & 1) n--;                        // keep whole samples
            if (bsp_audio_write(s_frame, (size_t)n) != ESP_OK) break;
        }
    }
    esp_http_client_cleanup(c);
}

static hw_chirp_t chirp_for(const char *mood) {
    if (strcmp(mood, "worried") == 0) return HW_CHIRP_WORRIED;
    if (strcmp(mood, "hello") == 0) return HW_CHIRP_HELLO;
    if (strcmp(mood, "thinking") == 0 || strcmp(mood, "confused") == 0) return HW_CHIRP_THINK;
    return HW_CHIRP_HAPPY;
}

static void finish(void) {
    s_state = HW_TALK_IDLE;
    hw_sound_hold(false);
    if (s_done) s_done(s_res);
}

static void talk_task(void *arg) {
    (void)arg;
    for (;;) {
        uint32_t bits = 0;
        xTaskNotifyWait(0, UINT32_MAX, &bits, portMAX_DELAY);
        if (!(bits & NOTIFY_ARM)) continue;
        memset(s_res, 0, sizeof *s_res);
        s_level = 0;
        s_elapsed_ms = 0;
        hw_sound_hold(true);                           // free the speaker and the codec path
        s_state = HW_TALK_ARMED;
        int preroll_ms = 0;
        if (!wait_for_long_press(&preroll_ms)) {       // just a short press: quietly forget it
            s_state = HW_TALK_IDLE;
            hw_sound_hold(false);
            continue;
        }
        s_state = HW_TALK_LISTENING;

        esp_http_client_handle_t c = open_client("/api/device/voice", HTTP_METHOD_POST);
        int ms = -1, status = -1;
        if (c) {
            esp_http_client_set_header(c, "Content-Type", "application/octet-stream");
            esp_http_client_set_header(c, "X-HW-Page", s_page);   // what voice may change
            ms = upload(c, preroll_ms);
            if (ms >= MIN_MS) {
                s_state = HW_TALK_THINKING;
                hw_sound_chirp_now(HW_CHIRP_THINK);
                status = read_response(c);
            }
        }
        if (c) esp_http_client_cleanup(c);

        char audio_id[24] = "";
        if (ms < 0) {
            hw_utf8_copy(s_res->error, sizeof s_res->error, "Mac没有回应，再试一次");
        } else if (ms < MIN_MS) {
            s_res->error[0] = '\0';                  // too short: just ignore
        } else if (status != 200 || !parse(audio_id, sizeof audio_id)) {
            ESP_LOGW(TAG, "voice turn failed: http %d", status);
            hw_utf8_copy(s_res->error, sizeof s_res->error, "我没听明白，再说一次吧");
        } else {
            s_res->ok = true;
            ESP_LOGI(TAG, "%d ms: \"%s\" -> \"%s\"", ms, s_res->transcript, s_res->reply);
            s_state = HW_TALK_SPEAKING;
            // The app shows the reply and applies the actions while the robot talks.
            if (s_done) s_done(s_res);
            hw_sound_chirp_now(chirp_for(s_res->mood));
            if (audio_id[0]) play_reply(audio_id);
            s_state = HW_TALK_IDLE;
            hw_sound_hold(false);
            continue;
        }
        finish();
    }
}

esp_err_t hw_talk_init(hw_talk_done_cb_t done) {
    s_done = done;
    s_resp = malloc(RESP_MAX);
    s_res = malloc(sizeof *s_res);
    if (!s_resp || !s_res) return ESP_ERR_NO_MEM;
    s_ring = malloc(PREROLL_N * sizeof(int16_t));     // ~19 KB; without it the first words are lost
    if (!s_ring) ESP_LOGW(TAG, "no RAM for the pre-roll; recording starts at the long press");
    if (xTaskCreate(talk_task, "hw_talk", 6144, NULL, 6, &s_task) != pdPASS) return ESP_ERR_NO_MEM;
    return ESP_OK;
}

void hw_talk_arm(void) {
    if (!s_task || s_state != HW_TALK_IDLE) return;
    if (!hw_net_mac_ip()[0] || hw_net_state() != HW_NET_ONLINE) return;
    s_begin = false;
    s_end = false;
    xTaskNotify(s_task, NOTIFY_ARM, eSetBits);
}

void hw_talk_begin(const char *page) {
    hw_utf8_copy(s_page, sizeof s_page, page ? page : "list");
    s_begin = true;
}

void hw_talk_end(void) {
    s_end = true;
}
