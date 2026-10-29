// @vitest-environment node
import { describe, expect, it } from "vitest";
import { selectionExcerpt, steerMessageBody } from "../src/steerMessage";

const SENT = { from: 0, to: 10, text: "First bit." };
const NOW = { from: 40, to: 66, text: "The passage selected later" };

describe("steered messages", () => {
  it("carry the passage selected since the request went out", () => {
    const body = steerMessageBody("is this accurate?", null, NOW, SENT);
    expect(body).toContain("is this accurate?\n\nSince asking, the user has selected a different passage (characters 41-66 of the document)");
    expect(body).toContain("<<<selection\nThe passage selected later\n>>>");
    expect(steerMessageBody("is this accurate?", null, NOW, null)).toContain("<<<selection");
  });

  it("are just the words when the selection is the one the request was sent with, or there is none", () => {
    expect(steerMessageBody("also keep it short", null, { ...SENT }, SENT)).toBe("also keep it short");
    expect(steerMessageBody("also keep it short", null, null, SENT)).toBe("also keep it short");
    expect(steerMessageBody("shorter", { ref: "S2", title: "Trim" } as never, null, null)).toBe('About S2 "Trim": shorter');
  });

  it("quote a selection briefly for the history", () => {
    expect(selectionExcerpt({ from: 0, to: 9, text: " two\n words " })).toBe("two words");
    expect(selectionExcerpt({ from: 0, to: 300, text: "x".repeat(300) })).toHaveLength(140);
    expect(selectionExcerpt(null)).toBeNull();
  });
});
