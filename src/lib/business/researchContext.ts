// One place that turns a business profile into research input.
//
// Every advanced field reaches the passes listed in its `use`; follow-up
// answers reach the passes of the field they target. Findings are labelled by
// provenance so a downstream prompt never sees a user's or a model's statement
// dressed up as an independently sourced fact.

import {
  ADVANCED_FIELDS, readAnswers, readFindings, isSourceBacked,
  type ResearchUse, type ProfileFinding,
} from "./profileSchema";

export interface ProfileLike {
  businessName: string;
  websiteUrl?: string | null;
  description?: string | null;
  industry: string;
  subIndustries: string[];
  targetAudiences: string[];
  primaryGoal: string;
  geographicMarkets: string[];
  language: string;
  findings: unknown;
  answers: unknown;
}

const FIELD_BY_KEY = new Map(ADVANCED_FIELDS.map((f) => [f.key, f]));
const fence = (s: string) => s.replace(/<\/?(user_input|finding)[^>]*>/gi, "");

/** Advanced answers + follow-ups routed to one pass, as labelled lines. */
export function fieldsForUse(profile: Pick<ProfileLike, "answers">, use: ResearchUse): { key: string; label: string; value: string }[] {
  const answers = readAnswers(profile.answers);
  const out: { key: string; label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(answers.fields)) {
    const f = FIELD_BY_KEY.get(key);
    if (f && f.use.includes(use) && value.trim()) out.push({ key, label: f.label, value: value.trim() });
  }
  for (const [id, fu] of Object.entries(answers.followups)) {
    if (fu.skipped || !fu.answer.trim()) continue;
    const target = fu.targetField ? FIELD_BY_KEY.get(fu.targetField) : undefined;
    const uses: ResearchUse[] = target ? target.use : ["topics", "dossier", "queries"];
    if (uses.includes(use)) out.push({ key: `followup:${id}`, label: fu.question, value: fu.answer.trim() });
  }
  return out;
}

export function usableFindings(profile: Pick<ProfileLike, "findings">): ProfileFinding[] {
  // Rejected findings are gone; contradicted ones are never research input.
  return readFindings(profile.findings).filter((f) => f.status !== "rejected" && f.provenance !== "SOURCE_CONTRADICTED");
}

function findingLabel(f: ProfileFinding): string {
  if (isSourceBacked(f.provenance)) {
    return f.verification?.authority === "FIRST_PARTY" ? "company's own site states" : "independent source";
  }
  if (f.provenance === "USER_CONFIRMED" || f.provenance === "USER_PROVIDED") return "business owner says";
  return "unverified inference";
}

/** The profile block for one research pass. User text is fenced as data. */
export function renderProfileContext(profile: ProfileLike, use: ResearchUse): string {
  const lines = [
    `Business: ${profile.businessName}${profile.websiteUrl ? ` (${profile.websiteUrl})` : ""}`,
    `Industry: ${profile.industry}${profile.subIndustries.length ? ` — ${profile.subIndustries.join(", ")}` : ""}`,
    `Primary audience: ${profile.targetAudiences[0] ?? "(not set)"}`,
    profile.targetAudiences.length > 1 ? `Secondary audiences: ${profile.targetAudiences.slice(1).join(", ")}` : "",
    `Podcast objective: ${profile.primaryGoal}`,
    `Markets: ${profile.geographicMarkets.join(", ") || "(not stated)"}`,
    `Language: ${profile.language}`,
  ].filter(Boolean);
  const parts = [lines.join("\n")];
  if (profile.description) parts.push(`<user_input field="description">\n${fence(profile.description)}\n</user_input>`);

  const findings = usableFindings(profile);
  if (findings.length && use !== "script") {
    parts.push(
      "Profile findings (label says how far each can be trusted):\n" +
        findings.slice(0, 60).map((f) => `- [${findingLabel(f)}] ${f.field}: ${fence(f.value)}`).join("\n")
    );
  }
  const fields = fieldsForUse(profile, use);
  if (fields.length) {
    parts.push(
      "From the business owner (their words; not independently verified):\n" +
        fields.map((f) => `<user_input field="${f.key}" question="${f.label.replace(/"/g, "'")}">\n${fence(f.value)}\n</user_input>`).join("\n")
    );
  }
  return parts.join("\n\n");
}

/** EXCLUDED_TOPICS as normalized phrases, one per line or comma. */
export function excludedTopics(profile: Pick<ProfileLike, "answers">): string[] {
  return fieldsForUse(profile, "exclude")
    .flatMap((f) => f.value.split(/[\n,;]+/))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
}

/** Terms that make a topic specific to THIS business (used by the genericness check). */
export function specificityTerms(profile: ProfileLike): string[] {
  const raw = [
    profile.industry,
    ...profile.subIndustries,
    ...fieldsForUse(profile, "queries").map((f) => f.value),
    ...usableFindings(profile)
      .filter((f) => ["SERVICES", "PRODUCTS", "INDUSTRY_TERMINOLOGY", "SUB_INDUSTRIES", "TARGET_CUSTOMERS"].includes(f.field))
      .map((f) => f.value),
  ].join(" ");
  const STOP = new Set("and or the for with your our their from that this into about over under business businesses company companies service services industry customers people".split(" "));
  const counts = new Map<string, number>();
  for (const w of raw.toLowerCase().match(/[a-z][a-z0-9/-]{3,}/g) ?? []) {
    if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.keys()].slice(0, 80);
}
