import { describe, expect, it } from "vitest";
import { accountEmailFromLabels, describeDocsApiError, docsAccessDeniedMessage, looksLikeOfficeFile } from "../src/chrome/docsAccess";

describe("Google Docs access diagnosis", () => {
  it("reads the page's signed-in account from its account button", () => {
    expect(accountEmailFromLabels(["Share", null, "Google Account: Jian Zhou  \n(Doc-Owner@Example.com)"])).toBe("doc-owner@example.com");
    expect(accountEmailFromLabels(["Email a collaborator at someone@example.com"])).toBeNull();
  });

  it("names both accounts when the doc is open as another one", () => {
    const message = docsAccessDeniedMessage("writer-user@example.com", "doc-owner@example.com");
    expect(message).toContain("signs in as writer-user@example.com");
    expect(message).toContain("open as doc-owner@example.com");
    expect(message).toContain("Share the doc with writer-user@example.com");
  });

  it("falls back to a general explanation when an account is unknown, and tells edit from read", () => {
    expect(docsAccessDeniedMessage(null, null)).toContain("this Chrome profile's main Google account");
    expect(docsAccessDeniedMessage("writer-user@example.com", "writer-user@example.com", true)).toContain("can open it but not edit it");
  });

  it("explains Google's refusal to edit an Office file, and spots one by its title", () => {
    const message = describeDocsApiError("This operation is not supported for this document. The document must not be an Office file.");
    expect(message).toContain("Save as Google Docs");
    expect(describeDocsApiError("Invalid requests[0]")).toBeNull();
    expect(looksLikeOfficeFile("Superres_paper_all_revisions_tracked.docx")).toBe(true);
    expect(looksLikeOfficeFile("IGVF planning")).toBe(false);
    expect(looksLikeOfficeFile(null)).toBe(false);
  });
});
