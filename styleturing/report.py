"""The scoreboard of a run: how often each judge spotted the published
paragraph, per condition and journal, with 95% intervals; where the
generated text drifts in measurable features; and what the judges said.

A condition passes for a journal when every judge's detection rate has a
95% interval that includes 50% (chance), i.e. the judges cannot tell.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean

from .corpus import JOURNALS
from .experiment import read_jsonl
from .stylometry import FEATURES, compare, features, wilson


def longest_shared_run(a: str, b: str) -> int:
    """Longest run of words the two texts share: a check that the brief did not leak wording."""
    x = re.findall(r"\w+", a.lower())
    y = re.findall(r"\w+", b.lower())
    best = 0
    previous = [0] * (len(y) + 1)
    for i in range(1, len(x) + 1):
        current = [0] * (len(y) + 1)
        for j in range(1, len(y) + 1):
            if x[i - 1] == y[j - 1]:
                current[j] = previous[j - 1] + 1
                best = max(best, current[j])
        previous = current
    return best


def detection_table(judgments: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for j in judgments:
        groups[(j["condition"], j["journal"], j["judge"])].append(j)
        groups[(j["condition"], "all", j["judge"])].append(j)
    rows = []
    for (condition, journal, judge), group in sorted(groups.items()):
        n = len(group)
        hits = sum(j["correct"] for j in group)
        low, high = wilson(hits, n)
        rows.append({
            "condition": condition, "journal": journal, "judge": judge, "n": n, "detected": hits,
            "rate": hits / n if n else 0.0, "ci_low": low, "ci_high": high,
            "confident_detections": sum(j["correct"] and j["confidence"] >= 0.8 for j in group),
            "indistinguishable": low <= 0.5,
        })
    return rows


def verdicts(rows: list[dict]) -> dict[str, dict[str, bool]]:
    """condition -> journal -> passes (every judge's interval includes chance)."""
    out: dict[str, dict[str, bool]] = defaultdict(dict)
    for row in rows:
        current = out[row["condition"]].get(row["journal"], True)
        out[row["condition"]][row["journal"]] = current and row["indistinguishable"]
    return out


def write_report(run_dir: Path, data_dir: Path) -> Path:
    config = json.loads((run_dir / "config.json").read_text())
    items = {i["id"]: i for i in read_jsonl(run_dir / "items.jsonl")}
    generations = read_jsonl(run_dir / "generations.jsonl")
    judgments = read_jsonl(run_dir / "judgments.jsonl")
    rows = detection_table(judgments)
    passing = verdicts(rows)

    lines = [f"# Style Turing test: {config['name']}", ""]
    lines.append(f"Split **{config['split']}** · {len(items)} published paragraphs · generator `{config['generator']}` · judges {', '.join(f'`{j}`' for j in config['judges'])} · {config['references']} calibration paragraphs per judgment")
    lines.append("")
    lines.append("Conditions: " + "; ".join(f"**{c['name']}** ({c['skill'] or 'no skill'}, `{c['fingerprint']}`)" for c in config["conditions"]))
    lines += ["", "Detection rate = how often the judge picked the published paragraph. 50% means the judge cannot tell. "
              "A condition passes a journal when every judge's 95% interval includes 50%.", ""]

    lines += ["## Verdict", "", "| Condition | " + " | ".join(JOURNALS[j].name for j in config["journals"]) + " | All |", "|---|" + "---|" * (len(config["journals"]) + 1)]
    for condition in [c["name"] for c in config["conditions"]]:
        cells = []
        for journal in config["journals"] + ["all"]:
            journal_rows = sorted((r for r in rows if r["condition"] == condition and r["journal"] == journal), key=lambda r: config["judges"].index(r["judge"]) if r["judge"] in config["judges"] else 99)
            if not journal_rows:
                cells.append("–")
                continue
            rates = " / ".join(f"{r['rate']:.0%}" for r in journal_rows)
            cells.append(("✅ " if passing[condition].get(journal) else "❌ ") + rates)
        lines.append(f"| {condition} | " + " | ".join(cells) + " |")
    lines += ["", "(Rates per judge, in the order: " + ", ".join(config["judges"]) + ".)", ""]

    lines += ["## Detection by judge", "", "| Condition | Journal | Judge | n | Detected | Rate | 95% CI | Confident hits |", "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        name = "All journals" if r["journal"] == "all" else JOURNALS[r["journal"]].name
        lines.append(f"| {r['condition']} | {name} | {r['judge']} | {r['n']} | {r['detected']} | {r['rate']:.0%} | {r['ci_low']:.0%}–{r['ci_high']:.0%} | {r['confident_detections']} |")

    # By section, pooled over journals and judges.
    lines += ["", "## Detection by section (all journals, all judges)", "", "| Condition | Section | n | Rate |", "|---|---|---|---|"]
    by_section: dict[tuple, list[bool]] = defaultdict(list)
    for j in judgments:
        by_section[(j["condition"], j["section"])].append(j["correct"])
    for (condition, section), hits in sorted(by_section.items()):
        lines.append(f"| {condition} | {section} | {len(hits)} | {sum(hits) / len(hits):.0%} |")

    # Measurable drift from the published text.
    lines += ["", "## Where the generated text drifts (stylometry)", "",
              "Effect = (generated mean − published mean) in pooled SD units; |effect| above ~0.5 is a visible habit.", ""]
    summary_style: dict = {}
    for condition in [c["name"] for c in config["conditions"]]:
        for journal in config["journals"]:
            gens = [g for g in generations if g["condition"] == condition and items.get(g["id"], {}).get("journal") == journal]
            if not gens:
                continue
            comparison = compare([features(items[g["id"]]["text"]) for g in gens], [features(g["text"]) for g in gens])
            summary_style[f"{condition}:{journal}"] = comparison
            top = [c for c in comparison if abs(c["effect"]) >= 0.4][:8]
            lines.append(f"**{condition} · {JOURNALS[journal].name}**: " + ("; ".join(f"{c['description']} {c['real']:.1f} → {c['generated']:.1f} ({c['effect']:+.1f})" for c in top) or "no feature off by 0.4 SD or more"))
            lines.append("")

    # Leak check.
    runs = [longest_shared_run(items[g["id"]]["text"], g["text"]) for g in generations if g["id"] in items]
    if runs:
        lines += ["## Leak check", "", f"Longest run of words shared by a published paragraph and its rewrite: median {sorted(runs)[len(runs) // 2]}, max {max(runs)} "
                  "(lists of names and numbers make long runs normal; a long run of ordinary words means the brief leaked wording).", ""]

    # What the judges said.
    lines += ["## What gave the rewrites away", ""]
    for condition in [c["name"] for c in config["conditions"]]:
        for journal in config["journals"]:
            tells = [t for j in judgments if j["condition"] == condition and j["journal"] == journal and j["correct"] for t in j["tells"]]
            if not tells:
                continue
            words = Counter(w for t in tells for w in re.findall(r"[a-z][a-z\-]{3,}", t.lower()))
            lines.append(f"**{condition} · {JOURNALS[journal].name}** ({len(tells)} tells; frequent words: {', '.join(w for w, _ in words.most_common(12))})")
            for tell in tells[:8]:
                lines.append(f"- {tell}")
            lines.append("")

    report = run_dir / "report.md"
    report.write_text("\n".join(lines) + "\n")
    (run_dir / "summary.json").write_text(json.dumps({"detection": rows, "passing": passing, "stylometry": summary_style,
                                                      "judgments": len(judgments), "generations": len(generations)}, indent=2))
    return report


def mean_or_none(values: list[float]) -> float | None:
    return mean(values) if values else None
