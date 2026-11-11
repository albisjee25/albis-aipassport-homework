// main/hw_net.c - see hw_net.h.
#include "hw_net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/ip4_addr.h"
#include "mdns.h"

#if __has_include("hw_secrets.h")
#include "hw_secrets.h"
#else
#include "hw_secrets.example.h"
#endif

#define POLL_MS          3000
#define HTTP_TIMEOUT_MS  3000
#define RESP_MAX         4096
#define FAILS_BEFORE_DOWN 2
#define FAILS_BEFORE_RESOLVE 5
#define GOT_IP_BIT       BIT0

static const char *TAG = "hw_net";

// value: worked seconds for "done", minutes for "minutes"; -1 = none. event fits "minutes".
typedef struct { char id[HW_ID_LEN]; char event[8]; int value; } net_event_t;

static EventGroupHandle_t s_bits;
static QueueHandle_t s_events;
static hw_net_list_cb_t s_on_list;
static volatile hw_net_state_t s_state;
static int s_version;
static char s_host_ip[16];
static char *s_resp;            // allocated by hw_net_start (normal mode only)
static int s_resp_len;
static hw_list_t *s_incoming;

hw_net_state_t hw_net_state(void) { return s_state; }
const char *hw_net_mac_ip(void) { return s_host_ip; }
int hw_net_mac_port(void) { return HW_RELAY_PORT; }
void hw_net_auth(void *client) { esp_http_client_set_header((esp_http_client_handle_t)client, "X-Device-Token", HW_DEVICE_TOKEN); }

static esp_err_t netif_prepare(void) {
    esp_err_t err = esp_netif_init();
    if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) err = esp_event_loop_create_default();
    return err == ESP_ERR_INVALID_STATE ? ESP_OK : err;
}

bool hw_net_has_wifi_config(void) {
    // Read the saved STA config without starting the radio.
    if (netif_prepare() != ESP_OK) return false;
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    bool inited = esp_wifi_init(&cfg) == ESP_OK;
    wifi_config_t wc = { 0 };
    bool has = inited && esp_wifi_get_config(WIFI_IF_STA, &wc) == ESP_OK && wc.sta.ssid[0] != '\0';
    if (inited) esp_wifi_deinit();
    return has;
}

esp_err_t hw_net_forget_wifi(void) {
    esp_err_t err = netif_prepare();
    if (err != ESP_OK) return err;
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) return err;
    esp_wifi_set_storage(WIFI_STORAGE_FLASH);
    wifi_config_t empty = { 0 };
    err = esp_wifi_set_config(WIFI_IF_STA, &empty);
    esp_wifi_deinit();
    return err;
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_bits, GOT_IP_BIT);
        s_state = HW_NET_CONNECTING;
        // The network task paces retries; reconnect right away here too.
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "got ip " IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(s_bits, GOT_IP_BIT);
        if (s_state == HW_NET_CONNECTING) s_state = HW_NET_SEARCHING;
    }
}

static void resolve_mac(void) {
    esp_ip4_addr_t addr = { 0 };
    esp_err_t err = mdns_query_a(HW_RELAY_HOSTNAME, 2000, &addr);
    if (err == ESP_OK && addr.addr) {
        snprintf(s_host_ip, sizeof s_host_ip, IPSTR, IP2STR(&addr));
        ESP_LOGI(TAG, "%s.local -> %s", HW_RELAY_HOSTNAME, s_host_ip);
    } else if (!s_host_ip[0]) {
        snprintf(s_host_ip, sizeof s_host_ip, "%s", HW_RELAY_FALLBACK_IP);
        ESP_LOGW(TAG, "mDNS lookup failed (%s); trying %s", esp_err_to_name(err), s_host_ip);
    }
}

static esp_err_t on_http(esp_http_client_event_t *e) {
    if (e->event_id == HTTP_EVENT_ON_DATA && e->data_len > 0) {
        int room = RESP_MAX - 1 - s_resp_len;
        int n = e->data_len < room ? e->data_len : room;
        if (n > 0) {
            memcpy(s_resp + s_resp_len, e->data, n);
            s_resp_len += n;
        }
    }
    return ESP_OK;
}

