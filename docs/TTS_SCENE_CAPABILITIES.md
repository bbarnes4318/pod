# TTS Scene Capabilities (verified matrix)

This file records, per registered TTS engine, exactly which scene-generation
capabilities we could VERIFY and how. It backs the capability matrix in
`src/lib/providers/tts/capabilities.ts` — the code must never claim more than
this document supports.

Statuses:

- `verified_documentation` — read from the provider's official documentation or
  the provider's OFFICIAL SDK source (which is generated from their API
  definition). The exact source is cited.
- `verified_live_probe` — confirmed by a real API call from this repo. (None
  yet: this environment has no provider credentials and its egress proxy
  blocks the provider hosts; nothing below is marked live-probed.)
- `unsupported` — the official material shows the feature does not exist.
- `unknown` — we could not verify either way. Unknown stays unknown; the code
  must treat unknown as "do not use".

Verification date: 2026-07-25. Sources: official SDK repositories fetched at
that date (`elevenlabs/elevenlabs-python@main`, `fishaudio/fish-audio-python@main`,
`openai/openai-node@master`) plus the providers' official documentation pages
(docs frontends for elevenlabs.io/docs and docs.fish.audio; retrieved via
search index because this environment's egress proxy blocks those hosts
directly — treat any item relying ONLY on that channel with the extra caution
noted inline).

---

## elevenlabs

| Capability | Status | Value / notes |
| --- | --- | --- |
| Production model IDs | `verified_documentation` | `eleven_v3` (expressive, audio tags), `eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`. Model for dialogue is queried via `GET /v1/models` (`can_do_text_to_speech`). |
| Single-speaker TTS | `verified_documentation` | `POST /v1/text-to-speech/{voice_id}` (already integrated). |
| Native multi-speaker scene | `verified_documentation` | `POST /v1/text-to-dialogue` — body `inputs: [{ text, voice_id }, ...]` in speaking order, plus `model_id`, `language_code?`, `settings? { stability }`, `seed?`, `apply_text_normalization? ('auto'\|'on'\|'off')`; query `output_format`. Source: official Python SDK `src/elevenlabs/text_to_dialogue/client.py` + `types/dialogue_input.py` + `types/model_settings_response_model.py`. |
| Max speakers per scene | `verified_documentation` | **10 unique voice IDs** per request (SDK docstring). |
| Recommended max request size | `verified_documentation` | **≤ 2,000 characters total across all `inputs[].text`** per request; "longer requests can terminate early in streaming responses or return a validation error" (SDK docstring, same text as the API reference page). This is the scene-planner budget — NOT the unrelated single-speaker text limit. |
| Hard max characters | `unknown` | Only the 2,000-char reliability guidance is documented; no hard cap is published for the dialogue endpoint. |
| Context / continuation (`previous_text` / `next_text`) | `unsupported` (dialogue) | The dialogue endpoint has **no continuity fields at all** (verified against the full SDK signature). For single-speaker TTS, `previous_text`/`next_text` exist but are rejected by `eleven_v3` (observed 400 `unsupported_model` in production; kept v2-only in our adapter). |
| Acting-instruction (natural-language direction) parameter | `unsupported` | No direction/instruction field on either endpoint. Delivery is steered only via inline audio tags (v3) and `settings.stability`. |
| Inline delivery tags | `verified_documentation` | `eleven_v3` interprets bracketed audio events (`[laughs]`, `[sighs]`, …) inside `inputs[].text` (Text to Dialogue capability page). Non-v3 models read them aloud — tags must be stripped for those. |
| Seed | `verified_documentation` | `seed` integer 0–4294967295, best-effort determinism, "determinism is not guaranteed" (SDK docstring). |
| Multiple candidates per request | `unsupported` | No `num_generations`-style field on the dialogue endpoint. Candidates are produced by repeating the request (different/absent seed). |
| Word/char timestamps | `verified_documentation` | `POST /v1/text-to-dialogue/with-timestamps` (SDK: `convert_with_timestamps`) returns `audio_base64` + `alignment` / `normalized_alignment` with `characters[]`, `character_start_times_seconds[]`, `character_end_times_seconds[]`. This is the scene timing-map source. |
| Speaker diarization of the output | `unsupported` | The response does not label characters by speaker; speaker attribution must be derived by mapping the concatenated input texts onto the character alignment (deterministic, since we sent the turns). |
| Custom voices / cloning | `verified_documentation` | `voice_id` per dialogue input; IVC/PVC voices usable. |
| Output formats | `verified_documentation` | `output_format` as `codec_samplerate_bitrate` (e.g. `mp3_44100_192` — Creator tier+; `pcm_44100` — Pro tier+). |
| Mono/stereo & track separation | `verified_documentation` | One MIXED audio stream per scene (mp3/pcm are single-stream renders; there is no per-speaker track output on this endpoint). Do NOT pan hosts inside a scene. |
| Long-generation limits | `verified_documentation` | The 2,000-char guidance above is the reliability boundary; streaming responses can terminate early beyond it. |
| GA / preview | `verified_documentation` | Text to Dialogue is a released capability (public API reference + GA SDK methods). ElevenLabs' docs describe v3 dialogue output as highly expressive and non-deterministic; treat candidate auditioning as a first-class need, not an edge case. |

