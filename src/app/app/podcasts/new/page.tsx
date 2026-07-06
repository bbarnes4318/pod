import React from "react";
import { db } from "@/lib/db";
import { SEED_TEAMS } from "@/lib/data/teamSeed";
import { verticalForTopic } from "@/lib/verticals";
import PodcastWizard, { WizardHost, WizardTeam, WizardInitial } from "./PodcastWizard";
import { requireUserPage } from "@/lib/currentUser";

export const dynamic = "force-dynamic";

export default async function NewPodcastPage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  await requireUserPage("/app/podcasts/new"); // creating a podcast requires an account
  const { topic: topicId } = await searchParams;

  const [hostsRaw, teamsRaw] = await Promise.all([
    db.aiHost.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true } }).catch(() => [] as any[]),
    db.team.findMany({ where: { id: { startsWith: "seed:" } }, orderBy: [{ leagueId: "asc" }, { name: "asc" }], select: { id: true, leagueId: true, name: true, city: true } }).catch(() => [] as any[]),
  ]);

  // The DB catalog is the source of truth; fall back to the static seed so
  // the wizard still works before the seed migration has run.
  const teams: WizardTeam[] = (teamsRaw.length > 0 ? teamsRaw : SEED_TEAMS).map((t: any) => ({
    id: t.id, leagueId: t.leagueId, name: t.name,
  }));
  const hosts: WizardHost[] = hostsRaw.map((h: any) => ({ id: h.id, name: h.name, role: h.role }));

  // Pre-fill from a hot topic (PART 7 entry point): topic → vertical, any
  // team named in the topic, and the topic title as the working name.
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
      <div className="uTopbar">
        <h1 className="uPageTitle">Create a podcast</h1>
      </div>
      <div className="uContent" style={{ maxWidth: 720 }}>
        <PodcastWizard hosts={hosts} teams={teams} initial={initial} />
      </div>
    </>
  );
}
