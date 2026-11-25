// The Business Intelligence Profile contract.
//
// Three layers, each validated here and nowhere else:
//   essentials — Level 1, real BusinessProfile columns.
//   findings   — what discovery (or the user) established, each with provenance.
//   answers    — advanced fields + adaptive follow-ups, in the user's own words.
//
// Provenance is the whole point: nothing AI-produced is ever presented as a
// fact unless it passed claim-level verification against a fetched source, and
// the user can accept, edit or reject every finding.
//
// EVERY advanced field declares which research passes consume it (`use`).
// researchContext.ts renders fields by use, and a test fails if a field is
// declared but never reaches a prompt — inputs are not collected to be ignored.

import { z } from "zod";

export const INDUSTRIES = [
  "Insurance", "Real Estate", "Telecommunications", "Healthcare", "Technology",
  "Finance", "Construction", "Legal Services", "Automotive", "Retail",
  "Marketing", "Manufacturing", "Hospitality", "Education", "Entertainment",
  "Home Services", "Other",
] as const;

/** Suggestions only — custom audiences, job titles and personas are accepted. */
export const TARGET_AUDIENCES = [
  "General consumers", "Existing customers", "Prospective buyers", "Business owners",
  "Independent professionals", "Industry executives", "Investors", "Employees",
  "Contractors", "Partners", "Industry analysts", "Experienced specialists", "Enthusiasts",
] as const;

export const PODCAST_GOALS = [
  "Maximum relevant traffic", "Qualified lead generation", "Thought leadership",
  "Customer education", "Brand awareness", "Industry authority", "Community building",
  "Recruiting", "Podcast monetization", "Customer retention", "Strategic partnerships",
] as const;

export const GEOGRAPHIC_SCOPES = ["Local", "Regional", "National", "International"] as const;

const text = (max: number) => z.string().trim().max(max);
// The message names the list: the bare zod default ("Array must contain at most
// 15 element(s)") reached the owner on the new-show form with no hint of which
// field it meant.
const list = (max: number, what = "items") =>
  z.array(text(120).min(1, `Remove the empty entry from your ${what}.`)).max(max, `Pick at most ${max} ${what}.`);

