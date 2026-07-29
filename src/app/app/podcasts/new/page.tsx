import React from "react";
import { db } from "@/lib/db";
import { SEED_TEAMS } from "@/lib/data/teamSeed";
import { verticalForTopic } from "@/lib/verticals";
import PodcastWizard, { WizardHost, WizardTeam, WizardInitial } from "./PodcastWizard";
import { requireUserPage } from "@/lib/currentUser";

export const dynamic = "force-dynamic";

export default async function NewPodcastPage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const user = await requireUserPage("/app/podcasts/new");
  const { topic: topicId } = await searchParams;

  const [hostsRaw, teamsRaw] = await Promise.all([
    db.aiHost.findMany({ where: { isActive: true, isArchived: false, OR: [{ ownerId: user.id }, { ownerId: null }] }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true } }).catch(() => [] as any[]),
    db.team.findMany({ where: { id: { startsWith: "seed:" } }, orderBy: [{ leagueId: "asc" }, { name: "asc" }], select: { id: true, leagueId: true, name: true, city: true } }).catch(() => [] as any[]),
  ]);

  const teams: WizardTeam[] = (teamsRaw.length > 0 ? teamsRaw : SEED_TEAMS).map((t: any) => ({
    id: t.id, leagueId: t.leagueId, name: t.name,
  }));
  const hosts: WizardHost[] = hostsRaw.map((h: any) => ({ id: h.id, name: h.name, role: h.role }));

  let initial: WizardInitial | undefined;
  if (topicId) {
    const t = await db.topicCandidate
      .findUnique({ where: { id: topicId }, select: { title: true, summary: true, sport: true, leagueId: true } })
      .catch(() => null);
    if (t) {
      const vertical = verticalForTopic(t.leagueId, t.sport);
      const text = `${t.title} ${t.summary || ""}`.toLowerCase();
      const matchedTeams = teams
        .filter((team) => vertical && team.leagueId === (t.leagueId || "").toUpperCase())
        .filter((team) => {
          const nickname = team.name.split(" ").slice(-1)[0].toLowerCase();
          return nickname.length >= 4 && text.includes(nickname);
        })
        .map((team) => team.id);
      initial = {
        name: t.title.length > 80 ? `${t.title.slice(0, 77)}…` : t.title,
        verticals: vertical ? [vertical] : [],
        teams: matchedTeams,
      };
    }
  }

  return (
    <>
      <div className="uTopbar" data-testid="show-forge-header">
        <div>
          <div style={{ color: "var(--u-brand)", fontSize: "0.72rem", fontWeight: 900, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 5 }}>
            Show Forge
          </div>
          <h1 className="uPageTitle">Build your show</h1>
          <div style={{ color: "var(--u-ink-2)", fontSize: "0.83rem", marginTop: 5, maxWidth: 680, lineHeight: 1.45 }}>
            Create the theme, listener promise, cast chemistry, episode rituals, and storylines that every future episode will follow.
          </div>
        </div>
      </div>
      <div className="uContent" style={{ maxWidth: 820 }}>
        <PodcastWizard hosts={hosts} teams={teams} initial={initial} />
      </div>
    </>
  );
}
