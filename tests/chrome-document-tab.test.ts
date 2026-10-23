// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { googleDocId, panelPath, panelTabId, resolveDocumentTab } from "../src/chrome/documentTab";

const PAPER = "example-document_123";

describe("Google Docs tab URLs", () => {
  it.each([
    `https://docs.google.com/document/d/${PAPER}/edit?pli=1&tab=t.0`,
    `https://docs.google.com/document/u/0/d/${PAPER}/edit?authuser=0`,
    `https://docs.google.com/document/u/1/d/${PAPER}/edit?authuser=1`,
    `https://docs.google.com/document/u/12/d/${PAPER}/preview#heading=h.test`,
    `https://docs.google.com/document/d/${PAPER}`
  ])("recognizes %s", (url) => {
    expect(googleDocId(url)).toBe(PAPER);
  });

  it.each([
    undefined, "", "not a URL", "chrome://extensions/",
    "https://docs.google.com/document/u/0/",
    "https://docs.google.com/document/d/",
    "https://docs.google.com/document/u/email/d/document-id/edit",
    "https://docs.google.com/document/d/bad%20id/edit",
    `http://docs.google.com/document/d/${PAPER}/edit`,
    `https://docs.google.com.evil.example/document/d/${PAPER}/edit`,
    `https://evil.example/document/d/${PAPER}/edit`,
    `https://docs.google.com/spreadsheets/d/${PAPER}/edit`
  ])("rejects a non-document URL: %s", (url) => {
    expect(googleDocId(url)).toBeNull();
  });
});

describe("tab-bound Writer panels", () => {
  const origin = "chrome-extension://test-extension/";

  it("gives each document tab a distinct panel path", () => {
    expect(panelPath(27)).not.toBe(panelPath(28));
    expect(panelTabId(origin + panelPath(27))).toBe(27);
    expect(panelTabId(origin + panelPath(0))).toBe(0);
  });

  it.each(["", "?tabId=", "?tabId=-1", "?tabId=NaN", "?tabId=1.5", "?tabId=9007199254740992"])(
    "rejects an unbound or invalid panel path: %s", (query) => {
      expect(panelTabId(`${origin}sidepanel.html${query}`)).toBeNull();
    }
  );

  it("resolves only its own tab even when another window has focus", async () => {
    const getTab = vi.fn(async (id: number) => ({ id, url: `https://docs.google.com/document/u/1/d/${PAPER}/edit` }));
    expect(await resolveDocumentTab(27, getTab)).toEqual({ tabId: 27, docId: PAPER });
    expect(getTab).toHaveBeenCalledExactlyOnceWith(27);
  });

  it("does not fall back to some other document when its tab is closed", async () => {
    await expect(resolveDocumentTab(27, async () => { throw new Error("No tab"); })).rejects.toThrow("tab was closed");
  });

  it("rejects a tab navigated away from Google Docs", async () => {
    await expect(resolveDocumentTab(27, async () => ({ id: 27, url: "https://example.com/" }))).rejects.toThrow("not a Google Doc");
  });

  it("rejects a mismatched tab identity", async () => {
    await expect(resolveDocumentTab(27, async () => ({ id: 28, url: `https://docs.google.com/document/d/${PAPER}/edit` }))).rejects.toThrow("not a Google Doc");
  });

  it("does not let a hidden panel operate on an inactive document tab", async () => {
    await expect(resolveDocumentTab(27, async () => ({ id: 27, active: false, url: `https://docs.google.com/document/d/${PAPER}/edit` }))).rejects.toThrow("Select this Google Doc tab");
  });

  it("tells an old/global panel to reopen rather than guessing a document", async () => {
    const getTab = vi.fn();
    await expect(resolveDocumentTab(null, getTab)).rejects.toThrow("reopen Writer");
    expect(getTab).not.toHaveBeenCalled();
  });
});
