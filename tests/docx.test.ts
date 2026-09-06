import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptTrackedChangesByAuthor, analyzeDocxFeatures, exportDocx, exportTrackedChangesFromSource, exportTrackedChangesFromSourceWithReport, extractDocxBodySafeAnchorCandidates, extractDocxBodySafeAnchorDetails, htmlToBlocks, htmlToText, importDocx } from "../server/docx";

describe("DOCX conversion", () => {
  it("converts editor HTML into structured blocks", () => {
    const blocks = htmlToBlocks("<h1>Title</h1><p>Hello <strong>writer</strong>.</p><ul><li>One</li></ul>");

    expect(blocks.map((block) => block.type)).toEqual(["heading1", "paragraph", "bullet"]);
    expect(blocks[1].runs).toEqual([
      { text: "Hello " },
      { text: "writer", bold: true },
      { text: "." }
    ]);
  });

  it("unwraps unknown inline tags instead of leaking their attribute text", () => {
    const blocks = htmlToBlocks([
      "<p>",
      "<span changeid=\"sug-1\" author=\"ai-Codex\" class=\"suggestion-deletion\">old text. </span>",
      "<span changeid=\"sug-1\" author=\"ai-Codex\" class=\"suggestion-insertion\">new <strong>bold</strong> text.</span>",
      "</p>"
    ].join(""));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].runs).toEqual([
      { text: "old text. new " },
      { text: "bold", bold: true },
      { text: " text." }
    ]);
  });

  it("parses suggestion-mark spans into revision runs", () => {
    const blocks = htmlToBlocks([
      "<p>Keep <span data-suggestion-deletion=\"true\" authorname=\"Codex\">old</span>",
      "<span data-suggestion-insertion=\"true\" authorname=\"Codex\">new</span> tail.</p>",
      "<p><span data-suggestion-insertion=\"true\" authorname=\"Claude Code\">A whole inserted paragraph.</span></p>"
    ].join(""));

    expect(blocks[0].runs).toEqual([
      { text: "Keep " },
      { text: "old", revision: { kind: "delete", author: "Codex" } },
      { text: "new", revision: { kind: "insert", author: "Codex" } },
      { text: " tail." }
    ]);
    expect(blocks[1].runs).toEqual([
      { text: "A whole inserted paragraph.", revision: { kind: "insert", author: "Claude Code" } }
    ]);
  });

  it("exports suggestion marks as real tracked changes, including inserted paragraphs", async () => {
    const buffer = await exportDocx({
      title: "Structural",
      trackedChanges: true,
      html: [
        "<p><span data-suggestion-deletion=\"true\" authorname=\"Codex\">Old paragraph struck entirely.</span></p>",
        "<p><span data-suggestion-insertion=\"true\" authorname=\"Codex\">First inserted paragraph.</span></p>",
        "<p><span data-suggestion-insertion=\"true\" authorname=\"Codex\">Second inserted paragraph.</span></p>",
        "<p>Untouched paragraph.</p>"
      ].join("")
    });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect((xml.match(/<w:ins /g) ?? []).length).toBe(2);
    expect((xml.match(/<w:del /g) ?? []).length).toBe(1);
    expect(xml).toContain("w:author=\"Codex\"");
    // inserted text must live INSIDE w:ins, never as plain runs
    const plainBody = xml.replace(/<w:ins [\s\S]*?<\/w:ins>/g, "").replace(/<w:del [\s\S]*?<\/w:del>/g, "");
    expect(plainBody).not.toContain("inserted paragraph");
    expect(plainBody).not.toContain("Old paragraph struck");
    expect(plainBody).toContain("Untouched paragraph.");
  });

  it("round-trips structural tracked changes as per-paragraph revisions", async () => {
    const buffer = await exportDocx({
      title: "Structural roundtrip",
      trackedChanges: true,
      html: [
        "<p><span data-suggestion-deletion=\"true\" authorname=\"Codex\">Old paragraph struck entirely.</span></p>",
        "<p><span data-suggestion-insertion=\"true\" authorname=\"Codex\">First inserted paragraph.</span></p>",
        "<p><span data-suggestion-insertion=\"true\" authorname=\"Codex\">Second inserted paragraph.</span></p>",
        "<p>Untouched paragraph.</p>"
      ].join("")
    });
    const imported = await importDocx(buffer, "structural.docx");
    const changes = imported.sourceTrackedChanges ?? [];
    // one change per paragraph — never a cross-paragraph aggregate
    expect(changes.map((change) => ({ kind: change.kind, text: change.text }))).toEqual([
      { kind: "deleted", text: "Old paragraph struck entirely." },
      { kind: "inserted", text: "First inserted paragraph." },
      { kind: "inserted", text: "Second inserted paragraph." }
    ]);
    // the struck first paragraph has no accepted text before it
    expect(changes[0].contextBefore).toBeUndefined();
    expect(changes[1].author).toBe("Codex");
  });

  it("extracts readable text from HTML", () => {
    expect(htmlToText("<h1>Title</h1><p>Fish &amp; chips</p>")).toBe("Title\nFish & chips");
  });

  it("extracts readable text from richer DOCX HTML structures", () => {
    expect(htmlToText([
      "<table><tbody><tr><th><p>Term</p></th><td><p>Definition</p></td></tr></tbody></table>",
      "<p><img src=\"data:image/png;base64,abc\" alt=\"Figure &amp; caption\" /></p>"
    ].join(""))).toBe("Term\nDefinition\nFigure & caption");
  });

  it("exports and imports a basic docx", async () => {
    const buffer = await exportDocx({
      title: "Round Trip",
      html: "<h1>Round Trip</h1><p>This paragraph survives export.</p>"
    });

    const imported = await importDocx(buffer, "round-trip.docx");

    expect(imported.name).toBe("round-trip.docx");
    expect(imported.plainText).toContain("Round Trip");
    expect(imported.plainText).toContain("This paragraph survives export.");
    expect(imported.features.preservationRecommended).toBe(false);
  });

  it("exports pending AI suggestions as Word tracked changes", async () => {
    const buffer = await exportDocx({
      title: "Tracked Changes",
      html: "<h1>Tracked Changes</h1><p>This is actually very wordy.</p>",
      trackedChanges: true,
      suggestions: [
        {
          id: "suggestion-1",
          title: "Tighten sentence",
          original: "This is actually very wordy.",
          replacement: "This is wordy.",
          rationale: "Removes filler.",
          confidence: 0.8,
          target: "selection",
          status: "pending"
        }
      ]
    });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const settingsXml = await zip.file("word/settings.xml")?.async("string");

    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("<w:ins ");
    expect(documentXml).toContain("<w:delText xml:space=\"preserve\">This is actually very wordy.</w:delText>");
    expect(documentXml).toContain("<w:t xml:space=\"preserve\">This is wordy.</w:t>");
    expect(settingsXml).toContain("<w:trackRevisions/>");
  });

  it("imports DOCX tracked changes as accepted display text", async () => {
    const buffer = await exportDocx({
      title: "Tracked Changes",
      html: "<h1>Tracked Changes</h1><p>This is actually very wordy.</p>",
      trackedChanges: true,
      suggestions: [
        {
          id: "suggestion-accepted-display",
          title: "Tighten sentence",
          original: "This is actually very wordy.",
          replacement: "This is wordy.",
          rationale: "Removes filler.",
          confidence: 0.8,
          target: "selection",
          status: "pending"
        }
      ]
    });

    const imported = await importDocx(buffer, "tracked.docx");

    expect(imported.features.trackedChanges).toBeGreaterThanOrEqual(2);
    expect(imported.features.preservationRecommended).toBe(true);
    expect(imported.messages.join("\n")).toContain("shown as accepted");
    expect(imported.html).toContain("This is wordy.");
    expect(imported.html).not.toContain("This is actually very wordy.");
    expect(imported.plainText).toContain("This is wordy.");
    expect(imported.plainText).not.toContain("This is actually very wordy.");
    expect(imported.sourceTrackedChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "deleted", text: "This is actually very wordy." }),
      expect.objectContaining({ kind: "inserted", text: "This is wordy." })
    ]));
  });

  it("imports nested DOCX insertions without malformed display XML", async () => {
    const imported = await importDocx(await docxWithNestedExistingInsertion(), "nested-insertion.docx");

    expect(imported.features.trackedChanges).toBeGreaterThan(0);
    expect(imported.messages.join("\n")).toContain("shown as accepted");
    expect(imported.plainText).toContain("Outer accepted text");
    expect(imported.plainText).toContain("Nested accepted text");
    expect(imported.plainText).toContain("after nested insertion");
  });

  it("preserves formula and citation XML when tracking changes against an imported source docx", async () => {
    const source = await docxWithFormulaAndCitation();
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-source",
        title: "Tighten sentence",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(documentXml).toContain("<m:oMath>");
    expect(documentXml).toContain("<w:fldSimple w:instr=\" ADDIN CSL_CITATION \">");
    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("<w:ins ");
    expect(documentXml).toContain("This is wordy.");
  });

  it("renders Word equations as visible browser previews while preserving source XML", async () => {
    const source = await docxWithFormulaAndCitation();
    const imported = await importDocx(source, "formula.docx");
    const tracked = await exportTrackedChangesFromSource(source, []);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(imported.features.formulas).toBe(1);
    expect(imported.html).toContain("data-docx-equation=\"true\"");
    expect(imported.html).toContain("data-docx-mathml=");
    expect(imported.html).toContain("data-docx-mathjax-svg=");
    expect(imported.html).toContain("&lt;math xmlns=&quot;http://www.w3.org/1998/Math/MathML&quot;");
    expect(imported.html).toContain("&lt;mjx-container class=&quot;MathJax&quot;");
    expect(imported.html).toContain("role=\"math\"");
    expect(imported.html).toContain("aria-label=\"Word equation preview: x+y\"");
    expect(imported.html).toContain("x+y");
    expect(imported.plainText).toContain("x+y");
    expect(documentXml).toContain("<m:oMath>");
    expect(documentXml).toContain("<m:t>x+y</m:t>");
  });

  it("explains equation-protected anchors when falling back to Word comments", async () => {
    const source = await docxWithFormulaAndCitation();
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-equation-paragraph",
        title: "Clarify formula sentence",
        original: "Formula stays.",
        replacement: "Formula preview stays visible.",
        rationale: "Exercises the formula-specific comment fallback.",
        confidence: 0.9,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentsXml = await zip.file("word/comments.xml")?.async("string");

    expect(result.report).toMatchObject({
      commentedSuggestions: 1,
      matchedSuggestions: 0,
      unmatchedSuggestions: 0
    });
    expect(result.report.commentedSuggestionReasons[0]).toContain("Word equation/math object");
    expect(documentXml).toContain("<m:oMath>");
    expect(documentXml).toContain("<m:t>x+y</m:t>");
    expect(documentXml).not.toContain("<w:del ");
    expect(documentXml).not.toContain("<w:ins ");
    expect(commentsXml).toContain("Clarify formula sentence");
    expect(commentsXml).toContain("Suggested revision: Formula preview stays visible.");
  });

  it("tracks editable text around citation fields without flattening the citation field", async () => {
    const source = await docxWithInlineCitationField();
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-inline-citation",
        title: "Fix target-selection grammar",
        original: "Thus target selection strongly depend on TF21.",
        replacement: "Thus, target selection strongly depends on TF21.",
        rationale: "Fixes grammar while preserving the citation field.",
        confidence: 0.98,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(result.report).toMatchObject({
      commentedSuggestions: 0,
      matchedSuggestions: 1,
      unmatchedSuggestions: 0
    });
    expect(documentXml).toContain("<w:fldSimple w:instr=\" ADDIN CSL_CITATION \">");
    expect(documentXml).toContain("<w:delText xml:space=\"preserve\">Thus target selection strongly depend on TF</w:delText>");
    expect(documentXml).toContain("<w:t xml:space=\"preserve\">Thus, target selection strongly depends on TF</w:t>");
    expect(documentXml).not.toContain("AI review comments");
  });

  it("attributes exported tracked changes to each suggestion's proposer", async () => {
    const source = await exportDocx({
      title: "Attribution Source",
      html: "<p>First sentence needs work.</p><p>Second sentence also needs work.</p>"
    });
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-authored",
        title: "Tighten first sentence",
        original: "First sentence needs work.",
        replacement: "First sentence reads cleanly.",
        rationale: "Attribution test.",
        confidence: 0.9,
        target: "global",
        status: "pending",
        proposedBy: "Alice Chen"
      },
      {
        id: "suggestion-anonymous",
        title: "Tighten second sentence",
        original: "Second sentence also needs work.",
        replacement: "Second sentence reads cleanly.",
        rationale: "Attribution fallback test.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(documentXml).toMatch(/<w:del [^>]*w:author="Alice Chen"/);
    expect(documentXml).toMatch(/<w:ins [^>]*w:author="Alice Chen"/);
    expect(documentXml).toMatch(/<w:del [^>]*w:author="Nebula Writer AI"/);
    expect(documentXml).toMatch(/<w:ins [^>]*w:author="Nebula Writer AI"/);
  });

  it("keeps character formatting of untouched runs when patching a paragraph", async () => {
    const source = await exportDocx({
      title: "Formatting Source",
      html: "<p>The <em>FOXP2</em> gene strongly depend on context.</p>"
    });
    const sourceZip = await JSZip.loadAsync(source);
    const sourceXml = await sourceZip.file("word/document.xml")?.async("string");
    expect(sourceXml).toMatch(/<w:i\/>/);

    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-formatting",
        title: "Fix agreement",
        original: "strongly depend on context.",
        replacement: "strongly depends on context.",
        rationale: "Grammar fix away from the italic run.",
        confidence: 0.95,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("<w:ins ");
    expect(documentXml).toContain("strongly depends on context.");
    // The italic FOXP2 run was not part of the edit and must keep its run properties.
    expect(documentXml).toMatch(/<w:r><w:rPr>[^<]*<w:i\/>[\s\S]*?<\/w:rPr><w:t[^>]*>FOXP2<\/w:t><\/w:r>/);
  });

  it("warns about header/footer content the editor cannot show", async () => {
    const source = await exportDocx({ title: "Header Source", html: "<p>Body text.</p>" });
    const zip = await JSZip.loadAsync(source);
    zip.file(
      "word/header1.xml",
      "<w:hdr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:p><w:r><w:t>Grant page header</w:t></w:r></w:p></w:hdr>"
    );
    const withHeader = await zip.generateAsync({ type: "nodebuffer" });

    const features = await analyzeDocxFeatures(withHeader);
    expect(features.headerFooterParts).toBe(1);

    const imported = await importDocx(withHeader, "with-header.docx");
    expect(imported.messages.some((message) => message.includes("header/footer"))).toBe(true);
  });

  it("routes short ambiguous anchors to comments instead of patching the first occurrence", async () => {
    const source = await exportDocx({
      title: "Ambiguous Anchor Source",
      html: "<p>We treated the cells for one hour.</p><p>Later we treated the cells for two hours.</p>"
    });
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-ambiguous-anchor",
        title: "Fix wording",
        original: "treated the cells",
        replacement: "exposed the cells",
        rationale: "Short anchor that appears twice.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(result.report).toMatchObject({
      commentedSuggestions: 1,
      matchedSuggestions: 0
    });
    expect(result.report.commentedSuggestionReasons[0]).toContain("appears 2 times");
    expect(documentXml).not.toContain("<w:del ");
    expect(documentXml).not.toContain("<w:ins ");
    // Both occurrences stay untouched; the edit arrives as a Word comment.
    expect(documentXml).toContain("We treated the cells for one hour.");
    expect(documentXml).toContain("Later we treated the cells for two hours.");
  });

  it("repairs case-only anchor drift before appending unmatched suggestions", async () => {
    const source = await exportDocx({
      title: "R01 Heading Source",
      html: "<h2>Background and Scientific Premise</h2><p>Body text.</p>"
    });
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-heading-case",
        title: "Use R01 section heading",
        original: "Background and scientific premise",
        replacement: "Significance and Scientific Premise",
        rationale: "Uses an R01-oriented section heading.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("Background and Scientific Premise");
    expect(documentXml).toContain("Significance and Scientific Premise");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
  });

  it("repairs safe multi-paragraph anchors before appending unmatched suggestions", async () => {
    const source = await exportDocx({
      title: "R01 Section Source",
      html: "<p>Significance.</p><p>This needs to be developed</p><p>Next section remains.</p>"
    });
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-significance-section",
        title: "Clarify Significance section",
        original: "Significance. This needs to be developed",
        replacement: "Significance. This proposal addresses a critical barrier.",
        rationale: "Expands a placeholder into reviewer-facing Significance text.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(documentXml).toContain("<w:del ");
    // Deleted text is preserved per source run so each piece keeps its own formatting.
    expect(documentXml).toContain("<w:delText xml:space=\"preserve\">Significance.</w:delText>");
    expect(documentXml).toContain("<w:delText xml:space=\"preserve\">This needs to be developed</w:delText>");
    expect(documentXml).toContain("Significance. This proposal addresses a critical barrier.");
    expect(documentXml).toContain("Next section remains.");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
  });

  it("does not rewrite source paragraphs that already contain tracked revisions", async () => {
    const source = await docxWithExistingRevision();
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-existing-revision",
        title: "Tighten reviewed sentence",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const tracked = result.buffer;
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentsXml = await zip.file("word/comments.xml")?.async("string");

    expect(result.report).toMatchObject({
      commentedSuggestions: 1,
      commentedSuggestionOriginals: ["This is actually very wordy."],
      matchedSuggestions: 0,
      unmatchedSuggestions: 0
    });
    expect(result.report.commentedSuggestionReasons[0]).toContain("already contains tracked changes");
    expect(documentXml).toContain("<w:ins w:id=\"7\"");
    expect(documentXml).toContain("<w:commentReference w:id=\"0\"");
    expect(documentXml).not.toContain("AI review comments");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
    expect(documentXml).not.toContain("<w:delText xml:space=\"preserve\">This is actually very wordy.</w:delText>");
    expect(commentsXml).toContain("Tighten reviewed sentence");
    expect(commentsXml).toContain("Suggested revision: This is wordy.");
    expect(commentsXml).toContain("Export note:");
  });

  it("preserves comment-only suggestions as anchored Word comments even when body text is safe", async () => {
    const source = await exportDocx({
      title: "Comment Only Source",
      html: "<p>This ordinary body sentence needs a PI fact check before it can be revised safely.</p>"
    });
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-comment-only",
        commentOnly: true,
        title: "Confirm PI fact",
        original: "This ordinary body sentence needs a PI fact check before it can be revised safely.",
        replacement: "PI confirmation needed: verify the factual value before revising this sentence.",
        rationale: "Factual placeholders should be handed off as comments instead of body edits.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentsXml = await zip.file("word/comments.xml")?.async("string");

    expect(result.report).toMatchObject({
      commentedSuggestions: 1,
      matchedSuggestions: 0,
      unmatchedSuggestions: 0
    });
    expect(result.report.commentedSuggestionReasons[0]).toContain("comment-only");
    expect(documentXml).toContain("<w:commentReference w:id=\"0\"");
    expect(documentXml).not.toContain("<w:delText");
    expect(commentsXml).toContain("Confirm PI fact");
    expect(commentsXml).toContain("PI confirmation needed");
  });

  it("anchors multi-paragraph comment suggestions to a substantial body fragment", async () => {
    const source = await exportDocx({
      title: "R01 Tail Comment Source",
      html: [
        "<p>Timeline for Aims 1-3</p>",
        "<p>Sex as a Biological Variable: Cell lines of both sexes will be included and the sex of each line will be reported.</p>",
        "<p>Expected Milestones and Impact: Deliver the datasets and models across the proposed aims.</p>"
      ].join("")
    });
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-r01-tail",
        commentOnly: true,
        title: "Integrate R01 tail",
        original: [
          "Timeline for Aims 1-3",
          "Sex as a Biological Variable: Cell lines of both sexes will be included and the sex of each line will be reported.",
          "Expected Milestones and Impact: Deliver the datasets and models across the proposed aims."
        ].join("\n"),
        replacement: "Timeline, SABV, and milestones should be integrated into one reviewer-facing closing section.",
        rationale: "Large section rewrites should remain anchored near the source text when exported as Word comments.",
        confidence: 0.95,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentsXml = await zip.file("word/comments.xml")?.async("string");

    expect(result.report).toMatchObject({
      commentedSuggestions: 1,
      matchedSuggestions: 0,
      unmatchedSuggestions: 0
    });
    expect(result.report.commentedSuggestionReasons[0]).toContain("comment-only");
    expect(documentXml).toContain("Sex as a Biological Variable");
    expect(documentXml).toContain("<w:commentReference w:id=\"0\"");
    expect(documentXml).not.toContain("AI review comments");
    expect(commentsXml).toContain("Integrate R01 tail");
    expect(commentsXml).toContain("Timeline, SABV, and milestones");
  });

  it("accepts only Nebula-authored body tracked changes while preserving reviewer revisions and comments", async () => {
    const base = await exportDocx({
      title: "Mixed Revision Source",
      html: "<p>This is actually very wordy.</p><p>Reviewer kept this phrase.</p>"
    });
    const sourceZip = await JSZip.loadAsync(base);
    const sourceDocumentXml = await sourceZip.file("word/document.xml")?.async("string");
    if (!sourceDocumentXml) {
      throw new Error("Missing document.xml");
    }
    sourceZip.file(
      "word/document.xml",
      sourceDocumentXml.replace(
        /<w:r><w:t[^>]*>Reviewer kept this phrase\.<\/w:t><\/w:r>/,
        "<w:ins w:id=\"7\" w:author=\"Reviewer\" w:date=\"2026-01-01T00:00:00.000Z\"><w:r><w:t xml:space=\"preserve\">Reviewer kept this phrase.</w:t></w:r></w:ins>"
      )
    );

    const result = await exportTrackedChangesFromSourceWithReport(await sourceZip.generateAsync({ type: "nodebuffer" }), [
      {
        id: "suggestion-safe-body",
        title: "Tighten safe body sentence",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      },
      {
        id: "suggestion-reviewer-protected",
        title: "Comment reviewer-protected sentence",
        original: "Reviewer kept this phrase.",
        replacement: "Reviewer phrase is clearer.",
        rationale: "Would touch an existing reviewer revision, so keep it as a comment.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);

    expect(result.report).toMatchObject({
      commentedSuggestions: 1,
      matchedSuggestions: 1,
      unmatchedSuggestions: 0
    });

    const accepted = await acceptTrackedChangesByAuthor(result.buffer, "Nebula Writer AI");
    const acceptedZip = await JSZip.loadAsync(accepted);
    const documentXml = await acceptedZip.file("word/document.xml")?.async("string");
    const commentsXml = await acceptedZip.file("word/comments.xml")?.async("string");

    expect(documentXml).toContain("This is wordy.");
    expect(documentXml).not.toContain("w:author=\"Nebula Writer AI\"");
    expect(documentXml).not.toContain("<w:delText xml:space=\"preserve\">This is actually very wordy.</w:delText>");
    expect(documentXml).toContain("<w:ins w:id=\"7\" w:author=\"Reviewer\"");
    expect(documentXml).toContain("Reviewer kept this phrase.");
    expect(documentXml).toContain("<w:commentReference w:id=\"0\"");
    expect(commentsXml).toContain("Comment reviewer-protected sentence");
    expect(commentsXml).toContain("Suggested revision: Reviewer phrase is clearer.");
  });

  it("does not rewrite source paragraphs with existing move-range tracked revisions", async () => {
    const source = await docxWithExistingMoveRangeRevision();
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-existing-move-range",
        title: "Tighten moved sentence",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentsXml = await zip.file("word/comments.xml")?.async("string");
    const movedParagraph = documentXml?.match(/<w:p\b[^>]*>[\s\S]*?<w:moveFromRangeStart\b[\s\S]*?<\/w:p>/)?.[0];

    expect(movedParagraph).toContain("<w:moveFromRangeStart w:id=\"640\"");
    expect(movedParagraph).toContain("<w:moveFromRangeEnd w:id=\"640\"");
    expect(movedParagraph).toContain("This is actually very wordy.");
    expect(movedParagraph).toContain("<w:commentReference w:id=\"0\"");
    expect(movedParagraph).not.toContain("<w:del ");
    expect(movedParagraph).not.toContain("<w:ins ");
    expect(documentXml).not.toContain("AI review comments");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
    expect(documentXml).not.toContain("<w:del w:id=\"641\"");
    expect(documentXml).not.toContain("<w:ins w:id=\"642\"");
    expect(commentsXml).toContain("Tighten moved sentence");
  });

  it("does not rewrite source paragraphs inside custom XML wrappers", async () => {
    const source = await docxWithCustomXmlWrapper();
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-custom-xml",
        title: "Tighten custom XML text",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentsXml = await zip.file("word/comments.xml")?.async("string");
    const customXmlBlock = documentXml?.match(/<w:customXml\b[\s\S]*?<\/w:customXml>/)?.[0];

    expect(customXmlBlock).toContain("This is actually very wordy.");
    expect(customXmlBlock).not.toContain("<w:del ");
    expect(customXmlBlock).not.toContain("<w:ins ");
    expect(documentXml).toContain("AI review comments");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
    expect(documentXml).not.toContain("<w:delText xml:space=\"preserve\">This is actually very wordy.</w:delText>");
    expect(commentsXml).toContain("Tighten custom XML text");
  });

  it("tracks text in paragraphs with standalone comment references while preserving the reference", async () => {
    const source = await docxWithCommentReference();
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-comment-reference",
        title: "Tighten commented text",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentedParagraph = documentXml?.match(/<w:p\b[^>]*>[\s\S]*?<w:commentReference\b[\s\S]*?<\/w:p>/)?.[0];

    expect(commentedParagraph).toContain("<w:commentReference w:id=\"4\"");
    expect(commentedParagraph).toContain("<w:del ");
    expect(commentedParagraph).toContain("<w:ins ");
    expect(commentedParagraph).toContain("This is wordy.");
    expect(documentXml).not.toContain("AI review comments");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
    expect(documentXml).toContain("<w:delText xml:space=\"preserve\">This is actually very wordy.</w:delText>");
  });

  it("tracks changes inside a comment range while preserving the range markers", async () => {
    const source = await docxWithCommentRange();
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-comment-range",
        title: "Tighten range-commented text",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentedParagraph = documentXml?.match(/<w:p\b[^>]*>[\s\S]*?<w:commentRangeStart\b[\s\S]*?<\/w:p>/)?.[0];

    // The edit is now applied as a tracked change; the comment-range markers
    // sit outside the rewritten run span and are preserved verbatim.
    expect(result.report).toMatchObject({
      commentedSuggestions: 0,
      matchedSuggestions: 1,
      unmatchedSuggestions: 0
    });
    expect(commentedParagraph).toContain("<w:commentRangeStart w:id=\"4\"");
    expect(commentedParagraph).toContain("<w:commentRangeEnd w:id=\"4\"");
    expect(commentedParagraph).toContain("<w:commentReference w:id=\"4\"");
    expect(commentedParagraph).toContain("<w:del ");
    expect(commentedParagraph).toContain("<w:ins ");
    expect(commentedParagraph).toContain("This is wordy.");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
  });

  it("tracks a change elsewhere in a paragraph that contains a hyperlink, preserving the link", async () => {
    const source = await docxWithHyperlinkAndEditableText();
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-hyperlink-paragraph",
        title: "Fix agreement away from the link",
        original: "the results are robust",
        replacement: "the results were robust",
        rationale: "Edit is nowhere near the hyperlink.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(result.report).toMatchObject({
      commentedSuggestions: 0,
      matchedSuggestions: 1,
      unmatchedSuggestions: 0
    });
    // The hyperlink and its display text survive; the edit lands as a tracked change.
    expect(documentXml).toContain("<w:hyperlink");
    expect(documentXml).toContain("Vierstra et al.");
    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("the results were robust");
  });

  it("comments an edit that would split a hyperlink's own display text", async () => {
    const source = await docxWithHyperlinkAndEditableText();
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-hyperlink-overlap",
        title: "Edit overlapping the link text",
        original: "Vierstra et al.",
        replacement: "Vierstra and colleagues",
        rationale: "This anchor is the hyperlink display text itself.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    // Rewriting the link's own text is unsafe, so this falls back to a comment
    // and the hyperlink is left intact.
    expect(result.report).toMatchObject({ commentedSuggestions: 1, matchedSuggestions: 0 });
    expect(documentXml).toContain("<w:hyperlink");
    expect(documentXml).toContain("Vierstra et al.");
  });

  it("preserves paragraphs with DOCX media by falling back to Word comments", async () => {
    const source = await docxWithImageAndEditableText();
    const sourceZip = await JSZip.loadAsync(source);
    const sourceDocumentXml = await sourceZip.file("word/document.xml")?.async("string");
    const sourceDrawingCount = sourceDocumentXml?.match(/<w:drawing\b/g)?.length ?? 0;
    const result = await exportTrackedChangesFromSourceWithReport(source, [
      {
        id: "suggestion-media-paragraph",
        title: "Tighten media-adjacent rationale",
        original: "Rationale. The assay measures multiple features on the same molecule.",
        replacement: "Rationale. The assay measures coordinated features on the same DNA molecule.",
        rationale: "Improves precision without touching the preserved image.",
        confidence: 0.9,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(result.buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const commentsXml = await zip.file("word/comments.xml")?.async("string");
    const mediaParagraph = documentXml?.match(/<w:p\b[^>]*>[\s\S]*?<w:drawing\b[\s\S]*?<\/w:p>/)?.[0];
    const trackedDrawingCount = documentXml?.match(/<w:drawing\b/g)?.length ?? 0;

    expect(result.report).toMatchObject({
      commentedSuggestions: 1,
      matchedSuggestions: 0,
      unmatchedSuggestions: 0
    });
    expect(result.report.commentedSuggestionReasons[0]).toContain("preserved DOCX media");
    expect(trackedDrawingCount).toBe(sourceDrawingCount);
    expect(mediaParagraph).toContain("Rationale. The assay measures multiple features on the same molecule.");
    expect(mediaParagraph).toContain("<w:commentReference w:id=\"0\"");
    expect(mediaParagraph).not.toContain("<w:del ");
    expect(mediaParagraph).not.toContain("<w:ins ");
    expect(documentXml).not.toContain("AI review comments");
    expect(commentsXml).toContain("Tighten media-adjacent rationale");
    expect(commentsXml).toContain("Suggested revision: Rationale. The assay measures coordinated features on the same DNA molecule.");
  });

  it("allocates new tracked-change IDs above existing revisions across story parts", async () => {
    const source = await docxWithExistingEndnoteRevision();
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-after-existing-revision",
        title: "Tighten sentence",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const endnotesXml = await zip.file("word/endnotes.xml")?.async("string");

    expect(endnotesXml).toContain("<w:ins w:id=\"640\"");
    expect(documentXml).toContain("<w:del w:id=\"641\"");
    expect(documentXml).toContain("<w:ins w:id=\"642\"");
  });

  it("creates missing settings wiring when exporting tracked changes from a minimal source docx", async () => {
    const source = await docxWithoutSettingsPart();
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-missing-settings",
        title: "Tighten sentence",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "selection",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const settingsXml = await zip.file("word/settings.xml")?.async("string");
    const contentTypesXml = await zip.file("[Content_Types].xml")?.async("string");
    const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");

    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("<w:ins ");
    expect(settingsXml).toContain("<w:trackRevisions/>");
    expect(contentTypesXml).toContain("PartName=\"/word/settings.xml\"");
    expect(contentTypesXml).toContain("wordprocessingml.settings+xml");
    expect(relsXml).toContain("relationships/settings");
    expect(relsXml).toContain("Target=\"settings.xml\"");
  });

  it("does not rewrite source bibliography entries when tracking changes", async () => {
    const source = await docxWithReferenceSection();
    const tracked = await exportTrackedChangesFromSource(source, [
      {
        id: "suggestion-reference-entry",
        title: "Tighten reference text",
        original: "This is actually very wordy.",
        replacement: "This is wordy.",
        rationale: "Removes filler.",
        confidence: 0.8,
        target: "global",
        status: "pending"
      }
    ]);
    const zip = await JSZip.loadAsync(tracked);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const referenceParagraph = documentXml?.match(/<w:p\b[^>]*>[\s\S]*?Smith[\s\S]*?<\/w:p>/)?.[0];

    expect(referenceParagraph).toContain("This is actually very wordy.");
    expect(referenceParagraph).not.toContain("<w:del ");
    expect(referenceParagraph).not.toContain("<w:ins ");
    expect(documentXml).toContain("AI review comments");
    expect(documentXml).not.toContain("Unmatched AI suggestions");
  });

  it("detects formula and citation structures during DOCX analysis", async () => {
    const features = await analyzeDocxFeatures(await docxWithFormulaAndCitation());

    expect(features.formulas).toBe(1);
    expect(features.citationFields).toBe(1);
    expect(features.fields).toBeGreaterThanOrEqual(1);
    expect(features.preservationRecommended).toBe(true);
  });

  it("detects custom XML wrappers during DOCX analysis", async () => {
    const features = await analyzeDocxFeatures(await docxWithCustomXmlWrapper());

    expect(features.customXml).toBe(1);
    expect(features.preservationRecommended).toBe(true);
  });

  it("detects standalone comment references during DOCX analysis", async () => {
    const features = await analyzeDocxFeatures(await docxWithCommentReference());

    expect(features.commentRanges).toBe(1);
    expect(features.preservationRecommended).toBe(true);
  });

  it("detects move-range tracked revisions during DOCX analysis", async () => {
    const features = await analyzeDocxFeatures(await docxWithExistingMoveRangeRevision());

    expect(features.trackedChanges).toBeGreaterThanOrEqual(2);
    expect(features.preservationRecommended).toBe(true);
  });

  it("detects formulas, citations, and revisions outside the main document body", async () => {
    const features = await analyzeDocxFeatures(await docxWithSensitiveStoryParts());

    expect(features.formulas).toBe(1);
    expect(features.citationFields).toBe(1);
    expect(features.fields).toBeGreaterThanOrEqual(1);
    expect(features.trackedChanges).toBe(1);
    expect(features.commentRanges).toBe(1);
    expect(features.preservationRecommended).toBe(true);
  });

  it("detects tables and images as structures that should use source preservation", async () => {
    const features = await analyzeDocxFeatures(await docxWithTableAndImage());

    expect(features.tables).toBe(1);
    expect(features.images).toBe(1);
    expect(features.preservationRecommended).toBe(true);
  });

  it("warns at import about fidelity loss for tables and images", async () => {
    const imported = await importDocx(await docxWithTableAndImage(), "table-image.docx");

    expect(imported.messages.some((message) => message.startsWith("warning:") && message.includes("table"))).toBe(true);
    expect(imported.messages.some((message) => message.includes("image"))).toBe(true);
  });

  it("marks imported DOCX text box paragraphs without hiding the text", async () => {
    const imported = await importDocx(await docxWithTextBox(), "textbox.docx");

    expect(imported.features.textBoxes).toBe(1);
    expect(imported.html).toContain("data-docx-text-box=\"true\"");
    expect(imported.plainText).toContain("Figure legend from text box.");
  });

  it("uses a visible placeholder for DOCX image formats the browser cannot render", async () => {
    const imported = await importDocx(await docxWithUnsupportedImage(), "unsupported-image.docx");

    expect(imported.features.images).toBe(1);
    expect(imported.html).toContain("data:image/svg+xml;base64");
    expect(imported.html).toContain("DOCX image preview unavailable");
    expect(imported.plainText).not.toContain("DOCX image preview unavailable");
  });

  it("labels EMF placeholders as preserved EMF instead of exposing image/x-emf", async () => {
    const imported = await importDocx(
      await docxWithUnsupportedImage({ extension: "emf", contentType: "image/x-emf" }),
      "unsupported-emf.docx"
    );

    expect(imported.features.images).toBe(1);
    expect(imported.html).toContain("EMF preview unavailable; preserved in source DOCX");
    expect(imported.plainText).not.toContain("DOCX image preview unavailable");
    expect(imported.plainText).not.toContain("X-EMF");
    expect(imported.plainText).not.toContain("image/x-emf");
  });

  it("uses a configured EMF converter to show SVG previews while preserving source metadata", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "nebula-writer-emf-test-"));
    const converterPath = join(tempDirectory, "fake-emf2svg.js");
    const previousConverter = process.env.WRITER_EMF_CONVERTER;
    writeFileSync(converterPath, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const output = args[args.indexOf('-o') + 1];",
      "fs.writeFileSync(output, '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"48\" height=\"20\"><text>Converted EMF</text></svg>');"
    ].join("\n"));
    chmodSync(converterPath, 0o755);
    process.env.WRITER_EMF_CONVERTER = converterPath;

    try {
      const imported = await importDocx(
        await docxWithUnsupportedImage({ extension: "emf", contentType: "image/x-emf" }),
        "converted-emf.docx"
      );
      const svgMatch = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(imported.html);

      expect(imported.features.images).toBe(1);
      expect(imported.html).toContain("DOCX image preview generated: EMF preserved in source DOCX");
      expect(imported.html).toContain("original EMF preserved in source DOCX");
      expect(imported.html).not.toContain("EMF preview unavailable; preserved in source DOCX");
      expect(svgMatch).not.toBeNull();
      expect(Buffer.from(svgMatch?.[1] ?? "", "base64").toString("utf8")).toContain("Converted EMF");
      expect(imported.plainText).not.toContain("DOCX image preview generated");
    } finally {
      if (previousConverter === undefined) {
        delete process.env.WRITER_EMF_CONVERTER;
      } else {
        process.env.WRITER_EMF_CONVERTER = previousConverter;
      }
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("detects bibliography/reference sections as structures that should use source preservation", async () => {
    const features = await analyzeDocxFeatures(await docxWithReferenceSection());

    expect(features.bibliographySections).toBe(1);
    expect(features.preservationRecommended).toBe(true);
  });

  it("samples body-safe anchors only from paragraphs the patcher can rewrite", async () => {
    const source = await docxWithMixedSafeAndTrackedParagraphs();
    const anchors = await extractDocxBodySafeAnchorCandidates(source);

    expect(anchors).toContain("This clean body sentence describes a reviewable experimental validation detail that remains safe for tracked-change anchoring.");
    expect(anchors).not.toContain("This revised body sentence describes a reviewable experimental validation detail that should be excluded from tracked-change anchoring.");
  });

  it("samples enough DOCX-verified anchors for broader R01 clean-anchor passes", async () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => (
      `<p>This clean reviewable body sentence number ${index + 1} describes an expected outcome, validation criterion, or fallback strategy that remains safe for tracked-change anchoring.</p>`
    ));
    const source = await exportDocx({
      title: "Many Clean Anchors",
      html: paragraphs.join("")
    });
    const anchors = await extractDocxBodySafeAnchorCandidates(source);

    expect(anchors).toHaveLength(24);
    expect(anchors[0]).toContain("number 1");
    expect(anchors.at(-1)).toContain("number 40");
  });

  it("excludes figure panel caption fragments from DOCX-verified body-safe anchors", async () => {
    const source = await exportDocx({
      title: "Caption Anchors",
      html: [
        "<p>Figure 2. Schematic of the assay and data. (A) Labeling step marks protein positions on DNA (B) Example traces from three replicate runs.</p>",
        "<p>This clean body sentence describes an expected outcome, validation criterion, and alternative strategy that remains safe for tracked-change anchoring.</p>"
      ].join("")
    });

    const anchors = await extractDocxBodySafeAnchorCandidates(source);

    expect(anchors).toContain("This clean body sentence describes an expected outcome, validation criterion, and alternative strategy that remains safe for tracked-change anchoring.");
    expect(anchors).not.toContain("(A) Labeling step marks protein positions on DNA (B) Example traces from three replicate runs.");
  });

  it("labels DOCX-verified anchors with their nearest section heading", async () => {
    const source = await exportDocx({
      title: "Sectioned Anchors",
      html: [
        "<h1>Approach</h1>",
        "<p>This clean approach sentence describes a reviewable validation criterion and fallback strategy that remains safe for tracked-change anchoring.</p>",
        "<h2>Aim 2 Perturbation</h2>",
        "<p>This clean Aim 2 sentence describes an expected outcome, interpretation rule, and alternative assay that remain safe for tracked-change anchoring.</p>",
        "<p>Aim 3: Systematic assessment of technical factors on the assay.</p>",
        "<p>This clean Aim 3 sentence describes a technical validation outcome, assay calibration criterion, and fallback strategy that remain safe for tracked-change anchoring.</p>",
        "<p>Aim 3C will annotate the likely functions of variants in the chosen differentiation model.</p>",
        "<p>This follow-on Aim 3 sentence describes a variant interpretation outcome, validation checkpoint, and alternative analysis that remain safe for tracked-change anchoring.</p>"
      ].join("")
    });

    const details = await extractDocxBodySafeAnchorDetails(source);

    expect(details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        section: "Approach",
        text: "This clean approach sentence describes a reviewable validation criterion and fallback strategy that remains safe for tracked-change anchoring."
      }),
      expect.objectContaining({
        section: "Aim 2 Perturbation",
        text: "This clean Aim 2 sentence describes an expected outcome, interpretation rule, and alternative assay that remain safe for tracked-change anchoring."
      }),
      expect.objectContaining({
        section: "Aim 3: Systematic assessment of technical factors on the assay",
        text: "This clean Aim 3 sentence describes a technical validation outcome, assay calibration criterion, and fallback strategy that remain safe for tracked-change anchoring."
      }),
      expect.objectContaining({
        section: "Aim 3: Systematic assessment of technical factors on the assay",
        text: "This follow-on Aim 3 sentence describes a variant interpretation outcome, validation checkpoint, and alternative analysis that remain safe for tracked-change anchoring."
      })
    ]));
  });
});

