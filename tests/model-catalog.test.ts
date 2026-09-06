// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeModelLabel,
  describeModelOptions,
  extractClaudeModelIds,
  getProviderCatalog,
  modelCliArgs,
  parseClaudeHelp,
  parseClaudeSettingsDefaults,
  parseCodexConfigDefaults,
  parseCodexModelCatalog,
  rankClaudeModelIds,
  scanFileForClaudeModelIds,
  sortReasoning,
  validateModelOptions
} from "../server/model-catalog";
import { buildAgentClaudeArgs, buildAgentCodexArgs } from "../server/agent-runtime";
import { buildCliArgs } from "../server/ai";

const CLAUDE_HELP = `
Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]                  Enable debug mode with optional
                                        category filtering
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session that runs on
                                        the given self-hosted environment
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
  -p, --print                           Print response and exit

Commands:
  agents [options]                      Manage background agents
`;

const CODEX_CATALOG = {
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Reliable agentic workhorse for everyday tasks.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses" },
        { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Deeper" },
        { effort: "xhigh", description: "Extra deep" },
        { effort: "max", description: "Maximum" },
        { effort: "ultra", description: "Maximum with delegation" }
      ],
      visibility: "list",
      priority: 1
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
      visibility: "list"
    },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "bad slug!", display_name: "nope" }
  ]
};

