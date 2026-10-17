// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {TreasuryAccount} from "./TreasuryAccount.sol";
import {PolicyGuard} from "./PolicyGuard.sol";
import {PeriodClose} from "./PeriodClose.sol";
import {BoardApprovals} from "./BoardApprovals.sol";
import {ITierSource} from "../interfaces/ITierSource.sol";
import {TemplateRegistry} from "./TemplateRegistry.sol";
import {ChangeDelay} from "../libs/ChangeDelay.sol";

/// One call gives a board a working treasury: EIP-1167 clones of TreasuryPolicy, TreasuryAccount, PeriodClose
/// and BoardApprovals, wired to each other and to the shared PolicyGuard.
///
/// `compiledPolicy` is `abi.encode(TreasuryPolicy.Policy)` exactly as the policy compiler emits it (21 words);
/// it is validated by TreasuryPolicy itself and becomes version 1, active at once. The board (a Safe in
/// production) owns every clone; the factory keeps no rights over anything it created beyond its adapter allow-list
/// (below), which only decides what code a treasury may register later. Anyone may call
/// `deploy` (it only creates contracts the named board controls), but the dashboard hands the board Safe an
/// unsigned transaction so in practice the Safe calls it.
///
/// Clone addresses are deterministic per (creator, board, nonce), the creator being `msg.sender`, so a front end
/// can show them before the Safe signs (`predict(creator, board)`). They are bound to the caller: someone else
/// deploying for the same board (with their own policy and controller) lands on their own addresses and cannot
/// take the ones the board was shown. The event is the source of truth. `feeRecipient` and `tiers` are factory-wide settings handed to
/// every PeriodClose (and `tiers` to every TreasuryAccount, for its desk limit), and either may be zero.
///
/// Templates marketplace (todo 30): `deployFromTemplate` builds a treasury from a template the
/// TemplateRegistry lists. The compiled policy must equal the template with only `controller` filled in
/// (`templateHash`), and the account records `templateOf` so the FeeRouter can pay the template's author a
/// share of the treasury's platform fee (`closeAuthor`).
///
/// Adapter allow-list: every treasury this factory makes refuses a new sleeve, vault-holding sleeve or perp venue
/// whose runtime codehash is not allowed here (`TreasuryAccount.registerDesk`, `PerpSleeve` / `BasisSleeve`
/// `addVenue`), so a board can only plug in code that is on the list. The codehash covers code and immutables, not
/// storage: a second deployment of a listed contract with the same immutables but different storage-held
/// configuration (e.g. a CashSleeve with another vault list) has the same codehash and is accepted; what such an
/// adapter can receive is still bounded by the policy's timelocked `instrumentAllowRoot` / `venueAllowRoot`
/// (SECURITY.md, accepted risks). An adapter bound to one account (PerpSleeve, BasisSleeve, PrivateSleeve, a
/// venue) has its own codehash and is approved per instance. OWNER keeps the list. Until the first
/// `acceptOwnership` (`changeNonce == 0`: the deployer's first-time setup) an addition applies at once; after it
/// every addition waits CHANGE_DELAY (48 h, ChangeDelay) in public, and a removal (risk-reducing) applies at once.
/// Every codehash ever allowed is kept in an on-chain list, so `allowedHashes()` enumerates exactly what is allowed
/// now (the post-deploy check compares it with what was shipped, including anything the deployer added during
/// setup). A removal does not unregister an adapter a treasury already holds (sleeves are never removed, so NAV
/// keeps them).
contract TreasuryFactory is ChangeDelay {
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
    TemplateRegistry public immutable templates; // zero = no templates marketplace

    mapping(address creator => mapping(address board => uint256)) public nonceOf;
    mapping(address account => bool) public isTreasury;
    mapping(address account => uint256) public templateOf; // 0 = not built from a template
    mapping(address close => address) public accountOfClose;
    address[] private _accounts;
    address public owner;
    address public pendingOwner;
    /// Runtime codehashes of reviewed adapters (sleeves, venues) a factory treasury may register.
    mapping(bytes32 codehash => bool) public adapterAllowed;
    bytes32[] private _everAllowed; // every codehash ever allowed, in order (enumerates the mapping)
    mapping(bytes32 codehash => bool) private _listed;

    event AdapterAllowed(bytes32 indexed codehash, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    error NotOwner();
    error NotPendingOwner();

    event TreasuryCreated(
        address indexed board,
        address indexed account,
        address indexed creator,
        address policy,
        address close,
        address approvals,
        bytes32 policyHash
    );
    event TreasuryFromTemplate(address indexed account, uint256 indexed templateId, bytes32 templateHash);

    error ZeroAddress();
    error NoCode(address impl);
    error BadPolicyEncoding(uint256 length);
    error NoTemplates();
    error TemplateNotListed(uint256 templateId);
    error TemplateMismatch(bytes32 want, bytes32 got);

    constructor(
        address policyImpl_,
        address accountImpl_,
        address closeImpl_,
        address approvalsImpl_,
        PolicyGuard guard_,
        IERC20Metadata cash_,
        address feeRecipient_,
        ITierSource tiers_,
        TemplateRegistry templates_
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
        templates = templates_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Adds (delayed after setup) or removes (at once) a reviewed adapter's runtime codehash.
    function setAdapterAllowed(bytes32 codehash, bool allowed) external onlyOwner {
        if (allowed && changeNonce != 0 && !_delayed()) return;
        adapterAllowed[codehash] = allowed;
        if (allowed && !_listed[codehash]) {
            _listed[codehash] = true;
            _everAllowed.push(codehash);
        }
        emit AdapterAllowed(codehash, allowed);
    }

    /// Every codehash allowed now.
    function allowedHashes() external view returns (bytes32[] memory out) {
        uint256 n;
        for (uint256 i; i < _everAllowed.length; ++i) {
            if (adapterAllowed[_everAllowed[i]]) ++n;
        }
        out = new bytes32[](n);
        n = 0;
        for (uint256 i; i < _everAllowed.length; ++i) {
            if (adapterAllowed[_everAllowed[i]]) out[n++] = _everAllowed[i];
        }
    }

    /// The runtime codehash the allow-list keys `adapter` by.
    function codehashOf(address adapter) external view returns (bytes32) {
        return adapter.codehash;
    }

    function isAdapterAllowed(address adapter) external view returns (bool) {
        return adapter.code.length != 0 && adapterAllowed[adapter.codehash];
    }

    function cancelChange(bytes32 id) external onlyOwner {
        _cancelChange(id);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
        _bumpChangeNonce(); // a new owner starts with no queued changes, and every later addition is delayed
    }

    /// Creates and wires a treasury for `boardSafe`. Reverts with TreasuryPolicy's own error if the policy is
    /// invalid, so nothing half-built is ever left behind.
    function deploy(bytes calldata compiledPolicy, address boardSafe)
        external
        returns (address account, address policy, address close)
    {
        (account, policy, close) = _deploy(_decode(compiledPolicy), compiledPolicy, boardSafe);
    }

    /// Same as `deploy`, from a listed marketplace template: `compiledPolicy` must be the template with only the
    /// controller filled in. Records `templateOf[account]` (the author's fee share follows from it).
    function deployFromTemplate(bytes calldata compiledPolicy, address boardSafe, uint256 templateId)
        external
        returns (address account, address policy, address close)
    {
        if (address(templates) == address(0)) revert NoTemplates();
        if (!templates.isListed(templateId)) revert TemplateNotListed(templateId);
        TreasuryPolicy.Policy memory p = _decode(compiledPolicy);
        bytes32 want = templates.policyHashOf(templateId);
        bytes32 got = templateHash(p);
        if (got != want) revert TemplateMismatch(want, got);
        (account, policy, close) = _deploy(p, compiledPolicy, boardSafe);
        templateOf[account] = templateId;
        emit TreasuryFromTemplate(account, templateId, got);
    }

    /// The marketplace hash of a policy: keccak256(abi.encode(policy)) with `controller` set to zero, so one
    /// template serves every treasury whatever controller key it uses.
    function templateHash(TreasuryPolicy.Policy memory p) public pure returns (bytes32) {
        address c = p.controller; // `p` may be the caller's struct (memory is by reference): restore it
        p.controller = address(0);
        bytes32 h = keccak256(abi.encode(p));
        p.controller = c;
        return h;
    }

    /// For the FeeRouter: the account a PeriodClose belongs to (zero if not made here) and the author of the
    /// template it was built from (zero if none).
    function closeAuthor(address close) external view returns (address account, address author) {
        account = accountOfClose[close];
        uint256 id = templateOf[account];
        if (id != 0) author = templates.authorOf(id);
    }

    function _decode(bytes calldata compiledPolicy) private pure returns (TreasuryPolicy.Policy memory) {
        if (compiledPolicy.length != POLICY_BYTES) revert BadPolicyEncoding(compiledPolicy.length);
        return abi.decode(compiledPolicy, (TreasuryPolicy.Policy));
    }

    function _deploy(TreasuryPolicy.Policy memory p, bytes calldata compiledPolicy, address boardSafe)
        private
        returns (address account, address policy, address close)
    {
        if (boardSafe == address(0)) revert ZeroAddress();
        uint256 nonce = nonceOf[msg.sender][boardSafe]++;
        policy = Clones.cloneDeterministic(policyImpl, _salt(msg.sender, boardSafe, nonce, 0));
        account = Clones.cloneDeterministic(accountImpl, _salt(msg.sender, boardSafe, nonce, 1));
        close = Clones.cloneDeterministic(closeImpl, _salt(msg.sender, boardSafe, nonce, 2));
        address approvals = Clones.cloneDeterministic(approvalsImpl, _salt(msg.sender, boardSafe, nonce, 3));

        TreasuryPolicy(policy).initialize(boardSafe, p);
        BoardApprovals(approvals).initialize(boardSafe, address(guard), account);
        TreasuryAccount(payable(account)).initialize(boardSafe, TreasuryPolicy(policy), guard, approvals, close, tiers);
        PeriodClose(close).initialize(TreasuryAccount(payable(account)), cash, feeRecipient, tiers);

        isTreasury[account] = true;
        accountOfClose[close] = account;
        _accounts.push(account);
        emit TreasuryCreated(boardSafe, account, msg.sender, policy, close, approvals, keccak256(compiledPolicy));
    }

    /// Addresses the next `deploy` (or `deployFromTemplate`) for `boardSafe` sent by `creator` will create.
    /// Only `creator` can move its nonce, so nobody else can take them.
    function predict(address creator, address boardSafe)
        external
        view
        returns (address account, address policy, address close, address approvals)
    {
        uint256 nonce = nonceOf[creator][boardSafe];
        policy = Clones.predictDeterministicAddress(policyImpl, _salt(creator, boardSafe, nonce, 0));
        account = Clones.predictDeterministicAddress(accountImpl, _salt(creator, boardSafe, nonce, 1));
        close = Clones.predictDeterministicAddress(closeImpl, _salt(creator, boardSafe, nonce, 2));
        approvals = Clones.predictDeterministicAddress(approvalsImpl, _salt(creator, boardSafe, nonce, 3));
    }

    function treasuryCount() external view returns (uint256) {
        return _accounts.length;
    }

    function treasuryAt(uint256 index) external view returns (address) {
        return _accounts[index];
    }

    function _salt(address creator, address board, uint256 nonce, uint8 kind) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, board, nonce, kind));
    }

    function _requireCode(address impl) private view {
        if (impl.code.length == 0) revert NoCode(impl);
    }
}
