// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITierSource, Tier} from "../interfaces/ITierSource.sol";

/// The templates marketplace: authors publish a compiled policy template, a review committee (a Safe in
/// production) lists or delists it, and TreasuryFactory only builds treasuries from listed templates.
///
/// A template is the hash of a compiled policy with its `controller` zeroed
/// (`TreasuryFactory.templateHash`), plus a metadata URI pointing at the human-readable template. Anyone may
/// submit; the same hash may be submitted more than once (the committee lists the genuine author's entry, so a
/// copy submitted first cannot block or steal it). The author earns a share of every platform fee paid by a
/// treasury created from their template (FeeRouter); `transferAuthor` moves that income to a new address.
///
/// `priorityOf` is the author's staking tier `templatePriority` (0 without a tier source): the API lists
/// templates highest priority first. Delisting stops new treasuries from the template; treasuries already
/// created keep their `templateId` and keep paying the author.
contract TemplateRegistry {
    uint256 public constant MAX_URI_BYTES = 256;

    struct Template {
        address author;
        bytes32 policyHash;
        string metadataURI;
        bool listed;
        uint64 submittedAt;
    }

    ITierSource public immutable tiers; // zero = every template priority 0
    address public committee;
    Template[] private _templates; // id = index + 1 (0 = no template)

    event TemplateSubmitted(uint256 indexed id, address indexed author, bytes32 indexed policyHash, string metadataURI);
    event TemplateListed(uint256 indexed id);
    event TemplateDelisted(uint256 indexed id);
    event AuthorTransferred(uint256 indexed id, address indexed from, address indexed to);
    event CommitteeSet(address committee);

    error ZeroAddress();
    error NotCommittee();
    error NotAuthor();
    error UnknownTemplate(uint256 id);
    error BadHash();
    error BadUri();
    error AlreadyListed(uint256 id);
    error NotListed(uint256 id);

    modifier onlyCommittee() {
        if (msg.sender != committee) revert NotCommittee();
        _;
    }

    constructor(address committee_, ITierSource tiers_) {
        if (committee_ == address(0)) revert ZeroAddress();
        committee = committee_;
        tiers = tiers_;
        emit CommitteeSet(committee_);
    }

    // ---------------------------------------------------------------- authors

    function submit(bytes32 policyHash, string calldata metadataURI) external returns (uint256 id) {
        if (policyHash == bytes32(0)) revert BadHash();
        uint256 n = bytes(metadataURI).length;
        if (n == 0 || n > MAX_URI_BYTES) revert BadUri();
        _templates.push(Template(msg.sender, policyHash, metadataURI, false, uint64(block.timestamp)));
        id = _templates.length;
        emit TemplateSubmitted(id, msg.sender, policyHash, metadataURI);
    }

    function transferAuthor(uint256 id, address to) external {
        Template storage t = _get(id);
        if (msg.sender != t.author) revert NotAuthor();
        if (to == address(0)) revert ZeroAddress();
        t.author = to;
        emit AuthorTransferred(id, msg.sender, to);
    }

    // ---------------------------------------------------------------- committee

    function list(uint256 id) external onlyCommittee {
        Template storage t = _get(id);
        if (t.listed) revert AlreadyListed(id);
        t.listed = true;
        emit TemplateListed(id);
    }

    function delist(uint256 id) external onlyCommittee {
        Template storage t = _get(id);
        if (!t.listed) revert NotListed(id);
        t.listed = false;
        emit TemplateDelisted(id);
    }

    function setCommittee(address committee_) external onlyCommittee {
        if (committee_ == address(0)) revert ZeroAddress();
        committee = committee_;
        emit CommitteeSet(committee_);
    }

    // ---------------------------------------------------------------- views

    function count() external view returns (uint256) {
        return _templates.length;
    }

    function get(uint256 id) external view returns (Template memory) {
        return _get(id);
    }

    function isListed(uint256 id) external view returns (bool) {
        return id != 0 && id <= _templates.length && _templates[id - 1].listed;
    }

    /// Zero for an unknown id (the FeeRouter treats that as "no author").
    function authorOf(uint256 id) external view returns (address) {
        if (id == 0 || id > _templates.length) return address(0);
        return _templates[id - 1].author;
    }

    function policyHashOf(uint256 id) external view returns (bytes32) {
        return _get(id).policyHash;
    }

    /// The author's staking-tier template priority (higher lists first). A failing tier source counts as 0.
    function priorityOf(uint256 id) public view returns (uint8) {
        address author = _get(id).author;
        if (address(tiers) == address(0)) return 0;
        try tiers.tierOf(author) returns (Tier memory t) {
            return t.templatePriority;
        } catch {
            return 0;
        }
    }

    /// Every listed id, in id order (the API sorts by priority).
    function listedIds() external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i; i < _templates.length; ++i) {
            if (_templates[i].listed) ++n;
        }
        ids = new uint256[](n);
        uint256 k;
        for (uint256 i; i < _templates.length; ++i) {
            if (_templates[i].listed) ids[k++] = i + 1;
        }
    }

    function _get(uint256 id) private view returns (Template storage) {
        if (id == 0 || id > _templates.length) revert UnknownTemplate(id);
        return _templates[id - 1];
    }
}
