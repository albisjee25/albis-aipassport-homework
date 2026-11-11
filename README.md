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
2. Install the homework firmware on the device. Open the plugin page, click “修改设备设置或刷机” and ask the agent to install the firmware for the first time. It follows `DEV-GUIDE.md`: clones `firmware/` from this repository, writes this computer's connection settings with `scripts/device-config.mjs`, builds, and flashes **only after you confirm**. The firmware embeds your computer's name and device token, so every household builds its own.
3. The plugin page shows the device as online and the robot's head lamp turns red.

## Updates

The plugin market shows an update when a new version is published to npm. Firmware updates are flashed to the app partition only, so Wi-Fi settings are kept.

## Repository layout

| Path | What |
|---|---|
| `index.js`, `lib/`, `voice/` | Local service for the device and parent dashboard, agent tools |
| `client.js` | Sidebar page in Harness |
| `admin.html` | Parent dashboard at `http://127.0.0.1:8787` |
| `DEV-GUIDE.md` | Guide the Harness agent reads (tool `homework_dev_guide`) before customising or flashing |
| `firmware/` | Device firmware, based on [FoloToy/ai-passport](https://github.com/FoloToy/ai-passport) (MIT). Not included in the npm package |
| `scripts/device-config.mjs` | Writes `firmware/main/hw_secrets.h` (computer name, fallback IP, port, device token) |

## License

MIT. `firmware/` keeps FoloToy's MIT license, see `firmware/LICENSE`.
