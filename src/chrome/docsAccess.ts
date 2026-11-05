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

export function docsAccessDeniedMessage(profileEmail: string | null, docEmail: string | null, editing = false): string {
  const writerAs = profileEmail ? `as ${profileEmail}, this Chrome profile's main account` : "as this Chrome profile's main Google account";
  if (editing) {
    return `Google won't let Writer edit this doc: Writer signs in ${writerAs}, which can open it but not edit it. Give that account edit access${docEmail && docEmail !== profileEmail?.toLowerCase() ? `, or open the doc in the Chrome profile whose main account is ${docEmail}` : ""}.`;
  }
  if (profileEmail && docEmail && profileEmail.toLowerCase() !== docEmail.toLowerCase()) {
    return `Google won't let Writer open this doc. Writer signs in ${writerAs}, but this doc is open as ${docEmail}. Share the doc with ${profileEmail}, or open it in the Chrome profile whose main account is ${docEmail} (with Writer added there).`;
  }
  return `Google won't let Writer open this doc: Writer signs in ${writerAs}, and that account has no access to it. Share the doc with that account, or open it in the Chrome profile whose main account owns it.`;
}
