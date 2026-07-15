/* eslint-disable @typescript-eslint/no-explicit-any -- e2e teardown */
// Stop the Next app + embedded Postgres started by global-setup.
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export default async function globalTeardown() {
  const pidfile = path.join(process.cwd(), "tests", "e2e", ".auth", "runtime.json");
  try {
    const { nextPid } = JSON.parse(fs.readFileSync(pidfile, "utf8"));
    if (nextPid) {
      // Kill the dev server process tree.
      try { execSync(`taskkill /PID ${nextPid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
    }
  } catch { /* no pidfile */ }
  // Embedded Postgres runs as a detached postgres.exe; stop it.
  try { execSync("taskkill /IM postgres.exe /F", { stdio: "ignore" }); } catch { /* none */ }
}
