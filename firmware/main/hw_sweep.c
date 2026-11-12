// main/hw_sweep.c - see hw_sweep.h.
#include "hw_sweep.h"

#define LEAD_MS      500     // robot drives from home to the first row
#define SLOT_MS      600     // one row: 80 % sweeping sideways, 20 % dropping to the next row
#define SWEEP_PCT    80
#define CLEAR_AT_PCT 40      // the card goes when the roller passes the middle of the row
#define CLEAR_MS     250
#define RETURN_MS    600
#define HOP_MS       400
#define HOP_PX       10
#define SWEEP_LIFE   500
#define FINALE_LIFE  1100
#define EMPTY_MS     300     // nothing to sweep: just celebrate

static int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static int lerp(int a, int b, int num, int den) { return a + (b - a) * num / den; }

static int cards_ok(int cards) { return clamp(cards, 0, HW_SWEEP_MAX); }

int hw_sweep_finale_ms(int cards) {
    cards = cards_ok(cards);
    return cards == 0 ? EMPTY_MS : LEAD_MS + cards * SLOT_MS + RETURN_MS;
}

int hw_sweep_total_ms(int cards) { return hw_sweep_finale_ms(cards) + FINALE_LIFE; }

int hw_sweep_dir(int i) { return i % 2 == 0 ? 1 : -1; }

static int clear_start_ms(int i) { return LEAD_MS + i * SLOT_MS + SLOT_MS * CLEAR_AT_PCT / 100; }

static int row_y(const hw_sweep_geo_t *g, int i) { return g->first_row_y + i * g->row_pitch; }

void hw_sweep_pose(const hw_sweep_geo_t *g, int cards, int ms, hw_sweep_pose_t *o) {
    cards = cards_ok(cards);
    ms = ms < 0 ? 0 : ms;
    int fin = hw_sweep_finale_ms(cards);
    o->x = g->home_x;
    o->y = g->home_y;
    o->facing = 0;
    o->text_on = ms >= fin;
    for (int i = 0; i < HW_SWEEP_MAX; i++) {
        o->cleared[i] = i >= cards ? 1000 : clamp((ms - clear_start_ms(i)) * 1000 / CLEAR_MS, 0, 1000);
    }
    if (cards == 0 || ms >= fin) {
        if (cards > 0) {                       // hop for joy
            int u = clamp((ms - fin) * 1000 / HOP_MS, 0, 1000);
            o->y -= HOP_PX * 4 * u * (1000 - u) / 1000000;
        }
        return;
    }
    if (ms < LEAD_MS) {                        // home -> start of row 0 (left edge)
        o->x = lerp(g->home_x, g->min_x, ms, LEAD_MS);
        o->y = lerp(g->home_y, row_y(g, 0), ms, LEAD_MS);
        o->facing = g->min_x < g->home_x ? 1 : 0;
        return;
    }
    int t = ms - LEAD_MS;
    int slot = t / SLOT_MS;
    if (slot < cards) {
        int s = t - slot * SLOT_MS;
        int sweep_ms = SLOT_MS * SWEEP_PCT / 100;
        bool right = hw_sweep_dir(slot) > 0;
        int from = right ? g->min_x : g->max_x, to = right ? g->max_x : g->min_x;
        o->facing = right ? 0 : 1;
        o->y = row_y(g, slot);
        if (s < sweep_ms || slot == cards - 1) {
            o->x = lerp(from, to, clamp(s, 0, sweep_ms), sweep_ms);
        } else {                               // drop to the next row at the edge
            o->x = to;
            o->y = lerp(row_y(g, slot), row_y(g, slot + 1), s - sweep_ms, SLOT_MS - sweep_ms);
        }
        return;
    }
    // back home from the end of the last row
    int last = cards - 1;
    int ex = hw_sweep_dir(last) > 0 ? g->max_x : g->min_x;
    int r = clamp(ms - (LEAD_MS + cards * SLOT_MS), 0, RETURN_MS);
    o->x = lerp(ex, g->home_x, r, RETURN_MS);
    o->y = lerp(row_y(g, last), g->home_y, r, RETURN_MS);
    o->facing = g->home_x > ex ? 0 : 1;
}

// Launch speeds (px/s), one per piece; the finale doubles them for a bigger burst.
static const int VX[HW_SWEEP_PARTICLES] = { -90, 20, 100, -60, 70, -110, 40, 90, -30, 60, -80, 10, 110, -50, 80 };
static const int VY[HW_SWEEP_PARTICLES] = { -160, -220, -150, -250, -190, -140, -260, -170, -230, -200, -180, -240, -155, -210, -225 };
#define GRAVITY 600          // px/s^2

void hw_sweep_particle(const hw_sweep_geo_t *g, int cards, int p, int ms, hw_sweep_particle_t *o) {
    cards = cards_ok(cards);
    o->visible = false;
    o->x = o->y = o->opa = 0;
    if (p < 0 || p >= HW_SWEEP_PARTICLES) return;
    int fin = hw_sweep_finale_ms(cards);
    int t, life, ox, oy, k;
    if (ms >= fin) {                           // finale: every piece, from the robot's head
        t = ms - fin;
        life = FINALE_LIFE;
        ox = g->home_x + g->body_w / 2;
        oy = g->home_y + 6;
        k = 2;
    } else {                                   // sweep: 3 pieces fly off the roller as each card goes
        int card = p / 3;
        if (card >= cards) return;
        t = ms - clear_start_ms(card);
        life = SWEEP_LIFE;
        hw_sweep_pose_t at;
        hw_sweep_pose(g, cards, clear_start_ms(card), &at);
        ox = at.x + g->roller_cx[at.facing];
        oy = at.y + g->roller_cy;
        k = 1;
    }
    if (t < 0 || t >= life) return;
    o->visible = true;
    o->x = ox + VX[p] * k * t / 1000;
    o->y = oy + VY[p] * k * t / 1000 + GRAVITY * t / 1000 * t / 2000;
    o->opa = 255 - 255 * t / life;
}
