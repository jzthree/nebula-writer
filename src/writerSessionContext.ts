export interface WriterSessionContext {
  documentName: string;
  latestRoutine: {
    commentedSuggestions?: number;
    completedAt?: string;
    commentReasons?: Array<{ count: number; reason: string }>;
    label: string;
    matchedSuggestions?: number;
    reviewReady?: boolean;
    totalSuggestions?: number;
    unmatchedSuggestions?: number;
  } | null;
  acceptedSuggestions: number;
  pendingSuggestions: number;
  preservationSignals: Array<{ label: string; count: number }>;
  rejectedSuggestions: number;
  routineRuns: number;
  topPendingSections: Array<{ label: string; count: number }>;
}

export function summarizeWriterSessionPayload(payload: unknown): WriterSessionContext | null {
  const session = typeof payload === "object" && payload && "session" in payload
    ? (payload as { session?: unknown }).session
    : null;
  if (!session || typeof session !== "object") {
    return null;
  }

  const value = session as {
    documentText?: unknown;
    features?: unknown;
    name?: unknown;
    pendingSuggestions?: unknown;
    routineRuns?: unknown;
    suggestions?: unknown;
  };
  const suggestions = Array.isArray(value.suggestions) ? value.suggestions : [];
  const documentText = typeof value.documentText === "string" ? value.documentText : "";
  const acceptedSuggestions = suggestions.filter((suggestion) => {
    return typeof suggestion === "object" && suggestion && (suggestion as { status?: unknown }).status === "accepted";
  }).length;
  const pendingSuggestions = Array.isArray(value.pendingSuggestions)
    ? value.pendingSuggestions.length
    : suggestions.filter((suggestion) => {
      return typeof suggestion === "object" && suggestion && (suggestion as { status?: unknown }).status === "pending";
    }).length;
  const rejectedSuggestions = suggestions.filter((suggestion) => {
    return typeof suggestion === "object" && suggestion && (suggestion as { status?: unknown }).status === "rejected";
  }).length;
  const routineRuns = Array.isArray(value.routineRuns) ? value.routineRuns : [];
  const latestRun = routineRuns.find((run) => typeof run === "object" && run) as {
    completedAt?: unknown;
    label?: unknown;
    report?: { commentedSuggestionReasonCounts?: unknown; commentedSuggestionReasons?: unknown; commentedSuggestions?: unknown; matchedSuggestions?: unknown; totalSuggestions?: unknown; unmatchedSuggestions?: unknown };
  } | undefined;

  return {
    documentName: typeof value.name === "string" ? value.name : "No document",
    latestRoutine: latestRun && typeof latestRun.label === "string" ? {
      completedAt: typeof latestRun.completedAt === "string" ? latestRun.completedAt : undefined,
      label: latestRun.label,
      commentReasons: summarizeCommentReasonCounts(latestRun.report?.commentedSuggestionReasonCounts) ?? summarizeCommentReasons(latestRun.report?.commentedSuggestionReasons),
      commentedSuggestions: typeof latestRun.report?.commentedSuggestions === "number" ? latestRun.report.commentedSuggestions : undefined,
      matchedSuggestions: typeof latestRun.report?.matchedSuggestions === "number" ? latestRun.report.matchedSuggestions : undefined,
      reviewReady: latestRun.report && typeof latestRun.report.totalSuggestions === "number" && typeof latestRun.report.unmatchedSuggestions === "number"
        ? latestRun.report.totalSuggestions > 0 && latestRun.report.unmatchedSuggestions === 0
        : undefined,
      totalSuggestions: typeof latestRun.report?.totalSuggestions === "number" ? latestRun.report.totalSuggestions : undefined,
      unmatchedSuggestions: typeof latestRun.report?.unmatchedSuggestions === "number" ? latestRun.report.unmatchedSuggestions : undefined
    } : null,
    acceptedSuggestions,
    pendingSuggestions,
    preservationSignals: summarizePreservationSignals(value.features),
    rejectedSuggestions,
    routineRuns: routineRuns.length,
    topPendingSections: summarizeTopPendingSections(suggestions, documentText)
  };
}

function summarizeCommentReasons(reasons: unknown): Array<{ count: number; reason: string }> | undefined {
  if (!Array.isArray(reasons)) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    if (typeof reason !== "string" || !reason.trim()) {
      continue;
    }
    const normalized = reason.trim();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([reason, count]) => ({ count, reason }));
}

function summarizeCommentReasonCounts(reasonCounts: unknown): Array<{ count: number; reason: string }> | undefined {
  if (!Array.isArray(reasonCounts)) {
    return undefined;
  }
  return reasonCounts
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const value = entry as { count?: unknown; reason?: unknown };
      if (typeof value.reason !== "string" || !value.reason.trim() || typeof value.count !== "number" || !Number.isFinite(value.count) || value.count <= 0) {
        return null;
      }
      return { count: Math.trunc(value.count), reason: value.reason.trim() };
    })
    .filter((entry): entry is { count: number; reason: string } => Boolean(entry))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function summarizePreservationSignals(features: unknown): Array<{ label: string; count: number }> {
  if (!features || typeof features !== "object") {
    return [];
  }

  const value = features as Record<string, unknown>;
  const definitions: Array<[string, string]> = [
    ["citationFields", "citation fields"],
    ["formulas", "formulas"],
    ["fields", "fields"],
    ["commentRanges", "comment ranges"],
    ["trackedChanges", "tracked changes"],
    ["images", "images"],
    ["textBoxes", "text boxes"],
    ["hyperlinks", "hyperlinks"],
    ["contentControls", "content controls"],
    ["bookmarks", "bookmarks"],
    ["customXml", "custom XML"]
  ];

  return definitions.flatMap(([key, label]) => {
    const count = value[key];
    return typeof count === "number" && count > 0 ? [{ label, count }] : [];
  });
}

