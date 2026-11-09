import { click, visible } from "./locateUi";

/**
 * Leave a comment on the passage Locate just selected, through Google Docs'
 * own Insert > Comment. The Drive API can only add comments that Docs shows
 * detached from the text, so the page's comment box is the one way to anchor
 * a comment to a passage. Operates only the comment box it opened.
 */

export const COMMENT_TEXT_LIMIT = 30_000;

function editable(element: Element): element is HTMLElement {
  const win = element.ownerDocument.defaultView!;
  if (element instanceof win.HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  const value = element.getAttribute("contenteditable");
  return element instanceof win.HTMLElement && value !== null && value !== "false";
}

function textOf(element: HTMLElement): string {
  const win = element.ownerDocument.defaultView!;
  return element instanceof win.HTMLTextAreaElement ? element.value : element.textContent ?? "";
}

function buttonLabel(element: Element): string {
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
}

function disabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(element.className);
}

const POST_LABEL = /^(Comment|Post|Reply)\b(?!s)/i;

/** Buttons in the comment box around `input` (the nearest ancestors first). */
function composerButtons(input: HTMLElement): HTMLElement[] {
  let scope: HTMLElement | null = input.parentElement;
  for (let depth = 0; scope && depth < 10; depth++, scope = scope.parentElement) {
    const buttons = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]'));
    if (buttons.some((item) => /^(Comment|Cancel|Post|Reply)\b/i.test(buttonLabel(item)))) return buttons;
  }
  return [];
}

/** The visible button that posts the comment. */
function postButton(input: HTMLElement): HTMLElement | null {
  return composerButtons(input).find((item) => visible(item) && POST_LABEL.test(buttonLabel(item))) ?? null;
}

/** An editable field outside the document's own text, in a box with comment buttons. */
function isCommentField(element: Element | null): element is HTMLElement {
  return !!element && editable(element) && element.isConnected && !element.closest('[role="dialog"], .kix-appview-editor') && composerButtons(element).length > 0;
}

/** Visible comment boxes. */
function commentBoxes(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll('textarea, [contenteditable]')).filter((element): element is HTMLElement => isCommentField(element) && visible(element));
}

/** A short description of an element, for the error a failed step reports. */
function describe(element: Element | null): string {
  if (!element) return "none";
  const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
  const role = element.getAttribute("role");
  const label = element.getAttribute("aria-label");
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}${role ? `[role=${role}]` : ""}${label ? `[aria-label=${label.slice(0, 30)}]` : ""}`;
}

function diagnostics(doc: Document, input: HTMLElement | null): string {
  const editables = Array.from(doc.querySelectorAll('textarea, [contenteditable]')).filter((item) => editable(item));
  const buttons = input ? composerButtons(input).map((item) => `${buttonLabel(item).slice(0, 20) || "?"}${visible(item) ? "" : " (hidden)"}${disabled(item) ? " (disabled)" : ""}`) : [];
  return ` [Details for Writer: focus ${describe(doc.activeElement)}; ${editables.length} editable field(s): ${editables.slice(0, 4).map(describe).join(", ") || "none"}${input ? `; box buttons: ${buttons.join(", ") || "none"}` : ""}]`;
}

function typeText(input: HTMLElement, text: string): void {
  const doc = input.ownerDocument;
  const win = doc.defaultView!;
  input.focus();
  // insertText behaves like typing, so Docs enables its Comment button as it would for the author.
  const typed = typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text);
  if (typed && textOf(input).trim()) return;
  if (input instanceof win.HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
  } else {
    input.textContent = text;
  }
  input.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function sameText(a: string, b: string): boolean {
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  return squash(a) === squash(b);
}

export async function commentOnSelection(doc: Document, text: string, isCurrentDocument: () => boolean = () => true): Promise<void> {
  if (typeof text !== "string" || !text.trim() || text.length > COMMENT_TEXT_LIMIT) throw new Error("Invalid Google Docs comment.");
  const win = doc.defaultView!;
  let cancelled = false;
  const cancel = (event: Event) => { if (event.isTrusted) cancelled = true; };
  const guard = () => {
    if (cancelled || !isCurrentDocument()) throw new Error("Commenting was interrupted. Click Comment again when ready.");
  };
  async function waitFor<T>(read: () => T | null, message: string, ms = 4_000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      guard();
      const value = read();
      if (value !== null) return value;
      await new Promise((resolve) => win.setTimeout(resolve, 40));
    }
    throw new Error(message);
  }
  if (commentBoxes(doc).some((box) => textOf(box).trim())) {
    throw new Error("Finish or cancel the comment you are writing in Google Docs, then try again.");
  }
  const before = new Set(commentBoxes(doc));
  const focusedBefore = doc.activeElement;
  doc.addEventListener("pointerdown", cancel, true);
  doc.addEventListener("keydown", cancel, true);
  let input: HTMLElement | null = null;
  try {
    guard();
    const menu = doc.getElementById("docs-insert-menu");
    if (!menu || !visible(menu)) throw new Error("Google Docs' Insert menu is unavailable. Commenting currently requires the English Docs interface in editing or commenting mode.");
    click(menu);
    const command = await waitFor(() => Array.from(doc.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(visible)
      .find((item) => /^Comment(?!s)\b/.test(item.textContent?.trim() ?? "")) ?? null,
    "Google Docs' Insert > Comment command is unavailable. Check that you can comment on this document.");
    if (disabled(command)) throw new Error("Google Docs does not allow a comment here. Check that you can comment on this document.");
    click(command);
    // Docs puts the cursor in the comment box it opens, as for the author.
    input = await waitFor(() => {
      const focused = doc.activeElement;
      if (focused !== focusedBefore && isCommentField(focused) && !textOf(focused).trim()) return focused;
      return commentBoxes(doc).find((box) => !before.has(box) && !textOf(box).trim()) ?? null;
    }, "Google Docs opened no comment box Writer could recognise. If one is open in the document, type the comment there or cancel it.").catch((error: Error) => {
      throw new Error(error.message + diagnostics(doc, null));
    });
    guard();
    typeText(input, text);
    if (!sameText(textOf(input), text)) {
      throw new Error("Google Docs' comment box did not take the text. The box is still open in the document: paste or type the comment there, or cancel it." + diagnostics(doc, input));
    }
    const field = input;
    const post = await waitFor(() => {
      const button = postButton(field);
      return button && !disabled(button) ? button : null;
    }, "", 2_000).catch(() => null);
    guard();
    if (post) {
      click(post);
    } else {
      // No Comment button found: post with the keyboard shortcut, as the author can.
      const mac = /Mac/i.test(doc.defaultView?.navigator.platform ?? "");
      field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
    }
    const firstLine = text.split("\n").find((line) => line.trim())!.trim();
    await waitFor(() => {
      const stillOpen = field.isConnected && visible(field) && textOf(field).trim();
      return !stillOpen && doc.body.textContent?.includes(firstLine) ? true : null;
    }, "Writer wrote the comment but Google Docs did not post it. Click Comment in the document to post it.").catch((error: Error) => {
      throw new Error(error.message + diagnostics(doc, field));
    });
  } finally {
    doc.removeEventListener("pointerdown", cancel, true);
    doc.removeEventListener("keydown", cancel, true);
  }
}
