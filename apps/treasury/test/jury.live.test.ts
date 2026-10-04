// Optional live check against a real local Ollama: skips unless `ollama` is on PATH and a server answers at
// OLLAMA_HOST (default 127.0.0.1:11434). Asserts only the contract: every juror votes with a valid answer or
// abstains, and the verdict follows the tally rules. Model choices are in jury/README.md.
import { describe, expect, test } from "bun:test";
import { ollamaUp } from "../jury/ollama";
import { JuryService } from "../jury/service";
import { tally } from "../jury/verdict";
import { exceptionReq } from "./jury.fixtures";

const jury = JuryService.fromEnv({ ...process.env, TREASURY_JURY_TIMEOUT_MS: process.env.TREASURY_JURY_TIMEOUT_MS || "180000" }, { log: () => {} });
const live = !!Bun.which("ollama") && (await ollamaUp(jury.ollama));

describe("model jury (live Ollama)", () => {
  test.skipIf(!live)(
    "three local models deliberate on an in-band exception",
    async () => {
      const d = await jury.deliberate(exceptionReq());
      expect(d.bundle.mode).toBe("models+rules");
      expect(d.bundle.jurors).toHaveLength(jury.models.length);
      for (const j of d.bundle.jurors) {
        if (j.status === "vote") {
          expect(["approve", "reject"]).toContain(j.recommend);
          expect(j.confidence).toBeGreaterThanOrEqual(0);
          expect(j.confidence).toBeLessThanOrEqual(1);
          expect(j.reasons.length).toBeGreaterThan(0);
        } else expect(j.attempts).toBe(2);
      }
      expect(d.bundle.verdict).toEqual(tally(d.bundle.jurors));
      expect(d.bundle.rules.recommend).toBe("approve");
      console.log(`[live jury] ${d.bundle.jurors.map((j) => `${j.model}=${j.status === "vote" ? `${j.recommend}@${j.confidence}` : "abstain"}`).join(" ")} -> ${d.bundle.verdict.recommend}`);
    },
    600_000,
  );
});
