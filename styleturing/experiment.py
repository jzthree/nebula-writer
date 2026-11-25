"""One run of the test: sample real paragraphs, brief them, regenerate them
under each condition (no skill / a skill version), and have each judge pick
the published one. Everything lands in runs/<name>/ as JSONL.
"""

from __future__ import annotations

import hashlib
import json
import random
import subprocess
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

from . import prompts
from .corpus import JOURNALS, SECTIONS, Paragraph, load
from .llm import Client, LLMError, Model


@dataclass
class Condition:
    name: str  # "baseline" or a skill label
    skill_dir: Path | None = None

    @staticmethod
    def parse(spec: str) -> "Condition":
        """'baseline', or 'skill=skills/journal-style', or 'v2=path/to/skill'."""
        if spec == "baseline":
            return Condition("baseline")
        name, _, path = spec.partition("=")
        if not path:
            path, name = name, Path(name).name
        return Condition(name, Path(path))

    def system(self, journal_key: str, section: str | None = None, query: str | None = None) -> str:
        if self.skill_dir is None:
            return prompts.BASELINE_SYSTEM
        return prompts.skill_system(self.skill_dir, journal_key, section, query)

    def fingerprint(self) -> str:
        """Which exact skill text was tested, so a report says what it measured."""
        if self.skill_dir is None:
            return "baseline"
        digest = hashlib.sha256()
        for path in sorted(q for pattern in ("*.md", "*.py", "*.jsonl") for q in self.skill_dir.rglob(pattern)):
            digest.update(path.read_bytes())
        return digest.hexdigest()[:12]


@dataclass
class RunConfig:
    name: str
    journals: list[str]
    split: str
    per_journal: int
    sections: list[str]
    conditions: list[Condition]
    generator: Model
    briefer: Model
    judges: list[Model]
    references: int = 3
    mode: str = "both"  # paired | single | both
    seed: int = 7
    workers: int = 6
    out_dir: Path = Path("runs")
    data_dir: Path = Path("data")
    extra: dict = field(default_factory=dict)


def _stable(*parts: str) -> int:
    return int(hashlib.sha256("|".join(parts).encode()).hexdigest(), 16)


def sample(paragraphs: list[Paragraph], journal: str, split: str, n: int, sections: list[str], seed: int) -> list[Paragraph]:
    """n paragraphs from distinct papers where possible, spread across sections."""
    rng = random.Random(f"{seed}:{journal}:{split}")
    pool = [p for p in paragraphs if p.journal == journal and p.split == split and p.section in sections]
    by_section: dict[str, list[Paragraph]] = defaultdict(list)
    for p in pool:
        by_section[p.section].append(p)
    for items in by_section.values():
        rng.shuffle(items)
    chosen: list[Paragraph] = []
    used_papers: set[str] = set()
    order = [s for s in sections if by_section.get(s)]
    # Round-robin over sections, preferring papers not used yet.
    while len(chosen) < n and any(by_section[s] for s in order):
        for section in order:
            if len(chosen) >= n or not by_section[section]:
                continue
            items = by_section[section]
            pick = next((p for p in items if p.pmcid not in used_papers), items[0])
            items.remove(pick)
            chosen.append(pick)
            used_papers.add(pick.pmcid)
    return chosen


def references_for(paragraphs: list[Paragraph], item: Paragraph, k: int) -> list[str]:
    """k published paragraphs from the same journal and section, from training papers only."""
    if k <= 0:
        return []
    from .exemplars import is_exemplar_paper

    # The other half of the training papers: the skill's examples never reach a judge.
    pool = [p for p in paragraphs if p.journal == item.journal and p.section == item.section and p.split == "train" and p.pmcid != item.pmcid and not is_exemplar_paper(p.pmcid)]
    pool.sort(key=lambda p: _stable(item.id, p.id))
    return [p.text for p in pool[:k]]


