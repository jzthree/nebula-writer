// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCliPrompt } from "../server/ai";
import { isImageCandidate, validateImageCandidate } from "../server/suggestion-validation";
import type { AiDocumentImage } from "../src/shared";

const dir = mkdtempSync(join(process.cwd(), ".writer-figures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// A 1×1 PNG.
const png = join(dir, "chart.png");
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const TEXT = "Aim 1 tests enrollment.\nResults by site follow.";
const images: AiDocumentImage[] = [{ index: 0, path: png, url: "/api/ai/images/x.png", mime: "image/png", width: 100, height: 50, context: "Figure 1. Design" }];
const request = { documentText: TEXT, mode: "global" as const, selection: null };

describe("figure suggestions", () => {
  it("routes by imageAction", () => {
    expect(isImageCandidate({ imageAction: "insert" })).toBe(true);
    expect(isImageCandidate({ imageIndex: 0 })).toBe(true);
    expect(isImageCandidate({ imageAction: null, imageIndex: null })).toBe(false);
  });

  it("stages an insert anchored to document text, with its caption, never as a deletion", () => {
    const verdict = validateImageCandidate({ imageAction: "insert", imageFile: png, imageCaption: "Figure 2. Enrollment by site.", original: "Results by site follow.", title: "Add chart", rationale: "Shows it." }, images, request);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.suggestion).toMatchObject({ kind: "image", original: "Results by site follow.", replacement: "" });
    expect(verdict.suggestion.image).toMatchObject({ action: "insert", index: null, caption: "Figure 2. Enrollment by site.", mime: "image/png" });
    expect(verdict.suggestion.anchor?.offset).toBe(TEXT.indexOf("Results"));
  });

  it("stages a delete of an existing picture", () => {
    const verdict = validateImageCandidate({ imageAction: "delete", imageIndex: 0 }, images, request);
    expect(verdict.ok && verdict.suggestion.image).toMatchObject({ action: "delete", index: 0, originalUrl: "/api/ai/images/x.png" });
  });

  it("rejects inserts without a real file or anchor, and bad indices", () => {
    expect(validateImageCandidate({ imageAction: "insert", imageFile: join(dir, "missing.png"), original: "Results by site follow." }, images, request).ok).toBe(false);
    expect(validateImageCandidate({ imageAction: "insert", imageFile: png, original: "Nowhere in the text." }, images, request).ok).toBe(false);
    expect(validateImageCandidate({ imageAction: "delete", imageIndex: 4 }, images, request).ok).toBe(false);
  });

  it("keeps replacements working as before", () => {
    const verdict = validateImageCandidate({ imageIndex: 0, imageFile: png }, images, request);
    expect(verdict.ok && verdict.suggestion.image?.action).toBeUndefined();
  });

  it("tells one-shot prompts how to add a figure even with no images", () => {
    const prompt = buildCliPrompt({ provider: "claude", instruction: "Add a chart", mode: "global", documentHtml: "", documentText: TEXT, selection: null });
    expect(prompt).toContain('imageAction "insert"');
  });
});
