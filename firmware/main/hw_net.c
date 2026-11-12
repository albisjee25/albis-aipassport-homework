// main/hw_net.c - see hw_net.h.
#include "hw_net.h"
#include "hw_diag.h"   // DIAG(power)

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
#include "lwip/sockets.h"
#include "mdns.h"
#include "nvs.h"

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
#define DISCOVERY_PORT   8788       // the plugin answers "HWH?" here with "HWH! <http port>"
#define TOKEN_MAX        64
#define BAD_TOKENS_BEFORE_REPAIR 3
#define PAIR_POLL_MS     2000

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
static char s_token[TOKEN_MAX];       // device token: from NVS, else the one compiled into hw_secrets.h
static int s_port = HW_RELAY_PORT;
static char s_code[5];                // pairing code while pairing
static char s_nonce[25];              // secret only this device knows; proves it is the one that asked
static bool s_ignore_compiled;        // the compiled-in token was refused: pair instead

// A build configured with a real Bonjour name still looks the Mac up by name first.
static bool has_hostname(void) { return strcmp(HW_RELAY_HOSTNAME, "my-mac") != 0; }
static bool has_compiled_token(void) { return strcmp(HW_DEVICE_TOKEN, "not-configured") != 0; }

hw_net_state_t hw_net_state(void) { return s_state; }
const char *hw_net_mac_ip(void) { return s_host_ip; }
int hw_net_mac_port(void) { return s_port; }
const char *hw_net_pair_code(void) { return s_state == HW_NET_PAIRING ? s_code : ""; }
void hw_net_auth(void *client) {
    if (s_token[0]) esp_http_client_set_header((esp_http_client_handle_t)client, "X-Device-Token", s_token);
}

static void token_load(void) {
    s_token[0] = '\0';
    nvs_handle_t h;
    if (nvs_open("hw_net", NVS_READONLY, &h) == ESP_OK) {
        size_t n = sizeof s_token;
        if (nvs_get_str(h, "token", s_token, &n) != ESP_OK) s_token[0] = '\0';
        nvs_close(h);
    }
    if (!s_token[0] && !s_ignore_compiled && has_compiled_token()) snprintf(s_token, sizeof s_token, "%s", HW_DEVICE_TOKEN);
}

static void token_save(const char *t) {
    nvs_handle_t h;
    if (nvs_open("hw_net", NVS_READWRITE, &h) != ESP_OK) return;
    if (t && t[0]) nvs_set_str(h, "token", t); else nvs_erase_key(h, "token");
    nvs_commit(h);
    nvs_close(h);
}

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

// Ask the local network "who runs the homework plugin?" with a UDP broadcast.
static bool discover_mac(void) {
    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (fd < 0) return false;
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, sizeof yes);
    struct timeval tv = { .tv_sec = 1 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    struct sockaddr_in to = { .sin_family = AF_INET, .sin_port = htons(DISCOVERY_PORT), .sin_addr.s_addr = htonl(INADDR_BROADCAST) };
    bool found = false;
    for (int i = 0; i < 3 && !found; i++) {
        sendto(fd, "HWH?", 4, 0, (struct sockaddr *)&to, sizeof to);
        hw_diag_net_broadcast();   // DIAG(power)
        char buf[24];
        struct sockaddr_in from;
        socklen_t flen = sizeof from;
        int n = recvfrom(fd, buf, sizeof buf - 1, 0, (struct sockaddr *)&from, &flen);
        if (n > 5) {
            buf[n] = '\0';
            int port = atoi(buf + 5);
            if (strncmp(buf, "HWH! ", 5) == 0 && port > 0 && port < 65536) {
                s_port = port;
                snprintf(s_host_ip, sizeof s_host_ip, IPSTR, IP2STR((const esp_ip4_addr_t *)&from.sin_addr.s_addr));
                found = true;
            }
        }
    }
    close(fd);
    return found;
}

