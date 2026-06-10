#!/usr/bin/env python3
# Copyright (c) 2026 TRV Enterprises LLC
# Licensed under Apache 2.0
# See LICENSE file for details.
"""
Reconcile dependency-scanner output against the accepted-vulnerability registry
(security/accepted-vulns.yaml).

Reads scanner findings, splits them into ACTIONABLE vs KNOWN-ACCEPTED (an
exception that exists in the registry AND has not expired), and prints a report.

Usage:
  govulncheck -json ./...        | reconcile-scan.py --scanner govulncheck
  npm audit --json               | reconcile-scan.py --scanner npm-audit
  reconcile-scan.py --scanner govulncheck --input file.json

Exit code:
  0  no actionable findings (all clear, or all findings are known-accepted)
  1  one or more ACTIONABLE findings (caller decides whether to block)
  2  registry/parse error, or an exception in the registry has EXPIRED
     (expired exceptions are treated as actionable + flagged loudly)

This script only REPORTS + classifies. The Makefile decides what blocks a
release (per SECURITY.md: gitleaks + npm-critical block; govulncheck reports).
The point here is to keep accepted findings out of the actionable list so the
release report is signal, not noise.
"""

import argparse
import datetime
import json
import os
import sys

REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "accepted-vulns.yaml")


def load_registry(path):
    """Load the accepted-vulns registry. Returns {id: entry}. Uses PyYAML if
    available, else a tiny purpose-built parser for this file's flat shape so
    the gate has no hard dependency on PyYAML."""
    if not os.path.exists(path):
        return {}, []
    try:
        import yaml  # noqa
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        entries = data.get("exceptions", []) or []
    except ImportError:
        entries = _parse_registry_fallback(path)
    by_id = {}
    errors = []
    for e in entries:
        eid = (e.get("id") or "").strip()
        if not eid:
            errors.append("registry entry missing 'id'")
            continue
        by_id[eid] = e
    return by_id, errors


