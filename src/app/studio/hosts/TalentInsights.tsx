"use client";

// The two advisory panels of the Talent Studio. Both render the output of the
// pure functions in src/lib/hosts/castingFit.ts: rules over stored fields, no
// model call. Each item shows the stored facts it was derived from.

import Link from "next/link";
import React from "react";
import { rankCastingPartners, type PersonalityRecommendation } from "@/lib/hosts/castingFit";
import { voiceReady, type StudioHostVM } from "./talentModel";

export function Recommendations({ recommendations, draft }: {
  recommendations: PersonalityRecommendation[];
  /** True inside the workflow, where the list follows unsaved edits. */
  draft?: boolean;
}) {
  return (
    <div className="talentInsight">
      <h3 className="sectionTitle">Personality recommendations</h3>
      <p className="advNote">
        Rule-based suggestions from {draft ? "what is in this draft right now" : "this host's stored settings"}. They are advice, not a score, and never block saving.
      </p>
      {recommendations.length === 0 ? (
        <p className="talentInsightEmpty">Nothing to suggest: the profile is filled in and no settings pull against each other.</p>
      ) : (
        <ul className="talentRecList">
          {recommendations.map((rec) => (
            <li key={rec.id} className="talentRec">
              <div className="talentRecHead">
                <span className={`statusPill ${rec.kind === "tension" ? "statusPill--warn" : "statusPill--idle"}`}>{rec.kind === "tension" ? "Tension" : "Gap"}</span>
                <strong>{rec.title}</strong>
              </div>
              <p className="talentRecBody">{rec.suggestion}</p>
              <p className="talentBasis"><span className="talentBasisLabel">Based on:</span> {rec.basis.join(" ")}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SHOWN_PARTNERS = 5;

export function CastingPartners({ host, others, onOpen }: {
  host: StudioHostVM;
  /** The viewer's other available (non-archived) hosts. */
  others: StudioHostVM[];
  onOpen: (hostId: string) => void;
}) {
  const ranked = rankCastingPartners(host, others);
  const byId = new Map(others.map((other) => [other.id, other]));
  const shown = ranked.slice(0, SHOWN_PARTNERS);

  return (
    <div className="talentInsight">
      <h3 className="sectionTitle">Who to cast them with</h3>
      <p className="advNote">
        An episode has exactly two hosts. This ranks your other talent by how well they complement {host.name}: contrast in personality,
        a different voice, and different jobs on the show. The fit score (0–100) is a rule-based estimate from stored settings, not a
        measurement, and it does not change who gets cast.
      </p>
      {shown.length === 0 ? (
        <p className="talentInsightEmpty">No other talent to compare with yet.</p>
      ) : (
        <ol className="talentFitList">
          {shown.map((fit, index) => {
            const partner = byId.get(fit.hostId)!;
            // The audition backend renders a two-voice scene read, but only
            // between hosts the viewer may run auditions for, with voices.
            const canAudition = host.ownedByMe && voiceReady(host.ttsVoiceId) && partner.canEdit && voiceReady(partner.ttsVoiceId);
            return (
              <li key={fit.hostId} className="talentFit">
                <div className="talentFitHead">
                  <span className="talentFitRank" aria-hidden="true">{index + 1}</span>
                  <button type="button" className="advLink talentFitName" onClick={() => onOpen(fit.hostId)}>{fit.name}</button>
                  <span className="talentFitScore">Fit {fit.score} / 100 <span className="talentBasisLabel">(estimate)</span></span>
                </div>
                <ul className="talentFitReasons">
                  {fit.reasons.map((reason) => (
                    <li key={reason.text}>
                      <span className="talentFitEffect" data-sign={reason.effect > 0 ? "plus" : "minus"}>
                        {reason.effect > 0 ? `+${reason.effect}` : `−${Math.abs(reason.effect)}`}
                      </span>{" "}
                      {reason.text}
                    </li>
                  ))}
                </ul>
                {canAudition ? (
                  <Link className="btnGhost btnSm" href={`/studio/auditions?host=${encodeURIComponent(host.id)}&partner=${encodeURIComponent(fit.hostId)}`}>
                    Two-voice audition with {fit.name}
                  </Link>
                ) : (
                  <p className="talentBasis">
                    A two-voice audition needs both hosts in your own roster, each with a voice.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {ranked.length > shown.length && <p className="talentBasis">Showing the top {shown.length} of {ranked.length}.</p>}
    </div>
  );
}
