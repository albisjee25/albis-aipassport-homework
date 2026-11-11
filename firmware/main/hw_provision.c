// main/hw_provision.c - see hw_provision.h.
// Adapted from the repository's demo/blufi-provisioning branch (commit 9c039cc),
// trimmed to a one-way setup flow: it never needs to stop, the app restarts instead.
#include "hw_provision.h"

#include <string.h>

#include "esp_blufi.h"
#include "esp_blufi_api.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "host/ble_hs.h"
#include "hw_blufi_security.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"

static const char *TAG = "hw_prov";

static volatile hw_prov_state_t s_state;
static wifi_config_t s_sta;
static bool s_ble_connected;
static bool s_joining;
static bool s_got_ip;

hw_prov_state_t hw_provision_state(void) { return s_state; }

static void report(esp_blufi_sta_conn_state_t st) {
    if (!s_ble_connected) return;
    esp_blufi_extra_info_t info = { 0 };
    size_t len = strnlen((const char *)s_sta.sta.ssid, sizeof s_sta.sta.ssid);
    if (len) {
        info.sta_ssid = s_sta.sta.ssid;
        info.sta_ssid_len = len;
    }
    esp_blufi_send_wifi_conn_report(WIFI_MODE_STA, st, 0, &info);
}

static void send_wifi_list(void) {
    uint16_t count = 16;
    wifi_ap_record_t rec[16];
    esp_blufi_ap_record_t list[16];
    memset(list, 0, sizeof list);
    if (esp_wifi_scan_get_ap_records(&count, rec) != ESP_OK) {
        esp_blufi_send_error_info(ESP_BLUFI_WIFI_SCAN_FAIL);
        return;
    }
    for (uint16_t i = 0; i < count; i++) {
        list[i].rssi = rec[i].rssi;
        memcpy(list[i].ssid, rec[i].ssid, sizeof list[i].ssid);
    }
    if (s_ble_connected) esp_blufi_send_wifi_list(count, list);
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = data;
        ESP_LOGW(TAG, "join failed, reason=%u", e->reason);
        if (s_joining) {
            report(ESP_BLUFI_STA_CONN_FAIL);
            s_state = HW_PROV_JOIN_FAILED;
        }
        s_joining = false;
        s_got_ip = false;
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        send_wifi_list();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        s_joining = false;
        s_got_ip = true;
        report(ESP_BLUFI_STA_CONN_SUCCESS);
        s_state = HW_PROV_DONE;
    }
}