def _parse_registry_fallback(path):
    """Minimal YAML-list parser for the flat `exceptions:` list in this file.
    Handles `- id: X` items with `key: value` lines and `>` folded blocks.
    Good enough for this file; PyYAML is used when present."""
    entries = []
    cur = None
    in_exceptions = False
    folding_key = None
    with open(path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            stripped = line.strip()
            if stripped.startswith("#") or not stripped:
                continue
            if stripped == "exceptions:":
                in_exceptions = True
                continue
            if not in_exceptions:
                continue
            indent = len(line) - len(line.lstrip())
            if stripped.startswith("- "):
                if cur:
                    entries.append(cur)
                cur = {}
                folding_key = None
                rest = stripped[2:]
                if ":" in rest:
                    k, _, v = rest.partition(":")
                    cur[k.strip()] = v.strip()
                continue
            if cur is None:
                continue
            if folding_key is not None and indent > cur.get("_fold_indent", 0):
                cur[folding_key] = (cur.get(folding_key, "") + " " + stripped).strip()
                continue
            folding_key = None
            if ":" in stripped:
                k, _, v = stripped.partition(":")
                k = k.strip()
                v = v.strip()
                if v in (">", "|"):
                    folding_key = k
                    cur[k] = ""
                    cur["_fold_indent"] = indent
                else:
                    cur[k] = v
    if cur:
        entries.append(cur)
    for e in entries:
        e.pop("_fold_indent", None)
    return entries


def today():
    # Pass an explicit date via SOURCE_DATE_EPOCH for reproducible/testable runs.
    sde = os.environ.get("SOURCE_DATE_EPOCH")
    if sde:
        return datetime.datetime.utcfromtimestamp(int(sde)).date()
    return datetime.date.today()


def is_expired(entry):
    exp = (entry.get("expires_on") or "").strip()
    if not exp:
        return False  # no expiry → treat as non-expired (registry validation warns separately)
    try:
        return today() > datetime.date.fromisoformat(exp)
    except ValueError:
        return False


def parse_govulncheck(stream):
    """Parse `govulncheck -json`. Returns SYMBOL-REACHABLE findings only —
    {id, module, scanner}.

    govulncheck -json emits two relevant record types:
      - `osv`     : the advisory CATALOG (definitions for everything in the
                    import graph). Do NOT treat these as findings — there are
                    hundreds, most for code we never call.
      - `finding` : an actual finding, with a `trace` of frames. A finding is
                    SYMBOL-REACHABLE (your code calls into the vulnerable
                    function) iff some trace frame names a `function`. Findings
                    without a function frame are 'imported but not called' /
                    transitive-only — lower tier, not actionable here.

    We surface only symbol-reachable findings, matching govulncheck's own
    default text-mode "Symbol Results". The osv records are used only as a
    lookup for the human-readable module name."""
    text = stream.read()
    dec = json.JSONDecoder()
    i, n = 0, len(text)
    catalog = {}      # osv id -> module name
    reachable = {}    # osv id -> finding dict (symbol-reachable only)
    while i < n:
        while i < n and text[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        try:
            obj, end = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            break
        i = end
        if not isinstance(obj, dict):
            continue
        if isinstance(obj.get("osv"), dict):
            osv = obj["osv"]
            vid = osv.get("id")
            if vid:
                mod = ""
                affected = osv.get("affected") or []
                if affected and isinstance(affected, list):
                    mod = affected[0].get("package", {}).get("name", "")
                catalog[vid] = mod
        elif isinstance(obj.get("finding"), dict):
            f = obj["finding"]
            vid = f.get("osv")
            if not vid:
                continue
            trace = f.get("trace") or []
            is_symbol_reachable = any(fr.get("function") for fr in trace)
            if is_symbol_reachable:
                mod = ""
                if trace:
                    mod = trace[0].get("module", "") or ""
                reachable.setdefault(vid, {"id": vid, "module": mod, "scanner": "govulncheck"})
    # Backfill module names from the catalog where the trace didn't carry one.
    for vid, f in reachable.items():
        if not f["module"]:
            f["module"] = catalog.get(vid, "")
    return list(reachable.values())


def parse_npm_audit(stream):
    """Parse `npm audit --json`. Returns findings keyed by GHSA id (preferred)
    so they can be matched against the registry."""
    data = json.load(stream)
    findings = {}
    for name, adv in (data.get("vulnerabilities") or {}).items():
        via = adv.get("via", [])
        sev = adv.get("severity", "unknown")
        for v in via:
            if isinstance(v, dict):
                # npm v7+ advisory object: url like .../advisories/GHSA-xxxx
                url = v.get("url", "") or ""
                ghsa = url.rstrip("/").split("/")[-1] if "GHSA" in url else v.get("source", name)
                findings.setdefault(str(ghsa), {
                    "id": str(ghsa),
                    "module": v.get("name", name),
                    "scanner": "npm-audit",
                    "severity": v.get("severity", sev),
                    "title": v.get("title", ""),
                })
    return list(findings.values())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scanner", required=True, choices=["govulncheck", "npm-audit"])
    ap.add_argument("--input", help="read scanner output from file instead of stdin")
    ap.add_argument("--registry", default=REGISTRY)
    args = ap.parse_args()

    registry, reg_errors = load_registry(args.registry)
    for err in reg_errors:
        print(f"⚠ registry: {err}", file=sys.stderr)

    stream = open(args.input) if args.input else sys.stdin
    if args.scanner == "govulncheck":
        findings = parse_govulncheck(stream)
    else:
        findings = parse_npm_audit(stream)

    actionable = []
    accepted = []
    expired = []
    for f in findings:
        entry = registry.get(f["id"])
        if entry and is_expired(entry):
            expired.append((f, entry))
        elif entry:
            accepted.append((f, entry))
        else:
            actionable.append(f)

    label = "govulncheck (Go deps + stdlib)" if args.scanner == "govulncheck" else "npm audit (client deps)"
    print(f"── {label} — reconciled against accepted-vulns registry ──")

    if accepted:
        print(f"\n  Known-accepted ({len(accepted)}) — risk consciously accepted, see security/accepted-vulns.yaml:")
        for f, e in accepted:
            print(f"    · {f['id']:<16} {f.get('module','')}  (until {e.get('expires_on','?')})")

    if expired:
        print(f"\n  ⚠ EXPIRED EXCEPTIONS ({len(expired)}) — re-review or remediate, now ACTIONABLE:")
        for f, e in expired:
            print(f"    ! {f['id']:<16} {f.get('module','')}  (expired {e.get('expires_on','?')})")

    if actionable:
        print(f"\n  ACTIONABLE ({len(actionable)}) — not in the accepted registry:")
        for f in actionable:
            extra = f"  [{f.get('severity','')}]" if f.get("severity") else ""
            print(f"    ✗ {f['id']:<16} {f.get('module','')}{extra}")
    else:
        print("\n  ACTIONABLE (0) — clean ✓")

    print()
    if expired:
        return 2
    return 1 if actionable else 0


if __name__ == "__main__":
    sys.exit(main())
