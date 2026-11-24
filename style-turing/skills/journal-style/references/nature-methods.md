# Nature Methods

Measured on recent open-access Nature Methods articles; numbers are per
paragraph unless stated. "pk" means per 1,000 words.

## House conventions

- **American spelling**: analyze, behavior, color, center, labeled, modeling.
- Nature Portfolio copyediting: person-first wording ("people with
  diabetes", not "diabetic patients"); suspended hyphens ("cell- or
  organ-level"); "number of" in running text, never "no.".
- "approximately" before a precise value in running text ("approximately
  31.2%"); "~" mostly inside parentheses or for rough magnitudes ("~10^6
  reads").
- "for example" written out, often in parentheses listing tools ("(for
  example, ToolA[12] and ToolB[15])"). Write "that is", not "i.e."; never
  "e.g." in text.
- "likely" rather than "probably".
- Figure references use lowercase panels: (Fig. 2b), (Extended Data Fig. 3),
  (Supplementary Fig. 4), (Supplementary Note 2). Place them after the claim
  they support, not at the start of the paragraph.
- Name tools as their authors style them (lowercase or mixed case kept). The
  method being introduced is often the grammatical subject, and its name is
  repeated rather than replaced by "it" or "the tool".
- Give each quantity its own parenthesis or clause. Do not merge
  abbreviation definitions and numbers into one semicolon-separated tuple,
  and do not add column-style headers like "(count; percent)".

## Word choice and texture

- **Evaluative words at the journal's rate.** Published Nature Methods text
  uses words like key, essential, powerful, considerable, comprehensive,
  novel, robust, highlight, capacity and utility far more than drafts do
  (about 7 pk in abstract, introduction and Discussion, about one per
  paragraph; about 4 pk in Results; rare in Methods). Use one where the
  authors would claim it; do not strip every one out.
- **Few hedges.** Drafts hedge three times more than published text. In
  abstracts, introductions and Methods, state claims directly ("X detects",
  "Y can provide"); avoid "could", "may", "potentially", "might" unless the
  content is speculative. Discussion allows about one hedge per paragraph.
- **Academic nominal phrasing, not plain-English paraphrase.** Published
  text uses longer, Latinate words and nominalizations ("the evaluation of",
  "the integration of", "greatly impacts the utility of", "in the absence
  of"). Do not paraphrase into conversational clauses ("how X is done
  affects how useful Y is", "lays out", "caps", "much of this remains
  untapped").
- **Repeat phrases.** Authors reuse the same verb or construction in
  adjacent sentences ("we used … we used", "followed by … followed by",
  "Here we … Here we also"). Do not cycle synonyms (applied / built /
  selected / passed to) to avoid repetition.
- **This/These openers are normal here.** About one sentence in ten starts
  with "This"/"These" + noun ("This dataset has been used …", "These data
  contain …"). Use one per paragraph where it links to the previous
  sentence.
- **Connectives at roughly one or two per paragraph** in introduction,
  Results and Discussion (Methods: about one every three paragraphs):
  However, Nevertheless, Furthermore, Moreover, In addition, Therefore,
  Altogether. A paragraph may open with "Moreover," or "In addition,"
  continuing the previous one; not every paragraph needs a self-contained
  topic sentence.
- **Colons are rare** (about one per four paragraphs). Do not use a colon to
  set up a summary ("neurons act jointly: …") or to introduce a list
  after "including". Semicolons occur mostly inside parentheses with
  statistics; do not join two clauses with "; this …".
- **Rhythm.** Sentence-length SD is about 8 words. In a six-sentence
  paragraph include at least one sentence under 15 words and one over 35.
  Average around 25 words; do not let every sentence run long.
- **Leave sentences as the content falls.** Do not merge two separate
  statements into one compound with "and we therefore"; do not split one
  long contrast ("While …, there is …") into tidy standalone declaratives.
  Long sentences in this journal accumulate clauses with "while",
  "including", "as well as", not with semicolons.

## Things drafts add that published text does not

- Explanatory glosses of an obvious mechanism ("where several neighbors may
  fall in range"), or unpacking of field shorthand into a longer phrase.
- Interpretive tags at the end of a sentence (", so X entails a
  trade-off", ", thereby enabling …", ", which makes it suitable for …").
- Bridges that summarize the previous sentence ("Despite this growth,",
  "Together, these gaps …") in place of a plain connective.
- Verb triplets and tricolons ("reduce A, permit B and thereby improve C").
  Each verb in a list must fit its subject.
- Closing sentences that echo the paper's title or restate the aim as a
  setting "in which to test whether …".
- Generic user-facing endings ("for users to choose the most suitable tool
  for a given analysis").
- Stock adjective defaults: rapidly increasing, diverse combinations,
  substantial challenge, most suitable. Prefer the field's term and specific
  nouns.

## Section rules

**Abstract**, ~155 words, ~7 sentences of ~22 words, no citations, no
semicolons, at most one colon. The problem in practical terms (what current
analyses do and what that loses), then "We present" or "We introduce" (with
or without "Here") plus the method's full name and abbreviation. Then what it
does, stated with present-tense verbs and the method's name as subject in
consecutive sentences ("ToolX detects … ToolX can identify …"); do not open
each result sentence with a parallel "In <setting>, ToolX …" frame. One
evaluative word is expected (tremendous, fundamental, clinically relevant). End
with a short availability sentence naming the URL ("ToolX is available at
example.org"); no "freely" or "open source and available".

**Introduction**, ~160 words, ~7 sentences of ~24 words, citing three to
four groups, about one passive per two sentences. Survey existing
approaches by name and state their limitation concretely ("cannot handle
overlapping cells", "requires paired data"). Contrasts use sentence-initial
"Nevertheless," "However," "Furthermore, while …,". The gap may be stated
with a nominal construction ("an absence of systematic evaluation of …"),
and the closing sentence may start with "These" and name the resulting
challenge in academic phrasing. No hedges.

**Results**, ~150 words, ~6 sentences of ~27 words, about two "we" per
paragraph. Vary openings. Do not default to "To evaluate X, we next
applied …"; a paragraph may open with a statement about the step or dataset
("The next benchmark uses …") followed by "Therefore, we …", or with
"First," / "Finally, we …". Describe a dataset with its accession,
organism and property, then a "This dataset …" sentence on why it is used.
Report benchmarks with metric and comparison ("a median Pearson's r of 0.71
versus 0.58 for ToolB"). A Results paragraph may end on a plain summary
of what the analysis shows about the method ("Altogether, these benchmarks
show that ToolX …"); this is house style. Do not end with "These properties
make …" or a "thus" consequence.

**Discussion**, ~140 words, ~6 sentences of ~26 words, almost no
parentheses, no dashes. Restate what the method enabled, in past tense,
with an evaluative verb or noun ("We demonstrate the strength of ToolX by
…"); vary the openers, avoid "Here we applied". Name limitations and future
work directly. Closing a Discussion paragraph with "Altogether, these
findings …" plus one evaluative word (key, capacity, utility) is normal; do
not compress the close into "X can thus …".

**Methods**, ~130 words, ~6 sentences of ~23 words. Passive voice
dominates (about three passives per paragraph) with "we" one or two times;
do not write a Methods paragraph wholly in "we". Software, versions,
parameters, hardware and training details inline, often in parentheses
("(maximum = 500)", "(version 2.1)"). Repeat procedural verbs ("was used",
"followed by"). Do not make a function the subject of a purpose clause
("function() then selected genes so that …"); write "genes were selected
using function()". Do not end with ", which yielded …".

## Tone

A tool paper: concrete about what the method does, on which data, how well
and compared with what. Technical terms are used without apology, the
method's name recurs as subject, and claims are stated, not hedged.
