// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";

// Local-fork wiring (branch local-fork-testing only): `vite dev` proxies the fork stack's API and relayer, so the
// browser never makes a cross-origin call (the API's CORS list and the relayer need no change), and serves the
// fork's deployment file. Targets come from VITE_API_URL / VITE_RELAYER_URL (.env.local).
// `vite dev --mode testnet` (bun run dev:testnet) loads .env.testnet.local: Robinhood Chain testnet 46630, the
// public testnet RPC, the testnet stack's API/relayer on this Mac, app/deployments/46630.json, no dev wallet.
const modeAt = process.argv.indexOf("--mode");
const MODE =
  modeAt > 0 && process.argv[modeAt + 1]
    ? process.argv[modeAt + 1]!
    : process.env.NODE_ENV === "production"
      ? "production"
      : "development";
const env = loadEnv(MODE, process.cwd(), "");
const API = (env.VITE_API_URL || "http://127.0.0.1:8789").replace(/\/+$/, "");
const RELAYER = (env.VITE_RELAYER_URL || "http://127.0.0.1:8791").replace(/\/+$/, "");
const DEPLOYMENT = resolve(env.FORK_DEPLOYMENT_JSON || "../app/deployments/fork.json");

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
        try {
          const body = readFileSync(DEPLOYMENT, "utf8");
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: `no fork deployment at ${DEPLOYMENT} (run app/scripts/fork/up.sh)`,
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
