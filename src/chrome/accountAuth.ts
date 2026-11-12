/**
 * Signing Writer in as the account a Docs tab is signed in as. Chrome's own
 * getAuthToken only gives the profile's main account, while a tab can be any
 * account in the browser; Google's OAuth page, opened by launchWebAuthFlow
 * with that account as login_hint, can sign in as any of them. It needs an
 * OAuth client of type "Web application" whose redirect URI is the
 * extension's https://<id>.chromiumapp.org/ (the "Chrome Extension" client
 * type refuses that redirect). Once an account approved Writer, later sign-ins
 * are silent (prompt=none), so Writer follows the tab's account by itself.
 */

export const DOCS_SCOPES = ["https://www.googleapis.com/auth/documents", "openid", "email"];

export function authUrl(options: { clientId: string; redirectUri: string; account: string; silent: boolean; state: string }): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    response_type: "token",
    redirect_uri: options.redirectUri,
    scope: DOCS_SCOPES.join(" "),
    login_hint: options.account,
    include_granted_scopes: "true",
    state: options.state
  });
  if (options.silent) params.set("prompt", "none");
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export type AuthRedirect =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string; needsApproval: boolean };

/** Read Google's answer from the redirect URL (the token is in the fragment). */
export function parseAuthRedirect(url: string, state: string, now = Date.now()): AuthRedirect {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Google's sign-in did not return to Writer.", needsApproval: false };
  }
  const params = new URLSearchParams(parsed.hash.replace(/^#/, "") || parsed.search.replace(/^\?/, ""));
  if (params.get("state") !== state) {
    return { ok: false, error: "Google's sign-in answer did not match Writer's request.", needsApproval: false };
  }
  const error = params.get("error");
  if (error) {
    // prompt=none could not finish without the author: never approved, or Google wants a choice.
    const needsApproval = /interaction_required|consent_required|login_required|account_selection_required/.test(error);
    return { ok: false, error: describeAuthError(error), needsApproval };
  }
  const token = params.get("access_token");
  if (!token) {
    return { ok: false, error: "Google's sign-in returned no access token.", needsApproval: false };
  }
  const seconds = Number(params.get("expires_in"));
  return { ok: true, token, expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000 };
}

export function describeAuthError(error: string): string {
  if (/access_denied/.test(error)) return "Access to Google Docs was not approved for this account.";
  if (/redirect_uri_mismatch/.test(error)) return "Writer's Google sign-in is not set up for this extension (its redirect URI is not registered). Run npm run chrome:setup and follow its steps.";
  if (/interaction_required|consent_required|login_required|account_selection_required/.test(error)) return "This account has not approved Writer yet.";
  return `Google's sign-in failed: ${error}.`;
}

/** The account a token was issued for, from Google's tokeninfo answer. */
export function tokenAccount(info: unknown): string | null {
  const email = info && typeof info === "object" ? (info as { email?: unknown }).email : null;
  return typeof email === "string" && email ? email.toLowerCase() : null;
}