export function summarizeTopPendingSections(suggestions: unknown[], documentTextOrLimit: string | number = "", limit = 5): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  const documentText = typeof documentTextOrLimit === "string" ? documentTextOrLimit : "";
  const maxSections = typeof documentTextOrLimit === "number" ? documentTextOrLimit : limit;
  const sections = collectDocumentSections(documentText);

  for (const suggestion of suggestions) {
    if (!suggestion || typeof suggestion !== "object") {
      continue;
    }
    const value = suggestion as { original?: unknown; status?: unknown; title?: unknown };
    if (value.status !== "pending") {
      continue;
    }
    const label = inferSuggestionSectionFromDocument(value, documentText, sections) ?? inferSuggestionSection(value);
    if (!label) {
      continue;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxSections)
    .map(([label, count]) => ({ label, count }));
}

function inferSuggestionSection(suggestion: { original?: unknown; title?: unknown }): string | null {
  const title = typeof suggestion.title === "string" ? suggestion.title : "";
  const original = typeof suggestion.original === "string" ? suggestion.original : "";
  const text = `${title} ${original}`.replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }

  if (/(\bfig\.|\bfigure\b|\btable\b|\bcaption\b|\bimage\b)/i.test(text)) {
    return "Figures/tables";
  }
  if (/(citation|reference|bibliography|\[\@|\(ref\b|\bref\s*[-)]|\bref[0-9]|\bdoi\b)/i.test(text)) {
    return "Citations/references";
  }

  const aim = /\bAim\s*([0-9]+)/i.exec(text);
  if (aim) {
    return `Aim ${aim[1]}`;
  }

  const sectionPatterns: Array<[string, RegExp]> = [
    ["Significance", /\bSignificance\b/i],
    ["Innovation", /\bInnovation\b/i],
    ["Approach", /\bApproach\b/i],
    ["Preliminary data", /\bPreliminary (studies|data)\b/i],
    ["Expected results", /\b(Expected results|limitations|alternative strategies)\b/i],
    ["Milestones", /\bMilestones?\b/i],
    ["SABV", /\bSex as a Biological Variable\b/i]
  ];
  return sectionPatterns.find(([, pattern]) => pattern.test(text))?.[0] ?? "General text";
}

interface DocumentSection {
  label: string;
  start: number;
}

function inferSuggestionSectionFromDocument(
  suggestion: { original?: unknown },
  documentText: string,
  sections: DocumentSection[]
): string | null {
  if (!documentText || !sections.length || typeof suggestion.original !== "string") {
    return null;
  }
  const index = findAnchorIndex(documentText, suggestion.original);
  if (index < 0) {
    return null;
  }
  return sectionLabelAt(sections, index);
}

function findAnchorIndex(documentText: string, original: string): number {
  const exact = documentText.indexOf(original);
  if (exact >= 0) {
    return exact;
  }

  const normalizedOriginal = original.replace(/\s+/g, " ").trim();
  if (normalizedOriginal.length < 20) {
    return -1;
  }

  const normalized = normalizeWithIndex(documentText);
  const normalizedIndex = normalized.text.indexOf(normalizedOriginal);
  return normalizedIndex >= 0 ? normalized.indexMap[normalizedIndex] ?? -1 : -1;
}

function normalizeWithIndex(value: string): { indexMap: number[]; text: string } {
  const indexMap: number[] = [];
  let text = "";
  let pendingSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      indexMap.push(index);
      pendingSpace = false;
    }
    text += char;
    indexMap.push(index);
  }

  return { indexMap, text };
}

function collectDocumentSections(documentText: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  let offset = 0;

  for (const line of documentText.split(/\n/)) {
    const trimmed = line.trim();
    if (isLikelySectionHeading(trimmed)) {
      sections.push({
        label: compactSectionLabel(trimmed),
        start: offset + Math.max(0, line.indexOf(trimmed))
      });
    }
    offset += line.length + 1;
  }

  return sections;
}

function isLikelySectionHeading(value: string): boolean {
  if (!value || value.length > 180) {
    return false;
  }
  return /^(Background|Significance|Innovation|Approach)\b/i.test(value)
    || /^Aim\s+[0-9]/i.test(value)
    || /^(Expected results|Expected Milestones|Authentication|Vertebrate|Sex as a Biological Variable|Data and Resource Sharing|Scientific Rigor)\b/i.test(value)
    || /^[0-9]+(?:\.[0-9]+)*\s+\S/.test(value)
    || /^[A-Z][A-Za-z0-9 /,&():'-]{2,100}:$/.test(value);
}

function compactSectionLabel(value: string): string {
  const expectedAim = /Expected results.*Aim\s*([0-9]+)/i.exec(value);
  if (expectedAim) {
    return `Aim ${expectedAim[1]} outcomes`;
  }

  const aim = /^Aim\s+([0-9]+[A-Z]?)/i.exec(value);
  if (aim) {
    return `Aim ${aim[1].toUpperCase()}`;
  }

  const label = value.replace(/[:.]\s*$/, "");
  return label.length > 42 ? `${label.slice(0, 39)}...` : label;
}

function sectionLabelAt(sections: DocumentSection[], index: number): string | null {
  let label: string | null = null;
  for (const section of sections) {
    if (section.start > index) {
      break;
    }
    label = section.label;
  }
  return label;
}
