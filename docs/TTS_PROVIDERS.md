# TTS Providers & Voice-Engine Resolution

Registered engines (see `src/lib/providers/tts/factory.ts` and
`src/lib/providers/tts/providerIds.ts`): `elevenlabs`, `cartesia`, `openai`,
`boson`, `fish`, `stub`.

## Which engine voices a line?

Resolved per TTS job in `src/lib/services/ttsSegmentService.ts`, highest
priority first:

1. **Trigger override** — the "TTS Provider Override" dropdown on
   `/admin/audio-segments/[scriptId]` (job payload `providerOverride`).
   An explicit override also **re-pins the episode** (writes
   `Episode.ttsProvider`) so later re-runs keep using the same engine.
2. **Episode engine** — `Episode.ttsProvider`, pinned at build time by the
   "Voice engine" picker on `/app/create` (persisted when "Produce the
   episode" creates the episode). Applies to every segment and every re-run.
3. **Per-host default** — `AiHost.ttsProvider` (admin → Personalities).
   Only consulted when neither 1 nor 2 is set, and lets each host speak
   through a different engine. A value of `stub` means "not set".
4. **Env default** — `TTS_PROVIDER`.
5. `stub` as the last resort.

So: the episode-level choice always beats the per-host setting; per-host is
the *default* engine mix for episodes that don't pin one.

The `tts:generate-segments` job log records the resolution: `input.providerOverride`,
`output.provider` (the resolved default) and `output.providerLineCounts`
(actual synthesized lines per engine). Each `AudioSegment.provider` row also
records the engine that produced it.

## Per-engine delivery formatting

Emotion/delivery markup is applied per resolved engine, per line:

- **Boson** — `<|emotion:...|>` control tokens via `sanitizeForBosonTts`
  (when `BOSON_TTS_ENABLE_TAGS=true`); formatter in `bosonFormat.ts`.
- **Fish** — inline natural-language `[bracket]` cues, applied *inside*
  `FishTTSProvider` via `fishFormat.ts` (max 2 cues/line). Model from
  `FISH_MODEL` (default `s2.1-pro-free`), auth via `FISH_API_KEY`.
- **ElevenLabs / Cartesia** — generic sanitizer keeps `[laughs]`-style audio
  tags intact for the engine to perform.

## Env vars

| Var | Meaning |
| --- | --- |
| `TTS_PROVIDER` | Global default engine |
| `FISH_API_KEY` / `FISH_MODEL` | Fish Audio auth + model (`s2.1-pro-free` default) |
| `FISH_TTS_VOICE`, `FISH_MAX_VOLTAGE_VOICE_ID`, `FISH_DR_LINEBREAK_VOICE_ID` | Fish voice (reference id) overrides |
| `FISH_TTS_TIMEOUT_MS`, `FISH_TTS_MAX_RETRIES` | Fish request tuning |
