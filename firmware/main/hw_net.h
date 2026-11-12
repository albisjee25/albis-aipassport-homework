// main/hw_net.h - home Wi-Fi + the parent's Mac (relay service).
//
// A network task connects with the Wi-Fi credentials saved by BLUFI provisioning,
// finds the Mac (a UDP broadcast the plugin answers; builds with a Bonjour name in
// hw_secrets.h use that first), pairs once to get a device token (kept in NVS), polls the
// homework list every few seconds and sends the device's task events back.
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "hw_model.h"

typedef enum {
    HW_NET_OFF = 0,
    HW_NET_CONNECTING,     // joining Wi-Fi
    HW_NET_SEARCHING,      // Wi-Fi OK, looking for the Mac
    HW_NET_ONLINE,         // the Mac answered recently
    HW_NET_MAC_DOWN,       // Wi-Fi OK but the Mac does not answer
    HW_NET_PAIRING,        // Mac found, waiting for the parent to tap "allow" (show hw_net_pair_code())
} hw_net_state_t;

// Called from the network task whenever the Mac sends a changed list.
typedef void (*hw_net_list_cb_t)(const hw_list_t *list);

// True when BLUFI has stored a Wi-Fi network (NVS must already be initialized).
bool hw_net_has_wifi_config(void);
// Forget the stored Wi-Fi network (used before re-provisioning).
esp_err_t hw_net_forget_wifi(void);

// Starts Wi-Fi and the sync task. `known_version` is the cached list's version.
esp_err_t hw_net_start(hw_net_list_cb_t on_list, int known_version);
hw_net_state_t hw_net_state(void);
// "a.b.c.d" of the Mac once found, or "" while searching.
const char *hw_net_mac_ip(void);
// Adds the device token header to a client created for the Mac.
void hw_net_auth(void *esp_http_client_handle);
int hw_net_mac_port(void);
// 4-digit code to show while state is HW_NET_PAIRING; "" otherwise.
const char *hw_net_pair_code(void);

// Queue an event for the Mac: "start", "stop", "done" (value = worked seconds) or
// "minutes" (value = duration set with the keys). value -1 = none. Non-blocking.
void hw_net_post_event(const char *task_id, const char *event, int value);
