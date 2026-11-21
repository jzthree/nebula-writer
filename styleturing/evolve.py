"""Iterative improvement of the skill against the benchmark.

Each round:
1. A proposer reads the incumbent skill and the evidence from the last round
   (what gave its paragraphs away, measured drift, and the ideas already
   tried with their outcomes) and proposes a few small, single-idea edits.
2. The incumbent and every candidate write paragraphs for the same fresh dev
   items, never used in an earlier round, and both judges score them in both
   modes.
3. A candidate replaces the incumbent only if it beats it on the same items
   with high bootstrap confidence. Everything else is logged as tried.

The test split is never touched here.
"""

from __future__ import annotations

import json
import random
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from statistics import mean

from .corpus import JOURNALS
from .experiment import Condition, RunConfig, Runner, read_jsonl
from .improve import copied_wording, profile
from .llm import Client, Model
from .stylometry import compare, features

PROPOSER_SYSTEM = """You improve a writing skill that helps scientists write manuscript paragraphs in the house style of specific journals (Nature, Science, Nature Genetics, Nature Methods). The skill is measured on a benchmark: a writer model uses the skill to write a paragraph from notes listing a published paragraph's content, and expert readers compare it with the published paragraph, side by side and alone. The goal is paragraphs whose style matches the journal's published prose as closely as possible.

You propose small, independent edits. Each candidate tests ONE idea, so the benchmark can tell which ideas help. A candidate may edit SKILL.md (the general method and workflow, used for every journal) or one or more journal reference files, but should change as little as needed to test its idea.

Rules:
- Each idea must generalize: it describes how the journals write, or how to write, never what a particular paper is about.
- Never quote wording from the evidence paragraphs or the readers' comments: no phrase of three or more words from them. Use short invented illustrations.
- The skill must produce correct, well-edited prose. Never recommend errors (grammar, agreement, spelling, typos, wrong facts) even if published text contains them.
- Do not repeat an idea from the history that was already tried and rejected, unless you change it materially and say how.
- Prefer ideas that address the most frequent reasons the readers gave, and the largest measured drift.
- Phrase rules as how to write a paragraph for the journal (from notes, data or a draft), never as instructions about this benchmark.

Answer with JSON only:
{"candidates": [{"idea": "one sentence: what this changes and why", "edits": [{"file": "SKILL.md or references/<journal>.md", "old": "exact text currently in that file, to be replaced (copy it exactly; empty string to append at the end of the file)", "new": "replacement text"}]}]}"""


CRITIC_SYSTEM = """You are an experienced editor at {journal}. A writer drafted a paragraph from notes listing the content of a paragraph published in {journal}, following a style guide for the journal. You compare the draft with the published paragraph and say how the draft's writing departs from the journal's published style, then how the style guide should change so that writers following it produce paragraphs closer to the journal's published prose.

Rules for your suggestions:
- They must generalize to other papers in {journal}: describe how the journal writes, never what this paper is about.
- Never quote wording from the two paragraphs (no phrase of three or more words); describe patterns, with short invented illustrations if needed.
- The guide must produce correct, well-edited prose: never suggest errors (grammar, agreement, spelling, typos, wrong facts) even where the published text has them.
- Differences that come only from content (a fact the notes lacked) are not style; leave them out.
- Point at the guide: say which rule is missing, wrong or ignored, and what it should say instead.

Answer with JSON only:
{{"differences": ["specific ways the draft's writing departs from the published style, most important first"], "suggestions": [{{"file": "SKILL.md or references/<journal>.md", "change": "the rule to add, or how to change an existing rule (quote the guide's current wording when changing it)", "why": "which difference it fixes"}}]}}"""


def critic_prompt(guide: str, section: str, published: str, draft: str, tells: list[str]) -> str:
    noted = "".join(f"\n- {t}" for t in tells) or "\n- (none recorded)"
    return (
        f"The style guide the writer followed:\n<<<\n{guide}\n>>>\n\n"
        f"Section: {section}\n\nPublished paragraph:\n<<<\n{published}\n>>>\n\nDraft:\n<<<\n{draft}\n>>>\n\n"
        f"What readers noted when they told the two apart:{noted}"
    )


