#!/usr/bin/env python3
"""Fail on any Slither Medium or High finding that has not been triaged.

    python3 script/slither-gate.py <slither.json> [slither.triage.json]

Each triage entry accepts one detector in one function: {"check", "where": "Contract.function", "reason"}.
Keys use the contract and function name, not line numbers, so unrelated edits do not re-open a finding, while any
new function (or a finding in a function nobody has looked at) fails the gate until someone reviews it and either
fixes the code or adds an entry with a reason. Stale entries (no longer reported) are listed so the file stays honest.
"""
import json
import sys

GATED = {"High", "Medium"}


def where(result):
    """Contract.function of a finding's first element (functions, nodes and local variables all resolve)."""
    for e in result.get("elements", []):
        cur = e
        while cur is not None:
            if cur.get("type") == "function":
                parent = cur.get("type_specific_fields", {}).get("parent", {})
                return f"{parent.get('name', '?')}.{cur['name']}"
            cur = cur.get("type_specific_fields", {}).get("parent")
    e = result["elements"][0] if result.get("elements") else {}
    return e.get("name", "?")


def main():
    report = json.load(open(sys.argv[1]))
    if not report.get("success"):
        sys.exit(f"slither failed: {report.get('error')}")
    triage_path = sys.argv[2] if len(sys.argv) > 2 else "slither.triage.json"
    triage = json.load(open(triage_path))
    accepted = {(t["check"], t["where"]) for t in triage["accepted"]}
    for t in triage["accepted"]:
        if not t.get("reason"):
            sys.exit(f"triage entry without a reason: {t}")

    results = report.get("results", {}).get("detectors", [])
    seen, new = set(), []
    for r in results:
        if r["impact"] not in GATED:
            continue
        key = (r["check"], where(r))
        seen.add(key)
        if key not in accepted:
            new.append((r["impact"], key, r["description"].strip().splitlines()[0]))

    for key in sorted(accepted - seen):
        print(f"stale triage entry (no longer reported): {key[0]} in {key[1]}")
    gated = sum(1 for r in results if r["impact"] in GATED)
    print(f"slither: {gated} Medium/High result(s), {len(seen)} distinct check/function pair(s), {len(new)} untriaged")
    for impact, key, line in new:
        print(f"UNTRIAGED {impact} {key[0]} in {key[1]}: {line}")
    sys.exit(1 if new else 0)


if __name__ == "__main__":
    main()
