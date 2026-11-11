// main/hw_sound.h - the robot's voice: synthesized M-O style chirps plus the
// pre-recorded phrases embedded in Flash (see hw_voice.h). Playback runs in its own
// task; every call here is non-blocking and safe from any task except key callbacks.
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "hw_voice.h"

typedef enum {
    HW_CHIRP_NONE = 0,
    HW_CHIRP_HELLO,
    HW_CHIRP_HAPPY,
    HW_CHIRP_WORRIED,
    HW_CHIRP_THINK,
    HW_CHIRP_IDLE_A,   // three short idle mutters for the waiting screen
    HW_CHIRP_IDLE_B,
    HW_CHIRP_IDLE_C,
    HW_CHIRP_COUNT,
} hw_chirp_t;

#define HW_NO_VOICE HW_VOICE_COUNT

esp_err_t hw_sound_init(void);
// Plays `chirp`, then `voice` (either may be NONE / HW_NO_VOICE). Replaces whatever
// is playing, so the newest event always wins.
void hw_sound_play(hw_chirp_t chirp, hw_voice_t voice);
bool hw_sound_busy(void);
// While held, chirps and phrases are ignored and anything playing stops, so the
// talk module can use the microphone and speaker directly.
void hw_sound_hold(bool held);
// Plays a chirp synchronously in the calling task (for the talk module while held).
void hw_sound_chirp_now(hw_chirp_t chirp);
