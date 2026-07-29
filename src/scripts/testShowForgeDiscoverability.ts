// Network-free regression for customer-visible Show Forge discovery and creator/listener separation.
// Run: npx tsx --conditions=react-server src/scripts/testShowForgeDiscoverability.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const listenerLayout = source("app/app/layout.tsx");
const listenerNav = source("app/app/AppNav.tsx");
const studioShell = source("app/studio/StudioShell.tsx");
const shows = source("app/studio/shows/page.tsx");
const forge = source("app/studio/shows/new/page.tsx");
const legacyShows = source("app/app/podcasts/page.tsx");
const legacyCreate = source("app/app/create/page.tsx");
const buildInfo = source("app/api/build-info/route.ts");

assert(listenerLayout.includes('href="/studio"'), "the listener sidebar does not hand creators into Studio");
assert(listenerLayout.includes("Open Creator Studio"), "the listener surface does not clearly name the creator destination");
assert(listenerLayout.includes("Listener build"), "the signed-in listener surface no longer exposes its deployed build");
assert(listenerLayout.includes("SOURCE_COMMIT"), "the visible build marker is not tied to the deployed source commit");
assert(listenerNav.includes('label: "Creator Studio"'), "listener navigation still presents show creation as a listener feature");
assert(studioShell.includes('href: "/studio/shows"'), "Studio navigation does not expose the Shows workspace");
assert(studioShell.includes('label: "Shows"'), "Studio navigation does not name the Shows workspace clearly");
assert(shows.includes("Show Studio"), "the canonical Shows page does not establish the creator workspace");
assert(shows.includes("Build a show"), "the canonical Shows page has no unmistakable Show Forge entry point");
assert(forge.includes("Build your show"), "the Studio creation route does not present Show Forge");
assert(forge.includes("theme, listener promise, cast chemistry"), "the Studio creation route does not explain the real show-building experience");
assert(legacyShows.includes('redirect("/studio/shows")'), "legacy show bookmarks do not redirect safely into Studio");
assert(legacyCreate.includes("/studio/create"), "legacy episode creation does not redirect safely into Studio");
assert(buildInfo.includes('release: "show-forge-visible-v1"'), "the deployment identity endpoint lacks a release marker");
assert(buildInfo.includes("sourceCommit"), "the deployment identity endpoint does not return the live web commit");
assert(buildInfo.includes('"Cache-Control": "no-store, max-age=0"'), "build identity may be hidden by stale caching");

console.log("Show Forge discoverability and Studio ownership: 16 passed, 0 failed");
