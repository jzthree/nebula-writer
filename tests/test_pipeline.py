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
    calls = {"generate": 0, "judge": 0}

    def fake_call(self, model, system, prompt):
        if "content briefs" in system:
            return '{"function": "states a result", "points": ["result [1]"]}'
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
    assert calls["generate"] == 8 and calls["judge"] == 16
    summary = json.loads((tmp_path / "runs" / "t" / "summary.json").read_text())
    rates = {(r["condition"], r["journal"], r["judge"]): r["rate"] for r in summary["detection"]}
    assert 0.0 < rates[("baseline", "all", "claude")] < 1.0  # "A" is right only when the real one came first
    text = report.read_text()
    assert "## Verdict" in text and "too smooth" in text
    # Rerunning hits the cache: no new calls.
    Runner(config, log=lambda *_: None).run()
    assert calls["generate"] == 8
    assert write_report(tmp_path / "runs" / "t", data).exists()
