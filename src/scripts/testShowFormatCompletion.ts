// Ten-format catalog completion tests. Run: npm run test:show-format-completion
//
// Proves every CANONICAL format works through registry -> cast validation ->
// prompt contract -> structural rules -> balance floors -> episode creation
// (cast rows + snapshot v3 with the canonical id), and that the deprecated
// aliases (solo_briefing, roundtable) resolve for historical data but never
// surface as new options. Embedded PostgreSQL; no LLM/TTS/network.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import {
  listShowFormats, getShowFormat, isGenerationReadyFormat, isDeprecatedFormatAlias,
  canonicalFormatId, validatePinnedCast, FORMAT_ALIASES, SHOW_FORMAT_REGISTRY_VERSION,
} from "../lib/formats/showFormatRegistry";
import { formatPromptPieces } from "../lib/formats/formatScriptPrompts";
import { checkFormatStructure, castBalanceGateMessage } from "../lib/formats/formatScriptValidation";
import { snapshotCastFor } from "../lib/services/episodeConfigurationSnapshot";
import type { AiHost } from "@prisma/client";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

const CANONICAL = [
  "solo_commentary", "two_host_debate", "sports_radio", "news_roundup", "host_and_expert",
  "three_person_panel", "interview", "documentary", "betting_desk", "rapid_fire",
];

const mkHostObj = (id: string, name: string, intensity: number): AiHost =>
  ({ id, name, slug: id, role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: intensity, ttsProvider: "stub", ttsVoiceId: "v" } as unknown as AiHost);
const HH = [mkHostObj("h1", "One", 9), mkHostObj("h2", "Two", 7), mkHostObj("h3", "Three", 5), mkHostObj("h4", "Four", 3)];

