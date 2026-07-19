// Asset CUE METADATA + verification state (PR 2).
//
// Admin-reviewed creative metadata for an AudioAsset, stored in
// AudioAsset.cueMetadata (JSON) and gated by AudioAsset.metadataState. NO
// musical facts are fabricated: metadata is authoritative for HARD
// compatibility decisions ONLY when `metadataState === "verified"`. "suggested"
// values may be displayed but never silently treated as verified;
// "unclassified" assets carry no creative metadata at all.
//
// This PR does NOT build automated musical-analysis infrastructure — a human
// (admin) sets/verifies these values.

export const METADATA_STATES = ["unclassified", "suggested", "verified"] as const;
export type MetadataState = (typeof METADATA_STATES)[number];

export function isMetadataState(x: unknown): x is MetadataState {
  return typeof x === "string" && (METADATA_STATES as readonly string[]).includes(x);
}

/** Per-slot suitability (true = suitable, false = unsuitable, undefined = unknown). */
export interface CueSuitability {
  broadcast?: string[];   // broadcast styles this asset suits (validated tags)
  formats?: string[];     // show format ids this asset suits
  underSpeech?: boolean;  // safe to play beneath active speech
  intro?: boolean;
  outro?: boolean;
  bed?: boolean;
  transition?: boolean;
  reaction?: boolean;
}

export interface CueMetadata {
  cueFamily?: string | null;      // proposed/verified creative family (validated against role elsewhere)
  genre?: string | null;
  moods?: string[];
  energy?: string | null;
  bpm?: number | null;
  instrumentation?: string[];
  vocals?: boolean;
  suitability?: CueSuitability;
}

const TAG = /^[a-z0-9][a-z0-9 _/&-]{0,39}$/i;
const tagArr = (v: unknown): string[] | null => {
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && TAG.test(s))) return null;
  return v as string[];
};

export type CueMetadataError =
  | { code: "not_object" }
  | { code: "invalid_tag"; field: string }
  | { code: "invalid_bpm" };

/**
 * Validate + normalize admin-supplied cue metadata. Pure; no fabrication.
 * Bad tag arrays / bpm are rejected with a structured error.
 */
export function validateCueMetadata(
  input: unknown
): { ok: true; metadata: CueMetadata } | { ok: false; error: CueMetadataError } {
  if (!input || typeof input !== "object") return { ok: false, error: { code: "not_object" } };
  const i = input as Record<string, unknown>;

  const moods = tagArr(i.moods);
  if (moods === null) return { ok: false, error: { code: "invalid_tag", field: "moods" } };
  const instrumentation = tagArr(i.instrumentation);
  if (instrumentation === null) return { ok: false, error: { code: "invalid_tag", field: "instrumentation" } };

  let bpm: number | null = null;
  if (i.bpm != null) {
    if (typeof i.bpm !== "number" || !Number.isFinite(i.bpm) || i.bpm <= 0 || i.bpm > 400) {
      return { ok: false, error: { code: "invalid_bpm" } };
    }
    bpm = i.bpm;
  }

  const sIn = (i.suitability ?? {}) as Record<string, unknown>;
  const broadcast = tagArr(sIn.broadcast);
  if (broadcast === null) return { ok: false, error: { code: "invalid_tag", field: "suitability.broadcast" } };
  const formats = tagArr(sIn.formats);
  if (formats === null) return { ok: false, error: { code: "invalid_tag", field: "suitability.formats" } };
  const boolOf = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

  return {
    ok: true,
    metadata: {
      cueFamily: typeof i.cueFamily === "string" ? i.cueFamily : null,
      genre: typeof i.genre === "string" && TAG.test(i.genre) ? i.genre : null,
      moods,
      energy: typeof i.energy === "string" && TAG.test(i.energy) ? i.energy : null,
      bpm,
      instrumentation,
      vocals: boolOf(i.vocals),
      suitability: {
        broadcast, formats,
        underSpeech: boolOf(sIn.underSpeech),
        intro: boolOf(sIn.intro), outro: boolOf(sIn.outro), bed: boolOf(sIn.bed),
        transition: boolOf(sIn.transition), reaction: boolOf(sIn.reaction),
      },
    },
  };
}

/** VERIFIED metadata only — the sole authoritative source for hard decisions.
 *  Returns null unless metadataState is "verified" and metadata validates. */
export function verifiedCueMetadata(asset: { metadataState?: string | null; cueMetadata?: unknown }): CueMetadata | null {
  if (asset.metadataState !== "verified") return null;
  const r = validateCueMetadata(asset.cueMetadata);
  return r.ok ? r.metadata : null;
}
