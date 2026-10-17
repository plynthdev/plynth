// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {SavingsVault} from "../../src/consumer/SavingsVault.sol";
import {CrowdBuy} from "../../src/consumer/CrowdBuy.sol";
import {JitterBeacon} from "../../src/core/JitterBeacon.sol";
import {MockUSDG} from "../../src/testnet/MockUSDG.sol";
import {MockFeed} from "../../src/testnet/MockFeed.sol";
import {CrowdBuyBase, HookStock} from "./CrowdBuyBase.sol";

/// Random joins, cancels, executions, claims, multiplier changes and time jumps.
contract CrowdHandler is Test {
    CrowdBuy public crowd;
    SavingsVault public vault;
    MockUSDG public usdg;
    address public keeper;
    address[] public actors;
    address[] public assets;
    MockFeed[] public feeds;
    uint256 public srcNonce = 1e9;
    uint256 public executions;
    uint256 public claims;

    constructor(CrowdBuy c, address k, address[] memory as_, MockFeed[] memory fs) {
        crowd = c;
        vault = c.vault();
        usdg = MockUSDG(address(c.usdg()));
        keeper = k;
        assets = as_;
        feeds = fs;
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            vm.startPrank(a);
            vault.setSettings(SavingsVault.Settings(10, 1, uint64(500e6), 0, uint8(i % 3)));
            SavingsVault.MixEntry[] memory m = new SavingsVault.MixEntry[](i % 2 == 0 ? 2 : 1);
            if (m.length == 2) {
                m[0] = SavingsVault.MixEntry(as_[0], uint16(1000 + i * 1000));
                m[1] = SavingsVault.MixEntry(as_[1], uint16(9000 - i * 1000));
            } else {
                m[0] = SavingsVault.MixEntry(as_[i % 2], 10_000);
            }
            vault.setMix(m);
            vm.stopPrank();
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function join(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1, 9_999_999);
        usdg.mint(a, amount);
        vm.startPrank(a);
        usdg.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        vm.prank(keeper);
        vault.accrue(a, bytes32(++srcNonce), 0, 10e6 - amount);
        (, uint256 pending) = vault.balancesOf(a);
        if (pending == 0) return; // weekly cap reached
        vm.prank(a);
        crowd.join(a);
    }

    function cancel(uint256 actorSeed, uint256 assetSeed) external {
        address a = actors[actorSeed % actors.length];
        address asset = assets[assetSeed % assets.length];
        uint256 id = crowd.currentBookId(asset);
        if (crowd.orderOf(asset, id, a) == 0) return;
        vm.prank(a);
        crowd.cancel(asset, id);
    }

    /// Reveals the current window's beacon (secrets are keccak256(abi.encode(tag, windowIndex))).
    function reveal(uint256 assetSeed) external {
        uint256 i = assetSeed % assets.length;
        (uint64 start,) = crowd.windowOf(block.timestamp);
        uint256 w = (start - crowd.GENESIS()) / 1 days;
        bytes32 secret = keccak256(abi.encode(i == 0 ? "a" : "b", w));
        try JitterBeacon(address(crowd.beacon())).reveal(crowd.beaconKey(assets[i], start), secret) {} catch {}
    }

    function execute(uint256 assetSeed) external {
        uint256 i = assetSeed % assets.length;
        feeds[i].set(feeds[i].latestAnswer());
        vm.prank(keeper); // keeper-only until windowEnd - GRACE
        try crowd.execute(assets[i]) {
            executions++;
        } catch {}
    }

    function claim(uint256 actorSeed, uint256 assetSeed, uint256 bookSeed) external {
        address a = actors[actorSeed % actors.length];
        address asset = assets[assetSeed % assets.length];
        uint256 id = crowd.currentBookId(asset);
        if (id == 0) return;
        id = bookSeed % id; // an executed book
        if (crowd.orderOf(asset, id, a) == 0 || crowd.settled(asset, id, a)) return;
        vm.prank(a);
        crowd.claimOpen(asset, id);
        claims++;
    }

    function setMultiplier(uint256 assetSeed, uint256 m) external {
        HookStock(assets[assetSeed % assets.length]).setMultiplier(bound(m, 1e17, 10e18));
    }

    function warp(uint256 dt) external {
        uint256 t = block.timestamp + bound(dt, 1 minutes, 12 hours);
        if (t > 1_800_000_000 + 59 days) return; // beacons are committed for 58 windows
        vm.warp(t);
    }
}

