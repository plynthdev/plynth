// The ShieldedPool interface (contracts/src/consumer/ShieldedPool.sol).
import { parseAbi, parseAbiItem } from "viem";

export const shieldedPoolAbi = parseAbi([
  "struct PublicTransfer { bytes32 root; bytes32[2] nullifiers; bytes32[2] outCommitments; address asset; }",
  "struct PublicWithdraw { bytes32 root; bytes32 nullifier; bytes32 changeCommitment; address asset; uint256 amount; address recipient; uint256 relayerFee; bytes encryptedChange; }",
  "struct Pending { bytes32 commitment; address asset; uint64 createdAt; uint8 state; address origin; uint128 raw; }",
  "function deposit(address asset, uint256 raw, bytes32 ownerPk, bytes32 blinding, bytes encryptedNote) returns (uint256 pendingId)",
  "function refundPending(uint256 pendingId)",
  "function insertPending(uint256 maxCount) returns (uint256 inserted)",
  "function transfer(bytes proof, PublicTransfer pub, bytes[2] encryptedNotes)",
  "function withdraw(bytes proof, PublicWithdraw pub)",
  "function isKnownRoot(bytes32 root) view returns (bool)",
  "function currentRoot() view returns (bytes32)",
  "function nextLeaf() view returns (uint256)",
  "function nullifierSpent(bytes32 nullifier) view returns (bool)",
  "function commitmentOf(address asset, uint256 raw, bytes32 ownerPk, bytes32 blinding) pure returns (bytes32)",
  "function pending(uint256 pendingId) view returns (Pending)",
  "function pendingCount() view returns (uint256)",
  "function nextPending() view returns (uint256)",
  "function readyCount(uint256 limit) view returns (uint256)",
  "function cap(address asset) view returns (uint256)",
  "function shielded(address asset) view returns (uint256)",
  "function MIN_PENDING_DELAY() view returns (uint64)",
  "event DepositQueued(uint256 indexed pendingId, address indexed asset, address indexed origin, uint256 raw, bytes32 commitment)",
  "event PendingRefunded(uint256 indexed pendingId, address indexed origin, uint256 raw)",
  "event PendingInserted(uint256 indexed pendingId, uint256 indexed leafIndex)",
  "event LeafInserted(uint256 indexed leafIndex, bytes32 commitment)",
  "event RootUpdated(bytes32 root, uint256 nextLeaf)",
  "event NoteEncrypted(bytes32 indexed commitment, bytes encryptedNote)",
  "event NullifierSpent(bytes32 indexed nullifier)",
  "event Withdrawn(address indexed asset, address indexed recipient, uint256 amount, uint256 relayerFee, address relayer)",
  "error ZeroAddress()",
  "error Paused()",
  "error BadAmount()",
  "error NoteTooLarge()",
  "error CapExceeded(uint256 shielded, uint256 raw, uint256 cap)",
  "error NotAFieldElement()",
  "error TransferAmountMismatch(uint256 received, uint256 expected)",
  "error NotPending(uint256 pendingId)",
  "error NotOrigin(uint256 pendingId)",
  "error NothingToInsert()",
  "error TreeFull()",
  "error UnknownRoot(bytes32 root)",
  "error NullifierAlreadySpent(bytes32 nullifier)",
  "error InvalidProof()",
]);

export const leafInsertedEvent = parseAbiItem("event LeafInserted(uint256 indexed leafIndex, bytes32 commitment)");
export const noteEncryptedEvent = parseAbiItem("event NoteEncrypted(bytes32 indexed commitment, bytes encryptedNote)");
export const nullifierSpentEvent = parseAbiItem("event NullifierSpent(bytes32 indexed nullifier)");
export const depositQueuedEvent = parseAbiItem(
  "event DepositQueued(uint256 indexed pendingId, address indexed asset, address indexed origin, uint256 raw, bytes32 commitment)",
);
