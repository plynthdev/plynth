// Local-fork e2e (branch local-fork-testing only): the dashboard against the running fork stack
// (backend/app/scripts/fork/up.sh), clicked through with the dev wallet. `bunx playwright test e2e-local`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e-local",
  timeout: 40 * 60_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8080",
    viewport: { width: 1400, height: 1000 },
    actionTimeout: 60_000,
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:8080/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
