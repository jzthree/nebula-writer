import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface ReviewHighlightRange {
  from: number;
  to: number;
}

export interface ReviewTrace extends ReviewHighlightRange {
  id: string;
  replacementText?: string;
  status: "pending" | "accepted" | "user-insert" | "user-delete";
  deletedText?: string;
  title?: string;
}

interface ReviewDecorationState {
  active: ReviewHighlightRange | null;
  traces: ReviewTrace[];
}

interface ReviewHighlightMeta {
  clear?: boolean;
  range?: ReviewHighlightRange;
  traces?: ReviewTrace[];
  addTrace?: ReviewTrace;
  removeTraceId?: string;
}

const emptyReviewDecorationState: ReviewDecorationState = {
  active: null,
  traces: []
};

const reviewHighlightKey = new PluginKey<ReviewDecorationState>("review-highlight");

export const ReviewHighlight = Extension.create({
  name: "reviewHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<ReviewDecorationState>({
        key: reviewHighlightKey,
        state: {
          init: () => emptyReviewDecorationState,
          apply(transaction, current) {
            const meta = transaction.getMeta(reviewHighlightKey) as ReviewHighlightMeta | undefined;
            const mapped = mapReviewDecorationState(current, transaction.mapping);

            if (meta?.clear) {
              return { ...mapped, active: null };
            }
            if (meta?.range) {
              return {
                ...mapped,
                active: normalizeRange(meta.range)
              };
            }

            if (meta?.traces) {
              return {
                ...mapped,
                traces: normalizeTraces(meta.traces)
              };
            }

            if (meta?.removeTraceId) {
              return {
                ...mapped,
                traces: mapped.traces.filter((existing) => existing.id !== meta.removeTraceId)
              };
            }

            if (meta?.addTrace) {
              const trace = normalizeTrace(meta.addTrace);
              if (!trace) {
                return mapped;
              }
              return {
                ...mapped,
                traces: [trace, ...mapped.traces.filter((existing) => existing.id !== trace.id)]
              };
            }

            return mapped;
          }
        },
        props: {
          decorations(state) {
            const reviewState = reviewHighlightKey.getState(state);
            if (!reviewState?.active && !reviewState?.traces.length) {
              return DecorationSet.empty;
            }

            const decorations = reviewState.traces.flatMap((trace) => {
              if (trace.status === "user-delete" && trace.from === trace.to) {
                return Decoration.widget(trace.from, () => {
                  const marker = document.createElement("span");
                  marker.className = "review-trace-delete-widget";
                  marker.dataset.reviewTrace = trace.id;
                  marker.title = trace.title || `Deleted: ${trace.deletedText ?? ""}`;
                  marker.textContent = "del";
                  return marker;
                }, { side: -1 });
              }

              if (trace.status === "pending" && trace.replacementText) {
                const active = Boolean(reviewState.active && trace.id && overlaps(trace, reviewState.active));
                return [
                  Decoration.inline(trace.from, trace.to, {
                    class: `review-trace review-trace-pending-source${active ? " review-trace-active" : ""}`,
                    "data-review-trace": trace.id,
                    "data-review-role": "source",
                    title: trace.title || reviewTraceTitle(trace)
                  }),
                  Decoration.widget(trace.from, () => {
                    const preview = document.createElement("span");
                    preview.className = `review-trace-preview-widget${active ? " review-trace-active" : ""}`;
                    preview.dataset.reviewTrace = trace.id;
                    preview.dataset.reviewRole = "replacement";
                    preview.setAttribute("contenteditable", "true");
                    preview.setAttribute("aria-readonly", "true");
                    preview.setAttribute("aria-label", "Proposed AI text");
                    preview.spellcheck = false;
                    preview.title = trace.title || reviewTraceTitle(trace);
                    preview.textContent = trace.replacementText ?? "";
                    blockReplacementPreviewMutationEvents(preview);
                    return preview;
                  }, {
                    ignoreSelection: true,
                    key: `${trace.id}-preview`,
                    raw: true,
                    side: -1,
                    stopEvent: stopReplacementPreviewEvent
                  })
                ];
              }

              return Decoration.inline(trace.from, trace.to, {
                class: `review-trace review-trace-${trace.status}${reviewState.active && trace.id && overlaps(trace, reviewState.active) ? " review-trace-active" : ""}`,
                "data-review-trace": trace.id,
                title: trace.title || reviewTraceTitle(trace)
              });
            });

            if (reviewState.active) {
              decorations.push(Decoration.inline(reviewState.active.from, reviewState.active.to, {
                class: "review-target-highlight"
              }));
            }

            return DecorationSet.create(state.doc, decorations);
          }
        }
      })
    ];
  }
});

export function setReviewHighlight(editor: Editor, range: ReviewHighlightRange): void {
  editor.view.dispatch(editor.state.tr.setMeta(reviewHighlightKey, { range }));
}

export function clearReviewHighlight(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(reviewHighlightKey, { clear: true }));
}

export function setReviewTraces(editor: Editor, traces: ReviewTrace[]): void {
  editor.view.dispatch(editor.state.tr.setMeta(reviewHighlightKey, { traces }));
}

export function addReviewTrace(editor: Editor, trace: ReviewTrace): void {
  editor.view.dispatch(editor.state.tr.setMeta(reviewHighlightKey, { addTrace: trace }));
}

export function removeReviewTrace(editor: Editor, id: string): void {
  editor.view.dispatch(editor.state.tr.setMeta(reviewHighlightKey, { removeTraceId: id }));
}

function mapReviewDecorationState(state: ReviewDecorationState, mapping: { map: (position: number) => number }): ReviewDecorationState {
  return {
    active: state.active ? normalizeRange({
      from: mapping.map(state.active.from),
      to: mapping.map(state.active.to)
    }) : null,
    traces: normalizeTraces(state.traces.map((trace) => ({
      ...trace,
      from: mapping.map(trace.from),
      to: mapping.map(trace.to)
    })))
  };
}

function normalizeTraces(traces: ReviewTrace[]): ReviewTrace[] {
  return traces
    .map(normalizeTrace)
    .filter((trace): trace is ReviewTrace => trace !== null);
}

function normalizeTrace(trace: ReviewTrace): ReviewTrace | null {
  const range = normalizeRange(trace);
  if (range) {
    return { ...trace, ...range };
  }
  return trace.status === "user-delete" && trace.from === trace.to ? trace : null;
}

function normalizeRange(range: ReviewHighlightRange): ReviewHighlightRange | null {
  return range.from < range.to ? range : null;
}

function overlaps(left: ReviewHighlightRange, right: ReviewHighlightRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function reviewTraceTitle(trace: ReviewTrace): string {
  switch (trace.status) {
    case "accepted":
      return "Accepted AI edit";
    case "user-insert":
      return "User tracked edit";
    case "user-delete":
      return `User deletion${trace.deletedText ? `: ${trace.deletedText}` : ""}`;
    default:
      return "Pending AI suggestion";
  }
}

function blockReplacementPreviewMutationEvents(element: HTMLElement): void {
  ["beforeinput", "cut", "drop", "input", "paste"].forEach((eventName) => {
    element.addEventListener(eventName, (event) => {
      event.preventDefault();
    });
  });
}

function stopReplacementPreviewEvent(event: Event): boolean {
  if (event.type === "beforeinput" || event.type === "cut" || event.type === "drop" || event.type === "input" || event.type === "paste") {
    event.preventDefault();
  }
  return true;
}
