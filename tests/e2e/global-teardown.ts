// Stop EXACTLY the resources global-setup started.
//
// Two layers, both perfectly scoped:
//  1. In-memory handles (graceful `pg.stop()` + our Next process tree by PID),
//     used when Playwright happens to share module state with globalSetup.
//  2. A durable fallback: our Next PID and OUR Postgres data dir's
//     `postmaster.pid` recorded by setup — because Playwright loads globalSetup
//     and globalTeardown in separate module registries, so (1) can be empty.
//
// Never by image name, never by port owner: an unrelated Postgres or dev server
// on this machine has a different PID and data dir and is never touched.
import path from "path";
import { stopRuntime, stopRuntimeFromFile } from "./runtime";

export default async function globalTeardown() {
  await stopRuntime();
  await stopRuntimeFromFile(path.join(process.cwd(), "tests", "e2e", ".auth", "runtime.json"));
}