## fish

| Capability | Status | Value / notes |
| --- | --- | --- |
| Production model IDs | `verified_documentation` | Official SDK (`fishaudio` package, `types/shared.py`): `Model = "speech-1.5" \| "speech-1.6" \| "s1" \| "s2-pro"`, with `speech-1.5`/`speech-1.6` explicitly DEPRECATED ("Use 's1' or 's2-pro' instead"). The official docs' curl example additionally shows a `model: s2.1-pro-free` header (S2.1 Pro free tier). Our previous default `s2.1-pro-free` therefore still exists, but the SDK-canonical production id is **`s2-pro`**. Scene mode defaults to `s2.1-pro-free` (override: `FISH_SCENE_MODEL`) — see the live-verification row below for why. |
| Single-speaker TTS | `verified_documentation` | `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer`, model selected by the `model` header, body `{ text, reference_id?, format, mp3_bitrate, temperature, top_p, ... }` (official SDK `TTSRequest`). Already integrated. |
| Native multi-speaker scene | `verified_live_api` (2026-07-25) | ~~Multi-speaker dialogue is S2-Pro only~~ — **outdated**: a live request against `api.fish.audio/v1/tts` with `model: s2.1-pro-free`, `<|speaker:N|>` tags and a 2-entry `reference_id` array returned HTTP 200 with real dialogue audio, so the FREE-TIER model renders scenes too. `s2-pro` additionally requires funded **API credit** (billed separately from platform credit — HTTP 402 `Insufficient API credit` otherwise; fund at fish.audio/app/developers). The scene is ONE request: `text` contains the whole dialogue with `<|speaker:N|>` tags marking each turn (`"<|speaker:0|>Hello!<|speaker:1|>Hi there!"`), and `reference_id` is an ARRAY of voice model ids whose positions map to the speaker indexes (docs example: `"reference_id": ["model-id-alice", "model-id-bob"]`). Because this shape was verified only through the indexed official docs (the SDK models single-speaker only), the adapter validates the response hard (non-empty audio, sane duration) and the fallback path stays one config flip away. |
| Max speakers per scene | `unknown` | No documented cap found. The planner conservatively allows at most the cast size (≤ 4). |
| Recommended max request size | `unknown` | Not published for dialogue. Planner default budget: 2,000 chars per scene (`FISH_SCENE_MAX_CHARS` to tune), chosen to match the S2 examples' scale — a conservative, overridable choice, not a documented limit. |
| Context / continuation across requests | `unsupported` | No cross-request continuation field in the official SDK/API (the `condition_on_previous_chunks` field conditions chunks WITHIN one request only). |
| Acting-instruction support | `verified_documentation` | Natural-language delivery control via inline `(bracket)`/`[bracket]` cues in the text (S2 docs); no separate instruction parameter. |
| Inline delivery tags | `verified_documentation` | Inline natural-language cues, applied per moment; emotion tags apply to the current speaker only in multi-speaker text. |
| Seed | `unsupported` | No seed field in the official SDK request schema. `temperature`/`top_p` are the only stochasticity controls. |
| Multiple candidates | `unsupported` | No n-generations field; candidates = repeated requests. |
| Word timestamps | `unsupported` | TTS response is raw audio bytes; no alignment payload. (Fish ASR exists but is a separate product; not wired here.) |
| Speaker diarization | `unsupported` | Not offered on TTS output. |
| Custom voices / cloning | `verified_documentation` | `reference_id` (hosted voice model, 32-hex) or `references[]` (zero-shot audio+text). We only ever send validated 32-hex `reference_id`s. |
| Output formats | `verified_documentation` | `mp3` (64/128/192 kbps), `wav`, `pcm`, `opus` (SDK `TTSRequest`). |
| Mono/stereo & track separation | `verified_documentation` | One mixed audio stream; no per-speaker tracks. Do NOT pan hosts inside a scene. |
| Long-generation limits | `unknown` | Not published; the adapter enforces the planner budget instead. |
| GA / preview | `verified_documentation` | S2-Pro is a released production model (official SDK default: `model: Model = "s2-pro"`). |

