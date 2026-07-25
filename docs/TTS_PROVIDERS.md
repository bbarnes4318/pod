# TTS Providers & Voice-Engine Resolution

> **Scene mode (native multi-speaker dialogue).** Line-by-line synthesis is now
> the LEGACY render mode. When `TTS_RENDER_MODE=scene|auto` and every cast
> voice resolves to ONE engine with verified native dialogue support
> (`elevenlabs` via Text to Dialogue, `fish` via S2-Pro `<|speaker:N|>` — see
> `docs/TTS_SCENE_CAPABILITIES.md`), whole conversational scenes are generated
> in single requests (`src/lib/services/ttsSceneService.ts`, planner in
> `src/lib/audio/dialogueScenePlanner.ts`) and assembled with their native
> internal timing preserved (`src/lib/services/sceneStitchingService.ts`).
> The decision actually taken is persisted on `Episode.ttsRenderMode`
> (`legacy_line | scene | mixed_fallback`). Flags:
> `TTS_RENDER_MODE` (default `legacy_line`), `TTS_SCENE_PROVIDER_ALLOWLIST`
> (default `elevenlabs,fish`), `TTS_SCENE_CANDIDATES_COLD_OPEN|_PEAK|_DEFAULT`
> (default 1), `ELEVENLABS_DIALOGUE_MODEL_ID` (default `eleven_v3`),
> `ELEVENLABS_DIALOGUE_TIMESTAMPS` (default on), `FISH_SCENE_MODEL` (default
> `s2-pro`), `FISH_SCENE_MAX_CHARS` (default 2000),
> `TTS_TRANSCRIPT_QA_ENABLED` (default false — transcript QA reports
> `not_run`, never a fake pass). Tests: `npm run test:scene-planner`,
> `npm run test:scene-contracts`. Blind A/B pack: `npm run sample:human-dialogue`.
> Everything below describes voice/engine RESOLUTION, which scene mode reuses
> unchanged.

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

## Which voice ID does that engine get?

Resolved per host in `src/lib/providers/tts/voiceResolution.ts`
(`resolveTtsProviderAndVoice`), highest priority first — and always
**provider-aware**: a voice id is only ever used with the engine it was
picked for, so an ElevenLabs id can never be sent to Boson or a non-32-hex
id to Fish as a `reference_id`.

1. **Run override** — voice ids entered on the Audio Segment Console for
   this trigger (job payload `voiceOverrides`, keyed by host slug). With
   "Save to episode for future reruns" checked (the default) they are also
   pinned as episode overrides.
2. **Episode override** — `Episode.ttsVoiceOverrides`, pinned at build time
   by the "Voice Engine & Voices" section of the admin episode builder, or
   by a saved run override. Shape:
   `{ "max-voltage": { "provider": "boson", "voiceId": "...", "voiceName": "..." }, ... }`
   An entry only applies when its `provider` matches the resolved engine.
3. **Host default** — `AiHost.ttsVoiceId`, but only when `AiHost.ttsProvider`
   matches the resolved engine.
4. **Per-provider env fallback** — `<PROVIDER>_MAX_VOLTAGE_VOICE_ID` /
   `<PROVIDER>_DR_LINEBREAK_VOICE_ID` / shared default
   (`BOSON_TTS_VOICE`, `FISH_TTS_VOICE`, `ELEVENLABS_VOICE_ID`,
   `CARTESIA_VOICE_ID`, `OPENAI_TTS_VOICE`).
5. **Provider safe default** — Boson `default`, OpenAI `alloy`, Fish "no
   reference_id" (engine default voice), Cartesia known-good stock voices.
   ElevenLabs has no safe default and fails with
   `No voice ID configured for provider elevenlabs and host <name>`.

Each `AudioSegment.providerMetadata` records `{ provider, voiceId,
voiceName?, voiceSource, model }` where `voiceSource` is one of
`run_override | episode_override | host_default | env_default |
provider_default` — never API keys.

Unit tests: `npm run test:voice-resolution`.

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
| `<PROVIDER>_VOICE_ID_<HOST_SLUG>` | Generic per-host voice fallback for ANY host slug (upper-snake), e.g. `FISH_VOICE_ID_BERNIE_LINE_TWO`, `FISH_VOICE_ID_OTIS_LAMINATE`. Checked before the legacy named vars below. |
| `FISH_TTS_VOICE`, `FISH_MAX_VOLTAGE_VOICE_ID`, `FISH_DR_LINEBREAK_VOICE_ID` | Fish voice (reference id) overrides (legacy names kept for existing deployments) |
| `FISH_TTS_TIMEOUT_MS`, `FISH_TTS_MAX_RETRIES` | Fish request tuning |
