#!/usr/bin/env python3
"""Repository hygiene gate (CI). Fails with one line per problem:

  - dependencies: exact versions (no ^, ~, ranges, tags) in app/, sdk/, circuits/ and web/;
    a committed bun.lock and a minimumReleaseAge guard in every package; postinstall installs are frozen;
  - Solidity: deployable contracts in contracts/src use a fixed pragma (`pragma solidity 0.8.x;`); interfaces,
    shared libraries and the generated verifiers/ may keep a range;
  - CI: every `uses:` in .github/workflows is pinned to a full commit SHA, and every workflow sets `permissions:`.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXACT = re.compile(r"^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|file:.+|workspace:.+)$")
problems = []


def bad(msg):
    problems.append(msg)


# ---- dependencies
for pkg_dir, strict in (("app", True), ("sdk", True), ("circuits", True), ("web", True)):
    d = ROOT / pkg_dir
    pkg = json.loads((d / "package.json").read_text())
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        for name, spec in pkg.get(section, {}).items():
            if (strict or name == "viem") and not EXACT.match(spec):
                bad(f"{pkg_dir}/package.json: {name} is '{spec}', pin an exact version")
    for script, cmd in pkg.get("scripts", {}).items():
        if script in ("postinstall", "preinstall", "install") and "bun install" in cmd and "--frozen-lockfile" not in cmd:
            bad(f"{pkg_dir}/package.json: {script} runs a non-frozen bun install")
    if not (d / "bun.lock").exists():
        bad(f"{pkg_dir}/bun.lock is missing (commit the lockfile)")
    bunfig = d / "bunfig.toml"
    if not bunfig.exists() or not re.search(r"^\s*minimumReleaseAge\s*=\s*[1-9]\d*", bunfig.read_text(), re.M):
        bad(f"{pkg_dir}/bunfig.toml: set [install] minimumReleaseAge")

# ---- fixed pragmas on deployable contracts
# Interfaces and libraries are compiled into other contracts; verifiers/ is generated (circuits/scripts).
RANGE_OK = ("contracts/src/interfaces/", "contracts/src/libs/", "contracts/src/consumer/verifiers/")
for sol in sorted((ROOT / "contracts" / "src").rglob("*.sol")):
    rel = sol.relative_to(ROOT).as_posix()
    if rel.startswith(RANGE_OK):
        continue
    m = re.search(r"^\s*pragma solidity ([^;]+);", sol.read_text(), re.M)
    if not m:
        bad(f"{rel}: no pragma")
    elif not re.fullmatch(r"0\.8\.\d+", m.group(1).strip()):
        bad(f"{rel}: floating pragma '{m.group(1).strip()}', use a fixed version")

# ---- GitHub Actions pinned by SHA, permissions set
for wf in sorted((ROOT / ".github" / "workflows").glob("*.y*ml")):
    text = wf.read_text()
    rel = wf.relative_to(ROOT).as_posix()
    if not re.search(r"^permissions:", text, re.M):
        bad(f"{rel}: no top-level permissions:")
    for line_no, line in enumerate(text.splitlines(), 1):
        m = re.match(r"\s*-?\s*uses:\s*([^\s#]+)", line)
        if m and not m.group(1).startswith("./") and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
            bad(f"{rel}:{line_no}: action '{m.group(1)}' is not pinned to a commit SHA")

for p in problems:
    print(f"FAIL {p}")
if problems:
    sys.exit(f"{len(problems)} hygiene problem(s)")
print("hygiene: dependencies pinned and frozen, pragmas fixed, actions pinned")
