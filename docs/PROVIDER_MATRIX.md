# TTS Provider Capability Matrix

This matrix defines the features, audio formats, and inline formatting capabilities supported by each text-to-speech (TTS) provider integrated into the Take Machine podcast platform.

| Capability / Attribute | Boson AI (`boson`) | Cartesia (`cartesia`) | ElevenLabs (`elevenlabs`) | OpenAI (`openai`) | Stub (`stub`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Supports Streaming** | Yes | Yes | Yes | Yes | No |
| **Supports Non-Streaming** | Yes | Yes | Yes | Yes | Yes |
| **Supported Audio Formats** | MP3, PCM (raw) | MP3, PCM (raw) | MP3, PCM (raw) | MP3, AAC, FLAC | MP3 |
| **Supports WAV** | No (unconfirmed) | Yes | Yes | Yes | No |
| **Supports Ulaw** | No (unconfirmed) | Yes | No | No | No |
| **Supports Inline Tags** | Yes (emotion, prosody) | No | No | No | No |
| **Supports Voice Cloning** | Yes (reference audio) | Yes (custom IDs) | Yes (custom IDs) | No | No |

## Sanitization Behaviors

- **Generic TTS Sanitization**: Applied to Cartesia, ElevenLabs, OpenAI, and Stub providers. Strips all markdown symbols (`*`, `_`, `_`, `#`, `~`), raw URLs, and any XML/Boson style inline tags.
- **Boson TTS Sanitization**: Applied only when the active provider is `boson` and `BOSON_TTS_ENABLE_TAGS=true`. Strips markdown and raw URLs, but preserves valid Boson tags such as `<|emotion:enthusiasm|>` and `<|prosody:speed_slow|>`.
