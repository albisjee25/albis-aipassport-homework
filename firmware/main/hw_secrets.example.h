// main/hw_secrets.example.h - placeholder used when main/hw_secrets.h is absent
// (CI, community builds). Normal devices do NOT need a hw_secrets.h: they find the Mac
// by broadcast and pair with it. For development only, bake in a name + token with:
//   homework-helper/.venv/bin/python homework-helper/tools/gen_device_config.py <this checkout>
// main/hw_secrets.h is git-ignored: it holds the device token.
#pragma once

#define HW_RELAY_HOSTNAME    "my-mac"          // Bonjour name, without ".local"
#define HW_RELAY_FALLBACK_IP "192.168.1.2"     // used if the name cannot be resolved
#define HW_RELAY_PORT        8787
#define HW_DEVICE_TOKEN      "not-configured"
