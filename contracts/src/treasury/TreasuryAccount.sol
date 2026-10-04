// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {PolicyGuard} from "./PolicyGuard.sol";
import {IAdapter, ISleeve} from "./interfaces/ISleeve.sol";

/// The treasury's wallet. Desks are plain keys that call `execute`: the account checks the desk's scope,
/// snapshots its state, runs the adapter with `call` (exact approvals, reset afterwards), then asks the
/// PolicyGuard to check the resulting state against the board's policy and reverts everything on a breach.
/// This keeps "agent proposes, code disposes" without an ERC-4337 bundler or paymaster.
///
/// The board can always take assets out with `withdrawToBoard`; nothing (pause, drawdown, stale feeds,
/// revoked desks) gates it. Non-upgradeable.
contract TreasuryAccount is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint8 public constant BAND_CASH = 0;
    uint8 public constant BAND_EQUITY = 1;
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

    address public immutable board;
    TreasuryPolicy public immutable policy;
    PolicyGuard public immutable guard;
    address public immutable approvals;
    address public periodClose;

    mapping(bytes32 deskId => Desk) private _desks;
    mapping(address key => uint256) private _activeDesksOfKey;
    address[] private _sleeves; // every adapter ever registered; never removed so its holdings stay in NAV
    mapping(address sleeve => bool) public isSleeve;
    mapping(address asset => bool) private _assetTaken;

    event DeskRegistered(bytes32 indexed deskId, address indexed key, address[] adapters);
    event DeskRevoked(bytes32 indexed deskId);
    event SleeveAdded(address indexed sleeve, uint8 band);
    event PeriodCloseSet(address indexed periodClose);
    event GuardDecision(bytes32 indexed opHash, bytes32 indexed deskId, uint8 code);
    event Executed(bytes32 indexed opHash, bytes32 indexed deskId, address indexed adapter);
    event WithdrawnToBoard(address indexed token, uint256 amount);
    event CloseFeePaid(address indexed token, address indexed to, uint256 amount);

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

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    constructor(address board_, TreasuryPolicy policy_, PolicyGuard guard_, address approvals_) {
        if (
            board_ == address(0) || address(policy_) == address(0) || address(guard_) == address(0)
                || approvals_ == address(0)
        ) revert ZeroAddress();
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
        for (uint256 i; i < adapters.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (adapters[i] == adapters[j]) revert BadAdapters();
            }
            if (!isSleeve[adapters[i]]) _addSleeve(adapters[i]);
        }
        _desks[deskId] = Desk(key, true, adapters);
        ++_activeDesksOfKey[key];
        emit DeskRegistered(deskId, key, adapters);
    }

    function revokeDesk(bytes32 deskId) external onlyBoard {
        Desk storage d = _desks[deskId];
        if (!d.active) revert DeskNotActive();
        d.active = false;
        --_activeDesksOfKey[d.key];
        emit DeskRevoked(deskId);
    }

    /// The contract whose `periodStartNav()` drives the drawdown rule (PeriodClose). Zero disables rule 8.
    function setPeriodClose(address periodClose_) external onlyBoard {
        periodClose = periodClose_;
        emit PeriodCloseSet(periodClose_);
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

    /// NAV in USD (1e18) as the sum of every sleeve's `valueOf`; `hold` if any price is stale.
    function navUsd() external view returns (uint256 nav, bool hold) {
        for (uint256 i; i < _sleeves.length; ++i) {
            (uint256 v, bool h) = ISleeve(_sleeves[i]).valueOf(address(this));
            nav += v;
            hold = hold || h;
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
    }

    function sleeves() external view returns (address[] memory) {
        return _sleeves;
    }

    function desk(bytes32 deskId) external view returns (Desk memory) {
        return _desks[deskId];
    }

    function isDeskKey(address key) external view returns (bool) {
        return _activeDesksOfKey[key] > 0;
    }

    // ---------------------------------------------------------------- internal

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
        if (band > BAND_EQUITY) revert BadSleeve(sleeve);
        (address[] memory assets, uint8[] memory kinds) = ISleeve(sleeve).assets();
        if (assets.length != kinds.length || assets.length > MAX_ASSETS_PER_SLEEVE) revert BadSleeve(sleeve);
        for (uint256 i; i < assets.length; ++i) {
            if (_assetTaken[assets[i]]) revert DuplicateAsset(assets[i]);
            if (kinds[i] > 2) revert BadSleeve(sleeve);
            _assetTaken[assets[i]] = true;
        }
        _sleeves.push(sleeve);
        isSleeve[sleeve] = true;
        emit SleeveAdded(sleeve, band);
    }
}
