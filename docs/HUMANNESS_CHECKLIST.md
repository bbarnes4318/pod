# Human-ness Checklist

The bar: a listener should not be able to tell an episode is AI-generated.
This checklist has two halves — the automated half runs on every stitch job
(`analyzeEpisodeAudio` in `src/lib/audio/audioQa.ts`, results stored in the
`audio:stitch-final` JobLog under `output.audioQa`); the editorial half is a
2-minute human spot-check before publishing.

## Automated checks (run on every final master)

| Check | Pass | Why it matters |
|---|---|---|
| Integrated loudness | target ±1.5 LU (default -16 LUFS) | Podcast apps normalize; off-target masters sound amateur next to other shows. |
| Loudness range (LRA) | ≥ 4 LU (warn ≥ 2.5) | Flat energy across an episode is the single biggest robotic tell. Humans get louder when excited and quieter when conceding. |
| True peak | ≤ -0.8 dBFS | Headroom for platform re-encoding. |
| Pause variety | σ of pause lengths ≥ 0.12 s | Identical gaps between every line = splice assembly. Real turn-taking is irregular. |
| No dead stretches | longest pause ≤ 2.2 s | Long gaps read as edit errors, not drama. |
| No digital black | zero gaps ≥ 0.6 s below -70 dB | Real rooms always have air. Pure silence between turns exposes clip-by-clip assembly. |

Set `AUDIO_QA_STRICT=true` to make a failing check fail the stitch job
instead of logging a warning.

## Editorial spot-check (listen to 3 random 30-second windows + the first 30s)

**Script / conversation**
- [ ] Cold open starts mid-argument — no "welcome to the show" as the first line.
- [ ] Hosts react to each other ("Oh come on", "Fine, that one's real") — not alternating monologues.
- [ ] At least one genuine interruption where a line audibly cuts the previous one off.
- [ ] Contractions everywhere; zero "he is not clutch"-style written grammar.
- [ ] Stats are spoken like a human ("damn near fifty percent"), not read ("49.8 field goal percentage").
- [ ] At least one concession and one callback to an earlier moment.
- [ ] Catchphrases ≤ 2–3 per host per episode, and none feel inserted.

**Delivery / sound**
- [ ] Energy visibly moves: the heated stretch sounds different from the wind-down.
- [ ] Laughs/sighs (if present) sound like reactions, not inserted sound effects.
- [ ] Turn-taking gaps feel irregular; nothing metronomic.
- [ ] Both hosts sit in the same "room" — no voice sounds like it was recorded elsewhere.
- [ ] No clicks/pops at line boundaries; no sudden loudness jumps between speakers.
- [ ] Intro/outro music (if used) crossfades with speech, never hard-cuts.

**Regression drill (when changing any pipeline setting)**
1. `npm run sample:ab` (add `--offline` if no TTS keys) → listen to
   `samples/before.mp3` vs `samples/after.mp3`.
2. Confirm the QA table printed for "AFTER" passes everything "BEFORE" fails
   (pause variety, room tone, LRA).
3. Only then run a full episode.
