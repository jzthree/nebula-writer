---
name: journal-style
description: Write or revise scientific paragraphs so they read like text published in Nature, Science, Nature Genetics or Nature Methods. Use when drafting, rewriting or polishing manuscript prose (abstract, introduction, Results, Discussion, Methods) for one of these journals, or when the user asks for "Nature style", "Science style" or similar. Rules are measured against published papers and validated by a blind test in which expert readers compare skill-written paragraphs with published ones.
---

# Writing like a published paper in a top journal

Published papers in these journals were written by scientists and then
edited by professional editors. They read as dense, specific and plain.
Machine-drafted scientific prose has a small set of recognizable habits;
much of this skill is about not having them. Then the journal's own reference
file (`references/<journal>.md`) adds what is specific to it.

## How to use this skill

1. Identify the journal and the section (abstract, introduction, Results,
   Discussion, Methods). Read `references/<journal>.md`:
   `nature.md`, `science.md`, `nature-genetics.md`, `nature-methods.md`.
2. Read the published examples for that journal and section,
   `examples/<journal>/<section>.md` (abstract, introduction, results,
   discussion, methods). Take their rhythm, density, voice and how they
   open and close; never their wording.
3. Draft the paragraph from the content you have. Keep every fact, number
   and citation; add none.
4. Check the draft against the list below and the reference file's
   section rules, and revise. Read it once more as the journal's editor
   would.

## What published text does

