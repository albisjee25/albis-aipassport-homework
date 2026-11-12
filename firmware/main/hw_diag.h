// main/hw_diag.h - DIAG(power): a one-line power report every 30 s on the serial log.
//
// Why: the device drains faster than it used to and nothing in the code says which part is
// responsible. Each "[pwr]" line shows the battery trend next to what the firmware was doing
// in that window (CPU idle share, screen redraws, network traffic, sound, Wi-Fi power mode),
// so a drain can be matched to an activity. Remove with the DIAG(power) markers when solved.
#pragma once

#include <stdbool.h>

void hw_diag_start(void);

// Counters fed from the other modules (cheap, any task).
void hw_diag_net_request(int ms, bool ok);   // one HTTP request to the Mac finished
void hw_diag_net_broadcast(void);            // one UDP "who is the Mac?" broadcast
void hw_diag_ui_flush(int pixels);           // the screen was (partly) redrawn