async function main() {
  console.log("\nTen-format catalog completion\n");

  await check("CORE: the registry contains EXACTLY the ten canonical formats, all generation-ready", () => {
    const ids = listShowFormats().map((f) => f.id).sort();
    assert(JSON.stringify(ids) === JSON.stringify([...CANONICAL].sort()), `catalog: ${ids.join(",")}`);
    for (const id of CANONICAL) {
      const f = getShowFormat(id)!;
      assert(isGenerationReadyFormat(id), `${id} ready`);
      assert(f.roles.length >= f.speakerMax, `${id} role per seat`);
      assert(f.description.length > 0 && f.pacing.length > 0 && f.useCase.length > 0, `${id} UI card fields`);
      assert(f.roles.filter((r) => r.required).length >= f.speakerMin || f.speakerMin === 1, `${id} required seats cover the minimum`);
    }
    assert(SHOW_FORMAT_REGISTRY_VERSION === 2, "registry version incremented");
    assert(getShowFormat("made_up") === null, "unknown formats fail closed");
  });

  await check("CORE: aliases resolve for history, never listed, canonicalized for new records", () => {
    assert(JSON.stringify(FORMAT_ALIASES) === JSON.stringify({ solo_briefing: "solo_commentary", roundtable: "three_person_panel" }), "alias map");
    for (const [alias, canonical] of Object.entries(FORMAT_ALIASES)) {
      assert(isDeprecatedFormatAlias(alias), `${alias} flagged deprecated`);
      assert(getShowFormat(alias)!.id === canonical, `${alias} -> ${canonical}`);
      assert(canonicalFormatId(alias) === canonical, "canonicalization");
      assert(!listShowFormats().some((f) => f.id === alias), `${alias} not listed`);
      assert(isGenerationReadyFormat(alias), `${alias} still resolves as ready (historical safety)`);
    }
    // snapshotCastFor STORES the canonical id even when given an alias:
    const snap = snapshotCastFor("roundtable", ["h1", "h2", "h3"]);
    assert(snap.formatId === "three_person_panel", "new snapshots store canonical");
    assert(snap.members.map((m) => m.role).join(",") === "moderator,panelist_one,panelist_two", "panel roles");
  });

  await check("per-format speaker bounds hold for all ten", () => {
    const bounds: Record<string, [number, number]> = {
      solo_commentary: [1, 1], two_host_debate: [2, 2], sports_radio: [2, 3], news_roundup: [1, 2],
      host_and_expert: [2, 2], three_person_panel: [3, 3], interview: [2, 2], documentary: [1, 4],
      betting_desk: [2, 3], rapid_fire: [2, 4],
    };
    for (const [id, [min, max]] of Object.entries(bounds)) {
      const f = getShowFormat(id)!;
      assert(f.speakerMin === min && f.speakerMax === max, `${id} bounds ${f.speakerMin}-${f.speakerMax}`);
      assert(validatePinnedCast(id, HH.slice(0, max).map((h) => h.id)).ok, `${id} max cast accepted`);
      assert(!validatePinnedCast(id, HH.slice(0, max + 1).map((h) => h.id)).ok || max === 4, `${id} over-cast rejected`);
    }
  });

  await check("CORE: every format has a DEDICATED prompt contract naming its chairs (no generic debate fallback)", () => {
    const expects: Record<string, RegExp> = {
      solo_commentary: /carries the WHOLE episode alone/,
      two_host_debate: /CHEMISTRY CONTRACT/,
      sports_radio: /SPORTS RADIO CONTRACT[\s\S]*NEVER reference callers/,
      news_roundup: /NEWS ROUNDUP CONTRACT[\s\S]*HEADLINE-FIRST/,
      host_and_expert: /HOST & EXPERT CONTRACT[\s\S]*SYNTHETIC SHOW CHARACTER/,
      three_person_panel: /PANEL CONTRACT[\s\S]*MODERATES/,
      interview: /INTERVIEW CONTRACT/,
      documentary: /DOCUMENTARY CONTRACT[\s\S]*QUOTES ARE RADIOACTIVE/,
      betting_desk: /BETTING DESK CONTRACT[\s\S]*NEVER invent lines, odds, prices/,
      rapid_fire: /RAPID FIRE CONTRACT[\s\S]*HARD CAP/,
    };
    for (const id of CANONICAL) {
      const f = getShowFormat(id)!;
      const pieces = formatPromptPieces(f, HH.slice(0, f.speakerMax));
      assert(expects[id].test(pieces.dynamicsContract), `${id} contract is format-specific`);
      assert(pieces.dynamicsContract.includes(HH[0].name), `${id} contract binds the actual cast`);
    }
  });

  await check("CORE: structural line rules are ENFORCED (rapid-fire cap, doc narrator open/close, expert outweighs host)", () => {
    const cast2 = HH.slice(0, 2).map((h) => ({ id: h.id, name: h.name }));
    const cast3 = HH.slice(0, 3).map((h) => ({ id: h.id, name: h.name }));
    const line = (hostId: string, text: string) => ({ speakerHostId: hostId, text });
    const long = "word ".repeat(60).trim();

    // rapid_fire: >1 oversized line fails; one outlier tolerated.
    const rf = getShowFormat("rapid_fire")!;
    assert(checkFormatStructure(rf, [line("h1", "Prompt?"), line("h2", "Short."), line("h1", "Scorecard.")], cast2) === null, "capped answers pass");
    assert(checkFormatStructure(rf, [line("h1", "Prompt?"), line("h2", long), line("h2", long), line("h1", "Done.")], cast2) !== null, "oversized rapid-fire answers rejected");

    // documentary: narrator must open AND close.
    const doc = getShowFormat("documentary")!;
    assert(checkFormatStructure(doc, [line("h1", "Chapter one."), line("h2", "Analysis."), line("h1", "Thesis resolved.")], cast3) === null, "narrator opens/closes passes");
    assert(checkFormatStructure(doc, [line("h2", "I open?"), line("h1", "narration"), line("h1", "close")], cast3) !== null, "non-narrator opening rejected");
    assert(checkFormatStructure(doc, [line("h1", "open"), line("h2", "I close?")], cast3) !== null, "non-narrator closing rejected");

    // host_and_expert: the expert must carry more material than the host.
    const he = getShowFormat("host_and_expert")!;
    assert(checkFormatStructure(he, [line("h1", "Why does this matter?"), line("h2", "Because of a long, substantive, evidence-grounded explanation covering the whole mechanism in detail.")], cast2) === null, "expert-heavy passes");
    assert(checkFormatStructure(he, [line("h1", "A very long host monologue that dominates the show entirely and leaves nothing for the expert to add."), line("h2", "Yes.")], cast2) !== null, "host-dominant rejected");

    // news_roundup: anchor opens and closes.
    const nr = getShowFormat("news_roundup")!;
    assert(checkFormatStructure(nr, [line("h2", "analyst opens?"), line("h1", "anchor")], cast2) !== null, "analyst opening rejected");

    // formats without rules: unaffected.
    assert(checkFormatStructure(getShowFormat("two_host_debate")!, [line("h2", "B first"), line("h1", "A")], cast2) === null, "debate has no structural open/close rule");
  });

  await check("balance floors: moderator protected, debate unchanged, optional chairs floor-free", () => {
    const panel = getShowFormat("three_person_panel")!;
    const seats = (a: number, b: number, c: number) => [
      { hostId: "h1", hostName: "One", seatIndex: 0, lineCount: a },
      { hostId: "h2", hostName: "Two", seatIndex: 1, lineCount: b },
      { hostId: "h3", hostName: "Three", seatIndex: 2, lineCount: c },
    ];
    assert(castBalanceGateMessage(panel, seats(10, 45, 45), 100) === null, "panel balanced");
    assert(castBalanceGateMessage(panel, seats(2, 49, 49), 100) !== null, "vanished moderator fails");
    const debate = getShowFormat("two_host_debate")!;
    assert(castBalanceGateMessage(debate, seats(80, 20, 0).slice(0, 2), 100) === null, "debate 80/20 still passes (historical floor)");
  });

  // ---- DB: creation writes canonical formats + cast rows for new formats ---
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-complete-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("complete");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/complete`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
  process.env.DATABASE_URL = dbUrl;
  const { resolveEpisodeCast } = await import("../lib/services/hostCasting");
  const { createEpisodeRecord } = await import("../lib/services/episodeService");
  const { savePodcastConfiguration, loadPodcastConfiguration } = await import("../lib/services/podcastConfiguration");
  const { db } = await import("../lib/db");

  try {
    const mk = (name: string, slug: string, i: number) =>
      db.aiHost.create({ data: { name, slug, role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: i, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } });
    const a = await mk("Alpha", "alpha", 9);
    const b = await mk("Bravo", "bravo", 7);
    const c = await mk("Charlie", "charlie", 5);
    const d = await mk("Delta", "delta", 3);
    const topic = await db.topicCandidate.create({ data: { title: "T", sport: "NFL", controversyScore: 1, starPowerScore: 1, bettingRelevanceScore: 1, recencyScore: 1, debateScore: 60, evidenceIds: [], status: "approved" } });

    await check("CORE: every canonical format creates an episode with correct cast rows + snapshot cast", async () => {
      const casts: Record<string, string[]> = {
        solo_commentary: [a.id],
        sports_radio: [a.id, b.id, c.id],
        news_roundup: [a.id, b.id],
        host_and_expert: [a.id, b.id],
        three_person_panel: [a.id, b.id, c.id],
        documentary: [a.id, b.id, c.id, d.id],
        betting_desk: [a.id, b.id, c.id],
        rapid_fire: [a.id, b.id, c.id, d.id],
      };
      for (const [formatId, hostIds] of Object.entries(casts)) {
        const format = getShowFormat(formatId)!;
        const resolved = await resolveEpisodeCast({ hostIds, formatId });
        assert(resolved.formatId === formatId, `${formatId} resolved canonical`);
        assert(resolved.members.length === hostIds.length, `${formatId} seats ${resolved.members.length}`);
        const res = await createEpisodeRecord(
          [{ ...topic, researchBrief: null } as never],
          {
            title: `E-${formatId}`, hostIds,
            configuration: {
              configurationSource: "standalone", podcastConfigurationVersion: null,
              configurationSnapshot: { version: 3, cast: snapshotCastFor(formatId, hostIds), source: "standalone", capturedAt: new Date().toISOString(), podcast: null, editorial: {}, production: {} } as never,
              configurationFingerprint: "f".repeat(64),
            },
          },
          [], db
        );
        const ep = await db.episode.findUnique({ where: { id: res.episodeId }, include: { castMembers: { orderBy: { orderIndex: "asc" } } } });
        assert(ep!.formatId === formatId, `${formatId} stamped`);
        assert(ep!.castMembers.length === hostIds.length, `${formatId} cast rows`);
        for (let seat = 0; seat < hostIds.length; seat++) {
          assert(ep!.castMembers[seat].role === format.roles[seat].id, `${formatId} seat ${seat} role ${ep!.castMembers[seat].role}`);
        }
      }
    });

    await check("panel minimum enforced: 2 active hosts cannot cast a three_person_panel", async () => {
      await db.aiHost.updateMany({ where: { id: { in: [c.id, d.id] } }, data: { isActive: false } });
      let threw = false;
      try { await resolveEpisodeCast({ hostIds: [], formatId: "three_person_panel" }); }
      catch (err) { threw = /at least 3/.test((err as Error).message); }
      assert(threw, "panel needs 3 active hosts");
      await db.aiHost.updateMany({ where: { id: { in: [c.id, d.id] } }, data: { isActive: true } });
    });

    await check("CORE: a config saved with a deprecated alias STORES the canonical id", async () => {
      const owner = await db.user.create({ data: { email: "o@x.test", passwordHash: "x" } });
      const pod = await db.podcast.create({ data: { name: "S", cadence: "one_time", slug: "s-show", ownerId: owner.id, editorialConfig: { create: {} }, productionConfig: { create: {} }, publishingConfig: { create: {} } } });
      const res = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: 1, canEdit: () => true,
        input: { identity: { name: "S", slug: "s-show" }, editorial: { format: "solo_briefing" }, production: { hostIds: [a.id] } },
      });
      assert(res.ok, JSON.stringify(res));
      const loaded = await loadPodcastConfiguration(db, pod.id);
      assert(loaded!.editorial.format === "solo_commentary", `stored canonical (got ${loaded!.editorial.format})`);
    });

    await check("historical alias episodes still resolve casts (no rewrite needed)", async () => {
      // An episode stamped with the OLD id (as pre-completion data would be):
      await db.$executeRawUnsafe(`INSERT INTO "Episode" ("id","title","slug","status","hostIds","audioMimeType","explicit","configurationSource","formatId","createdAt","updatedAt")
        VALUES ('ep-alias','Old','ep-alias','draft', ARRAY['${a.id}'], 'audio/mpeg', false, 'legacy', 'solo_briefing', now(), now())`);
      const resolved = await resolveEpisodeCast({ hostIds: [a.id], formatId: "solo_briefing" });
      assert(resolved.formatId === "solo_commentary" && resolved.members[0].role === "anchor", "alias cast resolves via canonical definition");
      const ep = await db.episode.findUnique({ where: { id: "ep-alias" } });
      assert(ep!.formatId === "solo_briefing", "historical record NOT rewritten");
    });

  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
