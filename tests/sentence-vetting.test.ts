import { describe, expect, it } from "vitest";
import { createAgentRun, stageAgentRunSuggestionsVetted } from "../server/agent-run";
import { changedSentences, parseVerdict, splitSentences, vetEdits, vettingPrompt, type SentenceVetter, type VetSentenceInput } from "../server/sentence-vetting";
import type { AiRequest } from "../src/shared";

const DOCUMENT = "Background sentence one. Mice gained 1.5 g on the diet (Fig. 2a), as reported by Smith et al. in 2020. The effect was small. Closing sentence here.";

function request(): AiRequest {
  return { provider: "claude", instruction: "Tighten the results", mode: "global", documentHtml: `<p>${DOCUMENT}</p>`, documentText: DOCUMENT } as AiRequest;
}

describe("sentence vetting", () => {
  it("splits sentences without breaking at abbreviations, decimals or initials", () => {
    expect(splitSentences("Mice gained 1.5 g (Fig. 2a), e.g. on day 3, as Smith et al. found. J. Doe agreed! Was it small?")).toEqual([
      "Mice gained 1.5 g (Fig. 2a), e.g. on day 3, as Smith et al. found.",
      "J. Doe agreed!",
      "Was it small?"
    ]);
  });

  it("vets only the sentences an edit adds or rewrites", () => {
    expect(changedSentences("The effect was small. Closing sentence here.", "The effect was modest and therefore causal. Closing sentence here.")).toEqual([
      "The effect was modest and therefore causal."
    ]);
  });

  it("reads a yes, a no with a reason, and treats anything else as a failed check", () => {
    expect(parseVerdict('{"verdict": "yes"}')).toEqual({ ok: true });
    expect(parseVerdict('Sure.\n{"verdict":"no","problem":"Adds a causal claim.","revision":"The effect was modest."}')).toEqual({
      ok: false, problem: "Adds a causal claim.", revision: "The effect was modest."
    });
    expect(parseVerdict('{"verdict":"no"}').ok).toBeNull();
    expect(parseVerdict("looks fine").ok).toBeNull();
  });

  it("checks each changed sentence with its own call, skips comment-only edits, and keeps going past a failed check", async () => {
    const asked: VetSentenceInput[] = [];
    const vetter: SentenceVetter = async (input) => {
      asked.push(input);
      if (input.sentence.includes("therefore")) {
        return { ok: false, problem: "The data do not show causation.", revision: "The effect was modest." };
      }
      if (input.sentence.includes("crash")) {
        throw new Error("CLI exited 1");
      }
      return { ok: true };
    };
    const results = await vetEdits([
      { original: "The effect was small.", replacement: "The effect was modest and therefore causal. It replicated." },
      { original: "Closing sentence here.", replacement: "Closing sentence here.", commentOnly: true },
      { original: "Background sentence one.", replacement: "A crash sentence." }
    ], { instruction: "Tighten", documentText: DOCUMENT, vetter });
    expect(asked.map((input) => input.sentence)).toEqual(["The effect was modest and therefore causal.", "It replicated.", "A crash sentence."]);
    expect(asked[0].contextBefore).toContain("Mice gained 1.5 g");
    expect(asked[0].contextAfter).toContain("Closing sentence here.");
    expect(vettingPrompt(asked[0])).toContain("Sentence to vet");
    expect(results[0]).toEqual({ checked: 2, objections: [{ sentence: "The effect was modest and therefore causal.", problem: "The data do not show causation.", revision: "The effect was modest." }], failures: [] });
    expect(results[1]).toEqual({ checked: 0, objections: [], failures: [] });
    expect(results[2].failures).toEqual(["CLI exited 1"]);
  });

  it("sends a flagged edit back with its objections, then stages it with the open concern on its second round", async () => {
    const run = createAgentRun(request());
    const vetter: SentenceVetter = async (input) => (input.sentence.includes("causal")
      ? { ok: false, problem: "The data do not show causation.", revision: "The effect was modest." }
      : { ok: true });
    const flagged = { title: "Tighten", original: "The effect was small.", replacement: "The effect was modest and causal.", rationale: "Shorter." };
    const clean = { title: "Close", original: "Closing sentence here.", replacement: "Closing sentence.", rationale: "Shorter." };

    const first = await stageAgentRunSuggestionsVetted(run, [flagged, clean], { vetter });
    expect(first.results[0].staged).toBe(false);
    expect(first.results[0].reason).toContain("The data do not show causation.");
    expect(first.results[0].reason).toContain('Suggested: "The effect was modest."');
    expect(first.results[1].staged).toBe(true);
    expect(first.vetting).toEqual({ sentencesChecked: 2, flagged: 1 });
    expect(run.activity.map((entry) => entry.summary)).toContain("Vetting: 2 sentences checked, 1 flagged and sent back for revision");

    const second = await stageAgentRunSuggestionsVetted(run, [flagged], { vetter });
    expect(second.results[0].staged).toBe(true);
    expect(second.results[0].note).toContain("objections still open");
    const card = run.staged.find((suggestion) => suggestion.original === flagged.original);
    expect(card?.rationale).toContain("Vetting concern not resolved");

    const revised = await stageAgentRunSuggestionsVetted(run, [{ ...clean, original: "Background sentence one.", replacement: "Background." }], { vetter });
    expect(revised.results[0].staged).toBe(true);
    expect(run.staged.every((suggestion) => suggestion.original !== "Background sentence one." || !suggestion.rationale.includes("Vetting"))).toBe(true);
  });
});

