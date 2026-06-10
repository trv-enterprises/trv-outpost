#!/usr/bin/env python3
# Copyright (c) 2026 TRV Enterprises LLC
# Licensed under Apache 2.0
# See LICENSE file for details.
"""
Report dependencies that are behind their latest version, reconciled against the
deliberate-pins registry (security/pinned-versions.yaml).

Splits "behind latest" deps into:
  - HELD          : listed in the pins registry with a reason, review not overdue.
  - REVIEW OVERDUE: a held pin whose review_on date has passed — re-evaluate.
  - AVAILABLE      : behind latest and NOT in the registry → a candidate bump.

Usage:
  npm outdated --json            | outdated-report.py --ecosystem npm
  go list -u -m -json all        | outdated-report.py --ecosystem go
  outdated-report.py --ecosystem npm --input out.json

This is informational — it never blocks anything. It's run by `make outdated`
(and can be run ad hoc) to keep dependency freshness visible. Routine drift
shows up under AVAILABLE; deliberate holds stay quiet under HELD.

Exit code: always 0 (informational). The presence of AVAILABLE items is normal.
"""

import argparse
import datetime
import json
import os
import sys

REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pinned-versions.yaml")


def load_pins(path):
    """Return {name: entry} from pinned-versions.yaml. Uses PyYAML if present,
    else the same flat-list fallback shape as reconcile-scan.py."""
    if not os.path.exists(path):
        return {}
    try:
        import yaml
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        entries = data.get("pins", []) or []
    except ImportError:
        entries = _parse_pins_fallback(path)
    return {(e.get("name") or "").strip(): e for e in entries if e.get("name")}


def _parse_pins_fallback(path):
    """Minimal parser for the flat `pins:` list (mirrors reconcile-scan.py's)."""
    entries, cur, in_pins, folding = [], None, False, None
    with open(path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            s = line.strip()
            if s.startswith("#") or not s:
                continue
            if s == "pins:":
                in_pins = True
                continue
            if not in_pins:
                continue
            indent = len(line) - len(line.lstrip())
            if s.startswith("- "):
                if cur:
                    entries.append(cur)
                cur, folding = {}, None
                rest = s[2:]
                if ":" in rest:
                    k, _, v = rest.partition(":")
                    cur[k.strip()] = v.strip().strip('"')
                continue
            if cur is None:
                continue
            if folding is not None and indent > cur.get("_fi", 0):
                cur[folding] = (cur.get(folding, "") + " " + s).strip()
                continue
            folding = None
            if ":" in s:
                k, _, v = s.partition(":")
                k, v = k.strip(), v.strip()
                if v in (">", "|"):
                    folding, cur[k], cur["_fi"] = k, "", indent
                else:
                    cur[k] = v.strip('"')
    if cur:
        entries.append(cur)
    for e in entries:
        e.pop("_fi", None)
    return entries


def today():
    sde = os.environ.get("SOURCE_DATE_EPOCH")
    if sde:
        return datetime.datetime.utcfromtimestamp(int(sde)).date()
    return datetime.date.today()


def review_overdue(entry):
    d = (entry.get("review_on") or "").strip()
    if not d:
        return False
    try:
        return today() > datetime.date.fromisoformat(d)
    except ValueError:
        return False


def parse_npm(stream):
    """Parse `npm outdated --json`. Returns deps where current != latest."""
    text = stream.read().strip()
    if not text:
        return []
    data = json.loads(text)
    out = []
    for name, info in data.items():
        cur, latest = info.get("current"), info.get("latest")
        if cur and latest and cur != latest:
            out.append({"name": name, "current": cur, "wanted": info.get("wanted", ""), "latest": latest})
    return out


def parse_go(stream):
    """Parse `go list -u -m -json all`. Returns modules with an available Update."""
    text = stream.read()
    dec = json.JSONDecoder()
    i, n, out = 0, len(text), []
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
        upd = obj.get("Update")
        if obj.get("Main"):
            continue
        if upd and isinstance(upd, dict) and upd.get("Version"):
            out.append({"name": obj.get("Path", ""), "current": obj.get("Version", ""),
                        "wanted": "", "latest": upd.get("Version", "")})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ecosystem", required=True, choices=["npm", "go"])
    ap.add_argument("--input")
    ap.add_argument("--registry", default=REGISTRY)
    args = ap.parse_args()

    pins = load_pins(args.registry)
    stream = open(args.input) if args.input else sys.stdin
    deps = parse_npm(stream) if args.ecosystem == "npm" else parse_go(stream)

    held, overdue, available = [], [], []
    for d in deps:
        entry = pins.get(d["name"])
        # only treat as held if the pin entry's ecosystem matches (or is unset)
        if entry and entry.get("ecosystem", args.ecosystem) == args.ecosystem:
            (overdue if review_overdue(entry) else held).append((d, entry))
        else:
            available.append(d)

    eco = "npm (client)" if args.ecosystem == "npm" else "go (server-go)"
    print(f"── {eco} — behind latest, reconciled against pinned-versions registry ──")

    if held:
        print(f"\n  HELD ({len(held)}) — deliberate pins, see security/pinned-versions.yaml:")
        for d, e in held:
            print(f"    · {d['name']:<32} {d['current']} → {d['latest']}  (review {e.get('review_on','?')})")

    if overdue:
        print(f"\n  ⚠ REVIEW OVERDUE ({len(overdue)}) — held pin past its review date:")
        for d, e in overdue:
            print(f"    ! {d['name']:<32} {d['current']} → {d['latest']}  (review was {e.get('review_on','?')})")

    if available:
        print(f"\n  AVAILABLE ({len(available)}) — behind latest, not a documented hold:")
        for d in available:
            w = f" (wanted {d['wanted']})" if d.get("wanted") and d["wanted"] != d["latest"] else ""
            print(f"    · {d['name']:<32} {d['current']} → {d['latest']}{w}")
    else:
        print("\n  AVAILABLE (0) — everything is current or held ✓")

    print(f"\n  Summary: {len(held)} held, {len(overdue)} review-overdue, {len(available)} available to bump.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
