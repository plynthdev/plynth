// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {StockTokenRegistry} from "../core/StockTokenRegistry.sol";
import {Valuer} from "../core/Valuer.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {AssetValuation} from "../libs/AssetValuation.sol";
import {BoardApprovals} from "./BoardApprovals.sol";
import {ITreasuryAccount} from "../interfaces/ITreasuryAccount.sol";
import {IPeriodStartNav, ISleeve} from "../interfaces/ISleeve.sol";
import {IPerpVenue, IPositionSleeve} from "../interfaces/IPerpVenue.sol";
import {IPrivateSleeve} from "./PrivateSleeve.sol";

/// "Agent proposes, code disposes." The TreasuryAccount takes a `snapshot` before a desk operation, runs it,
/// then asks `check` to compare the resulting state with the policy. Any broken rule returns a non-zero
/// reason code and the account reverts the whole operation.
///
/// Stateless except for the rolling 24-hour notional counters (one ring of hourly buckets per account).
/// All USD amounts are 18-decimal; policy caps are whole USD.
///
/// T2 (perp venues): NAV includes the equity of every venue of every position sleeve (in-house venues read
/// on-chain, off-chain venues from the PositionMirror). Rule 5 bounds the net delta (spot Stock Tokens plus
/// signed perp notional, over NAV) to the policy's overlay band and each venue's leverage (gross notional over
/// venue equity) to maxLeverageX10. Rule 6 allows new risk (more notional or more margin) only at a venue in
/// venueAllowRoot whose numbers are fresh, and keeps each venue's equity within perVenueCapBps of NAV.
/// Reducing a venue (closing, withdrawing) needs no proof and works while its mirror is stale.
///
/// Private sleeve: its book counts at PrivateSleeve.bookUsd (in its band, as Stock Token delta), so shielding
/// moves value between the tracked set and the book without changing NAV. Private trades inside the pool are not
/// seen until the next proven close (the last proven value is used until then).
contract PolicyGuard {
    // Reason codes (rule numbers follow the policy spec).
    uint8 public constant OK = 0;
    uint8 public constant R1_DESK_SCOPE = 1; // returned by the account, not by check
    uint8 public constant R2_NOT_ALLOWED = 2; // an increased asset is not in instrumentAllowRoot
    uint8 public constant R2_NOT_CANONICAL = 3; // an increased Stock Token is not canonical in the registry
    uint8 public constant R3_ORDER_CAP = 4;
    uint8 public constant R3_DAY_CAP = 5;
    uint8 public constant R4_BAND = 6;
    uint8 public constant R6_UNKNOWN_CHANGE = 7; // ETH moved, asset set changed, or value left the tracked set
    uint8 public constant R7_OFF_HOURS = 8;
    uint8 public constant R8_PAUSED = 9;
    uint8 public constant R8_DERISK = 10;
    uint8 public constant R9_APPROVAL = 11;
    uint8 public constant R5_NET_DELTA = 12;
    uint8 public constant R5_LEVERAGE = 13;
    uint8 public constant R6_VENUE_NOT_ALLOWED = 14;
    uint8 public constant R6_VENUE_CAP = 15;
    uint8 public constant R6_STALE_VENUE = 16; // new risk at a venue whose mirror is stale (or unpriceable)
    uint8 public constant R10_PRIVATE_DESK = 17; // returned by the account: private sleeve run by another desk

    uint8 public constant BAND_CASH = 0;
    uint8 public constant BAND_EQUITY = 1;
    uint8 public constant BAND_BASIS = 2;
    /// Equity growth at a venue below this (USD 1e18) is rounding, not new margin.
    uint256 public constant VENUE_DUST = 1e13;

    /// Buckets cover the current hour plus the previous 24, so any true 24-hour window is inside the sum.
    uint256 public constant DAY_BUCKETS = 25;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    struct Venue {
        address venue;
        uint256 equity; // USD 1e18
        uint256 gross; // sum of |position notional|, USD 1e18
        bool stale;
    }

    struct Snapshot {
        address[] assets;
        uint256[] raw;
        uint256[] usd;
        uint256 nav;
        uint256 cashUsd;
        uint256 equityUsd;
        uint256 eth;
        bool equityHold; // a held (raw > 0) Stock Token's feed is stale
        uint256 basisUsd;
        uint256 stockUsd; // spot Stock Tokens in any band (delta 1)
        int256 perpDeltaUsd; // signed perp notional over every venue (+ long, - short)
        Venue[] venues;
        uint256 privateUsd; // the private sleeve's book (last proven value +/- flows since), in its band
    }

    struct Bucket {
        uint64 hour;
        uint192 notional;
    }

    StockTokenRegistry public immutable registry;
    Valuer public immutable valuer;
    /// Most value an operation may lose (fees, slippage vs oracle), in bps of its notional. Value that leaves
    /// the tracked asset set beyond this (sent to an unknown asset or address) is rule 5-6: rejected.
    uint16 public immutable maxOpLossBps;

    mapping(address account => Bucket[DAY_BUCKETS]) private _buckets;

    error NotAccount();
    error BadLossBps();

    constructor(StockTokenRegistry registry_, Valuer valuer_, uint16 maxOpLossBps_) {
        if (maxOpLossBps_ > 1000) revert BadLossBps();
        registry = registry_;
        valuer = valuer_;
        maxOpLossBps = maxOpLossBps_;
    }

    // ---------------------------------------------------------------- snapshot

    function snapshot(address account) public view returns (Snapshot memory s) {
        (address[] memory assets, uint8[] memory kinds, uint8[] memory bands) =
            ITreasuryAccount(account).trackedAssets();
        uint256 n = assets.length;
        s.assets = assets;
        s.raw = new uint256[](n);
        s.usd = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 raw = IERC20(assets[i]).balanceOf(account);
            (uint256 usd, bool hold) = AssetValuation.value(valuer, assets[i], kinds[i], raw);
            s.raw[i] = raw;
            s.usd[i] = usd;
            s.nav += usd;
            _addToBand(s, bands[i], usd);
            if (kinds[i] == AssetValuation.KIND_STOCK_TOKEN) {
                s.stockUsd += usd;
                if (hold) s.equityHold = true;
            }
        }
        s.eth = account.balance;
        _snapshotVenues(s, account);
        _snapshotPrivate(s, account);
    }

    /// The private sleeve is not readable on-chain: it counts at its `bookUsd` (last proven close value plus
    /// shields minus unshields since), in its band and as Stock Token delta, until the next close.
    function _snapshotPrivate(Snapshot memory s, address account) private view {
        address ps;
        try ITreasuryAccount(account).privateSleeve() returns (address a) {
            ps = a;
        } catch {
            return;
        }
        if (ps == address(0)) return;
        uint256 usd = IPrivateSleeve(ps).bookUsd();
        s.privateUsd = usd;
        s.nav += usd;
        s.stockUsd += usd;
        _addToBand(s, IPrivateSleeve(ps).band(), usd);
    }

    function _addToBand(Snapshot memory s, uint8 band, uint256 usd) private pure {
        if (band == BAND_CASH) s.cashUsd += usd;
        else if (band == BAND_EQUITY) s.equityUsd += usd;
        else s.basisUsd += usd;
    }

    function _snapshotVenues(Snapshot memory s, address account) private view {
        address[] memory ps = ITreasuryAccount(account).positionSleeves();
        IPerpVenue[][] memory vs = new IPerpVenue[][](ps.length);
        uint256 n;
        for (uint256 i; i < ps.length; ++i) {
            vs[i] = IPositionSleeve(ps[i]).venues();
            n += vs[i].length;
        }
        s.venues = new Venue[](n);
        uint256 k;
        for (uint256 i; i < ps.length; ++i) {
            uint8 band = ISleeve(ps[i]).band();
            for (uint256 j; j < vs[i].length; ++j) {
                (Venue memory v, int256 delta) = _readVenue(vs[i][j]);
                s.venues[k++] = v;
                s.nav += v.equity;
                _addToBand(s, band, v.equity);
                s.perpDeltaUsd += delta;
            }
        }
    }

    /// A venue's equity and positions, valued with the Valuer (per token, multiplier once). A position that
    /// cannot be priced (delisted underlying) makes the venue stale: no new risk there until it is priced again.
    function _readVenue(IPerpVenue venue) private view returns (Venue memory v, int256 delta) {
        v.venue = address(venue);
        (v.equity, v.stale) = venue.equityOf();
        IPerpVenue.Position[] memory pos = venue.positionOf();
        for (uint256 i; i < pos.length; ++i) {
            int256 t = pos[i].tokens;
            uint256 abs = t < 0 ? uint256(-t) : uint256(t);
            try valuer.value(pos[i].underlying, abs) returns (uint256 usd, bool) {
                v.gross += usd;
                delta += t < 0 ? -int256(usd) : int256(usd);
            } catch {
                v.stale = true;
            }
        }
    }

    // ---------------------------------------------------------------- check

    struct Ctx {
        TreasuryPolicy.Policy p;
        Snapshot a; // after
        uint8[] kinds;
        uint256 notional;
        bool stockIncreased;
        uint256 moved; // sum of |delta usd| over assets and venue equity
        uint256 grossMoved; // sum of |delta gross notional| over venues
        uint256 cursor; // next unread entry of allowProof
        bool venueRiskUp; // some venue's gross or margin went up
        bool venueGrossDown; // some venue's gross notional went down
    }

    /// Called by the account itself after running the operation. Returns OK or the first broken rule's code.
    /// On OK it records the notional in the day counter and consumes the approval ticket if one was needed.
    ///
    /// `allowProof` holds one Merkle proof per asset whose balance increased, in tracked-asset order, each
    /// prefixed by its length: [len0, p0..., len1, p1..., ...] (see `packProofs`).
    function check(
        address account,
        bytes32 opHash,
        Snapshot calldata before,
        bytes32[] calldata allowProof,
        bytes32 approvalTicket
    ) external returns (uint8 code) {
        if (msg.sender != account) revert NotAccount();
        Ctx memory c;
        (c.p,,) = ITreasuryAccount(account).policy().current();
        uint8[] memory bands;
        address[] memory assets;
        (assets, c.kinds, bands) = ITreasuryAccount(account).trackedAssets();
        c.a = snapshot(account);

        // Rules 5-6 (T1): nothing outside the tracked set may change.
        if (c.a.eth != before.eth || !_sameAssets(assets, before.assets) || !_sameVenues(c.a.venues, before.venues)) {
            return R6_UNKNOWN_CHANGE;
        }

        // Rule 2, rule 6 (venue allow-list and freshness) and the notional for rule 3.
        code = _assetRules(c, before, allowProof);
        if (code != OK) return code;
        code = _venueRules(c, before, allowProof);
        if (code != OK) return code;
        c.notional = c.moved / 2 + c.grossMoved;

        // Rules 5-6: value may only leave the tracked set as bounded fees/slippage.
        if (before.nav > c.a.nav && before.nav - c.a.nav > c.notional * maxOpLossBps / BPS) return R6_UNKNOWN_CHANGE;

        // Rule 3.
        if (c.notional > uint256(c.p.perOrderCapUsd) * WAD) return R3_ORDER_CAP;
        if (dayTotal(account) + c.notional > uint256(c.p.perDayCapUsd) * WAD) return R3_DAY_CAP;

        // Rule 4.
        if (!_bandsOk(c, before)) return R4_BAND;

        // Rules 5-6: venue caps, leverage, net delta.
        code = _overlayRules(c, before);
        if (code != OK) return code;

        code = _riskRules(c, before, account);
        if (code != OK) return code;

        // Rule 9.
        bool needsTicket = c.notional > uint256(c.p.approvalAboveUsd) * WAD;
        BoardApprovals approvals;
        if (needsTicket) {
            approvals = BoardApprovals(ITreasuryAccount(account).approvals());
            if (address(approvals) == address(0) || !approvals.isValid(approvalTicket, opHash, account)) {
                return R9_APPROVAL;
            }
        }

        _record(account, c.notional);
        if (needsTicket) approvals.consume(approvalTicket, opHash, account);
        return OK;
    }

    function _assetRules(Ctx memory c, Snapshot calldata b, bytes32[] calldata proofs) private view returns (uint8) {
        c.moved += _absDiff(c.a.privateUsd, b.privateUsd);
        for (uint256 i; i < c.a.assets.length; ++i) {
            c.moved += _absDiff(c.a.usd[i], b.usd[i]);
            if (c.a.raw[i] <= b.raw[i]) continue;

            // Rule 2: every increased asset is allowed by the policy and, for Stock Tokens, canonical.
            bool ok;
            (ok, c.cursor) = _verifyNext(proofs, c.cursor, c.p.instrumentAllowRoot, _leaf(c, i));
            if (!ok) return R2_NOT_ALLOWED;
            if (c.kinds[i] == AssetValuation.KIND_STOCK_TOKEN) {
                if (!registry.isCanonical(c.a.assets[i])) return R2_NOT_CANONICAL;
                c.stockIncreased = true;
            }
        }
        return OK;
    }

    /// Rule 6, per venue whose risk went up (more gross notional, or more margin than rounding): the venue's
    /// numbers are fresh and it is in venueAllowRoot (proofs follow the asset proofs, in venue order).
    function _venueRules(Ctx memory c, Snapshot calldata b, bytes32[] calldata proofs) private pure returns (uint8) {
        for (uint256 i; i < c.a.venues.length; ++i) {
            Venue memory a = c.a.venues[i];
            Venue calldata v = b.venues[i];
            c.moved += _absDiff(a.equity, v.equity);
            c.grossMoved += _absDiff(a.gross, v.gross);
            if (a.gross < v.gross) c.venueGrossDown = true;
            if (!_riskUp(a, v)) continue;
            c.venueRiskUp = true;
            if (a.gross > v.gross) c.stockIncreased = true; // new perp exposure is new risk for rule 8
            if (a.stale || v.stale) return R6_STALE_VENUE;
            bool ok;
            (ok, c.cursor) = _verifyNext(proofs, c.cursor, c.p.venueAllowRoot, keccak256(abi.encode(a.venue)));
            if (!ok) return R6_VENUE_NOT_ALLOWED;
        }
        return OK;
    }

    function _overlayRules(Ctx memory c, Snapshot calldata b) private pure returns (uint8) {
        for (uint256 i; i < c.a.venues.length; ++i) {
            Venue memory a = c.a.venues[i];
            Venue calldata v = b.venues[i];
            if (a.equity == v.equity && a.gross == v.gross) continue; // untouched venue

            // Rule 6: equity at one venue within perVenueCapBps of NAV, or moving down toward it.
            if (_riskUp(a, v) && c.a.nav != 0) {
                TreasuryPolicy.Band memory cap = TreasuryPolicy.Band(0, c.p.perVenueCapBps);
                if (!bandOk(cap, _weight(v.equity, b.nav), _weight(a.equity, c.a.nav))) return R6_VENUE_CAP;
            }
            // Rule 5: gross / equity <= maxLeverageX10 / 10, unless the operation lowered the ratio.
            if (a.gross != 0 && a.gross * 10 > a.equity * c.p.maxLeverageX10) {
                if (!(a.gross * v.equity < v.gross * a.equity)) return R5_LEVERAGE;
            }
        }

        // Rule 5: net delta inside the overlay band, or moving toward it from the same side (T2 only).
        if (c.p.maxLeverageX10 != 0 && c.a.nav != 0) {
            int256 wB = _sweight(int256(b.stockUsd) + b.perpDeltaUsd, b.nav);
            int256 wA = _sweight(int256(c.a.stockUsd) + c.a.perpDeltaUsd, c.a.nav);
            if (!netDeltaOk(c.p.netDeltaMinBps, c.p.netDeltaMaxBps, wB, wA)) return R5_NET_DELTA;
        }
        return OK;
    }

    /// Signed weights are WAD (1e18 = 100% of NAV). Same "toward from the same side" rule as bandOk.
    function netDeltaOk(int16 minBps, int16 maxBps, int256 wBefore, int256 wAfter) public pure returns (bool) {
        int256 lo = int256(minBps) * int256(WAD) / int256(BPS);
        int256 hi = int256(maxBps) * int256(WAD) / int256(BPS);
        if (wAfter < lo) return wBefore < wAfter;
        if (wAfter > hi) return wBefore > wAfter;
        return true;
    }

    function _riskUp(Venue memory a, Venue calldata v) private pure returns (bool) {
        return a.gross > v.gross || a.equity > v.equity + VENUE_DUST;
    }

    function _absDiff(uint256 x, uint256 y) private pure returns (uint256) {
        return x > y ? x - y : y - x;
    }

    function _sweight(int256 part, uint256 nav) private pure returns (int256) {
        return part * int256(WAD) / int256(nav);
    }

    function _leaf(Ctx memory c, uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode(c.a.assets[i], c.kinds[i]));
    }

    function _riskRules(Ctx memory c, Snapshot calldata b, address account) private view returns (uint8) {
        uint256 eqBefore = _weight(b.equityUsd, b.nav);
        uint256 eqAfter = _weight(c.a.equityUsd, c.a.nav);

        // Rule 7: off-hours (a held equity's feed on hold) only risk-reducing operations: equity weight down, or a
        // pure perp reduction (gross notional down at a venue, no venue risk up, no stock bought, spot value not
        // up). The perp reduction costs a spread, so NAV dips and the equity weight ticks up without new risk.
        if (c.p.noNewRiskOffHours && (b.equityHold || c.a.equityHold) && !(eqAfter < eqBefore)) {
            bool perpReduce = c.venueGrossDown && !c.venueRiskUp && !c.stockIncreased && c.a.equityUsd <= b.equityUsd;
            if (!perpReduce) return R7_OFF_HOURS;
        }

        // Rule 8: drawdown from the period-start NAV (written by PeriodClose).
        address pc = ITreasuryAccount(account).periodClose();
        if (pc == address(0)) return OK;
        uint256 start = IPeriodStartNav(pc).periodStartNav();
        if (start == 0) return OK;
        int256 dd = (int256(b.nav) - int256(start)) * int256(BPS) / int256(start);
        if (dd <= c.p.deriskAtDrawdownBps) {
            // DERISK: only operations that move the book toward cash.
            if (c.stockIncreased || !(_weight(c.a.cashUsd, c.a.nav) > _weight(b.cashUsd, b.nav))) return R8_DERISK;
        } else if (dd <= c.p.pauseNewRiskAtDrawdownBps) {
            // PAUSED: only risk-reducing operations (no Stock Token bought, equity weight not up).
            if (c.stockIncreased || eqAfter > eqBefore) return R8_PAUSED;
        }
        return OK;
    }

    /// Rule 4: each band holds after the operation, or its weight moved strictly toward the band from the same
    /// side (jumping across the band to the other side is not "toward").
    function _bandsOk(Ctx memory c, Snapshot calldata b) private pure returns (bool) {
        if (c.a.nav == 0) return true; // nothing held, nothing to weigh
        return bandOk(c.p.cash, _weight(b.cashUsd, b.nav), _weight(c.a.cashUsd, c.a.nav))
            && bandOk(c.p.equity, _weight(b.equityUsd, b.nav), _weight(c.a.equityUsd, c.a.nav))
            && bandOk(c.p.basis, _weight(b.basisUsd, b.nav), _weight(c.a.basisUsd, c.a.nav));
    }

    /// Weights are WAD (1e18 = 100%).
    function bandOk(TreasuryPolicy.Band memory band, uint256 wBefore, uint256 wAfter) public pure returns (bool) {
        uint256 lo = uint256(band.minBps) * WAD / BPS;
        uint256 hi = uint256(band.maxBps) * WAD / BPS;
        if (wAfter < lo) return wBefore < wAfter;
        if (wAfter > hi) return wBefore > wAfter;
        return true;
    }

    function _weight(uint256 part, uint256 nav) private pure returns (uint256) {
        return nav == 0 ? 0 : part * WAD / nav;
    }

    // ---------------------------------------------------------------- proofs

    function _verifyNext(bytes32[] calldata proofs, uint256 cursor, bytes32 root, bytes32 leaf)
        private
        pure
        returns (bool ok, uint256 next)
    {
        if (cursor >= proofs.length) return (false, cursor);
        uint256 len = uint256(proofs[cursor]);
        if (len > proofs.length - cursor - 1) return (false, cursor);
        next = cursor + 1 + len;
        ok = MerkleProof.verifyCalldata(proofs[cursor + 1:next], root, leaf);
    }

    /// Packs one proof per increased asset into the `allowProof` layout `check` expects.
    function packProofs(bytes32[][] calldata proofs) external pure returns (bytes32[] memory out) {
        uint256 n;
        for (uint256 i; i < proofs.length; ++i) n += 1 + proofs[i].length;
        out = new bytes32[](n);
        uint256 k;
        for (uint256 i; i < proofs.length; ++i) {
            out[k++] = bytes32(proofs[i].length);
            for (uint256 j; j < proofs[i].length; ++j) out[k++] = proofs[i][j];
        }
    }

    // ---------------------------------------------------------------- day counter

    /// Notional (USD 1e18) recorded in the current hour and the previous 24 hours.
    function dayTotal(address account) public view returns (uint256 total) {
        uint256 hour = block.timestamp / 1 hours;
        Bucket[DAY_BUCKETS] storage bs = _buckets[account];
        for (uint256 i; i < DAY_BUCKETS; ++i) {
            if (uint256(bs[i].hour) + DAY_BUCKETS > hour) total += bs[i].notional;
        }
    }

    function _record(address account, uint256 notional) private {
        if (notional == 0) return;
        uint64 hour = uint64(block.timestamp / 1 hours);
        Bucket storage b = _buckets[account][hour % DAY_BUCKETS];
        if (b.hour != hour) {
            b.hour = hour;
            b.notional = uint192(notional);
        } else {
            b.notional += uint192(notional);
        }
    }

    function _sameVenues(Venue[] memory x, Venue[] calldata y) private pure returns (bool) {
        if (x.length != y.length) return false;
        for (uint256 i; i < x.length; ++i) {
            if (x[i].venue != y[i].venue) return false;
        }
        return true;
    }

    function _sameAssets(address[] memory x, address[] calldata y) private pure returns (bool) {
        if (x.length != y.length) return false;
        for (uint256 i; i < x.length; ++i) {
            if (x[i] != y[i]) return false;
        }
        return true;
    }
}
