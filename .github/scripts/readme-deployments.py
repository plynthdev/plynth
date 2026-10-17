#!/usr/bin/env python3
"""Keep the README's deployment section equal to app/deployments (the files the services and the web app read).

    python3 .github/scripts/readme-deployments.py           # rewrite the block between the markers in README.md
    python3 .github/scripts/readme-deployments.py --check   # CI: exit 1 if README.md differs from the files

The block sits between `<!-- deployments:start -->` and `<!-- deployments:end -->`. After a redeploy (for example
a v2 mainnet deploy that rewrites app/deployments/4663.json), run it without --check and commit both files.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "app" / "deployments"
README = ROOT / "README.md"
START, END = "<!-- deployments:start -->", "<!-- deployments:end -->"

# Deployment-file key -> contract name, in the order the README lists them. Keys absent from a file are skipped.
CONTRACTS = [
    ("stockTokenRegistry", "StockTokenRegistry"),
    ("valuer", "Valuer"),
    ("stockRouter", "StockRouter"),
    ("jitterBeacon", "JitterBeacon"),
    ("eligibilityRegistry", "EligibilityRegistry"),
    ("savingsVault", "SavingsVault"),
    ("crowdBuy", "CrowdBuy"),
    ("stealthClaims", "StealthClaims"),
    ("shieldedPool", "ShieldedPool"),
    ("shieldedTrade", "ShieldedTrade"),
    ("thresholdVerifier", "ThresholdVerifier"),
    ("parkAdapter", "ERC4626Park"),
    ("treasuryFactory", "TreasuryFactory"),
    ("policyGuard", "PolicyGuard"),
    ("templateRegistry", "TemplateRegistry"),
    ("receipts", "Receipts"),
    ("cashSleeve", "CashSleeve"),
    ("equitySleeve", "EquitySleeve"),
    ("perpPool", "PerpPool"),
    ("plth", "PLTH"),
    ("staking", "PlinthStaking"),
    ("feeRouter", "FeeRouter"),
    ("insurancePool", "ExceptionInsurancePool"),
    ("usdg", "USDG"),
]
ROLES = [
    ("owner", "Owner (every admin role; two-step contracts after `acceptOwnership`)"),
    ("keeper", "Keeper bot"),
    ("attester", "Eligibility attester"),
    ("relayer", "Relayer (no on-chain role)"),
    ("controller", "Treasury controller (first treasury's policy)"),
    ("cashDesk", "Cash desk key"),
    ("equityDesk", "Equity desk key"),
    ("deployer", "Deployer (keeps no role after the hand-over)"),
]


def load(chain):
    path = DEPLOY / f"{chain}.json"
    if not path.exists():
        return None
    d = json.loads(path.read_text())
    extra = DEPLOY / f"{chain}-treasury.json"
    if extra.exists():
        for k, v in json.loads(extra.read_text()).items():
            d.setdefault(k, v)
    return d


def table(d, chain):
    rows = ["| Contract | Address |", "| --- | --- |"]
    for key, name in CONTRACTS:
        if d.get(key):
            label = f"`{name}`" if key != "usdg" else ("USDG (external)" if chain == 4663 else "`MockUSDG` (mUSDG, 6 dp)")
            rows.append(f"| {label} | `{d[key]}` |")
    for sym, addr in sorted((d.get("perpMarkets") or {}).items()):
        rows.append(f"| `PerpMarket` {sym} | `{addr}` |")
    return rows


def roles(d):
    rows = ["| Role | Address |", "| --- | --- |"]
    for key, label in ROLES:
        if d.get(key):
            rows.append(f"| {label} | `{d[key]}` |")
    return rows


def render():
    main, test = load(4663), load(46630)
    out = [START, ""]
    if main:
        token = "with" if main.get("deployToken") else "without"
        out += [
            f"**Mainnet (`4663`): closed beta, deployed at block {main['deployBlock']:,}** {token} the token contracts "
            f"(PLTH, staking, FeeRouter, insurance pool), against the real USDG, Stock Tokens, Chainlink feeds and "
            f"Uniswap v4 pools. Every address is in [`app/deployments/4663.json`](app/deployments/4663.json) (and "
            f"`4663-treasury.json`); explorer: <https://robinhoodchain.blockscout.com>. Roles, timelocks and accepted "
            f"risks are in [SECURITY.md](SECURITY.md); `bun run verify:deployment` (in `app/`) checks them on chain. "
            f"This is the version the external AI audit reviewed (security/AUDITS.md); a v2 with its fixes is in "
            f"progress and not deployed. When it is, the deploy rewrites `app/deployments/4663.json` and this section "
            f"is regenerated from it (`python3 .github/scripts/readme-deployments.py`).",
            "",
        ]
        out += table(main, 4663) + [""] + roles(main) + [""]
    else:
        out += ["Not deployed to mainnet.", ""]
    if test:
        out += [
            "**Testnet (`46630`)** with mock assets (mock USDG, mock Stock Tokens priced from the real mainnet feeds, "
            "a mock ERC-4626 USDG vault) and the chain's real Uniswap v4 PoolManager, Permit2 and ERC-5564/6538 "
            "contracts. Every address is in [`app/deployments/46630.json`](app/deployments/46630.json) (and "
            "`46630-treasury.json`); explorer: <https://explorer.testnet.chain.robinhood.com>.",
            "",
        ]
        out += table(test, 46630) + [""]
    out.append(END)
    return "\n".join(out)


def main():
    text = README.read_text()
    if START not in text or END not in text:
        sys.exit(f"README.md has no {START} ... {END} block")
    head, rest = text.split(START, 1)
    _, tail = rest.split(END, 1)
    new = head + render() + tail
    if "--check" in sys.argv:
        if new != text:
            sys.exit("README.md deployment section differs from app/deployments: run .github/scripts/readme-deployments.py")
        print("README deployment section matches app/deployments")
        return
    README.write_text(new)
    print("README deployment section rewritten from app/deployments")


if __name__ == "__main__":
    main()
