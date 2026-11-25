// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCliPrompt } from "../server/ai";
import { focusHeading, locateStyleSkill, sectionExampleFile, writingStyleLines } from "../server/writing-style";
import type { AiRequest, WordHostContext } from "../src/shared";

const skill = mkdtempSync(join(tmpdir(), "writer-style-skill-"));
mkdirSync(join(skill, "references"));
mkdirSync(join(skill, "examples", "nature-genetics"), { recursive: true });
writeFileSync(join(skill, "SKILL.md"), "---\nname: journal-style\n---\n\n# Writing like a published paper\n\nAssemble, do not paraphrase.\n");
writeFileSync(join(skill, "references", "nature-genetics.md"), "# Nature Genetics\n\nCommas: about 1.7 per sentence.\n");
writeFileSync(join(skill, "examples", "nature-genetics", "results.md"), "# Nature Genetics: published Results paragraphs\n\nExample paragraph.\n");
afterAll(() => rmSync(skill, { recursive: true, force: true }));

const host = (heading: string, outline: Array<{ heading: string; offset: number }> = []) => ({
  section: { heading, level: 1, paragraphIndex: 3, offset: 40 },
  outline: outline.map((entry, index) => ({ ...entry, level: 1, paragraphIndex: index }))
}) as unknown as WordHostContext;

describe("writing style", () => {
  it("finds the skill where it is configured, and can be turned off", () => {
    expect(locateStyleSkill({ WRITER_STYLE_SKILL_DIR: skill }, "/nonexistent")).toBe(skill);
    expect(locateStyleSkill({ WRITER_STYLE_SKILL_DIR: "off" }, "/nonexistent")).toBeNull();
  });

  it("maps section headings to example files per venue", () => {
    expect(sectionExampleFile("nature-genetics", "3. Results")).toBe("results");
    expect(sectionExampleFile("science", "Materials and Methods")).toBe("methods");
    expect(sectionExampleFile("nih", "Specific Aims")).toBe("specific-aims");
    expect(sectionExampleFile("nih", "Project Narrative")).toBe("project-narrative");
    expect(sectionExampleFile("nih", "Approach")).toBeNull();
  });

  it("takes the selection's section from the outline, else the caret's", () => {
    const context = host("Discussion", [{ heading: "Introduction", offset: 0 }, { heading: "Results", offset: 100 }, { heading: "Discussion", offset: 300 }]);
    expect(focusHeading({ mode: "selection", selection: { from: 150, to: 180, text: "x" }, hostContext: context })).toBe("Results");
    expect(focusHeading({ mode: "global", selection: null, hostContext: context })).toBe("Discussion");
  });

  it("carries the skill, the venue's rules and the section's examples into the prompt", () => {
    const lines = writingStyleLines({ writingStyle: "nature-genetics", mode: "global", selection: null, hostContext: host("Results") }, skill).join("\n");
    expect(lines).toContain("Writing style: Nature Genetics");
    expect(lines).toContain("Do not compress the authors' prose into terse statements");
    expect(lines).toContain("Assemble, do not paraphrase.");
    expect(lines).not.toContain("name: journal-style");
    expect(lines).toContain("Commas: about 1.7 per sentence.");
    expect(lines).toContain("examples/nature-genetics/results.md (the section being edited: Results)");
    const general = writingStyleLines({ writingStyle: null, mode: "global", selection: null, hostContext: host("Results") }, skill).join("\n");
    expect(general).toContain("the skill's general method");
    expect(general).not.toContain("Commas: about 1.7");
    expect(writingStyleLines({ writingStyle: "off", mode: "global", selection: null, hostContext: null }, skill)).toEqual([]);
    // Without the skill installed, the register instruction still applies.
    expect(writingStyleLines({ writingStyle: "nature", mode: "global", selection: null, hostContext: null }, null).join("\n")).toContain("full, connected sentences");
  });

  it("puts the style into the one-shot prompt", () => {
    const previous = process.env.WRITER_STYLE_SKILL_DIR;
    process.env.WRITER_STYLE_SKILL_DIR = skill;
    try {
      const prompt = buildCliPrompt({ provider: "codex", instruction: "Tighten", mode: "global", documentHtml: "", documentText: "Text.", writingStyle: "nature-genetics" } as AiRequest);
      expect(prompt).toContain("Commas: about 1.7 per sentence.");
      expect(prompt.indexOf("Writing style: Nature Genetics")).toBeLessThan(prompt.indexOf("Instruction: Tighten"));
    } finally {
      process.env.WRITER_STYLE_SKILL_DIR = previous;
    }
  });
});