export const BusinessEssentialsSchema = z
  .object({
    showName: text(80).min(1, "Give the show a name."),
    businessName: text(160).min(1, "Business name is required."),
    websiteUrl: z
      .string()
      .trim()
      .max(2000)
      .url("That website URL is not valid.")
      .refine((u) => /^https?:\/\//i.test(u), "Website must start with http:// or https://")
      .optional()
      .nullable(),
    description: text(4000).optional().nullable(),
    // Custom industries are allowed — the list is a suggestion, not a cage.
    industry: text(120).min(1, "Pick or type an industry."),
    // The form takes a free comma-separated list here.
    subIndustries: list(30, "sub-industries").default([]),
    // ORDER MATTERS: the first audience is the primary audience.
    // 13 suggested audiences plus any number of the owner's own: 15 was below
    // what the form invites (owner hit "Array must contain at most 15").
    targetAudiences: list(40, "audiences").min(1, "Pick at least one audience."),
    primaryGoal: z.enum(PODCAST_GOALS),
    geographicMarkets: list(10, "markets").default([]),
    language: text(35).min(2).default("en"),
  })
  // Discovery needs SOMETHING to read: a website, or a description.
  .refine((e) => !!e.websiteUrl || (e.description ?? "").length >= 20, {
    message: "Add your website, or describe what your business does and who it serves (a sentence or two).",
    path: ["description"],
  });

export type BusinessEssentials = z.infer<typeof BusinessEssentialsSchema>;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

// Current values first; SOURCE_VERIFIED and UNKNOWN are LEGACY and still read
// (SOURCE_VERIFIED meant only "the quote matched" — the UI says exactly that).
//   USER_PROVIDED       typed by the user (essentials, answers)
//   USER_CONFIRMED      an AI suggestion the user kept or edited — THEIR claim,
//                       not an independently verified external fact
//   SOURCE_SUPPORTED    quote exists AND passed claim-level verification
//   SOURCE_CONTRADICTED quote exists but the source says something else
//   AI_INFERRED         model reading with no supporting passage
//   UNVERIFIED          a cited source failed verification (missing, outdated,
//                       wrong entity, fabricated quote, unsupported inference)
export const PROVENANCE = [
  "USER_PROVIDED", "USER_CONFIRMED", "SOURCE_SUPPORTED", "SOURCE_CONTRADICTED", "AI_INFERRED", "UNVERIFIED",
  "SOURCE_VERIFIED", "UNKNOWN",
] as const;
export type Provenance = (typeof PROVENANCE)[number];

/** True only for provenance an external source independently backs. Legacy SOURCE_VERIFIED is NOT. */
export function isSourceBacked(p: Provenance): boolean {
  return p === "SOURCE_SUPPORTED";
}

/** Fields discovery may populate. */
export const FINDING_FIELDS = [
  "BUSINESS_OVERVIEW", "BUSINESS_MODEL", "INDUSTRY_CLASSIFICATION", "SUB_INDUSTRIES",
  "PRODUCTS", "SERVICES", "TARGET_CUSTOMERS", "CUSTOMER_PROBLEMS", "CUSTOMER_OUTCOMES",
  "COMPETITIVE_DIFFERENTIATORS", "INDUSTRY_TERMINOLOGY", "GEOGRAPHIC_COVERAGE",
  "PUBLIC_PRICING", "COMPETITORS", "RELATED_INDUSTRIES", "REGULATORY_CONTEXT",
  "CUSTOMER_QUESTIONS", "RESEARCH_OPPORTUNITIES",
] as const;
export type FindingField = (typeof FINDING_FIELDS)[number];

export const FindingVerificationSchema = z.object({
  verdict: z.enum(["SOURCE_SUPPORTED", "SOURCE_CONTRADICTED", "UNVERIFIED"]),
  reasons: z.array(z.string().max(400)).max(12),
  authority: z.enum(["FIRST_PARTY", "INDEPENDENT", "UNKNOWN"]),
  marketingClaim: z.boolean(),
  entailment: z.enum(["entailed", "contradicted", "neutral", "not_run"]),
  verifiedAt: z.string(),
});

export const ProfileFindingSchema = z.object({
  id: z.string().min(1).max(64),
  field: z.enum(FINDING_FIELDS),
  value: text(1000).min(1),
  provenance: z.enum(PROVENANCE),
  /** Verbatim text from the source that supports `value` (source-backed only). */
  evidenceQuote: text(500).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  retrievedAt: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["pending", "accepted", "rejected"]),
  /** Claim-level verification record. Absent on legacy rows. */
  verification: FindingVerificationSchema.nullable().optional(),
  /** The quote the model offered, kept for audit even when it did not verify. */
  offeredQuote: text(500).nullable().optional(),
});
export type ProfileFinding = z.infer<typeof ProfileFindingSchema>;

export const FindingsSchema = z.array(ProfileFindingSchema).max(200);

