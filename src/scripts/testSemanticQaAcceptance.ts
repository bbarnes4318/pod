// FULL semantic-QA acceptance contract.
//
// The earlier four-line Fish/Deepgram run proved the Deepgram backend WORKS.
// It did not prove speaker-aware acceptance, because it used ONE voice — so
// diarization had nothing to separate and speaker attribution was vacuous.
//
// This file is the real contract. It has two halves:
//
//   DETERMINISTIC (always runs, in CI, no credentials)
//     Feeds doctored transcripts into the real `evaluateDiarizedTranscript` and
//     asserts each NEGATIVE CONTROL fails. These are the controls that make a
//     "pass" mean something: if a swapped speaker, a changed name, or a changed
//     number can slip through, the gate is decorative.
//
//   LIVE (runs only when two distinct voices and a transcript provider are set)
//     Renders both speakers with DIFFERENT voices, masters them, transcribes
//     through the live provider, and asserts a real pass on the real audio.
//
// Run:  npm run test:semantic-qa-acceptance
// Live: additionally set LIVE_QA_VOICE_A, LIVE_QA_VOICE_B, DEEPGRAM_API_KEY.
//
// NOTHING here weakens a threshold to manufacture a pass, and the persisted
// report never contains a credential.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluateDiarizedTranscript,
  resolveSemanticQaRequirement,
  type ExpectedSpokenLine,
  type DiarizedSegment,
} from "../lib/audio/audioSemanticQa";

const OUT = path.resolve(process.cwd(), "artifacts/live-quality-evidence");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

// Two speakers, alternating, carrying names AND numbers — the two fact classes
// semantic QA exists to protect.
const HOST_A = "a";
const HOST_B = "b";
export const ACCEPTANCE_LINES: ExpectedSpokenLine[] = [
  { lineIndex: 0, speakerHostId: HOST_A, speakerName: "Zabala", text: "The American League won four to nothing, and the National League managed exactly three hits." },
  { lineIndex: 1, speakerHostId: HOST_B, speakerName: "Mercer", text: "Dylan Cease started that shutout and threw twelve pitches before the bullpen took over." },
  { lineIndex: 2, speakerHostId: HOST_A, speakerName: "Zabala", text: "Mike Trout got the loudest ovation of the night in Philadelphia." },
  { lineIndex: 3, speakerHostId: HOST_B, speakerName: "Mercer", text: "Fifteen strikeouts in nine innings ties the record set back in two thousand twelve." },
];

const seg = (speaker: string, text: string, start = 0, end = 1): DiarizedSegment => ({ speaker, text, start, end });

/** The transcript a CORRECT two-voice render produces (digits are the ASR's own
 *  smart formatting, which the number normalizer treats as equivalent). */
function correctSegments(): DiarizedSegment[] {
  return [
    seg("speaker_0", "The American League won four to nothing, and the National League managed exactly three hits.", 0, 6),
    seg("speaker_1", "Dylan Cease started that shutout and threw 12 pitches before the bullpen took over.", 6, 12),
    seg("speaker_0", "Mike Trout got the loudest ovation of the night in Philadelphia.", 12, 17),
    seg("speaker_1", "15 strikeouts in nine innings ties the record set back in 2012.", 17, 23),
  ];
}

