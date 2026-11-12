// main/hw_sweep.h - timeline of the "all homework done" celebration (pure logic, no LVGL).
//
// The robot drives down the screen in a zig-zag, its roller brush sweeping one finished task
// card off the screen per row, then returns home and throws confetti. Everything is a
// function of elapsed milliseconds, so the UI just asks "where is everything at t?" and the
// result can be unit-tested on the host.
#pragma once

#include <stdbool.h>

#define HW_SWEEP_MAX       5                       // task cards shown
#define HW_SWEEP_PARTICLES (HW_SWEEP_MAX * 3)      // confetti pieces (3 per card, all 15 for the finale)

// Screen geometry, supplied by the UI (robot sprite size depends on the art in use).
typedef struct {
    int home_x, home_y;        // robot top-left when idle
    int first_row_y;           // robot top-left y when its roller is level with card 0
    int row_pitch;             // distance between cards
    int min_x, max_x;          // robot x travel limits
    int body_w;                // robot width (confetti leaves from the middle of its head)
    int roller_cx[2];          // roller centre relative to the robot's top-left, per facing
    int roller_cy;
} hw_sweep_geo_t;

typedef struct {
    int x, y;                  // robot top-left
    int facing;                // 0: right, 1: left
    int cleared[HW_SWEEP_MAX]; // per card: 0 (untouched) .. 1000 (gone)
    bool text_on;              // the "all done" title may show
} hw_sweep_pose_t;

typedef struct {
    bool visible;
    int x, y, opa;             // opa 0..255
} hw_sweep_particle_t;

// Total length for `cards` cards (0..HW_SWEEP_MAX); the animation is over after this.
int hw_sweep_total_ms(int cards);
// Moment the finale starts (robot is home, title shows, confetti flies).
int hw_sweep_finale_ms(int cards);
// Direction the robot sweeps card `i`: +1 to the right, -1 to the left.
int hw_sweep_dir(int i);

void hw_sweep_pose(const hw_sweep_geo_t *g, int cards, int ms, hw_sweep_pose_t *out);
void hw_sweep_particle(const hw_sweep_geo_t *g, int cards, int p, int ms, hw_sweep_particle_t *out);
