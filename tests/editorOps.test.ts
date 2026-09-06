import { describe, expect, it, vi } from "vitest";
import { applySuggestion, centerSuggestionTarget, findSuggestionMatch, findSuggestionRange, normalizeText, primeSuggestionRangeCache, replacementToContent, selectSuggestionTarget } from "../src/editorOps";
import type { AiSuggestion } from "../src/shared";

describe("editor operations", () => {
  it("normalizes text for suggestion matching", () => {
    expect(normalizeText("  One\n\n  two\tthree  ")).toBe("One two three");
  });

  it("turns multi-line replacements into editor paragraphs", () => {
    expect(replacementToContent("First line.\n\nSecond <line>.")).toBe("<p>First line.</p><p>Second &lt;line&gt;.</p>");
  });

  it("keeps single-line replacements inline", () => {
    expect(replacementToContent("A tighter <sentence>.")).toBe("A tighter &lt;sentence&gt;.");
  });

  it("uses a still-valid suggestion range before searching the whole document", () => {
    const editor = {
      state: {
        doc: {
          textBetween: vi.fn(() => "Original sentence.")
        }
      }
    };

    expect(findSuggestionRange(editor as never, suggestion({ range: { from: 4, to: 22, text: "Original sentence." } }))).toEqual({ from: 4, to: 22 });
    expect(editor.state.doc.textBetween).toHaveBeenCalledWith(4, 22, "\n");
  });

  it("prefers substring matches inside the original selection over earlier duplicates", () => {
    const editor = {
      state: {
        doc: {
          textBetween: vi.fn(() => "Repeat target text. More context."),
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Intro target text. Outro" }, 1);
            visitor({ isText: true, text: "Repeat target text. More context." }, 36);
          })
        }
      }
    };

    expect(findSuggestionRange(editor as never, suggestion({
      original: "target text.",
      range: {
        from: 36,
        to: 69,
        text: "Repeat target text. More context."
      }
    }))).toEqual({ from: 43, to: 55 });
  });

  it("uses saved range context to choose the intended duplicate inside a broad selection", () => {
    const editor = {
      state: {
        doc: {
          textBetween: vi.fn(() => "First target text. Middle target text. End."),
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "First target text. Middle target text. End." }, 10);
          })
        }
      }
    };

    expect(findSuggestionRange(editor as never, suggestion({
      original: "target text.",
      range: {
        from: 10,
        to: 53,
        text: "First target text. Middle target text. End."
      }
    }))).toEqual({ from: 16, to: 28 });

    expect(findSuggestionRange(editor as never, suggestion({
      original: "target text.",
      range: {
        from: 10,
        to: 53,
        text: "First target text. Middle target text. End.".replace("target text.", "earlier wording.")
      }
    }))).toEqual({ from: 36, to: 48 });
  });

  it("falls back to text matching when a restored suggestion range is outside the editor document", () => {
    const editor = {
      state: {
        doc: {
          content: { size: 24 },
          textBetween: vi.fn(() => {
            throw new Error("range out of bounds");
          }),
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Original sentence. More text." }, 1);
          })
        }
      }
    };

    expect(findSuggestionRange(editor as never, suggestion({ range: { from: 2000, to: 2040, text: "Original sentence." } }))).toEqual({ from: 1, to: 19 });
    expect(editor.state.doc.textBetween).not.toHaveBeenCalled();
  });

  it("matches suggestion text across protected inline equation previews", () => {
    const editor = {
      state: {
        doc: {
          descendants: vi.fn((visitor: (node: unknown, pos: number) => void) => {
            visitor({ isText: true, text: "Train " }, 1);
            visitor({ attrs: { text: "Xt+1" }, isAtom: true, isInline: true, nodeSize: 1 }, 7);
            visitor({ isText: true, text: " model now." }, 8);
          })
        }
      }
    };

    expect(findSuggestionRange(editor as never, suggestion({
      original: "Train Xt+1 model now."
    }))).toEqual({ from: 1, to: 19 });
  });

  it("matches suggestion text across paragraph boundaries", () => {
    const editor = {
      state: {
        doc: {
          descendants: vi.fn((visitor: (node: unknown, pos: number) => void) => {
            visitor({ isText: true, text: "First paragraph ends." }, 1);
            visitor({ isText: true, text: "Second paragraph starts." }, 24);
          })
        }
      }
    };

    expect(findSuggestionRange(editor as never, suggestion({
      original: "First paragraph ends. Second paragraph starts."
    }))).toEqual({ from: 1, to: 48 });
  });

  it("caches suggestion target ranges for repeated Find jumps in the same editor document", () => {
    const editor = {
      state: {
        doc: {
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Opening. Original sentence. Closing." }, 1);
          })
        }
      }
    };
    const cachedSuggestion = suggestion({ range: null });

    primeSuggestionRangeCache(editor as never, [cachedSuggestion]);
    expect(findSuggestionRange(editor as never, cachedSuggestion)).toEqual({ from: 10, to: 28 });

    expect(editor.state.doc.descendants).toHaveBeenCalledTimes(1);
  });

  it("classifies a still-valid stored range as an exact match", () => {
    const editor = {
      state: {
        doc: {
          textBetween: vi.fn(() => "Original sentence.")
        }
      }
    };

    expect(findSuggestionMatch(editor as never, suggestion({ range: { from: 4, to: 22, text: "Original sentence." } })))
      .toEqual({ from: 4, to: 22, matchKind: "exact" });
  });

  it("picks the fallback match closest to the original anchor instead of the first occurrence", () => {
    const repeated = "Repeated phrase here.";
    const editor = {
      state: {
        doc: {
          textBetween: vi.fn(() => "Different text now."),
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: `${repeated} Filler.` }, 1);
            visitor({ isText: true, text: `More filler. ${repeated}` }, 500);
          })
        }
      }
    };

    const match = findSuggestionMatch(editor as never, suggestion({
      original: repeated,
      range: { from: 495, to: 512, text: "stale selection text" }
    }));
    expect(match?.from).toBe(513);
    expect(match?.matchKind).toBe("nearby");
  });

  it("flags a fallback match far from the original anchor as relocated", () => {
    const editor = {
      state: {
        doc: {
          content: { size: 24 },
          textBetween: vi.fn(() => {
            throw new Error("range out of bounds");
          }),
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Original sentence. More text." }, 1);
          })
        }
      }
    };

    expect(findSuggestionMatch(editor as never, suggestion({ range: { from: 9000, to: 9040, text: "Original sentence." } })))
      .toEqual({ from: 1, to: 19, matchKind: "relocated" });
  });

  it("flags anchorless suggestions as unique or ambiguous by occurrence count", () => {
    const singleEditor = {
      state: {
        doc: {
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Original sentence. Tail." }, 1);
          })
        }
      }
    };
    expect(findSuggestionMatch(singleEditor as never, suggestion({ range: null }))?.matchKind).toBe("unique");

    const dupEditor = {
      state: {
        doc: {
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Original sentence. Original sentence." }, 1);
          })
        }
      }
    };
    expect(findSuggestionMatch(dupEditor as never, suggestion({ range: null }))?.matchKind).toBe("ambiguous");
  });

  it("requires confirmation before applying relocated or ambiguous matches", () => {
    const chain = {
      focus: vi.fn(() => chain),
      insertContentAt: vi.fn(() => chain),
      run: vi.fn(() => true)
    };
    const editor = {
      chain: vi.fn(() => chain),
      state: {
        doc: {
          content: { size: 24 },
          textBetween: vi.fn(() => {
            throw new Error("range out of bounds");
          }),
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Original sentence. More text." }, 1);
          })
        }
      }
    };
    const relocated = suggestion({ range: { from: 9000, to: 9040, text: "Original sentence." } });

    const blocked = applySuggestion(editor as never, relocated);
    expect(blocked).toEqual({
      ok: false,
      reason: "needs-confirmation",
      matchKind: "relocated",
      range: { from: 1, to: 19 }
    });
    expect(chain.insertContentAt).not.toHaveBeenCalled();

    const confirmed = applySuggestion(editor as never, relocated, { confirmRelocated: true });
    expect(confirmed).toEqual({ ok: true, matchKind: "relocated", range: { from: 1, to: 19 } });
    expect(chain.insertContentAt).toHaveBeenCalledWith({ from: 1, to: 19 }, "Revised sentence.");
  });

  it("reports a missing target when the suggestion text is gone", () => {
    const editor = {
      chain: vi.fn(),
      state: {
        doc: {
          descendants: vi.fn((visitor: (node: { isText: boolean; text: string }, pos: number) => void) => {
            visitor({ isText: true, text: "Entirely different content." }, 1);
          })
        }
      }
    };

    expect(applySuggestion(editor as never, suggestion({ range: null }))).toEqual({ ok: false, reason: "missing" });
    expect(editor.chain).not.toHaveBeenCalled();
  });

  it("selects and centers a suggestion target instantly", () => {
    const chain = {
      focus: vi.fn(() => chain),
      setTextSelection: vi.fn(() => chain),
      scrollIntoView: vi.fn(() => chain),
      run: vi.fn(() => true)
    };
    const scrollShell = document.createElement("div");
    scrollShell.className = "editor-content-shell";
    const editorDom = document.createElement("div");
    scrollShell.append(editorDom);
    document.body.append(scrollShell);
    Object.defineProperty(scrollShell, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollShell, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scrollShell, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 600, height: 500, left: 0, right: 700, top: 100, width: 700, x: 0, y: 100, toJSON: () => ({}) })
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
    });
    Object.defineProperty(scrollShell, "scrollTo", { configurable: true, value: scrollTo });
    const editor = {
      state: {
        doc: {
          textBetween: vi.fn(() => "Original sentence.")
        }
      },
      chain: vi.fn(() => chain),
      view: {
        coordsAtPos: vi.fn((position: number) => (
          position <= 4
            ? { bottom: 820, left: 0, right: 10, top: 800 }
            : { bottom: 860, left: 0, right: 10, top: 840 }
        )),
        dom: editorDom
      }
    };

    expect(selectSuggestionTarget(editor as never, suggestion({ range: { from: 4, to: 22, text: "Original sentence." } }))).toEqual({ from: 4, to: 22 });
    expect(chain.setTextSelection).toHaveBeenCalledWith({ from: 4, to: 22 });
    expect(chain.scrollIntoView).not.toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith({ top: 480, behavior: "auto" });
    expect(scrollShell.scrollTop).toBe(480);
    scrollShell.remove();
  });

  it("centers the visible pending trace widget when the original source span is hidden", () => {
    const scrollShell = document.createElement("div");
    scrollShell.className = "editor-content-shell";
    const editorDom = document.createElement("div");
    const hiddenSource = document.createElement("span");
    hiddenSource.dataset.reviewTrace = "suggestion-test";
    hiddenSource.className = "review-trace review-trace-pending-source";
    const preview = document.createElement("span");
    preview.dataset.reviewTrace = "suggestion-test";
    preview.className = "review-trace-preview-widget";
    editorDom.append(hiddenSource, preview);
    scrollShell.append(editorDom);
    document.body.append(scrollShell);
    Object.defineProperty(scrollShell, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollShell, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scrollShell, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 600, height: 500, left: 0, right: 700, top: 100, width: 700, x: 0, y: 100, toJSON: () => ({}) })
    });
    Object.defineProperty(hiddenSource, "getClientRects", { configurable: true, value: () => [] });
    Object.defineProperty(preview, "getClientRects", {
      configurable: true,
      value: () => [{ bottom: 840, height: 60, left: 0, right: 100, top: 780, width: 100, x: 0, y: 780, toJSON: () => ({}) }]
    });
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 840, height: 60, left: 0, right: 100, top: 780, width: 100, x: 0, y: 780, toJSON: () => ({}) })
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
    });
    Object.defineProperty(scrollShell, "scrollTo", { configurable: true, value: scrollTo });
    const editor = {
      view: {
        dom: editorDom
      }
    };

    expect(centerSuggestionTarget(editor as never, suggestion())).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 460, behavior: "auto" });
    expect(scrollShell.scrollTop).toBe(460);
    scrollShell.remove();
  });
});

function suggestion(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  return {
    id: "suggestion-test",
    title: "Tighten sentence",
    original: "Original sentence.",
    replacement: "Revised sentence.",
    rationale: "Improves the sentence.",
    confidence: 0.9,
    target: "selection",
    status: "pending",
    ...overrides
  };
}
