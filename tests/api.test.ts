// @vitest-environment node

import type express from "express";
import JSZip from "jszip";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createWriterApp } from "../server/app";

const app = createWriterApp();

describe("writer sidecar API", () => {
  it("reports health and local provider state", async () => {
    const response = await requestBuffer("GET", "/api/health");
    const body = JSON.parse(response.body.toString("utf8")) as {
      ok: boolean;
      cliTimeout: { env: string; value: string | null; timeoutMs: number; valid: boolean; clamped: boolean; detail: string };
      providers: string[];
      providerStatus: Array<{ name: string; available: boolean; enabled: boolean; overrideEnv: string; overrideValue: string | null; path?: string | null; version?: string | null }>;
    };

    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.cliTimeout).toMatchObject({
      env: "WRITER_CLI_TIMEOUT_MS",
      value: null,
      timeoutMs: 0,
      valid: true,
      clamped: false
    });
    expect(body.providers).toEqual(["codex", "claude"]);
    expect(body.providerStatus.find((provider) => provider.name === "demo")).toBeUndefined();
    for (const provider of body.providerStatus) {
      expect(provider).toHaveProperty("overrideEnv");
      expect(provider).toHaveProperty("overrideValue");
      expect(provider).toHaveProperty("path");
      expect(provider).toHaveProperty("version");
    }
  });

  it("surfaces invalid WRITER_CLI_TIMEOUT_MS values in health diagnostics", async () => {
    const previousTimeout = process.env.WRITER_CLI_TIMEOUT_MS;
    process.env.WRITER_CLI_TIMEOUT_MS = "slow";

    try {
      const response = await requestBuffer("GET", "/api/health");
      const body = JSON.parse(response.body.toString("utf8")) as {
        cliTimeout: { value: string | null; timeoutMs: number; valid: boolean; detail: string };
      };

      expect(response.statusCode).toBe(200);
      expect(body.cliTimeout.value).toBe("slow");
      expect(body.cliTimeout.timeoutMs).toBe(0);
      expect(body.cliTimeout.valid).toBe(false);
      expect(body.cliTimeout.detail).toContain("WRITER_CLI_TIMEOUT_MS=slow");
      expect(body.cliTimeout.detail).toContain("using no timeout");
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.WRITER_CLI_TIMEOUT_MS;
      } else {
        process.env.WRITER_CLI_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("surfaces invalid provider override paths in health diagnostics", async () => {
    const previousCodex = process.env.WRITER_CODEX_PATH;
    process.env.WRITER_CODEX_PATH = "/definitely/missing/codex";

    try {
      const response = await requestBuffer("GET", "/api/health");
      const body = JSON.parse(response.body.toString("utf8")) as {
        providerStatus: Array<{ name: string; available: boolean; detail: string; overrideEnv: string; overrideValue: string | null }>;
      };
      const codex = body.providerStatus.find((provider) => provider.name === "codex");

      expect(response.statusCode).toBe(200);
      expect(codex).toBeDefined();
      expect(codex?.available).toBe(false);
      expect(codex?.overrideEnv).toBe("WRITER_CODEX_PATH");
      expect(codex?.overrideValue).toBe("/definitely/missing/codex");
      expect(codex?.detail).toContain("WRITER_CODEX_PATH");
      expect(codex?.detail).toContain("not executable");
    } finally {
      if (previousCodex === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousCodex;
      }
    }
  });

  it("accepts truthy WRITER_ALLOW_CLI values in health status", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    process.env.WRITER_ALLOW_CLI = "yes";

    try {
      const response = await requestBuffer("GET", "/api/health");
      const body = JSON.parse(response.body.toString("utf8")) as {
        cliEnabled: boolean;
        providerStatus: Array<{ name: string; detail: string }>;
      };
      const codex = body.providerStatus.find((provider) => provider.name === "codex");

      expect(response.statusCode).toBe(200);
      expect(body.cliEnabled).toBe(true);
      expect(codex?.detail).not.toContain("disabled");
    } finally {
      delete process.env.WRITER_AI_ENGINE;
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
    }
  });

  it("surfaces invalid WRITER_ALLOW_CLI values in health diagnostics", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    process.env.WRITER_ALLOW_CLI = "enabled";

    try {
      const response = await requestBuffer("GET", "/api/health");
      const body = JSON.parse(response.body.toString("utf8")) as {
        cliEnabled: boolean;
        providerStatus: Array<{ name: string; detail: string }>;
      };
      const codex = body.providerStatus.find((provider) => provider.name === "codex");

      expect(response.statusCode).toBe(200);
      expect(body.cliEnabled).toBe(false);
      expect(codex?.detail).toContain("WRITER_ALLOW_CLI=enabled");
      expect(codex?.detail).toContain("Use 1, true, yes, or on");
      expect(codex?.detail).toContain("0, false, no, or off");
    } finally {
      delete process.env.WRITER_AI_ENGINE;
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
    }
  });

  it("surfaces explicit WRITER_ALLOW_CLI locked mode in health status", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    process.env.WRITER_ALLOW_CLI = "0";

    try {
      const response = await requestBuffer("GET", "/api/health");
      const body = JSON.parse(response.body.toString("utf8")) as {
        cliEnabled: boolean;
        providerStatus: Array<{ name: string; detail: string }>;
      };
      const codex = body.providerStatus.find((provider) => provider.name === "codex");

      expect(response.statusCode).toBe(200);
      expect(body.cliEnabled).toBe(false);
      expect(codex?.detail).toContain("WRITER_ALLOW_CLI=0");
      expect(codex?.detail).toContain("disabled");
    } finally {
      delete process.env.WRITER_AI_ENGINE;
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
    }
  });

  it("detects CLI version from fallback args and stderr output", async () => {
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-health-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  printf '%s\\n' \"unknown option: --version\" 1>&2",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"version\" ]; then",
        "  printf '%s\\n' \"codex-cli 1.2.3\" 1>&2",
        "  exit 0",
        "fi",
        "exit 1"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await requestBuffer("GET", "/api/health");
      const body = JSON.parse(response.body.toString("utf8")) as {
        providerStatus: Array<{ name: string; version: string | null; overrideEnv: string; overrideValue: string | null; path: string | null }>;
      };
      const codex = body.providerStatus.find((provider) => provider.name === "codex");

      expect(response.statusCode).toBe(200);
      expect(codex?.overrideEnv).toBe("WRITER_CODEX_PATH");
      expect(codex?.overrideValue).toBe(relative(process.cwd(), fakeCodexPath));
      expect(codex?.path).toBe(fakeCodexPath);
      expect(codex?.version).toBe("codex-cli 1.2.3");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("roundtrips a DOCX through HTTP import and export", async () => {
    const exportResponse = await exportHttpDocx({
      title: "HTTP Roundtrip",
      html: "<h1>HTTP Roundtrip</h1><p>The sidecar exported this file.</p>"
    });

    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers["content-type"]).toContain("wordprocessingml.document");

    const importResponse = await importHttpDocx(exportResponse.body, "http-roundtrip.docx");
    const imported = JSON.parse(importResponse.body.toString("utf8")) as { plainText: string };

    expect(importResponse.statusCode).toBe(200);
    expect(imported.plainText).toContain("HTTP Roundtrip");
    expect(imported.plainText).toContain("The sidecar exported this file.");
  });

  it("attributes live terminal staging to the CLI that staged it", async () => {
    const exportResponse = await exportHttpDocx({
      title: "Attribution",
      html: "<h1>Attribution</h1><p>The quick brown fox jumps over the lazy dog.</p>"
    });
    await importHttpDocx(exportResponse.body, "attribution.docx");

    const stageResponse = await requestBuffer(
      "POST",
      "/api/agent-run/live/stage",
      { "Content-Type": "application/json" },
      JSON.stringify({
        agent: "claude",
        suggestions: [{
          title: "Swap adjective",
          original: "quick brown fox",
          replacement: "swift brown fox",
          rationale: "test",
          confidence: 0.9
        }]
      })
    );
    expect(stageResponse.statusCode).toBe(200);

    const listResponse = await requestBuffer("GET", "/api/session/suggestions");
    const listed = JSON.parse(listResponse.body.toString("utf8")) as { suggestions: Array<{ title: string; proposedBy?: string | null }> };
    const staged = listed.suggestions.find((suggestion) => suggestion.title === "Swap adjective");
    expect(staged?.proposedBy).toBe("Claude Code");
  });

  it("returns demo suggestions through HTTP", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "demo",
        instruction: "Make this shorter",
        mode: "selection",
        documentText: "This is actually very wordy.",
        selection: {
          from: 1,
          to: 31,
          text: "This is actually very wordy."
        }
      })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { suggestions: Array<{ replacement: string }> };

    expect(response.statusCode).toBe(200);
    expect(body.suggestions[0].replacement).toBe("This is wordy.");
  });

  it("accepts text-only AI requests for image-heavy imported DOCX files", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "demo",
        instruction: "Make this shorter",
        mode: "global",
        documentText: [
          "Specific Aims",
          "",
          "This is actually very wordy language for a grant application opening paragraph."
        ].join("\n")
      })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { suggestions: Array<{ original: string; replacement: string }> };

    expect(response.statusCode).toBe(200);
    expect(body.suggestions[0].original).toContain("This is actually very wordy");
    expect(body.suggestions[0].replacement).toContain("This is wordy");
  });

  it("can preview generic AI suggestions without staging them into the active session", async () => {
    const exportResponse = await exportHttpDocx({
      title: "Preview Staging",
      html: "<h1>Preview Staging</h1><p>This is actually very wordy language for a grant application opening paragraph that should be tightened.</p>"
    });
    const importResponse = await importHttpDocx(exportResponse.body, "preview-staging.docx");
    const imported = JSON.parse(importResponse.body.toString("utf8")) as { plainText: string };
    const beforeResponse = await requestBuffer("GET", "/api/session");
    const before = JSON.parse(beforeResponse.body.toString("utf8")) as { session: { pendingSuggestions: number } };

    const previewResponse = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "demo",
        instruction: "Tighten this.",
        mode: "global",
        documentText: imported.plainText,
        stageSuggestions: false
      })
    );
    const preview = JSON.parse(previewResponse.body.toString("utf8")) as { stagedInSession: boolean; suggestions: Array<{ title: string }> };
    const afterPreviewResponse = await requestBuffer("GET", "/api/session");
    const afterPreview = JSON.parse(afterPreviewResponse.body.toString("utf8")) as { session: { pendingSuggestions: number } };

    expect(previewResponse.statusCode).toBe(200);
    expect(preview.stagedInSession).toBe(false);
    expect(preview.suggestions[0].title).toBe("Tighten opening passage");
    expect(before.session.pendingSuggestions).toBe(0);
    expect(afterPreview.session.pendingSuggestions).toBe(0);

    const stagedResponse = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "demo",
        instruction: "Tighten this.",
        mode: "global",
        documentText: imported.plainText
      })
    );
    const staged = JSON.parse(stagedResponse.body.toString("utf8")) as { stagedInSession: boolean };
    const afterStagedResponse = await requestBuffer("GET", "/api/session");
    const afterStaged = JSON.parse(afterStagedResponse.body.toString("utf8")) as { session: { pendingSuggestions: number } };

    expect(stagedResponse.statusCode).toBe(200);
    expect(staged.stagedInSession).toBe(true);
    expect(afterStaged.session.pendingSuggestions).toBe(1);
  });

  it("rejects unsupported AI providers through HTTP", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "openai",
        instruction: "Make this shorter",
        mode: "selection",
        documentHtml: "<p>This is actually very wordy.</p>",
        documentText: "This is actually very wordy.",
        selection: {
          from: 1,
          to: 31,
          text: "This is actually very wordy."
        }
      })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(body.error).toContain("Codex CLI");
    expect(body.error).toContain("Claude Code");
  });

  it("rejects malformed AI suggestion bodies before provider execution", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "codex",
        mode: "global",
        documentHtml: "<p>This is actually very wordy.</p>",
        documentText: "This is actually very wordy."
      })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(body.error).toContain("instruction string");
  });

  it("rejects invalid AI suggestion limits through HTTP", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "demo",
        instruction: "Make this shorter",
        mode: "global",
        documentText: "This is actually very wordy.",
        maxSuggestions: 0
      })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(body.error).toContain("maxSuggestions");
    expect(body.error).toContain("positive whole number");
  });

  it("rejects invalid generic AI staging controls through HTTP", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "demo",
        instruction: "Make this shorter",
        mode: "global",
        documentText: "This is actually very wordy.",
        stageSuggestions: "no"
      })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(body.error).toContain("stageSuggestions");
    expect(body.error).toContain("boolean");
  });

  it("rejects selection AI requests without a concrete selected range", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/suggest",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({
        provider: "demo",
        instruction: "Make this shorter",
        mode: "selection",
        documentHtml: "<p>This is actually very wordy.</p>",
        documentText: "This is actually very wordy.",
        selection: {
          text: "This is actually very wordy."
        }
      })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(body.error).toContain("numeric from/to offsets");
  });

  it("runs a safe Codex provider smoke test through HTTP", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-codex-smoke-"));
    const fakeCodexPath = join(tempDir, "fake-codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s\\n' '{\"message\":\"Smoke ok\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy [@smith2020] while $E=mc^2$ stays.\",\"replacement\":\"This is wordy [@smith2020] while $E=mc^2$ stays.\",\"rationale\":\"Removes filler while preserving protected tokens.\",\"confidence\":0.92}]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_AI_ENGINE = "oneshot"; // legacy pipeline test; rewritten agentically when one-shot is deleted
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);

    try {
      const response = await requestBuffer(
        "POST",
        "/api/ai/smoke",
        {
          "Content-Type": "application/json"
        },
        JSON.stringify({ provider: "codex" })
      );
      const body = JSON.parse(response.body.toString("utf8")) as {
        provider: string;
        ok: boolean;
        suggestionCount: number;
        message: string;
      };

      expect(response.statusCode).toBe(200);
      expect(body.provider).toBe("codex");
      expect(body.ok).toBe(true);
      expect(body.suggestionCount).toBe(1);
      expect(body.message).toContain("Codex CLI returned 1 exact-source suggestion");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.WRITER_AI_ENGINE;
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
    }
  });

  it("rejects Demo AI provider smoke tests", async () => {
    const response = await requestBuffer(
      "POST",
      "/api/ai/smoke",
      {
        "Content-Type": "application/json"
      },
      JSON.stringify({ provider: "demo" })
    );
    const body = JSON.parse(response.body.toString("utf8")) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(body.error).toContain("Codex CLI or Claude Code");
  });

  it("rejects malformed provider smoke test requests before provider execution", async () => {
    const response = await requestBuffer("POST", "/api/ai/smoke");
    const body = JSON.parse(response.body.toString("utf8")) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(body.error).toContain("JSON request body");
    expect(body.error).toContain("Codex CLI or Claude Code");
  });

  it("exports tracked changes through HTTP", async () => {
    const response = await exportHttpDocx({
      title: "HTTP Tracked",
      html: "<p>This is actually very wordy.</p>",
      trackedChanges: true,
      suggestions: [trackedSuggestion("suggestion-http")]
    });
    const zip = await JSZip.loadAsync(response.body);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="HTTP-Tracked_\d{8}T\d{6}Z_review\.docx"$/);
    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("<w:ins ");
  });

  it("uses an imported source DOCX as the base for tracked review export", async () => {
    const sourceResponse = await exportHttpDocx({
      title: "Imported Source",
      html: "<p>This is actually very wordy.</p>"
    });
    const importResponse = await importHttpDocx(sourceResponse.body, "imported-source.docx");
    const imported = JSON.parse(importResponse.body.toString("utf8")) as { id: string };
    const reviewResponse = await exportHttpDocx({
      title: "Imported Source",
      sourceDocumentId: imported.id,
      trackedChanges: true,
      suggestions: [trackedSuggestion("suggestion-source-http")]
    });
    const zip = await JSZip.loadAsync(reviewResponse.body);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.headers["content-disposition"]).toMatch(/^attachment; filename="Imported-Source_\d{8}T\d{6}Z_review\.docx"$/);
    expect(reviewResponse.headers["x-nebula-writer-suggestions-total"]).toBe("1");
    expect(reviewResponse.headers["x-nebula-writer-suggestions-matched"]).toBe("1");
    expect(JSON.parse(decodeURIComponent(reviewResponse.headers["x-nebula-writer-suggestions-matched-ids"]))).toEqual(["suggestion-source-http"]);
    expect(JSON.parse(decodeURIComponent(reviewResponse.headers["x-nebula-writer-suggestions-matched-titles"]))).toEqual(["Tighten sentence"]);
    expect(reviewResponse.headers["x-nebula-writer-suggestions-unmatched"]).toBe("0");
    expect(JSON.parse(decodeURIComponent(reviewResponse.headers["x-nebula-writer-suggestions-unmatched-ids"]))).toEqual([]);
    expect(JSON.parse(decodeURIComponent(reviewResponse.headers["x-nebula-writer-suggestions-unmatched-titles"]))).toEqual([]);
    expect(reviewResponse.headers["x-nebula-writer-suggestions-commented"]).toBe("0");
    expect(JSON.parse(decodeURIComponent(reviewResponse.headers["x-nebula-writer-suggestions-commented-ids"]))).toEqual([]);
    expect(JSON.parse(decodeURIComponent(reviewResponse.headers["x-nebula-writer-suggestions-commented-reasons"]))).toEqual([]);
    expect(JSON.parse(decodeURIComponent(reviewResponse.headers["x-nebula-writer-suggestions-commented-titles"]))).toEqual([]);
    expect(documentXml).toContain("<w:del ");
    expect(documentXml).toContain("<w:ins ");
  });

  it("records comment-only suggestions that have no replacement text", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), "tmp", "writer-comment-only-"));
    try {
      const sourcePath = join(tempDir, "comment-only-source.docx");
      const sourceResponse = await exportHttpDocx({
        title: "Comment Only Source",
        html: "<p>This is actually very wordy.</p>"
      });
      writeFileSync(sourcePath, sourceResponse.body);
      await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );

      const recordResponse = await requestBuffer(
        "POST",
        "/api/session/record-suggestions",
        { "Content-Type": "application/json" },
        JSON.stringify({
          suggestions: [{
            id: "comment-only-flag",
            title: "Flag ambiguous wording",
            original: "This is actually very wordy.",
            replacement: "",
            rationale: "Consider clarifying what 'actually' refers to.",
            confidence: 0.9,
            commentOnly: true,
            proposedBy: "Reviewer"
          }]
        })
      );
      const recorded = JSON.parse(recordResponse.body.toString("utf8")) as { recorded: number };
      expect(recordResponse.statusCode).toBe(200);
      expect(recorded.recorded).toBe(1);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({ outputPath: join(tempDir, "comment-only-review.docx") })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        outputPath: string;
        report: { commentedSuggestions: number } | null;
      };
      expect(exported.report).toMatchObject({ commentedSuggestions: 1 });
      const zip = await JSZip.loadAsync(readFileSync(exported.outputPath));
      const commentsXml = await zip.file("word/comments.xml")?.async("string");
      expect(commentsXml).toMatch(/w:author="Reviewer"/);
      expect(commentsXml).toContain("Consider clarifying");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exports agent-accepted suggestions as tracked changes when pendingOnly is off", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), "tmp", "writer-accepted-export-"));
    try {
      const sourcePath = join(tempDir, "accepted-source.docx");
      const sourceResponse = await exportHttpDocx({
        title: "Accepted Export Source",
        html: "<p>This is actually very wordy.</p>"
      });
      writeFileSync(sourcePath, sourceResponse.body);
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const acceptedSuggestion = {
        ...trackedSuggestion("suggestion-agent-accepted"),
        status: "accepted",
        proposedBy: "Review Agent",
        decidedBy: "Review Agent"
      };
      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: join(tempDir, "accepted-review.docx"),
          pendingOnly: false,
          suggestions: [acceptedSuggestion]
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        outputPath: string;
        report: { matchedSuggestions: number; totalSuggestions: number } | null;
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.report).toMatchObject({ matchedSuggestions: 1, totalSuggestions: 1 });
      const zip = await JSZip.loadAsync(readFileSync(exported.outputPath));
      const documentXml = await zip.file("word/document.xml")?.async("string");
      expect(documentXml).toMatch(/<w:del [^>]*w:author="Review Agent"/);
      expect(documentXml).toMatch(/<w:ins [^>]*w:author="Review Agent"/);
      expect(documentXml).toContain("This is wordy.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a sidecar Writer session for agent-driven DOCX review", async () => {
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CODEX_PATH;
    const previousDownloadsDir = process.env.WRITER_DOWNLOADS_DIR;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-"));
    const sourcePath = join(tempDir, "source.docx");
    const reviewPath = join(tempDir, "review.docx");
    const downloadsDir = join(tempDir, "Downloads");
    const downloadCopyPath = join(downloadsDir, "review.docx");
    const selectedReviewPath = join(tempDir, "selected-review.docx");
    const reportPath = join(tempDir, "review-report.json");
    const suggestionsPath = join(tempDir, "review-suggestions.json");
    const fakeCodexPath = join(tempDir, "fake-codex");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>This is actually very wordy.</p>"
    });

    writeFileSync(sourcePath, sourceResponse.body);
    writeFileSync(
      suggestionsPath,
      JSON.stringify({
        message: "Saved routine suggestions",
        suggestions: [
          {
            id: "saved-run-suggestion",
            title: "Saved run suggestion",
            original: "This is actually very wordy.",
            replacement: "This is wordy.",
            rationale: "Restores the saved routine suggestion.",
            confidence: 0.93
          }
        ]
      }),
      "utf8"
    );
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s\\n' '{\"message\":\"Session suggestion\",\"suggestions\":[{\"title\":\"Tighten sentence\",\"original\":\"This is actually very wordy.\",\"replacement\":\"This is wordy.\",\"rationale\":\"Removes filler.\",\"confidence\":0.92}]}'"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.WRITER_ALLOW_CLI = "1";
    process.env.WRITER_AI_ENGINE = "oneshot"; // legacy pipeline test; rewritten agentically when one-shot is deleted
    process.env.WRITER_CODEX_PATH = relative(process.cwd(), fakeCodexPath);
    process.env.WRITER_DOWNLOADS_DIR = downloadsDir;

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      const opened = JSON.parse(openResponse.body.toString("utf8")) as {
        session: {
          documentText: string;
          pendingSuggestions: number;
          routineProgress: string[];
          sourceDocument: { modifiedAt: string; modifiedMs: number; path: string; sizeBytes: number } | null;
        };
      };
      const openedSourceInfo = statSync(sourcePath);

      expect(openResponse.statusCode).toBe(200);
      expect(opened.session.documentText).toContain("This is actually very wordy.");
      expect(opened.session.pendingSuggestions).toBe(0);
      expect(opened.session.routineProgress).toEqual([]);
      expect(opened.session.sourceDocument).toMatchObject({
        path: sourcePath,
        sizeBytes: openedSourceInfo.size
      });
      expect(typeof opened.session.sourceDocument?.modifiedAt).toBe("string");
      expect(typeof opened.session.sourceDocument?.modifiedMs).toBe("number");

      const progressResponse = await requestBuffer(
        "POST",
        "/api/session/routine-progress",
        { "Content-Type": "application/json" },
        JSON.stringify({ routineProgress: ["r01-significance", "r01-aims", "r01-significance"] })
      );
      const progress = JSON.parse(progressResponse.body.toString("utf8")) as { session: { routineProgress: string[] } };

      expect(progressResponse.statusCode).toBe(200);
      expect(progress.session.routineProgress).toEqual(["r01-significance", "r01-aims"]);

      const runResponse = await requestBuffer(
        "POST",
        "/api/session/routine-run",
        { "Content-Type": "application/json" },
        JSON.stringify({
          id: "run-1",
          routineId: "r01-significance",
          label: "Significance",
          completedAt: "2026-05-24T12:45:05.670Z",
          artifactPath: reviewPath,
          reportPath,
          suggestionsPath,
          report: {
            totalSuggestions: 4,
            matchedSuggestions: 2,
            commentedSuggestions: 2,
            commentedSuggestionOriginals: [
              "This protected premise sentence became a Word comment.",
              "This second protected premise sentence became a Word comment."
            ],
            commentedSuggestionReasons: [
              "Anchor is in a paragraph that already contains tracked changes.",
              "Anchor is in a paragraph that already contains tracked changes."
            ],
            commentedSuggestionTitles: ["Protected premise", "Protected premise"],
            unmatchedSuggestions: 0,
            unmatchedSuggestionTitles: []
          }
        })
      );
      const run = JSON.parse(runResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ artifactPath: string | null; reportPath: string | null; suggestionsPath: string | null; id: string; label: string; report: { commentedSuggestionOriginals: string[]; commentedSuggestionReasonCounts: Array<{ count: number; reason: string }>; commentedSuggestionReasons: string[]; commentedSuggestionTitles: string[]; matchedSuggestions: number; representedSuggestions: number } }> };
      };

      expect(runResponse.statusCode).toBe(200);
      expect(run.session.routineRuns[0]).toMatchObject({
        artifactPath: reviewPath,
        reportPath,
        suggestionsPath,
        id: "run-1",
        label: "Significance",
        report: {
          commentedSuggestionOriginals: [
            "This protected premise sentence became a Word comment.",
            "This second protected premise sentence became a Word comment."
          ],
          commentedSuggestionReasons: [
            "Anchor is in a paragraph that already contains tracked changes.",
            "Anchor is in a paragraph that already contains tracked changes."
          ],
          commentedSuggestionReasonCounts: [
            { count: 2, reason: "Anchor is in a paragraph that already contains tracked changes." }
          ],
          commentedSuggestionTitles: ["Protected premise", "Protected premise"],
          matchedSuggestions: 2,
          representedSuggestions: 4
        }
      });

      const longOriginal = `Long protected section ${"x".repeat(900)}`;
      const longRunResponse = await requestBuffer(
        "POST",
        "/api/session/routine-run",
        { "Content-Type": "application/json" },
        JSON.stringify({
          id: "run-long-original",
          routineId: "r01-long-comment",
          label: "Long comment",
          completedAt: "2026-05-24T13:45:05.670Z",
          artifactPath: reviewPath,
          reportPath,
          suggestionsPath,
          report: {
            totalSuggestions: 1,
            matchedSuggestions: 0,
            commentedSuggestions: 1,
            commentedSuggestionOriginals: [longOriginal],
            commentedSuggestionReasons: ["Anchor was found only in raw Word XML."],
            commentedSuggestionTitles: ["Long protected section"],
            unmatchedSuggestions: 0,
            unmatchedSuggestionTitles: []
          }
        })
      );
      const longRun = JSON.parse(longRunResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ id: string; report: { commentedSuggestionOriginals: string[] } }> };
      };

      expect(longRunResponse.statusCode).toBe(200);
      expect(longRun.session.routineRuns[0].id).toBe("run-long-original");
      expect(longRun.session.routineRuns[0].report.commentedSuggestionOriginals[0]).not.toBe(longOriginal);
      expect(longRun.session.routineRuns[0].report.commentedSuggestionOriginals[0]).toContain("full original remains in the report and suggestions artifacts");

      const fullSnapshotResponse = await requestBuffer("GET", "/api/session/export-state");
      const fullSnapshot = JSON.parse(fullSnapshotResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ id: string; report: { commentedSuggestionOriginals: string[] } }> };
      };
      expect(fullSnapshot.session.routineRuns[0].id).toBe("run-long-original");
      expect(fullSnapshot.session.routineRuns[0].report.commentedSuggestionOriginals[0]).toBe(longOriginal);

      const emptyRunResponse = await requestBuffer(
        "POST",
        "/api/session/routine-run",
        { "Content-Type": "application/json" },
        JSON.stringify({
          routineId: "r01-approach",
          label: "Approach",
          artifactPath: reviewPath,
          report: {
            totalSuggestions: 0,
            matchedSuggestions: 0,
            commentedSuggestions: 0,
            commentedSuggestionTitles: [],
            unmatchedSuggestions: 0,
            unmatchedSuggestionTitles: []
          }
        })
      );
      const emptyRun = JSON.parse(emptyRunResponse.body.toString("utf8")) as { error: string };

      expect(emptyRunResponse.statusCode).toBe(400);
      expect(emptyRun.error).toBe("Routine run report totalSuggestions must be greater than zero.");

      const documentResponse = await requestBuffer("GET", "/api/session/document");
      const documentSession = JSON.parse(documentResponse.body.toString("utf8")) as {
        session: { documentHtml: string; documentHtmlLength: number; name: string; routineProgress: string[]; routineRuns: Array<{ id: string; routineId: string }> };
      };

      expect(documentResponse.statusCode).toBe(200);
      expect(documentSession.session.name).toBe("source.docx");
      expect(documentSession.session.documentHtml).toContain("This is actually very wordy.");
      expect(documentSession.session.documentHtmlLength).toBe(documentSession.session.documentHtml.length);
      expect(documentSession.session.routineProgress).toEqual(["r01-significance", "r01-aims"]);
      expect(documentSession.session.routineRuns).toMatchObject([
        { id: "run-long-original", routineId: "r01-long-comment" },
        { id: "run-1", routineId: "r01-significance" }
      ]);

      const suggestResponse = await requestBuffer(
        "POST",
        "/api/session/suggest",
        { "Content-Type": "application/json" },
        JSON.stringify({ provider: "codex", instruction: "Tighten this.", mode: "global" })
      );
      const suggested = JSON.parse(suggestResponse.body.toString("utf8")) as {
        ai: { suggestions: Array<{ id: string; title: string }> };
        recordedSuggestions: boolean;
        session: { pendingSuggestions: number };
      };

      expect(suggestResponse.statusCode).toBe(200);
      expect(suggested.ai.suggestions[0].title).toBe("Tighten sentence");
      expect(suggested.recordedSuggestions).toBe(true);
      expect(suggested.session.pendingSuggestions).toBe(1);

      const previewSuggestResponse = await requestBuffer(
        "POST",
        "/api/session/suggest",
        { "Content-Type": "application/json" },
        JSON.stringify({ provider: "codex", instruction: "Preview only.", mode: "global", recordSuggestions: false })
      );
      const previewSuggested = JSON.parse(previewSuggestResponse.body.toString("utf8")) as {
        ai: { suggestions: Array<{ id: string; title: string }> };
        recordedSuggestions: boolean;
        session: { pendingSuggestions: number };
      };

      expect(previewSuggestResponse.statusCode).toBe(200);
      expect(previewSuggested.ai.suggestions[0].title).toBe("Tighten sentence");
      expect(previewSuggested.recordedSuggestions).toBe(false);
      expect(previewSuggested.session.pendingSuggestions).toBe(1);

      const snapshotPath = join(tempDir, "review_session.json");
      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          copyToDownloads: true,
          outputPath: reviewPath,
          sessionSnapshotOutputPath: snapshotPath,
          routineRun: {
            id: "run-exported",
            routineId: "r01-integration",
            label: "Integration",
            completedAt: "2026-05-25T09:38:30.568Z",
            instruction: "Original integration prompt."
          }
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        artifactPath: string;
        downloadCopyPath: string | null;
        outputPath: string;
        reportPath: string;
        reviewPlacements: Array<{ handoff: string; outcome: string; title: string }>;
        reviewSummary: { matchedSuggestionTitles: string[]; representedSuggestions: number; totalSuggestions: number; trackedChanges: number; unresolvedSuggestions: number; wordComments: number };
        routineRun: { artifactPath: string; downloadCopyPath: string | null; id: string; instruction: string; label: string; report: { matchedSuggestionTitles: string[]; matchedSuggestions: number; representedSuggestions: number; totalSuggestions: number }; reportPath: string; sourceDocument: { modifiedAt: string; modifiedMs: number; path: string; sizeBytes: number } | null; suggestionsPath: string };
        session: { routineProgress: string[]; routineRuns: Array<{ downloadCopyPath: string | null; id: string; instruction: string; label: string; reportPath: string; sourceDocument: { modifiedAt: string; modifiedMs: number; path: string; sizeBytes: number } | null; suggestionsPath: string }> };
        sessionSnapshotPath: string | null;
        suggestionsPath: string;
        sourceDocument: { modifiedAt: string; modifiedMs: number; path: string; sizeBytes: number } | null;
        report: { matchedSuggestionTitles: string[]; matchedSuggestions: number; totalSuggestions: number };
      };
      const zip = await JSZip.loadAsync(readFileSync(exported.outputPath));
      const documentXml = await zip.file("word/document.xml")?.async("string");
      const sourceInfo = statSync(sourcePath);
      const savedSuggestions = JSON.parse(readFileSync(exported.suggestionsPath, "utf8")) as {
        downloadCopyPath: string | null;
        documentName: string;
        pendingOnly: boolean;
        reviewPlacements: Array<{ handoff: string; originalLength: number; originalPreview: string; outcome: string; replacementLength: number; replacementPreview: string; scale: string; sectionHint: string; title: string }>;
        routineRun: { id: string; instruction?: string; label: string; routineId: string; completedAt: string } | null;
        sourceDocument: { modifiedAt: string; modifiedMs: number; path: string; sizeBytes: number } | null;
        sourceDocumentPath: string | null;
        suggestions: Array<{ title: string }>;
      };
      const savedReport = JSON.parse(readFileSync(exported.reportPath, "utf8")) as {
        artifactPath: string;
        downloadCopyPath: string | null;
        documentName: string;
        outputPath: string;
        pendingOnly: boolean;
        reviewSummary: { matchedSuggestionTitles: string[]; representedSuggestions: number; totalSuggestions: number; trackedChanges: number; unresolvedSuggestions: number; wordComments: number };
        sourceDocument: { modifiedAt: string; modifiedMs: number; path: string; sizeBytes: number } | null;
        sourceDocumentPath: string | null;
        suggestionsPath: string;
        report: { matchedSuggestions: number; totalSuggestions: number };
      };
      const savedSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        sourceDocumentPath: string | null;
        version: number;
        session: { routineProgress: string[]; routineRuns: Array<{ id: string; instruction?: string; label: string; sourceDocument?: { path: string; sizeBytes: number } | null }>; suggestions: Array<{ title: string }> };
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.artifactPath).toBe(reviewPath);
      expect(exported.downloadCopyPath).toBe(downloadCopyPath);
      expect(exported.outputPath).toBe(reviewPath);
      expect(exported.reportPath).toBe(join(tempDir, "review_report.json"));
      expect(exported.sessionSnapshotPath).toBe(snapshotPath);
      expect(exported.suggestionsPath).toBe(join(tempDir, "review_suggestions.json"));
      expect(exported.reviewPlacements).toMatchObject([{
        handoff: "Body tracked change in Word; review and accept or reject normally.",
        outcome: "tracked-change",
        title: "Tighten sentence"
      }]);
      expect(exported.sourceDocument).toMatchObject({
        path: sourcePath,
        sizeBytes: sourceInfo.size
      });
      expect(typeof exported.sourceDocument?.modifiedAt).toBe("string");
      expect(typeof exported.sourceDocument?.modifiedMs).toBe("number");
      expect(exported.routineRun).toMatchObject({
        artifactPath: reviewPath,
        downloadCopyPath,
        id: "run-exported",
        instruction: "Original integration prompt.",
        label: "Integration",
        reportPath: join(tempDir, "review_report.json"),
        sourceDocument: {
          path: sourcePath,
          sizeBytes: sourceInfo.size
        },
        suggestionsPath: join(tempDir, "review_suggestions.json"),
        report: { matchedSuggestionTitles: ["Tighten sentence"], matchedSuggestions: 1, totalSuggestions: 1 }
      });
      expect(exported.session.routineRuns[0]).toMatchObject({
        downloadCopyPath,
        id: "run-exported",
        instruction: "Original integration prompt.",
        label: "Integration",
        reportPath: join(tempDir, "review_report.json"),
        sourceDocument: {
          path: sourcePath,
          sizeBytes: sourceInfo.size
        },
        suggestionsPath: join(tempDir, "review_suggestions.json")
      });
      expect(exported.session.routineProgress).toEqual(["r01-significance", "r01-aims", "r01-integration"]);
      expect(exported.report).toMatchObject({ matchedSuggestionTitles: ["Tighten sentence"], matchedSuggestions: 1, totalSuggestions: 1 });
      expect(exported.reviewSummary).toMatchObject({
        matchedSuggestionTitles: ["Tighten sentence"],
        representedSuggestions: 1,
        totalSuggestions: 1,
        trackedChanges: 1,
        unresolvedSuggestions: 0,
        wordComments: 0
      });
      expect(readFileSync(downloadCopyPath).equals(readFileSync(reviewPath))).toBe(true);
      expect(savedSuggestions).toMatchObject({
        downloadCopyPath,
        documentName: "source.docx",
        pendingOnly: true,
        reviewPlacements: [{
          handoff: "Body tracked change in Word; review and accept or reject normally.",
          originalLength: 28,
          originalPreview: "This is actually very wordy.",
          outcome: "tracked-change",
          replacementLength: 14,
          replacementPreview: "This is wordy.",
          scale: "sentence",
          sectionHint: "Unscoped",
          title: "Tighten sentence"
        }],
        routineRun: {
          id: "run-exported",
          instruction: "Original integration prompt.",
          label: "Integration",
          routineId: "r01-integration",
          completedAt: "2026-05-25T09:38:30.568Z"
        },
        sourceDocument: {
          path: sourcePath,
          sizeBytes: sourceInfo.size
        },
        sourceDocumentPath: sourcePath,
        suggestions: [{ title: "Tighten sentence" }]
      });
      expect(savedReport).toMatchObject({
        artifactPath: reviewPath,
        downloadCopyPath,
        documentName: "source.docx",
        outputPath: reviewPath,
        pendingOnly: true,
        reviewSummary: {
          matchedSuggestionTitles: ["Tighten sentence"],
          representedSuggestions: 1,
          totalSuggestions: 1,
          trackedChanges: 1,
          unresolvedSuggestions: 0,
          wordComments: 0
        },
        sourceDocument: {
          path: sourcePath,
          sizeBytes: sourceInfo.size
        },
        sourceDocumentPath: sourcePath,
        suggestionsPath: join(tempDir, "review_suggestions.json"),
        report: { matchedSuggestionTitles: ["Tighten sentence"], matchedSuggestions: 1, totalSuggestions: 1 }
      });
      expect(savedSnapshot.sourceDocumentPath).toBe(sourcePath);
      expect(savedSnapshot.version).toBe(1);
      expect(savedSnapshot.session.routineRuns[0]).toMatchObject({
        id: "run-exported",
        instruction: "Original integration prompt.",
        label: "Integration",
        sourceDocument: {
          path: sourcePath,
          sizeBytes: sourceInfo.size
        }
      });
      expect(savedSnapshot.session.routineProgress).toEqual(["r01-significance", "r01-aims", "r01-integration"]);
      expect(savedSnapshot.session.suggestions).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "Tighten sentence" })
      ]));
      expect(documentXml).toContain("<w:del ");
      expect(documentXml).toContain("<w:ins ");

      const artifactResponse = await requestBuffer(
        "POST",
        "/api/session/routine-artifact",
        { "Content-Type": "application/json" },
        JSON.stringify({ id: "run-1" })
      );

      expect(artifactResponse.statusCode).toBe(200);
      expect(artifactResponse.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      expect(artifactResponse.headers["content-disposition"]).toContain("review.docx");
      expect(artifactResponse.body.equals(readFileSync(reviewPath))).toBe(true);

      const routineSuggestionsResponse = await requestBuffer(
        "POST",
        "/api/session/routine-suggestions",
        { "Content-Type": "application/json" },
        JSON.stringify({ id: "run-1" })
      );
      const routineSuggestions = JSON.parse(routineSuggestionsResponse.body.toString("utf8")) as {
        syncedSuggestions: number;
        session: { pendingSuggestions: number; suggestions: Array<{ id: string; status: string; title: string }> };
      };

      expect(routineSuggestionsResponse.statusCode).toBe(200);
      expect(routineSuggestions.syncedSuggestions).toBe(1);
      expect(routineSuggestions.session.pendingSuggestions).toBe(2);
      expect(routineSuggestions.session.suggestions[0]).toMatchObject({
        id: "saved-run-suggestion",
        status: "pending",
        title: "Saved run suggestion"
      });

      const selectedExportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: selectedReviewPath,
          suggestionIds: [suggested.ai.suggestions[0].id]
        })
      );
      const selectedExport = JSON.parse(selectedExportResponse.body.toString("utf8")) as {
        report: { matchedSuggestionTitles: string[]; totalSuggestions: number };
        suggestionsPath: string;
      };
      const selectedSavedSuggestions = JSON.parse(readFileSync(selectedExport.suggestionsPath, "utf8")) as {
        suggestions: Array<{ title: string }>;
      };

      expect(selectedExportResponse.statusCode).toBe(200);
      expect(selectedExport.report).toMatchObject({
        matchedSuggestionTitles: ["Tighten sentence"],
        totalSuggestions: 1
      });
      expect(selectedSavedSuggestions.suggestions).toMatchObject([{ title: "Tighten sentence" }]);

      const unknownSelectedExportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({ outputPath: selectedReviewPath, suggestionIds: ["missing-suggestion"] })
      );
      const unknownSelectedExport = JSON.parse(unknownSelectedExportResponse.body.toString("utf8")) as { error: string };

      expect(unknownSelectedExportResponse.statusCode).toBe(400);
      expect(unknownSelectedExport.error).toContain("missing-suggestion");

      const stateExportResponse = await requestBuffer("GET", "/api/session/export-state");
      const snapshot = JSON.parse(stateExportResponse.body.toString("utf8")) as {
        session: { name: string; routineProgress: string[]; routineRuns: Array<{ completedAt: string; id: string; label: string }>; sourceTrackedChanges?: Array<{ author?: string; date?: string; kind: string; text: string }>; suggestions: Array<{ title: string }> };
        sourceDocumentPath: string;
        version: number;
      };

      expect(stateExportResponse.statusCode).toBe(200);
      expect(stateExportResponse.headers["content-disposition"]).toContain("_nebula-session.json");
      expect(snapshot.version).toBe(1);
      expect(snapshot.sourceDocumentPath).toBe(sourcePath);
      expect(snapshot.session.name).toBe("source.docx");
      expect(snapshot.session.routineProgress).toEqual(["r01-significance", "r01-aims", "r01-integration"]);
      expect(snapshot.session.routineRuns).toMatchObject([
        { id: "run-exported", label: "Integration" },
        { id: "run-long-original", label: "Long comment" },
        { id: "run-1", label: "Significance" }
      ]);
      expect(snapshot.session.sourceTrackedChanges).toEqual([]);
      expect(snapshot.session.suggestions).toHaveLength(2);
      expect(snapshot.session.suggestions.map((suggestion) => suggestion.title)).toContain("Saved run suggestion");
      expect(snapshot.session.suggestions.map((suggestion) => suggestion.title)).toContain("Tighten sentence");

      const unorderedSnapshot = {
        ...snapshot,
        session: {
          ...snapshot.session,
          routineRuns: [...snapshot.session.routineRuns].reverse(),
          sourceTrackedChanges: [
            {
              author: "Nebula Writer",
              date: "2026-06-08T02:49:00.000Z",
              kind: "inserted",
              text: "Source-tracked text from Word."
            }
          ]
        }
      };
      const stateImportResponse = await requestBuffer(
        "POST",
        "/api/session/import-state",
        { "Content-Type": "application/json" },
        JSON.stringify(unorderedSnapshot)
      );
      const importedState = JSON.parse(stateImportResponse.body.toString("utf8")) as {
        session: { documentHtml: string; pendingSuggestions: number; routineProgress: string[]; routineRuns: Array<{ id: string; label: string }>; sourceTrackedChanges?: Array<{ author?: string; date?: string; kind: string; text: string }>; suggestions: Array<{ title: string }> };
      };

      expect(stateImportResponse.statusCode).toBe(200);
      expect(importedState.session.documentHtml).toContain("This is actually very wordy.");
      expect(importedState.session.pendingSuggestions).toBe(2);
      expect(importedState.session.routineProgress).toEqual(["r01-significance", "r01-aims", "r01-integration"]);
      expect(importedState.session.routineRuns).toMatchObject([
        { id: "run-exported", label: "Integration" },
        { id: "run-long-original", label: "Long comment" },
        { id: "run-1", label: "Significance" }
      ]);
      expect(importedState.session.sourceTrackedChanges).toEqual(unorderedSnapshot.session.sourceTrackedChanges);
      expect(importedState.session.suggestions.map((suggestion) => suggestion.title)).toContain("Saved run suggestion");

      const restoredSnapshotResponse = await requestBuffer("GET", "/api/session/export-state");
      const restoredSnapshot = JSON.parse(restoredSnapshotResponse.body.toString("utf8")) as {
        session: { sourceTrackedChanges?: Array<{ author?: string; date?: string; kind: string; text: string }> };
      };
      expect(restoredSnapshot.session.sourceTrackedChanges).toEqual(unorderedSnapshot.session.sourceTrackedChanges);

      const manyReportIds = Array.from({ length: 25 }, (_, index) => `matched-suggestion-${index + 1}`);
      const manyIdSnapshot = {
        ...snapshot,
        session: {
          ...snapshot.session,
          routineRuns: [
            {
              id: "run-many-report-ids",
              routineId: "r01-many-report-ids",
              label: "Many report ids",
              completedAt: "2030-01-01T00:00:00.000Z",
              report: {
                totalSuggestions: manyReportIds.length,
                matchedSuggestions: manyReportIds.length,
                matchedSuggestionIds: manyReportIds,
                matchedSuggestionTitles: manyReportIds.map((id) => `Title for ${id}`),
                commentedSuggestions: 0,
                commentedSuggestionIds: [],
                commentedSuggestionOriginals: [],
                commentedSuggestionReasons: [],
                commentedSuggestionTitles: [],
                unmatchedSuggestions: 0,
                unmatchedSuggestionIds: [],
                unmatchedSuggestionOriginals: [],
                unmatchedSuggestionTitles: []
              }
            },
            ...snapshot.session.routineRuns
          ]
        }
      };
      const manyIdImportResponse = await requestBuffer(
        "POST",
        "/api/session/import-state",
        { "Content-Type": "application/json" },
        JSON.stringify(manyIdSnapshot)
      );
      const manyIdImport = JSON.parse(manyIdImportResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ id: string; report: { matchedSuggestionIds: string[]; matchedSuggestionTitles: string[] } }> };
      };

      expect(manyIdImportResponse.statusCode).toBe(200);
      expect(manyIdImport.session.routineRuns[0].id).toBe("run-many-report-ids");
      expect(manyIdImport.session.routineRuns[0].report.matchedSuggestionIds).toEqual(manyReportIds);
      expect(manyIdImport.session.routineRuns[0].report.matchedSuggestionTitles).toHaveLength(20);

      const overlappingReportSnapshot = {
        ...snapshot,
        session: {
          ...snapshot.session,
          routineRuns: [
            {
              id: "run-overlap-report",
              routineId: "r01-overlap-report",
              label: "Overlap report",
              completedAt: "2030-01-02T00:00:00.000Z",
              report: {
                totalSuggestions: 1,
                matchedSuggestions: 0,
                matchedSuggestionIds: [],
                matchedSuggestionTitles: [],
                commentedSuggestions: 1,
                commentedSuggestionIds: ["overlap-suggestion"],
                commentedSuggestionOriginals: ["Original sentence."],
                commentedSuggestionReasons: ["Preserved as an appendix comment."],
                commentedSuggestionTitles: ["Overlap suggestion"],
                unmatchedSuggestions: 1,
                unmatchedSuggestionIds: ["overlap-suggestion"],
                unmatchedSuggestionOriginals: ["Original sentence."],
                unmatchedSuggestionTitles: ["Overlap suggestion"]
              }
            },
            ...snapshot.session.routineRuns
          ]
        }
      };
      const overlappingReportImportResponse = await requestBuffer(
        "POST",
        "/api/session/import-state",
        { "Content-Type": "application/json" },
        JSON.stringify(overlappingReportSnapshot)
      );

      expect(overlappingReportImportResponse.statusCode).toBe(200);

      const pathlessSnapshot = {
        ...snapshot,
        sourceDocumentPath: null,
        session: {
          ...snapshot.session,
          suggestions: [
            ...snapshot.session.suggestions,
            {
              id: "pathless-session-note",
              title: "Pathless session note",
              original: "This is actually very wordy.",
              replacement: "This is concise.",
              rationale: "Exercises pathless session import onto the open source DOCX.",
              confidence: 0.8,
              target: "global",
              status: "pending"
            }
          ]
        }
      };
      const pathlessImportResponse = await requestBuffer(
        "POST",
        "/api/session/import-state",
        { "Content-Type": "application/json" },
        JSON.stringify(pathlessSnapshot)
      );
      const pathlessImportedState = JSON.parse(pathlessImportResponse.body.toString("utf8")) as {
        session: { pendingSuggestions: number; suggestions: Array<{ title: string }> };
      };

      expect(pathlessImportResponse.statusCode).toBe(200);
      expect(pathlessImportedState.session.pendingSuggestions).toBe(3);
      expect(pathlessImportedState.session.suggestions.map((suggestion) => suggestion.title)).toContain("Pathless session note");

      const reopenedResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      const reopened = JSON.parse(reopenedResponse.body.toString("utf8")) as {
        session: { pendingSuggestions: number; routineProgress: string[]; routineRuns: Array<{ id: string; label: string }>; suggestions: Array<{ title: string }> };
      };

      expect(reopenedResponse.statusCode).toBe(200);
      expect(reopened.session.pendingSuggestions).toBe(3);
      expect(reopened.session.suggestions.map((suggestion) => suggestion.title)).toEqual([
        "Saved run suggestion",
        "Tighten sentence",
        "Pathless session note"
      ]);
      expect(reopened.session.routineProgress).toEqual(["r01-significance", "r01-aims", "r01-integration"]);
      expect(reopened.session.routineRuns).toMatchObject([
        { id: "run-exported", label: "Integration" },
        { id: "run-long-original", label: "Long comment" },
        { id: "run-1", label: "Significance" }
      ]);

      const closingReviewPath = join(tempDir, "closing-review.docx");
      const closingExportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: closingReviewPath,
          pendingOnly: false,
          suggestions: [{
            id: "closing-suggestion",
            title: "Closing Compliance and Milestones",
            original: "Missing closing section.",
            replacement: "Scientific Rigor, Reproducibility and Transparency: Verify Aim 1, Aim 2, and Aim 3 outputs. Expected Milestones and Impact: retain the timeline of proposed work.",
            rationale: "Classifies a closing handoff even when aim names appear in the replacement.",
            confidence: 0.8,
            target: "global",
            range: null,
            status: "pending"
          }]
        })
      );
      const closingExported = JSON.parse(closingExportResponse.body.toString("utf8")) as { suggestionsPath: string };
      const closingSavedSuggestions = JSON.parse(readFileSync(closingExported.suggestionsPath, "utf8")) as {
        reviewPlacements: Array<{ outcome: string; sectionHint: string; title: string }>;
      };

      expect(closingExportResponse.statusCode).toBe(200);
      expect(closingSavedSuggestions.reviewPlacements).toMatchObject([{
        outcome: "word-comment",
        sectionHint: "Closing sections",
        title: "Closing Compliance and Milestones"
      }]);

      const approachReviewPath = join(tempDir, "approach-review.docx");
      const approachExportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: approachReviewPath,
          pendingOnly: false,
          suggestions: [{
            id: "approach-suggestion",
            title: "Approach opening integration transition",
            original: "Missing approach transition.",
            replacement: "Approach\nAim 1, Aim 2, and Aim 3 form an integrated strategy.",
            rationale: "Classifies approach handoffs before aim-name mentions.",
            confidence: 0.8,
            target: "global",
            range: null,
            status: "pending"
          }]
        })
      );
      const approachExported = JSON.parse(approachExportResponse.body.toString("utf8")) as { suggestionsPath: string };
      const approachSavedSuggestions = JSON.parse(readFileSync(approachExported.suggestionsPath, "utf8")) as {
        reviewPlacements: Array<{ outcome: string; sectionHint: string; title: string }>;
      };

      expect(approachExportResponse.statusCode).toBe(200);
      expect(approachSavedSuggestions.reviewPlacements).toMatchObject([{
        outcome: "word-comment",
        sectionHint: "Approach",
        title: "Approach opening integration transition"
      }]);

      const broadRangeReviewPath = join(tempDir, "broad-range-review.docx");
      const broadRangeExportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: broadRangeReviewPath,
          pendingOnly: false,
          suggestions: [{
            id: "broad-range-aim2-suggestion",
            title: "Aim 2 integration note",
            original: "Missing Aim 2 integration.",
            replacement: "Connect Aim 2 dynamics to the proposal-wide model.",
            rationale: "Classifies the suggestion's own scope before broad selection context.",
            confidence: 0.8,
            target: "selection",
            range: {
              from: 0,
              to: 30,
              text: "Approach\nAim 1 starts first. Aim 2 follows later."
            },
            status: "pending"
          }]
        })
      );
      const broadRangeExported = JSON.parse(broadRangeExportResponse.body.toString("utf8")) as { suggestionsPath: string };
      const broadRangeSavedSuggestions = JSON.parse(readFileSync(broadRangeExported.suggestionsPath, "utf8")) as {
        reviewPlacements: Array<{ outcome: string; sectionHint: string; title: string }>;
      };

      expect(broadRangeExportResponse.statusCode).toBe(200);
      expect(broadRangeSavedSuggestions.reviewPlacements).toMatchObject([{
        outcome: "word-comment",
        sectionHint: "Aim 2",
        title: "Aim 2 integration note"
      }]);

      const payoffReviewPath = join(tempDir, "payoff-review.docx");
      const payoffExportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: payoffReviewPath,
          pendingOnly: false,
          suggestions: [{
            id: "closing-payoff-suggestion",
            title: "Refine final payoff",
            original: "Missing final payoff.",
            replacement: "This proposal will establish a rigorous, reproducible framework for studying dynamic chromatin regulation.",
            rationale: "Classifies payoff edits as closing material even when the selected range starts in Aim 3.",
            confidence: 0.8,
            target: "selection",
            range: {
              from: 0,
              to: 40,
              text: "Expected results, limitations and alternative strategies (Aim 3)."
            },
            status: "pending"
          }]
        })
      );
      const payoffExported = JSON.parse(payoffExportResponse.body.toString("utf8")) as { suggestionsPath: string };
      const payoffSavedSuggestions = JSON.parse(readFileSync(payoffExported.suggestionsPath, "utf8")) as {
        reviewPlacements: Array<{ outcome: string; sectionHint: string; title: string }>;
      };

      expect(payoffExportResponse.statusCode).toBe(200);
      expect(payoffSavedSuggestions.reviewPlacements).toMatchObject([{
        handoff: expect.stringContaining("Word comment"),
        outcome: "word-comment",
        sectionHint: "Closing sections",
        title: "Refine final payoff"
      }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.WRITER_AI_ENGINE;
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CODEX_PATH;
      } else {
        process.env.WRITER_CODEX_PATH = previousOverride;
      }
      if (previousDownloadsDir === undefined) {
        delete process.env.WRITER_DOWNLOADS_DIR;
      } else {
        process.env.WRITER_DOWNLOADS_DIR = previousDownloadsDir;
      }
    }
  }, 10_000);

  it("exports explicit review packets with more than 200 suggestions", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-bulk-export-"));
    const sourcePath = join(tempDir, "bulk-source.docx");
    const reviewPath = join(tempDir, "bulk-review.docx");
    const suggestionCount = 205;
    const sourceSentences = Array.from(
      { length: suggestionCount },
      (_, index) => `Bulk export sentence ${String(index + 1).padStart(3, "0")} is unnecessarily wordy.`
    );
    const sourceResponse = await exportHttpDocx({
      title: "Bulk Export Source",
      html: sourceSentences.map((sentence) => `<p>${sentence}</p>`).join("")
    });
    const suggestions = sourceSentences.map((sentence, index) => ({
      id: `bulk-export-suggestion-${index + 1}`,
      title: `Bulk export suggestion ${index + 1}`,
      original: sentence,
      replacement: sentence.replace("unnecessarily wordy", "concise"),
      rationale: "Exercises large explicit review export packets.",
      confidence: 0.91
    }));

    try {
      writeFileSync(sourcePath, sourceResponse.body);
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );

      expect(openResponse.statusCode).toBe(200);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: reviewPath,
          suggestions
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        report: { totalSuggestions: number };
        suggestionsPath: string;
      };
      const savedSuggestions = JSON.parse(readFileSync(exported.suggestionsPath, "utf8")) as {
        suggestions: Array<{ title: string }>;
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.report.totalSuggestions).toBe(suggestionCount);
      expect(savedSuggestions.suggestions).toHaveLength(suggestionCount);
      expect(savedSuggestions.suggestions.at(-1)?.title).toBe(`Bulk export suggestion ${suggestionCount}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("restores routine history from the latest matching tmp session snapshot when reopening a DOCX", async () => {
    const previousDownloadsDir = process.env.WRITER_DOWNLOADS_DIR;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-snapshot-restore-"));
    const downloadsDir = join(tempDir, "Downloads");
    const sourcePath = join(tempDir, "source.docx");
    const tmpDir = join(process.cwd(), "tmp");
    const olderSnapshotPath = join(tmpDir, `writer-autorestore-older-${Date.now()}.json`);
    const latestSnapshotPath = join(tmpDir, `writer-autorestore-latest-${Date.now()}.json`);
    const latestArtifactPath = join(tempDir, "Latest history.docx");
    const latestDownloadCopyPath = join(downloadsDir, "Latest history.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>Restore this integration note.</p>"
    });

    process.env.WRITER_DOWNLOADS_DIR = downloadsDir;
    writeFileSync(sourcePath, sourceResponse.body);
    writeFileSync(latestArtifactPath, sourceResponse.body);
    mkdirSync(tmpDir, { recursive: true });

    const snapshot = (exportedAt: string, label: string, downloadCopyPath: string | null) => ({
      version: 1,
      exportedAt,
      sourceDocumentPath: sourcePath,
      session: {
        name: "source.docx",
        title: "Session Source",
        routineProgress: ["r01-cross-aim"],
        routineRuns: [{
          id: `run-${label.toLowerCase().replace(/\s+/g, "-")}`,
          routineId: "r01-cross-aim",
          label,
          completedAt: exportedAt,
          artifactPath: join(tempDir, `${label}.docx`),
          downloadCopyPath,
          report: {
            totalSuggestions: 1,
            matchedSuggestions: 1,
            matchedSuggestionTitles: ["Restore integration note"],
            commentedSuggestions: 0,
            commentedSuggestionTitles: [],
            unmatchedSuggestions: 0,
            unmatchedSuggestionTitles: []
          }
        }],
        suggestions: [{
          id: `suggestion-${label.toLowerCase().replace(/\s+/g, "-")}`,
          title: "Restore integration note",
          original: "Restore this integration note.",
          replacement: "Restore this integration note clearly.",
          rationale: "Verifies snapshot recovery.",
          confidence: 0.9,
          target: "global",
          status: "pending"
        }]
      }
    });

    writeFileSync(olderSnapshotPath, JSON.stringify(snapshot("2026-05-25T09:00:00.000Z", "Older history", "/tmp/older.docx"), null, 2));
    writeFileSync(latestSnapshotPath, JSON.stringify(snapshot("2026-05-25T10:00:00.000Z", "Latest history", null), null, 2));

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      const opened = JSON.parse(openResponse.body.toString("utf8")) as {
        session: { pendingSuggestions: number; routineProgress: string[]; routineRuns: Array<{ downloadCopyPath: string | null; label: string }>; suggestions: Array<{ title: string }> };
      };

      expect(openResponse.statusCode).toBe(200);
      expect(opened.session.pendingSuggestions).toBe(1);
      expect(opened.session.routineProgress).toEqual(["r01-cross-aim"]);
      expect(opened.session.routineRuns).toMatchObject([
        { downloadCopyPath: latestDownloadCopyPath, label: "Latest history" }
      ]);
      expect(readFileSync(latestDownloadCopyPath).equals(readFileSync(latestArtifactPath))).toBe(true);
      expect(opened.session.suggestions).toMatchObject([{ title: "Restore integration note" }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(olderSnapshotPath, { force: true });
      rmSync(latestSnapshotPath, { force: true });
      if (previousDownloadsDir === undefined) {
        delete process.env.WRITER_DOWNLOADS_DIR;
      } else {
        process.env.WRITER_DOWNLOADS_DIR = previousDownloadsDir;
      }
    }
  });

  it("rejects stale session writes when the client provides concurrency context", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-conflict-"));
    const sourcePath = join(tempDir, "source.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Conflict Source",
      html: "<p>Conflict guard text.</p>"
    });
    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);
      const opened = JSON.parse(openResponse.body.toString("utf8")) as {
        session: { id: string; revision: number };
      };
      expect(typeof opened.session.revision).toBe("number");

      const wrongSessionResponse = await requestBuffer(
        "POST",
        "/api/session/chat-messages",
        { "Content-Type": "application/json" },
        JSON.stringify({ chatMessages: [], expectedSessionId: "not-the-active-session" })
      );
      expect(wrongSessionResponse.statusCode).toBe(409);

      const matchingResponse = await requestBuffer(
        "POST",
        "/api/session/chat-messages",
        { "Content-Type": "application/json" },
        JSON.stringify({
          chatMessages: [{ role: "user", content: "First write" }],
          expectedSessionId: opened.session.id,
          expectedRevision: opened.session.revision
        })
      );
      expect(matchingResponse.statusCode).toBe(200);
      const updated = JSON.parse(matchingResponse.body.toString("utf8")) as {
        session: { revision: number };
      };
      expect(updated.session.revision).toBeGreaterThan(opened.session.revision);

      const staleRevisionResponse = await requestBuffer(
        "POST",
        "/api/session/chat-messages",
        { "Content-Type": "application/json" },
        JSON.stringify({
          chatMessages: [{ role: "user", content: "Stale write" }],
          expectedSessionId: opened.session.id,
          expectedRevision: opened.session.revision
        })
      );
      expect(staleRevisionResponse.statusCode).toBe(409);
      const staleBody = JSON.parse(staleRevisionResponse.body.toString("utf8")) as { error: string };
      expect(staleBody.error).toContain("another tab or agent");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("answers CORS preflight only for origins allowed via WRITER_ALLOWED_ORIGINS", async () => {
    process.env.WRITER_ALLOWED_ORIGINS = "https://writer.zhoulab.io";
    const { createServer } = await import("node:http");
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const allowed = await fetch(`http://127.0.0.1:${port}/api/health`, {
        method: "OPTIONS",
        headers: { Origin: "https://writer.zhoulab.io", "Access-Control-Request-Method": "POST" }
      });
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://writer.zhoulab.io");
      expect(allowed.headers.get("access-control-allow-headers")).toContain("X-Writer-Share-Token");

      const denied = await fetch(`http://127.0.0.1:${port}/api/health`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" }
      });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      delete process.env.WRITER_ALLOWED_ORIGINS;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stores decision notes with suggestion decisions and clears them on reopen", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-decision-note-"));
    const sourcePath = join(tempDir, "note.docx");
    const sourceResponse = await exportHttpDocx({ title: "Notes", html: "<p>Note test body.</p>" });
    writeFileSync(sourcePath, sourceResponse.body);
    try {
      await requestBuffer("POST", "/api/session/open-docx", { "Content-Type": "application/json" }, JSON.stringify({ path: sourcePath }));
      await requestBuffer("POST", "/api/session/record-suggestions", { "Content-Type": "application/json" }, JSON.stringify({
        suggestions: [{ id: "note-1", title: "T", original: "Note test body.", replacement: "Edited.", rationale: "r", confidence: 0.9, target: "global", status: "pending", proposedBy: "Agent" }]
      }));

      const rejected = await requestBuffer("POST", "/api/session/suggestion-status", { "Content-Type": "application/json" }, JSON.stringify({
        id: "note-1", status: "rejected", expectedStatus: "pending", decidedBy: "Jian", decisionNote: "Too informal; keep the citation style."
      }));
      expect(rejected.statusCode).toBe(200);
      const rejectedBody = JSON.parse(rejected.body.toString("utf8")) as { session: { suggestions: Array<{ id: string; decisionNote?: string | null }> } };
      expect(rejectedBody.session.suggestions.find((sugg) => sugg.id === "note-1")?.decisionNote).toBe("Too informal; keep the citation style.");

      const reopened = await requestBuffer("POST", "/api/session/suggestion-status", { "Content-Type": "application/json" }, JSON.stringify({
        id: "note-1", status: "pending", expectedStatus: "rejected"
      }));
      const reopenedBody = JSON.parse(reopened.body.toString("utf8")) as { session: { suggestions: Array<{ id: string; decisionNote?: string | null }> } };
      expect(reopenedBody.session.suggestions.find((sugg) => sugg.id === "note-1")?.decisionNote ?? null).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records browser-side AI suggestions into the shared session with id dedupe", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-record-suggestions-"));
    const sourcePath = join(tempDir, "source.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Record Suggestions",
      html: "<p>Record this proposal.</p>"
    });
    writeFileSync(sourcePath, sourceResponse.body);
    const suggestion = {
      id: `record-${Date.now()}`,
      title: "Tighten recorded sentence",
      original: "Record this proposal.",
      replacement: "Record it.",
      rationale: "Sync test.",
      confidence: 0.9,
      target: "global",
      status: "pending"
    };

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const recordResponse = await requestBuffer(
        "POST",
        "/api/session/record-suggestions",
        { "Content-Type": "application/json" },
        JSON.stringify({ suggestions: [suggestion] })
      );
      expect(recordResponse.statusCode).toBe(200);
      const recordBody = JSON.parse(recordResponse.body.toString("utf8")) as { recorded: number; session: { pendingSuggestions: number } };
      expect(recordBody.recorded).toBe(1);
      expect(recordBody.session.pendingSuggestions).toBe(1);

      // A retry (same id) records nothing new.
      const retryResponse = await requestBuffer(
        "POST",
        "/api/session/record-suggestions",
        { "Content-Type": "application/json" },
        JSON.stringify({ suggestions: [suggestion] })
      );
      const retryBody = JSON.parse(retryResponse.body.toString("utf8")) as { recorded: number; session: { pendingSuggestions: number } };
      expect(retryBody.recorded).toBe(0);
      expect(retryBody.session.pendingSuggestions).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("appends chat messages with id dedupe instead of replacing the history", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-chat-append-"));
    const sourcePath = join(tempDir, "source.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Chat Append",
      html: "<p>Chat about this.</p>"
    });
    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const aliceAppend = await requestBuffer(
        "POST",
        "/api/session/chat-append",
        { "Content-Type": "application/json" },
        JSON.stringify({ chatMessages: [{ id: "m-alice-1", role: "user", content: "Can you clarify the methods?", author: "Alice", createdAt: "2026-06-10T12:00:00.000Z" }] })
      );
      expect(aliceAppend.statusCode).toBe(200);

      // Bob appends concurrently — including a duplicate of Alice's message id,
      // as a retry would. Only his new message lands.
      const bobAppend = await requestBuffer(
        "POST",
        "/api/session/chat-append",
        { "Content-Type": "application/json" },
        JSON.stringify({
          chatMessages: [
            { id: "m-alice-1", role: "user", content: "Can you clarify the methods?", author: "Alice", createdAt: "2026-06-10T12:00:00.000Z" },
            { id: "m-bob-1", role: "user", content: "The stats section needs sources.", author: "Bob", createdAt: "2026-06-10T12:00:00.050Z" }
          ]
        })
      );
      expect(bobAppend.statusCode).toBe(200);
      const bobBody = JSON.parse(bobAppend.body.toString("utf8")) as { appended: number; session: { chatMessages: Array<{ author: string | null; content: string; id?: string }> } };
      expect(bobBody.appended).toBe(1);
      const contents = bobBody.session.chatMessages.map((message) => `${message.author}: ${message.content}`);
      expect(contents).toContain("Alice: Can you clarify the methods?");
      expect(contents).toContain("Bob: The stats section needs sources.");
      expect(bobBody.session.chatMessages.filter((message) => message.id === "m-alice-1").length).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a stale suggestion decision via compare-and-swap and records who decided", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-suggestion-cas-"));
    const sourcePath = join(tempDir, "source.docx");
    const reviewPath = join(tempDir, "review.docx");
    const sourceResponse = await exportHttpDocx({
      title: "CAS Source",
      html: "<p>Decide this suggestion once.</p>"
    });
    writeFileSync(sourcePath, sourceResponse.body);
    const suggestion = {
      id: `cas-${Date.now()}`,
      title: "Tighten decision sentence",
      original: "Decide this suggestion once.",
      replacement: "Decide once.",
      rationale: "CAS test.",
      confidence: 0.9,
      target: "global",
      status: "pending"
    };

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);
      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({ outputPath: reviewPath, suggestions: [suggestion] })
      );
      expect(exportResponse.statusCode).toBe(200);

      // Alice accepts first.
      const aliceResponse = await requestBuffer(
        "POST",
        "/api/session/suggestion-status",
        { "Content-Type": "application/json" },
        JSON.stringify({ id: suggestion.id, status: "accepted", expectedStatus: "pending", decidedBy: "Alice" })
      );
      expect(aliceResponse.statusCode).toBe(200);
      const aliceBody = JSON.parse(aliceResponse.body.toString("utf8")) as { suggestion: { decidedBy: string; status: string } };
      expect(aliceBody.suggestion).toMatchObject({ status: "accepted", decidedBy: "Alice" });

      // Bob tries to reject the same pending suggestion — too late.
      const bobResponse = await requestBuffer(
        "POST",
        "/api/session/suggestion-status",
        { "Content-Type": "application/json" },
        JSON.stringify({ id: suggestion.id, status: "rejected", expectedStatus: "pending", decidedBy: "Bob" })
      );
      expect(bobResponse.statusCode).toBe(409);
      const bobBody = JSON.parse(bobResponse.body.toString("utf8")) as { conflict: { decidedBy: string; status: string }; error: string };
      expect(bobBody.error).toContain("already marked accepted by Alice");
      expect(bobBody.conflict).toMatchObject({ status: "accepted", decidedBy: "Alice" });

      // Without the guard (legacy callers) the update still applies.
      const legacyResponse = await requestBuffer(
        "POST",
        "/api/session/suggestion-status",
        { "Content-Type": "application/json" },
        JSON.stringify({ id: suggestion.id, status: "pending" })
      );
      expect(legacyResponse.statusCode).toBe(200);
      const legacyBody = JSON.parse(legacyResponse.body.toString("utf8")) as { suggestion: { decidedBy: string | null } };
      expect(legacyBody.suggestion.decidedBy).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists suggestion status updates to the auto-restore session snapshot", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-status-persist-"));
    const sourcePath = join(tempDir, "source.docx");
    const reviewPath = join(tempDir, "review.docx");
    const tmpDir = join(process.cwd(), "tmp", "recovery");
    const sourceResponse = await exportHttpDocx({
      title: "Status Source",
      html: "<p>Persist this status update.</p>"
    });
    const suggestion = {
      id: `status-persist-${Date.now()}`,
      title: "Persist status update",
      original: "Persist this status update.",
      replacement: "Persist this status update clearly.",
      rationale: "Verifies that user triage survives a sidecar restart.",
      confidence: 0.93,
      target: "global",
      status: "pending"
    };
    const snapshotsToCleanUp = new Set<string>();

    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: reviewPath,
          suggestions: [suggestion]
        })
      );
      expect(exportResponse.statusCode).toBe(200);

      const statusResponse = await requestBuffer(
        "POST",
        "/api/session/suggestion-status",
        { "Content-Type": "application/json" },
        JSON.stringify({ id: suggestion.id, status: "rejected" })
      );
      const statusBody = JSON.parse(statusResponse.body.toString("utf8")) as {
        suggestion: { id: string; status: string };
      };

      expect(statusResponse.statusCode).toBe(200);
      expect(statusBody.suggestion).toMatchObject({ id: suggestion.id, status: "rejected" });

      const restoredSnapshots = readdirSync(tmpDir)
        .filter((filename) => filename.startsWith("writer-autorestore-") && filename.endsWith(".json"))
        .map((filename) => join(tmpDir, filename))
        .map((snapshotPath) => {
          const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
            exportedAt?: string;
            sourceDocumentPath?: string;
            session?: { suggestions?: Array<{ id: string; status: string }> };
          };
          return { parsed, snapshotPath };
        })
        .filter(({ parsed }) => parsed.sourceDocumentPath === sourcePath);

      for (const { snapshotPath } of restoredSnapshots) {
        snapshotsToCleanUp.add(snapshotPath);
      }

      expect(restoredSnapshots.length).toBeGreaterThan(0);
      const latestSnapshot = restoredSnapshots
        .sort((left, right) => Date.parse(right.parsed.exportedAt ?? "") - Date.parse(left.parsed.exportedAt ?? ""))[0]?.parsed;
      const persistedSuggestion = latestSnapshot?.session?.suggestions?.find((candidate) => candidate.id === suggestion.id);

      expect(persistedSuggestion).toMatchObject({ id: suggestion.id, status: "rejected" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      for (const snapshotPath of snapshotsToCleanUp) {
        rmSync(snapshotPath, { force: true });
      }
    }
  });

  it("copies externally recorded review artifacts to Downloads when no handoff path is provided", async () => {
    const previousDownloadsDir = process.env.WRITER_DOWNLOADS_DIR;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-routine-download-copy-"));
    const downloadsDir = join(tempDir, "Downloads");
    const sourcePath = join(tempDir, "source.docx");
    const artifactPath = join(tempDir, "external-review.docx");
    const expectedDownloadCopyPath = join(downloadsDir, "external-review.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>Review this external artifact handoff.</p>"
    });
    const artifactResponse = await exportHttpDocx({
      title: "External Review",
      html: "<p>The agent exported this review document outside Writer.</p>"
    });

    process.env.WRITER_DOWNLOADS_DIR = downloadsDir;
    writeFileSync(sourcePath, sourceResponse.body);
    writeFileSync(artifactPath, artifactResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const routineRunResponse = await requestBuffer(
        "POST",
        "/api/session/routine-run",
        { "Content-Type": "application/json" },
        JSON.stringify({
          id: "external-review-run",
          routineId: "r01-external-review",
          label: "External review",
          artifactPath
        })
      );
      const routineRun = JSON.parse(routineRunResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ artifactPath: string | null; downloadCopyPath: string | null; id: string }> };
      };

      expect(routineRunResponse.statusCode).toBe(200);
      expect(routineRun.session.routineRuns[0]).toMatchObject({
        id: "external-review-run",
        artifactPath,
        downloadCopyPath: expectedDownloadCopyPath
      });
      expect(readFileSync(expectedDownloadCopyPath).equals(readFileSync(artifactPath))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousDownloadsDir === undefined) {
        delete process.env.WRITER_DOWNLOADS_DIR;
      } else {
        process.env.WRITER_DOWNLOADS_DIR = previousDownloadsDir;
      }
    }
  });

  it("backfills missing Downloads handoff paths when delayed routine artifacts appear", async () => {
    const previousDownloadsDir = process.env.WRITER_DOWNLOADS_DIR;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-routine-download-backfill-"));
    const downloadsDir = join(tempDir, "Downloads");
    const sourcePath = join(tempDir, "source.docx");
    const artifactPath = join(tempDir, "delayed-review.docx");
    const expectedDownloadCopyPath = join(downloadsDir, "delayed-review.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>Review this delayed artifact handoff.</p>"
    });
    const artifactResponse = await exportHttpDocx({
      title: "Delayed Review",
      html: "<p>The review artifact arrived after routine metadata.</p>"
    });

    process.env.WRITER_DOWNLOADS_DIR = downloadsDir;
    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const routineRunResponse = await requestBuffer(
        "POST",
        "/api/session/routine-run",
        { "Content-Type": "application/json" },
        JSON.stringify({
          id: "delayed-review-run",
          routineId: "r01-delayed-review",
          label: "Delayed review",
          artifactPath
        })
      );
      const routineRun = JSON.parse(routineRunResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ downloadCopyPath: string | null; id: string }> };
      };

      expect(routineRunResponse.statusCode).toBe(200);
      expect(routineRun.session.routineRuns[0]).toMatchObject({
        id: "delayed-review-run",
        downloadCopyPath: null
      });

      writeFileSync(artifactPath, artifactResponse.body);

      const sessionResponse = await requestBuffer("GET", "/api/session");
      const session = JSON.parse(sessionResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ downloadCopyPath: string | null; id: string }> };
      };

      expect(sessionResponse.statusCode).toBe(200);
      expect(session.session.routineRuns[0]).toMatchObject({
        id: "delayed-review-run",
        downloadCopyPath: expectedDownloadCopyPath
      });
      expect(readFileSync(expectedDownloadCopyPath).equals(readFileSync(artifactPath))).toBe(true);

      const snapshotResponse = await requestBuffer("GET", "/api/session/export-state");
      const snapshot = JSON.parse(snapshotResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ downloadCopyPath: string | null; id: string }> };
      };
      expect(snapshot.session.routineRuns[0]).toMatchObject({
        id: "delayed-review-run",
        downloadCopyPath: expectedDownloadCopyPath
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousDownloadsDir === undefined) {
        delete process.env.WRITER_DOWNLOADS_DIR;
      } else {
        process.env.WRITER_DOWNLOADS_DIR = previousDownloadsDir;
      }
    }
  });

  it("leaves local tmp routine artifacts out of Downloads unless a handoff copy is requested", async () => {
    const previousDownloadsDir = process.env.WRITER_DOWNLOADS_DIR;
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-routine-local-tmp-"));
    const downloadsDir = join(tempDir, "Downloads");
    const localTmpRoot = join(process.cwd(), "tmp");
    mkdirSync(localTmpRoot, { recursive: true });
    const localArtifactDir = mkdtempSync(join(localTmpRoot, ".routine-artifact-"));
    const sourcePath = join(tempDir, "source.docx");
    const artifactPath = join(localArtifactDir, "local-review.docx");
    const unexpectedDownloadCopyPath = join(downloadsDir, "local-review.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>Review this local tmp handoff.</p>"
    });
    const artifactResponse = await exportHttpDocx({
      title: "Local Review",
      html: "<p>The review artifact is intentionally local.</p>"
    });

    process.env.WRITER_DOWNLOADS_DIR = downloadsDir;
    writeFileSync(sourcePath, sourceResponse.body);
    writeFileSync(artifactPath, artifactResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const routineRunResponse = await requestBuffer(
        "POST",
        "/api/session/routine-run",
        { "Content-Type": "application/json" },
        JSON.stringify({
          id: "local-tmp-review-run",
          routineId: "r01-local-tmp-review",
          label: "Local tmp review",
          artifactPath
        })
      );
      const routineRun = JSON.parse(routineRunResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ artifactPath: string | null; downloadCopyPath: string | null; id: string }> };
      };

      expect(routineRunResponse.statusCode).toBe(200);
      expect(routineRun.session.routineRuns[0]).toMatchObject({
        id: "local-tmp-review-run",
        artifactPath,
        downloadCopyPath: null
      });

      const sessionResponse = await requestBuffer("GET", "/api/session");
      const session = JSON.parse(sessionResponse.body.toString("utf8")) as {
        session: { routineRuns: Array<{ downloadCopyPath: string | null; id: string }> };
      };

      expect(sessionResponse.statusCode).toBe(200);
      expect(session.session.routineRuns[0]).toMatchObject({
        id: "local-tmp-review-run",
        downloadCopyPath: null
      });
      expect(() => statSync(unexpectedDownloadCopyPath)).toThrow();
    } finally {
      rmSync(localArtifactDir, { recursive: true, force: true });
      rmSync(tempDir, { recursive: true, force: true });
      if (previousDownloadsDir === undefined) {
        delete process.env.WRITER_DOWNLOADS_DIR;
      } else {
        process.env.WRITER_DOWNLOADS_DIR = previousDownloadsDir;
      }
    }
  });

  it("exports caller-provided shared-session suggestions that are not yet stored on the sidecar", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-override-"));
    const sourcePath = join(tempDir, "source.docx");
    const reviewPath = join(tempDir, "override-review.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>Aim 2B still says in response to XXX.</p><p>Aim 2B needs reagent dose confirmation.</p>"
    });
    const overrideSuggestion = {
      id: "local-ui-suggestion",
      title: "Replace placeholder stimulus",
      original: "in response to XXX",
      replacement: "in response to defined differentiation cues across the selected time course",
      rationale: "Carries a local UI suggestion into the shared-session review export.",
      confidence: 0.88,
      range: {
        from: 18,
        text: "Aim 2B still says in response to XXX.",
        to: 33
      },
      target: "global",
      status: "pending"
    };
    const piSuggestion = {
      id: "local-pi-suggestion",
      title: "Confirm reagent dose",
      original: "Aim 2B needs reagent dose confirmation.",
      replacement: "PI confirmation needed: verify the inhibitor concentration and target-engagement readout before export.",
      rationale: "Carries a PI fact-check suggestion into the shared-session review export.",
      confidence: 0.84,
      range: {
        from: 35,
        text: "Aim 2B needs reagent dose confirmation.",
        to: 75
      },
      target: "global",
      status: "pending"
    };

    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: reviewPath,
          suggestions: [overrideSuggestion, piSuggestion],
          routineRun: {
            id: "override-run",
            routineId: "r01-word-comment-handoff",
            label: "Word comments"
          }
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        report: { commentedSuggestionReasonCounts: Array<{ count: number; reason: string }>; commentedSuggestions: number; matchedSuggestionTitles: string[]; matchedSuggestions: number; totalSuggestions: number };
        reviewSummary: { piFactCheckHandoffs: number; piFactCheckTitles: string[]; unitSensitiveHandoffs: number; unitSensitiveTitles: string[] };
        session: { pendingSuggestions: number; routineRuns: Array<{ id: string; report: { commentedSuggestionReasonCounts: Array<{ count: number; reason: string }>; commentedSuggestions: number; matchedSuggestionTitles: string[]; matchedSuggestions: number; representedSuggestions: number; totalSuggestions: number } }> };
        suggestionsPath: string;
      };
      const savedSuggestions = JSON.parse(readFileSync(exported.suggestionsPath, "utf8")) as {
        reviewPlacements: Array<{ handoff: string; outcome: string; sectionHint: string; title: string }>;
        suggestions: Array<{ id: string; range: { text: string } | null; title: string }>;
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.report).toMatchObject({ commentedSuggestions: 1, matchedSuggestions: 1, totalSuggestions: 2 });
      expect(exported.report.commentedSuggestionReasonCounts).toEqual([
        expect.objectContaining({ count: 1, reason: expect.stringMatching(/comment-only/) })
      ]);
      expect(exported.reviewSummary).toMatchObject({
        piFactCheckHandoffs: 1,
        piFactCheckTitles: ["Confirm reagent dose"],
        unitSensitiveHandoffs: 0,
        unitSensitiveTitles: []
      });
      expect(exported.session.pendingSuggestions).toBe(2);
      expect(exported.session.routineRuns[0]).toMatchObject({
        id: "override-run",
        report: {
          commentedSuggestionReasonCounts: [
            expect.objectContaining({ count: 1, reason: expect.stringMatching(/comment-only/) })
          ],
          commentedSuggestions: 1,
          matchedSuggestionTitles: ["Replace placeholder stimulus"],
          matchedSuggestions: 1,
          representedSuggestions: 2,
          totalSuggestions: 2
        }
      });
      expect(savedSuggestions.reviewPlacements).toMatchObject([{
        sectionHint: "Aim 2",
        title: "Replace placeholder stimulus"
      }, {
        handoff: "PI/fact-check Word comment; resolve the factual decision before accepting overlapping tracked changes.",
        outcome: "word-comment",
        sectionHint: "Aim 2",
        title: "Confirm reagent dose"
      }]);
      expect(savedSuggestions.suggestions).toEqual([
        expect.objectContaining({
          id: "local-ui-suggestion",
          range: expect.objectContaining({
            text: "Aim 2B still says in response to XXX."
          }),
          title: "Replace placeholder stimulus"
        }),
        expect.objectContaining({
          id: "local-pi-suggestion",
          range: expect.objectContaining({
            text: "Aim 2B needs reagent dose confirmation."
          }),
          title: "Confirm reagent dose"
        })
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts the shorter shared-session export alias for agent workflows", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-export-alias-"));
    const sourcePath = join(tempDir, "source.docx");
    const reviewPath = join(tempDir, "alias-review.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>Aim 2B causal logic needs sharper wording.</p>"
    });
    const suggestion = {
      id: "alias-export-suggestion",
      title: "Sharpen Aim 2B logic",
      original: "causal logic needs sharper wording",
      replacement: "causal logic is framed as an acute perturbation test",
      rationale: "Verifies the export alias returns the normal JSON review response.",
      confidence: 0.9,
      target: "global",
      status: "pending"
    };

    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: reviewPath,
          suggestions: [suggestion],
          routineRun: {
            id: "alias-export-run",
            routineId: "r01-export-alias",
            label: "Export alias"
          }
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        report: { matchedSuggestions: number; totalSuggestions: number };
        routineRun: { id: string } | null;
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.report).toMatchObject({ matchedSuggestions: 1, totalSuggestions: 1 });
      expect(exported.routineRun).toMatchObject({ id: "alias-export-run" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("flags unit-sensitive tracked changes in review placement handoffs", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-unit-review-"));
    const sourcePath = join(tempDir, "source.docx");
    const reviewPath = join(tempDir, "unit-review.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>LCL cultures will be treated with 100 mM DRB for 4 h.</p>"
    });
    const suggestion = {
      id: "unit-review-suggestion",
      title: "Correct DRB unit",
      original: "100 mM DRB",
      replacement: "100 uM DRB",
      rationale: "Exercises unit-sensitive handoff diagnostics.",
      confidence: 0.9,
      target: "global",
      status: "pending"
    };

    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: reviewPath,
          suggestions: [suggestion]
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        reviewPlacements: Array<{ handoff: string; outcome: string; title: string }>;
        reviewSummary: { unitSensitiveHandoffs: number; unitSensitiveTitles: string[] };
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.reviewSummary).toMatchObject({
        unitSensitiveHandoffs: 1,
        unitSensitiveTitles: ["Correct DRB unit"]
      });
      expect(exported.reviewPlacements).toMatchObject([{
        handoff: "Unit-sensitive tracked change; verify the dose or concentration before accepting.",
        outcome: "tracked-change",
        title: "Correct DRB unit"
      }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("summarizes same-target conflicts in review export artifacts", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-conflicts-"));
    const sourcePath = join(tempDir, "source.docx");
    const reviewPath = join(tempDir, "conflicts-review.docx");
    const reportPath = join(tempDir, "conflicts-review_report.json");
    const suggestionsPath = join(tempDir, "conflicts-review_suggestions.json");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>This paragraph needs focus.</p>"
    });
    const suggestions = [
      {
        id: "same-target-a",
        title: "Clarify endpoint",
        original: "This paragraph needs focus.",
        replacement: "This paragraph needs focus and a clear endpoint.",
        rationale: "Exercises same-target conflict metadata.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      },
      {
        id: "same-target-b",
        title: "Clarify reviewer logic",
        original: "This paragraph needs focus.",
        replacement: "This paragraph needs focus for reviewer logic.",
        rationale: "Exercises same-target conflict metadata.",
        confidence: 0.88,
        target: "global",
        status: "pending"
      }
    ];

    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          outputPath: reviewPath,
          reportOutputPath: reportPath,
          suggestions,
          suggestionsOutputPath: suggestionsPath
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        reviewConflictSummary: { conflictGroups: number; conflictingSuggestions: number; groups: Array<{ count: number; originalPreview: string; suggestionIds: string[]; titles: string[] }> };
      };
      const savedReport = JSON.parse(readFileSync(reportPath, "utf8")) as {
        reviewConflictSummary: { conflictGroups: number; conflictingSuggestions: number; groups: Array<{ count: number; originalPreview: string; suggestionIds: string[]; titles: string[] }> };
      };
      const savedSuggestions = JSON.parse(readFileSync(suggestionsPath, "utf8")) as {
        reviewConflictSummary: { conflictGroups: number; conflictingSuggestions: number; groups: Array<{ count: number; originalPreview: string; suggestionIds: string[]; titles: string[] }> };
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.reviewConflictSummary).toMatchObject({
        conflictGroups: 1,
        conflictingSuggestions: 2,
        groups: [{
          count: 2,
          originalPreview: "This paragraph needs focus.",
          suggestionIds: ["same-target-a", "same-target-b"],
          titles: ["Clarify endpoint", "Clarify reviewer logic"]
        }]
      });
      expect(savedReport.reviewConflictSummary).toEqual(exported.reviewConflictSummary);
      expect(savedSuggestions.reviewConflictSummary).toEqual(exported.reviewConflictSummary);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses document, routine, and timestamp in default shared review export filenames", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".writer-session-filename-"));
    const sourcePath = join(tempDir, "source.docx");
    const sourceResponse = await exportHttpDocx({
      title: "Session Source",
      html: "<p>Deliver a useful milestone.</p>"
    });

    writeFileSync(sourcePath, sourceResponse.body);

    try {
      const openResponse = await requestBuffer(
        "POST",
        "/api/session/open-docx",
        { "Content-Type": "application/json" },
        JSON.stringify({ path: sourcePath })
      );
      expect(openResponse.statusCode).toBe(200);

      const exportResponse = await requestBuffer(
        "POST",
        "/api/session/export-review",
        { "Content-Type": "application/json" },
        JSON.stringify({
          suggestions: [
            {
              id: "filename-suggestion",
              title: "Sharpen milestone",
              original: "Deliver a useful milestone.",
              replacement: "Deliver a reviewer-visible milestone.",
              rationale: "Makes the milestone more concrete.",
              confidence: 0.87,
              target: "global",
              status: "pending"
            }
          ],
          routineRun: {
            id: "filename-run",
            routineId: "r01-impact-payoff",
            label: "Milestones payoff handoff"
          }
        })
      );
      const exported = JSON.parse(exportResponse.body.toString("utf8")) as {
        artifactPath: string;
        outputPath: string;
        reportPath: string;
        routineRun: { artifactPath: string; reportPath: string; suggestionsPath: string };
        suggestionsPath: string;
      };

      expect(exportResponse.statusCode).toBe(200);
      expect(exported.artifactPath).toBe(exported.outputPath);
      expect(basename(exported.outputPath)).toMatch(/^source_Milestones-payoff-handoff_\d{8}T\d{6}Z_review\.docx$/);
      expect(exported.reportPath).toBe(exported.outputPath.replace(/\.docx$/i, "_report.json"));
      expect(exported.suggestionsPath).toBe(exported.outputPath.replace(/\.docx$/i, "_suggestions.json"));
      expect(exported.routineRun).toMatchObject({
        artifactPath: exported.outputPath,
        reportPath: exported.reportPath,
        suggestionsPath: exported.suggestionsPath
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function trackedSuggestion(id: string) {
  return {
    id,
    title: "Tighten sentence",
    original: "This is actually very wordy.",
    replacement: "This is wordy.",
    rationale: "Removes filler.",
    confidence: 0.8,
    target: "selection",
    status: "pending"
  };
}

function exportHttpDocx(body: Record<string, unknown>) {
  return requestBuffer(
    "POST",
    "/api/docx/export",
    {
      "Content-Type": "application/json"
    },
    JSON.stringify(body)
  );
}

function importHttpDocx(buffer: Buffer, filename: string) {
  const boundary = `----nebula-writer-${Date.now()}`;
  const multipartHead = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n"
  );
  const multipartTail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return requestBuffer(
    "POST",
    "/api/docx/import",
    {
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    Buffer.concat([multipartHead, buffer, multipartTail])
  );
}

async function requestBuffer(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer
) {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return requestBufferInProcess(method, path, headers, payload);
}

async function requestBufferInProcess(
  method: string,
  path: string,
  headers: Record<string, string>,
  payload?: Buffer
) {
  // Query strings ride separately so handlers can read request.query like they do under Express.
  const [pathname, search = ""] = path.split("?");
  const { handle: handler, params } = getRouteHandler(app, method.toLowerCase(), pathname);
  const requestHeaders = normalizeHeaders(headers);
  const req: Record<string, unknown> = { headers: requestHeaders, params, query: Object.fromEntries(new URLSearchParams(search)) };

  if (payload && requestHeaders["content-type"]?.includes("application/json")) {
    req.body = JSON.parse(payload.toString("utf8"));
  }

  if (payload && path === "/api/docx/import") {
    const parsed = parseMultipartUpload(payload, requestHeaders["content-type"] ?? "");
    req.file = {
      originalname: parsed.filename,
      buffer: parsed.buffer
    };
  }

  const res = createMockResponse();
  let nextError: unknown;

  await Promise.resolve(
    handler(req, res, (error?: unknown) => {
      nextError = error;
    })
  );

  if (nextError) {
    throw nextError;
  }

  const responseBody =
    typeof res.body === "string"
      ? Buffer.from(res.body, "utf8")
      : Buffer.isBuffer(res.body)
        ? res.body
        : Buffer.from(JSON.stringify(res.body ?? {}), "utf8");

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: responseBody
  };
}

function getRouteHandler(appInstance: express.Application, method: string, path: string) {
  type RouteLayer = {
    route?: {
      path?: string;
      methods?: Record<string, boolean>;
      stack?: Array<{ handle: Function }>;
    };
  };

  const anyApp = appInstance as express.Application & {
    _router?: { stack?: RouteLayer[] };
  };

  // Literal match first, then :param routes (e.g. /api/agent-run/:runId/stage).
  const matchParams = (routePath: string | undefined): Record<string, string> | null => {
    if (!routePath) {
      return null;
    }
    if (routePath === path) {
      return {};
    }
    if (!routePath.includes(":")) {
      return null;
    }
    const routeParts = routePath.split("/");
    const pathParts = path.split("/");
    if (routeParts.length !== pathParts.length) {
      return null;
    }
    const params: Record<string, string> = {};
    for (let index = 0; index < routeParts.length; index += 1) {
      if (routeParts[index].startsWith(":")) {
        params[routeParts[index].slice(1)] = pathParts[index];
      } else if (routeParts[index] !== pathParts[index]) {
        return null;
      }
    }
    return params;
  };

  let params: Record<string, string> = {};
  const layer = anyApp._router?.stack?.find((entry: RouteLayer) => {
    if (!entry.route?.methods?.[method]) {
      return false;
    }
    const matched = matchParams(entry.route.path);
    if (!matched) {
      return false;
    }
    params = matched;
    return true;
  });

  if (!layer?.route?.stack?.length) {
    throw new Error(`Route handler not found for ${method.toUpperCase()} ${path}`);
  }

  return { handle: layer.route.stack[layer.route.stack.length - 1].handle, params };
}

function normalizeHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  ) as Record<string, string>;
}

function parseMultipartUpload(payload: Buffer, contentType: string) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType);
  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary in request.");
  }

  const boundary = boundaryMatch[1];
  const marker = `--${boundary}`;
  const payloadText = payload.toString("latin1");
  const headerStart = payloadText.indexOf(marker);
  const headerEnd = payloadText.indexOf("\r\n\r\n", headerStart);
  const fileStart = headerEnd + 4;
  const fileEnd = payloadText.indexOf(`\r\n${marker}--`, fileStart);
  const filenameMatch = /filename="([^"]+)"/i.exec(payloadText.slice(headerStart, headerEnd));

  if (headerStart < 0 || headerEnd < 0 || fileEnd < 0 || !filenameMatch) {
    throw new Error("Malformed multipart upload payload in API test.");
  }

  return {
    filename: filenameMatch[1],
    buffer: payload.subarray(fileStart, fileEnd)
  };
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    }
  };
}

