// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildAgentCodexArgs } from "../server/agent-runtime";
import { codexServiceTierArg, describeModelOptions, parseCodexModelCatalog, validateModelOptions } from "../server/model-catalog";

describe("Codex speed tiers", () => {
  it("reads each model's speed tiers from the catalog, labelled by its service tiers", () => {
    const { models } = parseCodexModelCatalog({
      models: [
        {
          slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol",
          additional_speed_tiers: ["fast", "ultrafast"],
          service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }, { id: "ultrafast", name: "Ultrafast", description: "The fastest available responses." }]
        },
        { slug: "gpt-6.1-terra", display_name: "GPT-6.1 Terra", additional_speed_tiers: ["fast"], service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }] },
        { slug: "plain", display_name: "Plain" }
      ]
    });
    expect(models[0].speedTiers).toEqual([
      { id: "fast", label: "Fast", description: "2x speed, increased usage" },
      { id: "ultrafast", label: "Ultrafast", description: "The fastest available responses." }
    ]);
    expect(models[1].speedTiers).toEqual([{ id: "fast", label: "Fast", description: "1.5x speed" }]);
    expect(models[2].speedTiers).toBeNull();
  });

  it("accepts a speed in the request and passes it to Codex as its service tier (Fast when unset)", () => {
    expect(validateModelOptions({ speed: "ultrafast" })).toEqual({ modelOptions: { model: null, reasoning: null, speed: "ultrafast" } });
    expect(validateModelOptions({ speed: "ultra fast!" })).toHaveProperty("error");
    expect(codexServiceTierArg({ speed: "ultrafast" })).toBe('service_tier="ultrafast"');
    expect(codexServiceTierArg(null)).toBe('service_tier="fast"');
    expect(describeModelOptions({ model: "gpt-6.2-sol", speed: "default" })).toBe("gpt-6.2-sol · standard speed");
    const args = buildAgentCodexArgs("go", "http://x", "/work", null, { model: "gpt-6.2-sol", speed: "ultrafast" });
    expect(args).toContain('service_tier="ultrafast"');
    expect(args).not.toContain('service_tier="fast"');
  });
});
