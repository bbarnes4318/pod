// The immutable configuration snapshot frozen into every Episode at creation.
//
// Why this exists: a show is editable. Its hosts, voices, verticals, and
// publishing policy can all change tomorrow. An episode built today must stay
// reproducible and auditable regardless — "how was THIS episode configured?"
// must have an answer that a later edit to the Podcast can never rewrite. So at
// creation we resolve the configuration (see podcastConfiguration.ts) and store
// a strict, versioned, deterministic, secret-free copy on the Episode.
//
// Three honesty rules this file enforces:
//   1. NO SECRETS. ownerEmail and any contact detail never enter a snapshot.
//   2. NO FABRICATION for legacy episodes. Episodes built before snapshots
//      existed get `source: "legacy"` and, when reconstructed for display, an
//      explicit `incomplete: true` — never a fake frozen config.
//   3. DETERMINISTIC. The fingerprint is computed over the configuration
//      material only (never the capture timestamp), key-order independent, so
//      the same configuration always fingerprints the same way.

import crypto from "node:crypto";
import { canonicalJson, type ResolvedEpisodeConfiguration, type Provenance } from "./podcastConfiguration";
import type { FrozenSoundProfile } from "./podcastSoundProfile";
import { DEFAULT_FORMAT_ID, getShowFormat, roleForSeat } from "../formats/showFormatRegistry";

// Version 2 (Prompt 6) adds the FROZEN SOUND PROFILE: the exact permitted
// intro/outro/bed/stinger/reaction assets (ids + content hashes + rights state
// at capture). Version-1 snapshots (Prompt 5 era) remain readable and are
// NEVER rewritten; their sound behavior resolves through the legacy
// compatibility path.
// Version 3 (Prompt 7) adds the SHOW FORMAT + pinned cast: which registered
// format (id + registry version) the episode was created under and which
// hosts were pinned into which seats. An empty pinned cast is honest — the
// remaining chairs are auto-cast at build time and recorded on the Script.
// v1/v2 snapshots stay readable and byte-stable (keys added only when present).
// Version 4 (Prompt 7.5) adds EXPLICIT FROZEN BOOKEND INTENT inside the frozen
// sound profile (production.soundProfile.introEnabled / .outroEnabled). This
// removes the v2/v3 ambiguity where "outro intentionally disabled" and "outro
// enabled but no asset assigned" both froze as `outro: null, excluded: []`. A
// v4 render REQUIRES an enabled bookend to be audible; a v2/v3 profile carries
// no explicit intent and keeps the documented compatibility behavior (never
// fabricate historical intent). v1/v2/v3 snapshots stay readable and BYTE/
// FINGERPRINT stable — the new keys live only inside newly frozen v4 profiles,
// and editorialMaterial serializes soundProfile exactly as stored.
export const EPISODE_CONFIGURATION_SNAPSHOT_VERSION = 4 as const;

export interface SnapshotCast {
  formatId: string;
  formatVersion: number;
  /** Pinned seats at creation time (may be empty = auto-cast at build). */
  members: Array<{ hostId: string; role: string; orderIndex: number }>;
}

/** Build the v3 cast section from a format id + the pinned seat order. An
 *  unknown format degrades to the default (defensive; the resolver already
 *  rejected it upstream). */
export function snapshotCastFor(formatId: string, pinnedHostIds: string[]): SnapshotCast {
  const format = getShowFormat(formatId) ?? getShowFormat(DEFAULT_FORMAT_ID)!;
  return {
    formatId: format.id,
    formatVersion: format.version,
    members: pinnedHostIds.slice(0, format.speakerMax).map((hostId, i) => ({
      hostId,
      role: roleForSeat(format, i).id,
      orderIndex: i,
    })),
  };
}