static void resolve_mac(void) {
    if (has_hostname()) {
        esp_ip4_addr_t addr = { 0 };
        esp_err_t err = mdns_query_a(HW_RELAY_HOSTNAME, 2000, &addr);
        if (err == ESP_OK && addr.addr) {
            snprintf(s_host_ip, sizeof s_host_ip, IPSTR, IP2STR(&addr));
            ESP_LOGI(TAG, "%s.local -> %s", HW_RELAY_HOSTNAME, s_host_ip);
            return;
        }
        ESP_LOGW(TAG, "mDNS lookup failed (%s)", esp_err_to_name(err));
    }
    if (discover_mac()) {
        ESP_LOGI(TAG, "found the Mac at %s:%d", s_host_ip, s_port);
    } else if (!s_host_ip[0] && has_hostname()) {
        snprintf(s_host_ip, sizeof s_host_ip, "%s", HW_RELAY_FALLBACK_IP);
        ESP_LOGW(TAG, "no answer to broadcast; trying %s", s_host_ip);
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
    snprintf(url, sizeof url, "http://%s:%d%s", s_host_ip, s_port, path);
    esp_http_client_config_t cfg = {
        .url = url, .method = method, .timeout_ms = HTTP_TIMEOUT_MS,
        .event_handler = on_http, .disable_auto_redirect = true,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return -1;
    hw_net_auth(c);
    if (body) {
        esp_http_client_set_header(c, "Content-Type", "application/json");
        esp_http_client_set_post_field(c, body, (int)strlen(body));
    }
    s_resp_len = 0;
    int64_t t_start = esp_timer_get_time();
    esp_err_t err = esp_http_client_perform(c);
    int status = err == ESP_OK ? esp_http_client_get_status_code(c) : -1;
    hw_diag_net_request((int)((esp_timer_get_time() - t_start) / 1000), err == ESP_OK);   // DIAG(power)
    // On a 401 without a WWW-Authenticate header the HTTP client fails with ESP_ERR_NOT_SUPPORTED
    // instead of reporting the status: read it ourselves so "token refused" is detected.
    if (err == ESP_ERR_NOT_SUPPORTED && esp_http_client_get_status_code(c) == 401) status = 401;
    else if (err != ESP_OK) {
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

static void new_pair_secrets(void) {
    snprintf(s_code, sizeof s_code, "%04u", (unsigned)(1000 + esp_random() % 9000));
    snprintf(s_nonce, sizeof s_nonce, "%08x%08x%08x", (unsigned)esp_random(), (unsigned)esp_random(), (unsigned)esp_random());
}

// One step of pairing; call every PAIR_POLL_MS until the token arrives. Returns true when paired.
static bool pair_step(void) {
    if (!s_code[0]) new_pair_secrets();
    char body[96];
    snprintf(body, sizeof body, "{\"code\":\"%s\",\"nonce\":\"%s\"}", s_code, s_nonce);
    // Asking again is harmless (same nonce just refreshes); it also revives a request that expired.
    int st = request(HTTP_METHOD_POST, "/api/pair/request", body);
    if (st == 400 && strstr(s_resp, "code in use")) { new_pair_secrets(); return false; }
    if (st != 200) { s_state = HW_NET_SEARCHING; return false; }
    s_state = HW_NET_PAIRING;
    snprintf(body, sizeof body, "{\"nonce\":\"%s\"}", s_nonce);
    st = request(HTTP_METHOD_POST, "/api/pair/poll", body);
    if (st != 200) return false;
    cJSON *root = cJSON_Parse(s_resp);
    if (!root) return false;
    const char *status = cJSON_GetStringValue(cJSON_GetObjectItem(root, "status"));
    const char *token = cJSON_GetStringValue(cJSON_GetObjectItem(root, "token"));
    bool paired = false;
    if (status && strcmp(status, "approved") == 0 && token && token[0] && strlen(token) < TOKEN_MAX) {
        snprintf(s_token, sizeof s_token, "%s", token);
        token_save(s_token);
        s_code[0] = '\0';
        s_state = HW_NET_SEARCHING;
        ESP_LOGI(TAG, "paired with the Mac");
        paired = true;
    } else if (status && strcmp(status, "gone") == 0) {
        new_pair_secrets();             // denied or expired: start over with a fresh code
    }
    cJSON_Delete(root);
    return paired;
}

static void net_task(void *arg) {
    (void)arg;
    int fails = 0, bad_tokens = 0;
    for (;;) {
        xEventGroupWaitBits(s_bits, GOT_IP_BIT, pdFALSE, pdTRUE, portMAX_DELAY);
        if (!s_host_ip[0] || fails % FAILS_BEFORE_RESOLVE == FAILS_BEFORE_RESOLVE - 1) resolve_mac();

        if (!s_token[0]) {                      // never paired: ask the parent to allow this device
            if (s_host_ip[0] && !pair_step()) {
                if (s_state != HW_NET_PAIRING) fails++;
            } else if (!s_host_ip[0]) {
                fails++;                        // keep broadcasting
            }
            vTaskDelay(pdMS_TO_TICKS(PAIR_POLL_MS));
            continue;
        }

        flush_events();
        char path[48];
        snprintf(path, sizeof path, "/api/device/list?since=%d", s_version);
        int st = request(HTTP_METHOD_GET, path, NULL);
        if (st == 200) {
            fails = 0;
            bad_tokens = 0;
            s_state = HW_NET_ONLINE;
            if (parse_list()) {
                s_version = s_incoming->version;
                if (s_on_list) s_on_list(s_incoming);
            }
        } else {
            fails++;
            if (st == 401) {
                ESP_LOGE(TAG, "the Mac rejected this device's token");
                if (++bad_tokens >= BAD_TOKENS_BEFORE_REPAIR) {     // the Mac forgot us: pair again
                    token_save(NULL);
                    s_ignore_compiled = true;
                    s_token[0] = '\0';
                    s_code[0] = '\0';
                    bad_tokens = 0;
                    continue;
                }
            }
            if (fails >= FAILS_BEFORE_DOWN) s_state = HW_NET_MAC_DOWN;
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

esp_err_t hw_net_start(hw_net_list_cb_t on_list, int known_version) {
    s_on_list = on_list;
    s_version = known_version;
    token_load();
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
    if (mdns_init() != ESP_OK) ESP_LOGW(TAG, "mDNS unavailable; relying on the broadcast");
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
