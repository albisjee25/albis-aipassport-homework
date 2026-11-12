// Host stand-in for esp_rom_printf (used by the DIAG(keys) lines in hw_ui.c).
#pragma once
#include <stdio.h>
#define esp_rom_printf(...) ((void)0)
