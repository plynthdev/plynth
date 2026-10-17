// Hand-written ABI subsets for the venue clients, the basis desk and the reconciler.
// test/venues.test.ts checks every selector against contracts/out.
import { parseAbi } from "viem";

export const inHouseVenueAbi = parseAbi([
  "struct Position { address underlying; int256 tokens; uint256 marginUsd; }",
  "function positionOf() view returns (Position[])",
  "function equityOf() view returns (uint256 usd, bool stale)",
  "function markets() view returns (address[])",
  "function marketOf(address underlying) view returns (address)",
]);

export const marketAbi = parseAbi([
  "struct Position { uint256 size; uint256 collateral; uint256 tokens; bool isLong; int256 fundingIndex; uint256 borrowIndex; int256 accruedFunding; uint256 accruedBorrow; uint64 openedAt; }",
  "function underlying() view returns (address)",
  "function fundingRate() view returns (uint256 ratePerSecond, bool longsPay)",
  "function position(address account) view returns (Position)",
  "function price() view returns (uint256 p, bool hold)",
]);

export const basisSleeveAbi = parseAbi([
  "struct Pair { uint32 venueIdx; address underlying; uint256 spotRaw; uint256 perpTokens; uint256 entryMultiplier; uint256 entryPriceUsd; uint256 collateral; uint64 openedAt; uint64 closedAt; int256 cumulativeFundingUsd; }",
  "function pairCount() view returns (uint256)",
  "function pair(uint256 id) view returns (Pair)",
  "function pairDelta(uint256 id) view returns (int256)",
  "function pairCarry(uint256 id) view returns (int256)",
  "function pairedRaw(address underlying) view returns (uint256)",
  "function openPairOf(uint256 venueIdx, address underlying) view returns (uint256)",
  "function venueNotional(uint256 venueIdx) view returns (uint256 notional, uint256 nav)",
  "function venues() view returns (address[])",
  "error SpotNotHeld(address underlying, uint256 free, uint256 needed)",
  "error FloatCapExceeded(address underlying, uint256 paired, uint256 cap)",
  "error VenueCapExceeded(uint256 venueIdx, uint256 notionalUsd, uint256 capUsd)",
  "error PairExists(uint256 pairId)",
  "error PairClosedAlready(uint256 pairId)",
  "error PositionNotFlat(address underlying)",
]);

export const venueValuerAbi = parseAbi([
  "struct Quote { uint256 priceUsdPerToken; uint256 multiplier; uint80 roundId; uint256 updatedAt; bool hold; }",
  "function quote(address token) view returns (Quote)",
]);
