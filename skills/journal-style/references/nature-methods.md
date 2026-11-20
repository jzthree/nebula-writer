# Nature Methods

Measured on 40 recent open-access Nature Methods articles; numbers are per
paragraph unless stated.

## House conventions

- **American spelling**: analyze, behavior, color, center, labeled, modeling.
- Approximations with "~" or "approximately"; "about" sometimes.
- "for example" written out, and used often (about once per 1,000 words),
  typically in parentheses listing tools: "(for example, Cellpose[25] and
  Mesmer[28])". "that is" rather than "i.e."; never "e.g." in text.
- "likely" rather than "probably".
- Figure references lowercase panels: (Fig. 2b), (Extended Data Fig. 3),
  (Supplementary Fig. 4) and (Supplementary Note 2) are frequent.
- Tools are named as their authors style them (Cellpose, scooby, precisION)
  and the method being introduced is the grammatical subject:
  "precisION implements …", "CellSAM achieves …".
- URLs and availability statements appear in text when relevant.

## Section rules

**Abstract**, ~155 words, ~7 sentences of ~22 words, no citations. The
problem in practical terms (what current methods cannot do and why it
matters), "Here we present / Here we introduce / Here we describe" plus
the method's name and what it does, then what it achieves on which data
("on 255,188 species from 2,874 samples"), and one sentence on reach.

**Introduction**, ~160 words, ~7 sentences of ~24 words: longer paragraphs
than the other journals, citing three to four groups each, surveying
existing approaches by name and stating their limitation concretely
("cannot handle overlapping cells", "requires paired data").

**Results**, ~150 words, ~6 sentences of ~27 words, in the first person
plural (about two "we" per paragraph). Paragraphs open with purpose ("To
assess the performance of X, we …", "To evaluate …") or sequence ("First,
…", "Second, we implemented …", "Finally, we …"). Benchmarks are reported
with the metric and the comparison ("a median Pearson's r of 0.71 versus
0.58 for …"). A Results paragraph may end with a sentence on what the
analysis demonstrates about the method ("Altogether, these analyses
demonstrate …"); this is the house style, unlike Nature.

**Discussion**, ~140 words, ~6 sentences of ~26 words, almost no
parentheses. Restates what the method enables ("Here we presented …"),
compares with alternatives, names limitations and "future work" directly,
and may end with availability or adoption ("we provide a streamlined
workflow …"). Some evaluative language is normal here ("a step change",
"broadens the scope"), used once, not stacked.

**Methods**, ~130 words, ~6 sentences of ~23 words, with more "we" than
the other journals' Methods (about two per paragraph) alongside passive
voice; software, parameters, hardware and training details inline.

## Tone

A tool paper: concrete about what the method does, on which data, how well,
compared with what. Technical terms are used without apology; the method's
name recurs as a subject.