/** The persisted shape (stored in Episode.configurationSnapshot as JSON). */
export interface EpisodeConfigurationSnapshot {
  version: 1 | 2 | 3 | 4;
  /** Version 3+: the frozen show format + pinned cast. Absent on v1/v2. */
  cast?: SnapshotCast;
  source: "podcast" | "standalone" | "legacy";
  /** ISO-8601 capture time. Present for provenance; EXCLUDED from the fingerprint. */
  capturedAt: string;
  /** Set only when the snapshot was reconstructed for a pre-snapshot episode. */
  incomplete?: true;
  podcast: {
    id: string;
    configVersion: number;
    fingerprint: string | null;
    identity: {
      name: string;
      slug: string | null;
      description: string | null;
      author: string | null;
      language: string;
      category: string | null;
      subcategory: string | null;
      explicit: boolean;
      copyright: string | null;
      coverImageUrl: string | null;
      visibility: string;
      // NOTE: ownerName/ownerEmail are DELIBERATELY absent — no contact PII.
    };
  } | null;
  editorial: {
    verticals: string[];
    teams: string[];
    segmentCount: number;
    format: string;
    minDebateScore: number | null;
    scriptStyle: string | null;
    maxWords: number | null;
    provenance: Record<string, Provenance>;
  };
  production: {
    hostIds: string[];
    ttsProvider: string | null;
    ttsVoiceOverrides: unknown | null;
    productionStyle: string | null;
    sfxDensity: string | null;
    provenance: Record<string, Provenance>;
    /** Version 2+: the exact permitted sound assets, frozen at creation —
     *  ids, content hashes, roles, gains/fades, and rights/license state at
     *  capture. The planner may only pick from THIS pool. Never contains
     *  storage keys or URLs. Absent on version-1 snapshots. */
    soundProfile?: FrozenSoundProfile;
  };
}

/** What createEpisodeRecord persists onto the Episode row. */
export interface EpisodeSnapshotColumns {
  configurationSource: "podcast" | "standalone" | "legacy";
  podcastConfigurationVersion: number | null;
  configurationSnapshot: EpisodeConfigurationSnapshot;
  configurationFingerprint: string;
}

function editorialMaterial(s: EpisodeConfigurationSnapshot) {
  // The material the fingerprint covers: everything that shapes the episode plus
  // the public identity — never capturedAt, never provenance labels (provenance
  // describes WHERE a value came from, not the value itself).
  return {
    version: s.version,
    source: s.source,
    podcast: s.podcast,
    // v3: the format + pinned cast is configuration material. Key added only
    // when present so stored v1/v2 fingerprints stay byte-stable.
    ...(s.cast !== undefined ? { cast: s.cast } : {}),
    editorial: {
      verticals: s.editorial.verticals,
      teams: s.editorial.teams,
      segmentCount: s.editorial.segmentCount,
      format: s.editorial.format,
      minDebateScore: s.editorial.minDebateScore,
      scriptStyle: s.editorial.scriptStyle,
      maxWords: s.editorial.maxWords,
    },
    production: {
      hostIds: s.production.hostIds,
      ttsProvider: s.production.ttsProvider,
      ttsVoiceOverrides: s.production.ttsVoiceOverrides,
      productionStyle: s.production.productionStyle,
      sfxDensity: s.production.sfxDensity,
      // v2: the frozen sound profile is part of the fingerprint — a sound
      // change is a configuration change. The key is added ONLY when present
      // so re-fingerprinting a stored v1 snapshot still reproduces its
      // original hash byte-for-byte.
      ...(s.production.soundProfile !== undefined ? { soundProfile: s.production.soundProfile } : {}),
    },
  };
}

/** Deterministic fingerprint of a snapshot's configuration material. */
export function fingerprintEpisodeSnapshot(s: EpisodeConfigurationSnapshot): string {
  return crypto.createHash("sha256").update(canonicalJson(editorialMaterial(s))).digest("hex");
}

const provenanceOf = (f: { provenance: Provenance }): Provenance => f.provenance;

/**
 * Freeze a resolved episode configuration into the columns createEpisodeRecord
 * writes. Pure and deterministic given (resolved, capturedAt).
 */
