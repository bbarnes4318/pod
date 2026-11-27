import React from "react";
import StudioPageHeader from "../../StudioPageHeader";
import { db } from "@/lib/db";
import { SEED_TEAMS } from "@/lib/data/teamSeed";
import { verticalForTopic } from "@/lib/verticals";
import { requireUserPage } from "@/lib/currentUser";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import Link from "next/link";
import PodcastWizard, {
  type WizardHost,
  type WizardTeam,
  type WizardInitial,
} from "@/app/app/podcasts/new/PodcastWizard";
import QuickStart from "./QuickStart";
import "../shows-intel.css";

export const dynamic = "force-dynamic";

export default async function NewStudioShowPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string; type?: string }>;
}) {
  const user = await requireUserPage("/studio/shows/new");
  const { topic: topicId, type } = await searchParams;

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

  // No type and no seeding topic: the front door. Quick start (AI recommends a
  // whole setup) sits beside the Custom paths; ?type=sports is Show Forge,
  // exactly as before, and business keeps its own setup form.
  if (!topicId && type !== "sports") {
    return <ShowFrontDoor hosts={hosts} teams={teams} business={businessPodcastsEnabledFor(user)} />;
  }

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

function ShowFrontDoor({ hosts, teams, business }: { hosts: WizardHost[]; teams: WizardTeam[]; business: boolean }) {
  const cards = [
    {
      href: "/studio/shows/new?type=sports",
      title: business ? "Sports podcast" : "Custom (Show Forge)",
      body: business
        ? "Turn sports news, statistics, rivalries, and debates into compelling episodes."
        : "Set every part yourself: premise, listener promise, cast, segments, storylines and schedule.",
      testId: "choose-sports",
    },
    ...(business
      ? [{
          href: "/studio/shows/new/business",
          title: "Business podcast",
          body: "Discover what your industry's audience wants to know and create podcasts powered by deep research.",
          testId: "choose-business",
        }]
      : []),
  ];
  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="New show"
        subtitle={business ? "Describe it and get a recommended setup, or build it yourself. Each type runs on its own research engine." : "Describe it and get a recommended setup, or build it yourself."}
        breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}
      />
      <QuickStart hosts={hosts} teams={teams} />
      <h2 className="sectionTitle qsOr">Custom: build it yourself</h2>
      <div className="bizTypeGrid">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="studioCard bizTypeCard" data-testid={c.testId}>
            <h3 className="m-0">{c.title}</h3>
            <p className="bizLead bizFlush">{c.body}</p>
            <span className="btnGhost bizTypeStart">Start →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
