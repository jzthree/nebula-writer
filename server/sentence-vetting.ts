/**
 * Sentence vetting: every sentence an AI edit adds or rewrites is checked on
 * its own, by a separate model call with fresh eyes, before the edit reaches
 * the review queue. Agent prose often reads well at a glance and falls apart
 * on a careful second reading (a claim the source does not support, a
 * "therefore" that does not follow, a dropped qualifier); one focused look per
 * sentence catches what a skim of the whole reply does not.
 *
 * Each check answers yes, or no with the problem and a corrected sentence.
 * Flagged edits go back to the agent, which combines the corrections into its
 * edit and stages it again (agentic runs), or to an automatic follow-up turn
 * (one-shot runs). After MAX_VETTING_ROUNDS an edit is staged with the open
 * objections in its rationale, so the author decides.
 *
 * On by default; WRITER_SENTENCE_VETTING=off turns it off.
 */

import type { AiModelOptions } from "../src/shared";

export const MAX_VETTING_ROUNDS = 2;
const DEFAULT_CONCURRENCY = 4;
const CONTEXT_CHARS = 900;

export interface VetSentenceInput {
  instruction: string;
  /** The document text around the passage (before and after), for meaning and flow. */
  contextBefore: string;
  contextAfter: string;
  original: string;
  replacement: string;
  sentence: string;
  rationale: string;
}

export type SentenceVerdict =
  | { ok: true }
  | { ok: false; problem: string; revision: string }
  /** The check itself failed (CLI error, unreadable answer): the sentence is not held back for it. */
  | { ok: null; error: string };

export type SentenceVetter = (input: VetSentenceInput, signal?: AbortSignal) => Promise<SentenceVerdict>;

export interface VettableEdit {
  original: string;
  replacement: string;
  rationale?: string;
  commentOnly?: boolean;
}

export interface SentenceObjection {
  sentence: string;
  problem: string;
  revision: string;
}

export interface EditVetting {
  /** Sentences that were checked (added or rewritten by the edit). */
  checked: number;
  objections: SentenceObjection[];
  /** Checks that could not run; their sentences were not held back. */
  failures: string[];
}

export function vettingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(env.WRITER_SENTENCE_VETTING ?? "");
}

const ABBREVIATIONS = /\b(?:Fig|Figs|fig|figs|Dr|Mr|Ms|Mrs|Prof|vs|al|approx|Eq|Eqs|Ref|Refs|No|Nos|Suppl|Supp|ca|cf|etc|St|Jr|Sr)\./g;

