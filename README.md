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
stl grants                                  # funded NIH summaries and narratives from RePORTER (local only)
stl run --name dev-v1 --per-journal 12 --condition baseline --condition skill=skills/journal-style
stl improve runs/dev-v1 --condition skill   # revise each journal's reference from dev evidence
stl run --name dev-v2 --seed 8 ...          # measure again on fresh dev paragraphs; repeat
stl run --name test-v1 --split test --per-journal 24 ...   # held-out score, once
stl evolve --rounds 4                       # automated loop: propose one-idea edits, score each on fresh dev paragraphs, adopt only a confident win
stl run --name test-v2 --split test --exclude-run runs/test-v1 ...   # a second held-out test on unused paragraphs
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
| | v3 | 94% / 91% | 0.89 / 0.80 |
| **test 2 (n=96, held out, unused paragraphs)** | baseline | 93% / – | 0.87 / – |
| | v3 | 86% / – | 0.81 / – |
| | v3 + the one edit evolve adopted | 91% / – | 0.83 / – |

Test 2 has the Claude judge only: Gemini's quota ran out before it started.

**Test 3 (n=192, held out, unused paragraphs; generator Opus 5.5; judges Opus 5.5 and Codex).**
Detectability is graded by the judge's confidence (0.5 = cannot tell; lower is better).

| Condition | Detectability | Paired, Opus / Codex | Single AUC, Opus / Codex |
|---|---|---|---|
| baseline | 0.768 | 95% / 99% | 0.88 / 0.97 |
| v3 | 0.734 | 92% / 98% | 0.85 / 0.96 |
| **v6 (shipped)** | **0.701** | **82% / 98%** | **0.81 / 0.90** |

v6 beats v3 by 0.033 (paired bootstrap P(better) 1.0), as much as v3 beats
no skill, and each judge confirms it alone (Opus +0.028, Codex +0.038); all
four journals improve. Codex still picks the published paragraph side by
side almost every time, but with less confidence, and alone it now rates
the rewrite published-like far more often.

v1–v2 (written rules only) barely moved detection; adding published example
paragraphs (v3) gave a consistent but small gain, and neither more rule
revision (v4) nor more examples (v5) improved on it. On held-out papers the
skill lowers detection modestly (most for Gemini, and in abstracts: 92% →
82%) and roughly a third fewer confident calls by Claude, but no journal
passes: side by side, judges still pick the published paragraph about nine
times in ten. Their main tell is that the rewrite is smoother than the
authors' prose (fewer rough edges, inconsistencies and slips), which the
skill deliberately does not imitate by adding errors. On test 2 the skill
again lowered detection (mean detectability 0.90 → 0.84 per paragraph,
paired bootstrap P(better) 0.99), so the gain is small but real.

**Automated improvement (`stl evolve`).** Ten rounds tested 31 one-idea
edits, each scored against the current skill on 96 dev paragraphs no earlier
round had used, adopting only at P(better) ≥ 0.95. Rounds 1–6 proposed edits
from the judges' tells and the stylometric drift; rounds 7–10 used TextGrad
(two critic models explain why they caught each paragraph and suggest guide
changes; an optimizer turns those into edits). One edit was adopted (round 1,
Nature Genetics sentence length and commas, +0.031 on dev). On test 2 it made
Nature Genetics worse (worse on 9 paragraphs, better on 1) and was reverted:
with about 30 tests at that bar, one false adoption is expected by chance.
The same unchanged skill scored between 0.84 and 0.91 from round to round,
so the effect of a single rule edit is below what 96 paragraphs can resolve.
Gemini's quota ran out during round 10, so part of that round is Claude only.

Two changes then made the loop work. **Scoring**: a right/wrong pick carries
little information when judges are right nine times in ten, so from round 11
each judgment is graded by the judge's stated confidence, and a candidate is
compared with the incumbent only on judge-and-mode cells both have. (The old
item average mixed judges whenever one failed for one condition; paired by
judge, the round-1 "win" was not significant, which is why it failed on the
held-out papers.) **Size of change** (`--scale structural`): candidates
became whole-workflow or whole-file changes. Rounds 11–13 tested nine; none
won alone, but three leaned positive (P 0.73–0.80) and touched different
files. Combined, they beat v3 on 192 fresh dev paragraphs (+0.018, P 0.999)
and on test 3 above. That combination is v6:

