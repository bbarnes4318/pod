// Client-safe host-casting helpers: pure functions with no DB import, so they
// ship to the browser and to unit tests without pulling server-only env.
// The DB-backed resolver lives in ./hostCasting.

export interface CastHost {
  id: string;
  name: string;
}

/** Do this episode's stored/generated speaker names/ids match the given cast?
 *  Used by validators to accept whatever two hosts the episode was cast with,
 *  never a hardcoded pair. */
export function makeSpeakerMatchers<T extends CastHost>({ hostA, hostB }: { hostA: T; hostB: T }) {
  const byLowerName = new Map<string, T>([
    [hostA.name.toLowerCase(), hostA],
    [hostB.name.toLowerCase(), hostB],
  ]);
  return {
    /** The cast host whose chair this speakerName occupies, or null. */
    hostForSpeaker(speakerName: unknown): T | null {
      if (typeof speakerName !== "string") return null;
      return byLowerName.get(speakerName.trim().toLowerCase()) ?? null;
    },
    isValidSpeaker(speakerName: unknown): boolean {
      return this.hostForSpeaker(speakerName) !== null;
    },
    /** hostId that should be attached to a line spoken by speakerName. */
    expectedHostId(speakerName: unknown): string | null {
      return this.hostForSpeaker(speakerName)?.id ?? null;
    },
    hostNames: [hostA.name, hostB.name] as const,
  };
}
