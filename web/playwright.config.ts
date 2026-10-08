// Local e2e (branch local-fork-testing only), `bunx playwright test e2e-local`:
// - project "fork": the dashboard against the running fork stack (backend/app/scripts/fork/up.sh), clicked through
//   with the dev wallet. FORK_PORT_OFFSET (default 0) matches the fork's PORT_OFFSET (1000 = beside the testnet stack).
// - project "testnet": the `dev:testnet` profile against the running Robinhood Chain testnet stack, READ-ONLY: a stub
//   wallet answers accounts and refuses every signature and send, so nothing is ever broadcast.
// Dev servers: 8085 (fork) and 8086 (testnet); 8080 belongs to another project on this Mac.
import { defineConfig } from "@playwright/test";

const off = Number(process.env.FORK_PORT_OFFSET || 0);
if (!Number.isInteger(off) || off < 0) throw new Error("FORK_PORT_OFFSET must be a non-negative integer");
const forkEnv = {
  VITE_API_URL: process.env.VITE_API_URL || `http://127.0.0.1:${8789 + off}`,
  VITE_RPC_URL: process.env.VITE_RPC_URL || `http://127.0.0.1:${8545 + off}`,
  VITE_RELAYER_URL: process.env.VITE_RELAYER_URL || `http://127.0.0.1:${8791 + off}`,
  VITE_CHAIN_ID: "31337",
  VITE_DEV_WALLET: "1",
  FORK_DEPLOYMENT_JSON:
    process.env.FORK_DEPLOYMENT_JSON ||
    (off ? `../backend/app/.fork-${off}/deployments/31337.json` : "../backend/app/deployments/fork.json"),
};
// The fork helper (Node side of the test) reads the same settings under its own names: VITE_* or
// FORK_DEPLOYMENT_JSON in process.env would leak into the testnet dev server and override .env.testnet.local.
process.env.FORK_HELPER_RPC_URL ??= forkEnv.VITE_RPC_URL;
process.env.FORK_HELPER_API_URL ??= forkEnv.VITE_API_URL;
process.env.FORK_HELPER_DEPLOYMENT ??= forkEnv.FORK_DEPLOYMENT_JSON;

const FORK_URL = "http://localhost:8085";
const TESTNET_URL = "http://localhost:8086";

export default defineConfig({
  testDir: "e2e-local",
  timeout: 40 * 60_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: { viewport: { width: 1400, height: 1000 }, actionTimeout: 60_000 },
  projects: [
    { name: "fork", testMatch: /flows\.spec\.ts/, use: { baseURL: FORK_URL } },
    { name: "testnet", testMatch: /testnet\.spec\.ts/, use: { baseURL: TESTNET_URL } },
  ],
  webServer: [
    {
      command: "bun run dev --port 8085 --strictPort",
      url: `${FORK_URL}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: forkEnv,
    },
    {
      command: "bun run dev:testnet --port 8086 --strictPort",
      url: `${TESTNET_URL}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
