import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { AI_RESPONSE_SCHEMA, buildAgentTaskPrompt, buildCliArgs, buildCliPrompt, buildDocumentCoverageChunks, getAiProgress, isMissingSessionError, parseCliResponse, proposeChanges, selectFinalPayload } from "../server/ai";
import { AI_CONTEXT_CHAR_LIMIT, type AiRequest } from "../src/shared";

// One-shot pipeline coverage. Claude's interactive engine is agentic
// (tests/agent.test.ts); the one-shot pipeline remains Codex's engine (its
// non-interactive exec cancels MCP tool calls — see docs/agentic-ai.md), so
// these tests pin WRITER_AI_ENGINE=oneshot to exercise it for both
// providers. They retire together with the pipeline once Codex agentic
// clears validation.
beforeAll(() => {
  process.env.WRITER_AI_ENGINE = "oneshot";
});
afterAll(() => {
  delete process.env.WRITER_AI_ENGINE;
});

const baseRequest: AiRequest = {
  provider: "demo",
  instruction: "Make this shorter and more professional",
  mode: "selection",
  documentHtml: "<p>This is actually very wordy.</p>",
  documentText: "This is actually very wordy.",
  selection: {
    from: 1,
    to: 31,
    text: "This is actually very wordy."
  }
};

describe("proposeChanges", () => {
  it("returns a reviewable demo suggestion for selected text", async () => {
    const response = await proposeChanges(baseRequest);

    expect(response.provider).toBe("demo");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0]).toMatchObject({
      original: "This is actually very wordy.",
      target: "selection",
      range: baseRequest.selection,
      status: "pending"
    });
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("does not run local CLIs when explicitly locked", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    process.env.WRITER_ALLOW_CLI = "0";

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });

      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("WRITER_ALLOW_CLI=0");
      expect(response.message).not.toContain("Demo mode");
    } finally {
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
    }
  });

  it("includes full global documents when they fit one AI pass", () => {
    const longDocument = [
      "BEGINNING_R01_FRAME ".repeat(500),
      "MIDDLE_APPROACH_DETAIL ".repeat(500),
      "ENDING_VERTEBRATE_ANIMALS ".repeat(500)
    ].join("\n\n");
    const prompt = buildCliPrompt({
      ...baseRequest,
      provider: "codex",
      mode: "global",
      selection: null,
      documentText: longDocument
    });

    expect(prompt).not.toContain("beginning, middle, and end excerpts");
    expect(prompt).not.toContain("[Beginning excerpt]");
    expect(prompt).toContain("BEGINNING_R01_FRAME");
    expect(prompt).toContain("MIDDLE_APPROACH_DETAIL");
    expect(prompt).toContain("ENDING_VERTEBRATE_ANIMALS");
  });

  it("warns local providers away from generic repeated DOCX source-text targets", () => {
    const prompt = buildCliPrompt({
      ...baseRequest,
      provider: "codex",
      instruction: "Revise Aim 3 rationale placeholders",
      documentText: "Aim 1\nRationale.\n\nAim 3\nRationale.\nPreliminary Studies."
    });

    expect(prompt).toContain("Avoid generic repeated source-text targets");
    expect(prompt).toContain("\"Rationale.\"");
    expect(prompt).toContain("include nearby unique context in original");
  });

  it("inlines attached reference files with their sidecar paths", () => {
    const prompt = buildCliPrompt({
      ...baseRequest,
      provider: "codex",
      instruction: "Align the aims with the attached reviewer summary",
      attachments: [
        { name: "reviews.md", path: "/tmp/attachments/ab12-reviews.md", text: "Reviewer 2 wants a clearer power analysis." },
        { name: "figure.pdf", path: "/tmp/attachments/cd34-figure.pdf", text: "", truncated: false }
      ]
    });

    expect(prompt).toContain("The user attached 2 reference files.");
    expect(prompt).toContain("Attachment: reviews.md (saved at /tmp/attachments/ab12-reviews.md)");
    expect(prompt).toContain("Reviewer 2 wants a clearer power analysis.");
    expect(prompt).toContain("never from the attachments");
    expect(prompt).toContain("No text could be extracted from this file");
    // Attachments must come before the document text so the Text block stays last.
    expect(prompt.indexOf("Reviewer 2 wants")).toBeLessThan(prompt.indexOf("Text:"));
  });

  it("omits the attachment section when no files are attached", () => {
    const prompt = buildCliPrompt({ ...baseRequest, provider: "codex" });
    expect(prompt).not.toContain("reference file");
    expect(prompt).not.toContain("<<<attachment");
  });

  it("warns local providers away from DOCX image preview placeholders", () => {
    const prompt = buildCliPrompt({
      ...baseRequest,
      provider: "codex",
      instruction: "Revise final milestones",
      documentText: "DOCX image preview unavailable: EMF preserved in source DOCX Timeline of proposed work.\n\nExpected Milestones and Impact:"
    });

    expect(prompt).toContain("Do not edit Writer display metadata");
    expect(prompt).toContain("\"DOCX image preview unavailable\"");
    expect(prompt).toContain("preserved DOCX media");
  });

  it("splits over-limit global documents into contiguous complete-coverage chunks", () => {
    const fullDocument = [
      "FIRST_COVERAGE_MARKER",
      "A".repeat(1_500),
      "SECOND_COVERAGE_MARKER",
      "B".repeat(1_500),
      "THIRD_COVERAGE_MARKER"
    ].join("\n\n");
    const chunks = buildDocumentCoverageChunks(fullDocument, 1_200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(fullDocument);
    expect(chunks.every((chunk) => chunk.text.length <= 1_200)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("FIRST_COVERAGE_MARKER");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("SECOND_COVERAGE_MARKER");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("THIRD_COVERAGE_MARKER");
  });

  it("reports invalid WRITER_ALLOW_CLI values when local execution is disabled", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    process.env.WRITER_ALLOW_CLI = "enabled";

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("WRITER_ALLOW_CLI=enabled");
      expect(response.message).toContain("Use 1, true, yes, or on");
      expect(response.message).toContain("0, false, no, or off");
    } finally {
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
    }
  });

  it("reports invalid Codex override path when CLI execution is enabled", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = "/definitely/missing/codex";

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("WRITER_CODEX_PATH");
      expect(response.message).toContain("not executable");
    } finally {
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("treats WRITER_ALLOW_CLI=true as enabled for provider execution", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    process.env.WRITER_ALLOW_CLI = "true";
    process.env.WRITER_CODEX_PATH = "/definitely/missing/codex";

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("WRITER_CODEX_PATH");
      expect(response.message).toContain("not executable");
    } finally {
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("runs Codex from a relative WRITER_CODEX_PATH override", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s' '{\"message\":\"Fake Codex response\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.93}]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.message).toContain("Fake Codex response");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("runs over-limit global documents through full-coverage CLI passes", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-coverage-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    const countPath = join(tempDir, "count.txt");
    const firstOriginal = "FIRST coverage sentence is actually very wordy.";
    const secondOriginal = "SECOND coverage sentence is actually very wordy.";
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "prompt=$(cat)",
        `count_path=${JSON.stringify(countPath)}`,
        "count=$(cat \"$count_path\" 2>/dev/null || printf 0)",
        "count=$((count + 1))",
        "printf '%s' \"$count\" > \"$count_path\"",
        `if printf '%s' "$prompt" | grep -q ${JSON.stringify(firstOriginal)}; then`,
        `  printf '%s' ${JSON.stringify(`{"message":"coverage one","suggestions":[{"title":"Tighten first chunk","original":"${firstOriginal}","replacement":"FIRST coverage sentence is wordy.","rationale":"Tightens the first covered chunk.","confidence":0.91}]}`)}`,
        "  exit 0",
        "fi",
        `if printf '%s' "$prompt" | grep -q ${JSON.stringify(secondOriginal)}; then`,
        `  printf '%s' ${JSON.stringify(`{"message":"coverage two","suggestions":[{"title":"Tighten second chunk","original":"${secondOriginal}","replacement":"SECOND coverage sentence is wordy.","rationale":"Tightens the second covered chunk.","confidence":0.9}]}`)}`,
        "  exit 0",
        "fi",
        "printf '%s' '{\"message\":\"no chunk match\",\"suggestions\":[]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    const overLimitDocument = [
      firstOriginal,
      "A".repeat(AI_CONTEXT_CHAR_LIMIT + 100),
      secondOriginal
    ].join("\n");

    try {
      const response = await proposeChanges({
        ...baseRequest,
        provider: "codex",
        mode: "global",
        documentText: overLimitDocument,
        selection: null
      });

      expect(response.provider).toBe("codex");
      expect(response.message).toContain("Reviewed the full document in 2 coverage passes");
      expect(response.suggestions.map((suggestion) => suggestion.original)).toEqual([firstOriginal, secondOriginal]);
      expect(readFileSync(countPath, "utf8")).toBe("2");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("retries Codex without --output-schema when older CLIs reject the flag", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "if printf '%s\\n' \"$@\" | grep -q -- '--output-schema'; then",
        "  printf '%s\\n' \"error: unknown option '--output-schema'\" 1>&2",
        "  exit 1",
        "fi",
        "printf '%s' '{\"message\":\"Codex fallback\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.93}]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.message).toContain("Codex fallback");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("retries Claude without --json-schema when older CLIs reject the flag", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CLAUDE_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-claude-cli-"));
    const fakeClaudePath = join(tempDir, "fake-claude");
    writeFileSync(
      fakeClaudePath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "if printf '%s\\n' \"$@\" | grep -q -- '--json-schema'; then",
        "  printf '%s\\n' \"error: unknown option '--json-schema'\" 1>&2",
        "  exit 1",
        "fi",
        "printf '%s' '{\"message\":\"Claude fallback\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.91}]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeClaudePath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CLAUDE_PATH = relative(process.cwd(), fakeClaudePath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "claude" });
      expect(response.provider).toBe("claude");
      expect(response.message).toContain("Claude fallback");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CLAUDE_PATH;
      } else {
        process.env.WRITER_CLAUDE_PATH = previousOverride;
      }
    }
  });

  it("retries Claude without --tools when older CLIs reject the flag", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CLAUDE_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-claude-cli-"));
    const fakeClaudePath = join(tempDir, "fake-claude");
    writeFileSync(
      fakeClaudePath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "if printf '%s\\n' \"$@\" | grep -q -- '--tools'; then",
        "  printf '%s\\n' \"error: unknown option '--tools'\" 1>&2",
        "  exit 1",
        "fi",
        "if ! printf '%s\\n' \"$@\" | grep -q -- '--json-schema'; then",
        "  printf '%s\\n' \"expected json schema to remain enabled\" 1>&2",
        "  exit 1",
        "fi",
        "printf '%s' '{\"message\":\"Claude tools fallback\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.91}]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeClaudePath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CLAUDE_PATH = relative(process.cwd(), fakeClaudePath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "claude" });
      expect(response.provider).toBe("claude");
      expect(response.message).toContain("Claude tools fallback");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CLAUDE_PATH;
      } else {
        process.env.WRITER_CLAUDE_PATH = previousOverride;
      }
    }
  });

  it("parses structured CLI output emitted on stderr when exit code is zero", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s' '{\"message\":\"stderr response\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.93}]}' 1>&2"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.message).toContain("stderr response");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("prefers structured stderr payload when stdout only contains diagnostics", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s\\n' 'warning: using fallback telemetry endpoint'",
        "printf '%s' '{\"message\":\"stderr wins\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.93}]}' 1>&2"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.message).toContain("stderr wins");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("runs local CLIs with color, pager, and terminal effects disabled", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const previousCliColor = process.env.CLICOLOR;
    const previousPager = process.env.PAGER;
    const previousGitPager = process.env.GIT_PAGER;
    const previousTerm = process.env.TERM;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "if [ \"$NO_COLOR\" != \"1\" ] || [ \"$FORCE_COLOR\" != \"0\" ] || [ \"$CLICOLOR\" != \"0\" ] || [ \"$PAGER\" != \"cat\" ] || [ \"$GIT_PAGER\" != \"cat\" ] || [ \"$TERM\" != \"dumb\" ]; then",
        "  printf '%s\\n' \"unexpected quiet env: NO_COLOR=$NO_COLOR FORCE_COLOR=$FORCE_COLOR CLICOLOR=$CLICOLOR PAGER=$PAGER GIT_PAGER=$GIT_PAGER TERM=$TERM\" 1>&2",
        "  exit 1",
        "fi",
        "printf '%s' '{\"message\":\"quiet env\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.93}]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);
    process.env.NO_COLOR = "0";
    process.env.FORCE_COLOR = "1";
    process.env.CLICOLOR = "1";
    process.env.PAGER = "less -R";
    process.env.GIT_PAGER = "less -R";
    process.env.TERM = "xterm-256color";

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.message).toContain("quiet env");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousCliColor === undefined) {
        delete process.env.CLICOLOR;
      } else {
        process.env.CLICOLOR = previousCliColor;
      }
      if (previousPager === undefined) {
        delete process.env.PAGER;
      } else {
        process.env.PAGER = previousPager;
      }
      if (previousGitPager === undefined) {
        delete process.env.GIT_PAGER;
      } else {
        process.env.GIT_PAGER = previousGitPager;
      }
      if (previousTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previousTerm;
      }
    }
  });

  it("surfaces stdout diagnostics when CLI exits non-zero without stderr", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s\n' 'Codex auth missing: run codex login'",
        "exit 1"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("Codex auth missing: run codex login");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("surfaces stderr diagnostics when a CLI exits before reading stdin", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "exec 0<&-",
        "printf '%s\\n' 'Codex auth missing: run codex login' 1>&2",
        "exit 17"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({
        ...baseRequest,
        provider: "codex",
        mode: "global",
        documentText: "This is actually very wordy. ".repeat(2_000),
        selection: null
      });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("Codex auth missing: run codex login");
      expect(response.message).not.toContain("EPIPE");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("truncates verbose CLI failure diagnostics without losing the start or end", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('AUTH START\\n' + 'x'.repeat(6000) + '\\nAUTH END');",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("AUTH START");
      expect(response.message).toContain("provider output truncated");
      expect(response.message).toContain("AUTH END");
      expect(response.message.length).toBeLessThan(4_200);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("reports signal-based CLI termination with a clear message", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-cli-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "kill -TERM $$"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("terminated by signal SIGTERM");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("interrupts local provider processes when the request aborts", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-abort-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    const pidPath = join(tempDir, "provider.pid");
    let providerPid: number | null = null;
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        `printf '%s' "$$" > ${JSON.stringify(pidPath)}`,
        "trap '' TERM",
        "cat >/dev/null",
        "while :; do sleep 1; done"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);
    const controller = new AbortController();

    try {
      const pending = proposeChanges({ ...baseRequest, provider: "codex" }, { signal: controller.signal });
      providerPid = await waitForPidFile(pidPath, 1_000);
      controller.abort();
      const response = await pending;

      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("request was interrupted");

      await waitForProcessExit(providerPid, 2_500);
    } finally {
      killProcessIfRunning(providerPid);
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("honors WRITER_CLI_TIMEOUT_MS for local provider execution", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const previousTimeout = process.env.WRITER_CLI_TIMEOUT_MS;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-timeout-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/usr/bin/env node",
        "setInterval(() => {}, 1000);"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);
    process.env.WRITER_CLI_TIMEOUT_MS = "100";

    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex" });
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("timed out after 0.1s");
      expect(response.message).toContain("Raise it, or unset it");
      expect(response.message).toContain("WRITER_CLI_TIMEOUT_MS");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
      if (previousTimeout === undefined) {
        delete process.env.WRITER_CLI_TIMEOUT_MS;
      } else {
        process.env.WRITER_CLI_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("force-kills local provider processes that ignore SIGTERM after a timeout", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const previousTimeout = process.env.WRITER_CLI_TIMEOUT_MS;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-timeout-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    const pidPath = join(tempDir, "provider.pid");
    let providerPid: number | null = null;
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        `printf '%s' "$$" > ${JSON.stringify(pidPath)}`,
        "trap '' TERM",
        "while :; do sleep 1; done"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);
    process.env.WRITER_CLI_TIMEOUT_MS = "1500";

    try {
      const pending = proposeChanges({ ...baseRequest, provider: "codex" });
      providerPid = await waitForPidFile(pidPath, 1_000);
      const response = await pending;
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("timed out after 1.5s");

      await waitForProcessExit(providerPid, 2_500);
    } finally {
      killProcessIfRunning(providerPid);
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
      if (previousTimeout === undefined) {
        delete process.env.WRITER_CLI_TIMEOUT_MS;
      } else {
        process.env.WRITER_CLI_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("aborts local provider processes that exceed the output safety limit", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-output-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    const pidPath = join(tempDir, "provider.pid");
    let providerPid: number | null = null;
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        `printf '%s' "$$" > ${JSON.stringify(pidPath)}`,
        "trap '' TERM",
        "i=0",
        "chunk=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        // 1,000-char chunks x 2,200 = 2.2M, just past the 2M streaming-output guard.
        "chunk=\"$chunk$chunk$chunk$chunk$chunk$chunk$chunk$chunk$chunk$chunk\"",
        "while [ \"$i\" -lt 2200 ]; do printf '%s' \"$chunk\"; i=$((i + 1)); done",
        "while :; do sleep 1; done"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const pending = proposeChanges({ ...baseRequest, provider: "codex" });
      providerPid = await waitForPidFile(pidPath, 1_000);
      const response = await pending;
      expect(response.provider).toBe("codex");
      expect(response.suggestions).toHaveLength(0);
      expect(response.message).toContain("produced more than 2000000 characters on stdout");

      await waitForProcessExit(providerPid, 2_500);
    } finally {
      killProcessIfRunning(providerPid);
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("preserves line breaks in multi-paragraph demo selections", async () => {
    const response = await proposeChanges({
      ...baseRequest,
      instruction: "Make this warmer",
      selection: {
        from: 1,
        to: 80,
        text: "The first paragraph is clear.\n\nThe second paragraph is useful."
      }
    });

    expect(response.suggestions[0].replacement).toBe("This first paragraph is clear.\n\nThis second paragraph is useful.");
  });

  it("keeps exact-source CLI suggestions", () => {
    const response = parseCliResponse("codex", JSON.stringify({
      message: "One edit",
      suggestions: [
        {
          title: "Tighten sentence",
          original: "This is actually very wordy.",
          replacement: "This is wordy.",
          rationale: "Removes filler.",
          confidence: 0.9
        }
      ]
    }), baseRequest);

    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0]).toMatchObject({
      original: "This is actually very wordy.",
      replacement: "This is wordy.",
      target: "selection"
    });
  });

  it("does not impose a default CLI suggestion cap", () => {
    const suggestions = Array.from({ length: 14 }, (_, index) => ({
      title: `Tighten sentence ${index + 1}`,
      original: `This is actually very wordy sentence ${index + 1}.`,
      replacement: `This is wordy sentence ${index + 1}.`,
      rationale: "Removes filler.",
      confidence: 0.9
    }));
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Many edits",
      suggestions
    }), {
      ...baseRequest,
      provider: "codex",
      mode: "global",
      documentText: suggestions.map((suggestion) => suggestion.original).join("\n")
    });

    expect(response.suggestions).toHaveLength(14);
  });

  it("honors a user configured CLI suggestion cap", () => {
    const suggestions = Array.from({ length: 6 }, (_, index) => ({
      title: `Tighten capped sentence ${index + 1}`,
      original: `This is actually very wordy capped sentence ${index + 1}.`,
      replacement: `This is wordy capped sentence ${index + 1}.`,
      rationale: "Removes filler.",
      confidence: 0.9
    }));
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Many edits",
      suggestions
    }), {
      ...baseRequest,
      provider: "codex",
      mode: "global",
      documentText: suggestions.map((suggestion) => suggestion.original).join("\n"),
      maxSuggestions: 3
    });

    expect(response.suggestions).toHaveLength(3);
    expect(response.suggestions.map((suggestion) => suggestion.title)).toEqual([
      "Tighten capped sentence 1",
      "Tighten capped sentence 2",
      "Tighten capped sentence 3"
    ]);
  });

  it("rejects CLI suggestions that are not found in the request text", () => {
    const response = parseCliResponse("claude", JSON.stringify({
      message: "One edit",
      suggestions: [
        {
          title: "Invent sentence",
          original: "This text does not exist.",
          replacement: "This replacement is invalid.",
          rationale: "Bad anchor.",
          confidence: 0.9
        }
      ]
    }), baseRequest);

    expect(response.suggestions).toHaveLength(0);
    expect(response.message).toContain("skipped");
  });

  it("rejects CLI suggestions that drop citation markers", () => {
    const citationRequest: AiRequest = {
      ...baseRequest,
      documentText: "This is actually very wordy [@smith2020].",
      selection: {
        from: 1,
        to: 41,
        text: "This is actually very wordy [@smith2020]."
      }
    };
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Dropped citation",
      suggestions: [
        {
          title: "Tighten sentence",
          original: "This is actually very wordy [@smith2020].",
          replacement: "This is wordy.",
          rationale: "Removes filler.",
          confidence: 0.9
        }
      ]
    }), citationRequest);

    expect(response.suggestions).toHaveLength(0);
    expect(response.message).toContain("protected reference/formula text");
  });

  it("keeps CLI suggestions that preserve citation markers", () => {
    const citationRequest: AiRequest = {
      ...baseRequest,
      documentText: "This is actually very wordy [@smith2020].",
      selection: {
        from: 1,
        to: 41,
        text: "This is actually very wordy [@smith2020]."
      }
    };
    const response = parseCliResponse("claude", JSON.stringify({
      message: "Preserved citation",
      suggestions: [
        {
          title: "Tighten sentence",
          original: "This is actually very wordy [@smith2020].",
          replacement: "This is wordy [@smith2020].",
          rationale: "Removes filler while preserving the citation.",
          confidence: 0.9
        }
      ]
    }), citationRequest);

    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy [@smith2020].");
  });

  it("treats provider fill-in instructions as Word-comment handoff suggestions", () => {
    const placeholderRequest: AiRequest = {
      ...baseRequest,
      documentText: "Analysis of PRO-seq data will follow established protocols (ref).",
      selection: {
        from: 1,
        to: 65,
        text: "Analysis of PRO-seq data will follow established protocols (ref)."
      }
    };
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Citation handoff",
      suggestions: [
        {
          title: "Add PRO-seq analysis citation",
          original: "Analysis of PRO-seq data will follow established protocols (ref).",
          replacement: "Analysis of PRO-seq data will follow established protocols [PI: replace with citation to the specific PRO-seq analysis protocol or pipeline used here].",
          rationale: "Keeps the citation task explicit without inventing a reference.",
          confidence: 0.96
        }
      ]
    }), placeholderRequest);

    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0]).toMatchObject({
      commentOnly: true,
      title: "Add PRO-seq analysis citation"
    });
  });

  it("rejects CLI suggestions that drop LaTeX citation and reference commands", () => {
    const latexReferenceRequest: AiRequest = {
      ...baseRequest,
      documentText: "This is actually very wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}.",
      selection: {
        from: 1,
        to: 80,
        text: "This is actually very wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}."
      }
    };
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Dropped LaTeX references",
      suggestions: [
        {
          title: "Tighten sentence",
          original: "This is actually very wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}.",
          replacement: "This is wordy and follows the loss equation.",
          rationale: "Removes filler.",
          confidence: 0.87
        }
      ]
    }), latexReferenceRequest);

    expect(response.suggestions).toHaveLength(0);
    expect(response.message).toContain("protected reference/formula text");
  });

  it("keeps CLI suggestions that preserve LaTeX citation and reference commands", () => {
    const latexReferenceRequest: AiRequest = {
      ...baseRequest,
      documentText: "This is actually very wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}.",
      selection: {
        from: 1,
        to: 80,
        text: "This is actually very wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}."
      }
    };
    const response = parseCliResponse("claude", JSON.stringify({
      message: "Preserved LaTeX references",
      suggestions: [
        {
          title: "Tighten sentence",
          original: "This is actually very wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}.",
          replacement: "This is wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}.",
          rationale: "Removes filler while preserving references.",
          confidence: 0.9
        }
      ]
    }), latexReferenceRequest);

    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy \\citep{smith2020} and follows Eq. \\eqref{eq:loss}.");
  });

  it("rejects CLI suggestions that drop inline formula tokens", () => {
    const formulaRequest: AiRequest = {
      ...baseRequest,
      documentText: "The energy is $E=mc^2$ in this model.",
      selection: {
        from: 1,
        to: 40,
        text: "The energy is $E=mc^2$ in this model."
      }
    };
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Dropped formula",
      suggestions: [
        {
          title: "Tighten formula sentence",
          original: "The energy is $E=mc^2$ in this model.",
          replacement: "The energy appears in this model.",
          rationale: "Smooths the sentence.",
          confidence: 0.86
        }
      ]
    }), formulaRequest);

    expect(response.suggestions).toHaveLength(0);
    expect(response.message).toContain("protected reference/formula text");
  });

  it("rejects no-op CLI suggestions", () => {
    const response = parseCliResponse("codex", JSON.stringify({
      suggestions: [
        {
          original: "This is actually very wordy.",
          replacement: "This is actually very wordy."
        }
      ]
    }), baseRequest);

    expect(response.suggestions).toHaveLength(0);
  });

  it("truncates verbose unparseable CLI responses", () => {
    const response = parseCliResponse("codex", `MALFORMED START\n${"x".repeat(6000)}\nMALFORMED END`, baseRequest);

    expect(response.suggestions).toHaveLength(0);
    expect(response.message).toContain("MALFORMED START");
    expect(response.message).toContain("provider output truncated");
    expect(response.message).toContain("MALFORMED END");
    expect(response.message.length).toBeLessThanOrEqual(4_000);
  });

  it("parses Codex JSONL response envelopes", () => {
    const wrapped = [
      JSON.stringify({ type: "response.created", response: { id: "abc123" } }),
      JSON.stringify({
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    message: "Wrapped response",
                    suggestions: [
                      {
                        title: "Tighten sentence",
                        original: "This is actually very wordy.",
                        replacement: "This is wordy.",
                        rationale: "Removes filler.",
                        confidence: 0.91
                      }
                    ]
                  })
                }
              ]
            }
          ]
        }
      })
    ].join("\n");

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("Wrapped response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses Codex JSON-RPC item/completed envelopes", () => {
    const wrapped = JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          text: JSON.stringify({
            message: "JSON-RPC completed response",
            suggestions: [
              {
                title: "Tighten sentence",
                original: "This is actually very wordy.",
                replacement: "This is wordy.",
                rationale: "Removes filler.",
                confidence: 0.9
              }
            ]
          })
        }
      }
    });

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("JSON-RPC completed response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses SSE data events that wrap JSON envelopes", () => {
    const wrapped = [
      "event: response.created",
      "data: {\"type\":\"response.created\"}",
      "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"{\\\"message\\\":\\\"SSE response\\\",\\\"suggestions\\\":[{\\\"title\\\":\\\"Tighten sentence\\\",\\\"original\\\":\\\"This is actually very wordy.\\\",\\\"replacement\\\":\\\"This is wordy.\\\",\\\"rationale\\\":\\\"Removes filler.\\\",\\\"confidence\\\":0.9}]}\"}]}]}}",
      "data: [DONE]"
    ].join("\n");

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("SSE response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses SSE data events that deliver JSON arrays", () => {
    const wrapped = [
      "event: response.output_item.done",
      "data: [{\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"{\\\"message\\\":\\\"SSE array response\\\",\\\"suggestions\\\":[{\\\"title\\\":\\\"Tighten sentence\\\",\\\"original\\\":\\\"This is actually very wordy.\\\",\\\"replacement\\\":\\\"This is wordy.\\\",\\\"rationale\\\":\\\"Removes filler.\\\",\\\"confidence\\\":0.9}]}\"}]}}]",
      "data: [DONE]"
    ].join("\n");

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("SSE array response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses CLI output with ANSI color prefixes", () => {
    const raw = [
      "\u001b[33mwarning: local telemetry unavailable\u001b[0m",
      JSON.stringify({
        message: "ANSI response",
        suggestions: [
          {
            title: "Tighten sentence",
            original: "This is actually very wordy.",
            replacement: "This is wordy.",
            rationale: "Removes filler.",
            confidence: 0.9
          }
        ]
      })
    ].join("\n");

    const response = parseCliResponse("claude", raw, baseRequest);

    expect(response.message).toContain("ANSI response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("reconstructs Codex JSONL delta chunks into a structured response", () => {
    const wrapped = [
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "{\"message\":\"Delta response\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\","
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.92}]}"
      }),
      JSON.stringify({ type: "response.output_text.done" })
    ].join("\n");

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("Delta response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("reconstructs Codex JSON-RPC delta chunks into a structured response", () => {
    const wrapped = [
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          delta: "{\"message\":\"JSON-RPC delta\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\","
        }
      }),
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          delta: "\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.92}]}"
        }
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          item: { type: "agentMessage", text: "" }
        }
      })
    ].join("\n");

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("JSON-RPC delta");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses Codex JSONL events when lines include log prefixes", () => {
    const wrapped = [
      "INFO codex stream: " + JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            message: "Prefixed event response",
            suggestions: [
              {
                title: "Tighten sentence",
                original: "This is actually very wordy.",
                replacement: "This is wordy.",
                rationale: "Removes filler.",
                confidence: 0.9
              }
            ]
          })
        }
      }),
      JSON.stringify({ type: "turn.completed" })
    ].join("\n");

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("Prefixed event response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses Codex JSONL events when prefixes start with bracketed tokens", () => {
    const wrapped = [
      "[codex] INFO stream: " + JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            message: "Bracketed prefix response",
            suggestions: [
              {
                title: "Tighten sentence",
                original: "This is actually very wordy.",
                replacement: "This is wordy.",
                rationale: "Removes filler.",
                confidence: 0.9
              }
            ]
          })
        }
      }),
      JSON.stringify({ type: "turn.completed" })
    ].join("\n");

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("Bracketed prefix response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses CLI output when diagnostics and payload JSON share one line", () => {
    const payload = JSON.stringify({
      message: "Mixed JSON response",
      suggestions: [
        {
          title: "Tighten sentence",
          original: "This is actually very wordy.",
          replacement: "This is wordy.",
          rationale: "Removes filler.",
          confidence: 0.9
        }
      ]
    });
    const wrapped = `INFO {"event":"started","provider":"codex"} ${payload} {"elapsedMs":42}`;

    const response = parseCliResponse("codex", wrapped, baseRequest);

    expect(response.message).toContain("Mixed JSON response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("reconstructs Claude SSE text_delta chunks into a structured response", () => {
    const payload = JSON.stringify({
      message: "Claude delta",
      suggestions: [
        {
          title: "Tighten sentence",
          original: "This is actually very wordy.",
          replacement: "This is wordy.",
          rationale: "Removes filler.",
          confidence: 0.87
        }
      ]
    });
    const splitIndex = payload.indexOf("\"replacement\"");
    const chunkA = payload.slice(0, splitIndex);
    const chunkB = payload.slice(splitIndex);
    const wrapped = [
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: chunkA } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: chunkB } })}`,
      "data: {\"type\":\"message_stop\"}",
      "data: [DONE]"
    ].join("\n");

    const response = parseCliResponse("claude", wrapped, baseRequest);

    expect(response.message).toContain("Claude delta");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("parses Claude-style nested content payloads", () => {
    const wrapped = JSON.stringify({
      type: "assistant_message",
      message: {
        content: [
          {
            type: "text",
            text: "```json\n{\"message\":\"Claude envelope\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.88}]}\n```"
          }
        ]
      }
    });

    const response = parseCliResponse("claude", wrapped, baseRequest);

    expect(response.message).toContain("Claude envelope");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].original).toBe("This is actually very wordy.");
  });

  it("parses Claude JSON metadata envelopes with structured_output", () => {
    const wrapped = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "session-123",
      structured_output: {
        message: "Structured response",
        suggestions: [
          {
            title: "Tighten sentence",
            original: "This is actually very wordy.",
            replacement: "This is wordy.",
            rationale: "Removes filler.",
            confidence: 0.89
          }
        ]
      }
    });

    const response = parseCliResponse("claude", wrapped, baseRequest);

    expect(response.message).toContain("Structured response");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("runs Codex CLI with a structured output schema file", () => {
    const args = buildCliArgs("codex", "/tmp/ai-response.schema.json");

    expect(args).toEqual([
      "exec",
      "--json",
      "-c",
      'service_tier="fast"',
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      "/tmp/ai-response.schema.json",
      "-"
    ]);
  });

  it("parses the structured reply out of Codex exec --json event lines", () => {
    const request: AiRequest = { ...baseRequest, provider: "codex", documentText: "The results were very unique.", documentHtml: "<p>The results were very unique.</p>", mode: "global", selection: null };
    const payload = { message: "Tightened one phrase.", suggestions: [{ title: "Drop the intensifier", original: "very unique", replacement: "unique", rationale: "Unique is absolute.", confidence: 0.9 }] };
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "**Scanning the sentence**\n\nOne intensifier." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })
    ].join("\n");

    const response = parseCliResponse("codex", raw, request);

    expect(response.message).toContain("Tightened one phrase.");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("unique");
  });

  it("takes the final answer, not a schema-shaped preamble, from Codex event lines", () => {
    const request: AiRequest = { ...baseRequest, provider: "codex", documentText: "The results were very unique.", documentHtml: "<p>The results were very unique.</p>", mode: "global", selection: null };
    const preamble = { message: "I'll assess this as a Pioneer Award essay, check the review criteria, and propose edits.", suggestions: [] };
    const answer = { message: "## Verdict\nNot yet a 1-2: the premise is asserted, not argued.", suggestions: [{ title: "Drop the intensifier", original: "very unique", replacement: "unique", rationale: "Unique is absolute.", confidence: 0.9 }] };
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(preamble) } }),
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "NIH Pioneer Award review criteria" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } }),
      JSON.stringify({ type: "turn.completed", usage: {} })
    ].join("\n");

    const response = parseCliResponse("codex", raw, request);
    expect(response.message).toContain("Not yet a 1-2");
    expect(response.suggestions).toHaveLength(1);

    // A pure question: the last payload wins even without suggestions.
    const verdictOnly = { message: "I would score this a 3. To reach a 2, argue the premise.", suggestions: [] };
    const questionRaw = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(preamble) } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdictOnly) } })
    ].join("\n");
    expect(parseCliResponse("codex", questionRaw, request).message).toContain("score this a 3");
    expect(selectFinalPayload([answer, { message: "Done.", suggestions: [] }])).toBe(answer);
  });

  it("leaves a transcript of each one-shot run for diagnosis", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const previousTranscripts = process.env.WRITER_CLI_TRANSCRIPTS;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-transcript-"));
    const transcriptDir = join(tempDir, "transcripts");
    const fakeCodexPath = join(tempDir, "fake-codex");
    const payload = { message: "Tightened one phrase.", suggestions: [{ title: "Drop the intensifier", original: "very unique", replacement: "unique", rationale: "Unique is absolute.", confidence: 0.9 }] };
    writeFileSync(
      fakeCodexPath,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('codex: warming up\\n');",
        `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }))} + '\\n');`
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = fakeCodexPath;
    process.env.WRITER_CLI_TRANSCRIPTS = transcriptDir;
    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex", documentText: "The results were very unique.", documentHtml: "<p>The results were very unique.</p>", mode: "global", selection: null });
      expect(response.suggestions).toHaveLength(1);
      const files = readdirSync(transcriptDir).filter((name) => name.endsWith("-codex.log"));
      expect(files).toHaveLength(1);
      const transcript = readFileSync(join(transcriptDir, files[0]), "utf8");
      expect(transcript).toContain("# exit code: 0");
      expect(transcript).toContain("## prompt");
      expect(transcript).toContain("The results were very unique.");
      expect(transcript).toContain("## stdout");
      expect(transcript).toContain("Tightened one phrase.");
      expect(transcript).toContain("## stderr");
      expect(transcript).toContain("codex: warming up");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
      if (previousTranscripts === undefined) {
        delete process.env.WRITER_CLI_TRANSCRIPTS;
      } else {
        process.env.WRITER_CLI_TRANSCRIPTS = previousTranscripts;
      }
    }
  });

  it("asks Codex to write its final message to a file and tolerates old builds without the flag", () => {
    const args = buildCliArgs("codex", "/tmp/schema.json", null, "/tmp/last.txt");
    expect(args.slice(-3)).toEqual(["--output-last-message", "/tmp/last.txt", "-"]);
    expect(buildCliArgs("codex", "/tmp/schema.json")).not.toContain("--output-last-message");
  });

  it("parses the structured reply out of Claude stream-json event lines", () => {
    const request: AiRequest = { ...baseRequest, provider: "claude", documentText: "The results were very unique.", documentHtml: "<p>The results were very unique.</p>", mode: "global", selection: null };
    const payload = { message: "Tightened one phrase.", suggestions: [{ title: "Drop the intensifier", original: "very unique", replacement: "unique", rationale: "Unique is absolute.", confidence: 0.9 }] };
    const raw = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"message\":" } } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: payload }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: payload, session_id: "s-1" })
    ].join("\n");

    const response = parseCliResponse("claude", raw, request);

    expect(response.message).toContain("Tightened one phrase.");
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].original).toBe("very unique");
  });

  it("publishes live progress from Codex event lines while the CLI is still running", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-stream-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    const payload = { message: "Tightened one phrase.", suggestions: [{ title: "Drop the intensifier", original: "very unique", replacement: "unique", rationale: "Unique is absolute.", confidence: 0.9 }] };
    writeFileSync(
      fakeCodexPath,
      [
        "#!/usr/bin/env node",
        `const lines = ${JSON.stringify([
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({ type: "item.started", item: { type: "reasoning" } }),
          JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "**Reviewing the opening sentence**\n\nOne intensifier." } }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }),
          JSON.stringify({ type: "turn.completed", usage: {} })
        ])};`,
        "let index = 0;",
        "const tick = () => {",
        "  if (index >= lines.length) { process.exit(0); }",
        "  process.stdout.write(lines[index++] + '\\n');",
        "  setTimeout(tick, 60);",
        "};",
        "process.stdin.resume();",
        "setTimeout(tick, 20);"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_CODEX_PATH = fakeCodexPath;

    const stages: string[] = [];
    const sampler = setInterval(() => {
      const progress = getAiProgress();
      if (progress && stages[stages.length - 1] !== progress.stage) {
        stages.push(progress.stage);
      }
    }, 5);
    try {
      const response = await proposeChanges({ ...baseRequest, provider: "codex", documentText: "The results were very unique.", documentHtml: "<p>The results were very unique.</p>", mode: "global", selection: null });
      clearInterval(sampler);
      expect(response.suggestions).toHaveLength(1);
      expect(stages).toContain("Codex CLI is reading the document");
      expect(stages).toContain("Thinking");
      expect(stages).toContain("Reviewing the opening sentence");
      expect(stages.indexOf("Thinking")).toBeLessThan(stages.indexOf("Reviewing the opening sentence"));
      expect(getAiProgress()).toBeNull();
    } finally {
      clearInterval(sampler);
      rmSync(tempDir, { recursive: true, force: true });
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("runs Claude Code CLI with inline structured output schema", () => {
    const args = buildCliArgs("claude");
    const schemaArg = args[args.indexOf("--json-schema") + 1];

    expect(args).toContain("-p");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--json-schema");
    expect(JSON.parse(schemaArg)).toMatchObject({
      type: "object",
      required: ["message", "suggestions"],
      properties: {
        suggestions: {
          type: "array",
          items: {
            required: ["title", "original", "replacement", "rationale", "confidence"]
          }
        }
      }
    });
    expect("maxItems" in AI_RESPONSE_SCHEMA.properties.suggestions).toBe(false);
  });
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Provider process ${pid} was still running after ${timeoutMs}ms`);
}

async function waitForPidFile(path: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isFinite(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // The fake provider may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Provider pid file was not written after ${timeoutMs}ms`);
}

function killProcessIfRunning(pid: number | null): void {
  if (pid === null || !isProcessRunning(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can exit between the liveness check and the kill attempt.
  }
}

describe("Word window state in prompts", () => {
  const hostContext = {
    source: "word-addin" as const,
    documentName: "Aims.docx",
    capturedAt: new Date().toISOString(),
    documentLength: 4_200,
    paragraphCount: 40,
    selection: null,
    cursor: { offset: 1_800, paragraphIndex: 17, paragraphText: "We will profile 50,000 cells across six time points.", sentence: "We will profile 50,000 cells across six time points." },
    section: { heading: "Aim 1. Map accessibility dynamics.", level: 2, paragraphIndex: 15, offset: 1_700 },
    viewport: { from: 1_500, to: 2_900, pages: [3, 4], leadingText: "Aim 1. Map accessibility dynamics.", trailingText: "with CRISPRi perturbations." },
    recentFocus: [{ offset: 20, paragraphIndex: 1, excerpt: "Chromatin accessibility is a determinant", heading: "Specific Aims", at: new Date().toISOString() }],
    outline: [{ heading: "Specific Aims", level: 1, paragraphIndex: 0, offset: 0 }, { heading: "Aim 1. Map accessibility dynamics.", level: 2, paragraphIndex: 15, offset: 1_700 }],
    changeTrackingMode: "TrackAll"
  };

  it("briefs the agentic engine with the caret, section, viewport, and a read hint", () => {
    const prompt = buildAgentTaskPrompt({ ...baseRequest, mode: "global", selection: null, hostContext }, { maxSuggestions: null, attachments: [] });
    expect(prompt).toContain("Word window state");
    expect(prompt).toContain("paragraph 18 of 40");
    expect(prompt).toContain('under the heading "Aim 1. Map accessibility dynamics."');
    expect(prompt).toContain("On screen right now: pages 3-4, offsets 1,500-2,900");
    expect(prompt).toContain("writer_read_document(offset=1500, limit=1401)");
    expect(prompt).toContain("Recently paused at");
    expect(prompt).toContain("Word change tracking: TrackAll");
    expect(prompt.indexOf("Word window state")).toBeLessThan(prompt.indexOf("How to work:"));
  });

  it("adds the same briefing to the one-shot prompt without tool references", () => {
    const prompt = buildCliPrompt({ ...baseRequest, mode: "global", selection: null, hostContext });
    expect(prompt).toContain("Word window state");
    expect(prompt).toContain("Paragraph at the caret");
    expect(prompt).not.toContain("writer_read_document");
    expect(prompt.indexOf("Word window state")).toBeLessThan(prompt.indexOf("Text:"));
    expect(buildCliPrompt(baseRequest)).not.toContain("Word window state");
  });
});

describe("conversation memory in prompts", () => {
  const conversation = [
    { role: "user" as const, content: "Tighten the paragraph at my caret." },
    { role: "assistant" as const, content: "Staged one tighter version.", decisions: [{ ref: "S1", title: "Tighten Aim 2 paragraph", status: "dismissed" as const, note: "too terse" }, { ref: "S2", title: "Drop redundant word", status: "applied" as const }] },
    { role: "user" as const, content: "Try again but keep the CRISPRi mention." }
  ];

  it("gives the agent the chat and the user's decisions", () => {
    const prompt = buildAgentTaskPrompt({ ...baseRequest, mode: "global", selection: null, conversation }, { maxSuggestions: null, attachments: [] });
    expect(prompt).toContain("Conversation so far");
    expect(prompt).toContain("User: Tighten the paragraph at my caret.");
    expect(prompt).toContain('S1 "Tighten Aim 2 paragraph" — dismissed ("too terse")');
    expect(prompt).toContain('S2 "Drop redundant word" — applied');
    expect(prompt).toContain("stage a revised version rather than repeating it");
    expect(prompt.indexOf("Conversation so far")).toBeLessThan(prompt.indexOf("How to work:"));

    const resumed = buildAgentTaskPrompt({ ...baseRequest, mode: "global", selection: null, conversation, agentSessionId: "sess-1" }, { maxSuggestions: null, attachments: [] });
    expect(resumed).toContain("you have this transcript");
    expect(resumed).toContain("dismissed");

    const oneShot = buildCliPrompt({ ...baseRequest, mode: "global", selection: null, conversation });
    expect(oneShot).toContain("Conversation so far");
    expect(oneShot.indexOf("Conversation so far")).toBeLessThan(oneShot.indexOf("Text:"));
    expect(buildCliPrompt(baseRequest)).not.toContain("Conversation so far");
  });

  it("recognises a vanished provider session so the turn can restart", () => {
    expect(isMissingSessionError("No conversation found with session ID: 1234")).toBe(true);
    expect(isMissingSessionError("error: thread abc was not found")).toBe(true);
    expect(isMissingSessionError("Session has expired, please start again")).toBe(true);
    expect(isMissingSessionError("The document is 1,778 characters long.")).toBe(false);
    expect(isMissingSessionError("out of usage credits")).toBe(false);
  });
});

describe("deletions from the one-shot pipeline", () => {
  const request: AiRequest = {
    provider: "codex",
    instruction: "Cut what is redundant.",
    mode: "global",
    documentText: "Sentence one stays. For example, the residual guides model revision. Sentence three stays.",
    selection: null
  };

  it("lets the schema and the prompt express a deletion as an empty replacement", () => {
    const replacement = (AI_RESPONSE_SCHEMA.properties.suggestions.items.properties.replacement as { minLength?: number; description: string });
    expect(replacement.minLength).toBeUndefined();
    expect(replacement.description).toContain("empty string");
    expect(buildCliPrompt(request)).toContain("set replacement to an empty string");
  });

  it("keeps an explicit empty replacement as a deletion", () => {
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Cut one sentence.",
      suggestions: [{ title: "Delete the residual example", original: "For example, the residual guides model revision.", replacement: "", rationale: "Redundant.", confidence: 0.9 }]
    }), request);
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0].replacement).toBe("");
  });

  it("converts filler written in place of a deletion into a real deletion", () => {
    const response = parseCliResponse("codex", JSON.stringify({
      message: "Cut one sentence.",
      suggestions: [
        { title: "Delete the residual example", original: "For example, the residual guides model revision.", replacement: "Also, it does not seem possible for us to make it any better.", rationale: "The preceding sentences already explain this; deleting it saves words.", confidence: 0.9 },
        { title: "Tighten sentence three", original: "Sentence three stays.", replacement: "Sentence three remains.", rationale: "Tighter.", confidence: 0.8 }
      ]
    }), request);
    expect(response.suggestions).toHaveLength(2);
    expect(response.suggestions[0].replacement).toBe("");
    expect(response.suggestions[0].rationale).toContain("proposed as a deletion");
    expect(response.suggestions[1].replacement).toBe("Sentence three remains.");
  });
});

