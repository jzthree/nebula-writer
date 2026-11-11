import { describe, expect, it } from "vitest";
import { accountEmailFromLabels, describeConnection, describeDocsApiError, describeSignInError, docsAccessDeniedMessage, documentNameFromTitle, isAccountRefusal, looksLikeOfficeFile } from "../src/chrome/docsAccess";

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

  it("tells an account refusal from Google's other 403s", () => {
    expect(isAccountRefusal(403, "The caller does not have permission")).toBe(true);
    expect(isAccountRefusal(404, "Requested entity was not found.")).toBe(true);
    expect(isAccountRefusal(403, "Google Docs API has not been used in project 123 before or it is disabled.")).toBe(false);
    expect(isAccountRefusal(403, "Quota exceeded for quota metric 'Read requests'")).toBe(false);
    expect(isAccountRefusal(500, "Internal error")).toBe(false);
  });

  it("says what to do when Chrome will not sign Writer in", () => {
    expect(describeSignInError("The user is not signed in.", null)).toContain("isn't signed in to Chrome itself");
    expect(describeSignInError("The user turned off browser signin", null)).toContain("isn't signed in to Chrome itself");
    expect(describeSignInError("The user did not approve access.", "writer-user@example.com")).toContain("wasn't approved for writer-user@example.com");
    expect(describeSignInError("OAuth2 request failed: bad client id: abc", null)).toContain("chrome:setup");
    expect(describeSignInError("Something new", "writer-user@example.com")).toBe("Writer couldn't sign in to Google as writer-user@example.com: Something new");
  });

  it("summarises the connection, naming both accounts when they differ", () => {
    expect(describeConnection("connected", "a@example.com", "A@example.com")).toEqual({ tone: "ok", text: "Connected as a@example.com." });
    const differs = describeConnection("connected", "a@example.com", "b@example.com");
    expect(differs.tone).toBe("warn");
    expect(differs.text).toContain("Writer's edits appear under a@example.com");
    expect(describeConnection("refused", "a@example.com", "b@example.com")).toEqual({ tone: "error", text: "No access: Writer signs in as a@example.com, but this tab is signed in as b@example.com." });
    expect(describeConnection("refused", "a@example.com", null).text).toContain("which can't open this doc");
    expect(describeConnection("failed", null, null).tone).toBe("error");
  });

  it("takes a document's name from its tab title", () => {
    expect(documentNameFromTitle("IGVF planning - Google Docs")).toBe("IGVF planning");
    expect(documentNameFromTitle("")).toBeNull();
    expect(documentNameFromTitle(undefined)).toBeNull();
  });
});
