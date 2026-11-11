// main/hw_sound.c - see hw_sound.h.
#include "hw_sound.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "bsp_audio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#define SR        16000
#define CHUNK     160          // 10 ms per write, so a new request cuts in quickly
#define VOLUME    72

static const char *TAG = "hw_sound";

// ---- embedded phrases -------------------------------------------------------------
#define VOICE_SYM(name) \
    extern const uint8_t name##_start[] asm("_binary_" #name "_pcm_start"); \
    extern const uint8_t name##_end[] asm("_binary_" #name "_pcm_end");
VOICE_SYM(remind2) VOICE_SYM(remind1) VOICE_SYM(timeup) VOICE_SYM(start) VOICE_SYM(done)
VOICE_SYM(alldone) VOICE_SYM(extend) VOICE_SYM(newlist) VOICE_SYM(hello) VOICE_SYM(wifi_ok)

typedef struct { const uint8_t *start, *end; } clip_t;
static clip_t s_clips[HW_VOICE_COUNT];

static void clips_init(void) {
#define CLIP(id, name) s_clips[id] = (clip_t){ name##_start, name##_end }
    CLIP(HW_VOICE_REMIND2, remind2); CLIP(HW_VOICE_REMIND1, remind1); CLIP(HW_VOICE_TIMEUP, timeup);
    CLIP(HW_VOICE_START, start);     CLIP(HW_VOICE_DONE, done);       CLIP(HW_VOICE_ALLDONE, alldone);
    CLIP(HW_VOICE_EXTEND, extend);   CLIP(HW_VOICE_NEWLIST, newlist); CLIP(HW_VOICE_HELLO, hello);
    CLIP(HW_VOICE_WIFI_OK, wifi_ok);
#undef CLIP
}

// ---- chirp synthesis ----------------------------------------------------------------
// A chirp is a few "notes": a square-ish tone gliding from f0 to f1 with optional
// vibrato, separated by short gaps. Mirrors the samples the family picked.
typedef struct { uint16_t f0, f1, ms, vib; } note_t;   // f0 == 0 means silence
#define GAP(ms) { 0, 0, ms, 0 }

static const note_t CH_HELLO[]   = { {900,1700,90,0}, GAP(30), {1500,2300,70,0}, GAP(30), {2000,1400,120,120}, GAP(110) };
static const note_t CH_HAPPY[]   = { {1000,2400,140,0}, GAP(30), {1600,2600,60,0}, GAP(20), {1600,2600,60,0}, GAP(20), {2200,3000,100,150}, GAP(110) };
static const note_t CH_WORRIED[] = { {1800,1800,50,0}, GAP(25), {1800,1800,50,0}, GAP(25), {1800,1800,50,0}, GAP(25), {1800,1800,50,0}, GAP(25), {1900,1200,160,90}, GAP(110) };
static const note_t CH_THINK[]   = { {1200,1400,60,0}, GAP(60), {1300,1100,60,0}, GAP(60), {1250,1500,80,60}, GAP(80) };
static const note_t CH_IDLE_A[]  = { {1400,1900,70,0}, GAP(40), {1700,1300,110,100} };
static const note_t CH_IDLE_B[]  = { {2100,2100,40,0}, GAP(30), {2100,2100,40,0}, GAP(30), {1500,2200,90,0} };
static const note_t CH_IDLE_C[]  = { {1100,1600,120,80}, GAP(50), {1900,1500,60,0} };

typedef struct { const note_t *notes; int n; } chirp_def_t;
#define DEF(a) { a, (int)(sizeof(a) / sizeof(a[0])) }
static const chirp_def_t CHIRPS[HW_CHIRP_COUNT] = {
    [HW_CHIRP_NONE] = { NULL, 0 },
    [HW_CHIRP_HELLO] = DEF(CH_HELLO), [HW_CHIRP_HAPPY] = DEF(CH_HAPPY), [HW_CHIRP_WORRIED] = DEF(CH_WORRIED),
    [HW_CHIRP_THINK] = DEF(CH_THINK), [HW_CHIRP_IDLE_A] = DEF(CH_IDLE_A), [HW_CHIRP_IDLE_B] = DEF(CH_IDLE_B),
    [HW_CHIRP_IDLE_C] = DEF(CH_IDLE_C),
};

typedef struct { hw_chirp_t chirp; hw_voice_t voice; } request_t;

