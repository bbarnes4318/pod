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
export const EPISODE_CONFIGURATION_SNAPSHOT_VERSION = 3 as const;

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
  version: 1 | 2 | 3;
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
