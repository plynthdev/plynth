// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
// Deploy target: NITRO_PRESET=vercel on Vercel (see vercel.json), cloudflare otherwise.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";

// Chain wiring. `vite dev` proxies the stack's API and relayer, so the browser never makes a cross-origin call (the
// API's CORS list and the relayer need no change), and serves the chain's deployment file. Targets come from
// VITE_API_URL / VITE_RELAYER_URL.
// - `bun run dev`: the local fork (31337), .env.local, app/deployments/fork.json.
// - `bun run dev:testnet` (--mode testnet): .env.testnet.local, Robinhood Chain testnet 46630, app/deployments/46630.json.
// - `bun run dev:mainnet` (--mode mainnet): .env.mainnet.local, Robinhood Chain 4663, app/deployments/4663.json
//   (or the raw 4663-beta.json).
// - `bun run build`: production. VITE_CHAIN_ID / VITE_RPC_URL / VITE_API_URL / VITE_RELAYER_URL come from the host's
//   environment; the chain's deployment file is inlined into the bundle, or null when it does not exist yet, which
//   the dashboard shows as "not deployed yet" (the build never fails for it).
const argv = process.argv;
const modeAt = argv.indexOf("--mode");
const MODE =
  modeAt > 0 && argv[modeAt + 1]
    ? argv[modeAt + 1]!
    : process.env["NODE_ENV"] === "production" || argv.includes("build")
      ? "production"
      : "development";
const env = loadEnv(MODE, process.cwd(), "");
const API = (env["VITE_API_URL"] || "http://127.0.0.1:8789").replace(/\/+$/, "");
const RELAYER = (env["VITE_RELAYER_URL"] || "http://127.0.0.1:8791").replace(/\/+$/, "");
const CHAIN_ID = Number(env["VITE_CHAIN_ID"] || 31337);

// The anvil dev key is for the local fork only. The browser refuses it for any other chain or host anyway
// (src/fork/config.ts devWalletAllowed); this stops a misconfigured build before it ships.
if (env["VITE_DEV_WALLET"] === "1" && CHAIN_ID !== 31337)
  throw new Error(`VITE_DEV_WALLET=1 is only for the local fork (31337), not chain ${CHAIN_ID}`);

// Deployment file per chain, first existing wins (FORK_DEPLOYMENT_JSON overrides).
const DEPLOYMENTS = resolve("../app/deployments");
const CANDIDATES: Record<number, string[]> = {
  31337: ["fork.json"],
  46630: ["46630.json"],
  4663: ["4663.json", "4663-beta.json"],
};
function deploymentPath(): string | null {
  if (env["FORK_DEPLOYMENT_JSON"]) return resolve(env["FORK_DEPLOYMENT_JSON"]);
  const files = (CANDIDATES[CHAIN_ID] ?? [`${CHAIN_ID}.json`]).map((f) => resolve(DEPLOYMENTS, f));
  return files.find((f) => existsSync(f)) ?? null;
}
function bundledDeployment(): unknown {
  const p = deploymentPath();
  if (!p || !existsSync(p)) {
    if (argv.includes("build"))
      console.warn(
        `[plynth] no deployment file for chain ${CHAIN_ID} (looked in ${env["FORK_DEPLOYMENT_JSON"] || DEPLOYMENTS}): the dashboard will say "not deployed yet".`,
      );
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8")) as unknown;
}

// The proxied request is server-to-server: drop the browser Origin so the API's allow-list does not apply.
const proxy = (target: string, prefix: string) => ({
  target,
  changeOrigin: true,
  rewrite: (p: string) => p.slice(prefix.length) || "/",
  configure: (p: {
    on(ev: "proxyReq", f: (req: { removeHeader(h: string): void }) => void): void;
  }) => p.on("proxyReq", (req) => req.removeHeader("origin")),
});

function forkDeployment(): Plugin {
  return {
    name: "plynth-fork-deployment",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__fork/deployment.json", (_req, res) => {
        // Read on every request: a fork redeploy needs no dev-server restart.
        const p = deploymentPath();
        try {
          if (!p) throw new Error("none");
          const body = readFileSync(p, "utf8");
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: `no deployment file for chain ${CHAIN_ID} (${p ?? DEPLOYMENTS}); for the fork run app/scripts/fork/up.sh`,
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  plugins: [forkDeployment()],
  vite: {
    // src/fork/deployment.ts reads this in a build; `vite dev` fetches /__fork/deployment.json instead.
    define: { __PLYNTH_DEPLOYMENT__: JSON.stringify(bundledDeployment()) },
    server: {
      // @plynth/sdk is file:../sdk; its WASM (Noir, Barretenberg) resolves to sdk/node_modules.
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), resolve("../sdk")] },
      proxy: {
        "/__fork/api": proxy(API, "/__fork/api"),
        "/__fork/relayer": proxy(RELAYER, "/__fork/relayer"),
      },
    },
    // Barretenberg / Noir ship their own WASM + workers: let Vite serve them as-is.
    optimizeDeps: {
      exclude: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"],
    },
    worker: { format: "es" },
    build: { target: "es2022" },
  },
});