async function docxWithMixedSafeAndTrackedParagraphs(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Mixed Anchor Source",
    html: [
      "<p>This clean body sentence describes a reviewable experimental validation detail that remains safe for tracked-change anchoring.</p>",
      "<p>This revised body sentence describes a reviewable experimental validation detail that should be excluded from tracked-change anchoring.</p>"
    ].join("")
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml.replace(
    /<w:r><w:t[^>]*>This revised body sentence describes a reviewable experimental validation detail that should be excluded from tracked-change anchoring\.<\/w:t><\/w:r>/,
    "<w:ins w:id=\"7\" w:author=\"Reviewer\" w:date=\"2026-01-01T00:00:00.000Z\"><w:r><w:t xml:space=\"preserve\">This revised body sentence describes a reviewable experimental validation detail that should be excluded from tracked-change anchoring.</w:t></w:r></w:ins>"
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithFormulaAndCitation(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Preservation Source",
    html: "<p>Formula stays.</p><p>Paperpile citation stays.</p><p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml
    .replace(
      /(<w:t[^>]*>Formula stays\.<\/w:t><\/w:r>)/,
      "$1<m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath>"
    )
    .replace(
      /<w:p>(<w:r><w:t[^>]*>Paperpile citation stays\.<\/w:t><\/w:r>)<\/w:p>/,
      "<w:p><w:fldSimple w:instr=\" ADDIN CSL_CITATION \">$1</w:fldSimple></w:p>"
    );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithInlineCitationField(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Inline Citation Source",
    html: "<p>Thus target selection strongly depend on TF21.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml.replace(
    /<w:r><w:t[^>]*>Thus target selection strongly depend on TF21\.<\/w:t><\/w:r>/,
    [
      "<w:r><w:t>Thus target selection strongly depend on TF</w:t></w:r>",
      "<w:fldSimple w:instr=\" ADDIN CSL_CITATION \"><w:r><w:t>21</w:t></w:r></w:fldSimple>",
      "<w:r><w:t>.</w:t></w:r>"
    ].join("")
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithExistingRevision(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Existing Revision Source",
    html: "<p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml.replace(
    /<w:r><w:t[^>]*>This is actually very wordy\.<\/w:t><\/w:r>/,
    "<w:ins w:id=\"7\" w:author=\"Reviewer\" w:date=\"2026-01-01T00:00:00.000Z\"><w:r><w:t xml:space=\"preserve\">This is actually very wordy.</w:t></w:r></w:ins>"
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithNestedExistingInsertion(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Nested Existing Revision Source",
    html: "<p>Paragraph before revision.</p><p>Paragraph after revision.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const revisionXml = [
    "<w:p>",
    "<w:ins w:id=\"7\" w:author=\"Reviewer\" w:date=\"2026-01-01T00:00:00.000Z\">",
    "<w:r><w:t>Outer accepted text </w:t></w:r>",
    "<w:ins w:id=\"8\" w:author=\"Reviewer\" w:date=\"2026-01-01T00:00:00.000Z\">",
    "<w:r><w:t>Nested accepted text </w:t></w:r>",
    "</w:ins>",
    "<w:r><w:t>after nested insertion.</w:t></w:r>",
    "</w:ins>",
    "</w:p>"
  ].join("");
  zip.file("word/document.xml", documentXml.replace(/<w:sectPr\b/, `${revisionXml}<w:sectPr`));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithExistingMoveRangeRevision(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Existing Move Range Source",
    html: "<p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml.replace(
    /<w:r><w:t[^>]*>This is actually very wordy\.<\/w:t><\/w:r>/,
    [
      "<w:moveFromRangeStart w:id=\"640\" w:author=\"Reviewer\" w:date=\"2026-01-01T00:00:00.000Z\"/>",
      "<w:r><w:t xml:space=\"preserve\">This is actually very wordy.</w:t></w:r>",
      "<w:moveFromRangeEnd w:id=\"640\"/>"
    ].join("")
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithCustomXmlWrapper(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Custom XML Source",
    html: "<p>Intro paragraph.</p><p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml.replace(
    /<w:p>(<w:r><w:t[^>]*>This is actually very wordy\.<\/w:t><\/w:r>)<\/w:p>/,
    "<w:customXml w:element=\"CitationData\" w:uri=\"urn:nebula-test\"><w:p>$1</w:p></w:customXml>"
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithCommentReference(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Comment Reference Source",
    html: "<p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml.replace(
    /(<w:r><w:t[^>]*>This is actually very wordy\.<\/w:t><\/w:r>)/,
    "$1<w:r><w:commentReference w:id=\"4\"/></w:r>"
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithCommentRange(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Comment Range Source",
    html: "<p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const patched = documentXml.replace(
    /(<w:r><w:t[^>]*>This is actually very wordy\.<\/w:t><\/w:r>)/,
    [
      "<w:commentRangeStart w:id=\"4\"/>",
      "$1",
      "<w:commentRangeEnd w:id=\"4\"/>",
      "<w:r><w:commentReference w:id=\"4\"/></w:r>"
    ].join("")
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithHyperlinkAndEditableText(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Hyperlink Source",
    html: "<p>As shown, the results are robust.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  // Insert a hyperlink run (a citation to "Vierstra et al.") at the end of the
  // paragraph, after the editable sentence, mirroring a linked reference.
  const patched = documentXml.replace(
    /(<w:r><w:t[^>]*>As shown, the results are robust\.<\/w:t><\/w:r>)/,
    "$1<w:hyperlink r:id=\"rId99\"><w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/></w:rPr><w:t xml:space=\"preserve\"> Vierstra et al.</w:t></w:r></w:hyperlink>"
  );
  zip.file("word/document.xml", patched);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithExistingEndnoteRevision(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Existing Story Revision Source",
    html: "<p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  zip.file(
    "word/endnotes.xml",
    "<w:endnotes><w:endnote w:id=\"2\"><w:p><w:ins w:id=\"640\" w:author=\"Reviewer\" w:date=\"2026-01-01T00:00:00.000Z\"><w:r><w:t>Existing endnote revision</w:t></w:r></w:ins></w:p></w:endnote></w:endnotes>"
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithoutSettingsPart(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Missing Settings Source",
    html: "<p>This is actually very wordy.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  zip.remove("word/settings.xml");

  const contentTypesXml = await zip.file("[Content_Types].xml")?.async("string");
  if (contentTypesXml) {
    zip.file("[Content_Types].xml", contentTypesXml.replace(/<Override\b[^>]*PartName="\/word\/settings\.xml"[^>]*\/>/i, ""));
  }

  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
  if (relsXml) {
    zip.file("word/_rels/document.xml.rels", relsXml.replace(/<Relationship\b[^>]*Type="[^"]*\/settings"[^>]*\/>/i, ""));
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithReferenceSection(): Promise<Buffer> {
  return exportDocx({
    title: "Reference Section Source",
    html: "<h1>References</h1><p>Smith, J. This is actually very wordy. Journal of Careful Tests.</p>"
  });
}

async function docxWithSensitiveStoryParts(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Story Part Source",
    html: "<p>Main body text.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  zip.file(
    "word/footnotes.xml",
    "<w:footnotes><w:footnote w:id=\"2\"><w:p><w:fldSimple w:instr=\" ADDIN PAPERPILE_CITATION \"><w:r><w:t>Reference</w:t></w:r></w:fldSimple></w:p></w:footnote></w:footnotes>"
  );
  zip.file(
    "word/header1.xml",
    "<w:hdr><w:p><m:oMathPara><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></m:oMathPara></w:p></w:hdr>"
  );
  zip.file(
    "word/comments.xml",
    "<w:comments><w:comment w:id=\"1\"><w:p><w:r><w:t>Review note</w:t></w:r></w:p></w:comment></w:comments>"
  );
  zip.file(
    "word/endnotes.xml",
    "<w:endnotes><w:endnote w:id=\"2\"><w:p><w:ins w:id=\"5\"><w:r><w:t>Existing endnote revision</w:t></w:r></w:ins></w:p></w:endnote></w:endnotes>"
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithTableAndImage(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Table Image Source",
    html: "<p>Main body text.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const tableXml = "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
  const imageXml = "<w:p><w:r><w:drawing><wp:inline><a:graphic/></wp:inline></w:drawing></w:r></w:p>";
  zip.file("word/document.xml", documentXml.replace(/<w:sectPr\b/, `${tableXml}${imageXml}<w:sectPr`));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithImageAndEditableText(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Image Text Source",
    html: "<p>Paragraph before media text.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const mediaTextXml = [
    "<w:p>",
    "<w:r><w:drawing><wp:inline><a:graphic/></wp:inline></w:drawing></w:r>",
    "<w:r><w:t>Rationale. The assay measures multiple features on the same molecule.</w:t></w:r>",
    "</w:p>"
  ].join("");
  zip.file("word/document.xml", documentXml.replace(/<w:sectPr\b/, `${mediaTextXml}<w:sectPr`));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithTextBox(): Promise<Buffer> {
  const base = await exportDocx({
    title: "Text Box Source",
    html: "<p>Paragraph before text box.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("Missing document.xml");
  }
  const withVmlNamespace = documentXml.includes("xmlns:v=")
    ? documentXml
    : documentXml.replace("<w:document ", "<w:document xmlns:v=\"urn:schemas-microsoft-com:vml\" ");
  const textBoxXml = [
    "<w:p>",
    "<w:r><w:t>Paragraph containing a text box.</w:t></w:r>",
    "<w:r><w:pict><v:shape><v:textbox><w:txbxContent>",
    "<w:p><w:r><w:t>Figure legend from text box.</w:t></w:r></w:p>",
    "</w:txbxContent></v:textbox></v:shape></w:pict></w:r>",
    "</w:p>"
  ].join("");
  zip.file("word/document.xml", withVmlNamespace.replace(/<w:sectPr\b/, `${textBoxXml}<w:sectPr`));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function docxWithUnsupportedImage(
  options: { extension: string; contentType: string } = { extension: "tiff", contentType: "image/tiff" }
): Promise<Buffer> {
  const base = await exportDocx({
    title: "Unsupported Image Source",
    html: "<p>Paragraph before image.</p>"
  });
  const zip = await JSZip.loadAsync(base);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
  const contentTypesXml = await zip.file("[Content_Types].xml")?.async("string");
  if (!documentXml || !relsXml || !contentTypesXml) {
    throw new Error("Missing DOCX parts");
  }

  const relId = "rIdNebulaImage";
  const mediaTarget = `media/image1.${options.extension}`;
  const imageXml = [
    "<w:p><w:r><w:drawing><wp:inline>",
    "<a:graphic><a:graphicData><pic:pic><pic:blipFill>",
    `<a:blip r:embed="${relId}"/>`,
    "</pic:blipFill></pic:pic></a:graphicData></a:graphic>",
    "</wp:inline></w:drawing></w:r></w:p>"
  ].join("");
  const withNamespaces = ensureDocumentNamespaces(documentXml, {
    a: "http://schemas.openxmlformats.org/drawingml/2006/main",
    pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
    r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  });
  const imageRel = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${mediaTarget}"/>`;
  const imageContentType = `<Default Extension="${options.extension}" ContentType="${options.contentType}"/>`;

  zip.file("word/document.xml", withNamespaces.replace(/<w:sectPr\b/, `${imageXml}<w:sectPr`));
  zip.file("word/_rels/document.xml.rels", relsXml.replace("</Relationships>", `${imageRel}</Relationships>`));
  zip.file(
    "[Content_Types].xml",
    new RegExp(`Extension="${options.extension}"`, "i").test(contentTypesXml)
      ? contentTypesXml
      : contentTypesXml.replace("</Types>", `${imageContentType}</Types>`)
  );
  zip.file(`word/${mediaTarget}`, Buffer.from(`fake-${options.extension}-image`));
  return zip.generateAsync({ type: "nodebuffer" });
}

function ensureDocumentNamespaces(documentXml: string, namespaces: Record<string, string>): string {
  return Object.entries(namespaces).reduce((xml, [prefix, uri]) => (
    xml.includes(`xmlns:${prefix}=`)
      ? xml
      : xml.replace("<w:document ", `<w:document xmlns:${prefix}="${uri}" `)
  ), documentXml);
}
