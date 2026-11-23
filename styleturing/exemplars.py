"""A bank of published paragraphs per journal and section, shipped with the
skill: rules describe a style, examples show it.

Only CC BY papers from the training split are used, and only from the half
of the training papers that never serves as judges' calibration (see
`is_exemplar_paper`), so the writer and the judge never see the same text.
Each example carries its attribution.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from statistics import median

from .corpus import JOURNALS, SECTIONS, load
from .prompts import SECTION_FILE, SECTION_NAMES


def is_exemplar_paper(pmcid: str) -> bool:
    """Training papers split in two: one half supplies the skill's examples, the other the judges' calibration."""
    return int(hashlib.sha256(f"exemplar:{pmcid}".encode()).hexdigest(), 16) % 2 == 0


def licenses(data_dir: Path, journal: str) -> dict[str, str]:
    path = data_dir / "records" / f"{journal}.json"
    if not path.exists():
        return {}
    return {r["pmcid"]: (r.get("license") or "").lower() for r in json.loads(path.read_text())}


def build(data_dir: Path, skill_dir: Path, journals: list[str], per_section: int = 6) -> list[Path]:
    written: list[Path] = []
    for journal in journals:
        license_of = licenses(data_dir, journal)
        pool = [p for p in load(data_dir, [journal]) if p.split == "train" and is_exemplar_paper(p.pmcid) and license_of.get(p.pmcid) == "cc by"]
        out_dir = skill_dir / "examples" / journal
        out_dir.mkdir(parents=True, exist_ok=True)
        for section in SECTIONS:
            candidates = [p for p in pool if p.section == section]
            if not candidates:
                continue
            typical = median(p.words for p in candidates)
            # Typical-length paragraphs, one per paper, spread over papers.
            candidates.sort(key=lambda p: (abs(p.words - typical), p.id))
            chosen, papers = [], set()
            for p in candidates:
                if p.pmcid in papers:
                    continue
                chosen.append(p)
                papers.add(p.pmcid)
                if len(chosen) == per_section:
                    break
            name = JOURNALS[journal].name
            lines = [f"# {name}: published {SECTION_NAMES[section]} paragraphs", "",
                     f"Paragraphs from {name} research articles, reproduced under CC BY 4.0 with attribution. "
                     "Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; "
                     "never copy their wording into a new paragraph.", ""]
            for i, p in enumerate(chosen, 1):
                lines += [f"## Example {i}", "", p.text, "", f"Source: \"{p.title}\", {name} ({p.year}), {p.pmcid}, CC BY 4.0.", ""]
            path = out_dir / f"{SECTION_FILE[section]}.md"
            path.write_text("\n".join(lines))
            written.append(path)
    return written


def build_bank(data_dir: Path, skill_dir: Path, journals: list[str]) -> list[Path]:
    """Every paragraph of the CC BY exemplar papers (train split only, never a dev or test paper), for
    scripts/find_examples.py: examples/<journal>/bank.jsonl."""
    written: list[Path] = []
    for journal in journals:
        license_of = licenses(data_dir, journal)
        pool = [p for p in load(data_dir, [journal]) if p.split == "train" and is_exemplar_paper(p.pmcid) and license_of.get(p.pmcid) == "cc by"]
        name = JOURNALS[journal].name
        out = skill_dir / "examples" / journal / "bank.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        rows = [{"section": p.section, "paper": p.pmcid, "text": p.text, "source": f"\"{p.title}\", {name} ({p.year}), {p.pmcid}, CC BY 4.0."}
                for p in sorted(pool, key=lambda p: p.id)]
        out.write_text("".join(json.dumps(row) + "\n" for row in rows))
        written.append(out)
    return written
