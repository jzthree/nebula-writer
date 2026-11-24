#!/usr/bin/env python3
"""Find the published paragraphs closest to the one you are writing.

    python3 scripts/find_examples.py --journal nature-genetics --section results < notes.txt

Reads your content notes (or draft) on stdin and prints the published
paragraphs from the same journal and section that are most similar in
content and function (TF-IDF cosine over words; at most one per paper),
from examples/<journal>/bank.jsonl (CC BY 4.0 paragraphs, with sources).
Use them as models for sentence shape, density and voice, never for wording.

Journals: nature, science, nature-genetics, nature-methods.
Sections: abstract, intro, results, discussion, methods.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

STOP = set("""a about above after again against all also am an and any are as at be because been before being below between both but by can
could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is
it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some
such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where
which while who whom why will with would you your yours yourself yourselves fig figs figure figures et al using used use""".split())


def tokens(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z][a-z0-9-]+", text.lower()) if w not in STOP and len(w) > 2]


def load_bank(skill_dir: Path, journal: str) -> list[dict]:
    path = skill_dir / "examples" / journal / "bank.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def nearest(bank: list[dict], section: str, query: str, k: int = 4) -> list[dict]:
    """The k bank paragraphs of this section closest to the query, at most one per paper."""
    pool = [row for row in bank if row["section"] == section]
    if not pool:
        return []
    docs = [Counter(tokens(row["text"])) for row in pool]
    df = Counter(term for doc in docs for term in doc)
    n = len(docs)
    idf = {term: math.log((n + 1) / (count + 1)) + 1 for term, count in df.items()}

    def vector(counts: Counter) -> dict[str, float]:
        weights = {t: (1 + math.log(c)) * idf.get(t, math.log(n + 1) + 1) for t, c in counts.items()}
        norm = math.sqrt(sum(v * v for v in weights.values())) or 1.0
        return {t: v / norm for t, v in weights.items()}

    q = vector(Counter(tokens(query)))
    scored = sorted(((sum(q.get(t, 0.0) * w for t, w in vector(doc).items()), i) for i, doc in enumerate(docs)), reverse=True)
    out, papers = [], set()
    for _, i in scored:
        row = pool[i]
        if row["paper"] in papers:
            continue
        out.append(row)
        papers.add(row["paper"])
        if len(out) == k:
            break
    return out


def render(rows: list[dict]) -> str:
    return "\n\n".join(f"## Closest published paragraph {i}\n\n{row['text']}\n\nSource: {row['source']}" for i, row in enumerate(rows, 1))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--journal", required=True)
    parser.add_argument("--section", required=True, choices=["abstract", "intro", "results", "discussion", "methods"])
    parser.add_argument("--k", type=int, default=4)
    args = parser.parse_args()
    rows = nearest(load_bank(Path(__file__).resolve().parents[1], args.journal), args.section, sys.stdin.read(), args.k)
    if not rows:
        print(f"No published {args.section} paragraphs for {args.journal}.", file=sys.stderr)
        return 1
    print(render(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