export function buildEpisodeConfigurationSnapshot(
  resolved: ResolvedEpisodeConfiguration,
  capturedAt: Date,
  /** The frozen sound profile (Prompt 6). Callers on the creation path always
   *  pass one; version-2 snapshots carry it, and the planner may only pick
   *  from it. */
  soundProfile?: FrozenSoundProfile,
  /** The frozen show format + pinned cast (Prompt 7, snapshot v3). */
  cast?: SnapshotCast
): EpisodeSnapshotColumns {
  const snapshot: EpisodeConfigurationSnapshot = {
    version: EPISODE_CONFIGURATION_SNAPSHOT_VERSION,
    ...(cast ? { cast } : {}),
    source: resolved.source,
    capturedAt: capturedAt.toISOString(),
    podcast: resolved.identity
      ? {
          id: resolved.podcastId!,
          configVersion: resolved.podcastConfigurationVersion ?? 0,
          fingerprint: resolved.podcastConfigurationFingerprint,
          identity: {
            name: resolved.identity.name,
            slug: resolved.identity.slug,
            description: resolved.identity.description,
            author: resolved.identity.author,
            language: resolved.identity.language,
            category: resolved.identity.category,
            subcategory: resolved.identity.subcategory,
            explicit: resolved.identity.explicit,
            copyright: resolved.identity.copyright,
            coverImageUrl: resolved.identity.coverImageUrl,
            visibility: resolved.identity.visibility,
          },
        }
      : null,
    editorial: {
      verticals: resolved.editorial.verticals.value,
      teams: resolved.editorial.teams.value,
      segmentCount: resolved.editorial.segmentCount.value,
      format: resolved.editorial.format.value,
      minDebateScore: resolved.editorial.minDebateScore.value,
      scriptStyle: resolved.editorial.scriptStyle.value,
      maxWords: resolved.editorial.maxWords.value,
      provenance: {
        verticals: provenanceOf(resolved.editorial.verticals),
        teams: provenanceOf(resolved.editorial.teams),
        segmentCount: provenanceOf(resolved.editorial.segmentCount),
        format: provenanceOf(resolved.editorial.format),
        minDebateScore: provenanceOf(resolved.editorial.minDebateScore),
        scriptStyle: provenanceOf(resolved.editorial.scriptStyle),
        maxWords: provenanceOf(resolved.editorial.maxWords),
      },
    },
    production: {
      hostIds: resolved.production.hostIds.value,
      ttsProvider: resolved.production.ttsProvider.value,
      ttsVoiceOverrides: resolved.production.ttsVoiceOverrides.value,
      productionStyle: resolved.production.productionStyle.value,
      sfxDensity: resolved.production.sfxDensity.value,
      ...(soundProfile ? { soundProfile } : {}),
      provenance: {
        hostIds: provenanceOf(resolved.production.hostIds),
        ttsProvider: provenanceOf(resolved.production.ttsProvider),
        ttsVoiceOverrides: provenanceOf(resolved.production.ttsVoiceOverrides),
        productionStyle: provenanceOf(resolved.production.productionStyle),
        sfxDensity: provenanceOf(resolved.production.sfxDensity),
      },
    },
  };

  // LEVEL 2: never freeze a v4 profile that enables a bookend without an asset
  // or a recorded exclusion. Throws before the episode is created (belt-and-
  // suspenders behind the Level-1 save validation).
  if (soundProfile) assertFrozenBookendIntent(soundProfile);

  return {
    configurationSource: resolved.source,
    podcastConfigurationVersion: resolved.podcastConfigurationVersion,
    configurationSnapshot: snapshot,
    configurationFingerprint: fingerprintEpisodeSnapshot(snapshot),
  };
}

/**
 * Reconstruct an explicitly-incomplete view for an episode that predates
 * snapshots (configurationSource = "legacy", no stored snapshot). This is for
 * DISPLAY ONLY and is never written back — the whole point is to be honest that
 * we do not know how a legacy episode was configured, rather than fabricate it.
 */
