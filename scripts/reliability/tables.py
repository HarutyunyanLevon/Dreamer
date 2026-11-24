"""Merges harness run folders into one table (the same metrics as the harness's summary.md).

python scripts/reliability/tables.py "label" <run folder> [<run folder> ...]
"""
import json
import sys
from collections import OrderedDict, defaultdict


def pct(v, p):
    if not v:
        return None
    v = sorted(v)
    return v[round((len(v) - 1) * p)]


def s(ms):
    return "-" if ms is None else f"{ms / 1000:.1f}s"


def main():
    label, dirs = sys.argv[1], sys.argv[2:]
    by = OrderedDict()
    claude = 0
    for d in dirs:
        for line in open(f"{d}/results.jsonl", encoding="utf-8"):
            r = json.loads(line)
            by.setdefault(r["scenario"], []).append(r)
            claude += r.get("claude_turns", 0)
    order = lambda k: (k[:2], k)
    print(f"### {label}\n")
    print("| Scenario | Success | TTFE median | TTFE p95 | Turn median | Turn p95 | End reasons (all turns) | Spinners |")
    print("|---|---|---|---|---|---|---|---|")
    for sc in sorted(by, key=order):
        rs = by[sc]
        ok = sum(1 for r in rs if r["ok"])
        turns = [t for r in rs for t in r["turns"]]
        ttfe = [t["ttfe_ms"] for t in turns if t.get("ttfe_ms") is not None]
        tot = [t["total_ms"] for t in turns]
        ends = defaultdict(int)
        for t in turns:
            k = t["end"]
            if t.get("fallback"):
                k += "/" + t["fallback"]
            if t.get("retried_local"):
                k += "+retry"
            ends[k] += 1
        spin = sum(1 for t in turns if t["end"] == "spinner")
        endtxt = ", ".join(f"{k} {n}" for k, n in sorted(ends.items()))
        print(f"| {sc} | {ok}/{len(rs)} | {s(pct(ttfe, .5))} | {s(pct(ttfe, .95))} | {s(pct(tot, .5))} | {s(pct(tot, .95))} | {endtxt} | {spin} |")
    print(f"\nReal Claude turns: {claude}\n")


main()