def textual_gradients(run_dir: Path, condition: str, skill_dir: Path, critics: list[Model], data_dir: Path, limit: int = 48, workers: int = 10, log=print) -> list[dict]:
    """TextGrad's backward pass: for paragraphs where the condition's draft was told apart from the published one,
    a critic explains the difference and suggests how the guide should change. Critics alternate across items."""
    from concurrent.futures import ThreadPoolExecutor

    from .llm import LLMError

    items = {i["id"]: i for i in read_jsonl(run_dir / "items.jsonl")}
    generations = {(g["id"], g["condition"]): g["text"] for g in read_jsonl(run_dir / "generations.jsonl")}
    tells: dict[str, list[str]] = {}
    caught: dict[str, float] = {}
    for j in read_jsonl(run_dir / "judgments.jsonl"):
        if j["condition"] == condition and j["correct"]:
            tells.setdefault(j["id"], []).extend(j["tells"])
            caught[j["id"]] = caught.get(j["id"], 0.0) + j["confidence"]
    for s in read_jsonl(run_dir / "singles.jsonl"):
        if s["kind"] == "generated" and s["condition"] == condition and s["probability"] < 0.5:
            tells.setdefault(s["id"], []).extend(s["tells"])
            caught[s["id"]] = caught.get(s["id"], 0.0) + (0.5 - s["probability"])
    # The most confidently caught first, spread over journals.
    ranked = sorted((i for i in caught if (i, condition) in generations), key=lambda i: -caught[i])
    by_journal: dict[str, list[str]] = {}
    for i in ranked:
        by_journal.setdefault(items[i]["journal"], []).append(i)
    chosen: list[str] = []
    while len(chosen) < limit and any(by_journal.values()):
        for queue in by_journal.values():
            if queue and len(chosen) < limit:
                chosen.append(queue.pop(0))
    client = Client(data_dir / "cache")

    def backward(job):
        index, item_id = job
        item = items[item_id]
        critic = critics[index % len(critics)]
        files = _skill_files(skill_dir)
        reference = f"references/{item['journal']}.md"
        guide = "\n\n".join(f"=== {name} ===\n{files[name]}" for name in ("SKILL.md", reference) if name in files)
        system = CRITIC_SYSTEM.format(journal=JOURNALS[item["journal"]].name)
        prompt = critic_prompt(guide, item["section"], item["text"], generations[(item_id, condition)], tells.get(item_id, [])[:8])
        try:
            answer = client.complete_json(critic, system, prompt)
        except LLMError as error:
            log(f"  gradient for {item_id} failed: {str(error)[:160]}")
            return None
        if not isinstance(answer, dict):
            return None
        return {"id": item_id, "journal": item["journal"], "section": item["section"], "critic": critic.label,
                "differences": [str(d) for d in answer.get("differences") or []][:6],
                "suggestions": [s for s in answer.get("suggestions") or [] if isinstance(s, dict)][:5]}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        out = [g for g in pool.map(backward, list(enumerate(chosen))) if g]
    log(f"  textual gradients: {len(out)} of {len(chosen)} caught paragraphs")
    return out


def format_gradients(gradients: list[dict]) -> str:
    blocks = []
    for n, g in enumerate(gradients, 1):
        lines = [f"[{n}] {JOURNALS[g['journal']].name}, {g['section']} (critic: {g['critic']})", "Differences:"]
        lines += [f"  - {d}" for d in g["differences"]]
        lines.append("Suggested guide changes:")
        lines += [f"  - ({s.get('file', '?')}) {s.get('change', '')} [fixes: {s.get('why', '')}]" for s in g["suggestions"]]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


