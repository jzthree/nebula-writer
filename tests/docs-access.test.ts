import { describe, expect, it } from "vitest";
import { accountEmailFromLabels, docsAccessDeniedMessage } from "../src/chrome/docsAccess";

describe("Google Docs access diagnosis", () => {
  it("reads the page's signed-in account from its account button", () => {
    expect(accountEmailFromLabels(["Share", null, "Google Account: Jian Zhou  \n(ZhouLabUC2@gmail.com)"])).toBe("zhoulabuc2@gmail.com");
    expect(accountEmailFromLabels(["Email a collaborator at someone@example.com"])).toBeNull();
  });

  it("names both accounts when the doc is open as another one", () => {
    const message = docsAccessDeniedMessage("euruswind@gmail.com", "zhoulabuc2@gmail.com");
    expect(message).toContain("signs in as euruswind@gmail.com");
    expect(message).toContain("open as zhoulabuc2@gmail.com");
    expect(message).toContain("Share the doc with euruswind@gmail.com");
  });

  it("falls back to a general explanation when an account is unknown, and tells edit from read", () => {
    expect(docsAccessDeniedMessage(null, null)).toContain("this Chrome profile's main Google account");
    expect(docsAccessDeniedMessage("euruswind@gmail.com", "euruswind@gmail.com", true)).toContain("can open it but not edit it");
  });
});
