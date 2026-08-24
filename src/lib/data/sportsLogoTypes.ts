// Shape of the generated sports-logo manifest.
//
// Kept in its own module so the generated file (500+ teams of JSON) can be
// imported for its data without dragging a type declaration through the
// generator, and so a consumer that only needs the types never pulls the
// payload into its bundle.

export interface LogoTeam {
  /** Folder name under public/sports-logos — the stable id for a team here. */
  slug: string;
  /** Display name, e.g. "Kansas City Chiefs" / "Texas A&M Aggies". */
  name: string;
  /** Abbreviation the logo files are named for, e.g. "KC". */
  abbr: string;
  /** Public path to the variant chosen for a dark surface. */
  logo: string;
  /** The mark needs a light plate behind it to be legible. */
  plate: boolean;
  /** Team primary colour from the folder's colors.txt, when present. */
  primary?: string;
  alternate?: string;
}

export interface LogoConference {
  slug: string;
  name: string;
  /** Nav-sized name: "SEC", "Big Ten", "C-USA". */
  shortName: string;
  logo?: string;
  plate?: boolean;
  teams: LogoTeam[];
}

export interface LogoLeague {
  /** League.id in the database — how a take is attributed to a league. */
  id: string;
  name: string;
  /** Nav-sized name: "NFL", "CFB". */
  shortName: string;
  sport: string;
  slug: string;
  logo?: string;
  plate?: boolean;
  /** Empty for the pro leagues; populated for college. */
  conferences: LogoConference[];
  /** Every team in the league, flattened (college included). */
  teams: LogoTeam[];
}
