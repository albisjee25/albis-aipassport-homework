// The host preview has no power log: swallow the redraw counter that hw_ui.c feeds.
#include "hw_diag.h"
void hw_diag_ui_flush(int pixels) { (void)pixels; }