- **Content first.** The first sentence carries information: a finding, a
  method, a gap. No warm-up ("In recent years, … has attracted increasing
  attention"), no announcing ("In this section, we…", "To address this,
  we sought to…").
- **Plain verbs.** show, find, identify, use, measure, increase, reduce,
  require, enable, predict. Leverage, harness, delve, unveil, showcase and
  "shed light on" are what AI reaches for; avoid them.
- **Calibrated, not sanitized.** Published papers do use "key", "critical",
  "novel", "robust", "highlight", "notably" and "however": about one such
  word per paragraph, where the authors mean it. Text with none of them, or
  with no connectives at all, reads as edited by a rule. Match the rates in
  the reference file instead of deleting a word class.
- **Specific nouns, few adjectives.** Name the thing ("H3K27ac peaks",
  "a 1.4-fold increase", "in 12 of 14 donors") instead of characterizing it.
  Do not stack intensifiers or pair adjectives ("robust and scalable").
- **Connectives as the journal uses them.** Most sentences start with their
  subject. "However", "Thus", "Therefore", "Finally", "In contrast" carry
  real turns; "moreover", "furthermore", "additionally", "notably" appear,
  but less than once per paragraph. See the reference file for the rate.
- **Uneven rhythm.** Sentence length varies a lot: a 9-word sentence next
  to a 40-word one with a parenthesis. Do not write runs of medium-length
  sentences, and do not build parallel triplets ("X, Y, and Z" as a
  rhetorical pattern, three adjectives, three clauses).
- **Numbers inline.** Statistics, sample sizes and ranges go in the
  sentence or in parentheses right after the claim ("(n = 24 mice;
  P = 0.003, two-sided t-test)", "(Fig. 2c)"), in the journal's format.
- **Calibrated claims.** Say "shows" for what the data show, "suggests"
  for inference, "may" for speculation, once each. Do not stack hedges
  ("may potentially suggest") and do not inflate ("demonstrates
  unequivocally", "paves the way", "opens new avenues").
- **No closing moral.** A Results or Methods paragraph ends on its last
  finding or step. It does not end with a sentence that restates why the
  result matters ("These findings highlight the importance of…",
  "Together, this underscores…"). Only the final paragraph of a Discussion
  or introduction, or an abstract, states the implication, once, concretely.
- **Not a summary of itself.** No "In summary", "Overall", "Taken
  together" except where the journal uses them (see the reference file),
  and never twice in a paper.
- **Punctuation at the journal's rate.** Semicolons and colons are
  occasional (one every two or three paragraphs, mostly inside parentheses or
  lists of results); do not use them to join balanced clauses. Em dashes
  only as often as the reference file says. No bold, no lists inside
  paragraphs, no rhetorical questions.

## Texture: published prose is not perfectly polished

Published prose is less uniform than a machine draft, and the unevenness is
part of the house voice. Without introducing errors:

- Repeat a term rather than vary it ("contamination … contamination",
  "we also find … we also find"). Elegant variation is a tell.
- Let one sentence carry a lot (a long list, two findings and a parenthesis)
  and the next be short and flat ("Rora and Rorb have similar motifs.").
- Keep the authors' own terms, coinages in quotation marks, symbols and
  notation exactly as given, even when a smoother word exists.
- Mix active and passive voice, and "we" with impersonal constructions, as
  scientists do; do not convert a paragraph wholly to one.
- Keep tense natural rather than uniform: past for what was done, present
  for what the data show and for figures, and an occasional switch.
- Do not add explanatory clauses, purpose fronting ("To obtain …, we") or
  tagged-on consequences (", making it possible to …", "which makes it …")
  that the content does not need.
- Hedge only where the content is uncertain; do not hedge systematically.

## Patterns that separate machine drafts from published prose

Expert readers comparing drafts with the published paragraphs point to these most often:

- **Tidying.** Authors write long compound sentences that carry two or
  three findings joined by "and", "whereas" or "but"; machine drafts split them into
  short, evenly sized sentences of one fact each. Keep related findings in
  one sentence; let some sentences run long.
- **Negation pivot.** "X alone does not recruit Y. Instead, Y binds …".
  Write the positive finding directly: "Y is not recruited by X alone, but
  binds …" or simply state what binds what.
- **Demonstrative recaps.** A sentence starting "This co-expression
  enables …", "This approach allows …", "This map provides …" that restates
  the previous sentence's object before adding to it. Join it to the
  previous sentence or start with the new subject.
- **Scaffolding.** "First, … Second, …", "in three ways", "two settings"
  announcements, and three parallel sentences with the same template.
  Published abstracts and Results stack findings with "We show that …
  We also find that …", or just state them.
- **Polished closers.** "Together, our findings indicate …", "These data
  offer a resource for …", "X thus provides a paradigm for …". If the
  paragraph needs a closing implication, make it specific and plain.
- **Thesaurus wording.** Uncommon synonyms for the field's standard terms
  ("unforeseen" for unexpected, "switches on" for activates, "travels" for
  is transported). Use the term the field uses, even if it is plain or
  repeated.
- **Over-smoothness.** Published text keeps some unevenness: a repeated
  "we also find", a slightly awkward term the authors coined (often in
  quotation marks), a long parenthetical. Do not polish every sentence to
  the same finish.
- **Spelling.** House spelling must be consistent: British in Nature,
  American in Science, Nature Genetics and Nature Methods.

## Checklist before returning a paragraph

- [ ] First sentence carries content; no warm-up or announcement.
- [ ] No AI vocabulary (leverage, harness, delve, unveil, showcase, shed light on); evaluative words and connectives at the journal's rate, not zero.
- [ ] Terms repeated rather than varied; the authors' terms and notation kept as given.
- [ ] At most one sentence-initial connective, and only for a real contrast or consequence.
- [ ] Sentence lengths vary (some under 15 words, some over 30, if the paragraph is long enough).
- [ ] No triplets for rhythm; no paired adjectives ("robust and scalable").
- [ ] No negation pivots ("… does not … Instead, …"), no "This X enables …" recaps, no "First, … Second, …" scaffolding.
- [ ] Related findings share a sentence; not every sentence is the same length or finish.
- [ ] Ends on content, not on a significance statement (unless it is the paragraph's job).
- [ ] Every number, name, citation and figure reference from the source is there, and nothing new.
- [ ] Matches the section rules and numbers in `references/<journal>.md`.
