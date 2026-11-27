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
import { PlayButton } from "../../StudioAudio";
import { bustAudioUrl, showHue, showInitials } from "../../lib";
import QualityTierSection from "./QualityTierSection";
import BusinessShowView, { resolveBusinessView } from "./BusinessShowView";
import "../shows-intel.css";

export const dynamic = "force-dynamic";

const PRODUCED = new Set(["audio_ready", "content_generating", "content_ready", "publish_ready", "published"]);

export default async function StudioShowHeadquartersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
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
        select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, audioUrl: true },
      },
    },
  }).catch(() => null);

  if (!podcast || !canViewOwned(user, podcast)) notFound();

  // Business shows have their own headquarters; nothing below is reached for them.
  if (podcast.intelligenceType === "BUSINESS") {
    const profile = await db.businessProfile.findUnique({ where: { podcastId: podcast.id } });
    if (!profile) notFound();
    // Old ?tab= ids (radar, topics, insider, dossiers, episodes) still resolve.
    const sp = await searchParams;
    const { stage, scope } = resolveBusinessView(typeof sp.tab === "string" ? sp.tab : undefined, typeof sp.scope === "string" ? sp.scope : undefined);
    return <BusinessShowView podcast={{ id: podcast.id, name: podcast.name }} profile={profile} stage={stage} scope={scope} />;
  }

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
  const cadence = podcast.cadence === "recurring" && podcast.scheduleDays.length
    ? podcast.scheduleDays.map((day) => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(", ")
    : "Manual releases";
  const tone = showForge.bible.tone.replace(/_/g, " + ").replace(/^./, (c) => c.toUpperCase());

  const cast = hosts.filter((host) => hostIds.includes(host.id));

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title={podcast.name}
        subtitle={`Sports show · ${cadence} · ${tone} tone`}
        breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}
        actions={
          <>
            <GenerateShowEpisodeButton podcastId={podcast.id} />
            <Link href={`/studio/create?show=${podcast.id}`} className="btnPrimary" data-new-episode>New episode</Link>
          </>
        }
      />

      {/* The masthead: this is a media property, and it should look like one. */}
      <header className="showHead">
        {podcast.coverImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={podcast.coverImageUrl} alt="" className="showArt showArt--lg showArt--img" />
        ) : (
          <span className="showArt showArt--lg" data-hue={showHue(podcast.id)} aria-hidden="true">{showInitials(podcast.name)}</span>
        )}
        <div className="showHeadText">
          <div className="overline">The show promise</div>
          <p className="showHeadPremise">{showForge.bible.premise}</p>
          <p className="showHeadPromise">{showForge.bible.audiencePromise}</p>
        </div>
      </header>

      <div className="showHq">
        <div className="showHqMain">
          <section>
            <div className="homeSectionHead">
              <h2 className="homeSectionTitle">Episodes in this show</h2>
              <span className="sectionCount">{podcast.episodes.length === 30 ? "Latest 30" : `${podcast.episodes.length} total`}</span>
            </div>
            {podcast.episodes.length === 0 ? (
              <div className="emptyState">
                <div className="emptyStateTitle">No episodes yet</div>
                <p className="emptyStateBody">Make the premiere. The show already knows its hosts, length and coverage, so you only choose the topics.</p>
                <Link href={`/studio/create?show=${podcast.id}`} className="btnPrimary">New episode</Link>
              </div>
            ) : (
              <ul className="readyList showEpisodeList">
                {podcast.episodes.map((episode) => {
                  const stage = friendlyStage(episode.status);
                  return (
                    <li key={episode.id} className="readyRow showEpisodeRow">
                      {episode.audioUrl ? (
                        <PlayButton
                          className="playBtn playBtn--sm"
                          track={{ id: episode.id, src: bustAudioUrl(episode.audioUrl, episode.updatedAt), title: episode.title, subtitle: podcast.name, href: `/studio/episodes/${episode.id}` }}
                        />
                      ) : (
                        <span className="showEpisodeDot" aria-hidden="true" />
                      )}
                      <span className="readyBody">
                        <Link href={`/studio/episodes/${episode.id}`} className="readyTitle">{episode.title}</Link>
                        <span className="readyMeta">
                          {new Date(episode.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </span>
                      <span className={stage.done ? "statusPill statusPill--ok" : "statusPill"}>{stage.label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {showForge.storylines.length > 0 && (
            <section>
              <div className="homeSectionHead"><h2 className="homeSectionTitle">Storyline board</h2></div>
              <ul className="showArcs">
                {showForge.storylines.map((storyline) => (
                  <li key={storyline.id} className="showArc">
                    <strong>{storyline.title}</strong>
                    <span className="showArcBody">{storyline.premise}</span>
                    <span className="showArcMeta">{storyline.beats.length} beats · {storyline.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="showHqSide">
          <section className="showSideBlock">
            <h2 className="homeSectionTitle">Next storyline movement</h2>
            {nextBeat ? (
              <>
                <div className="showSideLead">{nextBeat.beatTitle}</div>
                <p className="showAsideBody">{nextBeat.storylineTitle}. {nextBeat.beatDirection}</p>
              </>
            ) : (
              <p className="showAsideBody">No season beat is due. The next episode stands alone inside the show bible.</p>
            )}
          </section>

          <section className="showSideBlock">
            <div className="homeSectionHead">
              <h2 className="homeSectionTitle">Hosts</h2>
              <Link href="/studio/hosts" className="sectionAction">Talent</Link>
            </div>
            {cast.length === 0 ? (
              <p className="showAsideBody">No hosts are assigned. Choose them in the show settings below.</p>
            ) : (
              <ul className="showCast">
                {cast.map((host, i) => (
                  <li key={host.id} className="showCastRow">
                    <span className="tHostDot" data-seat={i === 0 ? "a" : "b"} aria-hidden="true" />
                    <span className="showCastName">{host.name}</span>
                    <span className="showCastRole">{host.role}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="showAsideBody"><strong>Chemistry:</strong> {showForge.bible.hostChemistry}</p>
          </section>

          <section className="showSideBlock">
            <h2 className="homeSectionTitle">Sound and release</h2>
            <dl className="deskFacts">
              <div><dt>Schedule</dt><dd>{cadence}</dd></div>
              <div><dt>Topics per episode</dt><dd>{podcast.editorialConfig?.segmentCount || podcast.segmentCount}</dd></div>
              <div><dt>Feed</dt><dd>{podcast.visibility}</dd></div>
            </dl>
            <div className="showSideLinks">
              <Link href={`/studio/shows/${podcast.id}/sound`} className="btnGhost btnSm">Sound and branding</Link>
              <Link href="/studio/publish" className="btnGhost btnSm">Publishing</Link>
            </div>
          </section>

          {/* Which models write this show: a one-click setting with a real cost
              and speed consequence. */}
          <QualityTierSection podcastId={podcast.id} initialTier={podcast.qualityTier ?? null} />
        </aside>
      </div>

      <details className="mt-8">
        <summary className="btnGhost showForgeSummary">Edit in Show Forge</summary>
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
