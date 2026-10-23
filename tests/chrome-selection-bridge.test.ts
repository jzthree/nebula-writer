// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readDocumentSelection } from "../src/chrome/selectionBridge";

const url = "https://docs.google.com/document/d/paper-id/edit";

describe("Google Docs selection bridge", () => {
  it("reads only the requested document tab and normalizes line endings", async () => {
    const send = vi.fn(async () => ({ text: "First.\r\nSecond.\rThird.", url }));
    expect(await readDocumentSelection(27, "paper-id", send)).toBe("First.\nSecond.\nThird.");
    expect(send).toHaveBeenCalledExactlyOnceWith(27, { type: "nebula-selection" });
  });

  it("distinguishes a working reader with no selection from a missing reader", async () => {
    expect(await readDocumentSelection(27, "paper-id", async () => ({ text: "", url }))).toBe("");
    await expect(readDocumentSelection(27, "paper-id", async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    })).rejects.toThrow("Refresh this Google Doc");
  });

  it.each([undefined, null, {}, { text: 42, url }, { text: "Passage." }, { text: "Passage.", url: 42 }])(
    "rejects a missing or malformed content-script reply: %j", async (reply) => {
      await expect(readDocumentSelection(27, "paper-id", async () => reply)).rejects.toThrow("reopen Writer");
    }
  );

  it.each([
    "https://docs.google.com/document/d/other-paper/edit",
    "https://example.com/document/d/paper-id/edit",
    "not a URL"
  ])("rejects selection text from another document: %s", async (otherUrl) => {
    await expect(readDocumentSelection(27, "paper-id", async () => ({ text: "Wrong text.", url: otherUrl })))
      .rejects.toThrow("Google Doc changed");
  });

  it("accepts a document URL qualified with a Google account", async () => {
    expect(await readDocumentSelection(27, "paper-id", async () => ({
      text: "Correct text.", url: "https://docs.google.com/document/u/1/d/paper-id/edit?authuser=1"
    }))).toBe("Correct text.");
  });
});
