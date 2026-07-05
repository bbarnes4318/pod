// Client-safe sound-design vocabulary: types, constant lists, and tiny
// validators shared by server actions, the mix engine, and admin UIs.
// No Node imports here — this module ships to the browser.

export type ProductionStyle = "clean" | "light" | "full";
export type SfxDensity = "subtle" | "medium" | "hype";

export const PRODUCTION_STYLES: ProductionStyle[] = ["clean", "light", "full"];
export const SFX_DENSITIES: SfxDensity[] = ["subtle", "medium", "hype"];

export const PRODUCTION_STYLE_LABELS: Record<ProductionStyle, string> = {
  clean: "Clean — dialogue only, no production",
  light: "Light — theme in/out + topic stingers",
  full: "Full — themes, stingers, reactions, ducked music bed",
};

export const SFX_DENSITY_LABELS: Record<SfxDensity, string> = {
  subtle: "Subtle — rare, big beats only",
  medium: "Medium — regular emotional beats",
  hype: "Hype — frequent, air horns allowed",
};

export const ASSET_KINDS = ["theme_intro", "theme_outro", "stinger", "bed", "sfx", "highlight"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  theme_intro: "Intro theme",
  theme_outro: "Outro theme",
  stinger: "Stinger",
  bed: "Music bed",
  sfx: "Sound effect",
  highlight: "Game highlight (rights-gated)",
};

export const SFX_CATEGORIES = ["laugh", "crowd", "airhorn", "buzzer", "rimshot", "whoosh", "impact"] as const;
export type SfxCategoryId = (typeof SFX_CATEGORIES)[number];

export function isProductionStyle(v: unknown): v is ProductionStyle {
  return typeof v === "string" && (PRODUCTION_STYLES as string[]).includes(v);
}
export function isSfxDensity(v: unknown): v is SfxDensity {
  return typeof v === "string" && (SFX_DENSITIES as string[]).includes(v);
}

/** Per-episode settings stored in Episode.soundDesign. */
export interface EpisodeSoundDesign {
  style?: ProductionStyle;
  sfxDensity?: SfxDensity;
  /** Rights-gated game-highlight placements: cleared clip after a script beat. */
  highlights?: Array<{ lineIndex: number; assetId: string }>;
}

export function parseEpisodeSoundDesign(raw: unknown): EpisodeSoundDesign {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: EpisodeSoundDesign = {};
  if (isProductionStyle(o.style)) out.style = o.style;
  if (isSfxDensity(o.sfxDensity)) out.sfxDensity = o.sfxDensity;
  if (Array.isArray(o.highlights)) {
    const hl = o.highlights
      .filter(
        (h): h is { lineIndex: number; assetId: string } =>
          !!h &&
          typeof h === "object" &&
          Number.isInteger((h as Record<string, unknown>).lineIndex) &&
          typeof (h as Record<string, unknown>).assetId === "string"
      )
      .map((h) => ({ lineIndex: h.lineIndex, assetId: h.assetId }));
    if (hl.length > 0) out.highlights = hl;
  }
  return out;
}
