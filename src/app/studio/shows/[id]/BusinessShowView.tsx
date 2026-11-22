import React from "react";
import type { BusinessProfile } from "@prisma/client";
import StudioPageHeader from "../../StudioPageHeader";
import { ADVANCED_SECTIONS, FINDING_FIELDS, readAnswers, readFindings } from "@/lib/business/profileSchema";
import { DiscoveryButton, FindingRow, AdvancedAnswersForm } from "./BusinessProfileClient";

const FIELD_LABEL = (f: string) => f.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export default function BusinessShowView({ podcastName, profile }: { podcastName: string; profile: BusinessProfile }) {
  const findings = readFindings(profile.findings);
  const answers = readAnswers(profile.answers);
  const visible = findings.filter((f) => f.status !== "rejected");
  const pendingCount = visible.filter((f) => f.status === "pending").length;
  const byField = FINDING_FIELDS.map((field) => ({ field, items: visible.filter((f) => f.field === field) })).filter((g) => g.items.length);
  const answered = Object.keys(answers.fields).length;
  const totalAdvanced = ADVANCED_SECTIONS.reduce((n, s) => n + s.fields.length, 0);

  return (
    <div className="fadeUp" data-testid="business-show-hq">
      <StudioPageHeader
        title={podcastName}
        subtitle={`Business podcast · ${profile.businessName} · ${profile.industry}`}
        breadcrumb={[{ label: "Shows", href: "/studio/shows" }]}
        actions={<DiscoveryButton podcastId={profile.podcastId} status={profile.discoveryStatus} hasRun={!!profile.discoveredAt} />}
      />

      <section className="studioCard bizStackTight">
        <div className="showEyebrow">Business intelligence profile</div>
        <div className="bizChips">
          <span className="chip chipAccent">{profile.primaryGoal}</span>
          {profile.subIndustries.map((s) => <span key={s} className="chip">{s}</span>)}
          {profile.targetAudiences.map((a) => <span key={a} className="chip">{a}</span>)}
          {profile.geographicMarkets.map((g) => <span key={g} className="chip">{g}</span>)}
        </div>
        {profile.websiteUrl && <p className="bizNote">{profile.websiteUrl}</p>}
        {profile.description && <p className="bizBody">{profile.description}</p>}
        <p className="bizNote">
          Business shows can&apos;t generate episodes yet. Topic research and scoring come next, and this profile is what they will read.
        </p>
      </section>

      <section className="studioCard bizSection">
        <div>
          <h2 className="m-0">Here is what we learned about your business</h2>
          <p className="bizLead">
            <strong>Verified</strong> items quote your site word for word. <strong>Inferred</strong> items are the model&apos;s reading. Research uses only items you keep.
            {pendingCount > 0 && ` ${pendingCount} waiting for your review.`}
          </p>
        </div>
        {profile.discoveryStatus === "failed" && (
          <p role="alert" className="gateResult gate-err bizFlush">Discovery failed: {profile.discoveryError}</p>
        )}
        {byField.length === 0 ? (
          <p className="bizLead bizFlush">
            {profile.discoveryStatus === "running" ? "Reading your website…" : "Nothing yet. Run discovery to read your website and description."}
          </p>
        ) : (
          byField.map((g) => (
            <div key={g.field} className="bizStackTight">
              <div className="fieldLabel bizFlush">{FIELD_LABEL(g.field)}</div>
              {g.items.map((f) => <FindingRow key={f.id} podcastId={profile.podcastId} finding={f} />)}
            </div>
          ))
        )}
      </section>

      <section className="studioCard bizSection">
        <div>
          <h2 className="m-0">Deeper context <span className="chip bizCount">{answered}/{totalAdvanced} answered</span></h2>
          <p className="bizLead">Optional. Skip anything — every answer makes research more specific to you.</p>
        </div>
        <AdvancedAnswersForm podcastId={profile.podcastId} version={profile.version} sections={ADVANCED_SECTIONS} initial={answers} />
      </section>
    </div>
  );
}