// ---------------------------------------------------------------------------
// Canonical frozen-sound-profile resolver.
//
// A snapshot carries the episode's PERMITTED sound pool under
// production.soundProfile. Every version from v2 onward that legitimately has
// one stores it in the SAME place — the key was added conditionally so v1
// bytes stay stable, NOT because the shape changes per version. So this
// resolver keys on the PRESENCE + SHAPE of the profile, never on the version
// number. That is the whole point: a version bump (v2 -> v3, or any future
// version) must never silently drop a compatible frozen profile and let the
// episode fall back to the legacy global pool. (That exact
// `snap.version !== 2` bug made every post-Prompt-7 episode lose its identity.)
//
// A snapshot that CLAIMS a profile but whose profile is structurally invalid
// is reported as "corrupt" — the caller must fail honestly rather than render
// with the wrong sound pool. Absence of a profile (v1, or a v2+ snapshot built
// without one) is "none", which is legitimate and NOT corruption.
// ---------------------------------------------------------------------------

const FROZEN_SOUND_PROFILE_MODES = new Set(["system_default", "custom", "clean"]);

/** Structural validator for a frozen asset ref: the load-bearing fields the
 *  render/loader actually read must be the right primitive types. Optional
 *  mix/rights fields are tolerated (older captures may omit some). */
function isFrozenSoundAssetRef(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.assetId === "string" &&
    typeof r.kind === "string" &&
    typeof r.role === "string" &&
    Array.isArray(r.tags)
  );
}

/** True when `x` is a structurally valid FrozenSoundProfile. Tolerant of
 *  optional fields, strict on the fields the renderer depends on. */
export function isFrozenSoundProfile(x: unknown): x is FrozenSoundProfile {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.mode !== "string" || !FROZEN_SOUND_PROFILE_MODES.has(p.mode)) return false;
  // v4 bookend intent is OPTIONAL (absent on v2/v3); if present it must be boolean.
  if (p.introEnabled !== undefined && typeof p.introEnabled !== "boolean") return false;
  if (p.outroEnabled !== undefined && typeof p.outroEnabled !== "boolean") return false;
  const slotOk = (v: unknown) => v === null || v === undefined || isFrozenSoundAssetRef(v);
  if (!slotOk(p.intro) || !slotOk(p.outro) || !slotOk(p.bed)) return false;
  if (!Array.isArray(p.stingers) || !p.stingers.every(isFrozenSoundAssetRef)) return false;
  if (!Array.isArray(p.reactions) || !p.reactions.every(isFrozenSoundAssetRef)) return false;
  return true;
}

/**
 * The FROZEN bookend intent for a snapshot's sound profile:
 *   true / false  — v4 explicit intent (enabled / disabled);
 *   null          — v2/v3 profile with no frozen intent (compatibility path;
 *                   the render gate must NOT fabricate historical intent).
 */
export function frozenBookendEnabled(profile: FrozenSoundProfile, kind: "intro" | "outro"): boolean | null {
  const v = kind === "intro" ? profile.introEnabled : profile.outroEnabled;
  return typeof v === "boolean" ? v : null;
}

/**
 * LEVEL 2 (episode snapshot creation): refuse to freeze a v4 profile whose
 * bookend intent says ENABLED but carries neither a resolved asset nor a
 * structured exclusion reason. That is the "enabled but no asset assigned" state
 * v4 exists to make impossible — never silently convert it to disabled. Only
 * validates profiles that actually carry explicit v4 intent; v2/v3 profiles
 * (no intent) are left to the documented compatibility path.
 */
export function assertFrozenBookendIntent(profile: FrozenSoundProfile): void {
  for (const kind of ["intro", "outro"] as const) {
    const enabled = frozenBookendEnabled(profile, kind);
    if (enabled !== true) continue; // disabled or no-frozen-intent: nothing to assert
    const ref = kind === "intro" ? profile.intro : profile.outro;
    const excluded = profile.excluded.some((e) => e.role === kind);
    if (!ref && !excluded) {
      throw new Error(
        `Cannot freeze episode configuration: ${kind} is enabled in the sound profile but no ${kind} asset ` +
          `is assigned/resolved and no exclusion reason was recorded. Fix the show's sound profile (assign a ` +
          `${kind} or disable it) before creating the episode.`
      );
    }
  }
}

