export interface WritingRoutine {
  ariaLabel?: string;
  builtIn?: boolean;
  id: string;
  label: string;
  prompt: string;
  recommendedMaxSuggestions?: number;
  title?: string;
}

export const r01EditorPrompt = "Act as an NIH R01 study-section grant editor. Propose a substantial batch of concrete exact-source edits that move this Research Strategy toward a submission-ready draft. Spread edits across the document rather than only the opening. Prioritize Significance, Innovation, Approach logic, testable hypotheses, expected outcomes, pitfalls/alternatives, and reviewer-friendly clarity. Preserve citation fields, formulas, figure labels, and technical meaning exactly.";

export const builtInRoutines: WritingRoutine[] = [
  {
    builtIn: true,
    id: "document-review",
    label: "Deep review",
    ariaLabel: "Use document review prompt",
    title: "Review structure, clarity, completeness, and reader fit",
    prompt: "Review this document for structure, clarity, completeness, and reader fit. Propose concrete exact-source edits that improve the document while preserving meaning, citations, formulas, and field structures."
  },
  {
    builtIn: true,
    id: "clarity-pass",
    label: "Clarity",
    ariaLabel: "Use clarity pass prompt",
    title: "Improve reader-facing clarity across the document",
    prompt: "Improve reader-facing clarity throughout this document. Propose concrete exact-source edits that make claims, transitions, and topic sentences easier to follow while preserving meaning and technical details."
  },
  {
    builtIn: true,
    id: "concise-pass",
    label: "Tighten",
    ariaLabel: "Use concise language prompt",
    title: "Make the document more concise and direct",
    prompt: "Make this document more concise and direct. Propose concrete exact-source edits that remove redundancy and improve flow while preserving meaning and required detail."
  },
  {
    builtIn: true,
    id: "structure-pass",
    label: "Structure",
    ariaLabel: "Use structure pass prompt",
    title: "Improve organization and section flow",
    prompt: "Improve the document's organization and section flow. Propose concrete exact-source edits that make the sequence of ideas easier to follow while preserving meaning and required detail."
  },
  {
    builtIn: true,
    id: "evidence-pass",
    label: "Evidence",
    ariaLabel: "Use evidence check prompt",
    title: "Check that claims are supported and framed carefully",
    prompt: "Check whether the document's claims are supported and framed carefully. Propose concrete exact-source edits that clarify evidence, qualify overstatements, and make unsupported claims more precise while preserving meaning and required detail."
  },
  {
    builtIn: true,
    id: "tone-pass",
    label: "Tone",
    ariaLabel: "Use tone consistency prompt",
    title: "Make voice and level of detail consistent",
    prompt: "Improve tone consistency across the document. Propose concrete exact-source edits that make voice, confidence, and level of detail feel consistent for the intended reader while preserving meaning and required detail."
  },
  {
    builtIn: true,
    id: "r01-pass",
    label: "R01 pass",
    ariaLabel: "Use R01 review prompt",
    title: "Load a broad R01 study-section review prompt",
    prompt: r01EditorPrompt
  },
  {
    builtIn: true,
    id: "r01-gap-triage",
    label: "Gap triage",
    ariaLabel: "Use R01 gap triage prompt",
    title: "Find placeholders and submission-blocking R01 gaps",
    prompt: "Act as a senior NIH R01 reviewer doing a gap-triage pass on this Research Strategy draft. Find concrete blockers to submission readiness: placeholders, incomplete rationales, missing validation details, weak Significance/Innovation claims, unclear expected outcomes, and missing pitfalls or alternative strategies. Prefer exact-source suggestions that replace short placeholder or underdeveloped body text with reviewable R01-ready language when safe. When the gap needs larger synthesis or the source text appears to touch protected DOCX structure, propose a Word-comment style suggestion on the nearest ordinary body sentence rather than a memo. Spread suggestions across the whole document, not only the beginning. Include high-value gaps in Aim rationale, model validation, perturbation design, interpretation, and expected outcomes if present. Preserve citations, field codes, formulas, figure labels, gene/method names, and technical meaning exactly. Return specific exact-source edits/comments only, not a general memo."
  },
  {
    builtIn: true,
    id: "r01-significance",
    label: "Significance",
    ariaLabel: "Use R01 Significance and Innovation prompt",
    title: "Focus this pass on Background, Significance, and Innovation",
    prompt: "Act as an NIH R01 study-section editor. Focus this pass only on the Background/scientific premise, Significance, and Innovation front matter. Propose the strongest feasible set of concrete exact-source edits that replace undeveloped placeholders such as \"Significance. This needs to be developed\", sharpen the disease/regulatory gap, strengthen the central premise and developmental model rationale, state why single-molecule chromatin dynamics matter for reviewers, and make the innovation claims specific. There is no artificial edit-count or sentence-count cap: produce as many high-confidence, reviewable section-building edits as are useful and safe. When a placeholder needs a full paragraph or subsection-level replacement, provide that replacement; split section-building into several exact-source suggestions when doing so improves Word placement or reviewer navigation. Do not rewrite methods-heavy Approach text in this pass. Preserve citation fields, formulas, figure labels, and technical meaning exactly."
  },
  {
    builtIn: true,
    id: "r01-aims",
    label: "Aims",
    ariaLabel: "Use R01 Aim alignment prompt",
    title: "Focus this pass on Aim-level alignment",
    prompt: "Act as an NIH R01 study-section editor. Focus this pass only on Aim-level alignment. Propose the strongest feasible set of concrete exact-source edits that make each Aim read as a testable claim, align rationale with approach and expected outcomes, clarify what success would prove, and remove notebook-style placeholders or vague transitions that weaken reviewer confidence. There is no artificial edit-count cap: return as many high-confidence, reviewable Aim-level edits as are useful and safe. Prefer unique, specific source-text targets over repeated short headings such as \"Rationale.\" or \"Preliminary studies.\" so Word handoff lands in the intended Aim. If a structural inconsistency needs a human decision, make the replacement itself safe for the body text and put the decision note in the rationale rather than inserting bracketed comments into the replacement. Preserve citation fields, formulas, figure labels, and technical meaning exactly."
  },
  {
    builtIn: true,
    id: "r01-integration",
    label: "Integration",
    ariaLabel: "Use R01 aim integration prompt",
    title: "Focus this pass on cross-aim boundaries and non-duplication",
    prompt: "Act as an NIH R01 study-section editor. Focus this pass only on cross-aim integration and non-duplication. Propose the strongest feasible set of concrete exact-source edits that make each Aim's role distinct, repair confusing transitions between adjacent aims, move or narrow language that makes two aims appear to test the same thing, and align expected outcomes with the specific purpose of each Aim. There is no artificial edit-count cap: return as many high-confidence, reviewable integration edits as are useful and safe. Prefer unique source-text targets spanning Aim headings, transition paragraphs, rationale openings, expected outcomes, and limitation paragraphs; when a boundary problem needs a paragraph-level replacement, keep the body text reviewer-facing and put any human decision note in the rationale rather than the replacement. Preserve citation fields, formulas, figure labels, and technical meaning exactly."
  },
  {
    builtIn: true,
    id: "r01-clarity",
    label: "Clarity",
    ariaLabel: "Use R01 reviewer clarity prompt",
    title: "Focus this pass on reviewer-facing clarity",
    prompt: "Act as an NIH R01 study-section editor. Focus this pass only on reviewer-facing clarity. Propose the strongest feasible set of concrete exact-source edits that sharpen topic sentences, transitions, and claim framing so a study-section reviewer can quickly understand the problem, the proposed test, and the expected interpretive payoff. There is no artificial edit-count cap: return as many high-confidence, reviewable clarity edits as are useful and safe. Prefer unique, specific source-text targets from ordinary body text; when a paragraph-level rewrite is needed to repair a broken transition, incomplete premise, or notebook-style placeholder, provide it and keep any human decision note in the rationale rather than the replacement. Preserve citation fields, formulas, figure labels, and technical meaning exactly."
  },
  {
    builtIn: true,
    id: "r01-approach",
    label: "Approach",
    ariaLabel: "Use R01 Approach logic prompt",
    title: "Focus this pass on aim logic and experimental approach",
    prompt: "Act as an NIH R01 study-section editor. Focus this pass only on Approach logic and feasibility. Propose the strongest feasible set of concrete exact-source edits that make each Aim testable, clarify hypotheses, align experiments with expected outcomes, strengthen model validation and perturbation interpretation, and remove notebook-style placeholders. There is no artificial edit-count cap: return as many high-confidence, reviewable Approach edits as are useful and safe. Prefer unique, specific source-text targets from method, validation, analysis, and interpretation paragraphs so Word handoff lands in the intended Aim; if a protected paragraph requires a larger synthesis, keep the body replacement reviewer-facing and put any human decision note in the rationale. Preserve citation fields, formulas, figure labels, and technical meaning exactly."
  },
  {
    builtIn: true,
    id: "r01-pitfalls",
    label: "Pitfalls",
    ariaLabel: "Use R01 pitfalls and outcomes prompt",
    title: "Focus this pass on expected outcomes, pitfalls, and alternatives",
    prompt: "Act as an NIH R01 study-section editor. Focus this pass only on expected outcomes, limitations, pitfalls, and alternative strategies. Return a balanced set of concrete exact-source edits across Aim 1, Aim 2, and Aim 3 when safe, rather than only fixing the first obvious risk paragraph. Prioritize vague expected results, blank or placeholder expected-results sections, blanket no-risk claims, missing go/no-go criteria, missing fallback assays or analyses, and interpretation plans for negative or ambiguous perturbation/model results. If an Aim contains only an expected-results heading or placeholder, replace that source text with a complete reviewer-facing expected-results, limitations, alternatives, and decision-criteria section rather than returning a note that content is missing. Spend most effort on the closing outcomes/pitfalls text before re-editing method placeholders that another Approach pass may have already covered. There is no artificial edit-count or sentence-count cap: produce as many high-confidence, reviewable outcomes-and-pitfalls edits as are useful and safe. Prefer unique, ordinary body text that can export as Word tracked changes; when a larger paragraph-level replacement is needed for reviewer coherence, provide it and use the rationale for any human decision notes. Preserve citation fields, formulas, figure labels, gene/method names, and technical terms exactly."
  },
  {
    builtIn: true,
    id: "r01-rigor",
    label: "Rigor",
    ariaLabel: "Use R01 rigor and milestones prompt",
    title: "Focus this pass on rigor, SABV, milestones, and impact",
    prompt: "Act as an NIH R01 study-section editor. Focus this pass only on Scientific Rigor, Reproducibility and Transparency; Sex as a Biological Variable; timeline/milestones; resource sharing; and Expected Milestones and Impact. Do the strongest feasible required-section revision pass with no artificial edit-count cap: return as many high-confidence, reviewable exact-source edits as are useful and safe. Replace boilerplate, thin deliverables, grammar problems, and overbroad impact language with coherent reviewer-facing R01 language. Prefer exact ordinary body text from these tail sections; when a paragraph-level replacement is needed, make the replacement self-contained and put any human decision note in the rationale rather than the replacement. Do not invent unsupported repositories, sample sizes, assays, timelines, or validation experiments. Preserve citations, fields, formulas, figure labels, timeline graphics, and technical meaning exactly."
  },
  {
    builtIn: true,
    id: "r01-body-safe",
    label: "Body-safe",
    ariaLabel: "Use R01 body-safe tracked-change prompt",
    title: "Prefer ordinary body sentences that export as tracked changes",
    prompt: "Act as a senior NIH R01 editor doing a tracked-change-safe micro-edit pass. Use the full document, but return only edits that are likely to become body tracked changes. Each original must be one complete sentence or less from ordinary body paragraphs; do not edit headings, captions, text boxes, citation fields, formulas, comments, bookmarks, bibliography/reference structures, or existing tracked-change regions. Focus on reviewer-facing clarity for premise, feasibility, alternatives, and Aim transitions. If a stronger synthesis edit would require protected Word structure, skip it and choose a nearby ordinary body sentence instead. Preserve scientific meaning, citations, figure labels, gene/method names, and technical terms exactly. Return exact-source replacement edits only."
  },
  {
    builtIn: true,
    id: "r01-word-comment-handoff",
    label: "Word comments",
    ariaLabel: "Use R01 Word-comment handoff prompt",
    title: "Use Word comments when important sections are protected",
    prompt: "Act as an NIH R01 study-section editor doing a Word-comment handoff pass for scientifically important edits that may touch protected DOCX structures. Use the full document and return exact-source suggestions on visible text from the target section, even when that text may contain citation fields, hyperlinks, comments, bookmarks, formulas, or other Word structures. These suggestions may export as Word comments rather than body tracked changes; that is acceptable. Focus on thin or protected sections where the body-safe prompt reports poor clean-source coverage. When a target Aim has lettered sub-aims such as Aim 2A, Aim 2B, and Aim 2C, state the target subsection(s) in the instruction and balance suggestions across those subsections; do not spend all suggestions on the first subsection if multiple protected source-text targets are available. Preserve citations, field codes, formulas, figure labels, gene/method names, and technical meaning exactly. Keep each replacement concise, reviewer-facing, and specific enough for Word review."
  }
];

export const r01StandaloneRoutineIds = new Set(["r01-pass", "r01-body-safe", "r01-word-comment-handoff"]);
export const generalBuiltInRoutines = builtInRoutines.filter((routine) => !isR01Routine(routine));
export const r01BuiltInRoutines = builtInRoutines.filter(isR01Routine);
export const r01RoutineSequence = builtInRoutines.filter((routine) => isR01Routine(routine) && !r01StandaloneRoutineIds.has(routine.id));

export function isR01Routine(routine: WritingRoutine): boolean {
  return routine.id.startsWith("r01-");
}
