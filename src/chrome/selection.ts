export interface DocsSelectionReader {
  read(): string;
  dispose(): void;
}

function meaningfulText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  return /^[\s\u200b\ufeff]*$/u.test(normalized) ? "" : normalized;
}

function rangeText(node: Node): string {
  if (node.nodeType === 3) {
    return node.textContent ?? "";
  }
  const element = node.nodeType === 1 ? node as Element : null;
  if (element?.tagName === "BR") {
    return element.getAttribute("role") === "presentation" ? "" : "\n";
  }
  const text = Array.from(node.childNodes, rangeText).join("");
  return element && /^(P|DIV|LI)$/.test(element.tagName) ? `${text}\n` : text;
}

function selectedText(doc: Document, root: Element | null): string {
  const selection = doc.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
    || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
    return "";
  }
  return meaningfulText(rangeText(selection.getRangeAt(0).cloneContents()).replace(/\n$/, ""));
}

/** Docs normally paints selections on canvas and only exports their text on Copy. */
export function createDocsSelectionReader(doc: Document): DocsSelectionReader {
  let copiedText = "";
  let generation = 0;
  let disposed = false;
  let frame: HTMLIFrameElement | null = null;
  let frameDocument: Document | null = null;
  let exportBeforeAction: { element: Element | null; html: string | undefined } | null = null;
  const cleanups: Array<() => void> = [];
  let frameCleanups: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const invalidate = () => {
    generation += 1;
    copiedText = "";
    const element = frameDocument?.querySelector('[contenteditable="true"] [id^="docs-internal-guid-"]') ?? null;
    exportBeforeAction = { element, html: element?.outerHTML };
  };

  function watchDocument(target: Document): Array<() => void> {
    const remove: Array<() => void> = [];
    for (const event of ["pointerdown", "mousedown", "keydown", "beforeinput", "input", "paste", "cut"]) {
      target.addEventListener(event, invalidate, true);
      remove.push(() => target.removeEventListener(event, invalidate, true));
    }
    const onCopy = (event: ClipboardEvent) => {
      const editor = target.querySelector<HTMLElement>('[contenteditable="true"]');
      const source = event.target as Node | null;
      if (target !== frameDocument || !editor || !source || !editor.contains(source)) {
        return;
      }
      const copiedAt = generation;
      const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
      const previousExport = exportBeforeAction?.element ?? editor.querySelector('[id^="docs-internal-guid-"]');
      const previousHtml = exportBeforeAction ? exportBeforeAction.html : previousExport?.outerHTML;
      // Docs populates its hidden editor while handling Copy. Never initiate a
      // copy ourselves, read the system clipboard, or reuse the whole frame body.
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (disposed || copiedAt !== generation || target !== frameDocument) {
          return;
        }
        const exported = editor.querySelector<HTMLElement>('[id^="docs-internal-guid-"]');
        const freshExport = exported && (exported !== previousExport || exported.outerHTML !== previousHtml);
        copiedText = meaningfulText(clipboardText)
          || (editor.querySelector("[data-ri]") ? selectedText(target, editor) : "")
          || (freshExport ? selectedText(target, editor) || meaningfulText(rangeText(exported).replace(/\n$/, "")) : "");
        exportBeforeAction = null;
      }, 0);
      timers.add(timer);
    };
    target.addEventListener("copy", onCopy, true);
    remove.push(() => target.removeEventListener("copy", onCopy, true));
    return remove;
  }

  function connectFrame(): void {
    const nextFrame = doc.querySelector<HTMLIFrameElement>("iframe.docs-texteventtarget-iframe");
    let nextDocument: Document | null = null;
    try {
      nextDocument = nextFrame?.contentDocument ?? null;
    } catch {
      // The editor may be navigating; wait for a same-origin frame to return.
    }
    if (nextFrame === frame && nextDocument === frameDocument) {
      return;
    }
    frame?.removeEventListener("load", connectFrame);
    frameCleanups.forEach((remove) => remove());
    invalidate();
    frame = nextFrame;
    frameDocument = nextDocument;
    exportBeforeAction = null;
    frame?.addEventListener("load", connectFrame);
    frameCleanups = frameDocument ? watchDocument(frameDocument) : [];
  }

  cleanups.push(...watchDocument(doc));
  connectFrame();
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
      node.nodeType === 1 && ((node as Element).matches("iframe") || (node as Element).querySelector("iframe"))))) {
      connectFrame();
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  return {
    read() {
      if (disposed) {
        return "";
      }
      connectFrame();
      const legacy = selectedText(doc, doc.querySelector(".kix-appview-editor"));
      if (legacy) {
        return legacy;
      }
      const editor = frameDocument?.querySelector('[contenteditable="true"]') ?? null;
      // Braille mode mirrors live text runs in this frame. Its native range is
      // authoritative; body text would incorrectly select the entire paragraph.
      if (frameDocument && editor?.querySelector("[data-ri]")) {
        return selectedText(frameDocument, editor);
      }
      return copiedText;
    },
    dispose() {
      disposed = true;
      invalidate();
      observer.disconnect();
      frame?.removeEventListener("load", connectFrame);
      frameCleanups.forEach((remove) => remove());
      cleanups.forEach((remove) => remove());
      timers.forEach(clearTimeout);
      timers.clear();
    }
  };
}