## cartesia

| Capability | Status | Value / notes |
| --- | --- | --- |
| Single-speaker TTS | `verified_documentation` | Existing integration (`sonic` family via bytes endpoint) — unchanged. |
| Native multi-speaker scene | `unknown` | No dialogue endpoint verified in this pass (docs unreachable from this environment; not present in the integrated API surface). Treated as no-scene: **explicit line fallback**. |
| Continuation | `unknown` | Cartesia's continuation contexts exist on their WebSocket API per prior integration knowledge, but were NOT re-verified in this pass — not used. |
| Everything else | `unknown` | Line mode only. |

## openai

| Capability | Status | Value / notes |
| --- | --- | --- |
| Production model IDs | `verified_documentation` | `gpt-4o-mini-tts` (instruction-steerable), `tts-1`, `tts-1-hd` (official Node SDK `resources/audio/speech.ts`). |
| Single-speaker TTS | `verified_documentation` | `input` + one `voice` per request; voices `alloy…cedar/marin`; `response_format` mp3/opus/aac/flac/wav/pcm; `speed` 0.25–4.0. |
| Acting-instruction support | `verified_documentation` | `instructions` field ("Control the voice of your generated audio with additional instructions. Does not work with `tts-1` or `tts-1-hd`."). This is where format/role-aware direction compiles for OpenAI. |
| Native multi-speaker scene | `unsupported` | One voice per request, no dialogue input shape. **Explicit line fallback.** |
| Continuation / seed / timestamps / diarization | `unsupported` | None of these fields exist on the speech endpoint. |
| Mono/stereo | `verified_documentation` | Single mixed stream per request. |

## boson

| Capability | Status | Value / notes |
| --- | --- | --- |
| Single-speaker TTS | existing integration | `higgs-tts-3` per current adapter; `<\|emotion:…\|>` control tokens via `sanitizeForBosonTts`. |
| Native multi-speaker scene | `unknown` | Boson/Higgs multi-speaker generation exists in the open-source model line, but no official hosted-API dialogue contract could be verified in this pass. **Explicit line fallback.** |
| Everything else | `unknown` | Line mode only. |

## stub

No capabilities; always fails loudly. Used to make fallback paths testable.

---

## How the code consumes this

`src/lib/providers/tts/capabilities.ts` encodes exactly the table above:

- `renderUnits` includes `multi_speaker_scene` ONLY for `elevenlabs` and `fish`.
- ElevenLabs scene budget: `recommendedMaxCharacters: 2000`, `maxSpeakers: 10`.
- Fish scene budget: `recommendedMaxCharacters` from `FISH_SCENE_MAX_CHARS`
  (default 2000 — an operational choice, documented as such), `maxSpeakers: 4`
  (platform cast bound, since the provider cap is unknown).
- `supportsWordTimestamps` true only for ElevenLabs (dialogue with-timestamps).
- `supportsSeed` true only for ElevenLabs.
- Every other provider reports no scene support, and the scene service records
  an explicit `fallback` decision instead of guessing.

Nothing in this file or in `capabilities.ts` may be upgraded to a stronger
status without either a cited official doc/SDK source or a recorded live probe.
