// Auto social clips — a short vertical (9:16) captioned promo cut of an
// episode's spiciest exchange.
//
// SELECTION reuses the REAL transcript tone/energy (Script.content lines) + the
// REAL per-line AudioSegment durations to find (or accept) a 20–45s run.
//
// RENDER reuses the REAL audio path: each selected line's stored AudioSegment
// audio is standardized and mixed through the SAME functions the full-episode
// stitch uses — planConversationTimeline → renderTimelineToWav → masterToMp3 —
// so the clip is genuine episode audio, never mock. Captions are host-colour
// coded (slot 0 = --host-max, slot 1 = --host-doc) and time-synced to those
// exact clip offsets. A 9:16 H.264 mp4 with burned-in captions is attempted via
// ffmpeg's libass + libx264; if the deploy ffmpeg lacks them we fall back to the
// mp3 + a WebVTT caption track and record kind = "audio+captions".

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { resolveEpisodeHosts } from "@/lib/services/hostCasting";
import {
  standardizeClipToWav,
  planConversationTimeline,
  renderTimelineToWav,
  masterToMp3,
  type PlannedLine,
} from "@/lib/audio/assembly";

const CLIP_MIN_MS = 20_000;
const CLIP_MAX_MS = 45_000;
// Host slot colours mirror the Step 1 tokens (--host-max / --host-doc).
const SLOT_HEX = ["#FF5A1F", "#4C8DFF"] as const; // slot 0 orange, slot 1 blue

interface FlatLine {
  lineIndex: number;
  text: string;
  speakerName: string;
  speakerHostId: string | null;
  tone: string | null;
  energy: string | null;
  isInterruption: boolean;
  pauseBefore?: string;
  segmentBreak?: string;
  durationMs: number;
  audioUrl: string | null;
  hasAudio: boolean;
}

/** Flatten Script.content lines joined with their AudioSegment audio + timing. */
async function flattenLines(scriptId: string): Promise<FlatLine[]> {
  const script = await db.script.findUnique({ where: { id: scriptId }, select: { content: true } });
  const content = (script?.content as any) || {};
  const segments: any[] = Array.isArray(content.segments) ? content.segments : [];
  const segRows = await db.audioSegment.findMany({
    where: { scriptId },
    select: { lineIndex: true, status: true, audioUrl: true, durationMs: true },
  });
  const byLine = new Map(segRows.map((s) => [s.lineIndex, s]));

  const out: FlatLine[] = [];
  segments.forEach((seg: any, segIdx: number) => {
    (seg?.lines || []).forEach((ln: any, li: number) => {
      const seg0 = byLine.get(ln.lineIndex);
      const hasAudio = !!seg0 && seg0.status === "ready" && !!seg0.audioUrl;
      out.push({
        lineIndex: ln.lineIndex,
        text: String(ln.text || ""),
        speakerName: String(ln.speakerName || ""),
        speakerHostId: ln.speakerHostId ?? null,
        tone: ln.tone ?? null,
        energy: ln.energy ?? null,
        isInterruption: ln.isInterruption === true,
        pauseBefore: ln.pauseBefore,
        // Reset the segment gap on the first line of a segment (except the very
        // first line) so the clip doesn't open with a dead pause.
        segmentBreak: li === 0 && segIdx > 0 ? (seg?.type === "topic" ? "topic" : "segment") : "none",
        durationMs: seg0?.durationMs ?? Math.max(900, Math.round((String(ln.text || "").split(/\s+/).filter(Boolean).length / 2.6) * 1000)),
        audioUrl: seg0?.audioUrl ?? null,
        hasAudio,
      });
    });
  });
  return out.sort((a, b) => a.lineIndex - b.lineIndex);
}

/** Heat score for a line from its REAL tone + energy metadata. */
function heat(line: FlatLine): number {
  const e = line.energy === "high" ? 3 : line.energy === "medium" ? 1.5 : line.energy === "low" ? 0.5 : 1;
  const t = line.tone || "";
  const toneBonus = ["heated", "incredulous", "dismissive", "excited"].includes(t)
    ? 2
    : ["sarcastic", "amused"].includes(t)
      ? 1
      : 0;
  const interruptBonus = line.isInterruption ? 0.5 : 0;
  return e + toneBonus + interruptBonus;
}

/**
 * Auto-pick the hottest 20–45s contiguous run of VOICED lines by summed heat.
 * Returns null when the episode has no voiced audio to clip.
 */
