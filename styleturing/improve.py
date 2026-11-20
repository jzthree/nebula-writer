"""Revise the skill from what gave its rewrites away on the dev split.

The reviser sees the judges' tells, the measured drift, a few published /
rewrite pairs the judges got right, and the published profile from the
training split, and returns a new reference file. Test is never shown, so
the held-out score stays honest.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .corpus import JOURNALS, load
from .experiment import read_jsonl
from .llm import Client, Model
from .stylometry import FEATURES, compare, features

REVISER_SYSTEM = """You maintain a writing-style skill that an AI model follows to write paragraphs indistinguishable from those published in a specific journal. You are given evidence of how its latest output was still told apart from the published text, and you rewrite the journal's reference file to fix that.

The skill is used to WRITE new paragraphs for this journal, from notes, data or a rough draft. It is not an editing guide for a given source text: phrase every rule as how to write (never "keep the source's …").

Rules for the reference file:
- Every rule must generalize: it describes how the journal writes, never what a particular paper is about.
- Never quote wording from the example pairs or the judges' tells: no phrase of three or more words from them, and none of their distinctive terms. Those paragraphs are evaluation data; copying them makes the next score meaningless. Write neutral, invented illustrations instead.
- Make rules concrete and checkable (what to do, what to avoid, with numbers where the profile gives them), not adjectives like "concise" or "elegant".
- Never paste sentences from the example paragraphs. Illustrate a pattern with a short invented example if needed.
- Keep what already works; remove or fix rules that the evidence shows backfire.
- Organize by section (abstract, introduction, Results, Discussion, Methods) where the journal differs by section.
- At most 1,400 words. Keep it shorter than that if you can: the writer reads all of it.

Answer with the complete new file between the lines <<<FILE and FILE>>>, then a short list of what you changed and why between <<<CHANGES and CHANGES>>>."""


class RevisionError(RuntimeError):
    pass


def copied_wording(reference: str, texts: list[str], limit: int = 6) -> list[str]:
    """Runs of `limit`+ ordinary words the reference shares with evaluation paragraphs (names and numbers aside)."""
    ref_words = re.findall(r"[a-z]+", reference.lower())
    grams = {" ".join(ref_words[i:i + limit]) for i in range(len(ref_words) - limit + 1)}
    found: list[str] = []
    for text in texts:
        words = re.findall(r"[a-z]+", text.lower())
        for i in range(len(words) - limit + 1):
            gram = " ".join(words[i:i + limit])
            if gram in grams and gram not in found:
                found.append(gram)
    return found[:5]


def profile(data_dir: Path, journal: str, split: str = "train") -> dict[str, dict[str, float]]:
    """Mean feature values of published paragraphs, per section, from one split."""
    from statistics import mean

    out: dict[str, dict[str, float]] = {}
    paragraphs = [p for p in load(data_dir, [journal]) if p.split == split]
    for section in sorted({p.section for p in paragraphs}):
        rows = [features(p.text) for p in paragraphs if p.section == section]
        out[section] = {name: mean(r[name] for r in rows) for name in FEATURES} | {"n": float(len(rows))}
    return out


def revise(run_dir: Path, data_dir: Path, skill_dir: Path, condition: str, journal: str, reviser: Model, examples: int = 4) -> tuple[str, str]:
    items = {i["id"]: i for i in read_jsonl(run_dir / "items.jsonl")}
    generations = {(g["id"], g["condition"]): g["text"] for g in read_jsonl(run_dir / "generations.jsonl")}
    judgments = [j for j in read_jsonl(run_dir / "judgments.jsonl") if j["condition"] == condition and j["journal"] == journal]
    if not judgments:
        raise SystemExit(f"no judgments for {condition} on {journal} in {run_dir}")
    detected = [j for j in judgments if j["correct"]]
    rate = len(detected) / len(judgments)

    pairs = [(items[j["id"]]["text"], generations[(j["id"], condition)]) for j in judgments if (j["id"], condition) in generations]
    drift = compare([features(a) for a, _ in pairs], [features(b) for _, b in pairs])
    drift_lines = "\n".join(f"- {d['description']}: published {d['real']:.2f}, rewrites {d['generated']:.2f} (effect {d['effect']:+.2f} SD)" for d in drift if abs(d["effect"]) >= 0.25)

    tells = "\n".join(f"- {t}" for j in detected for t in j["tells"])
    confident = sorted(detected, key=lambda j: -j["confidence"])
    seen: set[str] = set()
    shown = []
    for j in confident:
        if j["id"] in seen or (j["id"], condition) not in generations:
            continue
        seen.add(j["id"])
        shown.append(f"Section: {j['section']}\nPublished:\n<<<\n{items[j['id']]['text']}\n>>>\nRewrite (detected, confidence {j['confidence']:.2f}):\n<<<\n{generations[(j['id'], condition)]}\n>>>")
        if len(shown) >= examples:
            break

    targets = profile(data_dir, journal)
    target_lines = "\n".join(
        f"- {section} (n={int(values['n'])}): " + ", ".join(f"{name} {values[name]:.2f}" for name in ("words", "sentence_len_mean", "sentence_len_sd", "commas_per_sentence", "we_pk", "passive_pk", "connectives_pk", "hedges_pk", "ai_tells_pk", "dashes_pk", "semicolons_pk", "this_these_start"))
        for section, values in targets.items()
    )

    skill = (skill_dir / "SKILL.md").read_text()
    reference_path = skill_dir / "references" / f"{journal}.md"
    reference = reference_path.read_text() if reference_path.exists() else "(empty: write it from scratch)"
    prompt = f"""Journal: {JOURNALS[journal].name}

