# 机器人的声音

默认用 `chirp.js`（机器人“哔嘟”语），不联网、不要密钥。想换声音，在插件设置里改 `voice.provider`：

| 值 | 说明 |
|---|---|
| `chirp`（默认） | 本地合成的哔嘟声，按字数和心情变化 |
| `azure` | 微软 Azure 语音（示例）。填 `voice.azureKey` 和 `voice.azureRegion`（如 `eastasia`） |
| `custom` | 你自己的文件：`voice.customModule` 写它的绝对路径 |

## 接入别的语音服务（让 Harness 助手帮你改）

复制 `azure.js` 当模板，对助手说“照 azure.js 的写法，帮我接入 ××× 的语音合成”。文件只要导出一个函数：

```js
// 返回 16kHz 单声道音频更好；别的采样率也行，插件会自动转
export async function synthesize(text, { mood, config }) {
  // text: 要说的话（不超过 30 字）；mood: hello/happy/worried/thinking/confused
  // config: 插件设置里 voice 那一组（可放你自己的密钥字段，比如 config.apiKey）
  return { samples: Float32Array /* -1..1 */, sampleRate: 16000 }
  // 也可以直接返回 WAV 的 Buffer
}
```

声音按“文字 + 心情 + 当前设置”缓存在数据目录的 `tts-cache/`，同一句话只合成一次。合成失败时，设备照样显示文字，只是没有声音。