export type SnapshotSoundProfileStatus = "none" | "v1_legacy" | "frozen" | "corrupt";

export interface SnapshotSoundProfileResolution {
  profile: FrozenSoundProfile | null;
  status: SnapshotSoundProfileStatus;
}

/**
 * Resolve the frozen sound profile from an Episode.configurationSnapshot value
 * (as stored — `unknown`). This is the ONE place that decides whether an
 * episode has a usable frozen pool. Keyed on shape, not version number.
 *
 *   none       no snapshot, or a snapshot that legitimately carries no profile
 *              (v1, or a v2+ snapshot built without one) -> legacy behavior.
 *   v1_legacy  an explicit version-1 snapshot -> no frozen profile (legacy).
 *   frozen     production.soundProfile present and structurally valid, on ANY
 *              version >= 2 (v2, v3, and any future version) -> use it.
 *   corrupt    production.soundProfile present but structurally invalid ->
 *              the caller must fail honestly, never degrade to the global pool.
 */
export function resolveSnapshotSoundProfile(snapshot: unknown): SnapshotSoundProfileResolution {
  if (!snapshot || typeof snapshot !== "object") return { profile: null, status: "none" };
  const snap = snapshot as Partial<EpisodeConfigurationSnapshot> & { production?: { soundProfile?: unknown } };

  const raw = snap.production?.soundProfile;
  const hasProfileKey = snap.production != null && "soundProfile" in (snap.production as object) && raw != null;

  // Version 1 never carried a frozen profile. If somehow a soundProfile is
  // present on a v1 snapshot, honor it only when structurally valid (defensive)
  // — but the documented v1 contract is: no frozen profile, legacy path.
  if (snap.version === 1 && !hasProfileKey) return { profile: null, status: "v1_legacy" };

  if (!hasProfileKey) {
    // No profile captured. Legitimate for v1 and for profile-less v2+ snapshots.
    return { profile: null, status: snap.version === 1 ? "v1_legacy" : "none" };
  }

  if (isFrozenSoundProfile(raw)) return { profile: raw, status: "frozen" };

  // A profile was captured but its shape is broken. Do NOT silently fall back
  // to the legacy global pool — that is exactly how an episode ends up sounding
  // like an unrelated show. Report corruption so the caller can fail safely.
  return { profile: null, status: "corrupt" };
}

export function reconstructLegacySnapshot(episode: {
  hostIds: string[];
  ttsProvider: string | null;
  ttsVoiceOverrides: unknown | null;
  soundDesign: { style?: string; sfxDensity?: string } | null;
  createdAt: Date;
}): EpisodeConfigurationSnapshot {
  const snapshot: EpisodeConfigurationSnapshot = {
    version: EPISODE_CONFIGURATION_SNAPSHOT_VERSION,
    source: "legacy",
    capturedAt: episode.createdAt.toISOString(),
    incomplete: true,
    podcast: null,
    editorial: {
      verticals: [],
      teams: [],
      segmentCount: 0,
      format: "two_host_debate",
      minDebateScore: null,
      scriptStyle: null,
      maxWords: null,
      // Everything here is unknown for a legacy episode; we do not pretend a
      // provenance we cannot substantiate.
      provenance: {},
    },
    production: {
      hostIds: episode.hostIds ?? [],
      ttsProvider: episode.ttsProvider ?? null,
      ttsVoiceOverrides: episode.ttsVoiceOverrides ?? null,
      productionStyle: episode.soundDesign?.style ?? null,
      sfxDensity: episode.soundDesign?.sfxDensity ?? null,
      provenance: {},
    },
  };
  return snapshot;
}