describe("Word add-in window state", () => {
  const documentText = "Specific Aims\nChromatin accessibility is actually a very important determinant of gene regulation.\nAim 1. Map accessibility dynamics.\nWe will profile 50,000 cells across six time points.";
  const hostContext = {
    source: "word-addin",
    documentName: "Aims.docx",
    capturedAt: new Date().toISOString(),
    documentLength: documentText.length,
    paragraphCount: 4,
    selection: { from: documentText.indexOf("We will profile"), to: documentText.length, text: "We will profile 50,000 cells across six time points." },
    cursor: { offset: documentText.indexOf("We will profile"), paragraphIndex: 3, paragraphText: "We will profile 50,000 cells across six time points.", sentence: "We will profile 50,000 cells across six time points." },
    section: { heading: "Aim 1. Map accessibility dynamics.", level: 2, paragraphIndex: 2, offset: documentText.indexOf("Aim 1.") },
    viewport: { from: 0, to: documentText.length, pages: [1], leadingText: "Specific Aims", trailingText: "six time points." },
    recentFocus: [{ offset: 0, paragraphIndex: 0, excerpt: "Specific Aims", heading: null, at: new Date().toISOString() }],
    outline: [
      { heading: "Specific Aims", level: 1, paragraphIndex: 0, offset: 0 },
      { heading: "Aim 1. Map accessibility dynamics.", level: 2, paragraphIndex: 2, offset: documentText.indexOf("Aim 1.") }
    ],
    changeTrackingMode: "Off"
  };

  it("adopts the Word document as the shared session and exposes the window state to live agents", async () => {
    const pushResponse = await requestBuffer("POST", "/api/word/context", { "content-type": "application/json" }, JSON.stringify({
      documentName: "Aims.docx",
      documentText,
      hostContext,
      adopt: true
    }));
    expect(pushResponse.statusCode).toBe(200);
    const push = JSON.parse(pushResponse.body.toString("utf8")) as { adopted: boolean; sessionId: string | null; pendingSuggestions: number };
    expect(push.adopted).toBe(true);
    expect(push.sessionId).toBeTruthy();

    const stored = JSON.parse((await requestBuffer("GET", "/api/word/context")).body.toString("utf8")) as { adopted: boolean; documentName: string; hostContext: { cursor: { paragraphIndex: number } } };
    expect(stored.adopted).toBe(true);
    expect(stored.documentName).toBe("Aims.docx");
    expect(stored.hostContext.cursor.paragraphIndex).toBe(3);

    const selectionResponse = await requestBuffer("GET", "/api/agent-run/live/selection");
    expect(selectionResponse.statusCode).toBe(200);
    const selection = JSON.parse(selectionResponse.body.toString("utf8")) as { mode: string; selection: { text: string } | null; hostContext: { section: { heading: string } } | null };
    expect(selection.mode).toBe("global");
    expect(selection.selection?.text).toBe("We will profile 50,000 cells across six time points.");
    expect(selection.hostContext?.section.heading).toBe("Aim 1. Map accessibility dynamics.");

    const documentResponse = await requestBuffer("GET", "/api/agent-run/live/document");
    expect(JSON.parse(documentResponse.body.toString("utf8")).text).toBe(documentText);

    // Structural reads follow the add-in's live caret.
    const contextResponse = await requestBuffer("GET", "/api/agent-run/live/context?what=paragraph");
    expect(contextResponse.statusCode).toBe(200);
    const context = JSON.parse(contextResponse.body.toString("utf8")) as { text: string; live: boolean; heading: { text: string } | null };
    expect(context.live).toBe(true);
    expect(context.text).toBe("We will profile 50,000 cells across six time points.");
    expect(context.heading?.text).toBe("Aim 1. Map accessibility dynamics.");
    const bad = await requestBuffer("GET", "/api/agent-run/live/context?what=chapter");
    expect(bad.statusCode).toBe(400);

    // A second push with only the window state keeps the same session.
    const again = JSON.parse((await requestBuffer("POST", "/api/word/context", { "content-type": "application/json" }, JSON.stringify({ documentName: "Aims.docx", hostContext }))).body.toString("utf8")) as { adopted: boolean; sessionId: string };
    expect(again.adopted).toBe(true);
    expect(again.sessionId).toBe(push.sessionId);
  });

  it("keeps the review queue when the Word text moves on", async () => {
    await requestBuffer("POST", "/api/word/context", { "content-type": "application/json" }, JSON.stringify({ documentName: "Aims.docx", documentText, hostContext, adopt: true }));
    const suggestResponse = await requestBuffer("POST", "/api/word/suggest", { "content-type": "application/json" }, JSON.stringify({
      provider: "demo",
      instruction: "Make this shorter",
      mode: "selection",
      documentText,
      documentName: "Aims.docx",
      selection: { from: documentText.indexOf("Chromatin"), to: documentText.indexOf("regulation.") + "regulation.".length, text: "Chromatin accessibility is actually a very important determinant of gene regulation." },
      hostContext
    }));
    expect(suggestResponse.statusCode).toBe(200);
    const suggest = JSON.parse(suggestResponse.body.toString("utf8")) as { ai: { suggestions: unknown[] }; session: { id: string; pendingSuggestions: number } };
    expect(suggest.ai.suggestions.length).toBe(1);
    expect(suggest.session.pendingSuggestions).toBe(1);

    const edited = `${documentText}\nA new closing paragraph typed in Word.`;
    const push = JSON.parse((await requestBuffer("POST", "/api/word/context", { "content-type": "application/json" }, JSON.stringify({ documentName: "Aims.docx", documentText: edited, hostContext }))).body.toString("utf8")) as { adopted: boolean; sessionId: string; pendingSuggestions: number };
    expect(push.adopted).toBe(true);
    expect(push.sessionId).toBe(suggest.session.id);
    expect(push.pendingSuggestions).toBe(1);
    expect(JSON.parse((await requestBuffer("GET", "/api/agent-run/live/document")).body.toString("utf8")).text).toBe(edited);
  });

  it("rejects malformed window state", async () => {
    const response = await requestBuffer("POST", "/api/word/context", { "content-type": "application/json" }, JSON.stringify({ documentName: "Aims.docx", hostContext: "nope" }));
    expect(response.statusCode).toBe(400);
    const missing = await requestBuffer("POST", "/api/word/context", { "content-type": "application/json" }, JSON.stringify({ documentName: "Aims.docx" }));
    expect(missing.statusCode).toBe(400);
    const badSuggest = await requestBuffer("POST", "/api/word/suggest", { "content-type": "application/json" }, JSON.stringify({
      provider: "demo",
      instruction: "x",
      mode: "global",
      documentText,
      hostContext: { documentLength: -5 }
    }));
    expect(badSuggest.statusCode).toBe(400);
  });
});

