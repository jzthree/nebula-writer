import { describe, expect, it } from "vitest";
import { cliTimeoutMs, formatCliTimeout, resolveCliTimeoutConfig } from "../server/cli-runtime";
import { CodexStreamParser, summarizeReasoning } from "../server/agent-runtime";
import { formatElapsedSince } from "../src/shared";

describe("provider timeout configuration", () => {
  it("has no timeout by default", () => {
    const config = resolveCliTimeoutConfig(undefined);
    expect(config.timeoutMs).toBe(0);
    expect(config.valid).toBe(true);
    expect(config.maxMs).toBeNull();
    expect(config.detail).toContain("No CLI timeout");
    expect(cliTimeoutMs("")).toBe(0);
  });

  it("treats off/0 as an explicit no-timeout setting", () => {
    expect(resolveCliTimeoutConfig("off")).toMatchObject({ timeoutMs: 0, valid: true });
    expect(resolveCliTimeoutConfig("0")).toMatchObject({ timeoutMs: 0, valid: true });
    expect(resolveCliTimeoutConfig("-5")).toMatchObject({ timeoutMs: 0, valid: true });
  });

  it("keeps WRITER_CLI_TIMEOUT_MS as an opt-in cap with only a lower bound", () => {
    expect(resolveCliTimeoutConfig("250")).toMatchObject({ timeoutMs: 250, valid: true, clamped: false });
    expect(resolveCliTimeoutConfig("50")).toMatchObject({ timeoutMs: 100, valid: true, clamped: true });
    expect(resolveCliTimeoutConfig("5400000")).toMatchObject({ timeoutMs: 5_400_000, clamped: false });
    expect(resolveCliTimeoutConfig("slow")).toMatchObject({ timeoutMs: 0, valid: false });
  });

  it("formats a disabled timeout in words", () => {
    expect(formatCliTimeout(0)).toBe("no timeout");
    expect(formatCliTimeout(1500)).toBe("1.5s");
  });
});

describe("live progress text", () => {
  it("turns Codex reasoning summaries into a one-line status", () => {
    expect(summarizeReasoning("**Reviewing Aim 2 rationale**\n\nThe paragraph repeats itself.")).toBe("Reviewing Aim 2 rationale");
    expect(summarizeReasoning("   \n\n")).toBe("");
    expect(summarizeReasoning(`${"x".repeat(200)}`)).toHaveLength(118);
  });

  it("emits the reasoning summary as a status event when the item completes", () => {
    const parser = new CodexStreamParser();
    expect(parser.consume(JSON.stringify({ type: "item.started", item: { type: "reasoning" } }))).toEqual([{ kind: "thinking" }]);
    expect(parser.consume(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "**Checking anchors**\n\ndetail" } })))
      .toEqual([{ kind: "status", stage: "thinking", detail: "Checking anchors" }]);
    expect(parser.consume(JSON.stringify({ type: "item.completed", item: { type: "reasoning" } }))).toEqual([]);
  });

  it("reports Codex web searches as tool activity, once per search", () => {
    const parser = new CodexStreamParser();
    expect(parser.consume(JSON.stringify({ type: "item.started", item: { id: "ws1", type: "web_search", query: "NIH Pioneer Award criteria" } })))
      .toEqual([{ kind: "tool", tool: "web_search", summary: 'Searching the web for "NIH Pioneer Award criteria"' }]);
    expect(parser.consume(JSON.stringify({ type: "item.completed", item: { id: "ws1", type: "web_search", query: "NIH Pioneer Award criteria" } }))).toEqual([]);
    expect(parser.consume(JSON.stringify({ type: "item.completed", item: { type: "web_search" } }))).toEqual([{ kind: "tool", tool: "web_search", summary: "Searching the web" }]);
  });

  it("formats elapsed time the same way for the web pill and the Word pane", () => {
    const start = Date.parse("2026-09-06T10:00:00.000Z");
    expect(formatElapsedSince("2026-09-06T10:00:00.000Z", start + 42_000)).toBe("42s");
    expect(formatElapsedSince(start, start + 187_000)).toBe("3m 7s");
    expect(formatElapsedSince("not a date", start)).toBe("0s");
  });
});