describe("model options validation and CLI arguments", () => {
  it("accepts well-formed model and reasoning ids and rejects the rest", () => {
    expect(validateModelOptions(undefined)).toEqual({ modelOptions: null });
    expect(validateModelOptions({})).toEqual({ modelOptions: null });
    expect(validateModelOptions({ model: "  ", reasoning: "" })).toEqual({ modelOptions: null });
    expect(validateModelOptions({ model: "claude-fable-5-1[1m]", reasoning: "xhigh" })).toEqual({ modelOptions: { model: "claude-fable-5-1[1m]", reasoning: "xhigh" } });
    expect(validateModelOptions({ model: "gpt-5.6-terra" })).toEqual({ modelOptions: { model: "gpt-5.6-terra", reasoning: null } });
    expect(validateModelOptions({ model: 'x"; rm -rf /' })).toHaveProperty("error");
    expect(validateModelOptions({ reasoning: "High" })).toHaveProperty("error");
    expect(validateModelOptions({ model: 5 })).toHaveProperty("error");
    expect(validateModelOptions("opus")).toHaveProperty("error");
  });

  it("maps options onto each CLI's flags", () => {
    expect(modelCliArgs("claude", null)).toEqual([]);
    expect(modelCliArgs("claude", { model: "opus", reasoning: "max" })).toEqual(["--model", "opus", "--effort", "max"]);
    expect(modelCliArgs("claude", { reasoning: "low" })).toEqual(["--effort", "low"]);
    expect(modelCliArgs("codex", { model: "gpt-5.5", reasoning: "high" })).toEqual(["-m", "gpt-5.5", "-c", 'model_reasoning_effort="high"']);
    expect(describeModelOptions({ model: "gpt-5.5", reasoning: "xhigh" })).toBe("gpt-5.5 · extra high");
    expect(describeModelOptions(null)).toBe("");
  });

  it("threads the override through the one-shot and agentic argument builders", () => {
    const oneShotCodex = buildCliArgs("codex", "/tmp/schema.json", { model: "gpt-5.6-terra", reasoning: "high" });
    expect(oneShotCodex.slice(0, 8)).toEqual(["exec", "--json", "-c", 'service_tier="fast"', "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="high"']);
    expect(oneShotCodex[oneShotCodex.length - 1]).toBe("-");
    expect(buildCliArgs("codex", "/tmp/schema.json")).not.toContain("-m");

    const oneShotClaude = buildCliArgs("claude", undefined, { model: "sonnet", reasoning: "medium" });
    expect(oneShotClaude.slice(0, 5)).toEqual(["-p", "--model", "sonnet", "--effort", "medium"]);

    const agentClaude = buildAgentClaudeArgs("go", "/tmp/mcp.json", "sess-1", { model: "opus", reasoning: "xhigh" });
    expect(agentClaude).toContain("--model");
    expect(agentClaude[agentClaude.indexOf("--model") + 1]).toBe("opus");
    expect(agentClaude.slice(-2)).toEqual(["--resume", "sess-1"]);
    expect(buildAgentClaudeArgs("go", "/tmp/mcp.json", null)).not.toContain("--effort");

    const agentCodex = buildAgentCodexArgs("go", "http://x", "/work", null, { model: "gpt-5.5", reasoning: "low" });
    expect(agentCodex[agentCodex.length - 1]).toBe("go");
    expect(agentCodex).toContain('model_reasoning_effort="low"');
    expect(agentCodex[agentCodex.indexOf("-m") + 1]).toBe("gpt-5.5");
  });
});

describe("Claude Code discovery", () => {
  it("reads aliases, example models, and effort levels from --help", () => {
    const info = parseClaudeHelp(CLAUDE_HELP);
    expect(info.supportsModel).toBe(true);
    expect(info.supportsEffort).toBe(true);
    expect(info.aliases).toEqual(["fable", "opus", "sonnet"]);
    expect(info.exampleModels).toEqual(["claude-fable-5"]);
    expect(info.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(parseClaudeHelp("Usage: claude\n  -p, --print  Print").supportsEffort).toBe(false);
  });

  it("ranks binary model ids newest-first and drops dated duplicates and old generations", () => {
    const ids = extractClaudeModelIds([
      "xx claude-sonnet-4-5 yy claude-opus-4-1-20250805 claude-opus-4-1 claude-fable-5-1 claude-sonnet-3-7",
      "claude-haiku-4-5-20251001 claude-opus-5 claude-sonnet-5 claude-fable-5 claude-opus-4-20250514-v1"
    ].join(" "));
    expect(ids).toContain("claude-fable-5-1");
    const ranked = rankClaudeModelIds(ids);
    expect(ranked[0]).toBe("claude-fable-5-1");
    expect(ranked.slice(0, 4)).toEqual(["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(ranked).not.toContain("claude-opus-4-1-20250805"); // undated twin exists
    expect(ranked).toContain("claude-haiku-4-5-20251001"); // only a dated form exists
    expect(ranked).not.toContain("claude-sonnet-3-7");
    // A dated snapshot is a date, not a minor version.
    expect(extractClaudeModelIds("claude-opus-4-20250514 claude-opus-4")).toEqual(["claude-opus-4-20250514", "claude-opus-4"]);
    expect(rankClaudeModelIds(["claude-opus-4-20250514", "claude-opus-4"])).toEqual(["claude-opus-4"]);
    expect(claudeModelLabel("claude-opus-4-20250514")).toBe("Claude Opus 4 (20250514)");
    expect(claudeModelLabel("claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(claudeModelLabel("claude-fable-5-1[1m]")).toBe("Claude Fable 5.1 · 1M");
    expect(claudeModelLabel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5 (20251001)");
    expect(claudeModelLabel("opus")).toBe("opus");
  });

  it("scans a file for model ids across chunk boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nebula-catalog-"));
    const path = join(dir, "fake-binary");
    const filler = Buffer.alloc(4 * 1024 * 1024 - 10, 0);
    writeFileSync(path, Buffer.concat([Buffer.from(" claude-opus-5 "), filler, Buffer.from("claude-sonnet-4-5-20250929 tail")]));
    const ids = await scanFileForClaudeModelIds(path);
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-5", "claude-sonnet-4-5-20250929"]));
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads defaults from settings.json", () => {
    expect(parseClaudeSettingsDefaults('{"model":"claude-fable-5-1[1m]","effortLevel":"xhigh"}')).toEqual({ model: "claude-fable-5-1[1m]", reasoning: "xhigh" });
    expect(parseClaudeSettingsDefaults("not json")).toEqual({ model: null, reasoning: null });
  });
});

describe("Codex discovery", () => {
  it("parses the model catalog with per-model reasoning levels", () => {
    const parsed = parseCodexModelCatalog(CODEX_CATALOG);
    expect(parsed.models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.5", "gpt-reserve"]);
    expect(parsed.models[0]).toMatchObject({ label: "GPT-5.6-Sol", source: "catalog", defaultReasoning: "low", hidden: false });
    expect(parsed.models[0].reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(parsed.models[2].hidden).toBe(true);
    expect(parsed.levels.map((level) => level.id)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(parsed.levels[0]).toMatchObject({ label: "Low", description: "Fast responses" });
    expect(parseCodexModelCatalog(CODEX_CATALOG.models).models.length).toBe(3);
    expect(parseCodexModelCatalog(null).models).toEqual([]);
  });

  it("reads defaults from config.toml without descending into tables", () => {
    expect(parseCodexConfigDefaults('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n[tui]\nmodel = "other"\n')).toEqual({ model: "gpt-5.6-sol", reasoning: "medium" });
    expect(parseCodexConfigDefaults("# nothing\n")).toEqual({ model: null, reasoning: null });
    expect(sortReasoning(["max", "low", "ultra", "custom", "high"])).toEqual(["low", "high", "max", "ultra", "custom"]);
  });
});

describe("live discovery", () => {
  const previousCodex = process.env.WRITER_CODEX_PATH;
  const previousClaude = process.env.WRITER_CLAUDE_PATH;
  afterAll(() => {
    if (previousCodex === undefined) {
      delete process.env.WRITER_CODEX_PATH;
    } else {
      process.env.WRITER_CODEX_PATH = previousCodex;
    }
    if (previousClaude === undefined) {
      delete process.env.WRITER_CLAUDE_PATH;
    } else {
      process.env.WRITER_CLAUDE_PATH = previousClaude;
    }
  });

  it("reports an unavailable CLI without throwing", async () => {
    process.env.WRITER_CODEX_PATH = "/nonexistent/codex";
    const catalog = await getProviderCatalog("codex", { refresh: true });
    expect(catalog.available).toBe(false);
    expect(catalog.models).toEqual([]);
    expect(catalog.allowsCustomModel).toBe(true);
    expect(catalog.notes.length).toBeGreaterThan(0);
  });

  it("discovers the installed CLIs when present", async () => {
    delete process.env.WRITER_CODEX_PATH;
    delete process.env.WRITER_CLAUDE_PATH;
    const [claude, codex] = await Promise.all([
      getProviderCatalog("claude", { refresh: true }),
      getProviderCatalog("codex", { refresh: true })
    ]);
    for (const catalog of [claude, codex]) {
      expect(catalog.discoveredAt).toBeTruthy();
      if (!catalog.available) {
        continue;
      }
      expect(catalog.version).toBeTruthy();
      expect(Array.isArray(catalog.models)).toBe(true);
      expect(catalog.models.every((model) => /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(model.id))).toBe(true);
      if (catalog.reasoning) {
        expect(catalog.reasoning.levels.length).toBeGreaterThan(0);
      }
    }
    // A second call is served from the cache (same binary, no refresh).
    const again = await getProviderCatalog("codex");
    expect(again.discoveredAt).toBe(codex.discoveredAt);
  }, 60_000);
});