OPTIMIZER_SYSTEM = PROPOSER_SYSTEM.replace(
    "You propose small, independent edits.",
    "You receive per-paragraph feedback from journal editors: for paragraphs where a skill draft was told apart from the published one, how the draft's writing departed from the journal's style and how they would change the guide (textual gradients). Aggregate them: an idea suggested for many paragraphs, by both critics, or across journals is stronger evidence than a one-off; weigh conflicting suggestions. You propose small, independent edits.",
)

@dataclass
class Candidate:
    name: str
    idea: str
    path: Path


def _skill_files(skill_dir: Path) -> dict[str, str]:
    files = {"SKILL.md": (skill_dir / "SKILL.md").read_text()}
    for path in sorted((skill_dir / "references").glob("*.md")):
        files[f"references/{path.name}"] = path.read_text()
    return files


def apply_edits(source: Path, target: Path, edits: list[dict]) -> str | None:
    """Copy the skill and apply edits. Returns an error message, or None when every edit applied."""
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    if not edits:
        return "no edits"
    for edit in edits:
        name = str(edit.get("file", ""))
        if name != "SKILL.md" and not re.fullmatch(r"references/[a-z-]+\.md", name):
            return f"edit to a file the proposer may not change: {name!r}"
        path = target / name
        if not path.exists():
            return f"no such file: {name}"
        text, old, new = path.read_text(), str(edit.get("old", "")), str(edit.get("new", ""))
        if old:
            if text.count(old) != 1:
                return f"text to replace occurs {text.count(old)} times in {name}: {old[:80]!r}"
            text = text.replace(old, new)
        else:
            text = text.rstrip("\n") + "\n\n" + new.strip() + "\n"
        path.write_text(text)
    return None


def evidence(run_dir: Path, condition: str, limit_tells: int = 120) -> str:
    """What gave the incumbent away in a run: tells from both modes, drift per journal, and a few pairs."""
    items = {i["id"]: i for i in read_jsonl(run_dir / "items.jsonl")}
    generations = {(g["id"], g["condition"]): g["text"] for g in read_jsonl(run_dir / "generations.jsonl")}
    judgments = [j for j in read_jsonl(run_dir / "judgments.jsonl") if j["condition"] == condition]
    singles = [s for s in read_jsonl(run_dir / "singles.jsonl") if s["kind"] == "generated" and s["condition"] == condition]
    rng = random.Random(0)
    tells = [f"[{j['journal']}, {j['section']}, side by side] {t}" for j in judgments if j["correct"] for t in j["tells"]]
    tells += [f"[{s['journal']}, {s['section']}, alone, rated {s['probability']:.2f}] {t}" for s in singles if s["probability"] < 0.5 for t in s["tells"]]
    rng.shuffle(tells)

    drift_lines = []
    for journal in sorted({i["journal"] for i in items.values()}):
        pairs = [(items[i]["text"], generations[(i, condition)]) for i in items if items[i]["journal"] == journal and (i, condition) in generations]
        if not pairs:
            continue
        drift = compare([features(a) for a, _ in pairs], [features(b) for _, b in pairs])
        shown = [f"{d['description']}: published {d['real']:.2f}, skill {d['generated']:.2f} ({d['effect']:+.2f} SD)" for d in drift if abs(d["effect"]) >= 0.3][:6]
        if shown:
            drift_lines.append(f"- {JOURNALS[journal].name}: " + "; ".join(shown))

    confident = sorted((j for j in judgments if j["correct"]), key=lambda j: -j["confidence"])
    pairs_shown, seen = [], set()
    for j in confident:
        if j["id"] in seen or (j["id"], condition) not in generations:
            continue
        seen.add(j["id"])
        pairs_shown.append(f"{JOURNALS[j['journal']].name}, {j['section']}\nPublished:\n<<<\n{items[j['id']]['text']}\n>>>\nSkill paragraph:\n<<<\n{generations[(j['id'], condition)]}\n>>>")
        if len(pairs_shown) == 4:
            break
    return (
        f"Reasons the readers gave when they identified the skill's paragraph ({len(tells)} in all, {min(len(tells), limit_tells)} shown, in random order):\n"
        + "\n".join(f"- {t}" for t in tells[:limit_tells])
        + "\n\nMeasured drift of the skill's paragraphs from the published ones:\n" + ("\n".join(drift_lines) or "- none above 0.3 SD")
        + "\n\nPairs the readers got right (evaluation data: do not copy wording):\n\n" + "\n\n".join(pairs_shown)
    )


