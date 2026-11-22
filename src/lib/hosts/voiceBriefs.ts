// Which Fish Voice Design brief belongs to a host.
//
// The sports catalog (sportsCharacterPack.ts) ships a written voice brief for
// every character, but the seed deliberately does not copy it into the
// database: it is direction for creating the voice, not part of the character.
// This looks it up so Host Studio can open the voice designer already filled in
// with the brief written for that character.

import { SPORTS_CHARACTER_PACK } from "./sportsCharacterPack";

export interface HostVoiceBrief {
  /** Sent to Fish as the voice description. */
  description: string;
  /** The line each designed take speaks. */
  testLine: string;
  tags: string[];
}

const BY_SLUG = new Map(SPORTS_CHARACTER_PACK.map((character) => [character.slug, character]));
const BY_NAME = new Map(SPORTS_CHARACTER_PACK.map((character) => [character.name.trim().toLowerCase(), character]));

/**
 * The catalog brief for a host, or null for hosts that are not catalog
 * characters. Matches the seeded slug first, then a roster copy's slug (a copy
 * gets `<slug>-<suffix>`), then the exact name.
 */
export function voiceBriefForHost(host: { slug?: string | null; name: string }): HostVoiceBrief | null {
  const slug = (host.slug || "").trim().toLowerCase();
  let character = slug ? BY_SLUG.get(slug) : undefined;
  if (!character && slug) {
    character = SPORTS_CHARACTER_PACK.find((entry) => slug.startsWith(`${entry.slug}-`));
  }
  if (!character) character = BY_NAME.get(host.name.trim().toLowerCase());
  if (!character) return null;
  return {
    description: character.fishVoiceDesign.description,
    testLine: character.fishVoiceDesign.previewText,
    tags: [...character.fishVoiceDesign.tags],
  };
}
