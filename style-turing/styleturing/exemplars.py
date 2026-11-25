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
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from statistics import median

from .corpus import API, JOURNALS, SECTIONS, Paragraph, _get, extract, load, search, split_for
from .prompts import SECTION_FILE, SECTION_NAMES


def is_exemplar_paper(pmcid: str) -> bool:
    """Training papers split in two: one half supplies the skill's examples, the other the judges' calibration."""
    return int(hashlib.sha256(f"exemplar:{pmcid}".encode()).hexdigest(), 16) % 2 == 0


def licenses(data_dir: Path, journal: str) -> dict[str, str]:
    path = data_dir / "records" / f"{journal}.json"
    if not path.exists():
        return {}
    return {r["pmcid"]: (r.get("license") or "").lower() for r in json.loads(path.read_text())}


def build_pool(data_dir: Path, journals: list[str], papers: int, years: tuple[int, int] = (2018, 2025), log=print) -> list[Path]:
    """More example papers than the benchmark corpus holds: CC BY papers that can never be a dev or test item or
    a judge's calibration paper (training split, exemplar half). data/exemplar-pool/<journal>.jsonl."""
    out_dir = data_dir / "exemplar-pool"
    out_dir.mkdir(parents=True, exist_ok=True)
    xml_dir = data_dir / "xml"
    xml_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for key in journals:
        journal = JOURNALS[key]
        records = [r for r in search(journal, years, papers * 12)
                   if split_for(r["pmcid"]) == "train" and is_exemplar_paper(r["pmcid"]) and (r.get("license") or "").lower() == "cc by"]
        log(f"{journal.name}: {len(records)} eligible papers")

        def fetch(record: dict) -> list[Paragraph]:
            path = xml_dir / f"{record['pmcid']}.xml"
            if not path.exists():
                try:
                    path.write_bytes(_get(f"{API}/{record['pmcid']}/fullTextXML"))
                except RuntimeError:
                    return []
            try:
                return extract(path.read_bytes(), record, journal)
            except ET.ParseError:
                return []

        kept: list[Paragraph] = []
        count = 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            for start in range(0, len(records), 24):
                if count >= papers:
                    break
                for paragraphs in pool.map(fetch, records[start:start + 24]):
                    if count >= papers or len(paragraphs) < 6 or not ({"results", "discussion"} & {p.section for p in paragraphs}):
                        continue
                    kept.extend(paragraphs)
                    count += 1
                log(f"  {count}/{papers} papers")
        path = out_dir / f"{key}.jsonl"
        path.write_text("".join(json.dumps(asdict(p), ensure_ascii=False) + "\n" for p in kept))
        log(f"  kept {count} papers, {len(kept)} paragraphs")
        written.append(path)
    return written


def exemplar_paragraphs(data_dir: Path, journal: str) -> list[Paragraph]:
    """Paragraphs the skill may show as examples: CC BY exemplar-half training papers of the corpus, plus the
    exemplar pool when one was built."""
    license_of = licenses(data_dir, journal)
    found = {p.id: p for p in load(data_dir, [journal]) if p.split == "train" and is_exemplar_paper(p.pmcid) and license_of.get(p.pmcid) == "cc by"}
    pool = data_dir / "exemplar-pool" / f"{journal}.jsonl"
    if pool.exists():
        for line in pool.read_text().splitlines():
            if line.strip():
                p = Paragraph(**json.loads(line))
                found.setdefault(p.id, p)
    return list(found.values())


def build(data_dir: Path, skill_dir: Path, journals: list[str], per_section: int = 6) -> list[Path]:
    written: list[Path] = []
    for journal in journals:
        pool = exemplar_paragraphs(data_dir, journal)
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
        pool = exemplar_paragraphs(data_dir, journal)
        name = JOURNALS[journal].name
        out = skill_dir / "examples" / journal / "bank.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        rows = [{"section": p.section, "paper": p.pmcid, "text": p.text, "source": f"\"{p.title}\", {name} ({p.year}), {p.pmcid}, CC BY 4.0."}
                for p in sorted(pool, key=lambda p: p.id)]
        out.write_text("".join(json.dumps(row) + "\n" for row in rows))
        written.append(out)
    return written
