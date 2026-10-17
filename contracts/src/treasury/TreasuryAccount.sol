// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {PolicyGuard} from "./PolicyGuard.sol";
import {IAdapter, ISleeve} from "../interfaces/ISleeve.sol";
import {IPositionSleeve} from "../interfaces/IPerpVenue.sol";
import {ITierSource} from "../interfaces/ITierSource.sol";
import {AssetValuation} from "../libs/AssetValuation.sol";
import {Valuer} from "../core/Valuer.sol";

/// The parts of a PrivateSleeve the account reads.
interface IPrivateSleeveAccount {
    function account() external view returns (address);
    function bookUsd() external view returns (uint256);
}

/// The part of a PeriodClose the account reads: the cash asset fees are paid in (USDG).
interface IPeriodCloseCash {
    function cash() external view returns (address);
}

/// The treasury's wallet. Desks are plain keys that call `execute`: the account checks the desk's scope,
/// snapshots its state, runs the adapter with `call` (exact approvals, reset afterwards), then asks the
/// PolicyGuard to check the resulting state against the board's policy and reverts everything on a breach.
/// This keeps "agent proposes, code disposes" without an ERC-4337 bundler or paymaster.
///
/// The board can always take assets out with `withdrawToBoard`; nothing (pause, drawdown, stale feeds,
/// revoked desks) gates it. Non-upgradeable.
///
/// Deployed either directly (constructor) or as an EIP-1167 clone by TreasuryFactory (`initialize`, once).
/// All-zero constructor arguments deploy a locked implementation for the factory.
///
/// Desk limit: with a tier source (the factory's PLTH staking), `registerDesk` refuses a desk beyond the board's
/// `tierOf(board).maxDesks`; revoked desks do not count. The tier is read only when a desk is registered: a board
/// that unstakes below its tier keeps the desks it already has (revoking is the board's call), it just cannot add
/// more until it stakes again or revokes down to the limit.
///
/// Cash before desks: the PeriodClose's cash asset (USDG) is always in `trackedAssets` and `navUsd`, also when
/// no registered sleeve lists it yet ("loose cash"), so a treasury funded before its first desk shows its money
/// to the guard, the close, the fee and the CFO pack. Once a sleeve lists the asset, the sleeve's entry replaces
/// the loose one (same balance, same value).
contract TreasuryAccount is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint8 public constant BAND_CASH = 0;
    uint8 public constant BAND_EQUITY = 1;
    uint8 public constant BAND_BASIS = 2;
    uint256 public constant MAX_SLEEVES = 8;
    uint256 public constant MAX_ADAPTERS_PER_DESK = 8;
    uint256 public constant MAX_ASSETS_PER_SLEEVE = 16;

    /// Token amount the account approves to the adapter for one operation.
    struct Pull {
        address token;
        uint256 amount;
    }

    struct Desk {
        address key;
        bool active;
        address[] adapters;
    }

    address public board;
    TreasuryPolicy public policy;
    PolicyGuard public guard;
    address public approvals;
    bool private _initialized;
    address public periodClose;
    /// PLTH staking tiers (TreasuryFactory's); zero = no desk limit.
    ITierSource public tiers;
    /// Registered desks that are not revoked (counted against `tiers.tierOf(board).maxDesks`).
    uint256 public activeDeskCount;

    mapping(bytes32 deskId => Desk) private _desks;
    mapping(address key => uint256) private _activeDesksOfKey;
    address[] private _sleeves; // every adapter ever registered; never removed so its holdings stay in NAV
    mapping(address sleeve => bool) public isSleeve;
    address[] private _positionSleeves; // sleeves whose value sits at perp venues (IPositionSleeve)
    mapping(address asset => bool) private _assetTaken;
    /// Private sleeve (PrivateSleeve) and the only desk that may run it. Zero = none.
    address public privateSleeve;
    bytes32 public privateDeskId;
    /// A PeriodClose replacement waiting out the policy's TIMELOCK (zero = none) and when it can be applied.
    address public pendingPeriodClose;
    uint64 public pendingPeriodCloseEta;

    event DeskRegistered(bytes32 indexed deskId, address indexed key, address[] adapters);
    event DeskRevoked(bytes32 indexed deskId);
    event SleeveAdded(address indexed sleeve, uint8 band);
    event PeriodCloseSet(address indexed periodClose);
    event PeriodCloseProposed(address indexed periodClose, uint64 eta);
    event PeriodCloseCancelled(address indexed periodClose);
    event GuardDecision(bytes32 indexed opHash, bytes32 indexed deskId, uint8 code);
    event Executed(bytes32 indexed opHash, bytes32 indexed deskId, address indexed adapter);
    event WithdrawnToBoard(address indexed token, uint256 amount);
    event CloseFeePaid(address indexed token, address indexed to, uint256 amount);
    event PrivateSleeveSet(address indexed sleeve, bytes32 indexed deskId);
    event TiersSet(address indexed tiers);

    error NotBoard();
    error ZeroAddress();
    error BadDesk();
    error DeskActive();
    error DeskNotActive();
    error BadAdapters();
    error TooManySleeves();
    error BadSleeve(address sleeve);
    error DuplicateAsset(address asset);
    error GuardRejected(uint8 code);
    error NotPeriodClose();
    error AlreadyInitialized();
    error PrivateBookOpen();
    error TierTooLow(address board, uint256 maxDesks);
    error PeriodCloseAlreadySet();
    error PeriodCloseNotSet();
    error NothingPending();
    error TimelockActive(uint64 eta);

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    constructor(address board_, TreasuryPolicy policy_, PolicyGuard guard_, address approvals_) {
        if (
            board_ == address(0) && address(policy_) == address(0) && address(guard_) == address(0)
                && approvals_ == address(0)
        ) {
            _initialized = true; // implementation for clones: never usable itself
            return;
        }
        _init(board_, policy_, guard_, approvals_);
    }

    /// Clone setup (TreasuryFactory), once. `periodClose_` may be zero (drawdown rule off until the board sets it
    /// with `setPeriodClose`);
    /// `tiers_` may be zero (no desk limit).
    function initialize(
        address board_,
        TreasuryPolicy policy_,
        PolicyGuard guard_,
        address approvals_,
        address periodClose_,
        ITierSource tiers_
    ) external {
        _init(board_, policy_, guard_, approvals_);
        if (periodClose_ != address(0)) {
            periodClose = periodClose_;
            emit PeriodCloseSet(periodClose_);
        }
        if (address(tiers_) != address(0)) {
            tiers = tiers_;
            emit TiersSet(address(tiers_));
        }
    }

    function _init(address board_, TreasuryPolicy policy_, PolicyGuard guard_, address approvals_) private {
        if (_initialized) revert AlreadyInitialized();
        if (
            board_ == address(0) || address(policy_) == address(0) || address(guard_) == address(0)
                || approvals_ == address(0)
        ) revert ZeroAddress();
        _initialized = true;
        board = board_;
        policy = policy_;
        guard = guard_;
        approvals = approvals_;
    }

    // ---------------------------------------------------------------- board

    function registerDesk(bytes32 deskId, address key, address[] calldata adapters) external onlyBoard {
        if (deskId == bytes32(0) || key == address(0)) revert BadDesk();
        if (_desks[deskId].active) revert DeskActive();
        if (adapters.length == 0 || adapters.length > MAX_ADAPTERS_PER_DESK) revert BadAdapters();
        if (address(tiers) != address(0)) {
            uint256 maxDesks = tiers.tierOf(board).maxDesks;
            if (activeDeskCount >= maxDesks) revert TierTooLow(board, maxDesks);
        }
        for (uint256 i; i < adapters.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (adapters[i] == adapters[j]) revert BadAdapters();
            }
            if (!isSleeve[adapters[i]]) _addSleeve(adapters[i]);
        }
        _desks[deskId] = Desk(key, true, adapters);
        ++_activeDesksOfKey[key];
        ++activeDeskCount;
        emit DeskRegistered(deskId, key, adapters);
    }

    function revokeDesk(bytes32 deskId) external onlyBoard {
        Desk storage d = _desks[deskId];
        if (!d.active) revert DeskNotActive();
        d.active = false;
        --_activeDesksOfKey[d.key];
        --activeDeskCount;
        emit DeskRevoked(deskId);
    }

    /// The contract whose `periodStartNav()` drives the drawdown rule (PeriodClose); it also pays the close fee
    /// and resets the private sleeve's book. Set once, instantly, while none is set (the factory wires it at
    /// `initialize`); after that it can only be replaced, never cleared, and only through
    /// `proposePeriodClose` / `applyPeriodClose` with the policy's TIMELOCK, so the drawdown rule cannot be
    /// switched off (or pointed at a PeriodClose with a fresh `periodStartNav` of 0) outside the timelock.
    function setPeriodClose(address periodClose_) external onlyBoard {
        if (periodClose_ == address(0)) revert ZeroAddress();
        if (periodClose != address(0)) revert PeriodCloseAlreadySet();
        periodClose = periodClose_;
        emit PeriodCloseSet(periodClose_);
    }

    /// Starts the TIMELOCK for replacing the PeriodClose (a new proposal replaces the old one and restarts it).
    function proposePeriodClose(address periodClose_) external onlyBoard {
        if (periodClose_ == address(0)) revert ZeroAddress();
        if (periodClose == address(0)) revert PeriodCloseNotSet();
        uint64 eta = uint64(block.timestamp) + policy.TIMELOCK();
        pendingPeriodClose = periodClose_;
        pendingPeriodCloseEta = eta;
        emit PeriodCloseProposed(periodClose_, eta);
    }

    function cancelPeriodClose() external onlyBoard {
        address p = pendingPeriodClose;
        if (p == address(0)) revert NothingPending();
        delete pendingPeriodClose;
        delete pendingPeriodCloseEta;
        emit PeriodCloseCancelled(p);
    }

    /// Anyone, once the TIMELOCK has passed.
    function applyPeriodClose() external {
        address p = pendingPeriodClose;
        if (p == address(0)) revert NothingPending();
        if (block.timestamp < pendingPeriodCloseEta) revert TimelockActive(pendingPeriodCloseEta);
        delete pendingPeriodClose;
        delete pendingPeriodCloseEta;
        periodClose = p;
        emit PeriodCloseSet(p);
    }

    /// Designates the private sleeve and the desk allowed to move holdings into it (`deskId`; the desk must list
    /// the sleeve among its adapters to reach it). The sleeve must be built for this account. Replacing a sleeve
    /// whose book is not empty is refused, so a shielded book cannot drop out of the proven close. The tier gate
    /// lives in the sleeve (shielding needs it, unshielding never does).
    function setPrivateSleeve(address sleeve, bytes32 deskId) external onlyBoard {
        if (sleeve != address(0) && IPrivateSleeveAccount(sleeve).account() != address(this)) revert BadSleeve(sleeve);
        address old = privateSleeve;
        if (old != address(0) && old != sleeve && IPrivateSleeveAccount(old).bookUsd() != 0) revert PrivateBookOpen();
        privateSleeve = sleeve;
        privateDeskId = deskId;
        emit PrivateSleeveSet(sleeve, deskId);
    }

    /// Sends `amount` of `token` (address(0) = ETH) to the board. Never gated by policy, guard or desks.
    function withdrawToBoard(address token, uint256 amount) external onlyBoard {
        if (token == address(0)) {
            (bool ok,) = board.call{value: amount}("");
            require(ok, "eth");
        } else {
            IERC20(token).safeTransfer(board, amount);
        }
        emit WithdrawnToBoard(token, amount);
    }

    // ---------------------------------------------------------------- period close

    /// The platform fee leg of a period close: only the board-appointed PeriodClose may move `amount` of
    /// `token` to `to`. PeriodClose computes the fee from the NAV it just recomputed and bounds it by idle cash.
    function payCloseFee(address token, address to, uint256 amount) external nonReentrant {
        if (msg.sender != periodClose || msg.sender == address(0)) revert NotPeriodClose();
        IERC20(token).safeTransfer(to, amount);
        emit CloseFeePaid(token, to, amount);
    }

    // ---------------------------------------------------------------- desks

    /// `data` = abi.encode(Pull[] pulls, bytes runData): the account approves each pull to `adapter`, calls
    /// `adapter.run(runData)`, resets the approvals, then runs the guard. Reverts GuardRejected(code) on any
    /// breach, so a desk can simulate with eth_call and read the reason code.
    function execute(
        bytes32 deskId,
        address adapter,
        bytes calldata data,
        bytes32[] calldata allowProof,
        bytes32 approvalTicket
    ) external nonReentrant returns (bytes memory result) {
        if (!_inScope(deskId, adapter)) revert GuardRejected(1); // rule 1: desk scope
        // Rule 10: moves into the private sleeve only by the board-designated private desk.
        if (adapter == privateSleeve && deskId != privateDeskId) revert GuardRejected(17);

        bytes32 opHash = opHashOf(deskId, adapter, data);
        PolicyGuard.Snapshot memory before = guard.snapshot(address(this));

        (Pull[] memory pulls, bytes memory runData) = abi.decode(data, (Pull[], bytes));
        for (uint256 i; i < pulls.length; ++i) {
            IERC20(pulls[i].token).forceApprove(adapter, pulls[i].amount);
        }
        result = IAdapter(adapter).run(runData);
        for (uint256 i; i < pulls.length; ++i) {
            IERC20(pulls[i].token).forceApprove(adapter, 0);
        }

        uint8 code = guard.check(address(this), opHash, before, allowProof, approvalTicket);
        if (code != 0) revert GuardRejected(code);
        emit GuardDecision(opHash, deskId, code);
        emit Executed(opHash, deskId, adapter);
    }

    // ---------------------------------------------------------------- views

    /// The id BoardApprovals tickets are bound to. Same inputs → same hash; a ticket is usable once.
    function opHashOf(bytes32 deskId, address adapter, bytes calldata data) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), deskId, adapter, keccak256(data)));
    }

    /// NAV in USD (1e18) as the sum of every sleeve's `valueOf` plus loose cash; `hold` if any price is stale.
    function navUsd() external view returns (uint256 nav, bool hold) {
        for (uint256 i; i < _sleeves.length; ++i) {
            (uint256 v, bool h) = ISleeve(_sleeves[i]).valueOf(address(this));
            nav += v;
            hold = hold || h;
        }
        (, uint256 loose) = looseCash();
        nav += loose;
    }

    /// The PeriodClose's cash asset while no registered sleeve lists it (zero otherwise), and its USD value (1e18).
    /// It counts in NAV and in the cash band.
    function looseCash() public view returns (address asset, uint256 usd) {
        asset = _looseCashAsset();
        if (asset != address(0)) {
            (usd,) = AssetValuation.value(
                Valuer(address(0)), asset, AssetValuation.KIND_CASH, IERC20(asset).balanceOf(address(this))
            );
        }
    }

    function trackedAssets()
        external
        view
        returns (address[] memory assets, uint8[] memory kinds, uint8[] memory bands)
    {
        uint256 n;
        uint256 len = _sleeves.length;
        address[][] memory perAssets = new address[][](len);
        uint8[][] memory perKinds = new uint8[][](len);
        uint8[] memory perBand = new uint8[](len);
        for (uint256 i; i < len; ++i) {
            ISleeve s = ISleeve(_sleeves[i]);
            (perAssets[i], perKinds[i]) = s.assets();
            perBand[i] = s.band();
            n += perAssets[i].length;
        }
        address loose = _looseCashAsset();
        if (loose != address(0)) ++n;
        assets = new address[](n);
        kinds = new uint8[](n);
        bands = new uint8[](n);
        uint256 k;
        for (uint256 i; i < len; ++i) {
            for (uint256 j; j < perAssets[i].length; ++j) {
                assets[k] = perAssets[i][j];
                kinds[k] = perKinds[i][j];
                bands[k] = perBand[i];
                ++k;
            }
        }
        if (loose != address(0)) {
            assets[k] = loose; // kind 0 (cash) and band 0 (cash) are the zero defaults
        }
    }

    function sleeves() external view returns (address[] memory) {
        return _sleeves;
    }

    /// The registered sleeves that hold positions at perp venues; the guard reads their venues directly.
    function positionSleeves() external view returns (address[] memory) {
        return _positionSleeves;
    }

    function desk(bytes32 deskId) external view returns (Desk memory) {
        return _desks[deskId];
    }

    function isDeskKey(address key) external view returns (bool) {
        return _activeDesksOfKey[key] > 0;
    }

    // ---------------------------------------------------------------- internal

    /// A PeriodClose without `cash()` (or none) means no loose cash: the account then tracks sleeves only.
    function _looseCashAsset() private view returns (address) {
        address pc = periodClose;
        if (pc == address(0) || pc.code.length == 0) return address(0);
        try IPeriodCloseCash(pc).cash() returns (address c) {
            if (c == address(0) || _assetTaken[c]) return address(0);
            return c;
        } catch {
            return address(0);
        }
    }

    function _inScope(bytes32 deskId, address adapter) private view returns (bool) {
        Desk storage d = _desks[deskId];
        if (!d.active || msg.sender != d.key) return false;
        for (uint256 i; i < d.adapters.length; ++i) {
            if (d.adapters[i] == adapter) return true;
        }
        return false;
    }

    function _addSleeve(address sleeve) private {
        if (sleeve == address(0) || sleeve.code.length == 0) revert BadSleeve(sleeve);
        if (_sleeves.length >= MAX_SLEEVES) revert TooManySleeves();
        uint8 band = ISleeve(sleeve).band();
        if (band > BAND_BASIS) revert BadSleeve(sleeve);
        (address[] memory assets, uint8[] memory kinds) = ISleeve(sleeve).assets();
        if (assets.length != kinds.length || assets.length > MAX_ASSETS_PER_SLEEVE) revert BadSleeve(sleeve);
        for (uint256 i; i < assets.length; ++i) {
            if (_assetTaken[assets[i]]) revert DuplicateAsset(assets[i]);
            if (kinds[i] > 2) revert BadSleeve(sleeve);
            _assetTaken[assets[i]] = true;
        }
        if (_isPositionSleeve(sleeve)) {
            if (IPositionSleeve(sleeve).account() != address(this)) revert BadSleeve(sleeve);
            _positionSleeves.push(sleeve);
        }
        _sleeves.push(sleeve);
        isSleeve[sleeve] = true;
        emit SleeveAdded(sleeve, band);
    }

    function _isPositionSleeve(address sleeve) private view returns (bool) {
        try IPositionSleeve(sleeve).isPositionSleeve() returns (bool yes) {
            return yes;
        } catch {
            return false;
        }
    }
}
