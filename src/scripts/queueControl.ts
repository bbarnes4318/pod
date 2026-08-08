// Operator entry point for the production queue during a deployment window.
//
//   npm run queue:pause-production
//   npm run queue:production-status
//   npm run queue:resume-production
//
// Pause never deletes a job. Resume never duplicates one. Both are idempotent,
// so re-running either during a tense deploy is safe.

import "dotenv/config";
import { PRODUCTION_QUEUE_NAME } from "../lib/queue/podcastQueue";
import {
  pauseProductionQueue,
  productionQueueStatus,
  renderQueueStatus,
  resumeProductionQueue,
} from "../lib/queue/queueControl";

type Action = "pause" | "status" | "resume";

async function main() {
  const action = (process.argv[2] || "status").trim() as Action;
  const queue = PRODUCTION_QUEUE_NAME;

  if (action === "pause") {
    const r = await pauseProductionQueue(queue);
    console.log(
      r.noop
        ? `\n  ${queue} was ALREADY paused. Nothing changed.`
        : `\n  ${queue} is now PAUSED. No job was deleted.`
    );
    console.log(renderQueueStatus(await productionQueueStatus(queue)));
    if (r.counts.active > 0) {
      console.log(
        `  ${r.counts.active} job(s) are still ACTIVE. Pausing stops NEW work being picked up;\n` +
          `  wait for active to reach 0 before deploying, then re-check with:\n` +
          `      npm run queue:production-status\n`
      );
      process.exit(1);
    }
    process.exit(0);
  }

  if (action === "resume") {
    const r = await resumeProductionQueue(queue);
    console.log(
      r.noop
        ? `\n  ${queue} was ALREADY running. Nothing changed.`
        : `\n  ${queue} is now RUNNING. No job was re-enqueued.`
    );
    console.log(renderQueueStatus(await productionQueueStatus(queue)));
    process.exit(0);
  }

  const status = await productionQueueStatus(queue);
  console.log(renderQueueStatus(status));
  // Status is diagnostic: it reports, it does not judge.
  process.exit(0);
}

main().catch((err) => {
  console.error("Queue control failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
