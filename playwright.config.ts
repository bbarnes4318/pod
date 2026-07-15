import { defineConfig, devices } from "@playwright/test";
import path from "path";

// The app + a throwaway seeded Postgres are started/stopped by global-setup /
// global-teardown (DB-only, no external services). Tests run authenticated via
// the saved storageState.
const APP_PORT = Number(process.env.E2E_APP_PORT) || 3311;
const storageState = path.join(__dirname, "tests", "e2e", ".auth", "state.json");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    storageState,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, storageState } },
    { name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, storageState } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, storageState } },
  ],
});
