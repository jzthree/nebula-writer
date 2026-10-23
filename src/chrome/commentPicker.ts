export interface CommentPickerConfig {
  paneOrigin: string;
  extensionOrigin: string;
  apiKey: string;
  appId: string;
  docId: string;
  documentName: string;
}

/** Tokens travel only through an origin-checked message, never URLs or storage. */
export function openCommentPicker(config: CommentPickerConfig, getToken: () => Promise<string>): Promise<void> {
  if (!config.apiKey || !/^\d+$/.test(config.appId)) {
    return Promise.reject(new Error("Google Picker is not configured. Enable the Google Drive and Google Picker APIs, then run chrome:setup with --picker-api-key and --picker-app-id."));
  }
  const nonce = crypto.randomUUID();
  const url = new URL("/gdocs/comment-picker.html", config.paneOrigin);
  url.searchParams.set("host", config.extensionOrigin);
  url.searchParams.set("nonce", nonce);
  const popup = window.open(url.href, "_blank", "popup,width=900,height=700");
  if (!popup) return Promise.reject(new Error("Chrome blocked the Google file picker. Allow this popup and try again."));
  return new Promise<void>((resolve, reject) => {
    let channel: MessageChannel | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      clearInterval(closed);
      channel?.port1.close();
      popup.close();
      if (error) reject(error); else resolve();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== config.paneOrigin || event.source !== popup || event.data?.nebula !== "comment-picker-ready"
        || event.data?.nonce !== nonce || channel) return;
      channel = new MessageChannel();
      channel.port1.onmessage = (message) => {
        const data = message.data as { type?: string; docId?: string; error?: string } | null;
        if (data?.type === "picked" && data.docId === config.docId) finish();
        else if (data?.type === "picked") finish(new Error("A different document was selected. Reconnect comments and choose the document open beside Writer."));
        else if (data?.type === "cancel") finish(new Error("Comment connection cancelled."));
        else if (data?.type === "error") finish(new Error("Google Picker could not open. Check its API key restrictions and enabled APIs."));
      };
      void getToken().then((token) => {
        if (settled || popup.closed || !channel) return;
        popup.postMessage({
          nebula: "comment-picker-init", nonce, token, apiKey: config.apiKey,
          appId: config.appId, documentName: config.documentName
        }, config.paneOrigin, [channel.port2]);
      }).catch(() => finish(new Error("Google did not grant per-file comment access. Connect comments again and approve the Google prompt.")));
    };
    const timeout = setTimeout(() => finish(new Error("Google file picker timed out. Connect comments again.")), 5 * 60_000);
    const closed = setInterval(() => { if (popup.closed) finish(new Error("Comment connection cancelled.")); }, 500);
    window.addEventListener("message", onMessage);
  });
}
