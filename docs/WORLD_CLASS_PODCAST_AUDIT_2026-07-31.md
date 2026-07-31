# World-Class Podcast Production Audit

**Repository:** `bbarnes4318/pod`  
**Audit date:** July 31, 2026  
**Scope:** topic selection, research, editorial architecture, dialogue generation, host identity, TTS performance, sound design, quality gates, publishing, and measurement.

## Executive verdict

This is not a toy prompt-to-audio application. It already contains evidence snapshots, role-specific LLM routing, outline-driven dialogue, grounding repair, continuity, scene TTS, sound-design planning, and extensive contract tests.

Its biggest weakness is more dangerous than missing features: **several of the strongest quality systems measure defects without controlling the production outcome.** A technically valid episode can pass even when the two hosts sound like one model, the opening has no retention power, or the selected voice performance is merely the first successful render.

This branch makes the independent script judge produce a persisted editorial decision, allows a true hold to stop downstream production, corrects the Fish production model contract, and auditions ElevenLabs dialogue takes before selecting one.

## P0 findings addressed

### Independent editorial judgment now governs the artifact

Every generated script stores its deterministic score, independent judge verdict or explicit error, excerpts, a `pass` / `review` / `hold` decision, exact reasons, thresholds, and whether downstream production is blocked. Manual approval remains the normal human override.

### ElevenLabs no longer trusts take one

Production renders several stochastic Text-to-Dialogue performances, analyzes raw dynamics and pacing, and selects the strongest passing candidate. Cold opens and escalation scenes receive the larger audition budget. Provider-native `voice_segments` timing is used when available.

### Fish uses the current production S2 model contract

Scene rendering now defaults to `s2-pro`, while remaining overridable after a live provider test.

### CI asserts the new hold behavior

The deterministic workflow still uses stubs, but now proves that the independent editorial decision is persisted and enforceable. A separate real-provider canary is still required.

## P0 work still required

### Build a listener-retention benchmark

Use at least 100 blinded episode comparisons. Measure whether listeners continue at 15 seconds, 60 seconds, minute 3, midpoint, and ending. Store pairwise preferences, not only 1–10 scores.

### Add transcript-aware audio verification

The acoustic analyzer catches clipping, dead air, metronomic pauses, weak dynamics, and repetitive terminal cadence. It does not prove word accuracy, speaker identity, intended emphasis, interruption timing, character stability, or emotional progression. Add an audio-understanding judge that receives the approved transcript, cast bible, direction, and audio.

### Replace headline hook scoring

Current topic hook scoring leans heavily on question marks, dramatic keywords, and proper names. Rank stories on unresolved uncertainty, consequence to a specific person, credible opposing interpretations, novelty, reveal potential, emotional contradiction, evidence richness, and ability to cause a position change.

### Treat the first 45 seconds as a separate product

Generate three cold opens: accusation, surprising consequence, and unresolved contradiction. Judge and voice all finalists. Select on performed audio. Never begin with greetings, show description, or both hosts stating prepared positions.

### Give hosts asymmetric objectives

Each host needs a private objective, one assigned fact, one protected belief, one reluctant concession, one behavioral trigger, and one misunderstanding of the other host. Asymmetric information creates discovery; shared briefs create polished summaries.

### Separate writer responsibilities

Use distinct passes for story editor, debate architect, Host A writer, Host B writer, dialogue director, continuity editor, and independent judge. The director may improve transitions and reactions but must not homogenize both hosts.

### Stop trusting aggregate quality

A high total can hide fatal chemistry. Enforce dimension floors for hook, host distinctness, causality, spoken naturalness, argument progression, emotional progression, payoff, factual integrity, voice identity, and transcript fidelity.

## Model strategy

Do not pick one LLM for the entire pipeline. Run dated challenger tests on identical real episode inputs and preserve raw outputs, latency, cost, judge breakdown, and blinded human preference.

Current challenger families to test:

- Editorial architecture and difficult synthesis: OpenAI GPT-5.6 Sol and Anthropic Claude Opus 5.
- Creative spoken dialogue: Anthropic Claude Fable 5, OpenAI GPT-5.6 Sol, and the current best measured in-app writer.
- Fast extraction and metadata: the lowest-cost current model that passes exact schema and factual tests.
- Independent judging: a different provider family from the writer.
- Audio understanding: a current multimodal model tested on known generated-audio defects.

Promotion requires a blinded human win without unacceptable factuality, latency, or cost regression. Generic benchmarks do not count as evidence for this application.

## Voice strategy

Bernadette Zabala and Cal Mercer are directionally strong, materially different characters. The operational risks remain:

- Cal has a placeholder voice unless production overrides it.
- impressive 10-second clones can become fatiguing over 12 minutes;
- scene-to-scene identity drift destroys believability;
- a clone can sound human while performing the wrong character.

Use one blind eight-scene audition pack for every voice: cold accusation, amused disbelief, interruption, restrained concession, factual explanation, genuine anger, quiet kill shot, and closing reflection. Score identity consistency, fatigue, intelligibility, spontaneity, emotional range, interruption quality, and character fit.

## Sound design

Use sound to create identity and pacing, not to prove effects exist. Keep a short sonic signature, subtle room tone, music mainly under bookends, and sparse stingers at genuine structural turns. Remove anything listeners describe as “AI,” “YouTube,” “radio imaging,” or “overproduced.”

## Required live canary

A scheduled private canary should run every active provider contract, create a full script, apply editorial gates, render scenes, run acoustic and transcript-aware QA, mix, upload a private artifact, publish no RSS item, compare with the last known-good run, and alert on drift.

## North-star metrics

Track 15-second retention, 60-second retention, completion, next-episode play, “sounds human” rate, host distinguishability, cold-open pairwise win rate, repeated-point rate, unsupported-claim rate, voice regeneration rate, transcript word-error rate, speaker-attribution error rate, cost per publishable minute, and production latency per publishable minute.

The winning system is not the one that generates the most episodes. It produces the highest percentage a human editor willingly publishes and a listener voluntarily finishes.
