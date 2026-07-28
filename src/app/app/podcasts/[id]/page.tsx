import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { SEED_TEAMS } from "@/lib/data/teamSeed";
import { friendlyStage } from "../../lib";
import { WEEKDAY_LABELS } from "../config";
import PodcastWizard, { type WizardHost, type WizardTeam } from "../new/PodcastWizard";
import GenerateNowButton from "../GenerateNowButton";
import { requireUserPage } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";
import { decodeShowForgeState, defaultShowForgeState, storylineSequence } from "@/lib/shows/showForge";

export const dynamic = "force-dynamic";
const PRODUCED = new Set(["audio_ready", "content_generating", "content_ready", "publish_ready", "published"]);

export default async function ManagePodcastPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserPage(`/app/podcasts/${id}`);
  const podcast = await db.podcast.findUnique({
    where: { id },
    include: {
      editorialConfig: true,
      productionConfig: true,
      episodes: { orderBy: { createdAt: "desc" }, take: 30, select: { id: true, title: true, status: true, createdAt: true, audioUrl: true } },
    },
  }).catch(() => null);
  if (!podcast || !canViewOwned(user, podcast)) notFound();

  const [hostsRaw, teamsRaw] = await Promise.all([
    db.aiHost.findMany({ where: { isActive: true, isArchived: false, OR: [{ ownerId: user.id }, { ownerId: null }] }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true } }).catch(() => [] as any[]),
    db.team.findMany({ where: { id: { startsWith: "seed:" } }, orderBy: [{ leagueId: "asc" }, { name: "asc" }], select: { id: true, leagueId: true, name: true } }).catch(() => [] as any[]),
  ]);
  const teams: WizardTeam[] = (teamsRaw.length > 0 ? teamsRaw : SEED_TEAMS).map((team: any) => ({ id: team.id, leagueId: team.leagueId, name: team.name }));
  const hosts: WizardHost[] = hostsRaw.map((host: any) => ({ id: host.id, name: host.name, role: host.role }));
  const showForge = decodeShowForgeState(podcast.editorialConfig?.scriptStyle).state || defaultShowForgeState();
  const hostIds = podcast.productionConfig?.hostIds?.length ? podcast.productionConfig.hostIds : podcast.hostIds;
  const producedCount = podcast.episodes.filter((episode) => PRODUCED.has(episode.status)).length;
  const nextBeat = storylineSequence(showForge.storylines)[producedCount] || null;

  return (
    <>
      <div className="uTopbar">
        <div>
          <div style={{ color: "var(--u-brand)", fontSize: ".66rem", fontWeight: 900, letterSpacing: ".12em", textTransform: "uppercase" }}>Show Headquarters</div>
          <h1 className="uPageTitle">{podcast.name}</h1>
        </div>
        <div style={{ display: "flex", gap: ".8rem", alignItems: "center", flexWrap: "wrap" }}>
          <Link href={`/app/podcasts/${podcast.id}/sound`} data-testid="podcast-sound-branding-link" className="uRecordBtn" style={{ textDecoration: "none" }}>Sound &amp; Branding</Link>
          <GenerateNowButton podcastId={podcast.id} solid />
        </div>
      </div>
      <div className="uContent" style={{ maxWidth: 980 }}>
        <div className="uTakeMeta" style={{ marginBottom: "1rem", flexWrap: "wrap" }}>
          <span className="uHeat">{podcast.cadence === "recurring" ? podcast.scheduleDays.map((day) => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(" · ") : "Manual releases"}</span>
          <span>{showForge.bible.tone.replace(/_/g, " + ")}</span>
          <Link href="/app/podcasts" style={{ color: "var(--u-brand)", fontWeight: 650 }}>← All shows</Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(240px, .6fr)", gap: "1rem" }}>
          <div className="uTakeCard" style={{ display: "block", padding: "1.2rem" }}>
            <div style={{ color: "var(--u-brand)", fontSize: ".68rem", fontWeight: 900, textTransform: "uppercase", letterSpacing: ".1em" }}>The show promise</div>
            <h2 style={{ margin: ".45rem 0", lineHeight: 1.25 }}>{showForge.bible.premise}</h2>
            <p style={{ color: "var(--u-ink-2)", lineHeight: 1.55 }}>{showForge.bible.audiencePromise}</p>
            <p style={{ fontSize: ".82rem", lineHeight: 1.5 }}><strong>Host chemistry:</strong> {showForge.bible.hostChemistry}</p>
          </div>
          <div className="uTakeCard" style={{ display: "block", padding: "1rem" }}>
            <strong>Next storyline movement</strong>
            {nextBeat ? <><div style={{ color: "var(--u-brand)", fontSize: ".72rem", fontWeight: 850, marginTop: ".7rem" }}>{nextBeat.storylineTitle}</div><div style={{ fontWeight: 800, marginTop: 4 }}>{nextBeat.beatTitle}</div><p style={{ color: "var(--u-ink-2)", fontSize: ".76rem", lineHeight: 1.45 }}>{nextBeat.beatDirection}</p></> : <p style={{ color: "var(--u-ink-2)", fontSize: ".78rem" }}>No season beat is due. The next episode stands alone inside the show bible.</p>}
          </div>
        </div>

        {showForge.storylines.length > 0 && <><h2 className="uSectionTitle" style={{ marginTop: "1.6rem", marginBottom: ".8rem" }}>Storyline board</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: ".7rem" }}>{showForge.storylines.map((storyline) => <div key={storyline.id} className="uTakeCard" style={{ display: "block", padding: ".9rem" }}><strong>{storyline.title}</strong><p style={{ color: "var(--u-ink-2)", fontSize: ".75rem", lineHeight: 1.45 }}>{storyline.premise}</p><span className="uHeat">{storyline.beats.length} beats · {storyline.status}</span></div>)}</div></>}

        <h2 className="uSectionTitle" style={{ marginTop: "1.8rem", marginBottom: ".8rem" }}>Episodes in this show</h2>
        {podcast.episodes.length === 0 ? <div className="uTakeCard" style={{ padding: "1rem" }}>No episodes yet. Generate the premiere when the room is ready.</div> : <div style={{ display: "flex", flexDirection: "column", gap: ".6rem" }}>{podcast.episodes.slice(0, 10).map((episode) => <Link key={episode.id} href={`/app/episodes/${episode.id}`} className="uTakeCard" style={{ textDecoration: "none", color: "inherit", justifyContent: "space-between", padding: ".8rem 1rem" }}><div><div className="uTakeTitle" style={{ fontSize: ".9rem" }}>{episode.title}</div><div className="uTakeMeta" style={{ marginTop: ".3rem" }}>{friendlyStage(episode.status).label}</div></div><span className="uRecordBtn">{episode.audioUrl ? "Listen" : "View"}</span></Link>)}</div>}

        <details style={{ marginTop: "2rem" }}>
          <summary className="uRecordBtn" style={{ cursor: "pointer", display: "inline-flex" }}>Edit in Show Forge</summary>
          <div style={{ marginTop: "1rem" }}><PodcastWizard hosts={hosts} teams={teams} podcastId={podcast.id} initial={{ name: podcast.name, cadence: podcast.cadence as "one_time" | "recurring", scheduleDays: podcast.scheduleDays, verticals: podcast.editorialConfig?.verticals || podcast.verticals, teams: podcast.editorialConfig?.teams || podcast.teams, segmentCount: podcast.editorialConfig?.segmentCount || podcast.segmentCount, hostIds, showForge }} /></div>
        </details>
      </div>
    </>
  );
}