describe("AI model catalog", () => {
  it("lists what each installed CLI offers and validates per-request overrides", async () => {
    const response = await requestBuffer("GET", "/api/ai/models");
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body.toString("utf8")) as { providers: Array<{ provider: string; available: boolean; models: unknown[]; reasoning: unknown; defaults: { model: string | null; reasoning: string | null }; discoveredAt: string }>; refreshed: boolean };
    expect(body.refreshed).toBe(false);
    expect(body.providers.map((provider) => provider.provider).sort()).toEqual(["claude", "codex"]);
    for (const provider of body.providers) {
      expect(typeof provider.available).toBe("boolean");
      expect(Array.isArray(provider.models)).toBe(true);
      expect(provider.defaults).toHaveProperty("model");
      expect(provider.discoveredAt).toBeTruthy();
    }

    const documentText = "This is actually very wordy language for a grant application opening paragraph.";
    const bad = await requestBuffer("POST", "/api/ai/suggest", { "content-type": "application/json" }, JSON.stringify({
      provider: "demo",
      instruction: "Make this shorter",
      mode: "global",
      documentText,
      modelOptions: { model: "rm -rf /" }
    }));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body.toString("utf8")).error).toContain("modelOptions.model");

    const good = await requestBuffer("POST", "/api/ai/suggest", { "content-type": "application/json" }, JSON.stringify({
      provider: "demo",
      instruction: "Make this shorter",
      mode: "global",
      documentText,
      modelOptions: { model: "demo-model", reasoning: "high" }
    }));
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body.toString("utf8")).modelOptions).toEqual({ model: "demo-model", reasoning: "high" });
  }, 60_000);

  it("threads the provider session id and the conversation digest through the request", async () => {
    const documentText = "This is actually very wordy language for a grant application opening paragraph.";
    const ok = await requestBuffer("POST", "/api/ai/suggest", { "content-type": "application/json" }, JSON.stringify({
      provider: "demo",
      instruction: "Make this shorter",
      mode: "global",
      documentText,
      agentSessionId: "9f2c6a3e-0f5d-4d3a-8f8e-1c2b3a4d5e6f",
      conversation: [
        { role: "user", content: "Tighten it." },
        { role: "assistant", content: "Staged one.", decisions: [{ ref: "S1", title: "Tighten", status: "dismissed", note: "too terse" }, { title: "bad", status: "nope" }] }
      ]
    }));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body.toString("utf8")).agentSessionId).toBe("9f2c6a3e-0f5d-4d3a-8f8e-1c2b3a4d5e6f");

    const badId = await requestBuffer("POST", "/api/ai/suggest", { "content-type": "application/json" }, JSON.stringify({ provider: "demo", instruction: "x", mode: "global", documentText, agentSessionId: "../etc/passwd" }));
    expect(badId.statusCode).toBe(400);
    const badTurn = await requestBuffer("POST", "/api/ai/suggest", { "content-type": "application/json" }, JSON.stringify({ provider: "demo", instruction: "x", mode: "global", documentText, conversation: [{ role: "system", content: "x" }] }));
    expect(badTurn.statusCode).toBe(400);
  });
});

