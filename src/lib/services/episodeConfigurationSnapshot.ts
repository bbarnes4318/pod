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

export const EPISODE_CONFIGURATION_SNAPSHOT_VERSION = 1 as const;

/** The persisted shape (stored in Episode.configurationSnapshot as JSON). */
export interface EpisodeConfigurationSnapshot {
  version: 1;
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
    // Concrete sound-design asset IDs are NOT frozen here: they are chosen by
    // the production planner at mix time from the shared, non-owned crate.
    // Recording the style + density (the actual per-show inputs) is honest;
    // inventing asset IDs the show never selected would not be.
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
  capturedAt: Date
): EpisodeSnapshotColumns {
  const snapshot: EpisodeConfigurationSnapshot = {
    version: EPISODE_CONFIGURATION_SNAPSHOT_VERSION,
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