// One HTTP request to the Mac. Returns the status code, or -1 on a network error.
static int request(esp_http_client_method_t method, const char *path, const char *body) {
    char url[128];
    snprintf(url, sizeof url, "http://%s:%d%s", s_host_ip, HW_RELAY_PORT, path);
    esp_http_client_config_t cfg = {
        .url = url, .method = method, .timeout_ms = HTTP_TIMEOUT_MS,
        .event_handler = on_http, .disable_auto_redirect = true,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return -1;
    esp_http_client_set_header(c, "X-Device-Token", HW_DEVICE_TOKEN);
    if (body) {
        esp_http_client_set_header(c, "Content-Type", "application/json");
        esp_http_client_set_post_field(c, body, (int)strlen(body));
    }
    s_resp_len = 0;
    int64_t t_start = esp_timer_get_time();
    esp_err_t err = esp_http_client_perform(c);
    int status = err == ESP_OK ? esp_http_client_get_status_code(c) : -1;
    if (err != ESP_OK) {
        int e = esp_http_client_get_errno(c);
        ESP_LOGW(TAG, "request %s failed: %s errno=%d (%s) after %lld ms, free heap %u",
                 path, esp_err_to_name(err), e, e ? strerror(e) : "-",
                 (long long)((esp_timer_get_time() - t_start) / 1000), (unsigned)esp_get_free_heap_size());
    }
    esp_http_client_cleanup(c);
    s_resp[s_resp_len] = '\0';
    return status;
}

static hw_status_t parse_status(const char *s) {
    if (s && strcmp(s, "doing") == 0) return HW_ST_DOING;
    if (s && strcmp(s, "done") == 0) return HW_ST_DONE;
    return HW_ST_TODO;
}

// Parses {"version":N,"changed":true,"tasks":[...]} into s_incoming-> Returns true on a new list.
static bool parse_list(void) {
    cJSON *root = cJSON_Parse(s_resp);
    if (!root) return false;
    bool changed = cJSON_IsTrue(cJSON_GetObjectItem(root, "changed"));
    cJSON *ver = cJSON_GetObjectItem(root, "version");
    cJSON *tasks = cJSON_GetObjectItem(root, "tasks");
    if (changed && cJSON_IsNumber(ver) && cJSON_IsArray(tasks)) {
        hw_list_init(s_incoming);
        s_incoming->version = ver->valueint;
        cJSON *t;
        cJSON_ArrayForEach(t, tasks) {
            if (s_incoming->count >= HW_MAX_TASKS) break;
            hw_task_t *dst = &s_incoming->tasks[s_incoming->count];
            const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(t, "id"));
            if (!id) continue;
            hw_utf8_copy(dst->id, sizeof dst->id, id);
            hw_utf8_copy(dst->title, sizeof dst->title, cJSON_GetStringValue(cJSON_GetObjectItem(t, "title")));
            hw_utf8_copy(dst->subject, sizeof dst->subject, cJSON_GetStringValue(cJSON_GetObjectItem(t, "subject")));
            cJSON *m = cJSON_GetObjectItem(t, "minutes");
            dst->minutes = cJSON_IsNumber(m) && m->valueint > 0 ? (uint16_t)m->valueint : 20;
            dst->optional = cJSON_IsTrue(cJSON_GetObjectItem(t, "optional"));
            dst->status = parse_status(cJSON_GetStringValue(cJSON_GetObjectItem(t, "status")));
            s_incoming->count++;
        }
    } else {
        changed = false;
    }
    cJSON_Delete(root);
    return changed;
}

static void flush_events(void) {
    net_event_t ev;
    while (xQueuePeek(s_events, &ev, 0) == pdTRUE) {
        char body[96];
        if (ev.value >= 0) {
            snprintf(body, sizeof body, "{\"id\":\"%s\",\"event\":\"%s\",\"value\":%d}", ev.id, ev.event, ev.value);
        } else {
            snprintf(body, sizeof body, "{\"id\":\"%s\",\"event\":\"%s\"}", ev.id, ev.event);
        }
        int st = request(HTTP_METHOD_POST, "/api/device/event", body);
        if (st < 0) return;                    // Mac unreachable: keep it for later
        xQueueReceive(s_events, &ev, 0);       // delivered (or refused): drop it
        if (st != 200) ESP_LOGW(TAG, "event %s/%s -> %d", ev.id, ev.event, st);
    }
}

static void net_task(void *arg) {
    (void)arg;
    int fails = 0;
    for (;;) {
        xEventGroupWaitBits(s_bits, GOT_IP_BIT, pdFALSE, pdTRUE, portMAX_DELAY);
        if (!s_host_ip[0] || fails % FAILS_BEFORE_RESOLVE == FAILS_BEFORE_RESOLVE - 1) resolve_mac();

        flush_events();
        char path[48];
        snprintf(path, sizeof path, "/api/device/list?since=%d", s_version);
        int st = request(HTTP_METHOD_GET, path, NULL);
        if (st == 200) {
            fails = 0;
            s_state = HW_NET_ONLINE;
            if (parse_list()) {
                s_version = s_incoming->version;
                if (s_on_list) s_on_list(s_incoming);
            }
        } else {
            fails++;
            if (st == 401) ESP_LOGE(TAG, "the Mac rejected this device's token");
            if (fails >= FAILS_BEFORE_DOWN) s_state = HW_NET_MAC_DOWN;
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

esp_err_t hw_net_start(hw_net_list_cb_t on_list, int known_version) {
    s_on_list = on_list;
    s_version = known_version;
    s_resp = malloc(RESP_MAX);
    s_incoming = malloc(sizeof *s_incoming);
    if (!s_resp || !s_incoming) return ESP_ERR_NO_MEM;
    s_bits = xEventGroupCreate();
    s_events = xQueueCreate(8, sizeof(net_event_t));
    if (!s_bits || !s_events) return ESP_ERR_NO_MEM;

    esp_err_t err = netif_prepare();
    if (err != ESP_OK) return err;
    if (!esp_netif_create_default_wifi_sta()) return ESP_ERR_NO_MEM;
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) return err;
    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL, NULL);
    esp_wifi_set_storage(WIFI_STORAGE_FLASH);
    esp_wifi_set_mode(WIFI_MODE_STA);
    s_state = HW_NET_CONNECTING;
    err = esp_wifi_start();
    if (err != ESP_OK) return err;
    if (mdns_init() != ESP_OK) ESP_LOGW(TAG, "mDNS unavailable; using %s", HW_RELAY_FALLBACK_IP);
    if (xTaskCreate(net_task, "hw_net", 6144, NULL, 4, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    return ESP_OK;
}

void hw_net_post_event(const char *task_id, const char *event, int value) {
    if (!s_events || !task_id || !event) return;
    net_event_t ev = { .value = value };
    hw_utf8_copy(ev.id, sizeof ev.id, task_id);
    hw_utf8_copy(ev.event, sizeof ev.event, event);
    if (xQueueSend(s_events, &ev, 0) != pdTRUE) ESP_LOGW(TAG, "event queue full; dropped %s", event);
}
