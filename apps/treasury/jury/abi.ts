import { parseAbi } from "viem";

export const approvalsAbi = parseAbi([
  "struct Ticket { bytes32 opHash; address requester; uint64 requestedAt; uint64 decidedAt; uint8 status; }",
  "function request(bytes32 opHash) returns (bytes32 ticket)",
  "function request(bytes32 opHash, bytes juryVerdictCid) returns (bytes32 ticket)",
  "function juryVerdictCidOf(bytes32 ticket) view returns (bytes)",
  "function ticketOf(bytes32 ticket) view returns (Ticket)",
  "function approve(bytes32 ticket)",
  "function reject(bytes32 ticket)",
  "event Requested(bytes32 indexed ticket, bytes32 indexed opHash, address indexed requester)",
  "event JuryVerdictAttached(bytes32 indexed ticket, bytes juryVerdictCid)",
  "error NotBoard()",
  "error NotDesk()",
  "error NotBound()",
  "error CidTooLong()",
  "error BadStatus(uint8 status)",
  "error Expired()",
]);

export const juryAccountAbi = parseAbi([
  "function approvals() view returns (address)",
  "function periodClose() view returns (address)",
  "function opHashOf(bytes32 deskId, address adapter, bytes data) view returns (bytes32)",
]);
