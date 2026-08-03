// Which speech providers a RELEASE actually depends on.
//
// Production renders with Fish, at s2.1-pro-free. ElevenLabs is an adapter this
// codebase supports, not a provider production requires — so an unconfigured
// ElevenLabs must never block a Fish release.
//
// That distinction used to be missing: both the canary and the readiness
// preflight treated "fish,elevenlabs" as the mandatory set, which meant a
// release could be refused for a provider production does not use. The two
// lists below make the difference explicit and keep the canary and the
// preflight reading the SAME definition, so they cannot drift apart.
//
//   REQUIRED  must be configured and must work. A failure here fails the run.
//   OPTIONAL  exercised when configured; reported as `skipped` when it is not.
//             Never a failure on its own.
//
// Making ElevenLabs mandatory is a deliberate act: add it to
// PRODUCTION_REQUIRED_TTS_PROVIDERS.

export type TtsProviderId = string;

/** Production's real speech provider. */
export const DEFAULT_REQUIRED_TTS_PROVIDERS: readonly TtsProviderId[] = ["fish"];

/** Supported adapters that are checked opportunistically, never demanded. */
export const DEFAULT_OPTIONAL_TTS_PROVIDERS: readonly TtsProviderId[] = ["elevenlabs"];

/** Providers this repository can actually build a scene for. */
export const SUPPORTED_TTS_PROVIDERS: readonly TtsProviderId[] = ["fish", "elevenlabs"];

export const REQUIRED_TTS_PROVIDERS_VAR = "PRODUCTION_REQUIRED_TTS_PROVIDERS";
export const OPTIONAL_TTS_PROVIDERS_VAR = "CANARY_OPTIONAL_TTS_PROVIDERS";

export interface TtsProviderPolicy {
  /** Must be configured AND must work. */
  required: TtsProviderId[];
  /** Exercised only if configured; a missing one is `skipped`. */
  optional: TtsProviderId[];
  /** Named in configuration but not buildable — a configuration error. */
  unknown: string[];
  /** True when the operator explicitly chose the required set. */
  requiredExplicit: boolean;
}

function parseList(raw: string | undefined | null): string[] {
  return (raw || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve the release's speech-provider policy.
 *
 * `CANARY_REQUIRED_PROVIDERS` is still honoured as a legacy alias so an existing
 * invocation keeps working, but it no longer defaults to including ElevenLabs.
 */
export function resolveTtsProviderPolicy(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): TtsProviderPolicy {
  const rawRequired =
    (env[REQUIRED_TTS_PROVIDERS_VAR] as string | undefined) ||
    (env.CANARY_REQUIRED_PROVIDERS as string | undefined) ||
    "";
  const requiredExplicit = Boolean(rawRequired.trim());
  const requestedRequired = requiredExplicit ? parseList(rawRequired) : [...DEFAULT_REQUIRED_TTS_PROVIDERS];

  const rawOptional = env[OPTIONAL_TTS_PROVIDERS_VAR] as string | undefined;
  const requestedOptional = rawOptional !== undefined && rawOptional !== null && rawOptional.trim() !== ""
    ? parseList(rawOptional)
    : [...DEFAULT_OPTIONAL_TTS_PROVIDERS];

  const unknown: string[] = [];
  const required: TtsProviderId[] = [];
  for (const p of requestedRequired) {
    if (SUPPORTED_TTS_PROVIDERS.includes(p)) required.push(p);
    else unknown.push(p);
  }

  const optional: TtsProviderId[] = [];
  for (const p of requestedOptional) {
    // A provider cannot be both. Required wins — it is the stronger claim.
    if (required.includes(p)) continue;
    if (SUPPORTED_TTS_PROVIDERS.includes(p)) optional.push(p);
    // An unknown OPTIONAL provider is simply ignored: it demands nothing, so it
    // cannot break a release, and refusing one would re-create the coupling this
    // module exists to remove.
  }

  return { required: [...new Set(required)], optional: [...new Set(optional)], unknown, requiredExplicit };
}

/** True when ElevenLabs was explicitly promoted to a release requirement. */
export function elevenLabsIsRequired(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): boolean {
  return resolveTtsProviderPolicy(env).required.includes("elevenlabs");
}
