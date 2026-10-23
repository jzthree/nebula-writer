import "./commentPicker.css";

interface PickerView {
  setMimeTypes(value: string): PickerView;
  setIncludeFolders(value: boolean): PickerView;
}
interface PickerBuilder {
  addView(view: PickerView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setSize(width: number, height: number): PickerBuilder;
  setCallback(callback: (data: { action: string; docs?: Array<{ id: string }> }) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}
interface PickerWindow extends Window {
  gapi?: { load(name: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void };
  google?: { picker: {
    DocsView: new () => PickerView;
    PickerBuilder: new () => PickerBuilder;
    Action: { PICKED: string; CANCEL: string };
  } };
}

const status = document.getElementById("status")!;
const query = new URLSearchParams(location.search);
const host = query.get("host") ?? "";
const nonce = query.get("nonce");
let port: MessagePort | null = null;
let started = false;
const validHost = /^chrome-extension:\/\/[a-p]{32}$/.test(host) && !!nonce && !!window.opener;

document.getElementById("close")!.addEventListener("click", () => {
  port?.postMessage({ type: "cancel" });
  window.close();
});

function fail(): void {
  status.textContent = "Google Picker could not load. Check the API key restrictions and enabled APIs.";
  port?.postMessage({ type: "error" });
}

if (!validHost) {
  status.textContent = "Open the comment picker from Nebula Writer's Connect comments command.";
} else {
  const ready = setInterval(() => {
    if (!started) window.opener?.postMessage({ nebula: "comment-picker-ready", nonce }, host);
  }, 250);
  window.addEventListener("pagehide", () => clearInterval(ready), { once: true });
  window.addEventListener("message", (event) => {
    if (started || event.origin !== host || (event.source !== null && event.source !== window.opener)
      || event.data?.nebula !== "comment-picker-init" || event.data?.nonce !== nonce || event.ports.length !== 1) return;
    const data = event.data as { token?: string; apiKey?: string; appId?: string; documentName?: string };
    if (!data.token || !data.apiKey || !data.appId || !/^\d+$/.test(data.appId)) return;
    started = true;
    clearInterval(ready);
    port = event.ports[0];
    const token = data.token;
    const apiKey = data.apiKey;
    const appId = data.appId;
    // Remote Google code runs only on this regular localhost page, never in
    // the extension's privileged context or its document-review iframe.
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.onerror = fail;
    script.onload = () => {
      const target = window as PickerWindow;
      if (!target.gapi) { fail(); return; }
      target.gapi.load("picker", {
        onerror: fail, timeout: 15_000, ontimeout: fail,
        callback: () => {
          const api = target.google?.picker;
          if (!api) { fail(); return; }
          const view = new api.DocsView().setMimeTypes("application/vnd.google-apps.document").setIncludeFolders(false);
          new api.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(apiKey).setAppId(appId)
            .setOrigin(location.origin).setTitle(`Connect comments: ${data.documentName ?? "Google Doc"}`)
            .setSize(Math.max(300, innerWidth - 24), Math.max(300, innerHeight - 100))
            .setCallback((result) => {
              if (result.action === api.Action.PICKED) port?.postMessage({ type: "picked", docId: result.docs?.[0]?.id });
              else if (result.action === api.Action.CANCEL) port?.postMessage({ type: "cancel" });
            }).build().setVisible(true);
          status.textContent = "Choose the document open beside Writer.";
        }
      });
    };
    document.head.append(script);
  });
}
