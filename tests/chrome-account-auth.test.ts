// @vitest-environment node
import { describe, expect, it } from "vitest";
import { authUrl, describeAuthError, parseAuthRedirect, tokenAccount } from "../src/chrome/accountAuth";
import { describeConnection, docsAccessDeniedMessage } from "../src/chrome/docsAccess";

const redirectUri = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";

describe("signing in as the Doc tab's account", () => {
  it("asks Google for the tab's account, silently unless approval is needed", () => {
    const silent = new URL(authUrl({ clientId: "1-abc.apps.googleusercontent.com", redirectUri, account: "lab@example.com", silent: true, state: "s1" }));
    expect(silent.origin + silent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(silent.searchParams.get("login_hint")).toBe("lab@example.com");
    expect(silent.searchParams.get("prompt")).toBe("none");
    expect(silent.searchParams.get("response_type")).toBe("token");
    expect(silent.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(silent.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/documents");
    const interactive = new URL(authUrl({ clientId: "1-abc.apps.googleusercontent.com", redirectUri, account: "lab@example.com", silent: false, state: "s1" }));
    expect(interactive.searchParams.has("prompt")).toBe(false);
  });

  it("reads the token from the redirect, and only for the request it made", () => {
    const answer = parseAuthRedirect(`${redirectUri}#state=s1&access_token=tok&expires_in=3599&token_type=Bearer`, "s1", 1_000);
    expect(answer).toEqual({ ok: true, token: "tok", expiresAt: 1_000 + 3_599_000 });
    expect(parseAuthRedirect(`${redirectUri}#state=other&access_token=tok`, "s1")).toMatchObject({ ok: false });
    expect(parseAuthRedirect("not a url", "s1")).toMatchObject({ ok: false });
  });

  it("tells an account that still needs approval from a real failure", () => {
    expect(parseAuthRedirect(`${redirectUri}#state=s1&error=interaction_required`, "s1")).toMatchObject({ ok: false, needsApproval: true });
    expect(parseAuthRedirect(`${redirectUri}#state=s1&error=consent_required`, "s1")).toMatchObject({ ok: false, needsApproval: true });
    expect(parseAuthRedirect(`${redirectUri}#state=s1&error=access_denied`, "s1")).toMatchObject({ ok: false, needsApproval: false, error: "Access to Google Docs was not approved for this account." });
    expect(describeAuthError("redirect_uri_mismatch")).toContain("chrome:setup");
  });

  it("reads which account a token belongs to", () => {
    expect(tokenAccount({ email: "Lab@Example.com", sub: "1" })).toBe("lab@example.com");
    expect(tokenAccount({})).toBeNull();
    expect(tokenAccount(null)).toBeNull();
  });

  it("explains a refusal for the tab's own account as that account's access, and offers approval", () => {
    expect(docsAccessDeniedMessage("lab@example.com", "lab@example.com", false, true)).toContain("Ask the owner to share it with that account");
    expect(docsAccessDeniedMessage("lab@example.com", "lab@example.com", true, true)).toContain("can open it but not edit it");
    expect(describeConnection("approval", "lab@example.com", "lab@example.com")).toEqual({ tone: "warn", text: "Writer can work as lab@example.com, the account this tab is signed in as, once you approve it." });
  });
});