static QueueHandle_t s_queue;
static volatile bool s_busy;
static volatile bool s_held;
static int16_t s_buf[CHUNK];

// True when a newer request is waiting: the current sound should stop.
static bool superseded(void) {
    return s_held || uxQueueMessagesWaiting(s_queue) > 0;
}

static bool play_chirp_into(hw_chirp_t id, int16_t *buf, bool interruptible) {
    const chirp_def_t *def = &CHIRPS[id];
    float phase = 0;
    for (int k = 0; k < def->n; k++) {
        const note_t *nt = &def->notes[k];
        int total = SR * nt->ms / 1000;
        for (int pos = 0; pos < total; pos += CHUNK) {
            if (interruptible && superseded()) return false;
            int n = total - pos < CHUNK ? total - pos : CHUNK;
            for (int i = 0; i < n; i++) {
                int idx = pos + i;
                float s = 0;
                if (nt->f0) {
                    float t = (float)idx / SR, dur = (float)nt->ms / 1000.0f;
                    float f = nt->f0 + (nt->f1 - nt->f0) * (t / dur) + nt->vib * sinf(6.2831853f * 28.0f * t);
                    phase += 6.2831853f * f / SR;
                    if (phase > 6.2831853f) phase -= 6.2831853f;
                    float env = fminf(1.0f, t / 0.008f) * fminf(1.0f, (dur - t) / 0.02f);
                    s = 0.30f * tanhf(3.0f * sinf(phase)) * env;
                }
                buf[i] = (int16_t)(s * 32767.0f);
            }
            if (bsp_audio_write(buf, (size_t)n * sizeof(int16_t)) != ESP_OK) return false;
        }
    }
    return true;
}

static bool play_chirp(hw_chirp_t id) {
    return play_chirp_into(id, s_buf, true);
}

void hw_sound_chirp_now(hw_chirp_t id) {
    static int16_t buf[CHUNK];     // the talk task's own buffer
    if (id > HW_CHIRP_NONE && id < HW_CHIRP_COUNT) play_chirp_into(id, buf, false);
}

static void play_voice(hw_voice_t id) {
    const uint8_t *p = s_clips[id].start, *end = s_clips[id].end;
    while (p < end) {
        if (superseded()) return;
        size_t n = (size_t)(end - p) < CHUNK * 2 ? (size_t)(end - p) : CHUNK * 2;
        // Embedded data lives in Flash; copy through RAM so I2S DMA never reads Flash.
        memcpy(s_buf, p, n);
        if (bsp_audio_write(s_buf, n) != ESP_OK) return;
        p += n;
    }
}

static void sound_task(void *arg) {
    (void)arg;
    request_t r;
    for (;;) {
        if (xQueueReceive(s_queue, &r, portMAX_DELAY) != pdTRUE) continue;
        s_busy = true;
        bool ok = true;
        if (r.chirp > HW_CHIRP_NONE && r.chirp < HW_CHIRP_COUNT) ok = play_chirp(r.chirp);
        if (ok && r.voice < HW_VOICE_COUNT) play_voice(r.voice);
        s_busy = !s_held && uxQueueMessagesWaiting(s_queue) > 0;
    }
}

esp_err_t hw_sound_init(void) {
    clips_init();
    esp_err_t err = bsp_audio_init();
    if (err == ESP_OK) err = bsp_audio_set_format(SR, 16, 1);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "audio unavailable (%s); running silent", esp_err_to_name(err));
        return err;
    }
    bsp_audio_set_volume(VOLUME);
    s_queue = xQueueCreate(1, sizeof(request_t));
    if (!s_queue) return ESP_ERR_NO_MEM;
    // Above the app task so PCM keeps flowing while the UI and network work.
    if (xTaskCreate(sound_task, "hw_sound", 3072, NULL, 7, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    return ESP_OK;
}

void hw_sound_hold(bool held) {
    s_held = held;
    if (held) {
        // Wait (bounded) for the current chunk to finish so the speaker is free.
        for (int i = 0; i < 30 && s_busy; i++) vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void hw_sound_play(hw_chirp_t chirp, hw_voice_t voice) {
    if (!s_queue || s_held) return;
    request_t r = { chirp, voice };
    s_busy = true;
    xQueueOverwrite(s_queue, &r);   // depth 1: the newest request replaces a waiting one
}

bool hw_sound_busy(void) {
    return s_busy;
}