export async function selectHottestRange(
  scriptId: string
): Promise<{ startLineIndex: number; endLineIndex: number } | null> {
  const lines = (await flattenLines(scriptId)).filter((l) => l.hasAudio);
  if (lines.length === 0) return null;

  let best: { i: number; j: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    let dur = 0;
    let score = 0;
    for (let j = i; j < lines.length; j++) {
      dur += lines[j].durationMs;
      score += heat(lines[j]);
      if (dur > CLIP_MAX_MS) break;
      if (dur >= CLIP_MIN_MS && (!best || score > best.score)) {
        best = { i, j, score };
      }
    }
  }
  // Episode shorter than the minimum window: take the hottest single line and
  // grow up to the max — always return SOMETHING voiced.
  if (!best) {
    let i = 0;
    for (let k = 1; k < lines.length; k++) if (heat(lines[k]) > heat(lines[i])) i = k;
    let dur = 0;
    let j = i;
    while (j < lines.length && dur + lines[j].durationMs <= CLIP_MAX_MS) {
      dur += lines[j].durationMs;
      j++;
    }
    best = { i, j: Math.max(i, j - 1), score: 0 };
  }
  return { startLineIndex: lines[best.i].lineIndex, endLineIndex: lines[best.j].lineIndex };
}

/* ---------- ffmpeg helpers (video step needs a cwd for the ass filter) ------- */
function ffmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}
function runFfmpegInDir(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { cwd });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (out += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out.slice(-2000)))));
    proc.on("error", (err) => reject(err));
  });
}

