/**
 * Safari cannot connect cloud pages to a local Writer (no loopback exemption
 * from mixed-content blocking), so the UI warns Safari users proactively
 * instead of letting the AI setup silently fail.
 */
export function isSafariBrowser(userAgent: string): boolean {
  return /safari/i.test(userAgent)
    && !/chrome|chromium|crios|edg|firefox|fxios|android/i.test(userAgent);
}