/** Read stored findings; a corrupt blob reads as empty rather than crashing a page. */
export function readFindings(raw: unknown): ProfileFinding[] {
  const parsed = FindingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// ---------------------------------------------------------------------------
// Advanced answers. Keys are stable (research relies on them); values are the
// user's words. Existing keys were kept — relabelled, not renamed — so answers
// saved before this change keep working.
// ---------------------------------------------------------------------------

/**
 * Where a field is consumed:
 *   queries  — research/demand search query building
 *   topics   — topic generation prompt
 *   insider  — insider-mechanism research pass
 *   dossier  — dossier writer
 *   script   — business script writer (style only, never facts)
 *   exclude  — hard topic exclusion filter
 */
export type ResearchUse = "queries" | "topics" | "insider" | "dossier" | "script" | "exclude";

export interface AdvancedField {
  key: string;
  label: string;
  help?: string;
  use: ResearchUse[];
  /** Asked by adaptive follow-ups when empty; higher = more valuable to research. */
  gapWeight?: number;
}
export interface AdvancedSection {
  key: string;
  title: string;
  why: string;
  fields: AdvancedField[];
}

export const ADVANCED_SECTIONS: AdvancedSection[] = [
  {
    key: "audience",
    title: "Audience intelligence",
    why: "Research ranks topics by what your listeners need, not what's generally popular.",
    fields: [
      { key: "AUDIENCE_JOB_TITLES", label: "Job titles or roles of your ideal listeners", use: ["queries", "topics", "script"], gapWeight: 3 },
      { key: "AUDIENCE_KNOWLEDGE_LEVEL", label: "Experience level (beginner → expert)", use: ["topics", "script"], gapWeight: 2 },
      { key: "AUDIENCE_TOP_PROBLEMS", label: "Problems your listeners struggle with most", use: ["queries", "topics", "dossier"], gapWeight: 3 },
      { key: "AUDIENCE_DESIRED_OUTCOMES", label: "What they would pay to understand or solve", use: ["topics", "dossier"], gapWeight: 2 },
      { key: "AUDIENCE_PURCHASE_TRIGGERS", label: "What makes them start looking for a solution", use: ["topics", "dossier"], gapWeight: 1 },
      { key: "AUDIENCE_OBJECTIONS", label: "Objections they raise before buying", use: ["topics", "dossier"], gapWeight: 1 },
      { key: "AUDIENCE_QUESTIONS", label: "Questions they ask you most often", use: ["queries", "topics"], gapWeight: 3 },
      { key: "AUDIENCE_INDUSTRY_TERMINOLOGY", label: "Words and jargon they actually use", use: ["queries", "script"], gapWeight: 2 },
      { key: "AUDIENCE_ADJACENT_INTERESTS", label: "Adjacent topics they also follow", use: ["topics"] },
    ],
  },
  {
    key: "specialization",
    title: "Business specialization",
    why: "Specific niches produce specific research.",
    fields: [
      { key: "PRODUCTS_AND_SERVICES", label: "Products and services, in your words", use: ["queries", "topics", "dossier"], gapWeight: 2 },
      { key: "CORE_SPECIALTIES", label: "Core specialties", use: ["queries", "topics"], gapWeight: 2 },
      { key: "MICRO_NICHES", label: "Specialized niches you serve", use: ["queries", "topics", "insider"], gapWeight: 3 },
      { key: "CUSTOMER_TYPES", label: "Customer types (e.g. agencies vs consumers, carriers vs resellers)", use: ["queries", "topics"], gapWeight: 3 },
      { key: "BUSINESS_DIFFERENTIATORS", label: "Competitive differentiators", use: ["topics", "dossier"] },
      { key: "PROPRIETARY_METHODS", label: "Unique methods", use: ["topics", "dossier"] },
      { key: "PROPRIETARY_TECHNOLOGIES", label: "Proprietary technologies", use: ["topics", "dossier"] },
      { key: "BUSINESS_ECONOMICS", label: "How the money works (margins, unit economics, pricing model)", use: ["insider", "dossier"], gapWeight: 2 },
      { key: "IMPORTANT_INDUSTRY_METRICS", label: "Numbers that actually decide success", use: ["insider", "dossier", "queries"], gapWeight: 3 },
      { key: "COMMON_OPERATIONAL_PROBLEMS", label: "Common operational problems", use: ["insider", "topics"], gapWeight: 2 },
    ],
  },
  {
    key: "insider",
    title: "Insider knowledge",
    why: "This is what separates a useful show from a generic AI summary. Only share what you're comfortable making public.",
    fields: [
      { key: "INSIDER_KNOWLEDGE", label: "What does your business understand that most outsiders don't?", use: ["insider", "topics", "dossier"], gapWeight: 3 },
      { key: "INDUSTRY_MISCONCEPTIONS", label: "Industry myths customers believe", use: ["insider", "topics", "dossier"], gapWeight: 2 },
      { key: "OVERLOOKED_INDUSTRY_PROBLEMS", label: "Overlooked problems that deserve investigation", use: ["insider", "topics", "queries"], gapWeight: 2 },
      { key: "HIDDEN_COSTS", label: "Hidden costs people don't see coming", use: ["insider", "dossier"], gapWeight: 2 },
      { key: "COMMON_EXPENSIVE_MISTAKES", label: "Costly mistakes people repeatedly make", use: ["insider", "topics", "dossier"], gapWeight: 2 },
      { key: "INDUSTRY_PRICING_MECHANISMS", label: "How pricing really works in your industry", use: ["insider", "queries", "dossier"], gapWeight: 2 },
      { key: "OPERATIONAL_BOTTLENECKS", label: "Operational bottlenecks", use: ["insider", "topics"] },
      { key: "UNUSUAL_CASE_STUDIES", label: "Unusual case studies (public-safe)", use: ["topics", "dossier"] },
      {
        key: "PROPRIETARY_STATISTICS", label: "Approved proprietary statistics you're comfortable sharing publicly", use: ["dossier", "topics"],
        help: "Labelled as your company's own data — never mixed up with public research or presented as independently verified.",
      },
      { key: "COMMON_COMPETITOR_WEAKNESSES", label: "Questions competitors ignore", use: ["topics", "insider"] },
    ],
  },
  {
    key: "strategy",
    title: "Content strategy",
    why: "Shapes which topics rank first and how episodes are written — never what counts as true.",
    fields: [
      { key: "PREFERRED_TOPICS", label: "Topics you want covered", use: ["topics", "queries"] },
      { key: "EXCLUDED_TOPICS", label: "Topics to avoid (one per line)", use: ["exclude", "topics"] },
      { key: "TECHNICAL_DEPTH", label: "Technical depth (light / moderate / expert)", use: ["topics", "script"] },
      { key: "CONTROVERSY_TOLERANCE", label: "Controversy tolerance (avoid / balanced / willing to challenge)", use: ["topics", "script"] },
      { key: "EPISODE_LENGTH", label: "Preferred episode length in minutes", use: ["script"] },
      { key: "EPISODE_STYLE", label: "Episode style (explainer, investigation, playbook, debate…)", use: ["script", "topics"] },
      { key: "EVERGREEN_VS_TRENDING", label: "Evergreen vs trending balance", use: ["topics"] },
      { key: "PRIMARY_DISCOVERY_CHANNELS", label: "Where listeners find you (search, YouTube, LinkedIn, podcasts…)", use: ["queries", "topics"] },
      { key: "PREFERRED_CALL_TO_ACTION", label: "What should listeners do after an episode?", use: ["script"] },
    ],
  },
  {
    key: "research",
    title: "Research sources",
    why: "Tells research which sources to trust and which competitors to compare against.",
    fields: [
      { key: "TRUSTED_RESEARCH_SOURCES", label: "Industry sources you trust (domains or names)", use: ["queries", "dossier"] },
      { key: "IMPORTANT_PUBLICATIONS", label: "Important publications", use: ["queries"] },
      { key: "REGULATORY_AGENCIES", label: "Regulators and rules that matter", use: ["queries", "insider", "dossier"], gapWeight: 1 },
      { key: "COMPETITOR_COMPANIES", label: "Competitors", use: ["queries", "topics"] },
      { key: "COMPETITOR_PODCASTS", label: "Competing podcasts or channels", use: ["queries", "topics"] },
      { key: "RELEVANT_TECHNOLOGIES", label: "Relevant technologies", use: ["queries", "insider"] },
      { key: "INDUSTRY_REPORTS", label: "Industry reports worth reading", use: ["queries", "dossier"] },
      {
        key: "CUSTOMER_APPROVED_INTERNAL_DATA", label: "Internal data you approve for use", use: ["dossier"],
        help: "Treated as your company's data, cited as such, never as an independent source.",
      },
    ],
  },
];

export const ADVANCED_FIELDS: AdvancedField[] = ADVANCED_SECTIONS.flatMap((s) => s.fields);
const ADVANCED_KEYS = new Set(ADVANCED_FIELDS.map((f) => f.key));

/**
 * Adaptive follow-ups: `followups: { [questionId]: { question, answer, targetField?, skipped? } }`.
 * Skipped questions are kept so they are not asked again.
 */
export const FollowupSchema = z.object({
  question: text(500).min(1),
  answer: text(4000),
  targetField: z.string().max(64).optional(),
  why: text(300).optional(),
  skipped: z.boolean().optional(),
  askedAt: z.string().optional(),
});
export type Followup = z.infer<typeof FollowupSchema>;

export const AnswersSchema = z.object({
  fields: z
    .record(z.string(), text(4000))
    .refine((r) => Object.keys(r).every((k) => ADVANCED_KEYS.has(k)), "Unknown advanced field.")
    .default({}),
  followups: z.record(z.string().max(64), FollowupSchema).default({}),
});
export type BusinessAnswers = z.infer<typeof AnswersSchema>;

export function readAnswers(raw: unknown): BusinessAnswers {
  const parsed = AnswersSchema.safeParse(raw);
  return parsed.success ? parsed.data : { fields: {}, followups: {} };
}