contract CrowdBuyInvariantTest is CrowdBuyBase {
    CrowdHandler internal handler;
    address[] internal assetList;

    function _minCrowd() internal pure override returns (uint32) {
        return 2;
    }

    function setUp() public override {
        super.setUp();
        assetList.push(address(tokA));
        assetList.push(address(tokB));
        for (uint256 w; w < 58; ++w) {
            _commit(address(tokA), w, keccak256(abi.encode("a", w)));
            _commit(address(tokB), w, keccak256(abi.encode("b", w)));
        }
        MockFeed[] memory fs = new MockFeed[](2);
        fs[0] = feedA;
        fs[1] = feedB;
        handler = new CrowdHandler(crowd, keeper, assetList, fs);
        feedA.transferOwnership(address(handler));
        feedB.transferOwnership(address(handler));
        usdg.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    /// R9: Stock Token balance >= unclaimed allocations + dust; USDG balance == sum of open orders.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_R9_balancesCoverObligations() public view {
        uint256 openUsdg;
        for (uint256 k; k < assetList.length; ++k) {
            address asset = assetList[k];
            uint256 cur = crowd.currentBookId(asset);
            openUsdg += crowd.book(asset, cur).usdgTotal;
            uint256 owed = crowd.dust(asset);
            for (uint256 id; id < cur; ++id) {
                uint256 sumAlloc;
                for (uint256 i; i < handler.actorCount(); ++i) {
                    address a = handler.actors(i);
                    uint256 alloc = crowd.allocationOf(asset, id, a);
                    sumAlloc += alloc;
                    if (!crowd.settled(asset, id, a)) owed += alloc;
                }
                CrowdBuy.Book memory b = crowd.book(asset, id);
                assertTrue(b.executed);
                assertLe(sumAlloc, b.rawOut, "over-allocated");
                CrowdBuy.Settlement memory s = crowd.settlement(asset, id);
                if (s.settledAccounts == b.accounts) {
                    // fully settled: exact accounting, counted once in dust
                    assertEq(s.settledRaw, sumAlloc);
                }
            }
            assertGe(HookStock(asset).balanceOf(address(crowd)), owed, "token balance < owed + dust");
        }
        assertEq(usdg.balanceOf(address(crowd)), openUsdg, "usdg == open orders");
    }

    /// R3 across every fully settled book: sum of allocations + that book's dust == rawOut.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_R3_dustIsExactForSettledBooks() public view {
        for (uint256 k; k < assetList.length; ++k) {
            address asset = assetList[k];
            uint256 cur = crowd.currentBookId(asset);
            uint256 dustSum;
            for (uint256 id; id < cur; ++id) {
                CrowdBuy.Book memory b = crowd.book(asset, id);
                CrowdBuy.Settlement memory s = crowd.settlement(asset, id);
                if (s.settledAccounts == b.accounts) dustSum += b.rawOut - s.settledRaw;
            }
            assertEq(crowd.dust(asset), dustSum);
        }
    }

    /// The handler must be able to reach execute and claimOpen, or the invariants above prove little.
    /// This is a fixed sequence, not an afterInvariant check: forge runs afterInvariant after every run,
    /// so one unlucky run with no claims failed the suite, and the shrunk 1-call sequence was persisted
    /// to cache/invariant/failures and replayed as a failure on every later run.
    function test_handlerReachesExecuteAndClaim() public {
        // actors 0 and 2 both hold A and B in their mix, so each book gets a crowd of 2.
        handler.join(0, 5e6);
        handler.join(2, 5e6);
        assertEq(crowd.book(address(tokA), 0).accounts, 2);
        vm.warp(GENESIS + 1 hours);
        handler.reveal(0);
        uint64 at = beacon.executeAfter(crowd.beaconKey(address(tokA), GENESIS));
        if (block.timestamp < at) vm.warp(at);
        handler.execute(0);
        assertEq(handler.executions(), 1, "execute not reachable from the handler");
        handler.claim(0, 0, 0);
        assertEq(handler.claims(), 1, "claimOpen not reachable from the handler");
        invariant_R3_dustIsExactForSettledBooks();
        invariant_R9_balancesCoverObligations();
    }
}
