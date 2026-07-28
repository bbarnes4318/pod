# Host Studio control map

Host Studio deliberately separates **character behavior** from **acoustic voice**. Mixing the two creates hosts that look configurable but behave unpredictably.

## What the application controls

These values belong in the script-generation character contract because they determine **what the host thinks, notices, and chooses to say**:

- role on the show
- worldview and decision standard
- argument habits
- whether the host interrupts
- how the host concedes
- humor posture
- finishing-line behavior
- forbidden phrases
- prohibited character behaviors
- catchphrases, when explicitly supplied

The child-friendly controls compile through `src/lib/hosts/hostStudioProfile.ts` into:

- `AiHost.role`
- `AiHost.worldview`
- `AiHost.speakingStyle`
- `AiHost.argumentPatterns`
- `AiHost.bannedPhrases`
- `AiHost.catchphrases`
- the validated `AiHost.performanceProfile`

The UI never asks customers to write a system prompt.

## What the performance profile controls

The validated performance profile is the bridge between the script and TTS:

- normal and maximum pace
- normal and peak intensity ranges
- humor/laughter posture
- interruption posture
- concession posture
- finishing-line posture
- pressure direction: louder/faster, quieter/sharper, or louder/slower
- pause density
- prohibited delivery traits
- Fish sampling variation (`temperature` and `top_p`)

The first sentence of the compiled speaking style is intentionally a compact acoustic delivery instruction because Fish scene rendering distills that sentence into the per-speaker scene cue.

## What Fish controls

Fish controls the physical sound and synthesis behavior:

- the selected or cloned voice model (`reference_id`)
- designed voice candidates
- speaking speed and volume for single-speaker previews
- sampling variation (`temperature`, `top_p`)
- inline emotional/delivery cues
- multi-speaker scene performance
- audio quality and consistency of the clone source

Fish should not be asked to invent the character's beliefs or argument strategy. Those must already be present in the script and performance direction.

## Voice workflows

### Design a voice

1. The user picks age, identity, sound, delivery, and accent in plain language.
2. Host Studio calls Fish `POST /v1/voice-design` and requests three candidates.
3. The candidates are played directly in the browser.
4. The selected candidate audio is sent to Fish `POST /model` as a private fast voice model.
5. The returned Fish voice ID is attached to the host and hidden from the normal UI.

### Clone an authorized voice

1. The user uploads one to three audio recordings.
2. The UI recommends at least 10 seconds and 30–60 seconds for a more natural clone.
3. The user must attest that they own the voice or have written permission.
4. Host Studio sends the recordings to Fish `POST /model` with private visibility.
5. The returned voice model is attached to the host with an ownership/permission provenance note.

### Existing Fish voice

This is an advanced path for customers who already own or license a Fish voice. The raw 32-character ID is not shown in the normal workflow.

## Preview contract

The old Character Studio preview forced every host into one analytical, medium-energy line. Host Studio provides three honest situations:

- normal conversation
- disagreement/interruption
- under pressure

Each preview uses the host's actual compiled performance profile, including pressure direction, speed, volume, Fish sampling values, and forbidden delivery traits.

## Safety and ownership

- Host mutations remain server-side owner gated.
- Shared starter hosts remain read-only until copied.
- Voice clones are private Fish models.
- A clone cannot be created without explicit rights attestation.
- Voice provenance remains stored on `AiHost`.
- A host can be saved without a voice, but audio production remains blocked by the existing placeholder-voice guards.
