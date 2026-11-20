"""The three prompts of the test.

1. Brief: a published paragraph becomes telegraphic content notes: every
   fact, number, citation and figure reference, none of the wording.
2. Generate: a writer rewrites the paragraph from the brief alone, with or
   without the style skill.
3. Judge: a reader of the journal sees the published paragraph and the
   rewrite (in random order, same content) and says which was published.

The skill succeeds when judges can no longer tell: detection near 50%.
"""

from __future__ import annotations

from pathlib import Path

from .corpus import JOURNALS

SECTION_NAMES = {
    "abstract": "abstract (summary paragraph)",
    "intro": "introduction",
    "results": "Results",
    "discussion": "Discussion",
    "methods": "Methods",
}

BRIEF_SYSTEM = """You prepare content briefs for a writing-style experiment. A writer will recreate a published paragraph from your brief alone, and a judge will compare the two, so the brief must carry ALL of the content and NONE of the wording.

Rules:
- Write telegraphic notes, not sentences: fragments, abbreviations and arrows are fine.
- Keep every fact, claim, comparison, number with its unit, statistic, sample size, name (gene, protein, cell type, organism, method, software, dataset), and the strength of each claim (shown / suggests / speculated / unknown).
- Keep citation markers exactly as written (for example [12] or [3–5]) next to the claim each supports, and figure or table references exactly as written (for example Fig. 2a, Extended Data Fig. 3b).
- Do not reuse any phrase of four or more words from the paragraph unless it is a name, an established technical term, or a quantity.
- Do not describe or hint at the style (tone, voice, sentence length, connectives).
- Keep the points in the order the paragraph presents them.

Answer with a JSON object: {"function": "one line on what the paragraph does in the paper", "points": ["note", "note", ...]}"""


def brief_prompt(paragraph_text: str) -> str:
    return f"Paragraph:\n<<<\n{paragraph_text}\n>>>"


BASELINE_SYSTEM = "You are a scientific writer."


def skill_system(skill_dir: Path, journal_key: str) -> str:
    """The skill as an agent would load it: SKILL.md, then the journal's reference file."""
    skill = (skill_dir / "SKILL.md").read_text()
    if skill.startswith("---"):
        skill = skill.split("---", 2)[2].lstrip()
    reference = skill_dir / "references" / f"{journal_key}.md"
    parts = [skill]
    if reference.exists():
        parts.append(reference.read_text())
    return "\n\n---\n\n".join(parts)


def generate_prompt(journal_key: str, title: str, section: str, words: int, brief: dict) -> str:
    journal = JOURNALS[journal_key].name
    points = "\n".join(f"- {point}" for point in brief.get("points", []))
    return (
        f'Paper: "{title}", to be published in {journal}.\n'
        f"Section: {SECTION_NAMES[section]}.\n\n"
        f"Write the paragraph described below for this section of the paper, as it would appear in {journal}. "
        f"Length: about {words} words. Keep every citation marker in the form [n] exactly as given, attached to the claim it supports, "
        "and keep figure references as given. Do not add facts, numbers or citations that are not in the notes. "
        "Output the paragraph only: no heading, no notes.\n\n"
        f"What the paragraph does: {brief.get('function', '')}\n"
        f"Content notes:\n{points}"
    )


def judge_system(journal_key: str) -> str:
    journal = JOURNALS[journal_key].name
    return (
        f"You are an expert reader of {journal}: you have read thousands of its papers and know how its published text reads. "
        "You judge which of two paragraphs was published and which was written by an AI model. Answer with JSON only."
    )


def judge_prompt(journal_key: str, title: str, section: str, first: str, second: str, references: list[str]) -> str:
    journal = JOURNALS[journal_key].name
    calibration = ""
    if references:
        shown = "\n\n".join(f"<<<\n{text}\n>>>" for text in references)
        calibration = f"For calibration, here are paragraphs from the {SECTION_NAMES[section]} sections of other {journal} papers:\n\n{shown}\n\n"
    return (
        f"{calibration}"
        f'Below are two paragraphs written for the {SECTION_NAMES[section]} of a paper titled "{title}". '
        f"Both convey the same content. One is the paragraph as published in {journal}. The other was written by an AI model "
        "from notes listing the published paragraph's content (facts, numbers, citations), without seeing its wording. "
        "Citation markers have been normalized to [n] in both.\n\n"
        f"Paragraph A:\n<<<\n{first}\n>>>\n\nParagraph B:\n<<<\n{second}\n>>>\n\n"
        "Which one was published? Judge how each is written. Differences in content are an artifact of the notes, not evidence.\n"
        'Answer with JSON: {"published": "A" or "B", "confidence": a number from 0.5 (a guess) to 1.0 (certain), '
        '"tells": ["short, specific features of the paragraph you think the AI wrote that gave it away"]}'
    )