def item_scores(run_dir: Path, condition: str) -> dict[str, float]:
    """Per item: how detectable the condition's paragraph was, averaged over judges and both modes
    (paired: 1 if the judge picked the published one; single: 1 if the published one was rated higher, 0.5 on ties).
    Lower is better; 0.5 is chance."""
    per: dict[str, list[float]] = {}
    for j in read_jsonl(run_dir / "judgments.jsonl"):
        if j["condition"] == condition:
            per.setdefault(j["id"], []).append(1.0 if j["correct"] else 0.0)
    singles = read_jsonl(run_dir / "singles.jsonl")
    real = {(s["judge"], s["id"]): s["probability"] for s in singles if s["kind"] == "published"}
    for s in singles:
        if s["kind"] == "generated" and s["condition"] == condition and (s["judge"], s["id"]) in real:
            r, g = real[(s["judge"], s["id"])], s["probability"]
            per.setdefault(s["id"], []).append(1.0 if r > g else 0.5 if r == g else 0.0)
    return {i: mean(v) for i, v in per.items() if v}


def compare_conditions(run_dir: Path, incumbent: str, candidate: str, resamples: int = 4000) -> dict:
    """Paired bootstrap over items: probability that the candidate is less detectable than the incumbent."""
    a, b = item_scores(run_dir, incumbent), item_scores(run_dir, candidate)
    ids = sorted(set(a) & set(b))
    diffs = [a[i] - b[i] for i in ids]
    if not diffs:
        return {"n": 0, "incumbent": None, "candidate": None, "gain": 0.0, "p_better": 0.0}
    rng = random.Random(1)
    n = len(diffs)
    wins = sum(1 for _ in range(resamples) if sum(rng.choice(diffs) for _ in range(n)) > 0)
    return {"n": n, "incumbent": mean(a[i] for i in ids), "candidate": mean(b[i] for i in ids), "gain": mean(diffs), "p_better": wins / resamples}


def used_ids(runs_dir: Path) -> set[str]:
    ids: set[str] = set()
    for path in runs_dir.glob("*/items.jsonl"):
        config_path = path.parent / "config.json"
        if config_path.exists() and json.loads(config_path.read_text()).get("split") == "dev":
            ids |= {row["id"] for row in read_jsonl(path)}
    return ids


