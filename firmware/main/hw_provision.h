// main/hw_provision.h - first-time Wi-Fi setup over Bluetooth (BLUFI).
//
// The parent opens the WeChat mini program "蓝牙配网-FoloToy AI PASSPORT", picks
// BLUFI_HomeworkBot and sends the home Wi-Fi name and password. The credentials are
// saved in NVS by the Wi-Fi driver. Bluetooth runs only in this mode; once Wi-Fi
// connects the app restarts into normal mode with Bluetooth off (saves RAM).
#pragma once

#include "esp_err.h"

typedef enum {
    HW_PROV_STARTING = 0,
    HW_PROV_WAITING,      // advertising, waiting for the phone
    HW_PROV_PHONE,        // phone connected
    HW_PROV_JOINING,      // trying the Wi-Fi network it sent
    HW_PROV_JOIN_FAILED,  // wrong password / network not found; phone can retry
    HW_PROV_DONE,         // got an IP address: credentials are good and saved
    HW_PROV_ERROR,
} hw_prov_state_t;

#define HW_PROV_DEVICE_NAME "BLUFI_HomeworkBot"

esp_err_t hw_provision_start(void);
hw_prov_state_t hw_provision_state(void);
