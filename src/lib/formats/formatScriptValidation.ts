// Format-driven script balance policy (Prompt 7, PR 2).
//
// One policy source: each format chair declares its approval-time minimum
// line share in the registry (minLineSharePct). The script GENERATION gate
// runs at 0.8x that floor — for the two-host debate that reproduces the
// engine's historical pair exactly (approval 25%, generation 20%), so the
// existing format's behavior is unchanged.

import type { ShowFormat } from "./showFormatRegistry";
import { roleForSeat } from "./showFormatRegistry";

/**
 * STRUCTURAL format rules (Prompt 7 completion): enforce each format's
 * lineRules against the final script — a rapid-fire answer over the word cap,
 * a documentary that does not open/close on the narrator, or an expert who
 * speaks less than the host is a VALIDATION FAILURE, not a style nuance.
 * Returns null when the structure holds, else a human-readable failure.
 */
export function checkFormatStructure(
  format: ShowFormat,
  flatLines: Array<{ speakerHostId?: string; text: string }>,
  cast: Array<{ id: string; name: string }>
): string | null {
  if (flatLines.length === 0) return null;
  const rules = format.lineRules ?? {};
  const seatOf = (hostId?: string) => cast.findIndex((h) => h.id === hostId);
  const roleOf = (hostId?: string) => {
    const seat = seatOf(hostId);
    return seat >= 0 ? roleForSeat(format, seat).id : null;
  };
  const words = (t: string) => t.replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/).filter(Boolean).length;

  if (rules.maxWordsPerLine) {
    const over = flatLines.filter((l) => words(l.text) > rules.maxWordsPerLine!);
    // Tolerate a single outlier (models drift); more is a structural failure.
    if (over.length > 1) {
      return `Format structure failed: ${over.length} line(s) exceed the ${format.displayName} cap of ${rules.maxWordsPerLine} words per line.`;
    }
  }
  if (rules.openingRole) {
    const first = roleOf(flatLines[0].speakerHostId);
    if (first !== rules.openingRole) {
      return `Format structure failed: the ${format.displayName} format must OPEN on the ${rules.openingRole} chair (got ${first ?? "unknown"}).`;
    }
  }
  if (rules.closingRole) {
    const last = roleOf(flatLines[flatLines.length - 1].speakerHostId);
    if (last !== rules.closingRole) {
      return `Format structure failed: the ${format.displayName} format must CLOSE on the ${rules.closingRole} chair (got ${last ?? "unknown"}).`;
    }
  }
  if (rules.mustOutweighSeatZero != null && cast.length > rules.mustOutweighSeatZero) {
    const counts = new Map<string, number>();
    for (const l of flatLines) {
      if (!l.speakerHostId) continue;
      counts.set(l.speakerHostId, (counts.get(l.speakerHostId) ?? 0) + words(l.text));
    }
    const seatZeroWords = counts.get(cast[0].id) ?? 0;
    const heavySeat = cast[rules.mustOutweighSeatZero];
    if ((counts.get(heavySeat.id) ?? 0) <= seatZeroWords) {
      return `Format structure failed: ${heavySeat.name} must carry MORE spoken material than ${cast[0].name} in the ${format.displayName} format.`;
    }
  }
  return null;
}

export interface CastSeatCount {
  hostId: string;
  hostName: string;
  seatIndex: number;
  lineCount: number;
}

export function generationFloorPct(format: ShowFormat, seatIndex: number): number {
  return roleForSeat(format, seatIndex).minLineSharePct * 0.8;
}

export function approvalFloorPct(format: ShowFormat, seatIndex: number): number {
  return roleForSeat(format, seatIndex).minLineSharePct;
}

/**
 * Generation-time balance gate over the ACTUAL cast (1-4 seats). Returns null
 * when balanced, else a human-readable failure message naming every chair and
 * its share. A solo format trivially passes (its floor is 0).
 */
export function castBalanceGateMessage(
  format: ShowFormat,
  seats: CastSeatCount[],
  totalLines: number
): string | null {
  if (totalLines === 0) return "Validation failed: the script has no attributable lines.";
  const failures: string[] = [];
  const shares = seats.map((s) => {
    const pct = (s.lineCount / totalLines) * 100;
    const floor = generationFloorPct(format, s.seatIndex);
    if (pct < floor) failures.push(`${s.hostName} needs >= ${Math.round(floor)}%`);
    return `${s.hostName}: ${Math.round(pct)}%`;
  });
  if (failures.length === 0) return null;
  return `Validation failed: cast line distribution is unbalanced for the ${format.displayName} format. ${shares.join(", ")}. ${failures.join("; ")}.`;
}
