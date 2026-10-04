// The jury service: deliberate on an exception (rule juror always; model jurors when Ollama answers), store
// the bundle, and open the board ticket with keccak256(bundle) attached. It never calls approve/reject:
// those are board-only on-chain, and the jury has no board key.
import { decodeEventLog, type Account, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { approvalsAbi } from "./abi";
import { askJuror, DEFAULT_MODELS, DEFAULT_OLLAMA_HOST, ollamaUp, type OllamaOptions } from "./ollama";
import { ruleJuror } from "./rules";
import type { JuryStore } from "./store";
import type { ExceptionRequest, JuryBundle } from "./types";
import { buildBundle, encodeBundle } from "./verdict";

export type JuryOptions = {
  ollama?: Partial<OllamaOptions>;
  models?: string[];
  store?: JuryStore;
  log?: (m: string) => void;
  now?: () => Date;
};

export type Deliberation = { bundle: JuryBundle; json: string; hash: Hex };

export type Filed = Deliberation & { id: number; ticket: Hex; txHash: Hex };

export class JuryService {
  readonly ollama: OllamaOptions;
  readonly models: string[];
  private readonly log: (m: string) => void;
  private readonly now: () => Date;

  constructor(private readonly o: JuryOptions = {}) {
    this.ollama = { host: DEFAULT_OLLAMA_HOST, ...o.ollama };
    this.models = o.models?.length ? o.models : [...DEFAULT_MODELS];
    this.log = o.log ?? ((m) => console.log(`[jury] ${m}`));
    this.now = o.now ?? (() => new Date());
  }

  /** From env: OLLAMA_HOST (host:port or URL), TREASURY_JURY_MODELS, TREASURY_JURY_TIMEOUT_MS. */
  static fromEnv(env: Record<string, string | undefined>, extra: Omit<JuryOptions, "ollama" | "models"> = {}): JuryService {
    let host = env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
    if (!/^https?:\/\//.test(host)) host = `http://${host}`;
    const models = (env.TREASURY_JURY_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const timeoutMs = env.TREASURY_JURY_TIMEOUT_MS ? Number(env.TREASURY_JURY_TIMEOUT_MS) : undefined;
    return new JuryService({ ...extra, ollama: { host, timeoutMs }, models });
  }

  async deliberate(req: ExceptionRequest): Promise<Deliberation> {
    const rules = ruleJuror(req);
    const up = await ollamaUp(this.ollama);
    let jurors: Awaited<ReturnType<typeof askJuror>>[] = [];
    if (up) {
      // One at a time: three small models in parallel can exceed a laptop's memory.
      for (const m of this.models) jurors.push(await askJuror(m, req, this.ollama));
    } else {
      this.log(`Ollama not reachable at ${this.ollama.host}: rule juror only for op ${req.opHash}`);
    }
    const bundle = buildBundle({ request: req, models: this.models, jurors, rules, up, createdAt: this.now() });
    const { json, hash } = encodeBundle(bundle);
    this.log(`op ${req.opHash}: models=${bundle.verdict.recommend} (${bundle.verdict.why}), rules=${rules.recommend}, bundle ${hash}`);
    return { bundle, json, hash };
  }

  /** Deliberate, store, then BoardApprovals.request(opHash, keccak256(bundle)) from the desk key. */
  async file(req: ExceptionRequest, desk: { pub: PublicClient; wallet: WalletClient; account: Account; chain: Chain }): Promise<Filed> {
    if (!this.o.store) throw new Error("JuryService.file needs a store");
    const d = await this.deliberate(req);
    const id = await this.o.store.insert(d.bundle, d.json, d.hash);
    try {
      const { request } = await desk.pub.simulateContract({
        address: req.approvals as Address,
        abi: approvalsAbi,
        functionName: "request",
        args: [req.opHash, d.hash],
        account: desk.account,
        chain: desk.chain,
      });
      const txHash = await desk.wallet.writeContract(request as Parameters<WalletClient["writeContract"]>[0]);
      const rcpt = await desk.pub.waitForTransactionReceipt({ hash: txHash });
      if (rcpt.status !== "success") throw new Error(`request reverted (${txHash})`);
      let ticket: Hex | undefined;
      for (const l of rcpt.logs) {
        if (l.address.toLowerCase() !== req.approvals.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: approvalsAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "Requested") ticket = ev.args.ticket;
        } catch {}
      }
      if (!ticket) throw new Error("no Requested event in the receipt");
      await this.o.store.markRequested(id, ticket, txHash);
      this.log(`op ${req.opHash}: board ticket ${BigInt(ticket)} opened (${txHash})`);
      return { ...d, id, ticket, txHash };
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage || e.message : String(e);
      await this.o.store.markFailed(id, msg);
      throw e;
    }
  }
}
