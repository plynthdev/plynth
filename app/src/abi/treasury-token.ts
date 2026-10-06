// Hand-written ABI subsets for the token contracts (PlinthStaking, FeeRouter, ExceptionInsurancePool).
// app/src/treasury/token/token.test.ts checks every selector against the forge artifacts.
import { parseAbi } from "viem";

export const stakingAbi = parseAbi([
  "struct Tier { uint8 maxDesks; bool weeklyClose; bool privateSleeve; uint8 templatePriority; }",
  "function stakedOf(address staker) view returns (uint256)",
  "function tierIndexOf(address staker) view returns (uint256)",
  "function tierOf(address staker) view returns (Tier)",
  "function stakerOf(address staker) view returns (uint256 active, uint256 pending, uint256 unbonding, uint64 releaseAt)",
  "function earned(address staker) view returns (uint256[2])",
  "function activeSupply() view returns (uint256)",
  "function pendingSupply() view returns (uint256)",
  "function lastBucket() view returns (uint64)",
]);

export const feeRouterAbi = parseAbi([
  "function lastPush() view returns (uint64)",
  "function buyCarry() view returns (uint256)",
  "function perPushCap() view returns (uint256)",
  "function maxSlippageBps() view returns (uint16)",
  "function authorBps() view returns (uint16)",
  "function spotSqrtPriceX96() view returns (uint160)",
  "function push(uint256 keeperMinOut)",
  "function observe()",
  "function keeper() view returns (address)",
  "function obsAt() view returns (uint64)",
  "function authorReserved() view returns (uint256)",
  "function quoteMinOut(uint256 usdgIn) view returns (uint256)",
  "function usdg() view returns (address)",
]);

export const insuranceAbi = parseAbi([
  "struct Claim { address treasury; address board; uint256 amount; uint256 paid; bytes32 evidenceHash; uint64 filedAt; bool committeeApproved; bool policyBugAttested; uint8 status; }",
  "function freeAssets() view returns (uint256)",
  "function queuedOwed() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function queueLength() view returns (uint256)",
  "function claimCount() view returns (uint256)",
  "function claim(uint256 id) view returns (Claim)",
]);

export const CLAIM_STATUS = ["none", "filed", "queued", "paid", "rejected"] as const;
