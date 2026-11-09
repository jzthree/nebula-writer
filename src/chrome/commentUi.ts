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

/** The visible button labelled `name` in the comment box around `input`. */
function composerButton(input: HTMLElement, name: string): HTMLElement | null {
  let scope: HTMLElement | null = input.parentElement;
  for (let depth = 0; scope && depth < 10; depth++, scope = scope.parentElement) {
    const button = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]'))
      .find((item) => visible(item) && buttonLabel(item) === name);
    if (button) return button;
  }
  return null;
}

/** Visible comment boxes: an editable field with its own Comment button. */
function commentBoxes(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll('textarea, [contenteditable]'))
    .filter((element): element is HTMLElement => editable(element) && visible(element) && composerButton(element as HTMLElement, "Comment") !== null);
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
  doc.addEventListener("pointerdown", cancel, true);
  doc.addEventListener("keydown", cancel, true);
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
    const input = await waitFor(() => {
      const boxes = commentBoxes(doc).filter((box) => !textOf(box).trim());
      const focused = boxes.find((box) => box === doc.activeElement || box.contains(doc.activeElement));
      return focused ?? boxes.find((box) => !before.has(box)) ?? null;
    }, "Google Docs did not open a comment box for this passage.");
    guard();
    typeText(input, text);
    if (!sameText(textOf(input), text)) {
      throw new Error("Google Docs' comment box did not take the text. The box is still open in the document: paste or type the comment there, or cancel it.");
    }
    const post = await waitFor(() => {
      const button = composerButton(input, "Comment");
      return button && !disabled(button) ? button : null;
    }, "Writer wrote the comment but Google Docs did not enable its Comment button. Click Comment in the document to post it.");
    guard();
    click(post);
    const firstLine = text.split("\n").find((line) => line.trim())!.trim();
    await waitFor(() => {
      const stillOpen = input.isConnected && visible(input) && textOf(input).trim();
      return !stillOpen && doc.body.textContent?.includes(firstLine) ? true : null;
    }, "Google Docs did not confirm the comment. Check the document: if the comment box is still open, click Comment there.");
  } finally {
    doc.removeEventListener("pointerdown", cancel, true);
    doc.removeEventListener("keydown", cancel, true);
  }
}
