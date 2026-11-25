import { describe, expect, it } from "vitest";
import { currentPassage, rebaseSuggestion, threeWayMerge } from "../src/autoheal";

const BEFORE = "We propose three aims to test this idea across cell types.\n";
const AFTER = "\nAim 2. Model RNA processing.";

describe("autoheal", () => {
  it("merges edits that touch different words, and refuses ones that touch the same words", () => {
    const base = "Aim 1 will build models of chromatin activity and transcription initiation in many cell types.";
    const later = "Aim 1 will build interpretable models of chromatin activity and transcription initiation in many cell types.";
    const suggestion = "Aim 1 will build models of chromatin activity and transcription initiation in over 400 cell types.";
    expect(threeWayMerge(base, later, suggestion)).toBe("Aim 1 will build interpretable models of chromatin activity and transcription initiation in over 400 cell types.");
    expect(threeWayMerge(base, base.replace("many", "several"), suggestion)).toBeNull();
    // The same change made on both sides is not a conflict.
    expect(threeWayMerge(base, suggestion, suggestion)).toBe(suggestion);
  });

  it("finds the passage's current version by the context saved around it", () => {
    const original = "Aim 1. Models of chromatin activity and transcription in many cell types.";
    const now = `Intro.\n${BEFORE}Aim 1. Interpretable models of chromatin activity and transcription in many cell types.${AFTER}`;
    const anchor = { offset: 7 + BEFORE.length, before: BEFORE, after: AFTER };
    expect(currentPassage(now, { original, anchor })?.text).toBe("Aim 1. Interpretable models of chromatin activity and transcription in many cell types.");
  });

  it("rebases a suggestion onto later edits, recognises one already applied, and names a real conflict", () => {
    const original = "Aim 1. Models of chromatin activity and transcription in many cell types.";
    const anchor = { offset: BEFORE.length, before: BEFORE, after: AFTER };
    const later = `${BEFORE}Aim 1. Interpretable models of chromatin activity and transcription in many cell types.${AFTER}`;
    expect(rebaseSuggestion(later, { original, replacement: original.replace("many", "over 400"), anchor })).toEqual({
      kind: "clean",
      original: "Aim 1. Interpretable models of chromatin activity and transcription in many cell types.",
      replacement: "Aim 1. Interpretable models of chromatin activity and transcription in over 400 cell types."
    });
    const rewritten = `${BEFORE}Aim 1. We will develop mechanistic models of chromatin and initiation across cell types.${AFTER}`;
    expect(rebaseSuggestion(rewritten, { original, replacement: "Aim 1. Develop models of chromatin accessibility and transcription initiation.", anchor }).kind).toBe("conflict");
    const applied = `${BEFORE}${original.replace("many", "over 400")}${AFTER}`;
    expect(rebaseSuggestion(applied, { original, replacement: original.replace("many", "over 400"), anchor })).toEqual({ kind: "already" });
    expect(rebaseSuggestion("Something else entirely.", { original, replacement: "x", anchor }).kind).toBe("lost");
  });
});
