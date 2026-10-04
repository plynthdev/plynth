// The risk service (spec §3): each tick it pushes fresh PositionMirror snapshots for off-chain venues, reads the
// treasury as the PolicyGuard sees it, and reports drawdown state, per-venue and per-name exposure, funding
// signs and off-hours flags. Webhooks: `drawdown.state` on every state change, `risk.alert` when an alert
// starts (venue stale / over cap / over leverage, net delta outside the band, funding adverse or flipped,
// a held name off-hours). Read-only on the treasury: it never trades.
import { zeroAddress, type Address, type PublicClient } from "viem";
import { guardAbi } from "../desks/abi";
import {
  perpMarketAbi,
  perpVenueAbi,
  periodStartAbi,
  riskAccountAbi,
  riskGuardAbi,
  riskPolicyAbi,
  valuerQuoteAbi,
} from "./abi";
import { DrawdownMachine, type DrawdownStep } from "./drawdown";
import { computeExposure, type ExposureReport, type SpotRead, type VenueRead } from "./exposure";
import { FundingWatch, signedRate, type FundingEvent, type FundingRead, type FundingSign } from "./funding";
import type { MirrorPusher, PushResult, VenueReader } from "./mirror";
import type { Webhooks } from "./webhooks";

const KIND_STOCK_TOKEN = 2;

export type RiskConfig = {
  account: Address;
  readers?: VenueReader[]; // off-chain venues to mirror (and their funding)
  hysteresisBps?: number;
};

export type Alert = { key: string; kind: string; detail: Record<string, unknown> };

export type RiskReport = {
  blockNumber: bigint;
  blockTime: bigint;
  navUsd: bigint;
  periodStartNav: bigint;
  drawdown: DrawdownStep;
  exposure: ExposureReport;
  funding: FundingSign[];
  offHours: { underlying: Address; hold: boolean }[];
  alerts: Alert[]; // every alert active now
  newAlerts: Alert[]; // alerts that started this tick
  pushes: PushResult[];
};

export class RiskService {
  readonly drawdown: DrawdownMachine;
  readonly funding = new FundingWatch();
  private activeAlerts = new Set<string>();
  private addrs?: { policy: Address; guard: Address; valuer: Address };

  constructor(
    readonly pub: PublicClient,
    readonly cfg: RiskConfig,
    readonly deps: { pusher?: MirrorPusher; webhooks?: Webhooks; log?: (msg: string, extra?: unknown) => void } = {},
  ) {
    this.drawdown = new DrawdownMachine(cfg.hysteresisBps ?? 50);
  }

  private async addresses() {
    if (!this.addrs) {
      const a = this.cfg.account;
      const [policy, guard] = await Promise.all([
        this.pub.readContract({ address: a, abi: riskAccountAbi, functionName: "policy" }),
        this.pub.readContract({ address: a, abi: riskAccountAbi, functionName: "guard" }),
      ]);
      const valuer = await this.pub.readContract({ address: guard, abi: riskGuardAbi, functionName: "valuer" });
      this.addrs = { policy, guard, valuer };
    }
    return this.addrs;
  }

