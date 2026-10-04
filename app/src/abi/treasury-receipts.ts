import { parseAbi } from "viem";

/** Receipts.sol (todo 30), the subset the service and the API use. Checked against forge out in tests. */
export const receiptsAbi = parseAbi([
  "struct Receipt { bytes32 root; uint32 leafCount; uint64 postedAt; }",
  "function post(address account, uint64 hour, bytes32 root, uint32 leafCount)",
  "function receipt(address account, uint64 hour) view returns (Receipt)",
  "function verify(address account, uint64 hour, bytes32 leaf, bytes32[] proof) view returns (bool)",
  "function leafOf(bytes32 rowHash) pure returns (bytes32)",
  "function controllerOf(address account) view returns (address)",
  "function lastHour(address account) view returns (uint64)",
  "event ReceiptPosted(address indexed account, uint64 indexed hour, bytes32 root, uint32 leafCount, address controller)",
  "error NotController(address controller)",
  "error HourNotOver(uint64 hour)",
  "error AlreadyPosted(uint64 hour)",
  "error BadRoot()",
]);
