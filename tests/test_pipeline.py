import json
from pathlib import Path

import pytest

from styleturing import llm
from styleturing.corpus import JOURNALS, Paragraph, _citations, classify, extract, split_for
from styleturing.experiment import Condition, RunConfig, Runner, sample
from styleturing.llm import Model, extract_json
from styleturing.report import longest_shared_run, write_report
from styleturing.stylometry import features, sentences, wilson

JATS = b"""<article article-type="research-article"><front><article-meta>
<title-group><article-title>A test paper</article-title></title-group>
<abstract><p>""" + b"word " * 80 + b"""ends here.</p></abstract></article-meta></front>
<body>
<sec><title>Main</title><p>Chromatin shapes gene regulation<sup><xref ref-type="bibr" rid="R1">1</xref>,<xref ref-type="bibr" rid="R2">2</xref></sup> and many assays measure it<sup><xref ref-type="bibr" rid="R3">3</xref>&#8211;<xref ref-type="bibr" rid="R5">5</xref></sup>. """ + b"filler " * 70 + b"""end.</p></sec>
<sec sec-type="results"><title>Results</title><p>We found (<xref ref-type="bibr" rid="R6">6</xref>, <xref ref-type="bibr" rid="R7">7</xref>) that x (Fig. 2a). """ + b"more " * 70 + b"""done.</p>
<p>Too short.</p><p>Has a formula <disp-formula>x</disp-formula> """ + b"pad " * 80 + b"""</p></sec>
<sec><title>Data availability</title><p>""" + b"data " * 90 + b"""</p></sec>
</body></article>"""


def test_extract_normalizes_citations_and_sections():
    paragraphs = extract(JATS, {"pmcid": "PMC1", "pubYear": "2024"}, JOURNALS["nature"])
    sections = [p.section for p in paragraphs]
    assert sections == ["abstract", "intro", "results"]
    assert "regulation[1,2] and" in paragraphs[1].text
    assert "it[3–5]." in paragraphs[1].text
    assert "We found [6,7] that x (Fig. 2a)." in paragraphs[2].text
    assert paragraphs[0].title == "A test paper"


def test_citation_groups():
    marked = "a\x011\x02,\x012\x02 b (\x013\x02–\x015\x02) c"
    assert _citations(marked) == "a[1,2] b [3–5] c"


def test_classify_and_split():
    assert classify("Online methods", None, 3) == "methods"
    assert classify("Data availability", None, 5) is None
    assert classify("Main", None, 0) == "intro"
    assert split_for("PMC123") in ("train", "dev", "test")
    assert split_for("PMC123") == split_for("PMC123")


def test_stylometry_and_stats():
    text = "We measured accessibility (Fig. 1a). These data, however, were noisy; we therefore repeated it[3]. Results were robust."
    assert len(sentences(text)) == 3
    f = features(text)
    assert f["we_pk"] > 0 and f["citations_pk"] > 0 and f["ai_tells_pk"] > 0
    low, high = wilson(10, 20)
    assert low < 0.5 < high
    assert wilson(19, 20)[0] > 0.5
    assert longest_shared_run("the cat sat on the mat", "a cat sat on a mat") == 3


