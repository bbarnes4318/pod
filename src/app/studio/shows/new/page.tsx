import React from "react";
import StudioPageHeader from "../../StudioPageHeader";
import { db } from "@/lib/db";
import { SEED_TEAMS } from "@/lib/data/teamSeed";
import { verticalForTopic } from "@/lib/verticals";
import { requireUserPage } from "@/lib/currentUser";
import PodcastWizard, {
  type WizardHost,
  type WizardTeam,
  type WizardInitial,
} from "@/app/app/podcasts/new/PodcastWizard";

export const dynamic = "force-dynamic";

export default async function NewStudioShowPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string }>;
}) {
  const user = await requireUserPage("/studio/shows/new");
  const { topic: topicId } = await searchParams;

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
      select: { id: true, leagueId: true, name: true, city: true },
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

  let initial: WizardInitial | undefined;
  if (topicId) {
    const topic = await db.topicCandidate.findUnique({
      where: { id: topicId },
      select: { title: true, summary: true, sport: true, leagueId: true },
    }).catch(() => null);

    if (topic) {
      const vertical = verticalForTopic(topic.leagueId, topic.sport);
      const text = `${topic.title} ${topic.summary || ""}`.toLowerCase();
      const matchedTeams = teams
        .filter((team) => vertical && team.leagueId === (topic.leagueId || "").toUpperCase())
        .filter((team) => {
          const nickname = team.name.split(" ").slice(-1)[0].toLowerCase();
          return nickname.length >= 4 && text.includes(nickname);
        })
        .map((team) => team.id);

      initial = {
        name: topic.title.length > 80 ? `${topic.title.slice(0, 77)}…` : topic.title,
        verticals: vertical ? [vertical] : [],
        teams: matchedTeams,
      };
    }
  }

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Build your show"
        subtitle="The theme, listener promise, cast chemistry and rituals every future episode follows."
        breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}
      />
      <PodcastWizard hosts={hosts} teams={teams} initial={initial} hideIdentity />
    </div>
  );
}
