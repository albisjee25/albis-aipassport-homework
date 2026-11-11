// main/hw_talk.h - push-to-talk: hold OK, speak, release.
//
// Recording starts the moment OK goes down (hw_talk_arm) into a short pre-roll
// buffer, so the first words are not lost while the long press is still being
// detected. Once it is a long press (hw_talk_begin) the pre-roll and everything
// after it is streamed to the parent's Mac (chunked
// HTTP upload, nothing is stored on the device). The Mac recognizes the speech
// locally, decides what to do, and answers with a short reply, the robot's voice
// for it, actions for the device and the updated list.
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "hw_model.h"

#define HW_TALK_MAX_ACTIONS 4
#define HW_TALK_TEXT_LEN    160

typedef enum {
    HW_TALK_IDLE = 0,
    HW_TALK_ARMED,           // OK is down: recording into the pre-roll, not yet a long press
    HW_TALK_LISTENING,
    HW_TALK_THINKING,
    HW_TALK_SPEAKING,
} hw_talk_state_t;

typedef struct {
    char type[8];            // "start", "extend" or "set"
    char id[HW_ID_LEN];
    int minutes;
} hw_talk_action_t;

typedef struct {
    bool ok;                 // false: too short, Mac unreachable, or bad answer
    char error[40];          // child-friendly reason when !ok (empty when too short)
    char transcript[HW_TALK_TEXT_LEN];
    char reply[HW_TALK_TEXT_LEN];
    char mood[12];
    hw_talk_action_t actions[HW_TALK_MAX_ACTIONS];
    int action_count;
    bool has_list;
    hw_list_t list;
} hw_talk_result_t;

// Called from the talk task once per turn: on success as soon as the answer arrives
// (the reply is then played; hw_talk_state() returns to IDLE when it ends), on
// failure when the turn is abandoned.
typedef void (*hw_talk_done_cb_t)(const hw_talk_result_t *result);

esp_err_t hw_talk_init(hw_talk_done_cb_t done);
// OK pressed: start recording into the pre-roll. Ignored unless idle and the Mac is online.
void hw_talk_arm(void);
// OK long press: keep the pre-roll and start sending. Only acts when armed.
// `page` is the screen the child is on: "list", "timer" or "alert". On the list page
// the Mac does not let voice change durations (keys do that).
void hw_talk_begin(const char *page);
// OK released: armed -> discard; listening -> send what was said.
void hw_talk_end(void);
hw_talk_state_t hw_talk_state(void);
// For the recording indicator: input level 0..100 and recorded time since OK went down.
int hw_talk_level(void);
int hw_talk_elapsed_ms(void);