  async tick(): Promise<RiskReport> {
    const pushes: PushResult[] = [];
    if (this.deps.pusher) {
      for (const r of this.cfg.readers ?? []) {
        try {
          pushes.push(await this.deps.pusher.push(r));
        } catch (err) {
          pushes.push({ venue: r.venue, posted: false, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    const { policy, guard, valuer } = await this.addresses();
    const block = await this.pub.getBlock({ blockTag: "latest" });
    const at = { blockNumber: block.number };
    const account = this.cfg.account;
    const [[p], snap, tracked, pc] = await Promise.all([
      this.pub.readContract({ address: policy, abi: riskPolicyAbi, functionName: "current", ...at }),
      this.pub.readContract({ address: guard, abi: guardAbi, functionName: "snapshot", args: [account], ...at }),
      this.pub.readContract({ address: account, abi: riskAccountAbi, functionName: "trackedAssets", ...at }),
      this.pub.readContract({ address: account, abi: riskAccountAbi, functionName: "periodClose", ...at }),
    ]);
    const periodStartNav =
      pc === zeroAddress ? 0n : await this.pub.readContract({ address: pc, abi: periodStartAbi, functionName: "periodStartNav", ...at });

    // Spot Stock Tokens (any band) from the guard's own valuation.
    const spot: SpotRead[] = [];
    snap.assets.forEach((asset, i) => {
      if (tracked[1][i] === KIND_STOCK_TOKEN) spot.push({ asset, usd: snap.usd[i]! });
    });

    // Venues: positions valued with the same Valuer the guard uses.
    const venues: VenueRead[] = [];
    const fundingReads: FundingRead[] = [];
    for (const v of snap.venues) {
      const positions = await this.pub.readContract({ address: v.venue, abi: perpVenueAbi, functionName: "positionOf", ...at });
      const pos: VenueRead["positions"] = [];
      for (const x of positions) {
        const abs = x.tokens < 0n ? -x.tokens : x.tokens;
        let usd = 0n;
        try {
          [usd] = await this.pub.readContract({ address: valuer, abi: valuerQuoteAbi, functionName: "value", args: [x.underlying, abs], ...at });
        } catch {
          usd = 0n; // unpriceable: the guard marks the venue stale already
        }
        pos.push({ underlying: x.underlying, tokens: x.tokens, usd: x.tokens < 0n ? -usd : usd });
      }
      venues.push({ venue: v.venue, equityUsd: v.equity, grossUsd: v.gross, stale: v.stale, positions: pos });
      fundingReads.push(...(await this.fundingOf(v.venue, pos, at.blockNumber)));
    }

    const exposure = computeExposure(snap.nav, spot, venues, {
      netDeltaMinBps: p.netDeltaMinBps,
      netDeltaMaxBps: p.netDeltaMaxBps,
      maxLeverageX10: p.maxLeverageX10,
      perVenueCapBps: p.perVenueCapBps,
    });
    const dd = this.drawdown.step({
      nav: snap.nav,
      periodStartNav,
      pauseBps: p.pauseNewRiskAtDrawdownBps,
      deriskBps: p.deriskAtDrawdownBps,
    });
    const { signs, events } = this.funding.update(fundingReads);
    const offHours = await this.offHours(valuer, exposure.names.map((n) => n.underlying), at.blockNumber);

    const alerts = this.alertsOf(exposure, signs, offHours, events);
    const newAlerts = alerts.filter((a) => !this.activeAlerts.has(a.key) || a.kind.startsWith("funding.flip"));
    this.activeAlerts = new Set(alerts.map((a) => a.key));

    const report: RiskReport = {
      blockNumber: block.number,
      blockTime: block.timestamp,
      navUsd: snap.nav,
      periodStartNav,
      drawdown: dd,
      exposure,
      funding: signs,
      offHours,
      alerts,
      newAlerts,
      pushes,
    };
    await this.notify(report);
    return report;
  }

  /** In-house venues expose their markets on-chain; off-chain venues report funding through their reader. */
  private async fundingOf(venue: Address, pos: VenueRead["positions"], blockNumber: bigint): Promise<FundingRead[]> {
    const out: FundingRead[] = [];
    const side = (u: Address) => {
      const x = pos.find((q) => q.underlying.toLowerCase() === u.toLowerCase());
      return x ? (x.tokens < 0n ? "short" : "long") : null;
    };
    const reader = (this.cfg.readers ?? []).find((r) => r.venue.toLowerCase() === venue.toLowerCase());
    if (reader) {
      const r = await reader.read();
      for (const f of r.funding ?? []) {
        const s = side(f.underlying);
        if (s) out.push({ venue, underlying: f.underlying, ourSide: s, ratePerSecond: f.ratePerSecond });
      }
      return out;
    }
    let markets: readonly Address[] = [];
    try {
      markets = await this.pub.readContract({ address: venue, abi: perpVenueAbi, functionName: "markets", blockNumber });
    } catch {
      return out; // not an in-house venue and no reader configured
    }
    for (const m of markets) {
      const u = await this.pub.readContract({ address: m, abi: perpMarketAbi, functionName: "underlying", blockNumber });
      const s = side(u);
      if (!s) continue;
      const [rate, longsPay] = await this.pub.readContract({ address: m, abi: perpMarketAbi, functionName: "fundingRate", blockNumber });
      out.push({ venue, underlying: u, ourSide: s, ratePerSecond: signedRate(rate, longsPay) });
    }
    return out;
  }

  private async offHours(valuer: Address, names: Address[], blockNumber: bigint) {
    const out: { underlying: Address; hold: boolean }[] = [];
    for (const u of names) {
      try {
        const q = await this.pub.readContract({ address: valuer, abi: valuerQuoteAbi, functionName: "quote", args: [u], blockNumber });
        out.push({ underlying: u, hold: q.hold });
      } catch {
        out.push({ underlying: u, hold: true }); // delisted or bad feed: treat as held
      }
    }
    return out;
  }

  private alertsOf(x: ExposureReport, signs: FundingSign[], offHours: { underlying: Address; hold: boolean }[], events: FundingEvent[]): Alert[] {
    const a: Alert[] = [];
    for (const v of x.venues) {
      if (v.stale) a.push({ key: `venue.stale:${v.venue}`, kind: "venue.stale", detail: { venue: v.venue } });
      if (v.overCap) a.push({ key: `venue.overCap:${v.venue}`, kind: "venue.overCap", detail: { venue: v.venue, weightBps: v.weightBps } });
      if (v.overLeverage) a.push({ key: `venue.overLeverage:${v.venue}`, kind: "venue.overLeverage", detail: { venue: v.venue, leverageX10: v.leverageX10 } });
    }
    if (x.netDeltaInBand === false) a.push({ key: "netDelta.outOfBand", kind: "netDelta.outOfBand", detail: { netDeltaBps: x.netDeltaBps } });
    for (const s of signs) {
      if (s.wePay) a.push({ key: `funding.adverse:${s.venue}:${s.underlying}`, kind: "funding.adverse", detail: { venue: s.venue, underlying: s.underlying, side: s.ourSide, ratePerHourBps: s.ratePerHourBps } });
    }
    for (const e of events) {
      if (e.kind === "flip") a.push({ key: `funding.flip:${e.key}`, kind: "funding.flip", detail: { venue: e.now.venue, underlying: e.now.underlying, ratePerSecond: e.now.ratePerSecond } });
    }
    for (const o of offHours) if (o.hold) a.push({ key: `offHours:${o.underlying}`, kind: "offHours", detail: { underlying: o.underlying } });
    return a;
  }

  private async notify(r: RiskReport) {
    const wh = this.deps.webhooks;
    const log = this.deps.log;
    if (r.drawdown.changed) {
      const data = {
        account: this.cfg.account,
        from: r.drawdown.from,
        to: r.drawdown.state,
        ddBps: r.drawdown.ddBps,
        navUsd: r.navUsd,
        periodStartNav: r.periodStartNav,
        blockNumber: r.blockNumber,
      };
      log?.("drawdown.state", data);
      if (wh) await wh.emit({ type: "drawdown.state", data });
    }
    for (const a of r.newAlerts) {
      log?.("risk.alert", a);
      if (wh) await wh.emit({ type: "risk.alert", data: { account: this.cfg.account, ...a, blockNumber: r.blockNumber } });
    }
  }
}
