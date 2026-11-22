// Versioned, immutable business topic snapshot + the discriminated editorial
// packet shared production resolves.
//
// Sports episodes keep their V1 EpisodeTopic snapshots, untouched. Business
// episodes freeze their dossier here, on BusinessEpisodeTopic, so a later
// dossier edit or re-research can never change what an episode was written
// from. The readiness gate checks business requirements (verified facts,
// independent origins, story structure) — never sport, league, betting,
// injuries or two opposing hosts' arguments.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { EpisodeTopicSnapshot } from "../services/topicSnapshot";
import type { DossierContent } from "./businessDossier";

export const BUSINESS_TOPIC_SNAPSHOT_VERSION = 1 as const;

const fact = z.object({
  id: z.string(), claim: z.string(), sourceId: z.string(), quote: z.string(), url: z.string(),
  publisher: z.string().nullable(), authority: z.string(), kind: z.enum(["context", "fact", "statistic", "expert", "misconception"]),
  asOf: z.string().nullable().optional(),
});
export type SnapshotFact = z.infer<typeof fact>;

export const BusinessTopicSnapshotV1Schema = z.object({
  kind: z.literal("business"),
  version: z.literal(1),
  opportunityId: z.string(),
  dossierId: z.string(),
  dossierVersion: z.number().int(),
  dossierFingerprint: z.string(),
  selectionTimestamp: z.string(),
  title: z.string().min(1),
  category: z.string(),
  businessNiche: z.string(),
  targetListener: z.string(),
  centralQuestion: z.string(),
  listenerPromise: z.string(),
  premise: z.string(),
  hook: z.string(),
  takeaway: z.string(),
  facts: z.array(fact),
  mechanisms: z.array(z.object({ explanation: z.string(), sourceIds: z.array(z.string()) })),
  originalAnalysis: z.array(z.object({
    finding: z.string(), method: z.string(), result: z.string(), status: z.enum(["completed", "proposed"]),
    inputs: z.array(z.object({ label: z.string(), value: z.string(), sourceId: z.string().nullable(), hypothetical: z.boolean() })),
  })),
  practicalApplications: z.array(z.string()),
  workedExamples: z.array(z.object({ title: z.string(), steps: z.array(z.string()), hypothetical: z.boolean(), sourceIds: z.array(z.string()) })),
  competingInterpretations: z.array(z.object({ view: z.string(), sourceIds: z.array(z.string()) })),
  uncertainties: z.array(z.string()),
  storyStructure: z.array(z.object({ beat: z.string(), purpose: z.string() })),
  factCheckRequirements: z.array(z.string()),
  sources: z.array(z.object({ id: z.string(), url: z.string(), title: z.string().nullable(), publisher: z.string().nullable(), publishedAt: z.string().nullable(), retrievedAt: z.string(), originKey: z.string() })),
  /** Style inputs from the profile. Shape writing only — never facts. */
  style: z.object({
    businessName: z.string(), industry: z.string(), audiences: z.array(z.string()),
    terminology: z.string().nullable(), technicalDepth: z.string().nullable(), episodeStyle: z.string().nullable(),
    controversyTolerance: z.string().nullable(), callToAction: z.string().nullable(), lengthMinutes: z.number().nullable(),
  }),
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BusinessTopicSnapshotV1 = z.infer<typeof BusinessTopicSnapshotV1Schema>;

export type BusinessSnapshotParse =
  | { status: "valid"; snapshot: BusinessTopicSnapshotV1 }
  | { status: "missing" | "unsupported_version" | "corrupt"; reason: string };

export function parseBusinessSnapshot(raw: unknown): BusinessSnapshotParse {
  if (raw == null) return { status: "missing", reason: "no snapshot" };
  if (typeof raw !== "object") return { status: "corrupt", reason: "snapshot is not an object" };
  const r = raw as { kind?: unknown; version?: unknown };
  if (r.kind !== "business") return { status: "corrupt", reason: "not a business snapshot" };
  if (r.version !== BUSINESS_TOPIC_SNAPSHOT_VERSION) return { status: "unsupported_version", reason: `business snapshot version ${String(r.version)} is not supported` };
  const p = BusinessTopicSnapshotV1Schema.safeParse(raw);
  return p.success ? { status: "valid", snapshot: p.data } : { status: "corrupt", reason: p.error.issues[0]?.message ?? "invalid" };
}

export function evidenceFingerprint(facts: SnapshotFact[], sources: { id: string; url: string }[]): string {
  const canon = JSON.stringify({ f: facts.map((f) => [f.id, f.claim, f.sourceId, f.quote]), s: sources.map((s) => [s.id, s.url]) });
  return createHash("sha256").update(canon).digest("hex");
}

export interface SnapshotInputs {
  opportunity: { id: string; title: string; category: string; businessNiche: string; targetListener: string };
  dossier: { id: string; version: number; fingerprint: string | null; content: DossierContent };
  style: BusinessTopicSnapshotV1["style"];
  selectedAt: Date;
}

export function buildBusinessSnapshot(x: SnapshotInputs): BusinessTopicSnapshotV1 {
  const c = x.dossier.content;
  let n = 0;
  const tag = (items: DossierContent["verifiedFacts"], kind: SnapshotFact["kind"]): SnapshotFact[] =>
    items.map((i) => ({ id: `F${++n}`, claim: i.claim, sourceId: i.sourceId, quote: i.quote, url: i.url, publisher: i.publisher, authority: i.authority, kind, asOf: i.asOf ?? null }));
  const facts = [
    ...tag(c.industryContext, "context"), ...tag(c.verifiedFacts, "fact"), ...tag(c.verifiedStatistics, "statistic"), ...tag(c.expertDetails, "expert"),
    ...c.misconceptions.map((m) => ({ id: `F${++n}`, claim: `Misconception: "${m.myth}". Reality: ${m.reality}`, sourceId: m.sourceId, quote: m.quote, url: m.url, publisher: null, authority: "INDEPENDENT", kind: "misconception" as const, asOf: null })),
  ];
  const sources = c.sourceReferences;
  return {
    kind: "business", version: 1,
    opportunityId: x.opportunity.id, dossierId: x.dossier.id, dossierVersion: x.dossier.version,
    dossierFingerprint: x.dossier.fingerprint ?? "",
    selectionTimestamp: x.selectedAt.toISOString(),
    title: x.opportunity.title, category: x.opportunity.category, businessNiche: x.opportunity.businessNiche,
    targetListener: c.targetListener || x.opportunity.targetListener,
    centralQuestion: c.centralQuestion, listenerPromise: c.listenerPromise, premise: c.premise, hook: c.hook, takeaway: c.takeaway,
    facts, mechanisms: c.mechanisms, originalAnalysis: c.originalAnalysis, practicalApplications: c.practicalApplications,
    workedExamples: c.workedExamples, competingInterpretations: c.competingInterpretations, uncertainties: c.uncertainties,
    storyStructure: c.storyStructure, factCheckRequirements: c.factCheckRequirements, sources,
    style: x.style,
    evidenceFingerprint: evidenceFingerprint(facts, sources),
  };
}

// ---------------------------------------------------------------------------
// Business script readiness (pure)
// ---------------------------------------------------------------------------

export interface ReadinessResult { ok: boolean; reasons: string[] }

export function evaluateBusinessScriptReadiness(snapshot: BusinessTopicSnapshotV1): ReadinessResult {
  const reasons: string[] = [];
  const statements = snapshot.facts.filter((f) => f.kind !== "context");
  if (statements.length < 3) reasons.push(`Only ${statements.length} verified fact(s); a business episode needs at least 3.`);
  const origins = new Set(snapshot.facts.map((f) => snapshot.sources.find((s) => s.id === f.sourceId)?.originKey).filter(Boolean));
  if (origins.size < 2) reasons.push(`Facts come from ${origins.size} independent origin(s); at least 2 are needed.`);
  if (snapshot.facts.some((f) => !snapshot.sources.some((s) => s.id === f.sourceId))) reasons.push("A fact cites a source missing from the snapshot.");
  if (!snapshot.hook.trim()) reasons.push("Dossier has no episode hook.");
  if (snapshot.storyStructure.length < 3) reasons.push("Dossier story structure has fewer than 3 beats.");
  if (evidenceFingerprint(snapshot.facts, snapshot.sources) !== snapshot.evidenceFingerprint) reasons.push("Snapshot evidence fingerprint does not match its contents.");
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// The editorial packet shared production dispatches on
// ---------------------------------------------------------------------------

export type EditorialPacket =
  | { kind: "SPORTS"; topicCount: number; snapshots: (EpisodeTopicSnapshot | null)[] }
  | { kind: "BUSINESS"; topicCount: number; snapshots: BusinessTopicSnapshotV1[]; problems: string[] };

/**
 * Decide which engine an episode belongs to from its podcast type AND its topic
 * links. Mixed or mismatched links are refused — a business episode can never
 * reach sports topics or vice versa.
 */
export function resolveEditorialPacket(ep: {
  podcast?: { intelligenceType?: string | null } | null;
  topics?: { id?: string; snapshot?: unknown }[];
  businessTopics?: { snapshot: unknown }[];
}): EditorialPacket {
  const isBusiness = ep.podcast?.intelligenceType === "BUSINESS";
  const sports = ep.topics ?? [];
  const biz = ep.businessTopics ?? [];
  if (isBusiness && sports.length > 0) throw new Error("A business episode is linked to sports topics; refusing to produce it.");
  if (!isBusiness && biz.length > 0) throw new Error("A sports episode is linked to business topics; refusing to produce it.");
  if (!isBusiness) return { kind: "SPORTS", topicCount: sports.length, snapshots: sports.map((t) => (t.snapshot as EpisodeTopicSnapshot) ?? null) };
  const problems: string[] = [];
  const snapshots: BusinessTopicSnapshotV1[] = [];
  for (const t of biz) {
    const p = parseBusinessSnapshot(t.snapshot);
    if (p.status === "valid") snapshots.push(p.snapshot);
    else problems.push(`Business topic snapshot ${p.status}: ${p.reason}`);
  }
  return { kind: "BUSINESS", topicCount: biz.length, snapshots, problems };
}
