// Host tests for main/hw_sweep.c (celebration timeline).
#include "hw_sweep.h"

#include <assert.h>
#include <stdio.h>

static const hw_sweep_geo_t G = {
    .home_x = 87, .home_y = 11, .first_row_y = 66, .row_pitch = 42,
    .min_x = 6, .max_x = 168, .body_w = 66,
    .roller_cx = { 39, 15 }, .roller_cy = 62,
};

static void test_total(void) {
    assert(hw_sweep_finale_ms(5) == 500 + 5 * 600 + 600);
    assert(hw_sweep_total_ms(5) > hw_sweep_finale_ms(5));
    assert(hw_sweep_finale_ms(0) < hw_sweep_finale_ms(1));
    assert(hw_sweep_finale_ms(99) == hw_sweep_finale_ms(HW_SWEEP_MAX));   // clamped
    assert(hw_sweep_dir(0) == 1 && hw_sweep_dir(1) == -1 && hw_sweep_dir(2) == 1);
}

static void test_pose(void) {
    hw_sweep_pose_t p;
    hw_sweep_pose(&G, 5, 0, &p);
    assert(p.x == G.home_x && p.y == G.home_y && !p.text_on);
    for (int i = 0; i < 5; i++) assert(p.cleared[i] == 0);
    hw_sweep_pose(&G, 5, 500, &p);                          // arrived at row 0, left edge
    assert(p.x == G.min_x && p.y == G.first_row_y && p.facing == 0);
    hw_sweep_pose(&G, 5, 500 + 600 * 4 / 10 + 250, &p);     // card 0 gone, card 1 untouched
    assert(p.cleared[0] == 1000 && p.cleared[1] == 0);
    hw_sweep_pose(&G, 5, 500 + 600 + 100, &p);              // row 1 sweeps leftwards
    assert(p.facing == 1 && p.y == G.first_row_y + G.row_pitch);
    hw_sweep_pose(&G, 5, 500 + 600 + 480 + 60, &p);         // dropping to row 2 at the right edge...
    assert(p.x == G.max_x || p.x == G.min_x);
    assert(p.y > G.first_row_y + G.row_pitch && p.y < G.first_row_y + 2 * G.row_pitch);
    int fin = hw_sweep_finale_ms(5);
    hw_sweep_pose(&G, 5, fin - 1, &p);                      // nearly home
    assert(!p.text_on && p.x >= G.home_x - 3 && p.x <= G.home_x + 3);
    hw_sweep_pose(&G, 5, fin, &p);
    assert(p.text_on && p.x == G.home_x && p.y == G.home_y);
    for (int i = 0; i < 5; i++) assert(p.cleared[i] == 1000);
    hw_sweep_pose(&G, 5, fin + 200, &p);                    // mid-hop: higher than home
    assert(p.y < G.home_y);
    hw_sweep_pose(&G, 5, hw_sweep_total_ms(5), &p);
    assert(p.y == G.home_y && p.facing == 0);
}

static void test_never_off_screen(void) {
    for (int n = 0; n <= HW_SWEEP_MAX; n++) {
        for (int ms = 0; ms <= hw_sweep_total_ms(n); ms += 7) {
            hw_sweep_pose_t p;
            hw_sweep_pose(&G, n, ms, &p);
            assert(p.x >= G.min_x - 1 && p.x <= G.max_x + 1);
            assert(p.y <= 320 - 84 && p.y >= G.home_y - 14);   // robot 84 px tall; the hop is the highest point
            for (int i = 0; i < HW_SWEEP_MAX; i++) assert(p.cleared[i] >= 0 && p.cleared[i] <= 1000);
        }
    }
}

static void test_cards_only_clear_when_present(void) {
    hw_sweep_pose_t p;
    hw_sweep_pose(&G, 2, 0, &p);
    assert(p.cleared[0] == 0 && p.cleared[1] == 0 && p.cleared[2] == 1000);   // unused slots stay gone
    hw_sweep_pose(&G, 0, 0, &p);
    assert(!p.text_on && p.y == G.home_y);
    hw_sweep_pose(&G, 0, hw_sweep_finale_ms(0), &p);
    assert(p.text_on);
}

static void test_particles(void) {
    hw_sweep_particle_t q;
    hw_sweep_particle(&G, 5, 0, 0, &q);
    assert(!q.visible);                                     // nothing flies before a card is swept
    int tc = 500 + 600 * 4 / 10;
    hw_sweep_particle(&G, 5, 0, tc, &q);
    assert(q.visible && q.opa == 255);
    hw_sweep_particle(&G, 5, 0, tc + 100, &q);
    assert(q.visible && q.opa < 255);
    hw_sweep_particle(&G, 5, 0, tc + 600, &q);
    assert(!q.visible);
    hw_sweep_particle(&G, 5, 14, tc, &q);                   // card 4's pieces wait for card 4
    assert(!q.visible);
    hw_sweep_particle(&G, 2, 9, 0, &q);                     // piece of a card that is not there
    assert(!q.visible);
    int fin = hw_sweep_finale_ms(5);
    for (int p = 0; p < HW_SWEEP_PARTICLES; p++) {
        hw_sweep_particle(&G, 5, p, fin + 1, &q);
        assert(q.visible);
    }
    hw_sweep_particle(&G, 5, 3, hw_sweep_total_ms(5), &q);
    assert(!q.visible);
    hw_sweep_particle(&G, 5, -1, fin, &q);
    assert(!q.visible);
}

int main(void) {
    test_total();
    test_pose();
    test_never_off_screen();
    test_cards_only_clear_when_present();
    test_particles();
    puts("test_hw_sweep: PASS");
    return 0;
}
