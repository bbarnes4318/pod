// Network-free regression for customer-visible Show Forge discovery and live web identity.
// Run: npx tsx --conditions=react-server src/scripts/testShowForgeDiscoverability.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const layout = source("app/app/layout.tsx");
const nav = source("app/app/AppNav.tsx");
const shows = source("app/app/podcasts/page.tsx");
const forge = source("app/app/podcasts/new/page.tsx");
const buildInfo = source("app/api/build-info/route.ts");

assert(layout.includes('href="/app/podcasts/new"'), "the primary sidebar does not link directly to Show Forge");
assert(layout.includes("Build a Show"), "the primary sidebar still hides Show Forge behind generic Create wording");
assert(layout.includes("Web build"), "the live web commit is not visible in the signed-in app");
assert(layout.includes("SOURCE_COMMIT"), "the visible build marker is not tied to the deployed source commit");
assert(nav.includes('label: "Shows"'), "the product navigation still calls themed shows generic podcasts");
assert(shows.includes("Show Forge is live"), "the Shows page does not visibly announce the capability");
assert(shows.includes("Open Show Forge"), "the Shows page has no unmistakable Show Forge entry point");
assert(forge.includes("Build your show"), "the creation route still presents itself as the old podcast form");
assert(forge.includes("theme, listener promise, cast chemistry"), "the creation route does not explain the real show-building experience");
assert(buildInfo.includes('release: "show-forge-visible-v1"'), "the deployment identity endpoint lacks a release marker");
assert(buildInfo.includes("sourceCommit"), "the deployment identity endpoint does not return the live web commit");
assert(buildInfo.includes('"Cache-Control": "no-store, max-age=0"'), "build identity may be hidden by stale caching");

console.log("Show Forge discoverability: 12 passed, 0 failed");
