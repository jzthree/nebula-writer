import { DOCUMENT_COMMENT_LIMIT, type DocumentComment, type DocumentCommentsStatus } from "../shared";
import { locateDocsSelection } from "./selectionMatch";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_API_ORIGIN = "https://www.googleapis.com/*";
const FIELDS = "nextPageToken,comments(id,content,createdTime,resolved,deleted,author(displayName),quotedFileContent(value),replies(content,createdTime,deleted,author(displayName)))";
const TEXT_BUDGET = 200_000;
const FIELD_LIMIT = 8_000;
const REPLY_LIMIT = 1_000;

interface DriveReply {
  content?: string;
  createdTime?: string;
  deleted?: boolean;
  author?: { displayName?: string };
}

interface DriveComment extends DriveReply {
  id?: string;
  resolved?: boolean;
  quotedFileContent?: { value?: string };
  replies?: DriveReply[];
}

export interface DriveCommentsPage {
  comments?: DriveComment[];
  nextPageToken?: string;
}

export interface DriveCommentsResult {
  comments: DocumentComment[];
  commentsStatus: DocumentCommentsStatus;
}

export function unavailableComments(detail: string): DriveCommentsResult {
  return { comments: [], commentsStatus: { state: "unavailable", detail } };
}

/** Read only this file; never use a missing/failed page as evidence of no comments. */
export async function readDriveComments(
  docId: string,
  documentText: string,
  getPage: (path: string) => Promise<DriveCommentsPage>
): Promise<DriveCommentsResult> {
  const comments: DocumentComment[] = [];
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  let used = 0;
  let replyCount = 0;
  let partial = false;
  const bounded = (text: string | undefined): string => {
    const source = text ?? "";
    const value = source.slice(0, Math.max(0, Math.min(FIELD_LIMIT, TEXT_BUDGET - used)));
    used += value.length;
    partial ||= value.length !== source.length;
    return value;
  };
  try {
    do {
      const query = new URLSearchParams({ fields: FIELDS, pageSize: "100", includeDeleted: "false" });
      if (pageToken) query.set("pageToken", pageToken);
      const page = await getPage(`/files/${encodeURIComponent(docId)}/comments?${query}`);
      if (!page || typeof page !== "object" || (page.comments !== undefined && !Array.isArray(page.comments))
        || (page.nextPageToken !== undefined && typeof page.nextPageToken !== "string")) {
        throw new Error("Invalid Google Drive comments response.");
      }
      for (const item of page.comments ?? []) {
        if (item.deleted) continue;
        if (typeof item.id !== "string" || !item.id || typeof item.content !== "string") {
          partial = true;
          continue;
        }
        if (ids.has(item.id)) continue;
        if (comments.length >= DOCUMENT_COMMENT_LIMIT || used >= TEXT_BUDGET) {
          partial = true;
          break;
        }
        ids.add(item.id);
        const anchorText = bounded(item.quotedFileContent?.value);
        const match = anchorText ? locateDocsSelection([{ text: documentText }], anchorText) : null;
        const text = bounded(item.content);
        const replies: DocumentComment["replies"] = [];
        for (const reply of item.replies ?? []) {
          if (reply.deleted) continue;
          if (typeof reply.content !== "string") { partial = true; continue; }
          if (replyCount >= REPLY_LIMIT || used >= TEXT_BUDGET) { partial = true; break; }
          replies.push({
            author: reply.author?.displayName?.slice(0, 200) ?? null,
            text: bounded(reply.content),
            createdAt: reply.createdTime ?? null
          });
          replyCount++;
        }
        comments.push({
          id: item.id,
          author: item.author?.displayName?.slice(0, 200) ?? null,
          text,
          anchorText,
          offset: match?.startOffset ?? null,
          resolved: item.resolved === true,
          createdAt: item.createdTime ?? null,
          replies
        });
      }
      pageToken = page.nextPageToken;
      if (pageToken && tokens.has(pageToken)) throw new Error("Repeated Google Drive page token.");
      if (pageToken) tokens.add(pageToken);
      if (pageToken && (comments.length >= DOCUMENT_COMMENT_LIMIT || used >= TEXT_BUDGET || tokens.size >= 20)) {
        partial = true;
        break;
      }
    } while (pageToken);
  } catch {
    return comments.length ? {
      comments,
      commentsStatus: { state: "partial", detail: "Some Google Docs comment threads were read, but a later page failed. Do not assume these are all the comments." }
    } : unavailableComments("Google Docs comments could not be read. Check this file's access and enable the Google Drive API in Writer's Google Cloud project.");
  }
  return {
    comments,
    commentsStatus: {
      state: partial ? "partial" : "complete",
      detail: partial
        ? "Google Docs comments were limited to Writer's thread/reply/text budget; some content is omitted."
        : "Successfully read the comment threads Google Drive made accessible for this document."
    }
  };
}
