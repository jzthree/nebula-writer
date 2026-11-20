# Style Turing test

An objective way to develop a writing-style skill: a skill for writing like
*Nature*, *Science*, *Nature Genetics* or *Nature Methods* has succeeded when
judges can no longer tell its paragraphs from the published ones.

## How the test works

For each published paragraph drawn from the corpus:

1. **Brief.** A model turns the paragraph into telegraphic content notes:
   every fact, number, name, citation marker and figure reference, the
   strength of each claim, and nothing of the wording.
2. **Rewrite.** A writer model recreates the paragraph from the notes alone:
   once with no guidance beyond the journal's name (**baseline**), once
   following the skill (**skill**).
3. **Judge.** A judge sees the published paragraph and the rewrite, in random
   order, with the paper's title and section, plus three published
   paragraphs from the same journal and section for calibration. It says
   which one was published, how sure it is, and what gave the other away.

Content is held fixed by the brief, so the only thing left to tell the two
apart is how they are written. The **detection rate** is how often a judge
picks the published paragraph: 50% is chance. A skill **passes** a journal
when every judge's 95% interval includes 50%.

Two judges from different model families (Claude, Gemini via Antigravity)
keep the skill from learning one judge's blind spots. Citations are
normalized to `[n]` in both texts, so citation formatting is not a tell.

## Data and splits

Paragraphs come from Europe PMC full texts (JATS XML) of open-access research
articles, 2018–2025, 120 papers per journal (Science: open-access papers
only, since its author manuscripts do not serve full text). Paragraphs of
70–260 words, without formulas, tables or figure legends, are tagged
abstract / intro / results / discussion / methods; citations become [n].

Papers are split by a hash of their PMCID, so adding papers never moves one
between splits: **train** (40%) is what the skill is written from, **dev**
(30%) is where it is tuned (a fresh seed each round, so no paragraph is
scored twice), **test** (30%) is held out and run once for the version that
ships. Train papers are split again by hash: half supply the skill's example
paragraphs (CC BY only, with attribution), the other half the judges'
calibration paragraphs, so writer and judge never see the same text.

## Use

```sh
uv venv && uv pip install -e ".[test]"
stl corpus --papers 120                     # download and extract (cached in data/)
stl profile                                 # measured style of each journal (train)
stl exemplars                               # example bank for the skill (train, CC BY)
stl run --name dev-v1 --per-journal 12 --condition baseline --condition skill=skills/journal-style
stl improve runs/dev-v1 --condition skill   # revise each journal's reference from dev evidence
stl run --name dev-v2 --seed 8 ...          # measure again on fresh dev paragraphs; repeat
stl run --name test-v1 --split test --per-journal 24 ...   # held-out score, once
```

Models are local CLIs, signed in as you: `claude` (Claude Code), `agy:<model>`
(Antigravity), `codex` (Codex CLI). Pick them with `--generator`, `--briefer`,
`--judge` (repeatable), e.g. `--judge claude --judge agy:gemini-4-neon-high`.
Every call is cached by its exact inputs under `data/cache/`, so a stopped
run resumes and a rerun of the same configuration is free.

Each run writes `runs/<name>/`: the sampled items, briefs, rewrites,
judgments, `summary.json` and `report.md` (verdict per journal, detection by
judge and section, the single-paragraph AUC, stylometric drift, a leak check
on shared wording, and the judges' stated tells).

Two tests run on the same rewrites. **Paired**: the judge sees the published
paragraph and the rewrite and picks the published one (pass = 95% interval
includes 50%). **Single**: the judge rates each paragraph alone for how
likely it is published; AUC 0.5 means it cannot tell. The paired test is the
strict bar: side by side, any difference in smoothness shows.

## Results so far

Generator Claude Opus 5.5 (Claude Code); judges Claude and Gemini 4 (Antigravity).
Paired: % of comparisons where the judge picked the published paragraph.

| Run | Condition | Paired, Claude / Gemini | Single AUC, Claude / Gemini |
|---|---|---|---|
| dev-v3 (n=48) | baseline | 94% / 98% | 0.93 / 0.96 |
| | v3 | 87% / 87% | 0.87 / 0.84 |
| dev-v4 (n=48) | baseline | 96% / 98% | 0.91 / 0.90 |
| | v3 | 92% / 89% | 0.86 / 0.77 |
| | v4 (rules revised again) | 92% / 89% | 0.86 / 0.82 |
| dev-v5 (n=48) | baseline | 94% / 92% | 0.88 / 0.92 |
| | v3 | 90% / 88% | 0.85 / 0.84 |
| | v5 (12 examples per section) | 92% / 92% | 0.89 / 0.85 |
| **test (n=96, held out)** | baseline | 95% / 98% | 0.91 / 0.88 |
| | **v3 (shipped)** | **94% / 91%** | **0.89 / 0.80** |

v1–v2 (written rules only) barely moved detection; adding published example
paragraphs (v3) gave a consistent but small gain, and neither more rule
revision (v4) nor more examples (v5) improved on it. On held-out papers the
skill lowers detection modestly (most for Gemini, and in abstracts: 92% →
82%) and roughly a third fewer confident calls by Claude, but no journal
passes: side by side, judges still pick the published paragraph about nine
times in ten. Their main tell is that the rewrite is smoother than the
authors' prose (fewer rough edges, inconsistencies and slips), which the
skill deliberately does not imitate by adding errors.

## The skill

`skills/journal-style/` is a Claude Code / Codex skill: `SKILL.md` holds the
general method, `references/<journal>.md` the journal-specific rules, and
`examples/<journal>/<section>.md` published CC BY paragraphs. The test loads
it exactly as an agent would: SKILL.md, the journal's reference file, then
the section's examples. Install it for your agents with

```sh
ln -s "$PWD/skills/journal-style" ~/.claude/skills/journal-style
ln -s "$PWD/skills/journal-style" ~/.codex/skills/journal-style
```

Earlier versions are kept under `data/skill-versions/` (not in git).

## Limits

- Judges are models. A human editor may catch other things; the protocol
  supports adding any judge that answers the same prompt.
- With 12 paragraphs per journal and judge, a 95% interval spans about ±25
  points; claims rest on the pooled and held-out numbers.
- The brief can lose detail, and the generator can recall a well-known
  paper's own wording (the leak check flags this; one test abstract was
  recalled under both conditions). The judges' tells show when content, not
  style, decided a comparison.
- Science is represented by its open-access papers only; the Nature corpus
  spans all fields.
- The skill is for writing your own manuscripts well in a journal's house
  style. Journals require disclosure of AI assistance; this tool does not
  change that.