class Runner:
    def __init__(self, config: RunConfig, log=print):
        self.config = config
        self.log = log
        self.dir = config.out_dir / config.name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.client = Client(config.data_dir / "cache")
        self.lock = threading.Lock()

    def _parallel(self, label: str, jobs: list, fn) -> list:
        results: list = [None] * len(jobs)
        done = 0
        with ThreadPoolExecutor(max_workers=self.config.workers) as pool:
            futures = {pool.submit(fn, job): index for index, job in enumerate(jobs)}
            for future in as_completed(futures):
                index = futures[future]
                try:
                    results[index] = future.result()
                except LLMError as error:
                    self.log(f"  {label}: one call failed and is left out: {error}")
                done += 1
                if done % 10 == 0 or done == len(jobs):
                    self.log(f"  {label}: {done}/{len(jobs)}")
        return results

    def run(self) -> Path:
        cfg = self.config
        corpus = load(cfg.data_dir, cfg.journals)
        excluded = set(cfg.extra.get("exclude", []))
        if excluded:
            corpus = [p for p in corpus if p.id not in excluded]
        items: list[Paragraph] = []
        for journal in cfg.journals:
            picked = sample(corpus, journal, cfg.split, cfg.per_journal, [s for s in cfg.sections if s in JOURNALS[journal].sections] or list(JOURNALS[journal].sections), cfg.seed)
            if len(picked) < cfg.per_journal:
                self.log(f"{journal}: only {len(picked)} paragraphs available in {cfg.split}")
            items.extend(picked)
        self._write_config(items)
        self.log(f"{len(items)} paragraphs; conditions {[c.name for c in cfg.conditions]}; judges {[j.label for j in cfg.judges]}")

        briefs = self._parallel("briefs", items, lambda p: self.client.complete_json(cfg.briefer, prompts.BRIEF_SYSTEM, prompts.brief_prompt(p.text)))
        live = [(p, b) for p, b in zip(items, briefs) if b and b.get("points")]
        self._dump("briefs.jsonl", [{"id": p.id, "brief": b} for p, b in live])

        gen_jobs = [(condition, p, b) for condition in cfg.conditions for p, b in live]

        def generate(job):
            condition, p, b = job
            notes = (b.get("function", "") + "\n" + "\n".join(map(str, b.get("points", [])))).strip()
            text = self.client.complete(cfg.generator, condition.system(p.journal, p.section, notes), prompts.generate_prompt(p.journal, p.title, p.section, p.words, b, p.pmcid))
            return {"id": p.id, "condition": condition.name, "text": text.strip()}

        generations = [g for g in self._parallel("generations", gen_jobs, generate) if g and g["text"]]
        self._dump("generations.jsonl", generations)

        by_id = {p.id: p for p in items}
        judge_jobs = [(judge, g) for judge in cfg.judges for g in generations]

        def judge(job):
            model, g = job
            p = by_id[g["id"]]
            real_first = _stable(p.id, g["condition"], model.label) % 2 == 0
            real, fake = prompts.plain(p.text), prompts.plain(g["text"])
            first, second = (real, fake) if real_first else (fake, real)
            references = [prompts.plain(text) for text in references_for(corpus, p, cfg.references)]
            answer = self.client.complete_json(model, prompts.judge_system(p.journal), prompts.judge_prompt(p.journal, p.title, p.section, first, second, references, p.pmcid))
            picked = str(answer.get("published", "")).strip().upper()[:1]
            try:
                confidence = float(answer.get("confidence", 0.5))
            except (TypeError, ValueError):
                confidence = 0.5
            return {
                "id": p.id, "journal": p.journal, "section": p.section, "condition": g["condition"], "judge": model.label,
                "real_position": "A" if real_first else "B", "picked": picked,
                "correct": picked == ("A" if real_first else "B"),
                "confidence": max(0.5, min(1.0, confidence)),
                "tells": [str(t) for t in answer.get("tells", [])][:6],
            }

        judgments: list[dict] = []
        if cfg.mode in ("paired", "both"):
            judgments = [j for j in self._parallel("paired judgments", judge_jobs, judge) if j and j["picked"] in ("A", "B")]
        self._dump("judgments.jsonl", judgments)

        def single(job):
            model, kind, p, condition, text = job
            references = [prompts.plain(t) for t in references_for(corpus, p, cfg.references)]
            answer = self.client.complete_json(model, prompts.judge_system(p.journal), prompts.single_judge_prompt(p.journal, p.title, p.section, prompts.plain(text), references, p.pmcid))
            try:
                probability = float(answer.get("published_probability"))
            except (TypeError, ValueError):
                return None
            return {"id": p.id, "journal": p.journal, "section": p.section, "judge": model.label, "kind": kind, "condition": condition,
                    "probability": max(0.0, min(1.0, probability)), "tells": [str(t) for t in answer.get("tells", [])][:6]}

        singles: list[dict] = []
        if cfg.mode in ("single", "both"):
            single_jobs = [(model, "published", by_id[i], None, by_id[i].text) for model in cfg.judges for i in {g["id"] for g in generations}]
            single_jobs += [(model, "generated", by_id[g["id"]], g["condition"], g["text"]) for model in cfg.judges for g in generations]
            singles = [s for s in self._parallel("single judgments", single_jobs, single) if s]
        self._dump("singles.jsonl", singles)
        from .report import write_report
        return write_report(self.dir, cfg.data_dir)

    def _write_config(self, items: list[Paragraph]) -> None:
        cfg = self.config
        try:
            commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
        except OSError:
            commit = ""
        (self.dir / "config.json").write_text(json.dumps({
            "name": cfg.name, "journals": cfg.journals, "split": cfg.split, "per_journal": cfg.per_journal,
            "sections": cfg.sections, "seed": cfg.seed, "references": cfg.references, "mode": cfg.mode,
            "conditions": [{"name": c.name, "skill": str(c.skill_dir) if c.skill_dir else None, "fingerprint": c.fingerprint()} for c in cfg.conditions],
            "generator": cfg.generator.label, "briefer": cfg.briefer.label, "judges": [j.label for j in cfg.judges],
            "commit": commit, **cfg.extra,
        }, indent=2))
        self._dump("items.jsonl", [{"id": p.id, "journal": p.journal, "section": p.section, "title": p.title, "text": p.text, "words": p.words} for p in items])

    def _dump(self, name: str, rows: list[dict]) -> None:
        with (self.dir / name).open("w") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


__all__ = ["Condition", "RunConfig", "Runner", "sample", "references_for", "read_jsonl", "SECTIONS"]
