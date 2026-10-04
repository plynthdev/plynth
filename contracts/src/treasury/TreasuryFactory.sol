// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {TreasuryAccount} from "./TreasuryAccount.sol";
import {PolicyGuard} from "./PolicyGuard.sol";
import {PeriodClose} from "./PeriodClose.sol";
import {BoardApprovals} from "./BoardApprovals.sol";
import {ITierSource} from "../token/ITierSource.sol";

/// One call gives a board a working treasury: EIP-1167 clones of TreasuryPolicy, TreasuryAccount, PeriodClose
/// and BoardApprovals, wired to each other and to the shared PolicyGuard.
///
/// `compiledPolicy` is `abi.encode(TreasuryPolicy.Policy)` exactly as the policy compiler emits it (21 words);
/// it is validated by TreasuryPolicy itself and becomes version 1, active at once. The board (a Safe in
/// production) owns every clone; the factory keeps no rights over anything it created. Anyone may call
/// `deploy` (it only creates contracts the named board controls), but the dashboard hands the board Safe an
/// unsigned transaction so in practice the Safe calls it.
///
/// Clone addresses are deterministic per (board, nonce) so a front end can show them before the Safe signs
/// (`predict`). If someone else deploys for the same board first, the board's transaction still succeeds at the
/// next nonce; the event is the source of truth. No token, staking or fee router wiring here (not in v1):
/// `feeRecipient` and `tiers` are factory-wide settings handed to every PeriodClose, and either may be zero.
contract TreasuryFactory {
    /// abi.encode(TreasuryPolicy.Policy): 3 bands x 2 words + 15 single-word fields.
    uint256 public constant POLICY_BYTES = 21 * 32;

    address public immutable policyImpl;
    address public immutable accountImpl;
    address public immutable closeImpl;
    address public immutable approvalsImpl;
    PolicyGuard public immutable guard;
    IERC20Metadata public immutable cash;
    address public immutable feeRecipient; // zero = no platform fee
    ITierSource public immutable tiers; // zero = no tier gating

    mapping(address board => uint256) public nonceOf;
    mapping(address account => bool) public isTreasury;
    address[] private _accounts;

    event TreasuryCreated(
        address indexed board,
        address indexed account,
        address indexed creator,
        address policy,
        address close,
        address approvals,
        bytes32 policyHash
    );

    error ZeroAddress();
    error NoCode(address impl);
    error BadPolicyEncoding(uint256 length);

    constructor(
        address policyImpl_,
        address accountImpl_,
        address closeImpl_,
        address approvalsImpl_,
        PolicyGuard guard_,
        IERC20Metadata cash_,
        address feeRecipient_,
        ITierSource tiers_
    ) {
        if (address(guard_) == address(0) || address(cash_) == address(0)) revert ZeroAddress();
        _requireCode(policyImpl_);
        _requireCode(accountImpl_);
        _requireCode(closeImpl_);
        _requireCode(approvalsImpl_);
        policyImpl = policyImpl_;
        accountImpl = accountImpl_;
        closeImpl = closeImpl_;
        approvalsImpl = approvalsImpl_;
        guard = guard_;
        cash = cash_;
        feeRecipient = feeRecipient_;
        tiers = tiers_;
    }

    /// Creates and wires a treasury for `boardSafe`. Reverts with TreasuryPolicy's own error if the policy is
    /// invalid, so nothing half-built is ever left behind.
    function deploy(bytes calldata compiledPolicy, address boardSafe)
        external
        returns (address account, address policy, address close)
    {
        if (boardSafe == address(0)) revert ZeroAddress();
        if (compiledPolicy.length != POLICY_BYTES) revert BadPolicyEncoding(compiledPolicy.length);
        TreasuryPolicy.Policy memory p = abi.decode(compiledPolicy, (TreasuryPolicy.Policy));

        uint256 nonce = nonceOf[boardSafe]++;
        policy = Clones.cloneDeterministic(policyImpl, _salt(boardSafe, nonce, 0));
        account = Clones.cloneDeterministic(accountImpl, _salt(boardSafe, nonce, 1));
        close = Clones.cloneDeterministic(closeImpl, _salt(boardSafe, nonce, 2));
        address approvals = Clones.cloneDeterministic(approvalsImpl, _salt(boardSafe, nonce, 3));

        TreasuryPolicy(policy).initialize(boardSafe, p);
        BoardApprovals(approvals).initialize(boardSafe, address(guard), account);
        TreasuryAccount(payable(account)).initialize(boardSafe, TreasuryPolicy(policy), guard, approvals, close);
        PeriodClose(close).initialize(TreasuryAccount(payable(account)), cash, feeRecipient, tiers);

        isTreasury[account] = true;
        _accounts.push(account);
        emit TreasuryCreated(boardSafe, account, msg.sender, policy, close, approvals, keccak256(compiledPolicy));
    }

    /// Addresses the next `deploy` for `boardSafe` will create (if nobody deploys for that board first).
    function predict(address boardSafe)
        external
        view
        returns (address account, address policy, address close, address approvals)
    {
        uint256 nonce = nonceOf[boardSafe];
        policy = Clones.predictDeterministicAddress(policyImpl, _salt(boardSafe, nonce, 0));
        account = Clones.predictDeterministicAddress(accountImpl, _salt(boardSafe, nonce, 1));
        close = Clones.predictDeterministicAddress(closeImpl, _salt(boardSafe, nonce, 2));
        approvals = Clones.predictDeterministicAddress(approvalsImpl, _salt(boardSafe, nonce, 3));
    }

    function treasuryCount() external view returns (uint256) {
        return _accounts.length;
    }

    function treasuryAt(uint256 index) external view returns (address) {
        return _accounts[index];
    }

    function _salt(address board, uint256 nonce, uint8 kind) private pure returns (bytes32) {
        return keccak256(abi.encode(board, nonce, kind));
    }

    function _requireCode(address impl) private view {
        if (impl.code.length == 0) revert NoCode(impl);
    }
}