def test_extract_json_and_model_specs():
    assert extract_json('Sure:\n```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('{"published": "B", "confidence": 0.7}') == {"published": "B", "confidence": 0.7}
    assert extract_json("no json") is None
    assert Model.parse("agy:gemini-4-neon-high@low") == Model("agy", "gemini-4-neon-high", "low")
    with pytest.raises(ValueError):
        Model.parse("gpt")


def _paragraph(journal: str, pmcid: str, section: str, split: str, index: int = 0) -> Paragraph:
    text = f"We show that {section} paragraph {pmcid} works well[1]. " + "It holds. " * 30
    return Paragraph(f"{journal}:{pmcid}:{index}", journal, pmcid, f"Paper {pmcid}", 2024, section, index, text, len(text.split()), split, False)


def test_sample_spreads_sections_and_papers():
    corpus = [_paragraph("nature", f"P{i}", s, "dev", k) for i in range(6) for k, s in enumerate(["intro", "results", "methods"])]
    picked = sample(corpus, "nature", "dev", 6, ["intro", "results", "methods"], seed=1)
    assert len(picked) == 6
    assert {p.section for p in picked} == {"intro", "results", "methods"}
    assert len({p.pmcid for p in picked}) == 6


def test_end_to_end_with_a_stand_in_model(tmp_path: Path, monkeypatch):
    data = tmp_path / "data"
    (data / "corpus").mkdir(parents=True)
    rows = [_paragraph("nature", f"P{i}", s, split, k) for i, split in enumerate(["train", "train", "dev", "dev", "dev"]) for k, s in enumerate(["intro", "results"])]
    (data / "corpus" / "nature.jsonl").write_text("\n".join(json.dumps(p.__dict__) for p in rows) + "\n")
    skill = tmp_path / "skill"
    (skill / "references").mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: t\ndescription: t\n---\nWrite plainly.\n")
    (skill / "references" / "nature.md").write_text("Nature rules.\n")
    calls = {"generate": 0, "judge": 0, "single": 0}

    def fake_call(self, model, system, prompt):
        if "content briefs" in system:
            return '{"function": "states a result", "points": ["result [1]"]}'
        if "Paragraph:\n<<<" in prompt:
            calls["single"] += 1
            return '{"published_probability": %s, "tells": ["even"]}' % ("0.3" if "Generated paragraph" in prompt else "0.8")
        if "Paragraph A:" in prompt:
            calls["judge"] += 1
            assert "For calibration" in prompt
            return '{"published": "A", "confidence": 0.9, "tells": ["too smooth"]}'
        calls["generate"] += 1
        if "Nature rules." in system:
            assert "Write plainly." in system and "name: t" not in system
        return f"Generated paragraph with a result[1] ({len(system)}). It is crucial."

    monkeypatch.setattr(llm.Client, "_call", fake_call)
    config = RunConfig(
        name="t", journals=["nature"], split="dev", per_journal=4, sections=["intro", "results"],
        conditions=[Condition.parse("baseline"), Condition.parse(f"skill={skill}")],
        generator=Model("claude"), briefer=Model("claude"), judges=[Model("claude"), Model("agy", "g")],
        references=2, workers=2, out_dir=tmp_path / "runs", data_dir=data,
    )
    report = Runner(config, log=lambda *_: None).run()
    assert calls["generate"] == 8 and calls["judge"] == 16 and calls["single"] == 24
    summary = json.loads((tmp_path / "runs" / "t" / "summary.json").read_text())
    rates = {(r["condition"], r["journal"], r["judge"]): r["rate"] for r in summary["detection"]}
    assert 0.0 < rates[("baseline", "all", "claude")] < 1.0  # "A" is right only when the real one came first
    text = report.read_text()
    assert "## Verdict" in text and "too smooth" in text
    single = {(r["condition"], r["journal"], r["judge"]): r["auc"] for r in summary["single"]}
    assert single[("baseline", "all", "claude")] == 1.0 and "## Single-paragraph test" in text
    # Rerunning hits the cache: no new calls.
    Runner(config, log=lambda *_: None).run()
    assert calls["generate"] == 8
    assert write_report(tmp_path / "runs" / "t", data).exists()


def test_nature_main_with_topical_subsections():
    filler = b"word " * 75
    xml = (b'<article article-type="research-article"><front><article-meta><title-group><article-title>T</article-title></title-group></article-meta></front><body>'
           b"<sec><title>Main</title><p>Intro " + filler + b"</p>"
           b"<sec><title>Enhancers drive expression</title><p>Finding " + filler + b"</p></sec>"
           b"<sec><title>Discussion</title><p>Meaning " + filler + b"</p></sec></sec>"
           b"<sec><title>A second topical heading</title><p>More " + filler + b"</p></sec>"
           b"<sec><title>Methods</title><p>Cells " + filler + b"</p></sec>"
           b"<sec><title>Ethics statement</title><p>Approved " + filler + b"</p></sec>"
           b"</body></article>")
    paragraphs = extract(xml, {"pmcid": "PMC2", "pubYear": "2023"}, JOURNALS["nature"])
    assert [(p.section, p.text.split()[0]) for p in paragraphs] == [("intro", "Intro"), ("results", "Finding"), ("discussion", "Meaning"), ("results", "More"), ("methods", "Cells")]
    assert paragraphs[0].title == "T"


def test_figure_legends_are_not_paragraphs():
    from styleturing.corpus import is_legend
    assert is_legend("a, Schematic of the process. b, Plots of loss. Scale bars, 1 cm.")
    assert is_legend("(A) Front view of the complex. (B) Side view.")
    assert is_legend("(a–ac) Tree constructed for each cancer.")
    assert is_legend("a) Staining of five tissues. b) Signal after deconvolution.")
    assert not is_legend("We found that a, b and c differ (Fig. 1a).")
    assert not is_legend("Two groups (A) and (B) were compared (Fig. 2A).")


def test_plain_gives_both_texts_the_same_surface():
    from styleturing.prompts import plain
    assert plain("The *FT* gene **binds** DNA [1,2] and \u2018x\u2019 _y_.") == "The FT gene binds DNA[1,2] and 'x' y."
    assert plain("a 3*4 grid and snake_case_name stay") == "a 3*4 grid and snake_case_name stay"


def test_copied_wording_guard():
    from styleturing.improve import copied_wording
    dev = ["Immune cell function is always dictated by some element of time in 12 donors."]
    assert copied_wording("Keep phrasing like always dictated by some element of time.", dev)[0] == "always dictated by some element of"
    assert copied_wording("Repeat terms rather than vary them.", dev) == []


def test_apply_edits_rejects_bad_edits(tmp_path: Path):
    from styleturing.evolve import apply_edits

    skill = tmp_path / "skill"
    (skill / "references").mkdir(parents=True)
    (skill / "SKILL.md").write_text("Rule one.\nRule two.\n")
    (skill / "references" / "nature.md").write_text("Nature rules.\n")
    out = tmp_path / "c1"
    assert apply_edits(skill, out, [{"file": "SKILL.md", "old": "Rule two.", "new": "Rule 2."}]) is None
    assert (out / "SKILL.md").read_text() == "Rule one.\nRule 2.\n" and (skill / "SKILL.md").read_text() == "Rule one.\nRule two.\n"
    assert apply_edits(skill, out, [{"file": "references/nature.md", "old": "", "new": "More."}]) is None
    assert (out / "references" / "nature.md").read_text() == "Nature rules.\n\nMore.\n"
    assert "occurs 0 times" in apply_edits(skill, out, [{"file": "SKILL.md", "old": "missing", "new": "x"}])
    assert "may not change" in apply_edits(skill, out, [{"file": "examples/nature/results.md", "old": "", "new": "x"}])
    assert "may not change" in apply_edits(skill, out, [{"file": "../escape.md", "old": "", "new": "x"}])


def test_evolve_adopts_only_a_candidate_that_wins(tmp_path: Path, monkeypatch):
    import subprocess

    from styleturing.evolve import Evolver

    repo = tmp_path / "repo"
    data, runs = repo / "data", repo / "runs"
    (data / "corpus").mkdir(parents=True)
    rows = [_paragraph("nature", f"P{i}", s, "dev" if i % 3 else "train", k) for i in range(30) for k, s in enumerate(["intro", "results"])]
    (data / "corpus" / "nature.jsonl").write_text("\n".join(json.dumps(p.__dict__) for p in rows) + "\n")
    skill = repo / "skills" / "journal-style"
    (skill / "references").mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: t\ndescription: t\n---\nWrite plainly.\n")
    (skill / "references" / "nature.md").write_text("Nature rules.\n")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.org", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "init"], cwd=repo, check=True)
    proposals = json.dumps({"candidates": [
        {"idea": "helpful rule", "edits": [{"file": "SKILL.md", "old": "Write plainly.", "new": "Write plainly. HELPFUL."}]},
        {"idea": "useless rule", "edits": [{"file": "references/nature.md", "old": "", "new": "Useless."}]},
        {"idea": "broken edit", "edits": [{"file": "SKILL.md", "old": "not there", "new": "x"}]},
    ]})

    def fake_call(self, model, system, prompt):
        if "improve a writing skill" in system:
            return proposals
        if "content briefs" in system:
            return '{"function": "f", "points": ["p [1]"]}'
        helpful = "HELPFUL-OUT" in prompt
        if "Paragraph:\n<<<" in prompt:
            if "Generated" not in prompt:
                return '{"published_probability": 0.7, "tells": []}'
            return '{"published_probability": %s, "tells": ["smooth"]}' % ("0.9" if helpful else "0.2")
        if "Paragraph A:" in prompt:
            if helpful:  # the rewrite fools the judge: it always picks the rewrite's slot
                first_is_real = prompt.index("Generated") > prompt.index("Paragraph B:")
                return '{"published": "%s", "confidence": 0.6, "tells": []}' % ("B" if first_is_real else "A")
            first_is_real = prompt.index("Generated") > prompt.index("Paragraph B:")
            return '{"published": "%s", "confidence": 0.9, "tells": ["smooth"]}' % ("A" if first_is_real else "B")
        return "Generated paragraph" + (" HELPFUL-OUT" if "HELPFUL." in system else "") + f" {abs(hash(prompt)) % 997}."

    monkeypatch.setattr(llm.Client, "_call", fake_call)
    logs: list[str] = []
    evolver = Evolver(skill, data, runs, ["nature"], per_journal=8, candidates=3, proposer=Model("claude"),
                      generator=Model("claude"), briefer=Model("claude"), judges=[Model("claude")], workers=2, threshold=0.95, log=logs.append)
    evolver.run(rounds=1, start_seed=0)
    assert "HELPFUL." in (skill / "SKILL.md").read_text() and "Useless." not in (skill / "references" / "nature.md").read_text()
    history = json.loads((runs / "evolve" / "history.json").read_text())
    outcomes = {h["idea"]: h["outcome"] for h in history if "idea" in h}
    assert "ACCEPTED" in outcomes["helpful rule"] and "rejected" in outcomes["useless rule"] and "not tested" in outcomes["broken edit"]
    assert "Evolve round 1: helpful rule" in subprocess.run(["git", "log", "-1", "--format=%s"], cwd=repo, capture_output=True, text=True).stdout
    # Round 2 never reuses round 1's paragraphs.
    first = {r["id"] for r in map(json.loads, (runs / "evolve-r1" / "items.jsonl").read_text().splitlines())}
    evolver.run(rounds=1, start_seed=0)
    second = {r["id"] for r in map(json.loads, (runs / "evolve-r2" / "items.jsonl").read_text().splitlines())}
    assert first and second and not first & second


def test_textgrad_round_critiques_caught_paragraphs_and_retests_near_misses(tmp_path: Path, monkeypatch):
    import subprocess

    from styleturing.evolve import Evolver

    repo = tmp_path / "repo"
    data, runs = repo / "data", repo / "runs"
    (data / "corpus").mkdir(parents=True)
    rows = [_paragraph("nature", f"P{i}", s, "dev" if i % 3 else "train", k) for i in range(40) for k, s in enumerate(["intro", "results"])]
    (data / "corpus" / "nature.jsonl").write_text("\n".join(json.dumps(p.__dict__) for p in rows) + "\n")
    skill = repo / "skills" / "journal-style"
    (skill / "references").mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: t\ndescription: t\n---\nWrite plainly.\nUse dashes rarely.\n")
    (skill / "references" / "nature.md").write_text("Nature rules.\n")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    seen = {"critic": [], "optimizer": []}
    round_no = {"n": 0}

    def fake_call(self, model, system, prompt):
        if "experienced editor at Nature" in system:
            seen["critic"].append(prompt)
            return json.dumps({"differences": ["draft is evenly paced"], "suggestions": [{"file": "SKILL.md", "change": "vary sentence length", "why": "even pacing"}]})
        if "improve a writing skill" in system:
            round_no["n"] += 1
            if "textual gradients" in system:
                seen["optimizer"].append(prompt)
            # Round 1: a near miss (dashes); round 2: an unrelated idea.
            edit = {"file": "SKILL.md", "old": "Use dashes rarely.", "new": "Use dashes at the journal's rate. NEARMISS."} if round_no["n"] == 1 else {"file": "references/nature.md", "old": "", "new": "Vary sentence length."}
            return json.dumps({"candidates": [{"idea": f"idea {round_no['n']}", "edits": [edit]}]})
        if "content briefs" in system:
            return '{"function": "f", "points": ["p [1]"]}'
        near = "NEARMISS-OUT" in prompt
        if "Paragraph:\n<<<" in prompt:
            if "Generated" not in prompt:
                return '{"published_probability": 0.7, "tells": []}'
            # The near miss fools the single judge on about one item in three.
            return '{"published_probability": %s, "tells": ["even"]}' % ("0.9" if near and hash(prompt) % 3 == 0 else "0.2")
        if "Paragraph A:" in prompt:
            first_is_real = prompt.index("Generated") > prompt.index("Paragraph B:")
            return '{"published": "%s", "confidence": 0.9, "tells": ["even pacing"]}' % ("A" if first_is_real else "B")
        return "Generated paragraph" + (" NEARMISS-OUT" if "NEARMISS." in system else "") + f" {abs(hash(prompt)) % 997}."

    monkeypatch.setattr(llm.Client, "_call", fake_call)
    evolver = Evolver(skill, data, runs, ["nature"], per_journal=12, candidates=1, proposer=Model("claude"),
                      generator=Model("claude"), briefer=Model("claude"), judges=[Model("claude")], workers=2,
                      threshold=1.01, retest_threshold=0.5, log=lambda *_: None)
    evolver.run(rounds=1, start_seed=0)
    assert "NEARMISS." not in (skill / "SKILL.md").read_text()  # nothing clears a bar above 1
    evolver.run(rounds=1, start_seed=0)
    # Round 2 critiqued round 1's caught paragraphs, with the guide and the pair in view, and aggregated them.
    assert seen["critic"] and "=== SKILL.md ===" in seen["critic"][0] and "=== references/nature.md ===" in seen["critic"][0]
    assert "Published paragraph:" in seen["critic"][0] and "Draft:" in seen["critic"][0]
    assert seen["optimizer"] and "vary sentence length" in seen["optimizer"][0]
    assert (runs / "evolve" / "r2-gradients.json").exists()
    # The round-1 near miss was retested on top of the incumbent, as one candidate.
    config = json.loads((runs / "evolve-r2" / "config.json").read_text())
    assert [c["name"] for c in config["conditions"]] == ["incumbent", "c1", "retest"]
    history = json.loads((runs / "evolve" / "history.json").read_text())
    assert any(h.get("retested_idea") == "idea 1" for h in history)