The general skill (for context; you are rewriting only the journal reference file):
<<<
{skill}
>>>

Current reference file for {JOURNALS[journal].name}:
<<<
{reference}
>>>

Result on the dev split: judges picked the published paragraph in {len(detected)} of {len(judgments)} comparisons ({rate:.0%}; 50% is the goal).

What the judges said gave the rewrites away:
{tells or '- (no tells)'}

Measured drift of the rewrites from the published paragraphs (feature: published vs rewrites):
{drift_lines or '- none above 0.25 SD'}

Published profile of {JOURNALS[journal].name} from the training split (means per section; feature names as in the drift list):
{target_lines}

Pairs the judges got right (do not copy their sentences):

{chr(10).join(shown)}
"""
    client = Client(data_dir / "cache")
    answer = client.complete(reviser, REVISER_SYSTEM, prompt)
    file_match = re.search(r"<<<FILE\s*\n(.*?)\n\s*FILE>>>", answer, re.S)
    if not file_match:
        (run_dir / f"revision-{journal}.raw.txt").write_text(answer)
        raise RevisionError(f"the reviser returned no file for {journal} (raw answer in {run_dir / f'revision-{journal}.raw.txt'})")
    copied = copied_wording(file_match.group(1), [i["text"] for i in items.values() if i["journal"] == journal])
    if copied:
        (run_dir / f"revision-{journal}.rejected.md").write_text(file_match.group(1))
        raise RevisionError(f"the revision for {journal} copies dev wording, so it was not applied: {copied}")
    changes_match = re.search(r"<<<CHANGES\s*\n(.*?)\n\s*CHANGES>>>", answer, re.S)
    reference_path.parent.mkdir(parents=True, exist_ok=True)
    reference_path.write_text(file_match.group(1).strip() + "\n")
    changes = changes_match.group(1).strip() if changes_match else "(no change list)"
    (run_dir / f"revision-{journal}.md").write_text(f"# Revision of {journal} from {run_dir.name}\n\nDev detection {rate:.0%} ({len(detected)}/{len(judgments)}).\n\n{changes}\n")
    return str(reference_path), changes


def profile_table(data_dir: Path, journals: list[str]) -> str:
    lines = ["| Journal | Section | n | " + " | ".join(FEATURES) + " |", "|---|---|---|" + "---|" * len(FEATURES)]
    for journal in journals:
        for section, values in profile(data_dir, journal).items():
            lines.append(f"| {journal} | {section} | {int(values['n'])} | " + " | ".join(f"{values[name]:.2f}" for name in FEATURES) + " |")
    return "\n".join(lines)


def dump_json(value) -> str:
    return json.dumps(value, indent=2)
