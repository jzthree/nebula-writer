/**
 * Why Google refused a document read. Chrome hands the extension a token for
 * the Chrome profile's main account only, while a Docs tab can be open as any
 * account signed in to the browser (/u/1/, /u/2/…). When those differ and the
 * profile's account has no access, the Docs API answers "The caller does not
 * have permission" — this names both accounts and the two ways out.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The signed-in account of a Google page, from its account button's label ("Google Account: Name (email)"). */
export function accountEmailFromLabels(labels: Array<string | null>): string | null {
  for (const label of labels) {
    if (label && /google account/i.test(label)) {
      const email = label.match(EMAIL)?.[0];
      if (email) {
        return email.toLowerCase();
      }
    }
  }
  return null;
}

export function docsAccessDeniedMessage(profileEmail: string | null, docEmail: string | null, editing = false, asTabAccount = false): string {
  if (asTabAccount && profileEmail) {
    // Writer already works as the tab's own account: the account itself lacks the access.
    return editing
      ? `Google won't let Writer edit this doc: ${profileEmail}, the account this tab is signed in as, can open it but not edit it. Ask the owner for edit access.`
      : `Google won't let Writer open this doc as ${profileEmail}, the account this tab is signed in as. Ask the owner to share it with that account.`;
  }
  const writerAs = profileEmail ? `as ${profileEmail}, this Chrome profile's main account` : "as this Chrome profile's main Google account";
  if (editing) {
    return `Google won't let Writer edit this doc: Writer signs in ${writerAs}, which can open it but not edit it. Give that account edit access${docEmail && docEmail !== profileEmail?.toLowerCase() ? `, or open the doc in the Chrome profile whose main account is ${docEmail}` : ""}.`;
  }
  if (profileEmail && docEmail && profileEmail.toLowerCase() !== docEmail.toLowerCase()) {
    return `Google won't let Writer open this doc. Writer signs in ${writerAs}, but this doc is open as ${docEmail}. Share the doc with ${profileEmail}, or open it in the Chrome profile whose main account is ${docEmail} (with Writer added there).`;
  }
  return `Google won't let Writer open this doc: Writer signs in ${writerAs}, and that account has no access to it. Share the doc with that account, or open it in the Chrome profile whose main account owns it.`;
}

export const OFFICE_FILE_MESSAGE = "This is a Word file opened in Google Docs, and Google doesn't let extensions edit those: Writer can read it and answer questions, but can't apply changes. To apply them, choose File > Save as Google Docs and open Writer beside the new copy.";

/** Google's refusal for an uploaded Office file, in words that say what to do; null for any other error. */
export function describeDocsApiError(detail: string): string | null {
  return /must not be an Office file/i.test(detail) ? OFFICE_FILE_MESSAGE : null;
}

/** Word files keep their extension as their title in Google Docs. */
export function looksLikeOfficeFile(title: string | null | undefined): boolean {
  return /\.(docx?|dotx?|docm|rtf|odt)$/i.test(title?.trim() ?? "");
}

/**
 * A 404, or a 403 that is about who is asking. Google also answers 403 for
 * an API not enabled and for quota; those are not an account problem and
 * must not be reported as one.
 */
export function isAccountRefusal(status: number, detail: string): boolean {
  return status === 404 || (status === 403 && !/not been used|is disabled|quota|rate limit|too many requests/i.test(detail));
}

/** Why Chrome would not give Writer a Google token, in words that say what to do. */
export function describeSignInError(raw: string, profileEmail: string | null): string {
  const account = profileEmail ?? "this Chrome profile's main account";
  if (/not signed in|turned off browser sign-?in|sign-?in (is )?disabled/i.test(raw)) {
    return "Writer can't sign in to Google because this Chrome profile isn't signed in to Chrome itself. Being signed in on a Google website isn't enough: click the profile picture in Chrome's toolbar and sign in there.";
  }
  if (/did not approve|not granted|revoked|cancell?ed|access_denied/i.test(raw)) {
    return `Google access wasn't approved for ${account}. Close and reopen Writer, then approve access when Google asks.`;
  }
  if (/bad client id|invalid_client/i.test(raw)) {
    return "Writer's Google sign-in isn't set up for this extension: its OAuth client id is wrong. Run npm run chrome:setup and follow its steps.";
  }
  if (/failed to fetch|network|connection/i.test(raw)) {
    return "Writer can't reach Google to sign in. Check this computer's internet connection, then try again.";
  }
  return `Writer couldn't sign in to Google as ${account}: ${raw}`;
}

export type DocsConnectionState = "connected" | "refused" | "failed" | "approval";

export interface DocsConnectionSummary {
  tone: "ok" | "warn" | "error";
  text: string;
}

/** One line saying which Google account Writer uses here, and how that went. */
export function describeConnection(state: DocsConnectionState, writerAccount: string | null, documentAccount: string | null): DocsConnectionSummary {
  const writer = writerAccount ?? "this Chrome profile's main account";
  const differs = !!writerAccount && !!documentAccount && writerAccount.toLowerCase() !== documentAccount.toLowerCase();
  if (state === "approval") {
    return { tone: "warn", text: `Writer can work as ${writer}, the account this tab is signed in as, once you approve it.` };
  }
  if (state === "failed") {
    return { tone: "error", text: `Not connected to Google. Writer signs in as ${writer}.` };
  }
  if (state === "refused") {
    return { tone: "error", text: differs ? `No access: Writer signs in as ${writer}, but this tab is signed in as ${documentAccount}.` : `No access: Writer signs in as ${writer}, which can't open this doc.` };
  }
  return differs
    ? { tone: "warn", text: `Writer reads and edits as ${writer}, while this tab is signed in as ${documentAccount}. Writer's edits appear under ${writer}.` }
    : { tone: "ok", text: `Connected as ${writer}.` };
}

/** A document's name from its tab title ("Name - Google Docs"). */
export function documentNameFromTitle(title: string | null | undefined): string | null {
  const name = title?.replace(/\s+-\s+Google Docs\s*$/i, "").trim();
  return name || null;
}
