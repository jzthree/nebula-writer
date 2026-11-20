"""Real paragraphs from each journal, from Europe PMC full texts (JATS XML).

Papers are split train/dev/test by a hash of their PMCID, so every paragraph
of a paper lands in the same split: the skill is written from train, tuned
on dev, and judged once on test.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

API = "https://www.ebi.ac.uk/europepmc/webservices/rest"


@dataclass(frozen=True)
class Journal:
    key: str
    name: str
    issn: str
    open_access_only: bool  # only open-access full texts can be downloaded as XML


JOURNALS: dict[str, Journal] = {
    j.key: j
    for j in [
        Journal("nature", "Nature", "0028-0836", True),
        Journal("science", "Science", "0036-8075", True),
        Journal("nature-genetics", "Nature Genetics", "1061-4036", True),
        Journal("nature-methods", "Nature Methods", "1548-7091", True),
    ]
}

SECTIONS = ("abstract", "intro", "results", "discussion", "methods")
MIN_WORDS, MAX_WORDS = 70, 260


@dataclass
class Paragraph:
    id: str
    journal: str
    pmcid: str
    title: str
    year: int
    section: str
    index: int  # position among the paper's kept paragraphs
    text: str
    words: int
    split: str
    author_manuscript: bool


def split_for(pmcid: str) -> str:
    bucket = int(hashlib.sha256(pmcid.encode()).hexdigest(), 16) % 10
    return "train" if bucket < 4 else "dev" if bucket < 7 else "test"


def _get(url: str, retries: int = 4, timeout: int = 90) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "style-turing/0.1 (research corpus builder)"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except Exception as error:  # network hiccups and 5xx from Europe PMC
            last = error
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def search(journal: Journal, years: tuple[int, int], limit: int) -> list[dict]:
    query = f"ISSN:{journal.issn} AND HAS_FT:y AND PUB_YEAR:[{years[0]} TO {years[1]}]"
    if journal.open_access_only:
        query += " AND OPEN_ACCESS:y"
    results: list[dict] = []
    cursor = "*"
    while len(results) < limit:
        params = urllib.parse.urlencode({"query": query, "format": "json", "pageSize": 100, "resultType": "core", "cursorMark": cursor})
        page = json.loads(_get(f"{API}/search?{params}"))
        batch = page.get("resultList", {}).get("result", [])
        if not batch:
            break
        results.extend(r for r in batch if r.get("pmcid"))
        next_cursor = page.get("nextCursorMark")
        if not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
    return results


# ---------------------------------------------------------------- JATS text

CITE_OPEN, CITE_CLOSE = "\x01", "\x02"
SKIP_TAGS = {"disp-formula", "inline-formula", "table-wrap", "fig", "list", "tex-math", "mml:math", "math", "supplementary-material", "graphic"}


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _render(element: ET.Element, out: list[str]) -> bool:
    """Append the element's text; False when it holds something a paragraph can't carry (formula, table)."""
    tag = _local(element.tag)
    if tag in SKIP_TAGS:
        return False
    ok = True
    if tag == "xref" and element.get("ref-type") == "bibr":
        out.append(CITE_OPEN + "".join(element.itertext()).strip() + CITE_CLOSE)
    else:
        if tag == "sup" and not any(_local(c.tag) == "xref" for c in element):
            out.append("^")
        if element.text:
            out.append(element.text)
        for child in element:
            ok = _render(child, out) and ok
    if element.tail:
        out.append(element.tail)
    return ok


_ONE = CITE_OPEN + r"[^" + CITE_CLOSE + r"]*" + CITE_CLOSE
_GROUP = _ONE + r"(?:\s*[,–\-;]\s*" + _ONE + r")*"
CITATION_GROUP = re.compile(r"\(\s*" + _GROUP + r"\s*\)|\[\s*" + _GROUP + r"\s*\]|" + _GROUP)


def _citations(text: str) -> str:
    """Every citation group, superscript or parenthesised, becomes one neutral [n] marker."""

    def group(match: re.Match[str]) -> str:
        inner = match.group(0)
        refs = re.findall(CITE_OPEN + r"([^" + CITE_CLOSE + r"]*)" + CITE_CLOSE, inner)
        seps = re.findall(CITE_CLOSE + r"\s*([,–\-;])\s*" + CITE_OPEN, inner)
        parts = [refs[0]]
        for sep, ref in zip(seps, refs[1:]):
            parts.append(("–" if sep in "–-" else ",") + ref)
        return "[" + "".join(parts).replace(" ", "") + "]"

    text = CITATION_GROUP.sub(group, text)
    return text.replace(CITE_OPEN, "").replace(CITE_CLOSE, "")


def paragraph_text(p: ET.Element) -> str | None:
    pieces: list[str] = []
    tail, p.tail = p.tail, None
    ok = True
    if p.text:
        pieces.append(p.text)
    for child in p:
        ok = _render(child, pieces) and ok
    p.tail = tail
    if not ok:
        return None
    text = _citations("".join(pieces))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:)])", r"\1", text)
    text = text.replace("( ", "(")
    return text or None


EXCLUDED = ("supplement", "data availability", "code availability", "acknowledg", "author contribution", "competing", "reporting summary", "online content", "references", "extended data", "funding", "additional information", "ethics", "declaration")


def _excluded(title: str) -> bool:
    t = title.strip().lower()
    return any(k in t for k in EXCLUDED)


def classify(title: str, sec_type: str | None, position: int) -> str | None:
    """The section a heading names, or None when it names none of ours (or is back matter)."""
    t = (title or "").strip().lower()
    s = (sec_type or "").lower()
    if _excluded(t):
        return None
    if "method" in t or "methods" in s or "materials" in t:
        return "methods"
    if "discussion" in t or "discussion" in s or "conclusion" in t:
        return "discussion"
    if "result" in t or "results" in s:
        return "results"
    if t in ("main", "introduction") or "intro" in s or (t == "" and position == 0):
        return "intro"
    return None


def is_legend(text: str) -> bool:
    """A figure legend that sits in the body as a paragraph ("a, Schematic of … b, …", "(A) Front view …")."""
    if re.match(r"^(?:[a-zA-Z],|\(?[A-Za-z]\))\s", text) or "Scale bar" in text:
        return True
    panels = re.findall(r"(?:^|[.;]\s)(?:[a-z],|\(?[A-Za-z]\))\s", text)
    return len(panels) >= 2


def extract(xml: bytes, record: dict, journal: Journal) -> list[Paragraph]:
    root = ET.fromstring(xml)
    if (root.get("article-type") or "research-article") != "research-article":
        return []
    pmcid = record["pmcid"]
    title = re.sub(r"\s+", " ", "".join(root.find(".//article-meta/title-group/article-title").itertext())).strip() if root.find(".//article-meta/title-group/article-title") is not None else record.get("title", "")
    year = int(record.get("pubYear") or 0)
    manuscript = record.get("authMan") == "Y"
    found: list[tuple[str, str]] = []
    abstract = root.find(".//article-meta/abstract")
    if abstract is not None and abstract.get("abstract-type") in (None, "summary"):
        for p in abstract.iter("p"):
            text = paragraph_text(p)
            if text:
                found.append(("abstract", text))
    body = root.find("body")
    if body is None:
        return []

    def take(element: ET.Element, kind: str) -> None:
        for p in element.iter("p"):
            text = paragraph_text(p)
            if text:
                found.append((kind, text))

    def walk_main(sec: ET.Element) -> None:
        # Nature-style "Main": its own paragraphs are the introduction, its
        # subsections (topical headings) are the Results unless named otherwise.
        for child in sec:
            tag = _local(child.tag)
            if tag == "p":
                take(child, "intro")
            elif tag == "sec":
                named = classify(child.findtext("title") or "", child.get("sec-type"), 1)
                if named in ("discussion", "methods", "results"):
                    take(child, named)
                elif named is None and _excluded(child.findtext("title") or ""):
                    continue
                else:
                    take(child, "results")

    seen_end = False  # after Discussion or Methods, unnamed sections are back matter
    for index, child in enumerate(body):
        tag = _local(child.tag)
        if tag == "p":
            take(child, "intro")  # an unlabelled opening (Science, some Nature papers)
            continue
        if tag != "sec":
            continue
        heading = child.findtext("title") or ""
        if heading.strip().lower() in ("main", "introduction") or (index == 0 and not heading.strip()):
            walk_main(child)
            continue
        kind = classify(heading, child.get("sec-type"), 1)
        if kind in ("discussion", "methods"):
            seen_end = True
        if kind is None and not _excluded(heading) and not seen_end:
            kind = "results"  # a topical Results heading
        if kind:
            take(child, kind)
    kept = [(kind, text) for kind, text in found if MIN_WORDS <= len(text.split()) <= MAX_WORDS and not is_legend(text)]
    split = split_for(pmcid)
    return [
        Paragraph(f"{journal.key}:{pmcid}:{i}", journal.key, pmcid, title, year, kind, i, text, len(text.split()), split, manuscript)
        for i, (kind, text) in enumerate(kept)
    ]


def build(data_dir: Path, journal_keys: list[str], papers: int, years: tuple[int, int], log=print) -> None:
    xml_dir = data_dir / "xml"
    xml_dir.mkdir(parents=True, exist_ok=True)
    out_dir = data_dir / "corpus"
    out_dir.mkdir(parents=True, exist_ok=True)
    for key in journal_keys:
        journal = JOURNALS[key]
        records_path = data_dir / "records" / f"{key}.json"
        if records_path.exists():
            records = json.loads(records_path.read_text())
        else:
            records = search(journal, years, papers * 3)
            records_path.parent.mkdir(parents=True, exist_ok=True)
            records_path.write_text(json.dumps(records))
        log(f"{journal.name}: {len(records)} candidate papers")
        kept: list[Paragraph] = []
        papers_kept = 0

        def fetch(record: dict) -> Path | None:
            path = xml_dir / f"{record['pmcid']}.xml"
            if not path.exists():
                try:
                    path.write_bytes(_get(f"{API}/{record['pmcid']}/fullTextXML"))
                except RuntimeError as error:
                    log(f"  skip {record['pmcid']}: {error}")
                    return None
            return path

        batch_size = max(12, papers // 2)
        for start in range(0, len(records), batch_size):
            if papers_kept >= papers:
                break
            batch = records[start:start + batch_size]
            with ThreadPoolExecutor(max_workers=6) as pool:
                paths = list(pool.map(fetch, batch))
            for record, path in zip(batch, paths):
                if path is None or papers_kept >= papers:
                    continue
                try:
                    paragraphs = extract(path.read_bytes(), record, journal)
                except ET.ParseError:
                    continue
                sections = {p.section for p in paragraphs}
                if len(paragraphs) < 6 or not ({"results", "discussion"} & sections):
                    continue
                kept.extend(paragraphs)
                papers_kept += 1
            log(f"  {papers_kept}/{papers} papers")
        with (out_dir / f"{key}.jsonl").open("w") as handle:
            for paragraph in kept:
                handle.write(json.dumps(asdict(paragraph), ensure_ascii=False) + "\n")
        counts = {s: sum(p.section == s for p in kept) for s in SECTIONS}
        log(f"  kept {papers_kept} papers, {len(kept)} paragraphs {counts}")


def load(data_dir: Path, journal_keys: list[str] | None = None) -> list[Paragraph]:
    paragraphs: list[Paragraph] = []
    for path in sorted((data_dir / "corpus").glob("*.jsonl")):
        if journal_keys and path.stem not in journal_keys:
            continue
        for line in path.read_text().splitlines():
            if line.strip():
                paragraphs.append(Paragraph(**json.loads(line)))
    return paragraphs