class Evolver:
    def __init__(self, skill_dir: Path, data_dir: Path, runs_dir: Path, journals: list[str], per_journal: int, candidates: int,
                 proposer: Model, generator: Model, briefer: Model, judges: list[Model], workers: int, threshold: float, log=print,
                 method: str = "textgrad", critics: list[Model] | None = None, gradients: int = 48, retest_threshold: float = 0.85):
        self.skill_dir, self.data_dir, self.runs_dir = skill_dir, data_dir, runs_dir
        self.journals, self.per_journal, self.candidates = journals, per_journal, candidates
        self.proposer, self.generator, self.briefer, self.judges = proposer, generator, briefer, judges
        self.workers, self.threshold, self.log = workers, threshold, log
        # textgrad: per-paragraph critiques (textual gradients) aggregated into edits; propose: one proposer reads the tells.
        self.method, self.critics, self.gradients, self.retest_threshold = method, critics or judges, gradients, retest_threshold
        self.home = runs_dir / "evolve"
        self.home.mkdir(parents=True, exist_ok=True)
        self.history_path = self.home / "history.json"
        self.history: list[dict] = json.loads(self.history_path.read_text()) if self.history_path.exists() else []

    def _save(self) -> None:
        self.history_path.write_text(json.dumps(self.history, indent=2))

    def propose(self, round_no: int, last_run: Path | None, condition: str = "incumbent") -> list[Candidate]:
        files = _skill_files(self.skill_dir)
        tried = "\n".join(f"- round {h['round']}: {h['idea']} -> {h['outcome']}" for h in self.history if h.get("idea")) or "- (none yet)"
        profiles = []
        for journal in self.journals:
            for section, values in profile(self.data_dir, journal).items():
                profiles.append(f"- {JOURNALS[journal].name} {section}: " + ", ".join(f"{k} {values[k]:.2f}" for k in ("words", "sentence_len_mean", "sentence_len_sd", "commas_per_sentence", "we_pk", "passive_pk", "connectives_pk", "hedges_pk", "dashes_pk", "semicolons_pk")))
        prompt = (
            "The skill's files (examples of published paragraphs per section also ship with it; they are not editable here):\n\n"
            + "\n\n".join(f"=== {name} ===\n{text}" for name, text in files.items())
            + f"\n\nIdeas tried in earlier rounds and their outcomes:\n{tried}\n\n"
            + "Published profile from the training split (means per paragraph; *_pk = per 1,000 words):\n" + "\n".join(profiles) + "\n\n"
        )
        system = PROPOSER_SYSTEM
        if self.method == "textgrad" and last_run:
            gradients = textual_gradients(last_run, condition, self.skill_dir, self.critics, self.data_dir, self.gradients, self.workers, self.log)
            (self.home / f"r{round_no}-gradients.json").write_text(json.dumps(gradients, indent=2))
            drift = evidence(last_run, condition).split("Measured drift", 1)[-1].split("Pairs the readers", 1)[0]
            prompt += (f"Editors' feedback on {len(gradients)} paragraphs where the skill's draft was told apart from the published one:\n\n"
                       + format_gradients(gradients) + "\n\nMeasured drift" + drift)
            system = OPTIMIZER_SYSTEM
        else:
            prompt += evidence(last_run, condition) if last_run else "(no evidence yet)"
        prompt += f"\n\nPropose {self.candidates} candidates, each testing a different idea."
        client = Client(self.data_dir / "cache")
        dev_texts = [row["text"] for path in self.runs_dir.glob("*/items.jsonl") for row in read_jsonl(path)]
        answer = client.complete_json(self.proposer, system, prompt + f"\n\n(Round {round_no}.)")
        out: list[Candidate] = []
        for index, proposal in enumerate((answer or {}).get("candidates", [])[: self.candidates], 1):
            idea = str(proposal.get("idea", "")).strip() or "(no description)"
            target = self.data_dir / "evolve" / f"r{round_no}" / f"c{index}"
            error = apply_edits(self.skill_dir, target, proposal.get("edits") or [])
            if error is None:
                new_text = "\n".join(str(e.get("new", "")) for e in proposal.get("edits") or [])
                copied = copied_wording(new_text, dev_texts)
                if copied:
                    error = f"copies evaluation wording: {copied}"
            if error:
                self.log(f"  candidate {index} dropped: {error}")
                self.history.append({"round": round_no, "idea": idea, "outcome": f"not tested ({error[:120]})"})
                continue
            (target / "IDEA.txt").write_text(idea + "\n\n" + json.dumps(proposal.get("edits"), indent=2))
            (target / "EDITS.json").write_text(json.dumps(proposal.get("edits") or []))
            out.append(Candidate(f"c{index}", idea, target))
            self.log(f"  candidate {index}: {idea}")
        self._save()
        return out

    def retest_candidate(self, round_no: int) -> Candidate | None:
        """Ideas that came close (or won but lost to a better one) and were never adopted or retested:
        applied together on top of the current skill, tested once as one candidate."""
        done = {h.get("retested_idea") for h in self.history}
        ideas, edits = [], []
        for h in self.history:
            stats = h.get("stats") or {}
            if not h.get("idea") or "ACCEPTED" in h.get("outcome", "") or h["idea"] in done or h.get("retest"):
                continue
            if stats.get("gain", 0) > 0 and stats.get("p_better", 0) >= self.retest_threshold:
                saved = self._edits_for(h)
                if saved is not None:
                    ideas.append(h["idea"])
                    edits.extend(saved)
        if not ideas:
            return None
        target = self.data_dir / "evolve" / f"r{round_no}" / "retest"
        error = apply_edits(self.skill_dir, target, edits)
        if error:
            # Some no longer apply after later changes: keep the ones that do, one at a time.
            kept_ideas, kept_edits = [], []
            for idea in ideas:
                h = next(x for x in self.history if x.get("idea") == idea)
                trial = kept_edits + (self._edits_for(h) or [])
                if apply_edits(self.skill_dir, target, trial) is None:
                    kept_ideas.append(idea)
                    kept_edits = trial
            for idea in ideas:
                if idea not in kept_ideas:
                    self.history.append({"round": round_no, "retested_idea": idea, "outcome": "no longer applies"})
            if not kept_ideas:
                return None
            ideas, edits = kept_ideas, kept_edits
            apply_edits(self.skill_dir, target, edits)
        (target / "EDITS.json").write_text(json.dumps(edits))
        idea = "Together, earlier near-misses: " + " | ".join(ideas)
        (target / "IDEA.txt").write_text(idea)
        for i in ideas:
            self.history.append({"round": round_no, "retested_idea": i, "outcome": "retested together"})
        self.log(f"  retest candidate: {len(ideas)} earlier near-misses together")
        return Candidate("retest", idea, target)

    def _edits_for(self, entry: dict) -> list[dict] | None:
        if entry.get("edits") is not None:
            return entry["edits"]
        # Older rounds: find the candidate by its idea.
        for idea_file in (self.data_dir / "evolve" / f"r{entry['round']}").glob("c*/IDEA.txt"):
            if idea_file.read_text().split("\n\n", 1)[0].strip() == entry["idea"]:
                text = idea_file.read_text().split("\n\n", 1)
                try:
                    return json.loads(text[1]) if len(text) > 1 else None
                except json.JSONDecodeError:
                    return None
        return None

    def round(self, round_no: int, last_run: Path | None, seed: int, evidence_condition: str = "incumbent") -> Path | None:
        self.log(f"== round {round_no}")
        incumbent_copy = self.data_dir / "evolve" / f"r{round_no}" / "incumbent"
        if incumbent_copy.exists():
            shutil.rmtree(incumbent_copy)
        shutil.copytree(self.skill_dir, incumbent_copy)
        candidates = self.propose(round_no, last_run, evidence_condition)
        if not candidates:
            self.log("  no usable candidates; proposing again")
            candidates = self.propose(round_no, last_run, evidence_condition)
        retest = self.retest_candidate(round_no)
        if retest:
            candidates.append(retest)
        if not candidates:
            self.log("  no usable candidates this round")
            return last_run
        conditions = [Condition("incumbent", incumbent_copy)] + [Condition(c.name, c.path) for c in candidates]
        config = RunConfig(
            name=f"evolve-r{round_no}", journals=self.journals, split="dev", per_journal=self.per_journal,
            sections=["abstract", "intro", "results", "discussion", "methods"], conditions=conditions,
            generator=self.generator, briefer=self.briefer, judges=self.judges, mode="both", seed=seed,
            workers=self.workers, out_dir=self.runs_dir, data_dir=self.data_dir,
            extra={"exclude": sorted(used_ids(self.runs_dir) - self._own_ids(round_no))},
        )
        run_dir = Runner(config, log=self.log).run().parent
        results = []
        for c in candidates:
            stats = compare_conditions(run_dir, "incumbent", c.name)
            if not stats["n"]:
                self.log(f"  {c.name}: no scored items")
                continue
            results.append((c, stats))
            self.log(f"  {c.name}: detectability {stats['candidate']:.3f} vs incumbent {stats['incumbent']:.3f} (gain {stats['gain']:+.3f}, P(better) {stats['p_better']:.2f}, n={stats['n']})")
        winners = [(c, s) for c, s in results if s["gain"] > 0 and s["p_better"] >= self.threshold]
        best = max(winners, key=lambda cs: cs[1]["gain"]) if winners else None
        for c, s in results:
            outcome = f"gain {s['gain']:+.3f}, P(better) {s['p_better']:.2f}: " + ("ACCEPTED" if best and c is best[0] else "rejected")
            saved = c.path / "EDITS.json"
            edits = json.loads(saved.read_text()) if saved.exists() else None
            self.history.append({"round": round_no, "idea": c.idea, "outcome": outcome, "stats": s, "edits": edits, "retest": c.name == "retest"})
        incumbent_score = mean(item_scores(run_dir, "incumbent").values())
        self.history.append({"round": round_no, "incumbent_detectability": incumbent_score, "run": str(run_dir)})
        self._save()
        if best:
            self._adopt(round_no, best[0], best[1])
        self._write_log()
        return run_dir

    def _own_ids(self, round_no: int) -> set[str]:
        path = self.runs_dir / f"evolve-r{round_no}" / "items.jsonl"
        return {row["id"] for row in read_jsonl(path)} if path.exists() else set()

    def _adopt(self, round_no: int, candidate: Candidate, stats: dict) -> None:
        for name in ["SKILL.md"] + [f"references/{p.name}" for p in (candidate.path / "references").glob("*.md")]:
            shutil.copyfile(candidate.path / name, self.skill_dir / name)
        self.log(f"  adopted {candidate.name}: {candidate.idea}")
        message = f"Evolve round {round_no}: {candidate.idea}\n\nDetectability {stats['incumbent']:.3f} -> {stats['candidate']:.3f} on {stats['n']} fresh dev items (P(better) {stats['p_better']:.2f}).\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
        repo = self.skill_dir.resolve().parents[1]
        subprocess.run(["git", "add", str(self.skill_dir.resolve())], cwd=repo, check=False)
        subprocess.run(["git", "commit", "-q", "-m", message], cwd=repo, check=False)

    def _write_log(self) -> None:
        lines = ["# Evolve log", "", "Detectability per item: mean over judges and both modes of whether the published paragraph won (1) or lost (0). Lower is better; 0.5 is chance.", ""]
        for h in self.history:
            if "incumbent_detectability" in h:
                lines.append(f"**Round {h['round']}**: incumbent detectability {h['incumbent_detectability']:.3f} ({h['run']})")
                lines.append("")
            elif "retested_idea" in h:
                lines.append(f"- round {h['round']}: retest of \"{h['retested_idea']}\" → {h['outcome']}")
            else:
                lines.append(f"- round {h['round']}: {h['idea']} → {h['outcome']}")
        (self.home / "log.md").write_text("\n".join(lines) + "\n")

    def run(self, rounds: int, start_seed: int, seed_run: Path | None = None, seed_condition: str = "incumbent") -> None:
        """seed_run/seed_condition: the evidence for round 1 (an earlier dev run and the incumbent's name in it)."""
        done = [h["round"] for h in self.history if "incumbent_detectability" in h]
        first = max(done, default=0) + 1
        if first > 1:
            last_run, condition = self.runs_dir / f"evolve-r{first - 1}", "incumbent"
        else:
            last_run, condition = seed_run, seed_condition
        for round_no in range(first, first + rounds):
            run_dir = self.round(round_no, last_run, start_seed + round_no, condition)
            if run_dir != last_run:
                last_run, condition = run_dir, "incumbent"
