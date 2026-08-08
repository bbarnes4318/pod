import React from "react";
import StudioPageHeader from "../../StudioPageHeader";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { SEED_TEAMS } from "@/lib/data/teamSeed";
import { requireUserPage } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";
import { friendlyStage } from "@/app/app/lib";
import { WEEKDAY_LABELS } from "@/app/app/podcasts/config";
import PodcastWizard, {
  type WizardHost,
  type WizardTeam,
} from "@/app/app/podcasts/new/PodcastWizard";
import {
  decodeShowForgeState,
  defaultShowForgeState,
  storylineSequence,
} from "@/lib/shows/showForge";
import GenerateShowEpisodeButton from "../GenerateShowEpisodeButton";

export const dynamic = "force-dynamic";

const PRODUCED = new Set(["audio_ready", "content_generating", "content_ready", "publish_ready", "published"]);

export default async function StudioShowHeadquartersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserPage(`/studio/shows/${id}`);
  const podcast = await db.podcast.findUnique({
    where: { id },
    include: {
      editorialConfig: true,
      productionConfig: true,
      episodes: {
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, title: true, status: true, createdAt: true, audioUrl: true },
      },
    },
  }).catch(() => null);

  if (!podcast || !canViewOwned(user, podcast)) notFound();

  const [hostsRaw, teamsRaw] = await Promise.all([
    db.aiHost.findMany({
      where: {
        isActive: true,
        isArchived: false,
        OR: [{ ownerId: user.id }, { ownerId: null }],
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, role: true },
    }).catch(() => [] as any[]),
    db.team.findMany({
      where: { id: { startsWith: "seed:" } },
      orderBy: [{ leagueId: "asc" }, { name: "asc" }],
      select: { id: true, leagueId: true, name: true },
    }).catch(() => [] as any[]),
  ]);

  const teams: WizardTeam[] = (teamsRaw.length > 0 ? teamsRaw : SEED_TEAMS).map((team: any) => ({
    id: team.id,
    leagueId: team.leagueId,
    name: team.name,
  }));
  const hosts: WizardHost[] = hostsRaw.map((host: any) => ({
    id: host.id,
    name: host.name,
    role: host.role,
  }));

  const showForge = decodeShowForgeState(podcast.editorialConfig?.scriptStyle).state || defaultShowForgeState();
  const hostIds = podcast.productionConfig?.hostIds?.length
    ? podcast.productionConfig.hostIds
    : podcast.hostIds;
  const producedCount = podcast.episodes.filter((episode) => PRODUCED.has(episode.status)).length;
  const nextBeat = storylineSequence(showForge.storylines)[producedCount] || null;
  const cadence = podcast.cadence === "recurring"
    ? podcast.scheduleDays.map((day) => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(" · ")
    : "Manual releases";

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title={podcast.name}
        subtitle={`${cadence} · ${showForge.bible.tone.replace(/_/g, " + ")}`}
        breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}
        actions={
          <>
            <Link href={`/studio/shows/${podcast.id}/sound`} className="btnGhost">Sound and branding</Link>
            <GenerateShowEpisodeButton podcastId={podcast.id} primary />
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(260px, .65fr)", gap: 14 }}>
        <section className="studioCard" style={{ padding: "1.25rem" }}>
          <div style={{ color: "var(--accent)", fontSize: ".68rem", fontWeight: 900, textTransform: "uppercase", letterSpacing: ".1em" }}>The show promise</div>
          <h2 style={{ margin: ".5rem 0", lineHeight: 1.25 }}>{showForge.bible.premise}</h2>
          <p style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>{showForge.bible.audiencePromise}</p>
          <p style={{ fontSize: ".84rem", lineHeight: 1.55, marginBottom: 0 }}><strong>Host chemistry:</strong> {showForge.bible.hostChemistry}</p>
        </section>

        <section className="studioCard" style={{ padding: "1.1rem" }}>
          <div style={{ fontWeight: 850 }}>Next storyline movement</div>
          {nextBeat ? (
            <>
              <div style={{ color: "var(--accent)", fontSize: ".72rem", fontWeight: 850, marginTop: ".8rem" }}>{nextBeat.storylineTitle}</div>
              <div style={{ fontWeight: 850, marginTop: 5 }}>{nextBeat.beatTitle}</div>
              <p style={{ color: "var(--text-secondary)", fontSize: ".78rem", lineHeight: 1.5, marginBottom: 0 }}>{nextBeat.beatDirection}</p>
            </>
          ) : (
            <p style={{ color: "var(--text-secondary)", fontSize: ".8rem", lineHeight: 1.5 }}>
              No season beat is due. The next episode stands alone inside the show bible.
            </p>
          )}
        </section>
      </div>

      {showForge.storylines.length > 0 && (
        <section className="mt-6">
          <div className="sectionHead"><h2 className="sectionTitle">Storyline board</h2></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
            {showForge.storylines.map((storyline) => (
              <article key={storyline.id} className="studioCard" style={{ padding: "1rem" }}>
                <strong>{storyline.title}</strong>
                <p style={{ color: "var(--text-secondary)", fontSize: ".78rem", lineHeight: 1.5 }}>{storyline.premise}</p>
                <span className="statusPill statusPill--warn">{storyline.beats.length} beats · {storyline.status}</span>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <div className="sectionHead">
          <h2 className="sectionTitle">Episodes in this show</h2>
          <Link href="/studio/create" className="sectionAction">Build a rundown →</Link>
        </div>
        {podcast.episodes.length === 0 ? (
          <div className="studioCard" style={{ padding: "1rem" }}>No episodes yet. Generate the premiere when the room is ready.</div>
        ) : (
          <div style={{ display: "grid", gap: 9 }}>
            {podcast.episodes.slice(0, 10).map((episode) => {
              const stage = friendlyStage(episode.status);
              return (
                <Link key={episode.id} href={`/studio/episodes/${episode.id}`} className="studioCard clickable" style={{ textDecoration: "none", color: "inherit", padding: ".9rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14 }}>
                  <div>
                    <div style={{ fontWeight: 850 }}>{episode.title}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: ".76rem", marginTop: 4 }}>{stage.label}</div>
                  </div>
                  <span className="btnGhost">{episode.audioUrl ? "Listen" : "Open"}</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <details className="mt-8">
        <summary className="btnGhost" style={{ cursor: "pointer", display: "inline-flex" }}>Edit in Show Forge</summary>
        <div className="mt-4">
          <PodcastWizard
            hosts={hosts}
            teams={teams}
            podcastId={podcast.id}
            initial={{
              name: podcast.name,
              cadence: podcast.cadence as "one_time" | "recurring",
              scheduleDays: podcast.scheduleDays,
              verticals: podcast.editorialConfig?.verticals || podcast.verticals,
              teams: podcast.editorialConfig?.teams || podcast.teams,
              segmentCount: podcast.editorialConfig?.segmentCount || podcast.segmentCount,
              hostIds,
              showForge,
            }}
          />
        </div>
      </details>
    </div>
  );
}
