// Curate a DEEP, varied Epidemic Sound crate and freeze it to
// ingest-manifest.json (committed to the repo). Run this where the ES MCP is
// reachable (EPIDEMIC_SOUND_API_KEY in env). It selects tracks and captures
// metadata but downloads NOTHING — download URLs expire, so the companion
// ingest script (ingestEpidemicCrate.ts) resolves fresh URLs at run time on
// the server.
//
//   npm run curate:epidemic            # writes ./ingest-manifest.json
//
// The library rotates across episodes with a cooldown, so depth + spread is
// the whole point: thin selection => repetition. Targets: ~20 beds (spread
// across urgent/dark/neutral/upbeat/cinematic, varied BPM, instrumental),
// ~25 stingers (risers/whooshes/impacts/swipes), ~6 intros, ~6 outros,
// ~12 reaction SFX mapped to categories.

import * as dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import {
  EpidemicMcpClient,
  EpidemicRecording,
  EpidemicSoundEffect,
  recordingMoods,
  recordingTagNames,
  recordingArtist,
} from "../lib/epidemic/mcpClient";

const LICENSE = "Epidemic Sound — Pro commercial (via MCP)";

interface CrateEntry {
  esId: string;
  esType: "recording" | "soundEffect";
  stemType?: "FULL";
  kind: "theme_intro" | "theme_outro" | "stinger" | "bed" | "sfx";
  category: string | null;
  name: string;
  tags: string[];
  durationMs: number | null;
  artist?: string;
  bpm?: number | null;
  license: string;
  licenseNote: string;
  esTitle: string;
}

const uniq = (arr: string[]) => Array.from(new Set(arr.filter(Boolean)));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---- Bed families: energy label -> queries + bpm hint --------------------
const BED_FAMILIES: Array<{
  energy: string;
  perFamily: number;
  queries: Array<{ term: string; bpm?: { min?: number; max?: number } }>;
}> = [
  {
    energy: "urgent/driving",
    perFamily: 4,
    queries: [
      { term: "driving urgent sports action", bpm: { min: 120, max: 165 } },
      { term: "aggressive intense energy pulse", bpm: { min: 120, max: 170 } },
    ],
  },
  {
    energy: "dark/tense",
    perFamily: 4,
    queries: [
      { term: "dark tension suspense underscore", bpm: { min: 60, max: 110 } },
      { term: "ominous brooding gritty", bpm: { min: 70, max: 120 } },
    ],
  },
  {
    energy: "neutral/underscore",
    perFamily: 4,
    queries: [
      { term: "neutral underscore minimal background", bpm: { min: 85, max: 120 } },
      { term: "calm subtle talk bed", bpm: { min: 80, max: 115 } },
    ],
  },
  {
    energy: "upbeat",
    perFamily: 4,
    queries: [
      { term: "upbeat positive energetic bright", bpm: { min: 105, max: 140 } },
      { term: "feel good uplifting groove", bpm: { min: 100, max: 135 } },
    ],
  },
  {
    energy: "cinematic",
    perFamily: 4,
    queries: [
      { term: "cinematic epic orchestral build", bpm: { min: 70, max: 150 } },
      { term: "hybrid trailer tension triumphant", bpm: { min: 80, max: 150 } },
    ],
  },
];

// ---- Stinger queries (SFX catalog: short designed transitions) -----------
const STINGER_QUERIES: string[] = [
  "designed riser transition build",
  "whoosh transition swipe fast",
  "impact hit transition boom",
  "braam cinematic hit transition",
  "glitch tech transition stinger",
  "sub drop impact transition",
  "reverse riser swell transition",
];
const STINGER_TARGET = 25;
const STINGER_DUR = { min: 1200, max: 14000 };

// ---- Intro / outro queries (short punchy musical/branded elements) -------
const INTRO_QUERIES: string[] = [
  "sports broadcast open fanfare energetic",
  "energetic logo reveal impact upbeat",
  "brand ident stab bright punchy",
  "epic intro hit short triumphant",
  "drum hit logo reveal sports",
];
const OUTRO_QUERIES: string[] = [
  "triumphant ending fanfare short",
  "uplifting outro button positive",
  "sports victory sting short",
  "end logo positive stab bright",
  "warm conclusive outro short",
];
const THEME_DUR = { min: 2500, max: 16000 };
const INTRO_TARGET = 6;
const OUTRO_TARGET = 6;