- SKILL.md: treat the given content as the authors' material, draft by
  assembling it rather than paraphrasing, then audit every departure (a
  synonym, an expanded abbreviation, reformatted notation, an added framing
  clause, a dropped or added hedge, reordered or regrouped points) and undo
  it unless a house rule requires it.
- Nature Genetics: the measured rates read as ceilings, not quotas.
- Science: the file rebuilt around how Science sentences are constructed in
  each section.

Part of v6's gain comes from keeping the content's own wording: 24% of a v6
draft's four-word sequences come from the notes, against 20% for v3. On a
real manuscript the notes are the author's own draft, so this is what an
editor should do; in this benchmark the notes were made from the published
paragraph, so some of the authors' phrasing reaches the draft that way. The
loop now retests positive near-misses together (`--retest-threshold 0.7`)
and stops after rounds in a row without a win (`--patience`).

**Where it stops.** From v6, rounds 14–16 tested nine more structural
changes and three combined retests; none won (all within ±0.01, and pushing
"keep what the content gives" from wording into sentence frames was clearly
worse, -0.018). One larger idea was then tested outside the loop: tailored
examples (`scripts/find_examples.py`, kept here as `skill-scripts/find_examples.py`; the harness runs it on each
paragraph's notes as an agent would; it shows the four most similar
published paragraphs of the journal and section from a bank of CC BY
training-split paragraphs). It was worse than v6 on 192 fresh dev paragraphs
(-0.009, P(better) 0.09; better for Nature, worse for the other three).

What still gives v6 away, by the Opus judge's stated reasons (240 sampled):
about half are specific word or construction choices where these authors
picked one of several acceptable forms (tense, voice, a connective, a list
form), a quarter are the rewrite's greater polish and regularity, a fifth
are the authors' own quirks and rough edges, and almost none are content.
The first kind varies from paper to paper, so rules that push one way
produce the opposite fault elsewhere (the loop saw this repeatedly); the
last two are what the skill deliberately does not imitate. v6 is the
plateau for changes to the skill under this protocol.

## NIH grant applications

The same test runs on funded NIH grant text (`--journals nih`). `stl grants`
fetches the Project Summaries and Project Narratives of funded new awards
(fiscal years 2019–2024; 300 projects each of R01, R21, R03, R35, K01, K08,
K23, K99, F31, F32) from the NIH RePORTER API into `data/corpus/nih.jsonl`.
Each project is one "paper": its core project number decides the split.
Summaries of 70–450 words and narratives of 25–160 words are kept, about
3,100 and 2,900 paragraphs.

RePORTER states no license for this text, so it never leaves `data/`: it is
what the grant rules are measured from and what the benchmark tests on.
The skill's committed NIH examples are applications that their authors
shared under CC BY 4.0 (found through Open Grants, ogrants.org). For more,
`scripts/find_examples.py --journal nih` searches RePORTER live for funded
awards on the user's topic and prints their summaries or narratives without
storing them. In the benchmark, the same script searches a local bank of
training-split projects instead, so it can never return the application
being rewritten. NIAID's sample applications are copyrighted and posted with
the authors' permission for education only, and the site does not allow
automated downloads, so they are not used.

The grant judge is told it is an NIH reviewer, sees the mechanism ("an NIH
predoctoral fellowship (F31) application") and calibration paragraphs from
other funded applications, and is told that grammatical slips and typos are
not evidence. Funded applications are not copy-edited, and in a first run
correcting the applicants' slips was the judges' most common tell; the skill
must not add errors, so the test measures style, not error rate.

**Results (Opus writes; Opus and Codex judge; graded detectability, 0.5 =
chance, lower is better).** Without the skill both judges catch almost every
rewrite (95–99%). On dev, v6 (no NIH rules) lowered detectability from 0.757
to 0.681; NIH rules and CC BY examples (g1) to 0.672; showing the four
funded paragraphs most similar to the notes as well (g1r) made it worse
(0.691), as tailored examples did for journals. What still gave g1 away was
polish: smoother than the applicants, tightened, tidied into parallel aims,
glossed. A section telling the writer that funded text is not copy-edited
(keep the applicants' constructions, do not tighten or tidy, add nothing for
clarity) beat g1 on 93 fresh dev paragraphs (0.682 → 0.664, P 0.998) and
shipped. Held out (93 test paragraphs): no skill 0.759, v6 0.693, shipped
0.677 (P 0.988 against v6, 1.0 against no skill). Opus still detects 85%
side by side and Codex 98%: grant text remains far from passing.

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
