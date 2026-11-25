/**
 * Writing style: the journal-style skill (style-turing/skills/journal-style)
 * carried into every AI request, so agents write in the register of the
 * venue instead of the terse, over-compressed prose they default to.
 *
 * The skill is found at runtime: WRITER_STYLE_SKILL_DIR, this repository's
 * style-turing/skills/journal-style, or an installed copy under
 * ~/.claude/skills or ~/.codex/skills. "general" uses the skill's general
 * method (SKILL.md); a journal or funder adds its reference file and the
 * published examples for the section the author is working in.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WRITING_STYLES, type AiRequest, type WritingStyleId } from "../src/shared";

const SKILL_NAME = "journal-style";

export function locateStyleSkill(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const configured = env.WRITER_STYLE_SKILL_DIR?.trim();
  if (configured && /^(off|none)$/i.test(configured)) {
    return null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.WRITER_STYLE_SKILL_DIR?.trim() || null,
    resolve(here, "..", "style-turing", "skills", SKILL_NAME),
    join(home, ".claude", "skills", SKILL_NAME),
    join(home, ".codex", "skills", SKILL_NAME)
  ];
  return candidates.find((dir): dir is string => Boolean(dir) && existsSync(join(dir!, "SKILL.md"))) ?? null;
}

export function isWritingStyle(value: unknown): value is WritingStyleId {
  return typeof value === "string" && WRITING_STYLES.some((style) => style.id === value);
}

/** The example file for a section heading, by venue; null when the heading names no section with examples. */
export function sectionExampleFile(style: WritingStyleId, heading: string | null): string | null {
  if (!heading) {
    return null;
  }
  const text = heading.toLowerCase();
  if (style === "nih") {
    if (/specific\s+aims?/.test(text)) return "specific-aims";
    if (/narrative|public health relevance/.test(text)) return "project-narrative";
    if (/summary|abstract/.test(text)) return "project-summary";
    return null;
  }
  if (/abstract|summary/.test(text)) return "abstract";
  if (/intro|background/.test(text)) return "introduction";
  if (/result/.test(text)) return "results";
  if (/discussion|conclusion/.test(text)) return "discussion";
  if (/method|materials|experimental procedures/.test(text)) return "methods";
  return null;
}

/** The heading the request is about: the selection's section, else the caret's. */
export function focusHeading(request: Pick<AiRequest, "mode" | "selection" | "hostContext">): string | null {
  const host = request.hostContext ?? null;
  if (!host) {
    return null;
  }
  if (request.mode === "selection" && request.selection && host.outline?.length) {
    const before = host.outline.filter((entry) => entry.offset <= request.selection!.from);
    if (before.length) {
      return before[before.length - 1].heading;
    }
  }
  return host.section?.heading ?? null;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  } catch {
    return null;
  }
}

/** Lines for the prompt: the skill, the venue's rules and the section's examples; [] when off. */
export function writingStyleLines(request: Pick<AiRequest, "writingStyle" | "mode" | "selection" | "hostContext">, skillDir: string | null = locateStyleSkill()): string[] {
  const style = request.writingStyle ?? "general";
  if (style === "off") {
    return [];
  }
  const register = "Write in the register of academic prose for this venue: full, connected sentences that keep their qualifiers, connectives and subordinate clauses. Do not compress the authors' prose into terse statements, and do not shorten a passage the instruction did not ask you to shorten.";
  if (!skillDir) {
    return ["", "Writing style:", register];
  }
  const skill = read(join(skillDir, "SKILL.md"));
  if (!skill) {
    return ["", "Writing style:", register];
  }
  const label = WRITING_STYLES.find((entry) => entry.id === style)?.label ?? style;
  const reference = style === "general" ? null : read(join(skillDir, "references", `${style}.md`));
  const heading = style === "general" ? null : focusHeading(request);
  const exampleFile = style === "general" ? null : sectionExampleFile(style, heading);
  const examples = exampleFile ? read(join(skillDir, "examples", style, `${exampleFile}.md`)) : null;
  return [
    "",
    `Writing style: ${style === "general" ? "academic prose (the skill's general method; no venue chosen)" : label}. Follow the style skill below for every sentence you write or revise. It was measured against published text and validated in blind tests; where it conflicts with your own habits, it wins. The skill files it refers to that apply here are included below; there is nothing else to open.`,
    register,
    "<<<style skill: SKILL.md",
    skill,
    ">>>",
    ...(reference ? [`<<<style skill: references/${style}.md`, reference, ">>>"] : []),
    ...(examples ? [`<<<style skill: examples/${style}/${exampleFile}.md (the section being edited: ${heading})`, examples, ">>>"] : [])
  ];
}