describe("sentence vetting in an agent run", () => {
  it("sends a flagged sentence back through the real staging route, and the agent's corrected edit is staged", async () => {
    const { createServer } = await import("node:http");
    const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createWriterApp } = await import("../server/app");
    const app = createWriterApp();
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const saved = { port: process.env.WRITER_SIDECAR_PORT, allow: process.env.WRITER_ALLOW_CLI, claude: process.env.WRITER_CLAUDE_PATH, vetting: process.env.WRITER_SENTENCE_VETTING };
    process.env.WRITER_SIDECAR_PORT = String(port);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_SENTENCE_VETTING = "on";
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-vetting-fake-"));
    // One stand-in for both roles: called with --system-prompt it is the
    // vetter (no to any "therefore", yes otherwise); called with --mcp-config
    // it is the agent, which stages, reads the objection and stages again.
    const fake = join(tempDir, "fake-claude");
    writeFileSync(fake, [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--system-prompt")) {',
      '  const prompt = fs.readFileSync(0, "utf8");',
      '  const sentence = prompt.split("Sentence to vet (from the proposed replacement):\\n<<<")[1] ?? "";',
      '  const verdict = sentence.includes("therefore") ? { verdict: "no", problem: "Claims causation the data do not show.", revision: "Enrollment may limit power." } : { verdict: "yes" };',
      '  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(verdict) }) + "\\n");',
      "  process.exit(0);",
      "}",
      'const config = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));',
      "const runUrl = config.mcpServers.writer.env.WRITER_AGENT_RUN_URL;",
      'const stage = (replacement) => fetch(`${runUrl}/stage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestions: [{ title: "Qualify", original: "The sample size is adequate.", replacement, rationale: "Reviewer concern." }] }) }).then((r) => r.json());',
      'let outcome = await stage("The sample size is small and therefore underpowered.");',
      'const reason = outcome.results[0].reason ?? "";',
      'if (!outcome.results[0].staged && reason.includes("Combine")) outcome = await stage(reason.match(/Suggested: \\"([^\\"]+)\\"/)[1]);',
      'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-sess" }) + "\\n");',
      'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `Staged ${outcome.stagedCount}.`, session_id: "fake-sess" }) + "\\n");'
    ].join("\n"), "utf8");
    chmodSync(fake, 0o755);
    process.env.WRITER_CLAUDE_PATH = fake;
    try {
      const { proposeChanges } = await import("../server/ai");
      const response = await proposeChanges({
        provider: "claude", instruction: "Address the sample size concern", mode: "global", documentHtml: "",
        documentText: "Our study enrolls participants. The sample size is adequate.", selection: null
      });
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0].replacement).toBe("Enrollment may limit power.");
      const steps = (response.activity ?? []).map((entry) => entry.summary);
      expect(steps).toContain("Vetting: 1 sentence checked, 1 flagged and sent back for revision");
      expect(steps).toContain("Vetting: 1 sentence checked, all sound");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
      for (const [key, value] of [["WRITER_SIDECAR_PORT", saved.port], ["WRITER_ALLOW_CLI", saved.allow], ["WRITER_CLAUDE_PATH", saved.claude], ["WRITER_SENTENCE_VETTING", saved.vetting]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 30_000);
});