function assTime(ms: number): string {
  const cs = Math.round(ms / 10);
  const c = cs % 100;
  const s = Math.floor(cs / 100) % 60;
  const m = Math.floor(cs / 6000) % 60;
  const h = Math.floor(cs / 360000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
function vttTime(ms: number): string {
  const t = Math.max(0, ms);
  const msPart = t % 1000;
  const s = Math.floor(t / 1000) % 60;
  const m = Math.floor(t / 60000) % 60;
  const h = Math.floor(t / 3600000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(msPart).padStart(3, "0")}`;
}
/** #RRGGBB → ASS &HAABBGGRR (alpha 00 = opaque). */
function hexToAss(hex: string): string {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
function assEscape(text: string): string {
  return text.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();
}

interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string;
  slot: 0 | 1;
}

function buildAss(cues: CaptionCue[], title: string): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Caption style: big, bold, centred lower third, heavy outline for legibility.
    "Style: Cap,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,4,2,2,80,80,320,1",
    // Title style: small, top, muted.
    "Style: Title,Arial,40,&H00C8C8C8,&H00C8C8C8,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,3,1,8,60,60,120,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  const end = cues.length ? cues[cues.length - 1].endMs : 0;
  // Persistent branding header across the whole clip.
  events.push(`Dialogue: 0,${assTime(0)},${assTime(end)},Title,,0,0,0,,${assEscape(title).slice(0, 60)}`);
  for (const c of cues) {
    const color = hexToAss(SLOT_HEX[c.slot]);
    const speaker = assEscape(c.speaker).toUpperCase();
    const body = assEscape(c.text);
    events.push(
      `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs)},Cap,,0,0,0,,{\\c${color}\\b1}${speaker}:  {\\c&H00FFFFFF&\\b0}${body}`
    );
  }
  return [...header, ...events].join("\n") + "\n";
}

function buildVtt(cues: CaptionCue[]): string {
  const out = ["WEBVTT", ""];
  for (const c of cues) {
    out.push(`${vttTime(c.startMs)} --> ${vttTime(c.endMs)}`);
    out.push(`<v ${c.speaker}>${c.speaker}: ${c.text.replace(/\r?\n/g, " ").trim()}`);
    out.push("");
  }
  return out.join("\n");
}

export interface RenderClipResult {
  kind: "video" | "audio+captions";
  audioUrl: string;
  videoUrl: string | null;
  captionsUrl: string;
  durationMs: number;
}

/**
 * Render the SocialClip row `clipId`. Downloads the real per-line audio for the
 * pinned range, mixes it via the real stitch functions, builds host-coloured
 * captions, and attempts a 9:16 mp4 (falls back to mp3 + vtt). Writes results
 * back onto the row.
 */
export async function renderSocialClip(clipId: string): Promise<RenderClipResult> {
  const clip = await db.socialClip.findUnique({ where: { id: clipId } });
  if (!clip) throw new Error(`SocialClip ${clipId} not found.`);
  await db.socialClip.update({ where: { id: clipId }, data: { status: "rendering", error: null } });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `clip-${clipId.slice(0, 8)}-`));
  const storage = getStorageProvider();
  try {
    const episode = await db.episode.findUnique({
      where: { id: clip.episodeId },
      select: { id: true, title: true, hostIds: true },
    });
    if (!episode) throw new Error("Episode not found.");
    const { hostA, hostB } = await resolveEpisodeHosts({ hostIds: episode.hostIds });

    const all = await flattenLines(clip.scriptId);
    const range = all.filter(
      (l) => l.lineIndex >= clip.startLineIndex && l.lineIndex <= clip.endLineIndex && l.hasAudio && l.audioUrl
    );
    if (range.length === 0) {
      throw new Error("No voiced lines in the selected range — voice the episode before clipping.");
    }

    // 1. Download + standardize each line's real audio.
    const planned: PlannedLine[] = [];
    const slotByLine = new Map<number, 0 | 1>();
    for (let i = 0; i < range.length; i++) {
      const ln = range[i];
      const dl = await storage.getObject({ url: ln.audioUrl! });
      const rawPath = path.join(tmp, `line-${ln.lineIndex}.mp3`);
      fs.writeFileSync(rawPath, dl.body);
      const wavPath = path.join(tmp, `line-${ln.lineIndex}.wav`);
      await standardizeClipToWav(ffmpegPath(), rawPath, wavPath, {});
      const slot: 0 | 1 = ln.speakerHostId && ln.speakerHostId === hostA.id ? 0 : ln.speakerHostId === hostB.id ? 1 : 0;
      slotByLine.set(ln.lineIndex, slot);
      planned.push({
        filePath: wavPath,
        durationMs: ln.durationMs,
        lineIndex: ln.lineIndex,
        hostSlot: slot,
        pauseBefore: (ln.pauseBefore as any) || "beat",
        isInterruption: i > 0 && ln.isInterruption,
        segmentBreak: "none", // never open a clip mid-line with a big gap
      });
    }

    // 2. Real stitch path: plan → mix → master. Same functions as the episode.
    const clips = planConversationTimeline(planned, {});
    const mixWav = path.join(tmp, "clip-mix.wav");
    await renderTimelineToWav(ffmpegPath(), clips, mixWav, {});
    const clipMp3 = path.join(tmp, "clip.mp3");
    await masterToMp3(ffmpegPath(), mixWav, clipMp3, {});

    // 3. Caption cues from the EXACT clip offsets the mix used.
    const cues: CaptionCue[] = clips.map((c) => {
      const ln = range.find((r) => r.lineIndex === planned.find((p) => p.filePath === c.filePath)?.lineIndex);
      const slot = slotByLine.get(ln?.lineIndex ?? -1) ?? 0;
      const speaker = slot === 0 ? hostA.name : hostB.name;
      return { startMs: c.startMs, endMs: c.startMs + c.durationMs, text: ln?.text || "", speaker, slot };
    });
    const durationMs = clips.length ? Math.max(...clips.map((c) => c.startMs + c.durationMs)) : 0;

    const title = episode.title || "Take Machine";
    const vtt = buildVtt(cues);
    const ass = buildAss(cues, title);
    fs.writeFileSync(path.join(tmp, "captions.ass"), ass, "utf8");

    // 4. Attempt a real 9:16 mp4 with burned-in host-coloured captions.
    let videoBuf: Buffer | null = null;
    let videoError: string | null = null;
    try {
      const durSec = (durationMs / 1000 + 0.4).toFixed(2);
      await runFfmpegInDir(
        [
          "-y",
          "-f", "lavfi",
          "-i", `color=c=0x0B0B0F:s=1080x1920:r=30:d=${durSec}`,
          "-i", "clip.mp3",
          "-vf", "ass=captions.ass",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "192k",
          "-shortest",
          "clip.mp4",
        ],
        tmp
      );
      videoBuf = fs.readFileSync(path.join(tmp, "clip.mp4"));
    } catch (err: any) {
      // Honest fallback — the deploy ffmpeg likely lacks libx264/libass.
      videoError = err?.message ? String(err.message).slice(-300) : "video encode failed";
    }

    // 5. Store the real assets. Audio + captions always; video when produced.
    const base = `episodes/${clip.episodeId}/scripts/${clip.scriptId}/clips/${clipId}`;
    const audioUp = await storage.putObject({ key: `${base}.mp3`, body: fs.readFileSync(clipMp3), contentType: "audio/mpeg" });
    const capUp = await storage.putObject({ key: `${base}.vtt`, body: Buffer.from(vtt, "utf8"), contentType: "text/vtt" });
    let videoUrl: string | null = null;
    if (videoBuf) {
      const vUp = await storage.putObject({ key: `${base}.mp4`, body: videoBuf, contentType: "video/mp4" });
      videoUrl = vUp.url;
    }

    const kind: RenderClipResult["kind"] = videoUrl ? "video" : "audio+captions";
    await db.socialClip.update({
      where: { id: clipId },
      data: {
        status: "ready",
        kind,
        audioUrl: audioUp.url,
        videoUrl,
        captionsUrl: capUp.url,
        durationMs,
        error: videoUrl ? null : videoError ? `9:16 video unavailable on this ffmpeg (${videoError}). Shipped audio + captions.` : null,
      },
    });

    return { kind, audioUrl: audioUp.url, videoUrl, captionsUrl: capUp.url, durationMs };
  } catch (err: any) {
    await db.socialClip.update({
      where: { id: clipId },
      data: { status: "failed", error: err?.message ? String(err.message).slice(0, 500) : "Clip render failed." },
    });
    throw err;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}
