"""Funded NIH grant text for the benchmark: Project Summaries and Project
Narratives of new awards, from the NIH RePORTER API (api.reporter.nih.gov).

RePORTER states no license for the abstract text, so it stays in data/
(local, git-ignored): it is what the grant benchmark tests on and what the
grant reference file is measured from, never shipped with the skill.

Each project is one "paper": its core project number decides the split, the
same hash as for journal papers, so train/dev/test never share a project.
"""

from __future__ import annotations

import json
import re
import socket
import time
import urllib.request
from dataclasses import asdict
from pathlib import Path

from .corpus import Paragraph, split_for

API = "https://api.reporter.nih.gov/v2/projects/search"
KEY = "nih"
ACTIVITY_CODES = ("R01", "R21", "R03", "R35", "K99", "K08", "K01", "K23", "F31", "F32")
# A Project Summary paragraph can run long (the whole summary is often one paragraph); a narrative is 2-3 sentences.
WORDS = {"summary": (70, 450), "narrative": (25, 160)}
HEADER = re.compile(
    r"^\s*(project\s+summary\s*/\s*abstract|project\s+summary|summary/abstract|abstract|description\s*\(provided by applicant\)|"
    r"project\s+narrative|public\s+health\s+relevance(\s+statement)?|narrative|relevance)\s*[:.\-–—]*\s*",
    re.I,
)


def _ipv4_first() -> None:
    """RePORTER publishes IPv6 addresses that may not answer; a connection then waits a minute before IPv4."""
    if getattr(socket, "_styleturing_ipv4_first", False):
        return
    original = socket.getaddrinfo

    def getaddrinfo(*args, **kwargs):
        return sorted(original(*args, **kwargs), key=lambda info: info[0] != socket.AF_INET)

    socket.getaddrinfo = getaddrinfo
    socket._styleturing_ipv4_first = True


def _post(body: dict, retries: int = 4) -> dict:
    _ipv4_first()
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(API, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "style-turing/0.1 (research corpus builder)"})
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read())
        except Exception as error:  # 5xx and rate limiting
            last = error
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"RePORTER search failed: {last}")


def search(code: str, years: tuple[int, int], limit: int) -> list[dict]:
    """New awards (type 1) of one activity code, one record per project."""
    rows: list[dict] = []
    offset = 0
    while len(rows) < limit:
        body = {
            "criteria": {"activity_codes": [code], "fiscal_years": list(range(years[0], years[1] + 1)), "is_new": True},
            "include_fields": ["ApplId", "CoreProjectNum", "ProjectTitle", "AbstractText", "PhrText", "ActivityCode", "FiscalYear", "AgencyIcAdmin"],
            "offset": offset,
            "limit": min(500, limit - len(rows)),
        }
        batch = _post(body).get("results", [])
        if not batch:
            break
        rows.extend(batch)
        offset += len(batch)
        time.sleep(1)  # RePORTER asks for no more than one request per second
    return rows


def paragraphs_of(text: str) -> list[str]:
    """RePORTER text is hard-wrapped: blank lines or an indented line start a paragraph; other line breaks are wraps."""
    text = text.replace("\r", "")
    blocks = re.split(r"\n\s*\n|\n(?=[ \t]+\S)", text)
    out = []
    for block in blocks:
        joined = re.sub(r"(\w)-\n(\w)", r"\1\2", block.strip())
        joined = re.sub(r"\s*\n\s*", " ", joined)
        joined = HEADER.sub("", joined, count=1).strip()
        joined = re.sub(r"\s{2,}", " ", joined)
        if joined:
            out.append(joined)
    return out


def to_paragraphs(record: dict) -> list[Paragraph]:
    core = record.get("core_project_num") or str(record.get("appl_id"))
    title = (record.get("project_title") or "").strip()
    out: list[Paragraph] = []
    index = 0
    for section, field in (("summary", "abstract_text"), ("narrative", "phr_text")):
        low, high = WORDS[section]
        for text in paragraphs_of(record.get(field) or ""):
            words = len(text.split())
            if low <= words <= high:
                out.append(Paragraph(f"{KEY}:{core}:{index}", KEY, core, title, int(record.get("fiscal_year") or 0), section, index, text, words, split_for(core), False))
            index += 1
    return out


def build(data_dir: Path, per_code: int = 300, years: tuple[int, int] = (2019, 2024), log=print) -> Path:
    records: list[dict] = []
    seen: set[str] = set()
    for code in ACTIVITY_CODES:
        found = search(code, years, per_code)
        fresh = [r for r in found if (r.get("core_project_num") or r.get("appl_id")) not in seen]
        seen.update(r.get("core_project_num") or r.get("appl_id") for r in fresh)
        records.extend(fresh)
        log(f"{code}: {len(fresh)} projects")
    (data_dir / "records").mkdir(parents=True, exist_ok=True)
    (data_dir / "records" / f"{KEY}.json").write_text(json.dumps(records))
    kept = [p for r in records for p in to_paragraphs(r)]
    out = data_dir / "corpus" / f"{KEY}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(asdict(p), ensure_ascii=False) + "\n" for p in kept))
    counts = {s: sum(p.section == s for p in kept) for s in WORDS}
    log(f"kept {len(kept)} paragraphs from {len(records)} projects {counts}")
    return out
