// Format-driven script balance policy (Prompt 7, PR 2).
//
// One policy source: each format chair declares its approval-time minimum
// line share in the registry (minLineSharePct). The script GENERATION gate
// runs at 0.8x that floor — for the two-host debate that reproduces the
// engine's historical pair exactly (approval 25%, generation 20%), so the
// existing format's behavior is unchanged.

import type { ShowFormat } from "./showFormatRegistry";
import { roleForSeat } from "./showFormatRegistry";

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
