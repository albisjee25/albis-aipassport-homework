# AI Passport Homework Helper (DeepSeek Harness plugin)

[中文说明](README.zh.md)

Turns the homework screenshots teachers post in parent group chats into a checklist on a **FoloToy AI Passport** device. The child holds a button to talk to a pixel-art robot, and works through the list one timed task at a time. The plugin learns how long each kind of homework actually takes.

Everything runs on your own computer inside DeepSeek Harness: the plugin uses the model you are signed in with, recognises speech locally (SenseVoice via sherpa-onnx), and keeps the child's data in `~/.dsh/homework-helper/`.

## What you need

- A FoloToy AI Passport (ESP32-C3) and a USB-C data cable
- DeepSeek Harness desktop, signed in
- Device and computer on the same 2.4 GHz Wi-Fi

## Install

1. Install the plugin from the Harness plugin market (search `albis-aipassport-homework`), or run
   `dsh plugin --profile desktop add albis-aipassport-homework`, then restart Harness.
2. Install the homework firmware on the device: flash it from the FoloToy AI Passport community page, or open the plugin page, click “修改设备设置或刷机” and ask the agent to build and flash `firmware/` (it asks before flashing). The same firmware works for every household.
3. Set up Wi-Fi with the “蓝牙配网” mini program. The device then shows a **4-digit pairing code**; the top of the plugin page in Harness shows the same code with Allow / Deny buttons. Check they match and click “允许”. The computer gives this device its own token, which it keeps; later boots connect by themselves. Click “拒绝” for a device you do not know.
4. The plugin page shows the device as online and the robot's head lamp turns red.

## Updates

When a new version is published to npm, the plugin page shows an update banner with the release notes and the sidebar entry gets an “更新” badge. Click Update, then restart Harness. (Only installs from the plugin market are offered updates.) The plugin market lists it too. Firmware updates are flashed to the app partition only, so Wi-Fi settings are kept.

## Repository layout

| Path | What |
|---|---|
| `index.js`, `lib/`, `voice/` | Local service for the device and parent dashboard, agent tools |
| `client.js` | Sidebar page in Harness |
| `admin.html` | Parent dashboard at `http://127.0.0.1:8787` |
| `DEV-GUIDE.md` | Guide the Harness agent reads (tool `homework_dev_guide`) before customising or flashing |
| `firmware/` | Device firmware, based on [FoloToy/ai-passport](https://github.com/FoloToy/ai-passport) (MIT). Not included in the npm package |
| `lib/pairing.js` | Device pairing: LAN discovery (UDP 8788), pairing code, per-device tokens |
| `scripts/device-config.mjs` | Optional, for development: bakes the computer name and token into a firmware build (not needed for normal installs) |

## License

MIT. `firmware/` keeps FoloToy's MIT license, see `firmware/LICENSE`.