/** Sentences of a passage, keeping abbreviations, decimals and initials inside their sentence. */
export function splitSentences(text: string): string[] {
  const guarded = text
    .replace(ABBREVIATIONS, (match) => match.replace(/\./g, "\u0000"))
    .replace(/\b(?:e\.g|i\.e|et al)\./gi, (match) => match.replace(/\./g, "\u0000"))
    .replace(/(\d)\.(\d)/g, "$1\u0000$2")
    .replace(/\b([A-Z])\.(?=\s?[A-Z])/g, "$1\u0000");
  const parts = guarded.match(/[^.!?\n]+(?:[.!?]+["')\]”’]*|$)|\n+/g) ?? [];
  return parts
    .map((part) => part.replace(/\u0000/g, ".").trim())
    .filter((part) => /[A-Za-z0-9]/.test(part));
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The replacement's sentences that the original does not already contain word for word. */
export function changedSentences(original: string, replacement: string): string[] {
  const before = new Set(splitSentences(original).map(normalize));
  const seen = new Set<string>();
  return splitSentences(replacement).filter((sentence) => {
    const key = normalize(sentence);
    if (before.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The document around a passage, for the vetter to judge meaning and flow. */
export function passageContext(documentText: string, original: string): { before: string; after: string } {
  const at = original ? documentText.indexOf(original) : -1;
  if (at < 0) {
    return { before: "", after: "" };
  }
  return {
    before: documentText.slice(Math.max(0, at - CONTEXT_CHARS), at),
    after: documentText.slice(at + original.length, at + original.length + CONTEXT_CHARS)
  };
}

export const VETTING_SYSTEM = `You vet one sentence of a proposed revision to a document. Read it slowly and skeptically, the way a careful co-author reads on a second pass, not the way a skim makes it seem fine. Text that sounds right can still be wrong.

Check the sentence for:
1. Accuracy: it says only what the original passage and the surrounding document support. No new facts, numbers, names, citations, mechanisms or causal claims; no qualifier, hedge, condition, number or point of the original lost or changed, unless the instruction asked for that change.
2. Logic: the claim holds up. Causal and contrast words (because, therefore, thus, however, whereas, despite), comparisons, scope words (all, only, most, first), and referents (this, these, it, they) are correct and consistent with the sentences around it.
3. Language: grammatical, unambiguous, terms and notation used the way the document uses them.
4. Fit: it does what the instruction asked and reads naturally in its place.

Flag only real problems that a careful reader would want fixed, not stylistic preferences. Answer with JSON only:
{"verdict": "yes"} when the sentence is appropriate, or
{"verdict": "no", "problem": "the specific problem, in one or two sentences", "revision": "the corrected sentence, or an empty string if the sentence should be removed"}.`;

export function vettingPrompt(input: VetSentenceInput): string {
  return [
    `Instruction the edit carries out: ${input.instruction.trim() || "(none given)"}`,
    "",
    "Document text just before the passage:",
    `<<<${input.contextBefore}>>>`,
    "",
    "Original passage:",
    `<<<${input.original}>>>`,
    "",
    "Proposed replacement:",
    `<<<${input.replacement}>>>`,
    "",
    "Document text just after the passage:",
    `<<<${input.contextAfter}>>>`,
    "",
    `The editor's reason for the change: ${input.rationale.trim() || "(none given)"}`,
    "",
    "Sentence to vet (from the proposed replacement):",
    `<<<${input.sentence}>>>`
  ].join("\n");
}

/** Reads a vetter's answer; anything that is not a clear yes or a clear no with a reason is a failed check. */
export function parseVerdict(raw: string): SentenceVerdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return { ok: null, error: "no JSON in the answer" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: null, error: "unreadable JSON in the answer" };
  }
  const record = parsed as { verdict?: unknown; problem?: unknown; revision?: unknown };
  const verdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
  if (verdict === "yes") {
    return { ok: true };
  }
  if (verdict === "no" && typeof record.problem === "string" && record.problem.trim()) {
    return { ok: false, problem: record.problem.trim(), revision: typeof record.revision === "string" ? record.revision.trim() : "" };
  }
  return { ok: null, error: "the answer was neither yes nor no with a problem" };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface VetEditsOptions {
  instruction: string;
  documentText: string;
  vetter: SentenceVetter;
  concurrency?: number;
  signal?: AbortSignal;
  /** Called as checks finish: (done, total). */
  onProgress?: (done: number, total: number) => void;
}

/** Vets every changed sentence of every edit, one check per sentence, in parallel. Comment-only edits are not vetted. */
export async function vetEdits(edits: VettableEdit[], options: VetEditsOptions): Promise<EditVetting[]> {
  const jobs: Array<{ edit: number; input: VetSentenceInput }> = [];
  edits.forEach((edit, index) => {
    if (edit.commentOnly) {
      return;
    }
    const context = passageContext(options.documentText, edit.original);
    for (const sentence of changedSentences(edit.original, edit.replacement)) {
      jobs.push({
        edit: index,
        input: {
          instruction: options.instruction,
          contextBefore: context.before,
          contextAfter: context.after,
          original: edit.original,
          replacement: edit.replacement,
          sentence,
          rationale: edit.rationale ?? ""
        }
      });
    }
  });
  const results: EditVetting[] = edits.map(() => ({ checked: 0, objections: [], failures: [] }));
  let done = 0;
  options.onProgress?.(0, jobs.length);
  const verdicts = await mapLimited(jobs, options.concurrency ?? DEFAULT_CONCURRENCY, async (job) => {
    let verdict: SentenceVerdict;
    if (options.signal?.aborted) {
      verdict = { ok: null, error: "canceled" };
    } else {
      try {
        verdict = await options.vetter(job.input, options.signal);
      } catch (error) {
        verdict = { ok: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    done += 1;
    options.onProgress?.(done, jobs.length);
    return verdict;
  });
  jobs.forEach((job, index) => {
    const result = results[job.edit];
    const verdict = verdicts[index];
    result.checked += 1;
    if (verdict.ok === false) {
      result.objections.push({ sentence: job.input.sentence, problem: verdict.problem, revision: verdict.revision });
    } else if (verdict.ok === null) {
      result.failures.push(verdict.error);
    }
  });
  return results;
}

const quote = (text: string) => JSON.stringify(text.length > 400 ? `${text.slice(0, 397)}…` : text);

/** The objections as the agent receives them, to combine into a corrected edit. */
export function describeObjections(objections: SentenceObjection[]): string {
  return objections.map((objection, index) =>
    `${index + 1}) ${quote(objection.sentence)} — ${objection.problem} ${objection.revision ? `Suggested: ${quote(objection.revision)}.` : "Suggested: remove this sentence."}`
  ).join(" ");
}

/** What the author sees on a card whose objections were not resolved in vetting. */
export function unresolvedNote(objections: SentenceObjection[]): string {
  return `Vetting concern${objections.length === 1 ? "" : "s"} not resolved: ${objections.map((objection) => `${quote(objection.sentence)}: ${objection.problem}`).join(" ")}`;
}

export interface VettingCliRunner {
  (prompt: string, system: string, modelOptions: AiModelOptions | null, signal?: AbortSignal): Promise<string>;
}

/** A vetter that asks a model CLI, one sentence per call. */
export function cliSentenceVetter(run: VettingCliRunner, modelOptions: AiModelOptions | null): SentenceVetter {
  return async (input, signal) => parseVerdict(await run(vettingPrompt(input), VETTING_SYSTEM, modelOptions, signal));
}
