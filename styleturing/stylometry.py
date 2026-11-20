"""Measurable surface features of a paragraph. They do not decide the test
(the judges do), but they show *where* generated text drifts from the
journal, in numbers the skill can be held to.
"""

from __future__ import annotations

import math
import re
from statistics import mean, pstdev

SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(\[‘“])")
ABBREVIATIONS = re.compile(r"\b(?:Fig|Figs|Extended Data Fig|Supplementary Fig|et al|e\.g|i\.e|ref|refs|approx|vs|cf|no|Eq|Eqs|Ref|Refs|Supplementary Table|Supplementary Note)\.$")

CONNECTIVES = ["however", "moreover", "furthermore", "additionally", "notably", "importantly", "consequently", "thus", "therefore", "hence", "indeed", "in addition", "in contrast", "overall", "together", "taken together", "collectively", "interestingly", "specifically", "finally"]
HEDGES = ["may", "might", "could", "suggest", "suggests", "suggesting", "likely", "possibly", "potentially", "appear", "appears", "indicate", "indicates", "putative"]
AI_TELLS = ["crucial", "pivotal", "delve", "underscore", "underscores", "highlight", "highlights", "highlighting", "landscape", "intricate", "robust", "robustly", "comprehensive", "leverage", "leveraging", "novel", "paramount", "multifaceted", "nuanced", "seamless", "showcase", "showcases", "unprecedented", "critical", "key", "insights", "valuable", "versatile", "holistic", "realm", "tapestry", "elucidate", "harness", "harnessing", "notably", "furthermore", "moreover", "additionally"]
PASSIVE = re.compile(r"\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b", re.I)


def sentences(text: str) -> list[str]:
    parts: list[str] = []
    buffer = ""
    for piece in SENTENCE_END.split(text):
        buffer = f"{buffer} {piece}".strip() if buffer else piece
        if ABBREVIATIONS.search(buffer):
            continue
        parts.append(buffer)
        buffer = ""
    if buffer:
        parts.append(buffer)
    return [p for p in parts if p.strip()]


def words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z][A-Za-z'’\-]*", text)


def _rate(count: int, n_words: int) -> float:
    return 1000.0 * count / max(1, n_words)


def _count_terms(lower: str, terms: list[str]) -> int:
    return sum(len(re.findall(rf"\b{re.escape(term)}\b", lower)) for term in terms)


FEATURES = {
    "words": "words in the paragraph",
    "sentences": "sentences in the paragraph",
    "sentence_len_mean": "mean words per sentence",
    "sentence_len_sd": "spread of sentence length (SD, words)",
    "word_len_mean": "mean letters per word",
    "commas_per_sentence": "commas per sentence",
    "semicolons_pk": "semicolons per 1,000 words",
    "colons_pk": "colons per 1,000 words",
    "dashes_pk": "em/en dashes used as punctuation per 1,000 words",
    "parens_pk": "parentheses per 1,000 words (excluding citations)",
    "we_pk": "'we/our/us' per 1,000 words",
    "passive_pk": "passive constructions per 1,000 words",
    "connectives_pk": "sentence connectives (however, moreover, …) per 1,000 words",
    "hedges_pk": "hedging words per 1,000 words",
    "ai_tells_pk": "words typical of AI prose (crucial, robust, highlight, …) per 1,000 words",
    "this_these_start": "share of sentences opening with This/These",
    "numbers_pk": "numerals per 1,000 words",
    "citations_pk": "citation markers per 1,000 words",
}


def features(text: str) -> dict[str, float]:
    sents = sentences(text)
    toks = words(text)
    n = len(toks)
    lower = text.lower()
    lens = [len(words(s)) for s in sents] or [0]
    no_cites = re.sub(r"\[[\d,–\-]+\]", "", text)
    return {
        "words": float(n),
        "sentences": float(len(sents)),
        "sentence_len_mean": mean(lens),
        "sentence_len_sd": pstdev(lens) if len(lens) > 1 else 0.0,
        "word_len_mean": mean(len(t) for t in toks) if toks else 0.0,
        "commas_per_sentence": text.count(",") / max(1, len(sents)),
        "semicolons_pk": _rate(text.count(";"), n),
        "colons_pk": _rate(len(re.findall(r":(?!\d)", text)), n),
        "dashes_pk": _rate(len(re.findall(r"—|\s–\s", text)), n),
        "parens_pk": _rate(no_cites.count("("), n),
        "we_pk": _rate(_count_terms(lower, ["we", "our", "us"]), n),
        "passive_pk": _rate(len(PASSIVE.findall(text)), n),
        "connectives_pk": _rate(_count_terms(lower, CONNECTIVES), n),
        "hedges_pk": _rate(_count_terms(lower, HEDGES), n),
        "ai_tells_pk": _rate(_count_terms(lower, AI_TELLS), n),
        "this_these_start": sum(bool(re.match(r"(This|These)\b", s)) for s in sents) / max(1, len(sents)),
        "numbers_pk": _rate(len(re.findall(r"(?<![\[\w])\d+(?:\.\d+)?", no_cites)), n),
        "citations_pk": _rate(len(re.findall(r"\[[\d,–\-]+\]", text)), n),
    }


def compare(real: list[dict[str, float]], generated: list[dict[str, float]]) -> list[dict]:
    """Per feature: means and the standardized difference (generated minus real, in real's SD units)."""
    rows = []
    for name in FEATURES:
        a = [f[name] for f in real]
        b = [f[name] for f in generated]
        if not a or not b:
            continue
        sd = pstdev(a + b) or 1.0
        rows.append({"feature": name, "description": FEATURES[name], "real": mean(a), "generated": mean(b), "effect": (mean(b) - mean(a)) / sd})
    rows.sort(key=lambda row: -abs(row["effect"]))
    return rows


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))
