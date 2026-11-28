// Measured audio QA (ffmpeg ebur128 / silencedetect on the rendered master),
// read from a stitch or line-regen job's output. Pure: no DB, testable.

export interface MixMeasuredVM {
  measuredAt: string;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDb: number | null;
  maxSilenceGapSec: number | null;
  checks: Array<{ name: string; status: "pass" | "warning" | "fail"; value: string; detail: string }>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Pull the measured QA report out of a stitch / line-regen job output. */
export function measuredFromJobOutput(output: unknown, createdAt: Date): MixMeasuredVM | null {
  const o = output as any;
  const qa = o?.audioQa || o?.stitch?.audioQa;
  if (!qa || typeof qa !== "object" || !qa.metrics) return null;
  const m = qa.metrics;
  const checks = Array.isArray(qa.checks)
    ? qa.checks
        .filter((c: any) => c && typeof c.name === "string" && ["pass", "warning", "fail"].includes(c.status))
        .map((c: any) => ({ name: c.name, status: c.status, value: String(c.value ?? ""), detail: String(c.detail ?? "") }))
    : [];
  return {
    measuredAt: createdAt.toISOString(),
    integratedLufs: num(m.integratedLufs),
    loudnessRangeLu: num(m.loudnessRangeLu),
    truePeakDb: num(m.truePeakDb),
    maxSilenceGapSec: num(m.maxSilenceGapSec),
    checks,
  };
}
