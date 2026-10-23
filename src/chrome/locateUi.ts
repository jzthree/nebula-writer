import { isDocsLocatePlan, type DocsLocatePlan } from "./locate";

function visible(element: Element): element is HTMLElement {
  return element instanceof element.ownerDocument.defaultView!.HTMLElement && element.getClientRects().length > 0;
}

function click(element: HTMLElement): void {
  const win = element.ownerDocument.defaultView!;
  const rect = element.getBoundingClientRect();
  // Closure suppresses a menu item's mouseup at the menu-opening coordinates.
  const options: MouseEventInit = {
    bubbles: true, cancelable: true, composed: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0
  };
  element.dispatchEvent(new win.MouseEvent("mouseover", options));
  element.dispatchEvent(new win.MouseEvent("mousemove", options));
  element.dispatchEvent(new win.MouseEvent("mousedown", { ...options, buttons: 1 }));
  element.dispatchEvent(new win.MouseEvent("mouseup", options));
  element.dispatchEvent(new win.MouseEvent("click", { ...options, detail: 1 }));
}

function label(element: HTMLInputElement): string {
  const doc = element.ownerDocument;
  return element.getAttribute("aria-label") ?? element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ")
    ?? Array.from(element.labels ?? []).map((item) => item.textContent).join(" ");
}

/** Operate only visible Find controls. Never touch the document editor or Replace. */
export async function locateDocsPassage(doc: Document, plan: DocsLocatePlan, isCurrentDocument: () => boolean = () => true): Promise<string> {
  if (!isDocsLocatePlan(plan)) throw new Error("Invalid Google Docs Locate request.");
  const win = doc.defaultView!;
  let cancelled = false;
  const cancel = (event: Event) => { if (event.isTrusted) cancelled = true; };
  const guard = () => {
    if (cancelled || !isCurrentDocument()) throw new Error("Locate was interrupted. Click Locate again when ready.");
  };
  async function waitFor<T>(read: () => T | null, message: string): Promise<T> {
    const until = Date.now() + 4_000;
    while (Date.now() < until) {
      guard();
      const value = read();
      if (value !== null) return value;
      await new Promise((resolve) => win.setTimeout(resolve, 40));
    }
    throw new Error(message);
  }
  const findDialog = () => Array.from(doc.querySelectorAll('[role="dialog"]')).filter(visible)
    .find((item) => item.className.includes("Findandreplacedialog") || item.querySelector('input[aria-label="Find"]')) ?? null;
  if (findDialog()) throw new Error("Close Google Docs' Find and replace dialog, then click Locate again.");
  doc.addEventListener("pointerdown", cancel, true);
  doc.addEventListener("keydown", cancel, true);
  let dialog: HTMLElement | null = null;
  let complete = false;
  try {
    guard();
    const menu = doc.getElementById("docs-edit-menu");
    if (!menu || !visible(menu)) throw new Error("Google Docs' Edit menu is unavailable. Locate currently requires the English Docs interface.");
    click(menu);
    const command = await waitFor(() => Array.from(doc.querySelectorAll('[role="menuitem"]')).filter(visible)
      .find((item) => !!item.querySelector(".docs-icon-editors-ia-find-replace") || /^Find and replace\b/.test(item.textContent?.trim() ?? "")) ?? null,
    "Google Docs' Find command is unavailable. Open the document in editing mode and try again.");
    click(command);
    dialog = await waitFor(findDialog, "Google Docs did not open Find. Refresh the document and try Locate again.");
    const input = dialog.querySelector<HTMLInputElement>('input[aria-label="Find"]');
    const counter = dialog.querySelector<HTMLElement>('[class*="FindInputCounter"]');
    const options = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const regex = options.find((item) => /regular expressions/i.test(label(item)));
    if (!input || !counter || !visible(input)) throw new Error("Google Docs' Find controls changed. Locate cannot safely continue.");
    if (regex?.checked) throw new Error("Turn off 'Use regular expressions' in Google Docs' Find and replace, close it, and retry Locate.");
    const matchCase = options.find((item) => /^Match case\b/i.test(label(item)))?.checked ?? false;
    const ignoreAccents = options.find((item) => /^Ignore diacritics\b/i.test(label(item)))?.checked ?? false;
    const expected = plan.positions[matchCase ? ignoreAccents ? "foldAccents" : "exact" : ignoreAccents ? "foldBoth" : "foldCase"];
    const setQuery = (value: string) => {
      input.focus();
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    };
    setQuery("");
    await waitFor(() => !counter.textContent?.trim() ? true : null, "Google Docs did not reset its search results.");
    setQuery(plan.query);
    const readCount = () => {
      const match = /^\s*([\d,]+)\s+of\s+([\d,]+)\s*$/.exec(counter.textContent ?? "");
      return match ? { index: Number(match[1].replace(/,/g, "")) - 1, count: Number(match[2].replace(/,/g, "")) } : null;
    };
    let result = await waitFor(readCount, "Google Docs found no searchable match for this passage. Refresh Writer and try again.");
    if (result.count !== expected.count || result.index < 0) throw new Error("Google Docs found a different set of occurrences than Writer. Refresh Writer before locating this passage.");
    if (Math.abs(result.index - expected.index) > 50) throw new Error("Too many repeated matches to locate safely. Use a longer passage.");
    while (result.index !== expected.index) {
      const direction = result.index > expected.index ? -1 : 1;
      const nextIndex = result.index + direction;
      const name = direction < 0 ? "Previous" : "Next";
      const button = Array.from(dialog.querySelectorAll("button")).find((item) => visible(item) && item.textContent?.trim() === name);
      if (!button || button.disabled) throw new Error("Google Docs could not advance to the requested occurrence.");
      click(button);
      result = await waitFor(() => { const current = readCount(); return current?.index === nextIndex && current.count === expected.count ? current : null; }, "Google Docs did not move to the requested occurrence.");
    }
    guard();
    const close = dialog.querySelector<HTMLElement>('button[aria-label="Close"]');
    if (!close || !visible(close)) throw new Error("Google Docs' Find dialog could not close safely.");
    click(close);
    await waitFor(() => !dialog?.isConnected || !visible(dialog) ? true : null, "Google Docs did not finish selecting this passage.");
    complete = true;
    return plan.query;
  } finally {
    doc.removeEventListener("pointerdown", cancel, true);
    doc.removeEventListener("keydown", cancel, true);
    if (!complete && !cancelled && dialog?.isConnected && visible(dialog)) {
      const close = dialog.querySelector<HTMLElement>('button[aria-label="Close"]');
      if (close && visible(close)) click(close);
    }
  }
}