// ---- Reaction SFX: category -> queries + duration ------------------------
const SFX_SPECS: Array<{
  category: string;
  target: number;
  dur: { min: number; max: number };
  queries: string[];
}> = [
  { category: "crowd", target: 3, dur: { min: 1500, max: 12000 }, queries: ["crowd cheer swell sport", "stadium crowd roar reaction", "crowd ooh gasp reaction"] },
  { category: "impact", target: 3, dur: { min: 400, max: 6000 }, queries: ["big impact hit boom", "cinematic slam impact", "deep sub boom hit"] },
  { category: "whoosh", target: 2, dur: { min: 250, max: 3500 }, queries: ["whoosh swipe fast", "quick swish transition"] },
  { category: "buzzer", target: 1, dur: { min: 400, max: 4500 }, queries: ["buzzer wrong answer game"] },
  { category: "airhorn", target: 1, dur: { min: 400, max: 5000 }, queries: ["air horn blast"] },
  { category: "rimshot", target: 1, dur: { min: 250, max: 3000 }, queries: ["rimshot drum joke sting"] },
  { category: "laugh", target: 1, dur: { min: 900, max: 6000 }, queries: ["audience laugh reaction"] },
];

async function main() {
  const client = new EpidemicMcpClient();
  await client.init();
  console.log("ES MCP session ready. Curating crate…\n");

  const entries: CrateEntry[] = [];
  const usedIds = new Set<string>();
  const usedTitleNorms = new Set<string>();
  const usedNames = new Set<string>();

  const makeName = (title: string): string => {
    let base = title.trim();
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base} (${n++})`;
    usedNames.add(name);
    return name;
  };

  const pushRecording = (rec: EpidemicRecording, kind: CrateEntry["kind"], energy: string) => {
    if (!rec?.id || usedIds.has(rec.id)) return false;
    const t = norm(rec.title);
    if (usedTitleNorms.has(t)) return false;
    usedIds.add(rec.id);
    usedTitleNorms.add(t);
    const moods = recordingMoods(rec);
    const artist = recordingArtist(rec);
    entries.push({
      esId: rec.id,
      esType: "recording",
      stemType: "FULL",
      kind,
      category: null,
      name: makeName(rec.title),
      tags: uniq([
        rec.bpm ? `bpm:${rec.bpm}` : "",
        ...moods,
        ...recordingTagNames(rec),
        `energy:${energy}`,
      ]),
      durationMs: rec.audioFile?.durationInMilliseconds ?? null,
      artist,
      bpm: rec.bpm ?? null,
      license: LICENSE,
      licenseNote: `ES id ${rec.id}, artist ${artist}`,
      esTitle: rec.title,
    });
    return true;
  };

  const pushSfx = (
    se: EpidemicSoundEffect,
    kind: CrateEntry["kind"],
    category: string | null,
    extraTags: string[]
  ) => {
    if (!se?.id || usedIds.has(se.id)) return false;
    const t = norm(se.title);
    if (usedTitleNorms.has(t)) return false;
    usedIds.add(se.id);
    usedTitleNorms.add(t);
    entries.push({
      esId: se.id,
      esType: "soundEffect",
      kind,
      category,
      name: makeName(se.title),
      tags: uniq([...(se.tags || []).map((x) => x.displayName), ...extraTags]),
      durationMs: se.audioFile?.durationInMilliseconds ?? null,
      license: LICENSE,
      licenseNote: `ES id ${se.id}`,
      esTitle: se.title,
    });
    return true;
  };

  // ---- Beds -------------------------------------------------------------
  for (const fam of BED_FAMILIES) {
    let picked = 0;
    const artistsInFamily = new Set<string>();
    // First pass: enforce artist spread. Second pass: fill regardless.
    for (const pass of [0, 1]) {
      for (const q of fam.queries) {
        if (picked >= fam.perFamily) break;
        const recs = await client.searchRecordings({
          term: q.term,
          first: 12,
          vocals: false,
          bpm: q.bpm,
          duration: { min: 80000, max: 240000 },
          sortBy: "RELEVANCE",
        });
        for (const rec of recs) {
          if (picked >= fam.perFamily) break;
          if (usedIds.has(rec.id)) continue;
          const artist = recordingArtist(rec);
          if (pass === 0 && artistsInFamily.has(artist)) continue;
          if (pushRecording(rec, "bed", fam.energy)) {
            artistsInFamily.add(artist);
            picked++;
          }
        }
      }
    }
    console.log(`beds[${fam.energy}]: ${picked}/${fam.perFamily}`);
  }

  // ---- Stingers ---------------------------------------------------------
  {
    let picked = 0;
    for (const pass of [0, 1]) {
      for (const term of STINGER_QUERIES) {
        if (picked >= STINGER_TARGET) break;
        const ses = await client.searchSoundEffects({ term, first: 10, duration: STINGER_DUR, sortBy: "RELEVANCE" });
        for (const se of ses) {
          if (picked >= STINGER_TARGET) break;
          if (pushSfx(se, "stinger", null, ["stinger", "transition"])) picked++;
        }
      }
      if (picked >= STINGER_TARGET) break;
    }
    console.log(`stingers: ${picked}/${STINGER_TARGET}`);
  }

  // ---- Intros / outros --------------------------------------------------
  const sourceThemes = async (queries: string[], kind: "theme_intro" | "theme_outro", target: number) => {
    let picked = 0;
    for (const term of queries) {
      if (picked >= target) break;
      const ses = await client.searchSoundEffects({ term, first: 8, duration: THEME_DUR, sortBy: "RELEVANCE" });
      for (const se of ses) {
        if (picked >= target) break;
        if (pushSfx(se, kind, null, [kind === "theme_intro" ? "intro" : "outro", "theme"])) picked++;
      }
    }
    // Fallback: short instrumental recordings if SFX under-filled.
    if (picked < target) {
      const recs = await client.searchRecordings({
        term: kind === "theme_intro" ? "energetic sports anthem short" : "triumphant ending short",
        first: 12,
        vocals: false,
        duration: { min: 3000, max: 20000 },
      });
      for (const rec of recs) {
        if (picked >= target) break;
        if (pushRecording(rec, kind, kind === "theme_intro" ? "intro" : "outro")) picked++;
      }
    }
    console.log(`${kind}: ${picked}/${target}`);
  };
  await sourceThemes(INTRO_QUERIES, "theme_intro", INTRO_TARGET);
  await sourceThemes(OUTRO_QUERIES, "theme_outro", OUTRO_TARGET);

  // ---- Reaction SFX -----------------------------------------------------
  for (const spec of SFX_SPECS) {
    let picked = 0;
    for (const term of spec.queries) {
      if (picked >= spec.target) break;
      const ses = await client.searchSoundEffects({ term, first: 8, duration: spec.dur, sortBy: "RELEVANCE" });
      for (const se of ses) {
        if (picked >= spec.target) break;
        if (pushSfx(se, "sfx", spec.category, [spec.category])) picked++;
      }
    }
    console.log(`sfx[${spec.category}]: ${picked}/${spec.target}`);
  }

  // ---- Write manifest ---------------------------------------------------
  const byKind: Record<string, number> = {};
  for (const e of entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  const out = path.join(process.cwd(), "ingest-manifest.json");
  fs.writeFileSync(out, JSON.stringify(entries, null, 2));
  console.log(`\nWrote ${entries.length} entries -> ${out}`);
  console.log("by kind:", JSON.stringify(byKind));
  const sfxByCat: Record<string, number> = {};
  for (const e of entries) if (e.kind === "sfx") sfxByCat[e.category || "?"] = (sfxByCat[e.category || "?"] || 0) + 1;
  console.log("sfx by category:", JSON.stringify(sfxByCat));
}

main().catch((e) => {
  console.error("CURATION ERROR:", e?.message || e);
  process.exit(1);
});
