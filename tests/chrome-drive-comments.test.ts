// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readDriveComments, unavailableComments, type DriveCommentsPage } from "../src/chrome/driveComments";
import { isDocumentCommentList } from "../src/shared";

const DOC = "Opening.\nAvailable material limits resolution.\nClosing.";
const thread = (id = "thread-1") => ({
  id, content: "Use input data instead of low coverage.", author: { displayName: "Reviewer" },
  quotedFileContent: { value: "Available material limits resolution." },
  createdTime: "2026-10-01T00:00:00Z", resolved: false,
  replies: [{ content: "Agreed; distinguish it from held-out data.", author: { displayName: "Author" }, createdTime: "2026-10-02T00:00:00Z" }]
});

describe("Google Drive comment threads", () => {
  it("preserves authors, replies, quoted text and resolved state", async () => {
    const result = await readDriveComments("paper-id", DOC, async () => ({ comments: [thread(), { ...thread("done"), resolved: true }] }));
    expect(result.commentsStatus.state).toBe("complete");
    expect(result.comments[0]).toEqual({
      id: "thread-1", text: thread().content, author: "Reviewer", anchorText: thread().quotedFileContent.value,
      offset: 9, resolved: false, createdAt: "2026-10-01T00:00:00Z",
      replies: [{ author: "Author", text: thread().replies[0].content, createdAt: "2026-10-02T00:00:00Z" }]
    });
    expect(result.comments[1].resolved).toBe(true);
    expect(isDocumentCommentList(result.comments)).toBe(true);
  });

  it("paginates with explicit fields and reads only the requested file", async () => {
    const getPage = vi.fn<(path: string) => Promise<DriveCommentsPage>>()
      .mockResolvedValueOnce({ comments: [thread()], nextPageToken: "next+page" })
      .mockResolvedValueOnce({ comments: [thread("second")] });
    const result = await readDriveComments("paper/id", DOC, getPage);
    expect(result.comments).toHaveLength(2);
    expect(getPage).toHaveBeenCalledTimes(2);
    const urls = getPage.mock.calls.map(([path]) => new URL(path, "https://www.googleapis.com"));
    expect(urls[0].pathname).toBe("/files/paper%2Fid/comments");
    expect(urls[0].searchParams.get("fields")).toContain("replies(");
    expect(urls[0].searchParams.get("includeDeleted")).toBe("false");
    expect(urls[1].searchParams.get("pageToken")).toBe("next+page");
  });

  it("distinguishes a successful empty result from missing access", async () => {
    expect((await readDriveComments("paper", DOC, async () => ({}))).commentsStatus.state).toBe("complete");
    const denied = await readDriveComments("paper", DOC, async () => { throw new Error("403 insufficient permissions"); });
    expect(denied.comments).toEqual([]);
    expect(denied.commentsStatus.state).toBe("unavailable");
    expect(unavailableComments("Not connected").commentsStatus).toEqual({ state: "unavailable", detail: "Not connected" });
  });

  it("marks a later page failure as partial, never complete", async () => {
    const getPage = vi.fn<(path: string) => Promise<DriveCommentsPage>>()
      .mockResolvedValueOnce({ comments: [thread()], nextPageToken: "next" })
      .mockRejectedValueOnce(new Error("network"));
    const result = await readDriveComments("paper", DOC, getPage);
    expect(result.comments).toHaveLength(1);
    expect(result.commentsStatus.state).toBe("partial");
  });

  it("excludes deleted comments/replies and does not invent missing or ambiguous anchors", async () => {
    const result = await readDriveComments("paper", "repeat repeat", async () => ({ comments: [
      { ...thread("deleted"), deleted: true },
      { ...thread(), quotedFileContent: { value: "repeat" }, replies: [{ content: "Deleted", deleted: true }, { content: "Visible reply" }] },
      { ...thread("unanchored"), quotedFileContent: undefined }
    ] }));
    expect(result.comments).toHaveLength(2);
    expect(result.comments.every((comment) => comment.offset === null)).toBe(true);
    expect(result.comments[0].replies).toEqual([{ author: null, text: "Visible reply", createdAt: null }]);
  });

  it("maps whitespace-normalized quotes to exact offsets", async () => {
    const result = await readDriveComments("paper", "Opening.\nAvailable\u00a0material  limits resolution.", async () => ({ comments: [thread()] }));
    expect(result.comments[0].offset).toBe(9);
    expect(result.comments[0].anchorText).toBe(thread().quotedFileContent.value);
  });

  it("bounds oversized threads and marks truncation", async () => {
    const result = await readDriveComments("paper", DOC, async () => ({ comments: [{ ...thread(), content: "x".repeat(9_000) }] }));
    expect(result.comments[0].text).toHaveLength(8_000);
    expect(result.commentsStatus.state).toBe("partial");
    expect(isDocumentCommentList(result.comments)).toBe(true);
  });

  it("caps large documents at the shared comment limit", async () => {
    let page = 0;
    const result = await readDriveComments("paper", DOC, async () => ({
      comments: Array.from({ length: 100 }, (_, i) => thread(`comment-${page}-${i}`)), nextPageToken: `page-${++page}`
    }));
    expect(result.comments).toHaveLength(300);
    expect(result.commentsStatus.state).toBe("partial");
  });

  it("bounds reply metadata even when replies contain very little text", async () => {
    const result = await readDriveComments("paper", DOC, async () => ({ comments: [{
      ...thread(), replies: Array.from({ length: 1_001 }, () => ({ content: "x" }))
    }] }));
    expect(result.comments[0].replies).toHaveLength(1_000);
    expect(result.commentsStatus.state).toBe("partial");
  });

  it("does not loop on repeated page tokens or double-count duplicate threads", async () => {
    const getPage = vi.fn(async () => ({ comments: [thread()], nextPageToken: "same" }));
    const result = await readDriveComments("paper", DOC, getPage);
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(result.comments).toHaveLength(1);
    expect(result.commentsStatus.state).toBe("partial");
  });
});
