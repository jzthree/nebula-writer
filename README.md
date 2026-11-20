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

Paragraphs come from Europe PMC full texts (JATS XML) of research articles,
2020–2025: open-access papers for the three Nature titles, and author
manuscripts for *Science* (accepted text before Science's copyediting, which
makes it a slightly different target). Paragraphs of 70–260 words, without
formulas or tables, are tagged abstract / intro / results / discussion /
methods.

Papers are split by a hash of their PMCID: **train** (40%) is what the skill
is written from and where judges' calibration paragraphs come from, **dev**
(30%) is where the skill is tuned, **test** (30%) is held out and run once
per version worth reporting.

## Use

```sh
uv venv && uv pip install -e ".[test]"
stl corpus --papers 40                      # download and extract (cached in data/)
stl profile                                 # measured style of each journal (train)
stl run --name dev-v1 --per-journal 12      # baseline vs skills/journal-style, on dev
stl improve runs/dev-v1                     # revise each journal's reference from dev evidence
stl run --name dev-v2 --per-journal 12      # measure again; repeat
stl run --name test-v2 --split test --per-journal 24   # held-out score
```

Models are local CLIs, signed in as you: `claude` (Claude Code), `agy:<model>`
(Antigravity), `codex` (Codex CLI). Pick them with `--generator`, `--briefer`,
`--judge` (repeatable), e.g. `--judge claude --judge agy:gemini-4-neon-high`.
Every call is cached by its exact inputs under `data/cache/`, so a stopped
run resumes and a rerun of the same configuration is free.

Each run writes `runs/<name>/`: the sampled items, briefs, rewrites,
judgments, `summary.json` and `report.md` (verdict per journal, detection by
judge and section, stylometric drift, a leak check on shared wording, and
the judges' stated tells).

## The skill

`skills/journal-style/` is a Claude Code / Codex skill: `SKILL.md` holds the
general method, `references/<journal>.md` the journal-specific rules. The
test loads it exactly as an agent would: SKILL.md, then the journal's
reference file. Install it for your agents with

```sh
ln -s "$PWD/skills/journal-style" ~/.claude/skills/journal-style
```

## Limits

- Judges are models. A human editor may catch other things; the protocol
  supports adding any judge that answers the same prompt.
- With 12 paragraphs per journal and judge, a 95% interval spans about ±25
  points; use the test split with more paragraphs for a claim.
- The brief can lose detail. The report's leak check and the judges' tells
  show when content, not style, decided a comparison.
