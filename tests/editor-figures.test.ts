// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "../src/preservedImage";
import { Document, ImageRun, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { applySuggestion, findSuggestionMatch, revertImageSuggestion } from "../src/editorOps";
import type { AiSuggestion } from "../src/shared";
import { exportDocx, importDocx } from "../server/docx";

let editor: Editor | null = null;

function makeEditor(html: string): Editor {
  editor = new Editor({ extensions: [StarterKit, Image.configure({ inline: false, allowBase64: true })], content: html });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function figure(overrides: Partial<AiSuggestion>): AiSuggestion {
  return { id: "f1", kind: "image", title: "Figure", original: "[Image 1]", replacement: "", rationale: "", confidence: 0.8, target: "global", status: "pending", ...overrides } as AiSuggestion;
}

function images(ed: Editor): string[] {
  const found: string[] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === "image") found.push(String(node.attrs.src));
  });
  return found;
}

describe("web editor figures", () => {
  it("retains imported Word figure dimensions through editor serialization and rebuilt export", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const source = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new ImageRun({ type: "png", data: png, transformation: { width: 320, height: 160 } })] })] }] }));
    const imported = await importDocx(source, "source.docx");
    const ed = makeEditor(imported.html);
    expect(ed.getHTML()).toContain('width="320" height="160"');
    const rebuilt = await exportDocx({ title: "Editor roundtrip", html: ed.getHTML() });
    const zip = await JSZip.loadAsync(rebuilt);
    expect(await zip.file("word/document.xml")!.async("string")).toContain('<wp:extent cx="3048000" cy="1524000"');
    expect((await zip.file(/^word\/media\/.+\.png$/)[0].async("nodebuffer")).equals(png)).toBe(true);
  });
  it("inserts a figure and its caption after the anchor paragraph, keeping the anchor", () => {
    const ed = makeEditor("<p>Enrollment grew at every site.</p><p>Closing.</p>");
    const suggestion = figure({ original: "grew at every site", image: { action: "insert", index: null, path: "/tmp/f.png", url: "/api/ai/images/f.png", mime: "image/png", caption: "Figure 1. Enrollment by site." } });
    expect(findSuggestionMatch(ed, suggestion)).not.toBeNull();
    const result = applySuggestion(ed, suggestion);
    expect(result.ok).toBe(true);
    expect(ed.getText()).toContain("Enrollment grew at every site.");
    const html = ed.getHTML();
    expect(html.indexOf("Enrollment grew")).toBeLessThan(html.indexOf("/api/ai/images/f.png"));
    expect(html.indexOf("/api/ai/images/f.png")).toBeLessThan(html.indexOf("Figure 1. Enrollment by site."));
    expect(html.indexOf("Figure 1. Enrollment by site.")).toBeLessThan(html.indexOf("Closing."));
    expect(revertImageSuggestion(ed, suggestion, null)).toBe(true);
    expect(images(ed)).toEqual([]);
    expect(ed.getText()).not.toContain("Figure 1.");
  });

  it("refuses an insert whose anchor is gone", () => {
    const ed = makeEditor("<p>Something else.</p>");
    expect(applySuggestion(ed, figure({ original: "missing anchor text", image: { action: "insert", index: null, path: "", url: "/x.png", mime: "image/png" } })).ok).toBe(false);
  });

  it("deletes a picture and puts it back on undo", () => {
    const ed = makeEditor('<p>Before.</p><img src="/a.png"><img src="/b.png"><p>After.</p>');
    const suggestion = figure({ image: { action: "delete", index: 1, path: "", url: "", mime: "image/png", originalUrl: "/b.png" } });
    const result = applySuggestion(ed, suggestion);
    expect(result.ok).toBe(true);
    expect(images(ed)).toEqual(["/a.png"]);
    expect(revertImageSuggestion(ed, suggestion, result.ok ? result.range.from : null)).toBe(true);
    expect(images(ed)).toEqual(["/a.png", "/b.png"]);
  });

  it("still replaces a picture, and undo restores the original", () => {
    const ed = makeEditor('<img src="/a.png"><p>Text.</p>');
    const suggestion = figure({ image: { index: 0, path: "/n.png", url: "/n.png", mime: "image/png", originalUrl: "/a.png" } });
    expect(applySuggestion(ed, suggestion).ok).toBe(true);
    expect(images(ed)).toEqual(["/n.png"]);
    expect(revertImageSuggestion(ed, suggestion, null)).toBe(true);
    expect(images(ed)).toEqual(["/a.png"]);
  });
});
