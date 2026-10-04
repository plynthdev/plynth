// Model jurors: small open models served by a local Ollama (free, runs on the box). Each juror answers with
// JSON {recommend, confidence, reasons[]} via Ollama's `format: "json"`. Anything else (bad JSON, wrong
// shape, HTTP error, timeout) gets exactly one retry, then the juror abstains.
import { WAD } from "./rules";
import type { ExceptionRequest, JurorResult, Recommend } from "./types";

/** Three families, each under 4 GB. Override with TREASURY_JURY_MODELS (comma separated). */
export const DEFAULT_MODELS = ["llama3.2:3b", "qwen2.5:3b", "phi3.5"] as const;
export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
export const MAX_ATTEMPTS = 2; // the first try plus one retry

export type OllamaOptions = { host: string; timeoutMs?: number | undefined; seed?: number; fetch?: typeof fetch };

export const SYSTEM_PROMPT = [
  "You are one juror on a treasury model jury.",
  "A desk bot of a company treasury wants to run an operation that its on-chain policy will not allow without the board's sign-off.",
  "Read the facts and recommend whether the board should approve or reject it. You only advise; the board decides.",
  "Be conservative: reject anything that pushes weights out of the policy bands, exceeds caps, adds risk while markets are closed or during a drawdown, or that you do not understand.",
  'Reply with JSON only, exactly: {"recommend":"approve" or "reject","confidence":number from 0 to 1,"reasons":["short reason", ...]}',
].join(" ");

const dollars = (v: string) => `$${(BigInt(v) / WAD).toString()}`;
const pct = (part: string, nav: string) => (BigInt(nav) === 0n ? "0" : (Number((BigInt(part) * 10_000n) / BigInt(nav)) / 100).toFixed(2));

/** Plain-language facts for the model (USD in whole dollars, weights in %), then the raw request. */
export function userPrompt(req: ExceptionRequest): string {
  const p = req.policy;
  const w = req.weights;
  return [
    `Operation: desk "${req.desk}" wants to ${req.intent.action} asset ${req.intent.asset}, notional ${dollars(req.intent.notionalUsd)}.${req.intent.note ? ` Note: ${req.intent.note}` : ""}`,
    `Why it needs the board: guard rule ${req.guard.reason} (code ${req.guard.code ?? "none"}).`,
    `Book now: NAV ${dollars(w.navUsd)}, cash ${pct(w.cashUsd, w.navUsd)}%, equity ${pct(w.equityUsd, w.navUsd)}%.`,
    `Policy: cash band ${p.cash.minBps / 100}-${p.cash.maxBps / 100}%, equity band ${p.equity.minBps / 100}-${p.equity.maxBps / 100}%, per-order cap $${p.perOrderCapUsd}, per-day cap $${p.perDayCapUsd}, board sign-off above $${p.approvalAboveUsd}, no new risk off-hours: ${p.noNewRiskOffHours}.`,
    `Market: feeds on hold (markets closed): ${req.market.equityHold}; traded in the last 24h ${dollars(req.market.dayUsedUsd)}; period-start NAV ${dollars(req.market.periodStartNavUsd)}.`,
    `Raw request JSON: ${JSON.stringify(req)}`,
  ].join("\n");
}

export type Parsed = { ok: true; recommend: Recommend; confidence: number; reasons: string[] } | { ok: false; error: string };

/** Validates one juror answer. Strict on shape; trims and caps reasons (8 x 400 chars). */
export function parseJurorAnswer(content: unknown): Parsed {
  if (typeof content !== "string") return { ok: false, error: "no message content" };
  let j: unknown;
  try {
    j = JSON.parse(content);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, error: "not a JSON object" };
  const o = j as Record<string, unknown>;
  const rec = typeof o.recommend === "string" ? o.recommend.trim().toLowerCase() : "";
  if (rec !== "approve" && rec !== "reject") return { ok: false, error: `recommend must be approve|reject` };
  const c = o.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) return { ok: false, error: "confidence must be a number in [0,1]" };
  if (!Array.isArray(o.reasons) || o.reasons.length === 0 || !o.reasons.every((r) => typeof r === "string" && r.trim().length > 0)) {
    return { ok: false, error: "reasons must be a non-empty array of strings" };
  }
  const reasons = (o.reasons as string[]).slice(0, 8).map((r) => r.trim().slice(0, 400));
  return { ok: true, recommend: rec, confidence: c, reasons };
}

async function chatOnce(model: string, req: ExceptionRequest, o: OllamaOptions): Promise<Parsed> {
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${o.host.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: { temperature: 0, seed: o.seed ?? 26 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt(req) },
        ],
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
    });
  } catch (e) {
    return { ok: false, error: `request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let body: { message?: { content?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: "invalid Ollama response" };
  }
  return parseJurorAnswer(body?.message?.content);
}

export async function askJuror(model: string, req: ExceptionRequest, o: OllamaOptions): Promise<JurorResult> {
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await chatOnce(model, req, o);
    if (r.ok) return { model, status: "vote", recommend: r.recommend, confidence: r.confidence, reasons: r.reasons, attempts: attempt };
    last = r.error;
  }
  return { model, status: "abstain", error: last, attempts: MAX_ATTEMPTS };
}

/** True if an Ollama server answers at `host`. */
export async function ollamaUp(o: OllamaOptions): Promise<boolean> {
  try {
    const res = await (o.fetch ?? fetch)(`${o.host.replace(/\/$/, "")}/api/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}