static void on_blufi(esp_blufi_cb_event_t event, esp_blufi_cb_param_t *p) {
    switch (event) {
    case ESP_BLUFI_EVENT_INIT_FINISH:
        esp_blufi_adv_start_with_name(HW_PROV_DEVICE_NAME);
        s_state = HW_PROV_WAITING;
        break;
    case ESP_BLUFI_EVENT_BLE_CONNECT:
        s_ble_connected = true;
        esp_blufi_adv_stop();
        if (hw_blufi_security_init() != 0) s_state = HW_PROV_ERROR;
        else if (s_state != HW_PROV_DONE) s_state = HW_PROV_PHONE;
        break;
    case ESP_BLUFI_EVENT_BLE_DISCONNECT:
        s_ble_connected = false;
        hw_blufi_security_deinit();
        if (s_state != HW_PROV_DONE) {
            esp_blufi_adv_start_with_name(HW_PROV_DEVICE_NAME);
            s_state = HW_PROV_WAITING;
        }
        break;
    case ESP_BLUFI_EVENT_SET_WIFI_OPMODE:
        esp_wifi_set_mode(WIFI_MODE_STA);
        break;
    case ESP_BLUFI_EVENT_RECV_STA_BSSID:
        memcpy(s_sta.sta.bssid, p->sta_bssid.bssid, 6);
        s_sta.sta.bssid_set = true;
        esp_wifi_set_config(WIFI_IF_STA, &s_sta);
        break;
    case ESP_BLUFI_EVENT_RECV_STA_SSID:
        if (p->sta_ssid.ssid_len >= (int)sizeof s_sta.sta.ssid) {
            esp_blufi_send_error_info(ESP_BLUFI_DATA_FORMAT_ERROR);
            break;
        }
        memset(&s_sta, 0, sizeof s_sta);
        s_sta.sta.threshold.authmode = WIFI_AUTH_OPEN;
        memcpy(s_sta.sta.ssid, p->sta_ssid.ssid, p->sta_ssid.ssid_len);
        esp_wifi_set_config(WIFI_IF_STA, &s_sta);
        break;
    case ESP_BLUFI_EVENT_RECV_STA_PASSWD:
        if (p->sta_passwd.passwd_len >= (int)sizeof s_sta.sta.password) {
            esp_blufi_send_error_info(ESP_BLUFI_DATA_FORMAT_ERROR);
            break;
        }
        memset(s_sta.sta.password, 0, sizeof s_sta.sta.password);
        memcpy(s_sta.sta.password, p->sta_passwd.passwd, p->sta_passwd.passwd_len);
        esp_wifi_set_config(WIFI_IF_STA, &s_sta);
        break;
    case ESP_BLUFI_EVENT_REQ_CONNECT_TO_AP:
        s_joining = true;
        s_state = HW_PROV_JOINING;
        if (s_got_ip) esp_wifi_disconnect();
        if (esp_wifi_connect() != ESP_OK) {
            s_joining = false;
            s_state = HW_PROV_JOIN_FAILED;
        }
        break;
    case ESP_BLUFI_EVENT_REQ_DISCONNECT_FROM_AP:
    case ESP_BLUFI_EVENT_DEAUTHENTICATE_STA:
        esp_wifi_disconnect();
        break;
    case ESP_BLUFI_EVENT_GET_WIFI_STATUS:
        report(s_got_ip ? ESP_BLUFI_STA_CONN_SUCCESS
                        : s_joining ? ESP_BLUFI_STA_CONNECTING : ESP_BLUFI_STA_CONN_FAIL);
        break;
    case ESP_BLUFI_EVENT_GET_WIFI_LIST: {
        wifi_scan_config_t sc = { 0 };
        if (esp_wifi_scan_start(&sc, false) != ESP_OK) esp_blufi_send_error_info(ESP_BLUFI_WIFI_SCAN_FAIL);
        break;
    }
    case ESP_BLUFI_EVENT_RECV_SLAVE_DISCONNECT_BLE:
        esp_blufi_disconnect();
        break;
    case ESP_BLUFI_EVENT_REPORT_ERROR:
        esp_blufi_send_error_info(p->report_error.state);
        break;
    default:
        break;
    }
}

static esp_blufi_callbacks_t s_callbacks = {
    .event_cb = on_blufi,
    .negotiate_data_handler = hw_blufi_negotiate,
    .encrypt_func = hw_blufi_encrypt,
    .decrypt_func = hw_blufi_decrypt,
    .checksum_func = hw_blufi_checksum,
};

static void on_host_reset(int reason) {
    ESP_LOGE(TAG, "NimBLE reset: %d", reason);
    s_state = HW_PROV_ERROR;
}

static void on_host_sync(void) {
    if (esp_blufi_profile_init() != 0) s_state = HW_PROV_ERROR;
}

static void host_task(void *arg) {
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

esp_err_t hw_provision_start(void) {
    s_state = HW_PROV_STARTING;
    esp_err_t err = esp_netif_init();
    if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    if (!esp_netif_create_default_wifi_sta()) return ESP_ERR_NO_MEM;
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) return err;
    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL, NULL);
    esp_wifi_set_storage(WIFI_STORAGE_FLASH);   // so the network survives the restart
    esp_wifi_set_mode(WIFI_MODE_STA);
    err = esp_wifi_start();
    if (err != ESP_OK) return err;

    err = esp_blufi_register_callbacks(&s_callbacks);
    if (err == ESP_OK) err = nimble_port_init();
    if (err != ESP_OK) return err;
    ble_hs_cfg.reset_cb = on_host_reset;
    ble_hs_cfg.sync_cb = on_host_sync;
    ble_hs_cfg.gatts_register_cb = esp_blufi_gatt_svr_register_cb;
    if (esp_blufi_gatt_svr_init() != 0) return ESP_FAIL;
    if (ble_svc_gap_device_name_set(HW_PROV_DEVICE_NAME) != 0) return ESP_FAIL;
    esp_blufi_btc_init();
    return esp_nimble_enable(host_task);
}
