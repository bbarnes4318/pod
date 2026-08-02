import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = readFileSync(join(process.cwd(), "src/lib/queue/worker.ts"), "utf8");

assert.match(worker, /recoverOrphanedAudioStitchesOnBoot/);
assert.match(worker, /AUDIO_STITCH_RECOVERY_GRACE_MS = 45_000/);
assert.match(worker, /\["active", "wait", "delayed", "prioritized"\]/);
assert.match(worker, /state === "active"/);
assert.match(worker, /status: "audio_segments_ready"/);
assert.match(worker, /queueFinalAudioStitchJob\(\{ scriptId: script\.id \}\)/);

const handlerStart = worker.indexOf("async function handleFinalAudioStitching");
const dispatchStart = worker.indexOf("const res = await dispatchFinalStitch", handlerStart);
const handlerPrefix = worker.slice(handlerStart, dispatchStart);
assert.match(handlerPrefix, /await releaseOrphanedStitchLockForJob\(job\)/);

console.log("Audio stitch orphan recovery regression: PASS");

