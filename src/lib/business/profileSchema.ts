// The Business Intelligence Profile contract.
//
// Three layers, each validated here and nowhere else:
//   essentials — Level 1, real BusinessProfile columns.
//   findings   — what discovery (or the user) established, each with provenance.
//   answers    — Level 3/4 advanced sections + adaptive follow-ups, in the
//                user's own words.
//
// Provenance is the whole point: nothing AI-produced is ever presented as a
// fact unless it was verified against a fetched source, and the user can
// accept, edit or reject every finding.

import { z } from "zod";

export const INDUSTRIES = [
  "Insurance", "Real Estate", "Telecommunications", "Healthcare", "Technology",
  "Finance", "Construction", "Legal Services", "Automotive", "Retail",
  "Marketing", "Manufacturing", "Hospitality", "Education", "Entertainment",
  "Home Services", "Other",
] as const;

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
const list = (max: number) => z.array(text(120).min(1)).max(max);

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
    subIndustries: list(12).default([]),
    targetAudiences: list(15).min(1, "Pick at least one audience."),
    primaryGoal: z.enum(PODCAST_GOALS),
    geographicMarkets: list(10).default([]),
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

export const PROVENANCE = ["USER_CONFIRMED", "SOURCE_VERIFIED", "AI_INFERRED", "UNKNOWN"] as const;
export type Provenance = (typeof PROVENANCE)[number];

/** Fields discovery may populate (directive §6). */
export const FINDING_FIELDS = [
  "BUSINESS_OVERVIEW", "BUSINESS_MODEL", "INDUSTRY_CLASSIFICATION", "SUB_INDUSTRIES",
  "PRODUCTS", "SERVICES", "TARGET_CUSTOMERS", "CUSTOMER_PROBLEMS", "CUSTOMER_OUTCOMES",
  "COMPETITIVE_DIFFERENTIATORS", "INDUSTRY_TERMINOLOGY", "GEOGRAPHIC_COVERAGE",
  "PUBLIC_PRICING", "COMPETITORS", "RELATED_INDUSTRIES", "REGULATORY_CONTEXT",
  "CUSTOMER_QUESTIONS", "RESEARCH_OPPORTUNITIES",
] as const;
export type FindingField = (typeof FINDING_FIELDS)[number];

export const ProfileFindingSchema = z.object({
  id: z.string().min(1).max(64),
  field: z.enum(FINDING_FIELDS),
  value: text(1000).min(1),
  provenance: z.enum(PROVENANCE),
  /** Verbatim text from the source that supports `value` (SOURCE_VERIFIED only). */
  evidenceQuote: text(500).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  retrievedAt: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["pending", "accepted", "rejected"]),
});
export type ProfileFinding = z.infer<typeof ProfileFindingSchema>;

export const FindingsSchema = z.array(ProfileFindingSchema).max(200);

/** Read stored findings; a corrupt blob reads as empty rather than crashing a page. */
export function readFindings(raw: unknown): ProfileFinding[] {
  const parsed = FindingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// ---------------------------------------------------------------------------
// Advanced answers (Level 3/4). Sections and field keys are fixed so the
// research stages can rely on them; values are free text in the user's words.
// ---------------------------------------------------------------------------

export interface AdvancedField {
  key: string;
  label: string;
  help?: string;
}
export interface AdvancedSection {
  key: string;
  title: string;
  why: string;
  fields: AdvancedField[];
}

export const ADVANCED_SECTIONS: AdvancedSection[] = [
  {
    key: "insider",
    title: "Insider knowledge",
    why: "This is what separates a useful show from a generic AI summary. Only share what you're comfortable making public.",
    fields: [
      { key: "INSIDER_KNOWLEDGE", label: "What does your business understand that most outsiders don't?" },
      { key: "INDUSTRY_MISCONCEPTIONS", label: "What do customers frequently misunderstand about your industry?" },
      { key: "COMMON_EXPENSIVE_MISTAKES", label: "What costly mistakes do people repeatedly make?" },
      { key: "COMMON_COMPETITOR_WEAKNESSES", label: "What does your competition rarely explain?" },
      { key: "OVERLOOKED_INDUSTRY_PROBLEMS", label: "What industry practices deserve closer investigation?" },
      { key: "IMPORTANT_INDUSTRY_METRICS", label: "Which numbers actually decide success in your business?" },
      { key: "PROPRIETARY_STATISTICS", label: "Internal statistics or case studies you're comfortable sharing publicly", help: "Marked as approved proprietary data — never mixed up with public research." },
    ],
  },
  {
    key: "audience",
    title: "Audience intelligence",
    why: "Research ranks topics by what your listeners need, not what's generally popular.",
    fields: [
      { key: "AUDIENCE_JOB_TITLES", label: "Job titles or roles of your ideal listeners" },
      { key: "AUDIENCE_KNOWLEDGE_LEVEL", label: "How much do they already know? (beginner → expert)" },
      { key: "AUDIENCE_TOP_PROBLEMS", label: "What problems do your ideal listeners struggle with most?" },
      { key: "AUDIENCE_DESIRED_OUTCOMES", label: "What would they pay to understand or solve?" },
      { key: "AUDIENCE_QUESTIONS", label: "Questions they ask you most often" },
    ],
  },
  {
    key: "specialization",
    title: "Business specialization",
    why: "Specific niches produce specific research.",
    fields: [
      { key: "CORE_SPECIALTIES", label: "Core specialties" },
      { key: "MICRO_NICHES", label: "Micro-niches you serve" },
      { key: "BUSINESS_DIFFERENTIATORS", label: "What makes you different" },
      { key: "PROPRIETARY_METHODS", label: "Proprietary methods or technology" },
    ],
  },
  {
    key: "industry",
    title: "Industry context",
    why: "Tells research which sources to trust and which competitors to compare against.",
    fields: [
      { key: "COMPETITOR_COMPANIES", label: "Competitors" },
      { key: "COMPETITOR_PODCASTS", label: "Competing podcasts or channels" },
      { key: "TRUSTED_RESEARCH_SOURCES", label: "Publications, associations or data sources you trust" },
      { key: "REGULATORY_AGENCIES", label: "Regulators and rules that matter" },
    ],
  },
  {
    key: "preferences",
    title: "Podcast preferences",
    why: "Shapes how episodes are written — never what counts as true.",
    fields: [
      { key: "TECHNICAL_DEPTH", label: "Technical depth (light / moderate / expert)" },
      { key: "PREFERRED_TOPICS", label: "Topics you want covered" },
      { key: "EXCLUDED_TOPICS", label: "Topics to avoid" },
      { key: "PREFERRED_CALL_TO_ACTION", label: "What should listeners do after an episode?" },
    ],
  },
];

const ADVANCED_KEYS = new Set(ADVANCED_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)));

/** Answers: { FIELD_KEY: "user's words" } plus adaptive follow-ups under
 *  `followups: { [questionId]: { question, answer } }`. */
export const AnswersSchema = z.object({
  fields: z
    .record(z.string(), text(4000))
    .refine((r) => Object.keys(r).every((k) => ADVANCED_KEYS.has(k)), "Unknown advanced field.")
    .default({}),
  followups: z
    .record(z.string().max(64), z.object({ question: text(500).min(1), answer: text(4000) }))
    .default({}),
});
export type BusinessAnswers = z.infer<typeof AnswersSchema>;

export function readAnswers(raw: unknown): BusinessAnswers {
  const parsed = AnswersSchema.safeParse(raw);
  return parsed.success ? parsed.data : { fields: {}, followups: {} };
}
