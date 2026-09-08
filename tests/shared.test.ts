import { describe, expect, it } from "vitest";
import { chooseAnchoredCandidate, isLocalHostname, scoreAnchorContext, suggestionAnchorFor } from "../src/shared";

describe("isLocalHostname", () => {
  it("treats loopback origins as local (repo present)", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLocalHostname(host)).toBe(true);
    }
  });

  it("treats hosted origins as remote (must guide from git clone)", () => {
    for (const host of ["writer.zhoulab.io", "192.168.1.42", "10.0.0.5", "0.0.0.0", "example.com"]) {
      expect(isLocalHostname(host)).toBe(false);
    }
  });
});

describe("placement anchors", () => {
  const doc = "Alpha beta. Moved clause. Gamma.\nDelta. Epsilon.";

  it("records where the original sits and the text around it", () => {
    expect(suggestionAnchorFor(doc, "Moved clause.")).toEqual({ offset: 12, before: "Alpha beta. ", after: " Gamma.\nDelta. Epsilon." });
    expect(suggestionAnchorFor(doc, "missing")).toBeNull();
    expect(suggestionAnchorFor("", "Alpha")).toBeNull();
  });

  it("tolerates whitespace differences between the quote and the document", () => {
    expect(suggestionAnchorFor(doc, "Moved   clause.")).toMatchObject({ offset: 12, before: "Alpha beta. " });
  });

  it("prefers the occurrence nearest the selection when the text repeats", () => {
    const repeated = "Aim 1 text. Aim 2 text. Aim 3 text.";
    expect(suggestionAnchorFor(repeated, "Aim")?.offset).toBe(0);
    expect(suggestionAnchorFor(repeated, "Aim", 13)?.offset).toBe(12);
  });

  it("chooses the occurrence whose surroundings match, and stays undecided on ties or noise", () => {
    const anchor = suggestionAnchorFor(doc, "Moved clause.")!;
    // After the insertion half of a move is accepted the clause exists twice.
    const moved = "Alpha beta. Moved clause. Gamma.\nDelta. Epsilon. Moved clause.";
    const candidates = [
      { before: moved.slice(0, 12), after: moved.slice(25) },
      { before: moved.slice(0, 49), after: "" }
    ];
    expect(scoreAnchorContext(anchor, candidates[0].before, candidates[0].after)).toBeGreaterThan(scoreAnchorContext(anchor, candidates[1].before, candidates[1].after));
    expect(chooseAnchoredCandidate(anchor, candidates)).toBe(0);
    expect(chooseAnchoredCandidate(anchor, [candidates[1], candidates[0]])).toBe(1);
    expect(chooseAnchoredCandidate(anchor, [candidates[0]])).toBeNull();
    expect(chooseAnchoredCandidate(null, candidates)).toBeNull();
    expect(chooseAnchoredCandidate(anchor, [{ before: "x ", after: " y" }, { before: "z ", after: " w" }])).toBeNull();
    expect(chooseAnchoredCandidate(anchor, [candidates[0], candidates[0]])).toBeNull();
  });
});