async function main() {
  console.log("\nSemantic QA acceptance contract\n");
  console.log("  -- positive control --");

  await check("a correct two-speaker render PASSES", () => {
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, correctSegments());
    assert.equal(r.status, "pass", `expected pass, got: ${r.failures.join(" | ")}`);
    assert.ok((r.speakerAttributionErrorRate ?? 1) <= 0.08, `attribution should be clean, got ${r.speakerAttributionErrorRate}`);
    assert.ok((r.lineOrderErrorRate ?? 1) <= 0.12, `order should be clean, got ${r.lineOrderErrorRate}`);
  });

  await check("both speakers are distinguished and mapped to the right hosts", () => {
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, correctSegments());
    const mapped = new Set(Object.values(r.speakerMap));
    assert.equal(mapped.size, 2, `expected two distinct hosts in the speaker map, got ${JSON.stringify(r.speakerMap)}`);
    assert.ok(mapped.has(HOST_A) && mapped.has(HOST_B), `both hosts must be present: ${JSON.stringify(r.speakerMap)}`);
  });

  console.log("  -- negative controls (each MUST fail) --");

  // DOCUMENTED LIMIT, asserted rather than hidden.
  //
  // Diarization labels are ANONYMOUS: "speaker_0"/"speaker_1" carry no identity.
  // Relabelling every segment is therefore the same transcript, and no
  // transcript-only check can distinguish it from correct output — the aligner
  // simply maps the labels the other way round. A GLOBAL swap is invisible here
  // BY CONSTRUCTION, and a test that claimed otherwise would be testing nothing.
  //
  // What that means in practice: this gate catches a wrong voice on SOME lines,
  // not every voice being wrong. The "every line rendered with the wrong voice"
  // case is caught upstream instead, where the per-line voice id is checked
  // against the episode cast before synthesis — see voiceResolution — because
  // that is where the identity actually exists.
  await check("a GLOBAL relabel is normalized, and the limit is explicit", () => {
    const swapped = correctSegments().map((s) =>
      seg(s.speaker === "speaker_0" ? "speaker_1" : "speaker_0", s.text, s.start, s.end)
    );
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, swapped);
    assert.equal(r.status, "pass", "a pure relabel is the same transcript and must not be reported as a content fault");
    // ...and it is normalized to the correct hosts, not left dangling.
    assert.equal(r.speakerMap["speaker_1"], HOST_A);
    assert.equal(r.speakerMap["speaker_0"], HOST_B);
  });

  await check("a PARTIAL speaker swap fails (one line on the wrong mouth)", () => {
    const s = correctSegments();
    s[1] = seg("speaker_0", s[1].text, s[1].start, s[1].end);
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, s);
    assert.equal(r.status, "fail", `one misattributed line must fail; failures=${r.failures.join(" | ")}`);
  });

  await check("a CHANGED NAME fails", () => {
    const s = correctSegments();
    s[2] = seg("speaker_0", "Mike Trask got the loudest ovation of the night in Philadelphia.", 12, 17);
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, s);
    assert.equal(r.status, "fail", "a substituted proper name must fail");
    assert.ok(r.failures.some((f) => /trout/i.test(f)), `the failure must name the missing word: ${r.failures.join(" | ")}`);
  });

  await check("a CHANGED NUMBER fails", () => {
    const s = correctSegments();
    s[3] = seg("speaker_1", "9 strikeouts in nine innings ties the record set back in 2012.", 17, 23);
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, s);
    assert.equal(r.status, "fail", "a substituted figure must fail");
    assert.ok(r.failures.some((f) => /15|figure/i.test(f)), `the failure must name the missing figure: ${r.failures.join(" | ")}`);
  });

  await check("a DROPPED LINE fails", () => {
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, correctSegments().filter((_, i) => i !== 2));
    assert.equal(r.status, "fail", "a missing line must fail");
  });

  await check("OUT-OF-ORDER delivery fails", () => {
    const s = correctSegments();
    const reordered = [s[0], s[2], s[1], s[3]];
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, reordered);
    assert.equal(r.status, "fail", `reordered speakers must fail; orderRate=${r.lineOrderErrorRate}`);
  });

  await check("HALLUCINATED speech fails", () => {
    const s = correctSegments();
    s.push(seg("speaker_0", "And that is why the commissioner resigned on Tuesday morning.", 23, 29));
    const r = evaluateDiarizedTranscript(ACCEPTANCE_LINES, s);
    assert.equal(r.status, "fail", "speech that was never authored must fail");
  });

  // --- LIVE half -----------------------------------------------------------
  const voiceA = (process.env.LIVE_QA_VOICE_A || "").trim();
  const voiceB = (process.env.LIVE_QA_VOICE_B || "").trim();
  const req = resolveSemanticQaRequirement({
    ...process.env,
    TTS_TRANSCRIPT_QA_ENABLED: "true",
  } as NodeJS.ProcessEnv);

  console.log("  -- live two-voice acceptance --");
  if (!voiceA || !voiceB || voiceA === voiceB || req.missing.length || !process.env.FISH_API_KEY) {
    const why = [
      !voiceA || !voiceB ? "LIVE_QA_VOICE_A / LIVE_QA_VOICE_B are not both set" : null,
      voiceA && voiceA === voiceB ? "the two voice ids are identical (a one-voice scene cannot test attribution)" : null,
      req.missing.length ? `missing: ${req.missing.join(", ")}` : null,
      !process.env.FISH_API_KEY ? "FISH_API_KEY is not set" : null,
    ].filter(Boolean);
    console.log(`  skip live two-voice acceptance — ${why.join("; ")}`);
    console.log("       This is NOT a pass. Full live semantic acceptance is unproven until this half runs.");
  } else {
    await check("live: two distinct voices, both speakers, real transcription", async () => {
      const { FishTTSProvider } = await import("../lib/providers/tts/fish");
      const { runAudioSemanticQa } = await import("../lib/audio/audioSemanticQa");
      process.env.TTS_TRANSCRIPT_QA_ENABLED = "true";
      fs.mkdirSync(OUT, { recursive: true });
      const fish = new FishTTSProvider();
      const parts: string[] = [];
      for (const line of ACCEPTANCE_LINES) {
        const res = await fish.synthesizeSpeech({
          text: line.text,
          voiceId: line.speakerHostId === HOST_A ? voiceA : voiceB,
          format: "mp3",
        } as Parameters<typeof fish.synthesizeSpeech>[0]);
        const f = path.join(OUT, `acceptance-${line.lineIndex}.mp3`);
        fs.writeFileSync(f, (res as { audioBuffer: Buffer }).audioBuffer);
        parts.push(f);
      }
      const listFile = path.join(OUT, "acceptance-concat.txt");
      fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
      const master = path.join(OUT, "semantic-qa-acceptance.mp3");
      const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg",
        ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", master],
        { encoding: "utf8" });
      assert.equal(r.status, 0, `ffmpeg concat failed: ${String(r.stderr).slice(-300)}`);

      const report = await runAudioSemanticQa({
        audio: fs.readFileSync(master),
        mimeType: "audio/mpeg",
        expected: ACCEPTANCE_LINES,
      });
      // The report is persisted WITHOUT any credential — only names and metrics.
      fs.writeFileSync(
        path.join(OUT, "semantic-qa-acceptance-report.json"),
        JSON.stringify({ ranAt: new Date().toISOString(), published: false, provider: report.provider, model: report.model, metrics: {
          wordErrorRate: report.wordErrorRate,
          speakerAttributionErrorRate: report.speakerAttributionErrorRate,
          criticalTokenMissRate: report.criticalTokenMissRate,
          lineOrderErrorRate: report.lineOrderErrorRate,
        }, status: report.status, failures: report.failures, warnings: report.warnings, speakerMap: report.speakerMap }, null, 2)
      );
      const serialized = fs.readFileSync(path.join(OUT, "semantic-qa-acceptance-report.json"), "utf8");
      for (const secret of [process.env.DEEPGRAM_API_KEY, process.env.FISH_API_KEY]) {
        if (secret) assert.ok(!serialized.includes(secret), "the persisted report must never contain a credential");
      }

      assert.notEqual(report.status, "not_run", "live acceptance requires the provider to actually run");
      assert.equal(Object.keys(report.speakerMap).length, 2, `two voices must diarize to two speakers, got ${JSON.stringify(report.speakerMap)}`);
      assert.equal(report.status, "pass", `live two-voice render must pass: ${report.failures.join(" | ")}`);
    });
  }

  console.log(failed === 0 ? "\nAll semantic QA acceptance checks passed.\n" : `\n${failed} check(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
