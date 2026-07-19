// Cue duration fitting tests (PR 3, pure). Run: npm run test:cue-fitting

import { fitCue, resolveCueFitConfig } from "../lib/audio/cueFitting";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const cfg = resolveCueFitConfig();

function main() {
  console.log("\nCue duration fitting\n");

  check("cue fits exactly -> full", () => {
    const r = fitCue(1000, 1000, cfg);
    assert(r.ok && r.strategy === "full" && r.audibleMs === 1000 && r.stretchPercent === 0, JSON.stringify(r));
    assert(r.fadeInMs > 0 && r.fadeOutMs > 0, "fades present (no abrupt edge)");
  });

  check("cue shorter than window -> full (no stretch)", () => {
    const r = fitCue(600, 1500, cfg);
    assert(r.ok && r.strategy === "full" && r.audibleMs === 600, JSON.stringify(r));
  });

  check("cue slightly longer -> safely faded excerpt", () => {
    const r = fitCue(1600, 1000, cfg);
    assert(r.ok && r.strategy === "faded_excerpt" && r.audibleMs === 1000 && r.fadeInMs > 0 && r.fadeOutMs > 0, JSON.stringify(r));
    assert(r.sourceStartMs === 0 && r.sourceEndMs === 1000, "leading excerpt");
  });

  check("window smaller than the minimum audible cue -> reject (never a 2s cue in a 500ms gap)", () => {
    const r = fitCue(2000, 300, cfg); // 300 < minCueAudibleMs 400
    assert(!r.ok && r.strategy === "reject" && /minimum audible/.test(r.reason), JSON.stringify(r));
  });

  check("excerpt with no room for fades -> rejected as an abrupt edge", () => {
    const tight = { ...cfg, minCueAudibleMs: 40, minFadeMs: 50 }; // window 60 >= 40 but < 2*50
    const r = fitCue(1000, 60, tight);
    assert(!r.ok && /abrupt|fade/.test(r.reason), JSON.stringify(r));
  });

  check("bounded time-stretch within limits succeeds", () => {
    const r = fitCue(1050, 1000, cfg, "time_stretch"); // ~4.76% <= 6%
    assert(r.ok && r.strategy === "time_stretch" && r.stretchPercent < 0 && Math.abs(r.stretchPercent) <= cfg.maxStretchPercent, JSON.stringify(r));
  });

  check("time-stretch beyond the bound fails (no aggressive stretching)", () => {
    const r = fitCue(2000, 1000, cfg, "time_stretch"); // 50% >> 6%
    assert(!r.ok && r.strategy === "reject" && /exceeds bound/.test(r.reason), JSON.stringify(r));
  });

  check("full requested but cue longer than window -> reject (no silent excerpt)", () => {
    const r = fitCue(1600, 1000, cfg, "full");
    assert(!r.ok && r.strategy === "reject", JSON.stringify(r));
  });

  check("invalid inputs reject safely", () => {
    assert(!fitCue(0, 1000, cfg).ok && !fitCue(1000, NaN, cfg).ok, "invalid rejected");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
