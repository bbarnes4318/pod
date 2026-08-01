// Long-form blind host-voice audition.
//
// AUDITION_VOICE_CANDIDATES_JSON='[{"label":"fish-a","provider":"fish","voiceId":"..."},...]' npm run audition:voices
//
// Each voice performs the SAME eight-section, multi-minute fixture. Output
// filenames are opaque; manifest.json unblinds only after ratings are locked.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getTTSProvider } from "../lib/providers/tts/factory";
import { runFfmpeg, masterToMp3, getFileDurationMs } from "../lib/audio/assembly";

interface Candidate { label: string; provider: string; voiceId: string; direction?: string }
const FIXTURE = [
  { id: "cold-accusation", tone: "incredulous", energy: "high" as const, text: "You keep calling that patience. It wasn't patience. It was a room full of people waiting for somebody else to own the decision. And now the easiest person to blame is the one who never controlled the budget. So answer the uncomfortable part: if everyone knew the plan was failing, who benefited from letting it fail one more week?" },
  { id: "amused-disbelief", tone: "amused", energy: "medium" as const, text: "Oh, that's beautiful. The same front office that spent all summer telling us chemistry cannot be measured would now like chemistry entered into evidence. Convenient. Very convenient. I almost admire it — almost — because you need real nerve to sell the cure after you helped manufacture the disease." },
  { id: "interruption", tone: "heated", energy: "high" as const, text: "No, stop. You're skipping the choice that made everything after it inevitable. They did not wake up trapped. They built the trap, tested the door, and climbed inside anyway. You don't get to call the consequences surprising just because the press release arrived late." },
  { id: "restrained-concession", tone: "conceding", energy: "low" as const, text: "All right. That part lands. I still think you're making motive do too much work, but the timeline does not help me here. If they knew the downside and accepted it anyway, then yes — I have to move. Not all the way. Do not look so pleased. But I have to move." },
  { id: "factual-explanation", tone: "analytical", energy: "medium" as const, text: "Here is the sequence without the slogans. The first decision narrowed their options. The second made retreat expensive. By the third, every public explanation protected the earlier choice, so the organization was no longer deciding what worked. It was deciding which admission hurt least. That distinction is why the final move looked sudden even though the pressure had been building for months." },
  { id: "genuine-anger", tone: "heated", energy: "high" as const, text: "What bothers me is not that they got it wrong. People get things wrong. It is that they pushed the cost downward. The people with the least power carried the public blame while the people who designed the system called themselves disappointed. That is not accountability. That is hierarchy wearing an accountability costume." },
  { id: "quiet-kill-shot", tone: "dismissive", energy: "low" as const, text: "If the plan only makes sense after you remove the people who approved it, then the plan never made sense. It merely had protection." },
  { id: "closing-reflection", tone: "reflective", energy: "low" as const, text: "Maybe that is the part worth keeping. The loudest decision is rarely the first one. By the time everybody sees the break, the real choice may be weeks behind them — a private compromise, a warning ignored, a person protected. Tomorrow's headline will tell us what happened. It may take much longer to understand who made it possible." },
];

function candidates(): Candidate[] {
  const parsed = JSON.parse(process.env.AUDITION_VOICE_CANDIDATES_JSON || "[]") as Candidate[];
  if (!Array.isArray(parsed) || parsed.length < 2) throw new Error("AUDITION_VOICE_CANDIDATES_JSON must contain at least two voices.");
  for (const c of parsed) if (!c.label || !c.provider || !c.voiceId) throw new Error("Every audition candidate needs label, provider and voiceId.");
  return parsed;
}

async function main() {
  const out = path.resolve(process.cwd(), "voice-audition-output");
  const blind = path.join(out, "blind");
  const temp = path.join(out, "tmp");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(blind, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const manifest: unknown[] = [];
  const rows = ["blind_code,character_fit,identity_consistency,listener_fatigue,spontaneity,intelligibility,emotional_range,interruption_quality,whole_episode_willingness,notes"];

  for (const candidate of candidates()) {
    const code = crypto.createHash("sha256").update(`voice-audition-v1:${candidate.label}`).digest("hex").slice(0, 8).toUpperCase();
    const provider = getTTSProvider(candidate.provider);
    const clips: string[] = [];
    const started = Date.now();
    for (let i = 0; i < FIXTURE.length; i++) {
      const scene = FIXTURE[i];
      const result = await provider.synthesizeSpeech({
        text: scene.text,
        voiceId: candidate.voiceId,
        speakerName: "Host",
        tone: scene.tone,
        energy: scene.energy,
        voiceDirection: candidate.direction || "Distinct long-form podcast host; responsive, spontaneous, intelligible, never commercial-announcer cadence.",
        previousText: i ? FIXTURE[i - 1].text : undefined,
        nextText: i + 1 < FIXTURE.length ? FIXTURE[i + 1].text : undefined,
        format: "mp3",
      });
      const clip = path.join(temp, `${code}-${i}.mp3`);
      fs.writeFileSync(clip, result.audioBuffer);
      clips.push(clip);
    }
    const concatFile = path.join(temp, `${code}.txt`);
    fs.writeFileSync(concatFile, clips.map((clip) => `file '${clip.replace(/'/g, "'\\''")}'`).join("\n"));
    const joined = path.join(temp, `${code}-joined.mp3`);
    await runFfmpeg(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", "-b:a", "192k", joined]);
    const blindFile = path.join(blind, `${code}.mp3`);
    await masterToMp3(process.env.FFMPEG_PATH || "ffmpeg", joined, blindFile, { targetLufs: -16, bitrate: "192k" });
    manifest.push({ blindCode: code, ...candidate, durationMs: await getFileDurationMs(process.env.FFPROBE_PATH || "ffprobe", blindFile), generationMs: Date.now() - started, fixture: FIXTURE.map((s) => s.id) });
    rows.push(`${code},,,,,,,,,`);
    console.log(`Generated blind voice ${code}`);
  }
  fs.writeFileSync(path.join(out, "ratings.csv"), rows.join("\n"));
  fs.writeFileSync(path.join(out, "LISTEN_FIRST.md"), `# Blind long-form voice audition\n\nListen to every file in \`blind/\` end to end, in randomized order, before opening \`manifest.json\`. Rate the CSV independently. Reject any voice that is impressive for ten seconds but tiring by the closing reflection.\n`);
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ fixtureVersion: 1, warning: "Open only after ratings are locked.", candidates: manifest }, null, 2));
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch((error) => { console.error(error); process.exit(1); });
